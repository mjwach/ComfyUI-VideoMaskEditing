# Derived from nodes/video_mask_editor.py in ComfyUI-CustomNodePacks
# by Code2Collapse (Likhith) -- https://github.com/Code2Collapse
# (https://github.com/Code2Collapse/ComfyUI-CustomNodePacks), Apache-2.0.
# Modified (see CHANGES.md for details): keyframes persisted in the workflow;
# brush settings remembered; the node now serves its own downscaled reference
# frames to the editor (no Preview Image node needed); it remembers the frame
# count its keyframes were made for and refuses to run on an input whose size
# or length no longer matches them; routes moved to /vme/*; menu category
# changed.
"""
VideoMaskEditorMEC
==================
Full-stack interactive video mask editor.

The actual painting is performed in the browser (see js/video_mask_editor.js).
This node:
  1. Hosts a server-side per-session store of pinned-keyframe masks
     (each pinned keyframe is a single grayscale PNG kept in RAM).
  2. At execute() time, reconstructs the per-frame mask batch:
       - frames that the user pinned use the pinned mask directly,
       - non-pinned frames are tweened from the surrounding pinned
         keyframes using one of: distance-transform interpolation
         (shape-coherent), linear alpha blend, or hold-nearest.
  3. Optionally feathers + thresholds the final masks.

INPUTS (required):
  image          IMAGE   (B,H,W,3) — the video batch; needed to know B/H/W
  session_id     STRING  unique UUID; set by the JS extension when the
                          node is first created. Used to key the server-
                          side session dict so multiple instances don't
                          collide.
  tween_mode     COMBO   {"distance_transform","linear","hold"}
  feather        FLOAT   gaussian sigma in px applied to the final masks
  threshold      FLOAT   binarize after tween (0 = no binarize)

INPUTS (optional):
  input_mask     MASK    fallback mask (used for any frame that has no
                          pinned/tween value because the user hasn't
                          set any keyframes). Shape (B|1,H,W).
  keyframes_data STRING  JSON {frame: base64 PNG}, written by the editor
                          UI on Save. This is the durable copy of your
                          pinned keyframes: it travels with the saved
                          workflow, so edits survive a server restart or
                          opening the workflow elsewhere (the live
                          in-memory session store below does not). When
                          present and non-empty it takes priority over
                          the in-memory session; it also changes value on
                          every Save, which is what lets IS_CHANGED
                          correctly invalidate the node's cache when
                          keyframes are edited.
  brush_opacity  FLOAT   editor brush opacity, remembered across
                          re-opens. Cosmetic only — excluded from
                          IS_CHANGED.
  brush_feather  FLOAT   editor brush edge softness, remembered across
                          re-opens. Cosmetic only — excluded from
                          IS_CHANGED. Default 0 (crisp brush).
  brush_size     INT     editor brush radius (px), remembered across
                          re-opens. Cosmetic only — excluded from
                          IS_CHANGED.
  keyframe_frame_count
                 INT     frame count of the input the keyframes were made
                          for (0 = unknown, e.g. keyframes saved by older
                          versions). Written by the editor. Together with
                          the keyframe PNGs' own width/height it lets the
                          editor notice a changed input and offer to
                          rescale the keyframes.

REFERENCE FRAMES:
  Each execute() remembers the input batch (a reference to the tensor, not
  a copy) under the node's session id. The editor fetches frames from
  /vme/frames/* one at a time, downscaled (to the size picked in the
  editor's Preview menu) and JPEG-encoded on demand, so no Preview Image
  node is needed and big videos stay cheap to browse. Masks are always
  painted at the input's full size.

OUTPUTS:
  mask           MASK    (B,H,W) float32 in [0,1]
  info           STRING  JSON: {session, n_keyframes, frames, source}

VRAM tier: 0 (CPU-only).
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import threading
import time
import uuid
from collections import OrderedDict
from typing import Dict, List, Optional, Tuple

import numpy as np
import torch

from ._is_changed_util import hash_args_and_kwargs

try:
    import cv2  # type: ignore
    _HAS_CV2 = True
except Exception:  # pragma: no cover
    cv2 = None
    _HAS_CV2 = False

try:
    from PIL import Image  # type: ignore
except Exception as e:  # pragma: no cover
    raise RuntimeError(
        "VideoMaskEditorMEC requires Pillow. Install with: pip install pillow"
    ) from e


# ─── In-memory session store ─────────────────────────────────────────
# {session_id: {"keyframes": {frame_int: np.uint8 mask (H,W)},
#               "shape": (H,W), "ts": float, "lock": threading.Lock}}
_SESSIONS: Dict[str, dict] = {}
_SESSIONS_LOCK = threading.Lock()
_SESSION_TTL_SEC = 60 * 60 * 6  # 6h
_SESSION_MAX = 64


def _gc_sessions() -> None:
    """Drop sessions older than TTL or trim to MAX (oldest first)."""
    now = time.time()
    with _SESSIONS_LOCK:
        # TTL.
        stale = [sid for sid, s in _SESSIONS.items()
                 if now - s.get("ts", now) > _SESSION_TTL_SEC]
        for sid in stale:
            _SESSIONS.pop(sid, None)
        # Cap.
        if len(_SESSIONS) > _SESSION_MAX:
            ordered = sorted(_SESSIONS.items(), key=lambda kv: kv[1].get("ts", 0))
            for sid, _ in ordered[:len(_SESSIONS) - _SESSION_MAX]:
                _SESSIONS.pop(sid, None)


def _get_session(session_id: str, create: bool = False) -> Optional[dict]:
    with _SESSIONS_LOCK:
        s = _SESSIONS.get(session_id)
        if s is None and create:
            s = {
                "keyframes": {},
                "shape": None,
                "ts": time.time(),
                "lock": threading.Lock(),
            }
            _SESSIONS[session_id] = s
        if s is not None:
            s["ts"] = time.time()
        return s


# ─── Reference-frame store (what the editor displays) ────────────────
# {session_id: {"image": IMAGE tensor (B,H,W,C), "token": str, "ts": float}}
# Holds a reference to the tensor ComfyUI already has in memory (no copy).
# Only the most recently executed few sessions are kept so an old input
# isn't held in RAM indefinitely.
_FRAMES: "OrderedDict[str, dict]" = OrderedDict()
_FRAMES_LOCK = threading.Lock()
_FRAMES_MAX_SESSIONS = 3

# Encoded JPEG cache: {(token, index, max_side): bytes}, LRU, byte-capped.
_JPEG_CACHE: "OrderedDict[tuple, bytes]" = OrderedDict()
_JPEG_CACHE_BYTES = 0
_JPEG_CACHE_MAX_BYTES = 256 * 1024 * 1024
_JPEG_QUALITY = 85


def _store_frames(session_id: str, image: torch.Tensor) -> str:
    """Remember `image` as the reference video for this session."""
    with _FRAMES_LOCK:
        prev = _FRAMES.get(session_id)
        if prev is not None and prev["image"] is image:
            token = prev["token"]
        else:
            token = uuid.uuid4().hex[:12]
        _FRAMES[session_id] = {"image": image, "token": token, "ts": time.time()}
        _FRAMES.move_to_end(session_id)
        while len(_FRAMES) > _FRAMES_MAX_SESSIONS:
            _FRAMES.popitem(last=False)
        return token


def _get_frames(session_id: str) -> Optional[dict]:
    with _FRAMES_LOCK:
        entry = _FRAMES.get(session_id)
        if entry is not None:
            _FRAMES.move_to_end(session_id)
        return entry


def _encode_frame_jpeg(image: torch.Tensor, index: int, max_side: int) -> bytes:
    """Frame `index` of an IMAGE batch -> JPEG bytes, longest side <= max_side
    (0 = full size). Runs in a worker thread."""
    frame = image[index].detach()
    if frame.device.type != "cpu":
        frame = frame.cpu()
    arr = (frame.float().clamp(0.0, 1.0).numpy() * 255.0 + 0.5).astype(np.uint8)
    if arr.ndim == 2:
        arr = arr[:, :, None]
    c = arr.shape[2]
    if c == 1:
        arr = np.repeat(arr, 3, axis=2)
    elif c == 2:
        arr = np.repeat(arr[:, :, :1], 3, axis=2)
    elif c > 3:
        arr = arr[:, :, :3]
    h, w = arr.shape[:2]
    if max_side > 0 and max(h, w) > max_side:
        scale = max_side / float(max(h, w))
        nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
        if _HAS_CV2:
            arr = cv2.resize(arr, (nw, nh), interpolation=cv2.INTER_AREA)
        else:
            arr = np.asarray(Image.fromarray(arr, mode="RGB").resize(
                (nw, nh), Image.BILINEAR, reducing_gap=2.0))
    buf = io.BytesIO()
    Image.fromarray(np.ascontiguousarray(arr), mode="RGB").save(
        buf, format="JPEG", quality=_JPEG_QUALITY)
    return buf.getvalue()


def _cached_frame_jpeg(image: torch.Tensor, token: str, index: int,
                       max_side: int) -> bytes:
    global _JPEG_CACHE_BYTES
    key = (token, index, max_side)
    with _FRAMES_LOCK:
        data = _JPEG_CACHE.get(key)
        if data is not None:
            _JPEG_CACHE.move_to_end(key)
            return data
    data = _encode_frame_jpeg(image, index, max_side)
    with _FRAMES_LOCK:
        if key not in _JPEG_CACHE:
            _JPEG_CACHE[key] = data
            _JPEG_CACHE_BYTES += len(data)
            while _JPEG_CACHE_BYTES > _JPEG_CACHE_MAX_BYTES and _JPEG_CACHE:
                _, old = _JPEG_CACHE.popitem(last=False)
                _JPEG_CACHE_BYTES -= len(old)
    return data


# ─── PNG codec helpers ───────────────────────────────────────────────
def _png_to_mask(png_bytes: bytes) -> np.ndarray:
    """Decode a grayscale PNG into a uint8 (H,W) array."""
    im = Image.open(io.BytesIO(png_bytes))
    if im.mode != "L":
        im = im.convert("L")
    return np.array(im, dtype=np.uint8)


def _mask_to_png(arr: np.ndarray) -> bytes:
    """Encode a uint8 (H,W) mask to PNG bytes."""
    if arr.dtype != np.uint8:
        arr = np.clip(arr, 0, 255).astype(np.uint8)
    im = Image.fromarray(arr, mode="L")
    buf = io.BytesIO()
    im.save(buf, format="PNG", optimize=False, compress_level=3)
    return buf.getvalue()


def _decode_keyframes_field(raw: str) -> Dict[int, np.ndarray]:
    """Decode the keyframes_data widget's JSON payload — {frame: base64
    PNG} — into the same {frame_int: uint8 (H,W) mask} shape the live
    session store uses. Reuses the same grayscale PNG codec as the
    HTTP keyframe routes. Malformed/empty input yields {}; individual
    bad entries are skipped rather than failing the whole batch.
    """
    out: Dict[int, np.ndarray] = {}
    if not raw:
        return out
    try:
        obj = json.loads(raw)
    except (TypeError, ValueError):
        return out
    if not isinstance(obj, dict):
        return out
    for k, v in obj.items():
        try:
            frame = int(k)
            png_bytes = base64.b64decode(v)
            out[frame] = _png_to_mask(png_bytes)
        except Exception:
            continue
    return out


# ─── Tween implementations ───────────────────────────────────────────
def _resize_to(mask: np.ndarray, target_hw: Tuple[int, int]) -> np.ndarray:
    """Resize a uint8 mask to (H,W). Uses cv2 if available, else PIL."""
    th, tw = target_hw
    if mask.shape == (th, tw):
        return mask
    if _HAS_CV2:
        return cv2.resize(mask, (tw, th), interpolation=cv2.INTER_LINEAR)
    im = Image.fromarray(mask, mode="L").resize((tw, th), Image.BILINEAR)
    return np.array(im, dtype=np.uint8)


def _signed_dt(mask: np.ndarray) -> np.ndarray:
    """Signed distance transform: positive inside, negative outside, in px.
    Robust to all-zero / all-one masks.
    """
    if not _HAS_CV2:
        # Fallback (slow but correct): just use the mask directly.
        m = (mask > 127).astype(np.float32)
        return (m - 0.5) * 100.0
    binm = (mask > 127).astype(np.uint8)
    if binm.max() == 0:
        # All background — uniform large negative.
        return np.full(mask.shape, -1e3, dtype=np.float32)
    if binm.min() == 1:
        # All foreground — uniform large positive.
        return np.full(mask.shape, 1e3, dtype=np.float32)
    inside = cv2.distanceTransform(binm, cv2.DIST_L2, 3).astype(np.float32)
    outside = cv2.distanceTransform(1 - binm, cv2.DIST_L2, 3).astype(np.float32)
    return inside - outside


def _centroid(mask: np.ndarray) -> Optional[Tuple[float, float]]:
    """Return (cx, cy) of a binary mask, or None if empty."""
    binm = mask > 127
    if not binm.any():
        return None
    ys, xs = np.where(binm)
    return float(xs.mean()), float(ys.mean())


def _translate(mask: np.ndarray, dx: float, dy: float) -> np.ndarray:
    """Translate a uint8 mask. cv2 if available, else numpy roll fallback."""
    if dx == 0 and dy == 0:
        return mask
    if _HAS_CV2:
        H, W = mask.shape[:2]
        M = np.float32([[1, 0, dx], [0, 1, dy]])
        return cv2.warpAffine(
            mask, M, (W, H), flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_CONSTANT, borderValue=0,
        )
    # Integer roll fallback.
    out = np.zeros_like(mask)
    idx = int(round(dx))
    idy = int(round(dy))
    H, W = mask.shape[:2]
    src_x0 = max(0, -idx)
    src_y0 = max(0, -idy)
    dst_x0 = max(0, idx)
    dst_y0 = max(0, idy)
    w = max(0, W - abs(idx))
    h = max(0, H - abs(idy))
    if w > 0 and h > 0:
        out[dst_y0:dst_y0 + h, dst_x0:dst_x0 + w] = \
            mask[src_y0:src_y0 + h, src_x0:src_x0 + w]
    return out


def _tween_dt(a: np.ndarray, b: np.ndarray, t: float) -> np.ndarray:
    """Distance-transform tween with centroid pre-alignment.

    Standard signed-DT lerp fails when the two keyframe shapes don't
    overlap (the lerped SDT goes negative everywhere between them and
    you get an empty middle frame). Fix: translate both keyframes
    toward the interpolated centroid first, lerp THOSE DTs, then we
    get a proper "moving shape" interpolation.
    """
    ca = _centroid(a)
    cb = _centroid(b)
    if ca is not None and cb is not None:
        # Target centroid = lerp.
        tcx = ca[0] * (1.0 - t) + cb[0] * t
        tcy = ca[1] * (1.0 - t) + cb[1] * t
        a_aligned = _translate(a, tcx - ca[0], tcy - ca[1])
        b_aligned = _translate(b, tcx - cb[0], tcy - cb[1])
    else:
        a_aligned = a
        b_aligned = b
    da = _signed_dt(a_aligned)
    db = _signed_dt(b_aligned)
    d = da * (1.0 - t) + db * t
    # 1px transition band for sub-pixel edge.
    soft = np.clip(d + 0.5, 0.0, 1.0)
    return (soft * 255.0).astype(np.uint8)


def _tween_linear(a: np.ndarray, b: np.ndarray, t: float) -> np.ndarray:
    return (a.astype(np.float32) * (1.0 - t) + b.astype(np.float32) * t).astype(np.uint8)


def _tween_hold(a: np.ndarray, b: np.ndarray, t: float) -> np.ndarray:
    return a if t < 0.5 else b


_TWEEN_FUNCS = {
    "distance_transform": _tween_dt,
    "linear": _tween_linear,
    "hold": _tween_hold,
}


# ─── aiohttp route registration ──────────────────────────────────────
def register_routes(server) -> None:
    """Bind /vme/* routes."""
    try:
        from aiohttp import web
    except Exception:
        print("[VideoMaskEditor] aiohttp not available; routes disabled.")
        return

    routes = server.routes

    @routes.post("/vme/init")
    async def init_session(request):
        sid = request.rel_url.query.get("session", "").strip()
        if not sid:
            return web.json_response({"error": "session required"}, status=400)
        try:
            body = await request.json()
            h = int(body.get("h"))
            w = int(body.get("w"))
        except Exception:
            return web.json_response({"error": "invalid body"}, status=400)
        if h <= 0 or w <= 0 or h > 8192 or w > 8192:
            return web.json_response({"error": "invalid shape"}, status=400)
        s = _get_session(sid, create=True)
        with s["lock"]:
            if s["shape"] != (h, w):
                # Shape change: drop any existing keyframes.
                s["keyframes"].clear()
                s["shape"] = (h, w)
        _gc_sessions()
        return web.json_response({"ok": True, "shape": [h, w]})

    @routes.post("/vme/keyframe")
    async def set_keyframe(request):
        sid = request.rel_url.query.get("session", "").strip()
        frame_s = request.rel_url.query.get("frame", "")
        if not sid or not frame_s.isdigit():
            return web.json_response({"error": "session+frame required"}, status=400)
        frame = int(frame_s)
        if frame < 0 or frame > 100000:
            return web.json_response({"error": "frame out of range"}, status=400)
        data = await request.read()
        if not data or len(data) > 32 * 1024 * 1024:
            return web.json_response({"error": "empty or too-large payload"}, status=400)
        try:
            arr = _png_to_mask(data)
        except Exception as e:
            return web.json_response({"error": f"png decode: {e}"}, status=400)
        s = _get_session(sid, create=True)
        with s["lock"]:
            if s["shape"] is None:
                s["shape"] = arr.shape
            elif s["shape"] != arr.shape:
                arr = _resize_to(arr, s["shape"])
            s["keyframes"][frame] = arr
        return web.json_response({
            "ok": True, "frame": frame, "n_keyframes": len(s["keyframes"]),
        })

    @routes.delete("/vme/keyframe")
    async def del_keyframe(request):
        sid = request.rel_url.query.get("session", "").strip()
        frame_s = request.rel_url.query.get("frame", "")
        if not sid or not frame_s.isdigit():
            return web.json_response({"error": "session+frame required"}, status=400)
        s = _get_session(sid)
        if s is None:
            return web.json_response({"ok": True})
        with s["lock"]:
            s["keyframes"].pop(int(frame_s), None)
            n = len(s["keyframes"])
        return web.json_response({"ok": True, "n_keyframes": n})

    @routes.get("/vme/state")
    async def get_state(request):
        sid = request.rel_url.query.get("session", "").strip()
        if not sid:
            return web.json_response({"error": "session required"}, status=400)
        s = _get_session(sid)
        if s is None:
            return web.json_response({"keyframes": [], "shape": None})
        with s["lock"]:
            return web.json_response({
                "keyframes": sorted(s["keyframes"].keys()),
                "shape": list(s["shape"]) if s["shape"] else None,
                "n_keyframes": len(s["keyframes"]),
            })

    @routes.get("/vme/keyframe")
    async def get_keyframe(request):
        sid = request.rel_url.query.get("session", "").strip()
        frame_s = request.rel_url.query.get("frame", "")
        if not sid or not frame_s.isdigit():
            return web.json_response({"error": "session+frame required"}, status=400)
        s = _get_session(sid)
        if s is None:
            return web.Response(status=404)
        with s["lock"]:
            arr = s["keyframes"].get(int(frame_s))
        if arr is None:
            return web.Response(status=404)
        return web.Response(body=_mask_to_png(arr), content_type="image/png")

    @routes.post("/vme/clear")
    async def clear_session(request):
        sid = request.rel_url.query.get("session", "").strip()
        if not sid:
            return web.json_response({"error": "session required"}, status=400)
        s = _get_session(sid)
        if s is not None:
            with s["lock"]:
                s["keyframes"].clear()
        return web.json_response({"ok": True})

    @routes.get("/vme/frames/info")
    async def frames_info(request):
        sid = request.rel_url.query.get("session", "").strip()
        entry = _get_frames(sid) if sid else None
        if entry is None:
            return web.json_response({"error": "no_frames"}, status=404)
        img = entry["image"]
        return web.json_response({
            "frames": int(img.shape[0]),
            "height": int(img.shape[1]),
            "width": int(img.shape[2]),
            "token": entry["token"],
        })

    @routes.get("/vme/frames/frame")
    async def frames_frame(request):
        q = request.rel_url.query
        sid = q.get("session", "").strip()
        token = q.get("token", "")
        try:
            index = int(q.get("i", ""))
            max_side = max(0, min(16384, int(q.get("max", "0"))))
        except ValueError:
            return web.json_response({"error": "bad i/max"}, status=400)
        entry = _get_frames(sid) if sid else None
        if entry is None:
            return web.json_response({"error": "no_frames"}, status=404)
        if token and token != entry["token"]:
            # The node ran again on a different input since the editor opened.
            return web.json_response({"error": "stale"}, status=409)
        img = entry["image"]
        if index < 0 or index >= int(img.shape[0]):
            return web.json_response({"error": "frame out of range"}, status=400)
        loop = asyncio.get_running_loop()
        try:
            data = await loop.run_in_executor(
                None, _cached_frame_jpeg, img, entry["token"], index, max_side)
        except Exception as e:  # pragma: no cover - defensive
            return web.json_response({"error": f"encode: {e}"}, status=500)
        return web.Response(body=data, content_type="image/jpeg", headers={
            "Cache-Control": "private, max-age=86400",
        })

    print("[VideoMaskEditor] routes registered (/vme/*)")


# ─── Mask reconstruction (used by execute) ───────────────────────────
def _reconstruct_batch(
    n_frames: int,
    target_hw: Tuple[int, int],
    keyframes: Dict[int, np.ndarray],
    tween_mode: str,
    fallback: Optional[np.ndarray],
) -> Tuple[np.ndarray, str]:
    """Build (n_frames,H,W) uint8 mask batch.
    Returns (batch, source_tag).
    """
    H, W = target_hw
    out = np.zeros((n_frames, H, W), dtype=np.uint8)
    tween = _TWEEN_FUNCS.get(tween_mode, _tween_dt)

    if not keyframes:
        if fallback is not None:
            fb = _resize_to(fallback, target_hw)
            for i in range(n_frames):
                out[i] = fb
            return out, "fallback_only"
        return out, "empty"

    # Ensure all keyframes match target shape.
    kfs: Dict[int, np.ndarray] = {}
    for f, m in keyframes.items():
        kfs[int(f)] = _resize_to(m, target_hw)
    sorted_f = sorted(kfs.keys())
    first_f, last_f = sorted_f[0], sorted_f[-1]

    for i in range(n_frames):
        if i in kfs:
            out[i] = kfs[i]
            continue
        if i < first_f:
            out[i] = kfs[first_f]
            continue
        if i > last_f:
            out[i] = kfs[last_f]
            continue
        # Find surrounding keyframes.
        lo = first_f
        hi = last_f
        for f in sorted_f:
            if f <= i:
                lo = f
            if f >= i:
                hi = f
                break
        if lo == hi:
            out[i] = kfs[lo]
            continue
        t = (i - lo) / float(hi - lo)
        out[i] = tween(kfs[lo], kfs[hi], float(t))
    return out, f"keyframes={len(keyframes)},tween={tween_mode}"


def _gaussian_feather(mask: np.ndarray, sigma: float) -> np.ndarray:
    """Apply Gaussian blur to a uint8 (...,H,W) mask. Returns float32 in [0,1]."""
    if sigma <= 0:
        return mask.astype(np.float32) / 255.0
    if not _HAS_CV2:
        return mask.astype(np.float32) / 255.0
    k = int(2 * round(sigma * 2.0) + 1)
    k = max(3, k | 1)
    if mask.ndim == 3:
        out = np.empty(mask.shape, dtype=np.float32)
        for i in range(mask.shape[0]):
            out[i] = cv2.GaussianBlur(mask[i], (k, k), sigma).astype(np.float32) / 255.0
        return out
    return cv2.GaussianBlur(mask, (k, k), sigma).astype(np.float32) / 255.0


def _check_keyframes_match(kfs: Dict[int, np.ndarray], n_frames: int,
                           h: int, w: int, kf_frame_count: int) -> None:
    """Refuse to run when the keyframes were made for a different input.

    Width/height come from the keyframe masks themselves; the frame count
    from the keyframe_frame_count widget (0 = unknown, not checked)."""
    if not kfs:
        return
    problems = []
    sizes = sorted({(int(m.shape[1]), int(m.shape[0])) for m in kfs.values()})
    if sizes != [(w, h)]:
        made = ", ".join(f"{a}x{b}" for a, b in sizes)
        problems.append(f"keyframes are {made} but the input is {w}x{h}")
    if kf_frame_count > 0 and kf_frame_count != n_frames:
        problems.append(f"keyframes were made for {kf_frame_count} frames "
                        f"but the input has {n_frames}")
    if problems:
        raise ValueError(
            "Video Mask Editor: the input video changed since the keyframes "
            "were made (" + "; ".join(problems) + "). Open the editor to "
            "rescale or delete the keyframes, then run again."
        )


# ─── ComfyUI Node ────────────────────────────────────────────────────
class VideoMaskEditorMEC:
    """Pinpoint per-frame mask editing across an entire video batch."""

    VRAM_TIER = 0
    CATEGORY = "mask"
    DESCRIPTION = (
        "Open the in-browser video mask editor (brush / erase / fill / "
        "lasso / onion-skin) to pin per-frame keyframes, then tweens "
        "non-keyframed frames using distance-transform interpolation. "
        "Run the node once (it is an output node, so you can run just it) "
        "to give the editor the input frames."
    )
    # An output node so it can be run on its own ("queue selected output
    # nodes") just to load the input frames into the editor.
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {
                    "tooltip": "Input video batch (B,H,W,3). Drives B/H/W.",
                }),
                "session_id": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "tooltip": "Auto-set by the editor UI. Don't edit by hand.",
                }),
                "tween_mode": (
                    ["distance_transform", "linear", "hold"],
                    {"default": "distance_transform",
                     "tooltip": "How to interpolate non-keyframed frames."},
                ),
                "feather": ("FLOAT", {
                    "default": 0.0, "min": 0.0, "max": 32.0, "step": 0.1,
                    "tooltip": "Gaussian feather radius (px). 0 = none.",
                }),
                "threshold": ("FLOAT", {
                    "default": 0.0, "min": 0.0, "max": 1.0, "step": 0.01,
                    "tooltip": "Binarize after tween. 0 = keep soft mask.",
                }),
            },
            "optional": {
                "input_mask": ("MASK", {
                    "tooltip": "Fallback mask used if no keyframes are set.",
                }),
                "keyframes_data": ("STRING", {
                    "default": "", "multiline": True,
                    "tooltip": (
                        "Internal: JSON {frame: base64 PNG} of your pinned "
                        "keyframes, written by the editor on Save. Persists "
                        "your edits inside the saved workflow. Don't edit "
                        "by hand."
                    ),
                }),
                "brush_size": ("INT", {
                    "default": 30, "min": 2, "max": 200, "step": 1,
                    "tooltip": "Editor brush radius (px). Remembers your "
                               "last value; has no effect on node output.",
                }),
                "brush_opacity": ("FLOAT", {
                    "default": 1.0, "min": 0.05, "max": 1.0, "step": 0.01,
                    "tooltip": "Editor brush opacity. Remembers your last "
                               "value; has no effect on node output.",
                }),
                "brush_feather": ("FLOAT", {
                    "default": 0.0, "min": 0.0, "max": 1.0, "step": 0.01,
                    "tooltip": "Editor brush edge softness. Remembers your "
                               "last value; has no effect on node output.",
                }),
                "keyframe_frame_count": ("INT", {
                    "default": 0, "min": 0, "max": 1000000, "step": 1,
                    "tooltip": "Internal: frame count of the input the "
                               "keyframes were made for (0 = unknown). "
                               "Written by the editor.",
                }),
            },
        }

    RETURN_TYPES = ("MASK", "STRING")
    RETURN_NAMES = ("mask", "info")
    FUNCTION = "execute"

    @classmethod
    def IS_CHANGED(cls, image, session_id, tween_mode, feather, threshold,
                   input_mask=None, keyframes_data="", brush_opacity=1.0,
                   brush_feather=0.0, brush_size=30, keyframe_frame_count=0,
                   **kwargs):
        return hash_args_and_kwargs(
            image, session_id, tween_mode, feather, threshold, input_mask,
            keyframes_data, keyframe_frame_count, **kwargs,
        )

    def execute(
        self,
        image: torch.Tensor,
        session_id: str,
        tween_mode: str,
        feather: float,
        threshold: float,
        input_mask: Optional[torch.Tensor] = None,
        keyframes_data: str = "",
        brush_opacity: float = 1.0,
        brush_feather: float = 0.0,
        brush_size: int = 30,
        keyframe_frame_count: int = 0,
    ):
        if image is None or not isinstance(image, torch.Tensor) or image.ndim != 4:
            raise ValueError("VideoMaskEditorMEC: image must be IMAGE tensor [B,H,W,C]")
        if input_mask is not None and (
            not isinstance(input_mask, torch.Tensor)
            or input_mask.ndim not in (2, 3)
        ):
            raise ValueError(
                "VideoMaskEditorMEC: input_mask must be MASK tensor [H,W] or [B,H,W]"
            )
        with torch.inference_mode():
            return self._execute_impl(
                image, session_id, tween_mode, feather, threshold, input_mask,
                keyframes_data, keyframe_frame_count,
            )

    def _execute_impl(
        self,
        image: torch.Tensor,
        session_id: str,
        tween_mode: str,
        feather: float,
        threshold: float,
        input_mask: Optional[torch.Tensor] = None,
        keyframes_data: str = "",
        keyframe_frame_count: int = 0,
    ):
        B, H, W, _C = image.shape
        sid = (session_id or "").strip()
        if not sid:
            raise ValueError(
                "VideoMaskEditorMEC: session_id is empty. Open the node's "
                "in-browser editor at least once so it can assign a UUID."
            )

        # Hand the input to the editor before anything below can fail, so
        # the editor can always open (e.g. to fix mismatched keyframes).
        _store_frames(sid, image)

        # Prefer the workflow-embedded keyframes (durable: survives a
        # server restart, works from a pure-API queue with no browser
        # involved, portable if the workflow is shared/moved). The JS
        # editor keeps this in lockstep with the live session on every
        # Save, so under normal use the two never disagree — this only
        # matters as a fallback when the in-memory session is gone.
        kf_source = "none"
        kfs: Dict[int, np.ndarray] = _decode_keyframes_field(keyframes_data)
        if kfs:
            kf_source = "workflow"
        else:
            s = _get_session(sid)
            if s is not None:
                with s["lock"]:
                    kfs = dict(s["keyframes"])
                if kfs:
                    kf_source = "session"

        _check_keyframes_match(kfs, B, H, W, int(keyframe_frame_count or 0))

        # Fallback mask: take first slice of input_mask, if any.
        fallback: Optional[np.ndarray] = None
        if input_mask is not None and input_mask.numel() > 0:
            fm = input_mask
            if fm.ndim == 3:
                fm0 = fm[0]
            elif fm.ndim == 2:
                fm0 = fm
            else:
                fm0 = fm.reshape(-1, fm.shape[-2], fm.shape[-1])[0]
            fb = (fm0.detach().cpu().clamp(0, 1).numpy() * 255.0).astype(np.uint8)
            fallback = fb

        batch_u8, src_tag = _reconstruct_batch(
            n_frames=B,
            target_hw=(H, W),
            keyframes=kfs,
            tween_mode=tween_mode,
            fallback=fallback,
        )

        # Feather + threshold + cast to float.
        mask_f = _gaussian_feather(batch_u8, float(feather))
        if threshold > 0:
            mask_f = (mask_f >= float(threshold)).astype(np.float32)
        mask_t = torch.from_numpy(mask_f.astype(np.float32))

        info = json.dumps({
            "session": sid[:8] + "…" if len(sid) > 8 else sid,
            "n_keyframes": len(kfs),
            "kf_source": kf_source,
            "frames": B,
            "shape": [H, W],
            "keyframe_frame_count": int(keyframe_frame_count or 0),
            "tween_mode": tween_mode,
            "feather": float(feather),
            "threshold": float(threshold),
            "source": src_tag,
        }, separators=(",", ":"))
        return (mask_t, info)


NODE_CLASS_MAPPINGS = {"VideoMaskEditorMEC": VideoMaskEditorMEC}
NODE_DISPLAY_NAME_MAPPINGS = {"VideoMaskEditorMEC": "Video Mask Editor"}
