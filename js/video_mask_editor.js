// Derived from js/video_mask_editor.js in ComfyUI-CustomNodePacks
// by Code2Collapse (Likhith) -- https://github.com/Code2Collapse
// (https://github.com/Code2Collapse/ComfyUI-CustomNodePacks), Apache-2.0.
// Modified (see CHANGES.md): keyframes persisted in the workflow; brush
// settings remembered; frames are loaded from the node itself (downscaled,
// on demand) instead of from an upstream preview; a dialog offers to rescale
// or delete keyframes when the input's size or frame count changed; the
// original pack's shared theme/dialog/report helpers were replaced by small
// local equivalents; server routes moved to /vme/*.
/**
 * VideoMaskEditorMEC — fullscreen video mask editor.
 *
 * Tools: brush · erase · fill · lasso · onion-skin · history.
 * Storage: per-pinned-frame ImageData kept client-side, POSTed to the
 *   server-side session on Save (PNG-compressed per frame), and also
 *   written into the node's keyframes_data widget so it saves with the
 *   workflow.
 * Frames: fetched from the node's own /vme/frames routes (downscaled JPEGs,
 *   loaded on demand + prefetched around the current frame).
 */

import { app } from "../../scripts/app.js";

const NODE_NAME = "VideoMaskEditorMEC";

// ─── Palette ───────────────────────────────────────────────────────
// Fixed colours (Catppuccin Mocha, as the original pack's default theme).
// Canvas2D fillStyle/strokeStyle needs literal colours, and _hexToRgb()
// expects "#rrggbb", so keep these as plain 6-digit hex.
const C = {
    bg:       "#1e1e2e",
    bg2:      "#181825",
    bg3:      "#181825",   // scrubber track + "loading…" background
    bg4:      "#11111b",
    panel:    "#313244",
    surface0: "#313244",
    surface1: "#45475a",   // frame tick marks
    border:   "#585b70",
    text:     "#cdd6f4",
    sub:      "#a6adc8",
    accent:   "#a6e3a1",
    accent2:  "#89b4fa",
    warn:     "#f9e2af",
    danger:   "#f38ba8",
    onion:    "#f9e2af",
    white:    "#ffffff",   // lasso-fill stencil — MUST be opaque white
    okBg:     "#3a5f50",
    okBg2:    "#2d4a3e",
    okMid2:   "#7fd17a",
    dangerBg2:"#4a2d2d",
    dangerBg3:"#5f3a3a",
    hover:    "#2a2a3e",
    rowHover: "#222234",
    violetBg: "#332233",
    scrim5:   "#101018",
    scrim6:   "#0f0f17",
};
const Z_MODAL = 10000;

function __c2cReport(where, err) {
    console.warn(`[VideoMaskEditor] ${where}:`, err);
}

// Node properties holding the editor's brush settings.
const BRUSH_PROPS = {
    brush_size: "vme_brush_size",
    brush_opacity: "vme_brush_opacity",
    brush_feather: "vme_brush_feather",
};

/** keyframes_data's "_frame_count" (null when absent or invalid). */
function readKeyframeFrameCount(raw) {
    if (!raw) return null;
    try {
        const n = JSON.parse(raw)?._frame_count;
        return (Number.isInteger(n) && n > 0) ? n : null;
    } catch { return null; }
}

const HISTORY_LIMIT = 60;

// ─── UUID generator (RFC4122 v4, crypto if available) ────────────────
function uuid() {
    if (crypto?.randomUUID) return crypto.randomUUID();
    return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
        (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & 15) >> (c / 4)).toString(16));
}

// ─── Small modal dialogs ───────────────────────────────────────────
// ComfyUI blocks window.alert(), so dialogs are plain DOM. While one is
// open it swallows keyboard events so the editor's shortcuts don't fire.
function _modalShell(widthPx = 420) {
    const backdrop = document.createElement("div");
    backdrop.style.cssText = `
        position:fixed;inset:0;z-index:${Z_MODAL + 10};display:flex;
        align-items:center;justify-content:center;background:rgba(0,0,0,0.55);
        font-family:Inter,system-ui,sans-serif;`;
    const card = document.createElement("div");
    card.style.cssText = `
        width:min(${widthPx}px,92vw);background:${C.bg2};color:${C.text};
        border:1px solid ${C.border};border-radius:10px;padding:18px 20px 16px;
        box-shadow:0 16px 56px rgba(0,0,0,0.6);box-sizing:border-box;font-size:13px;`;
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);
    return { backdrop, card };
}

function _dlgButton(label, { primary = false, danger = false } = {}) {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText = `
        padding:7px 14px;border-radius:6px;cursor:pointer;font-size:12px;
        font-weight:${primary ? 600 : 500};
        background:${primary ? C.accent : C.panel};
        color:${primary ? C.bg4 : (danger ? C.danger : C.text)};
        border:1px solid ${primary ? C.accent : (danger ? C.danger + "88" : C.border)};`;
    return b;
}

function vmeAlert(message, title = "Video Mask Editor") {
    return new Promise((resolve) => {
        const { backdrop, card } = _modalShell(440);
        const h = document.createElement("div");
        h.textContent = title;
        h.style.cssText = `font-weight:600;color:${C.accent};margin-bottom:10px;`;
        const m = document.createElement("div");
        m.textContent = message;
        m.style.cssText = "white-space:pre-wrap;line-height:1.5;margin-bottom:16px;";
        const row = document.createElement("div");
        row.style.cssText = "display:flex;justify-content:flex-end;";
        const ok = _dlgButton("OK", { primary: true });
        row.appendChild(ok);
        card.append(h, m, row);
        const onKey = (e) => {
            e.stopImmediatePropagation();
            if (e.type === "keydown" && (e.key === "Enter" || e.key === "Escape")) {
                e.preventDefault(); done();
            }
        };
        const done = () => {
            document.removeEventListener("keydown", onKey, true);
            document.removeEventListener("keyup", onKey, true);
            backdrop.remove();
            resolve();
        };
        ok.onclick = done;
        document.addEventListener("keydown", onKey, true);
        document.addEventListener("keyup", onKey, true);
        requestAnimationFrame(() => ok.focus());
    });
}

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(",")[1]);
        r.onerror = reject;
        r.readAsDataURL(blob);
    });
}

// ─── Reference frames (served by the node itself) ──────────────────
// The node keeps the input batch from its last run; frames are fetched one
// at a time as downscaled JPEGs. Compressed frames are kept in memory (up
// to BLOB_CACHE_BYTES) and prefetched outward from the current frame; only
// a small window of them is decoded at any moment.
const BITMAP_CACHE = 40;                        // decoded frames kept
const BLOB_CACHE_BYTES = 512 * 1024 * 1024;     // compressed frames kept
const PREFETCH_WORKERS = 4;
const PREVIEW_DEFAULT = 1024;                   // px, longest side
const PREVIEW_CHOICES = [[512, "512 px"], [768, "768 px"], [1024, "1024 px"],
                         [1536, "1536 px"], [2048, "2048 px"], [0, "full size"]];

class FrameSource {
    constructor(sessionId, maxSide) {
        this.sessionId = sessionId;
        this.maxSide = Math.max(0, maxSide | 0);
        this.count = 0;
        this.width = 0;
        this.height = 0;
        this.token = "";
        this.blobs = new Map();      // i -> Blob (JPEG)
        this.blobBytes = 0;
        this.bitmaps = new Map();    // i -> ImageBitmap, oldest first
        this.inflight = new Map();   // i -> Promise<Blob>
        this.decoding = new Map();   // i -> Promise<ImageBitmap>
        this.focus = 0;
        this.protect = -1;           // frame index currently on screen
        this.workers = 0;
        this.disposed = false;
        this.stale = false;          // node re-ran on another input meanwhile
        this.onFrameReady = null;    // (i) => void
    }

    /** Ask the node what it last ran on. False if it hasn't run yet. */
    async init() {
        const r = await fetch(`/vme/frames/info?session=${encodeURIComponent(this.sessionId)}`);
        if (!r.ok) return false;
        const j = await r.json();
        this.count = j.frames | 0;
        this.width = j.width | 0;
        this.height = j.height | 0;
        this.token = String(j.token || "");
        return this.count > 0 && this.width > 0 && this.height > 0;
    }

    _url(i) {
        return `/vme/frames/frame?session=${encodeURIComponent(this.sessionId)}` +
               `&token=${encodeURIComponent(this.token)}&i=${i}&max=${this.maxSide}`;
    }

    _fetchBlob(i) {
        const have = this.blobs.get(i);
        if (have) return Promise.resolve(have);
        let p = this.inflight.get(i);
        if (p) return p;
        p = fetch(this._url(i)).then(async (r) => {
            if (r.status === 409) { this.stale = true; throw new Error("input changed"); }
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const b = await r.blob();
            if (!this.disposed && !this.blobs.has(i)) {
                this.blobs.set(i, b);
                this.blobBytes += b.size;
                this._trimBlobs();
            }
            return b;
        }).finally(() => this.inflight.delete(i));
        this.inflight.set(i, p);
        return p;
    }

    _trimBlobs() {
        while (this.blobBytes > BLOB_CACHE_BYTES && this.blobs.size > 1) {
            let far = -1, farD = -1;
            for (const k of this.blobs.keys()) {
                const d = Math.abs(k - this.focus);
                if (d > farD) { farD = d; far = k; }
            }
            this.blobBytes -= this.blobs.get(far).size;
            this.blobs.delete(far);
        }
    }

    /** Decoded frame if ready (no loading), else null. */
    peek(i) {
        const bm = this.bitmaps.get(i);
        if (!bm) return null;
        this.bitmaps.delete(i);      // mark as recently used
        this.bitmaps.set(i, bm);
        return bm;
    }

    /** Load + decode frame i. */
    request(i) {
        if (i < 0 || i >= this.count) return Promise.resolve(null);
        if (this.bitmaps.has(i)) return Promise.resolve(this.peek(i));
        let p = this.decoding.get(i);
        if (p) return p;
        p = this._fetchBlob(i)
            .then((b) => createImageBitmap(b))
            .then((bm) => {
                if (this.disposed) { bm.close?.(); return null; }
                this.bitmaps.set(i, bm);
                this._trimBitmaps();
                this.onFrameReady?.(i);
                return bm;
            })
            .finally(() => this.decoding.delete(i));
        this.decoding.set(i, p);
        return p;
    }

    _trimBitmaps() {
        if (this.bitmaps.size <= BITMAP_CACHE) return;
        for (const k of [...this.bitmaps.keys()]) {
            if (this.bitmaps.size <= BITMAP_CACHE) break;
            if (k === this.protect || k === this.focus) continue;
            this.bitmaps.get(k).close?.();
            this.bitmaps.delete(k);
        }
    }

    /** The user is looking at frame i: load it first, then its neighbours. */
    setFocus(i) {
        this.focus = i;
        this.request(i).catch(() => {});
        for (const d of [1, -1, 2]) this.request(i + d).catch(() => {});
        this._pump();
    }

    _nextToPrefetch() {
        for (let d = 0; d < this.count; d++) {
            for (const i of d ? [this.focus + d, this.focus - d] : [this.focus]) {
                if (i >= 0 && i < this.count && !this.blobs.has(i) && !this.inflight.has(i)) return i;
            }
        }
        return -1;
    }

    _pump() {
        while (!this.disposed && !this.stale && this.workers < PREFETCH_WORKERS &&
               this.blobBytes < BLOB_CACHE_BYTES * 0.9) {
            const i = this._nextToPrefetch();
            if (i < 0) return;
            this.workers++;
            this._fetchBlob(i).catch(() => {}).finally(() => {
                this.workers--;
                this._pump();
            });
        }
    }

    loadedCount() { return this.blobs.size; }

    dispose() {
        this.disposed = true;
        for (const bm of this.bitmaps.values()) bm.close?.();
        this.bitmaps.clear();
        this.blobs.clear();
        this.blobBytes = 0;
    }
}


// ─── Keyframe rescaling ─────────────────────────────────────────────
/** Resample one keyframe (RGBA ImageData; the mask lives in alpha) to
 *  dw×dh. method: "nearest" (keeps hard edges) or "bilinear". */
function resampleKeyframe(id, dw, dh, method, rgb) {
    const sw = id.width, sh = id.height, src = id.data;
    const out = new ImageData(dw, dh);
    const dst = out.data;
    if (method === "nearest") {
        const xs = new Int32Array(dw);
        for (let x = 0; x < dw; x++) xs[x] = Math.min(sw - 1, Math.floor((x + 0.5) * sw / dw));
        for (let y = 0; y < dh; y++) {
            const sy = Math.min(sh - 1, Math.floor((y + 0.5) * sh / dh));
            const srow = sy * sw, drow = y * dw;
            for (let x = 0; x < dw; x++) {
                const o = (drow + x) * 4;
                dst[o] = rgb.r; dst[o + 1] = rgb.g; dst[o + 2] = rgb.b;
                dst[o + 3] = src[(srow + xs[x]) * 4 + 3];
            }
        }
        return out;
    }
    // bilinear, pixel-centre aligned
    const x0s = new Int32Array(dw), x1s = new Int32Array(dw), wxs = new Float32Array(dw);
    for (let x = 0; x < dw; x++) {
        const fx = (x + 0.5) * sw / dw - 0.5;
        let x0 = Math.floor(fx), wx = fx - x0;
        if (x0 < 0) { x0 = 0; wx = 0; }
        let x1 = x0 + 1;
        if (x1 > sw - 1) { x1 = sw - 1; }
        x0s[x] = Math.min(x0, sw - 1); x1s[x] = x1; wxs[x] = wx;
    }
    for (let y = 0; y < dh; y++) {
        const fy = (y + 0.5) * sh / dh - 0.5;
        let y0 = Math.floor(fy), wy = fy - y0;
        if (y0 < 0) { y0 = 0; wy = 0; }
        y0 = Math.min(y0, sh - 1);
        const y1 = Math.min(y0 + 1, sh - 1);
        const r0 = y0 * sw, r1 = y1 * sw, drow = y * dw;
        for (let x = 0; x < dw; x++) {
            const wx = wxs[x];
            const a00 = src[(r0 + x0s[x]) * 4 + 3], a01 = src[(r0 + x1s[x]) * 4 + 3];
            const a10 = src[(r1 + x0s[x]) * 4 + 3], a11 = src[(r1 + x1s[x]) * 4 + 3];
            const top = a00 + (a01 - a00) * wx;
            const bot = a10 + (a11 - a10) * wx;
            const o = (drow + x) * 4;
            dst[o] = rgb.r; dst[o + 1] = rgb.g; dst[o + 2] = rgb.b;
            dst[o + 3] = Math.round(top + (bot - top) * wy);
        }
    }
    return out;
}

/** New index for keyframe f when the clip goes from oldN to newN frames. */
function remapFrameIndex(f, oldN, newN) {
    if (oldN === newN) return Math.max(0, Math.min(newN - 1, f));
    return Math.max(0, Math.min(newN - 1, Math.round(f * newN / oldN)));
}

/**
 * Shown when saved keyframes don't match the current input. Resolves to
 *   { action: "cancel" } | { action: "delete" } |
 *   { action: "rescale", oldCount, method }
 */
function showMismatchDialog(info) {
    // info: { inW, inH, inN, kfSizes: [[w,h],…], kfN (number|null), nKeyframes }
    return new Promise((resolve) => {
        const { backdrop, card } = _modalShell(520);
        const kfW = info.kfSizes.length === 1 ? info.kfSizes[0][0] : null;
        const kfH = info.kfSizes.length === 1 ? info.kfSizes[0][1] : null;
        const mixed = info.kfSizes.length > 1;
        const sizeDiffers = mixed || kfW !== info.inW || kfH !== info.inH;

        const h = document.createElement("div");
        h.textContent = "Keyframes don't match this input";
        h.style.cssText = `font-weight:600;font-size:14px;color:${C.warn};margin-bottom:8px;`;
        const intro = document.createElement("div");
        intro.style.cssText = `color:${C.sub};line-height:1.5;margin-bottom:14px;`;
        intro.textContent =
            `This node has ${info.nKeyframes} saved keyframe${info.nKeyframes === 1 ? "" : "s"}, ` +
            "made for a video of a different size or length than the one now connected " +
            "(or of an unknown length). Choose what to do with them.";

        // Comparison table.
        const tbl = document.createElement("table");
        tbl.style.cssText = `border-collapse:collapse;width:100%;margin-bottom:14px;font-size:12px;`;
        const cell = (txt, { head = false, bad = false } = {}) => {
            const td = document.createElement(head ? "th" : "td");
            td.style.cssText = `padding:6px 8px;border-bottom:1px solid ${C.border};text-align:${head ? "left" : "right"};` +
                `font-weight:${head ? 600 : 400};color:${bad ? C.warn : (head ? C.sub : C.text)};` +
                `font-family:${head ? "inherit" : "ui-monospace,monospace"};`;
            if (txt instanceof Node) td.appendChild(txt); else td.textContent = txt;
            return td;
        };
        const hdr = document.createElement("tr");
        hdr.append(cell("", { head: true }), cell("Keyframes made for", { head: true }), cell("Current input", { head: true }));
        tbl.appendChild(hdr);
        const wTxt = mixed ? "mixed" : String(kfW);
        const hTxt = mixed ? "mixed" : String(kfH);
        const rowW = document.createElement("tr");
        rowW.append(cell("Width", { head: true }), cell(wTxt, { bad: mixed || kfW !== info.inW }), cell(String(info.inW)));
        const rowH = document.createElement("tr");
        rowH.append(cell("Height", { head: true }), cell(hTxt, { bad: mixed || kfH !== info.inH }), cell(String(info.inH)));
        const rowN = document.createElement("tr");
        let countInput = null;
        if (info.kfN == null) {
            const wrap = document.createElement("div");
            wrap.style.cssText = "display:flex;flex-direction:column;align-items:flex-end;gap:4px;";
            const lab = document.createElement("div");
            lab.textContent = "unknown — enter it:";
            lab.style.cssText = `color:${C.warn};font-family:inherit;font-size:11px;`;
            countInput = document.createElement("input");
            countInput.type = "number"; countInput.min = "1"; countInput.step = "1";
            countInput.placeholder = "frames";
            countInput.style.cssText = `width:90px;padding:4px 6px;border-radius:5px;text-align:right;
                background:${C.bg};color:${C.text};border:1px solid ${C.border};font:inherit;`;
            const same = document.createElement("a");
            same.textContent = `same as now (${info.inN})`;
            same.href = "#";
            same.style.cssText = `color:${C.accent2};font-size:11px;font-family:inherit;`;
            same.onclick = (e) => { e.preventDefault(); countInput.value = String(info.inN); update(); };
            wrap.append(lab, countInput, same);
            rowN.append(cell("Frames", { head: true }), cell(wrap, { bad: true }), cell(String(info.inN)));
        } else {
            rowN.append(cell("Frames", { head: true }), cell(String(info.kfN), { bad: info.kfN !== info.inN }), cell(String(info.inN)));
        }
        tbl.append(rowW, rowH, rowN);

        // Resampling choice (only meaningful when width/height change).
        const methodRow = document.createElement("div");
        methodRow.style.cssText = "display:flex;align-items:center;gap:10px;margin-bottom:8px;";
        const mLab = document.createElement("span");
        mLab.textContent = "Resampling:";
        mLab.style.color = C.sub;
        const sel = document.createElement("select");
        sel.style.cssText = `padding:4px 6px;border-radius:5px;background:${C.bg};color:${C.text};border:1px solid ${C.border};font:inherit;`;
        for (const [v, t] of [["nearest", "Nearest neighbor (keeps masks hard-edged)"],
                              ["bilinear", "Bilinear (smooth edges)"]]) {
            const o = document.createElement("option"); o.value = v; o.textContent = t; sel.appendChild(o);
        }
        methodRow.append(mLab, sel);
        if (!sizeDiffers) methodRow.style.display = "none";

        const explain = document.createElement("div");
        explain.style.cssText = `color:${C.sub};font-size:11px;line-height:1.5;margin-bottom:16px;min-height:16px;`;

        const row = document.createElement("div");
        row.style.cssText = "display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;";
        const bCancel = _dlgButton("Cancel");
        bCancel.title = "Close the editor without changing anything";
        const bDelete = _dlgButton("Delete all keyframes", { danger: true });
        const bRescale = _dlgButton("Rescale keyframes", { primary: true });
        row.append(bCancel, bDelete, bRescale);

        card.append(h, intro, tbl, methodRow, explain, row);

        const oldCount = () => {
            if (!countInput) return info.kfN;
            const v = Number(countInput.value);
            return Number.isInteger(v) && v >= 1 ? v : null;
        };
        const update = () => {
            const n = oldCount();
            bRescale.disabled = n == null;
            bRescale.style.opacity = n == null ? "0.5" : "1";
            bRescale.style.cursor = n == null ? "not-allowed" : "pointer";
            const parts = [];
            if (sizeDiffers) parts.push(`Masks will be resized to ${info.inW}×${info.inH}.`);
            if (n != null && n !== info.inN) {
                parts.push(`Keyframe positions will be scaled by ${info.inN}/${n} and rounded to the nearest frame.`);
            }
            if (!parts.length && n != null) parts.push("Nothing to resize; this just records the frame count.");
            parts.push("Takes effect when you click Save & Close.");
            explain.textContent = parts.join(" ");
        };
        if (countInput) countInput.addEventListener("input", update);
        update();

        const onKey = (e) => {
            // Keep the editor's own shortcuts from firing behind the dialog.
            e.stopImmediatePropagation();
            if (e.type === "keydown" && e.key === "Escape") { e.preventDefault(); finish({ action: "cancel" }); }
        };
        const finish = (res) => {
            document.removeEventListener("keydown", onKey, true);
            document.removeEventListener("keyup", onKey, true);
            backdrop.remove();
            resolve(res);
        };
        bCancel.onclick = () => finish({ action: "cancel" });
        bDelete.onclick = () => finish({ action: "delete" });
        bRescale.onclick = () => {
            const n = oldCount();
            if (n == null) { countInput?.focus(); return; }
            finish({ action: "rescale", oldCount: n, method: sel.value });
        };
        document.addEventListener("keydown", onKey, true);
        document.addEventListener("keyup", onKey, true);
        requestAnimationFrame(() => (countInput || bRescale).focus());
    });
}

// ─── Editor session class ───────────────────────────────────────────
class VMEEditor {
    constructor(node) {
        this.node = node;
        this.sessionId = this._getOrCreateSession();
        this.frames = null;        // FrameSource, set by loadFrames()
        this._shownIdx = -1;       // frame whose picture is on screen
        this.frameCount = 0;
        this.frameW = 0;
        this.frameH = 0;
        this.curFrame = 0;
        // Pinned keyframes: Map<frame:int, ImageData>
        this.keyframes = new Map();
        // Frame count of the input the keyframes were made for (null =
        // unknown). Width/height come from the keyframes themselves.
        // Stored as "_frame_count" inside keyframes_data.
        this.kfFrameCount = readKeyframeFrameCount(this._widget("keyframes_data")?.value);
        this.curMask = null;       // ImageData for current frame's working buffer
        this.curDirty = false;
        // Tool state
        this.tool = "brush";       // brush|erase|fill|lasso|rect|ellipse|polygon|star|line
        this.brushRadius = 30;
        this.brushOpacity = 1.0;
        this.brushFeather = 0.0;   // default changed from 0.6 — crisp brush by default
        this._loadBrushPrefsFromWidgets();

        // Shape-tool state (rect/ellipse/polygon/star/line)
        this.shapeStart = null;    // {x,y} in image coords — drag anchor
        this.shapeCur = null;      // {x,y} live drag point
        this.shapeSides = 5;       // polygon/star vertex count
        this.starInner = 0.5;      // star inner-radius ratio
        this.shapeRotation = 0;    // radians
        this.shapeSquare = false;  // constrain to square/circle (Shift)

        // Roto pen state — editable spline through anchor points.
        this.penPoints = [];       // [{x,y}] anchors in image coords
        this.penDragIdx = -1;      // index of anchor being dragged (-1 none)
        this.penHover = null;      // {x,y} rubber-band cursor point
        this.penSmooth = true;     // smooth (Catmull-Rom) vs straight polygon

        // Shapes & roto add to the mask by default; subtract cuts holes.
        this.subtractMode = false;
        this.onion = true;
        this.painting = false;
        this.lastPaint = null;
        this.lasso = [];           // polygon points in canvas coords
        // View
        this.zoom = 1;
        this.panX = 0;
        this.panY = 0;
        // Undo (per-frame stack of ImageData)
        this.history = new Map();  // frame -> [ImageData,...]
        this.redo = new Map();
        // DOM refs filled by mount()
        this.dom = {};
    }

    _getOrCreateSession() {
        const w = this.node.widgets?.find(w => w.name === "session_id");
        if (!w) return "";
        if (!w.value || typeof w.value !== "string" || w.value.length < 8) {
            w.value = uuid();
        }
        return w.value;
    }

    _widget(name) {
        return this.node.widgets?.find(w => w.name === name) || null;
    }

    _widgetNum(name, fallback) {
        const v = this._widget(name)?.value;
        return (typeof v === "number" && isFinite(v)) ? v : fallback;
    }

    // Brush settings are editor-only, so they live in the node's properties
    // (saved with the workflow, never sent to the backend). As inputs they
    // made the node and everything downstream re-run when changed.
    _loadBrushPrefsFromWidgets() {
        const p = this.node.properties || {};
        const num = (k, fb) => (typeof p[k] === "number" && isFinite(p[k])) ? p[k] : fb;
        this.brushRadius = num(BRUSH_PROPS.brush_size, this.brushRadius);
        this.brushOpacity = num(BRUSH_PROPS.brush_opacity, this.brushOpacity);
        this.brushFeather = num(BRUSH_PROPS.brush_feather, this.brushFeather);
    }

    _syncBrushPref(name, value) {
        if (!this.node.properties) this.node.properties = {};
        this.node.properties[BRUSH_PROPS[name]] = value;
    }

    // ── frame init / switch ──────────────────────────────────────────
    /** Longest side of the reference pictures (0 = full size). Kept in the
     *  node's properties: saved with the workflow but never sent to the
     *  backend, so changing it doesn't make anything re-run. */
    _previewMaxSide() {
        const v = this.node.properties?.vme_preview_max_size;
        return (typeof v === "number" && v >= 0) ? v : PREVIEW_DEFAULT;
    }

    async setPreviewMaxSide(v) {
        if (!this.node.properties) this.node.properties = {};
        this.node.properties.vme_preview_max_size = v;
        if (!this.frames || !this.frameCount) return;
        const old = this.frames;
        const fresh = new FrameSource(this.sessionId, v);
        Object.assign(fresh, { count: old.count, width: old.width, height: old.height, token: old.token });
        fresh.onFrameReady = old.onFrameReady;
        old.dispose();
        this.frames = fresh;
        this._shownIdx = -1;
        fresh.setFocus(this.curFrame);
        this.draw();
    }

    async loadFrames() {
        this.frames = new FrameSource(this.sessionId, this._previewMaxSide());
        let ok = false;
        try { ok = await this.frames.init(); }
        catch (e) { __c2cReport("frames.init", e); }
        if (!ok) {
            await vmeAlert(
                "The editor has no frames to show yet.\n\n" +
                "Run the workflow once — or select just this node and run it " +
                "(it's an output node, so it can be run on its own) — so it can " +
                "pick up the input video. Then open the editor again.");
            return false;
        }
        this.frameCount = this.frames.count;
        this.frameW = this.frames.width;
        this.frameH = this.frames.height;
        this.frames.onFrameReady = (i) => {
            if (i === this.curFrame || this._shownIdx < 0) this.draw();
        };

        // Keyframes: the workflow copy is authoritative; the in-memory
        // server session is only a fallback for older workflows.
        await this._restoreFromWidget();
        if (this.keyframes.size === 0) {
            try {
                const r = await fetch(`/vme/state?session=${encodeURIComponent(this.sessionId)}`);
                const j = await r.json();
                for (const f of j.keyframes || []) await this._fetchExistingKeyframe(f);
            } catch (e) { __c2cReport("video_mask_editor", e); }
        }
        if (this.keyframes.size === 0) this.kfFrameCount = null;

        if (!(await this._resolveMismatch())) return false;

        this._switchFrame(0, { fresh: true });
        return true;
    }

    /** Distinct [w,h] sizes among the keyframes. */
    _keyframeSizes() {
        const seen = new Map();
        for (const id of this.keyframes.values()) seen.set(`${id.width}x${id.height}`, [id.width, id.height]);
        return [...seen.values()];
    }

    /** If the keyframes were made for a different input, make the user
     *  choose: cancel (returns false), delete them, or rescale them. */
    async _resolveMismatch() {
        if (!this.keyframes.size) return true;
        const sizes = this._keyframeSizes();
        const sizeOk = sizes.length === 1 && sizes[0][0] === this.frameW && sizes[0][1] === this.frameH;
        const countOk = this.kfFrameCount === this.frameCount;
        if (sizeOk && countOk) return true;
        const choice = await showMismatchDialog({
            inW: this.frameW, inH: this.frameH, inN: this.frameCount,
            kfSizes: sizes, kfN: this.kfFrameCount, nKeyframes: this.keyframes.size,
        });
        if (choice.action === "cancel") return false;
        this.history.clear();
        this.redo.clear();
        if (choice.action === "delete") {
            this.keyframes.clear();
            this.kfFrameCount = null;
            return true;
        }
        const dropped = this._rescaleKeyframes(choice.oldCount, choice.method);
        if (dropped > 0) {
            await vmeAlert(
                `${dropped} keyframe${dropped === 1 ? "" : "s"} landed on the same frame as another ` +
                "after rescaling in time and " + (dropped === 1 ? "was" : "were") + " dropped " +
                "(where keyframes collided, the one closest to that frame was kept).");
        }
        return true;
    }

    /** Resize every keyframe to the input's width/height and move it in
     *  time from oldN frames to the input's frame count. Returns how many
     *  keyframes were dropped because two landed on the same frame. */
    _rescaleKeyframes(oldN, method) {
        const newN = this.frameCount, W = this.frameW, H = this.frameH;
        const rgb = this._hexToRgb(C.accent);
        const out = new Map();
        const err = new Map();     // new index -> |exact - rounded|
        let dropped = 0;
        for (const [f, id] of [...this.keyframes.entries()].sort((a, b) => a[0] - b[0])) {
            const g = remapFrameIndex(f, oldN, newN);
            const e = Math.abs(f * newN / oldN - g);
            if (out.has(g)) {
                dropped++;
                if (err.get(g) <= e) continue;
            }
            const img = (id.width === W && id.height === H) ? id : resampleKeyframe(id, W, H, method, rgb);
            out.set(g, img);
            err.set(g, e);
        }
        this.keyframes = out;
        this.kfFrameCount = newN;
        return dropped;
    }

    /** Record the input's frame count the first time a keyframe exists. */
    _noteKeyframeAdded() {
        if (this.kfFrameCount == null) this.kfFrameCount = this.frameCount;
    }

    /** Decode a stored grayscale keyframe PNG at its own size into the
     *  editor's RGBA form (mask in alpha, accent colour in RGB). */
    async _decodeKeyframePng(blob) {
        const bm = await createImageBitmap(blob, {
            colorSpaceConversion: "none", premultiplyAlpha: "none",
        });
        const c = document.createElement("canvas");
        c.width = bm.width; c.height = bm.height;
        const cx = c.getContext("2d", { willReadFrequently: true });
        cx.drawImage(bm, 0, 0);
        bm.close?.();
        const id = cx.getImageData(0, 0, c.width, c.height);
        const accent = this._hexToRgb(C.accent);
        for (let i = 0; i < id.data.length; i += 4) {
            const a = id.data[i];
            id.data[i] = accent.r; id.data[i + 1] = accent.g; id.data[i + 2] = accent.b;
            id.data[i + 3] = a;
        }
        return id;
    }

    async _restoreFromWidget() {
        const w = this._widget("keyframes_data");
        if (!w?.value) return;
        let obj;
        try { obj = JSON.parse(w.value); } catch { return; }
        if (!obj || typeof obj !== "object") return;
        for (const [fStr, b64] of Object.entries(obj)) {
            if (!/^\d+$/.test(fStr)) continue;   // e.g. "_frame_count"
            const f = parseInt(fStr, 10);
            try {
                const bin = atob(b64);
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                const blob = new Blob([bytes], { type: "image/png" });
                this.keyframes.set(f, await this._decodeKeyframePng(blob));
            } catch (e) { __c2cReport("video_mask_editor", e); }
        }
    }

    async _fetchExistingKeyframe(f) {
        try {
            const r = await fetch(`/vme/keyframe?session=${encodeURIComponent(this.sessionId)}&frame=${f}`);
            if (!r.ok) return;
            this.keyframes.set(f, await this._decodeKeyframePng(await r.blob()));
        } catch (e) { __c2cReport("video_mask_editor", e); }
    }

    _hexToRgb(hex) {
        const h = hex.replace("#", "");
        return {
            r: parseInt(h.slice(0, 2), 16),
            g: parseInt(h.slice(2, 4), 16),
            b: parseInt(h.slice(4, 6), 16),
        };
    }

    _emptyMask() {
        return new ImageData(this.frameW, this.frameH);
    }

    /** Save current working mask back into keyframes (if dirty) and
     *  load the new frame's mask. */
    _switchFrame(idx, { fresh = false } = {}) {
        idx = Math.max(0, Math.min(this.frameCount - 1, idx | 0));
        if (!fresh) this._commitCurrent();
        this.curFrame = idx;
        this.frames?.setFocus(idx);
        // Working buffer: start from pinned keyframe at this frame
        // if any, else from an empty mask. We do NOT auto-tween in the
        // editor — user is editing keyframes explicitly. (Tweening
        // happens server-side at execute time.)
        const kf = this.keyframes.get(idx);
        if (kf) {
            this.curMask = new ImageData(
                new Uint8ClampedArray(kf.data), kf.width, kf.height);
        } else {
            this.curMask = this._emptyMask();
        }
        this.curDirty = false;
        this.draw();
    }

    /** If user painted on this frame, store as a keyframe. */
    _commitCurrent() {
        if (!this.curDirty || !this.curMask) return;
        this.keyframes.set(this.curFrame, this.curMask);
        this._noteKeyframeAdded();
        this.curDirty = false;
    }

    // ── Undo / redo (per-frame) ──────────────────────────────────────
    _pushUndo() {
        if (!this.curMask) return;
        const stk = this.history.get(this.curFrame) || [];
        stk.push(new ImageData(new Uint8ClampedArray(this.curMask.data),
                               this.curMask.width, this.curMask.height));
        if (stk.length > HISTORY_LIMIT) stk.shift();
        this.history.set(this.curFrame, stk);
        this.redo.set(this.curFrame, []);
    }
    undo() {
        const stk = this.history.get(this.curFrame);
        if (!stk?.length) return;
        const cur = new ImageData(new Uint8ClampedArray(this.curMask.data),
                                  this.curMask.width, this.curMask.height);
        const r = this.redo.get(this.curFrame) || [];
        r.push(cur);
        this.redo.set(this.curFrame, r);
        this.curMask = stk.pop();
        this.curDirty = true;
        this.draw();
    }
    redoOp() {
        const r = this.redo.get(this.curFrame);
        if (!r?.length) return;
        const stk = this.history.get(this.curFrame) || [];
        stk.push(new ImageData(new Uint8ClampedArray(this.curMask.data),
                               this.curMask.width, this.curMask.height));
        this.history.set(this.curFrame, stk);
        this.curMask = r.pop();
        this.curDirty = true;
        this.draw();
    }

    // ── Whole-frame mask ops ─────────────────────────────────────────
    _invertMask() {
        if (!this.curMask) return;
        this._pushUndo();
        const d = this.curMask.data, ac = this._hexToRgb(C.accent);
        for (let p = 0; p < d.length; p += 4) {
            d[p+3] = 255 - d[p+3];
            d[p] = ac.r; d[p+1] = ac.g; d[p+2] = ac.b;
        }
        this.curDirty = true; this.draw();
    }
    _clearMask() {
        if (!this.curMask) return;
        this._pushUndo();
        const d = this.curMask.data;
        for (let p = 3; p < d.length; p += 4) d[p] = 0;
        this.curDirty = true; this.draw();
    }
    _fillFrame() {
        if (!this.curMask) return;
        this._pushUndo();
        const d = this.curMask.data, ac = this._hexToRgb(C.accent);
        for (let p = 0; p < d.length; p += 4) { d[p+3] = 255; d[p]=ac.r; d[p+1]=ac.g; d[p+2]=ac.b; }
        this.curDirty = true; this.draw();
    }

    // ── Painting ─────────────────────────────────────────────────────
    _stamp(x, y, prev) {
        // Draw soft brush onto curMask. We use straight per-pixel
        // alpha-modify so brush size doesn't depend on canvas zoom.
        const data = this.curMask.data;
        const W = this.curMask.width, H = this.curMask.height;
        const r = this.brushRadius;
        const r2 = r * r;
        const isErase = this.tool === "erase";
        const op = this.brushOpacity;
        const featherStart = r * (1 - this.brushFeather);
        const accent = this._hexToRgb(C.accent);
        const lineCount = prev
            ? Math.max(1, Math.ceil(Math.hypot(x - prev.x, y - prev.y) / Math.max(1, r * 0.35)))
            : 1;
        for (let step = 0; step <= lineCount; step++) {
            const t = lineCount === 0 ? 0 : step / lineCount;
            const cx = prev ? prev.x + (x - prev.x) * t : x;
            const cy = prev ? prev.y + (y - prev.y) * t : y;
            const x0 = Math.max(0, Math.floor(cx - r));
            const y0 = Math.max(0, Math.floor(cy - r));
            const x1 = Math.min(W - 1, Math.ceil(cx + r));
            const y1 = Math.min(H - 1, Math.ceil(cy + r));
            for (let yy = y0; yy <= y1; yy++) {
                const dy = yy - cy;
                for (let xx = x0; xx <= x1; xx++) {
                    const dx = xx - cx;
                    const d2 = dx * dx + dy * dy;
                    if (d2 > r2) continue;
                    const d = Math.sqrt(d2);
                    let falloff = 1;
                    if (d > featherStart) {
                        const t2 = (d - featherStart) / Math.max(1e-6, r - featherStart);
                        falloff = 1 - t2;
                    }
                    const add = Math.round(255 * op * falloff);
                    const i = (yy * W + xx) * 4;
                    if (isErase) {
                        const cur = data[i + 3];
                        const newA = Math.max(0, cur - add);
                        data[i + 3] = newA;
                    } else {
                        const cur = data[i + 3];
                        const newA = Math.min(255, cur + add);
                        data[i + 3] = newA;
                        data[i] = accent.r;
                        data[i + 1] = accent.g;
                        data[i + 2] = accent.b;
                    }
                }
            }
        }
    }

    // ── Shape primitives (Nuke-style) ───────────────────────────────
    // Outline points of the current shape from its drag bounding box
    // (image coords). Mirrors nodes/_spline_curves.make_primitive.
    _shapePoints(kind, x0, y0, x1, y1) {
        let ax0 = Math.min(x0, x1), ay0 = Math.min(y0, y1);
        let ax1 = Math.max(x0, x1), ay1 = Math.max(y0, y1);
        if (this.shapeSquare) {
            const s = Math.min(ax1 - ax0, ay1 - ay0);
            ax1 = ax0 + s; ay1 = ay0 + s;
        }
        const cx = (ax0 + ax1) / 2, cy = (ay0 + ay1) / 2;
        const rx = Math.max(0.5, (ax1 - ax0) / 2), ry = Math.max(0.5, (ay1 - ay0) / 2);
        const rot = this.shapeRotation || 0;
        const rotate = (px, py) => {
            if (!rot) return [px, py];
            const dx = px - cx, dy = py - cy, c = Math.cos(rot), s = Math.sin(rot);
            return [cx + dx * c - dy * s, cy + dx * s + dy * c];
        };
        const pts = [];
        if (kind === "rect") {
            for (const [px, py] of [[ax0,ay0],[ax1,ay0],[ax1,ay1],[ax0,ay1]]) pts.push(rotate(px,py));
            return pts;
        }
        if (kind === "ellipse") {
            const N = 72;
            for (let i = 0; i < N; i++) { const a = (i/N)*Math.PI*2; pts.push(rotate(cx+Math.cos(a)*rx, cy+Math.sin(a)*ry)); }
            return pts;
        }
        if (kind === "polygon" || kind === "star") {
            const n = Math.max(3, this.shapeSides|0);
            const inner = kind === "star" ? Math.max(0.05, Math.min(0.95, this.starInner)) : 1;
            const count = kind === "star" ? n*2 : n;
            const a0 = -Math.PI/2;
            for (let i = 0; i < count; i++) {
                const a = a0 + (i/count)*Math.PI*2;
                const rr = (kind === "star" && (i % 2)) ? inner : 1;
                pts.push(rotate(cx + Math.cos(a)*rx*rr, cy + Math.sin(a)*ry*rr));
            }
            return pts;
        }
        return pts;
    }

    // Rasterise the live shape into curMask's alpha (feathered). Uses an
    // offscreen canvas then composites — the exact same alpha the brush
    // writes, so keyframe/tween/player are untouched.
    _rasterizeShape(kind) {
        if (!this.shapeStart || !this.shapeCur || !this.curMask) return;
        const W = this.curMask.width, H = this.curMask.height;
        const x0 = this.shapeStart.x, y0 = this.shapeStart.y;
        const x1 = this.shapeCur.x, y1 = this.shapeCur.y;
        if (Math.hypot(x1 - x0, y1 - y0) < 1.5) return;   // ignore accidental taps
        const tmp = document.createElement("canvas"); tmp.width = W; tmp.height = H;
        const tc = tmp.getContext("2d");
        const featherPx = Math.round((this.brushFeather || 0) * 24);
        tc.fillStyle = "#fff"; tc.strokeStyle = "#fff";
        if (featherPx > 0) { tc.shadowColor = "#fff"; tc.shadowBlur = featherPx; }
        if (kind === "line") {
            tc.lineWidth = Math.max(1, this.brushRadius);
            tc.lineCap = "round";
            tc.beginPath(); tc.moveTo(x0, y0); tc.lineTo(x1, y1); tc.stroke();
        } else {
            const pts = this._shapePoints(kind, x0, y0, x1, y1);
            if (pts.length < 3) return;
            tc.beginPath(); tc.moveTo(pts[0][0], pts[0][1]);
            for (let i = 1; i < pts.length; i++) tc.lineTo(pts[i][0], pts[i][1]);
            tc.closePath(); tc.fill();
        }
        const shp = tc.getImageData(0, 0, W, H).data;
        const data = this.curMask.data;
        const accent = this._hexToRgb(C.accent);
        const op = this.brushOpacity;
        const sub = this.subtractMode;
        for (let p = 0; p < W * H; p++) {
            const sa = shp[p*4+3];
            if (!sa) continue;
            const i = p*4;
            const add = Math.round(sa * op);
            if (sub) { data[i+3] = Math.max(0, data[i+3] - add); }
            else { data[i+3] = Math.min(255, data[i+3] + add); data[i] = accent.r; data[i+1] = accent.g; data[i+2] = accent.b; }
        }
        this.curDirty = true;
    }

    // ── Roto pen (editable spline) ───────────────────────────────────
    // Find the anchor index near a frame-space point (for grab/close).
    _penHit(fp, tolImg) {
        for (let i = 0; i < this.penPoints.length; i++) {
            const p = this.penPoints[i];
            if (Math.hypot(p.x - fp.x, p.y - fp.y) <= tolImg) return i;
        }
        return -1;
    }

    // Sample a smooth closed/open curve through the anchors (Catmull-Rom),
    // or the straight polygon when penSmooth is off. Returns [[x,y],…].
    _penCurve(closed) {
        const P = this.penPoints;
        const n = P.length;
        if (n < 2) return P.map(p => [p.x, p.y]);
        if (!this.penSmooth || n < 3) {
            const pts = P.map(p => [p.x, p.y]);
            return pts;
        }
        const out = [];
        const seg = 16;                          // samples per span
        const at = (i) => {                      // clamped/wrapped index
            if (closed) return P[((i % n) + n) % n];
            return P[Math.max(0, Math.min(n - 1, i))];
        };
        const last = closed ? n : n - 1;
        for (let i = 0; i < last; i++) {
            const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
            for (let s = 0; s < seg; s++) {
                const t = s / seg, t2 = t * t, t3 = t2 * t;
                const x = 0.5 * ((2*p1.x) + (-p0.x + p2.x)*t + (2*p0.x - 5*p1.x + 4*p2.x - p3.x)*t2 + (-p0.x + 3*p1.x - 3*p2.x + p3.x)*t3);
                const y = 0.5 * ((2*p1.y) + (-p0.y + p2.y)*t + (2*p0.y - 5*p1.y + 4*p2.y - p3.y)*t2 + (-p0.y + 3*p1.y - 3*p2.y + p3.y)*t3);
                out.push([x, y]);
            }
        }
        if (!closed) out.push([P[n-1].x, P[n-1].y]);
        return out;
    }

    // Rasterise the closed roto spline into curMask alpha (feathered).
    _commitPen() {
        if (this.penPoints.length < 3 || !this.curMask) { this.penPoints = []; return; }
        this._pushUndo();
        const W = this.curMask.width, H = this.curMask.height;
        const pts = this._penCurve(true);
        const tmp = document.createElement("canvas"); tmp.width = W; tmp.height = H;
        const tc = tmp.getContext("2d");
        const featherPx = Math.round((this.brushFeather || 0) * 24);
        if (featherPx > 0) { tc.shadowColor = "#fff"; tc.shadowBlur = featherPx; }
        tc.fillStyle = "#fff";
        tc.beginPath(); tc.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) tc.lineTo(pts[i][0], pts[i][1]);
        tc.closePath(); tc.fill();
        const shp = tc.getImageData(0, 0, W, H).data;
        const data = this.curMask.data;
        const accent = this._hexToRgb(C.accent);
        const op = this.brushOpacity;
        const sub = this.subtractMode;
        for (let p = 0; p < W * H; p++) {
            const sa = shp[p*4+3]; if (!sa) continue;
            const i = p*4;
            const add = Math.round(sa * op);
            if (sub) { data[i+3] = Math.max(0, data[i+3] - add); }
            else { data[i+3] = Math.min(255, data[i+3] + add); data[i] = accent.r; data[i+1] = accent.g; data[i+2] = accent.b; }
        }
        this.curDirty = true;
        this.penPoints = []; this.penHover = null; this.penDragIdx = -1;
    }

    _floodFill(x, y) {
        // Scanline flood-fill on alpha channel; fills connected region
        // of similar alpha with full opacity.
        x = x | 0; y = y | 0;
        const W = this.curMask.width, H = this.curMask.height;
        if (x < 0 || y < 0 || x >= W || y >= H) return;
        const data = this.curMask.data;
        const accent = this._hexToRgb(C.accent);
        const startIdx = (y * W + x) * 4 + 3;
        const startA = data[startIdx];
        const isErase = this.tool === "erase";
        const target = isErase ? 0 : 255;
        if (startA === target) return;
        const tol = 32;
        const stack = [[x, y]];
        const seen = new Uint8Array(W * H);
        while (stack.length) {
            const [cx, cy] = stack.pop();
            if (cx < 0 || cy < 0 || cx >= W || cy >= H) continue;
            const fIdx = cy * W + cx;
            if (seen[fIdx]) continue;
            const a = data[fIdx * 4 + 3];
            if (Math.abs(a - startA) > tol) continue;
            seen[fIdx] = 1;
            data[fIdx * 4 + 3] = target;
            if (!isErase) {
                data[fIdx * 4] = accent.r;
                data[fIdx * 4 + 1] = accent.g;
                data[fIdx * 4 + 2] = accent.b;
            }
            stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
        }
    }

    _fillLasso() {
        if (this.lasso.length < 3) return;
        const W = this.curMask.width, H = this.curMask.height;
        // Build off-screen path → bitmask via canvas.
        const off = document.createElement("canvas");
        off.width = W; off.height = H;
        const oc = off.getContext("2d");
        oc.fillStyle = C.white;
        oc.beginPath();
        oc.moveTo(this.lasso[0].x, this.lasso[0].y);
        for (let i = 1; i < this.lasso.length; i++) oc.lineTo(this.lasso[i].x, this.lasso[i].y);
        oc.closePath();
        oc.fill();
        const id = oc.getImageData(0, 0, W, H);
        const src = id.data;
        const dst = this.curMask.data;
        const isErase = this.tool === "erase";
        const accent = this._hexToRgb(C.accent);
        const op = Math.round(255 * this.brushOpacity);
        for (let i = 0; i < dst.length; i += 4) {
            if (src[i] === 0) continue;  // outside polygon
            if (isErase) {
                dst[i + 3] = Math.max(0, dst[i + 3] - op);
            } else {
                dst[i + 3] = Math.min(255, dst[i + 3] + op);
                dst[i] = accent.r;
                dst[i + 1] = accent.g;
                dst[i + 2] = accent.b;
            }
        }
    }

    // ── Coord transforms ─────────────────────────────────────────────
    _viewToFrame(vx, vy) {
        return { x: (vx - this.panX) / this.zoom, y: (vy - this.panY) / this.zoom };
    }
    fitView() {
        const r = this.dom.viewport.getBoundingClientRect();
        const pad = 20;
        const sx = (r.width - pad * 2) / this.frameW;
        const sy = (r.height - pad * 2) / this.frameH;
        this.zoom = Math.max(0.05, Math.min(sx, sy, 8));
        this.panX = (r.width - this.frameW * this.zoom) / 2;
        this.panY = (r.height - this.frameH * this.zoom) / 2;
    }

    // ── Render ───────────────────────────────────────────────────────
    draw() {
        const cnv = this.dom.canvas;
        const r = this.dom.viewport.getBoundingClientRect();
        const W = Math.max(1, Math.floor(r.width));
        const H = Math.max(1, Math.floor(r.height));
        if (cnv.width !== W || cnv.height !== H) {
            cnv.width = W; cnv.height = H;
        }
        const ctx = cnv.getContext("2d");
        ctx.fillStyle = C.bg;
        ctx.fillRect(0, 0, W, H);
        ctx.save();
        ctx.translate(this.panX, this.panY);
        ctx.scale(this.zoom, this.zoom);

        // Underlay: current video frame (downscaled reference picture,
        // stretched to the full frame size). While it loads, keep showing
        // the last frame we had.
        let frame = this.frames?.peek(this.curFrame) || null;
        let frameIsCurrent = !!frame;
        if (frame) {
            this._shownIdx = this.curFrame;
            if (this.frames) this.frames.protect = this.curFrame;
        } else if (this._shownIdx >= 0) {
            frame = this.frames?.peek(this._shownIdx) || null;
        }
        if (frame) {
            ctx.imageSmoothingEnabled = true;
            try { ctx.drawImage(frame, 0, 0, this.frameW, this.frameH); }
            catch (__c2cErr) { __c2cReport("video_mask_editor", __c2cErr); }
        } else {
            ctx.fillStyle = C.bg3;
            ctx.fillRect(0, 0, this.frameW, this.frameH);
        }

        // Onion skin: nearest pinned keyframes (one back, one forward).
        if (this.onion && this.keyframes.size) {
            const sorted = [...this.keyframes.keys()].sort((a, b) => a - b);
            let prev = null, next = null;
            for (const f of sorted) {
                if (f < this.curFrame) prev = f;
                else if (f > this.curFrame && next === null) next = f;
            }
            const onionColors = [
                [prev, "rgba(249,226,175,0.35)"],
                [next, "rgba(137,180,250,0.35)"],
            ];
            for (const [f, tint] of onionColors) {
                if (f == null) continue;
                const id = this.keyframes.get(f);
                if (!id) continue;
                // Render via a temporary canvas tinted with composite.
                const tmp = document.createElement("canvas");
                tmp.width = id.width; tmp.height = id.height;
                tmp.getContext("2d").putImageData(id, 0, 0);
                ctx.globalAlpha = 0.45;
                ctx.drawImage(tmp, 0, 0);
                ctx.globalAlpha = 1.0;
            }
        }

        // Mask overlay.
        if (this.curMask) {
            const tmp = document.createElement("canvas");
            tmp.width = this.curMask.width; tmp.height = this.curMask.height;
            tmp.getContext("2d").putImageData(this.curMask, 0, 0);
            ctx.globalAlpha = 0.65;
            ctx.drawImage(tmp, 0, 0);
            ctx.globalAlpha = 1.0;
        }

        // Frame border.
        ctx.strokeStyle = C.border;
        ctx.lineWidth = 2 / this.zoom;
        ctx.strokeRect(0, 0, this.frameW, this.frameH);

        // Lasso preview.
        if (this.tool === "lasso" && this.lasso.length) {
            ctx.strokeStyle = C.accent2;
            ctx.fillStyle = C.accent2 + "30";
            ctx.lineWidth = 2 / this.zoom;
            ctx.setLineDash([6 / this.zoom, 4 / this.zoom]);
            ctx.beginPath();
            ctx.moveTo(this.lasso[0].x, this.lasso[0].y);
            for (let i = 1; i < this.lasso.length; i++) ctx.lineTo(this.lasso[i].x, this.lasso[i].y);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // Shape preview (live drag outline for rect/ellipse/polygon/star/line).
        if (this.shaping && this.shapeStart && this.shapeCur) {
            ctx.strokeStyle = C.accent;
            ctx.fillStyle = (C.accent || "#89b4fa") + "22";
            ctx.lineWidth = 2 / this.zoom;
            ctx.setLineDash([6 / this.zoom, 4 / this.zoom]);
            if (this.tool === "line") {
                ctx.beginPath();
                ctx.moveTo(this.shapeStart.x, this.shapeStart.y);
                ctx.lineTo(this.shapeCur.x, this.shapeCur.y);
                ctx.stroke();
            } else {
                const pts = this._shapePoints(this.tool, this.shapeStart.x, this.shapeStart.y,
                                              this.shapeCur.x, this.shapeCur.y);
                if (pts.length >= 3) {
                    ctx.beginPath();
                    ctx.moveTo(pts[0][0], pts[0][1]);
                    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
                    ctx.closePath();
                    ctx.fill();
                    ctx.stroke();
                }
            }
            ctx.setLineDash([]);
        }

        // Roto pen preview: smooth curve + rubber band + draggable anchors.
        if (this.tool === "pen" && this.penPoints.length) {
            const P = this.penPoints;
            const closedPreview = P.length >= 3;
            const curve = this._penCurve(closedPreview);
            ctx.lineWidth = 2 / this.zoom;
            // filled preview of the closed area
            if (closedPreview && curve.length >= 3) {
                ctx.fillStyle = (C.accent || "#89b4fa") + "22";
                ctx.beginPath(); ctx.moveTo(curve[0][0], curve[0][1]);
                for (let i = 1; i < curve.length; i++) ctx.lineTo(curve[i][0], curve[i][1]);
                ctx.closePath(); ctx.fill();
            }
            // the curve itself
            ctx.strokeStyle = C.accent;
            ctx.setLineDash([6 / this.zoom, 4 / this.zoom]);
            ctx.beginPath(); ctx.moveTo(curve[0][0], curve[0][1]);
            for (let i = 1; i < curve.length; i++) ctx.lineTo(curve[i][0], curve[i][1]);
            ctx.stroke();
            // rubber band from last anchor to cursor
            if (this.penHover && this.penDragIdx < 0) {
                const lp = P[P.length - 1];
                ctx.beginPath(); ctx.moveTo(lp.x, lp.y); ctx.lineTo(this.penHover.x, this.penHover.y); ctx.stroke();
            }
            ctx.setLineDash([]);
            // anchor handles
            const rr = 5 / this.zoom;
            for (let i = 0; i < P.length; i++) {
                ctx.beginPath(); ctx.arc(P[i].x, P[i].y, rr, 0, Math.PI * 2);
                ctx.fillStyle = (i === 0) ? C.accent2 : "#fff";
                ctx.fill();
                ctx.lineWidth = 1.5 / this.zoom; ctx.strokeStyle = C.accent; ctx.stroke();
            }
        }

        ctx.restore();

        if (this.frames && (this.frames.stale || !frameIsCurrent)) {
            const msg = this.frames.stale
                ? "The node has run on a different input since this editor opened — reopen the editor."
                : `loading frame ${this.curFrame + 1}…`;
            ctx.font = "12px Inter, system-ui";
            const tw = ctx.measureText(msg).width;
            ctx.fillStyle = "rgba(17,17,27,0.8)";
            ctx.fillRect(10, 10, tw + 16, 22);
            ctx.fillStyle = this.frames.stale ? C.warn : C.sub;
            ctx.fillText(msg, 18, 25);
        }

        // Brush cursor outline.
        if ((this.tool === "brush" || this.tool === "erase") && this._cursor) {
            ctx.strokeStyle = this.tool === "erase" ? C.danger : C.accent;
            ctx.lineWidth = 1.5;
            ctx.setLineDash([4, 3]);
            ctx.beginPath();
            ctx.arc(this._cursor.vx, this._cursor.vy,
                    this.brushRadius * this.zoom, 0, Math.PI * 2);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // Update status / sidebar.
        this._updateStatus();
        this._updateSidebar();
        this._drawScrubber();
    }

    _updateStatus() {
        if (!this.dom.status) return;
        const pinned = this.keyframes.has(this.curFrame) || this.curDirty;
        const loaded = this.frames ? this.frames.loadedCount() : 0;
        this.dom.status.textContent =
            `${this.frameW}×${this.frameH} · frame ${this.curFrame + 1}/${this.frameCount} · ` +
            `${pinned ? "📌 keyframe" : "blank"} · ${this.keyframes.size} pinned` +
            (this.curDirty ? " · ●" : "") +
            (this.frames && loaded < this.frameCount ? ` · frames loaded ${loaded}/${this.frameCount}` : "");
    }

    _updateSidebar() {
        const list = this.dom.kfList;
        list.innerHTML = "";
        const sorted = [...this.keyframes.keys()].sort((a, b) => a - b);
        for (const f of sorted) {
            const row = document.createElement("div");
            row.style.cssText = `
                display:flex;align-items:center;gap:6px;padding:4px 8px;
                border-radius:4px;background:${f === this.curFrame ? C.accent + "22" : "transparent"};
                cursor:pointer;font-size:11px;border:1px solid transparent;
                border-color:${f === this.curFrame ? C.accent + "55" : "transparent"};
            `;
            row.onmouseenter = () => { if (f !== this.curFrame) row.style.background = C.rowHover; };
            row.onmouseleave = () => { row.style.background = f === this.curFrame ? C.accent + "22" : "transparent"; };
            const dot = document.createElement("span");
            dot.textContent = "📌";
            dot.style.fontSize = "10px";
            row.appendChild(dot);
            const lbl = document.createElement("span");
            lbl.textContent = `frame ${f}`;
            lbl.style.flex = "1";
            lbl.style.color = C.text;
            lbl.onclick = () => this._switchFrame(f);
            row.appendChild(lbl);
            const del = document.createElement("button");
            del.textContent = "✕";
            del.title = "Delete this keyframe";
            del.style.cssText = `
                width:18px;height:18px;border:none;border-radius:3px;
                background:transparent;color:${C.danger};cursor:pointer;font-size:11px;
            `;
            del.onmouseenter = () => { del.style.background = C.danger + "33"; };
            del.onmouseleave = () => { del.style.background = "transparent"; };
            del.onclick = (e) => {
                e.stopPropagation();
                this.keyframes.delete(f);
                if (f === this.curFrame) {
                    this.curMask = this._emptyMask();
                    this.curDirty = false;
                }
                this.draw();
            };
            row.appendChild(del);
            list.appendChild(row);
        }
        if (!sorted.length) {
            const empty = document.createElement("div");
            empty.textContent = "no keyframes yet — paint then Pin";
            empty.style.cssText = `color:${C.sub};font-size:11px;padding:6px;font-style:italic;`;
            list.appendChild(empty);
        }
    }

    _drawScrubber() {
        const c = this.dom.scrub;
        const r = c.getBoundingClientRect();
        const W = Math.max(1, Math.floor(r.width));
        const H = Math.max(1, Math.floor(r.height));
        if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
        const ctx = c.getContext("2d");
        ctx.fillStyle = C.bg3;
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = C.border;
        ctx.fillRect(8, H / 2 - 2, W - 16, 4);
        const n = Math.max(1, this.frameCount);
        // Frame ticks.
        if (n <= 200) {
            ctx.fillStyle = C.surface1;
            for (let i = 0; i < n; i++) {
                const x = 8 + (W - 16) * (i / Math.max(1, n - 1));
                ctx.fillRect(x - 0.5, H / 2 - 4, 1, 8);
            }
        }
        // Keyframe pins.
        for (const f of this.keyframes.keys()) {
            const x = 8 + (W - 16) * (f / Math.max(1, n - 1));
            ctx.fillStyle = C.accent;
            ctx.beginPath();
            ctx.moveTo(x, 2); ctx.lineTo(x - 4, 10); ctx.lineTo(x + 4, 10);
            ctx.closePath(); ctx.fill();
        }
        // Current frame indicator.
        const cx = 8 + (W - 16) * (this.curFrame / Math.max(1, n - 1));
        ctx.strokeStyle = C.warn;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(cx, 2); ctx.lineTo(cx, H - 2); ctx.stroke();
        ctx.fillStyle = C.warn;
        ctx.beginPath(); ctx.arc(cx, H / 2, 5, 0, Math.PI * 2); ctx.fill();
    }

    // ── Pin / Unpin ──────────────────────────────────────────────────
    pin() {
        if (!this.curMask) return;
        // Empty mask = nothing to pin.
        let any = false;
        const d = this.curMask.data;
        for (let i = 3; i < d.length; i += 4) {
            if (d[i] > 0) { any = true; break; }
        }
        if (!any) {
            vmeAlert("Nothing to pin — paint a mask first.");
            return;
        }
        this.keyframes.set(this.curFrame,
            new ImageData(new Uint8ClampedArray(this.curMask.data),
                          this.curMask.width, this.curMask.height));
        this._noteKeyframeAdded();
        this.curDirty = false;
        this.draw();
    }
    unpin() {
        this.keyframes.delete(this.curFrame);
        this.curMask = this._emptyMask();
        this.curDirty = false;
        this.draw();
    }

    // ── Save to server ───────────────────────────────────────────────
    async save() {
        this._commitCurrent();
        // Init (idempotent) just in case shape changed.
        await fetch(`/vme/init?session=${encodeURIComponent(this.sessionId)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ h: this.frameH, w: this.frameW }),
        });
        // Clear and re-POST every keyframe (simple & correct).
        await fetch(`/vme/clear?session=${encodeURIComponent(this.sessionId)}`, {
            method: "POST",
        });
        let saved = 0;
        const kfObj = {};
        const sorted = [...this.keyframes.entries()].sort((a, b) => a[0] - b[0]);
        for (const [f, id] of sorted) {
            const blob = await this._maskToPngBlob(id);
            const r = await fetch(`/vme/keyframe?session=${encodeURIComponent(this.sessionId)}&frame=${f}`, {
                method: "POST",
                headers: { "Content-Type": "image/png" },
                body: blob,
            });
            if (r.ok) {
                saved++;
                kfObj[f] = await blobToBase64(blob);
            }
        }
        // Remember which frame count these keyframes belong to.
        if (this.keyframes.size) kfObj._frame_count = this.kfFrameCount ?? this.frameCount;
        const kfWidget = this._widget("keyframes_data");
        if (kfWidget) kfWidget.value = JSON.stringify(kfObj);
        return saved;
    }

    async _maskToPngBlob(id) {
        // Reduce RGBA → grayscale L (use alpha channel as luma) for compact PNG.
        const W = id.width, H = id.height;
        const c = document.createElement("canvas");
        c.width = W; c.height = H;
        const cx = c.getContext("2d");
        const out = cx.createImageData(W, H);
        for (let i = 0; i < id.data.length; i += 4) {
            const a = id.data[i + 3];
            out.data[i] = out.data[i + 1] = out.data[i + 2] = a;
            out.data[i + 3] = 255;
        }
        cx.putImageData(out, 0, 0);
        return new Promise(resolve => c.toBlob(resolve, "image/png"));
    }
}


// ─── Modal mount ────────────────────────────────────────────────────
function openModal(node) {
    const ed = new VMEEditor(node);

    const overlay = document.createElement("div");
    // Windowed panel (not fullscreen): centred, ~portion of the screen like
    // ComfyUI's own mask editor. The big spread box-shadow paints the dim
    // backdrop around the panel with no extra element, so close() (which just
    // removes `overlay`) still works. Drag by the title bar, resize from the
    // bottom-right corner (CSS `resize`).
    overlay.style.cssText = `
        position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
        width:min(1360px,90vw);height:min(880px,88vh);
        min-width:520px;min-height:380px;
        z-index:${Z_MODAL};
        background:${C.bg};color:${C.text};
        display:flex;flex-direction:column;
        border:1px solid ${C.border};border-radius:12px;overflow:hidden;resize:both;
        box-shadow:0 0 0 100vmax color-mix(in srgb, ${C.bg} 55%, transparent),
                   0 24px 70px rgba(0,0,0,0.55);
        font-family:Inter,system-ui,sans-serif;
    `;
    document.body.appendChild(overlay);

    // ── Top bar ────────────────────────────────────────────────────
    const top = document.createElement("div");
    top.style.cssText = `
        display:flex;align-items:center;gap:8px;padding:8px 14px;
        background:linear-gradient(${C.panel},${C.scrim5});
        border-bottom:1px solid ${C.border};flex:0 0 auto;flex-wrap:wrap;
    `;
    overlay.appendChild(top);

    const title = document.createElement("div");
    title.innerHTML = `<span style="color:${C.accent};font-weight:600">🎨 Video Mask Editor</span>` +
                      `<span style="color:${C.sub};font-size:11px;margin-left:10px;">session: <code style="color:${C.text}">${ed.sessionId.slice(0,8)}…</code></span>`;
    top.appendChild(title);

    const spacer = document.createElement("div");
    spacer.style.flex = "1";
    top.appendChild(spacer);

    const mkBtn = (label, opts = {}) => {
        const b = document.createElement("button");
        b.innerHTML = label;
        b.title = opts.title || "";
        b.style.cssText = `
            min-width:32px;height:30px;padding:0 12px;
            background:${opts.bg || C.panel};color:${opts.fg || C.text};
            border:1px solid ${opts.border || C.border};border-radius:5px;
            cursor:pointer;font-size:12px;font-weight:500;line-height:1;
            display:inline-flex;align-items:center;justify-content:center;gap:6px;
            transition:background .12s,border-color .12s,transform .05s;
        `;
        b.onmouseenter = () => { b.style.background = opts.hover || C.hover; };
        b.onmouseleave = () => { b.style.background = opts.bg || C.panel; };
        b.onmousedown = () => { b.style.transform = "scale(0.97)"; };
        b.onmouseup = () => { b.style.transform = "scale(1)"; };
        return b;
    };

    // ── Tool buttons ───────────────────────────────────────────────
    // Paint tools + a Nuke-style shape suite. Shape tools drag out a
    // bounding box and rasterise the primitive into the current keyframe's
    // alpha mask, so the frame-by-frame keyframe/tween/player path is
    // completely unchanged — shapes are just another way to fill alpha.
    const tools = [
        { id: "brush",   label: "🖌 Brush",   hot: "B" },
        { id: "erase",   label: "🧽 Erase",   hot: "E" },
        { id: "fill",    label: "🪣 Fill",    hot: "G" },
        { id: "lasso",   label: "✂ Lasso",   hot: "L" },
        { id: "rect",    label: "▭ Rect",    hot: "R", shape: true },
        { id: "ellipse", label: "◯ Ellipse", hot: "C", shape: true },
        { id: "polygon", label: "⬠ Polygon", hot: "P", shape: true },
        { id: "star",    label: "★ Star",    hot: "T", shape: true },
        { id: "line",    label: "／ Line",    hot: "N", shape: true },
        { id: "pen",     label: "✎ Roto",    hot: "Y" },   // editable spline roto
    ];
    const SHAPE_IDS = new Set(tools.filter(t => t.shape).map(t => t.id));
    const toolBtns = {};
    const setTool = (id) => {
        ed.tool = id;
        for (const k in toolBtns) {
            const sel = k === id;
            toolBtns[k].style.background = sel ? C.accent : C.panel;
            toolBtns[k].style.color = sel ? C.bg2 : C.text;
            toolBtns[k].style.borderColor = sel ? C.accent : C.border;
        }
        ed.lasso = [];
        ed.penPoints = []; ed.penHover = null; ed.penDragIdx = -1;   // reset roto path
        // Show polygon/star/rotation controls only for shape tools.
        if (ed._shapeCtrls) ed._shapeCtrls.style.display = SHAPE_IDS.has(id) ? "flex" : "none";
        ed.draw();
    };
    for (const t of tools) {
        const b = mkBtn(t.label, { title: `${t.label} (${t.hot})` });
        b.onclick = () => setTool(t.id);
        toolBtns[t.id] = b;
        top.appendChild(b);
    }

    // ── Brush controls ─────────────────────────────────────────────
    const sliderWrap = (lbl, min, max, val, step, onChange, suffix = "") => {
        const wrap = document.createElement("div");
        wrap.style.cssText = `display:flex;align-items:center;gap:6px;padding:0 4px;font-size:11px;color:${C.sub};`;
        const ttl = document.createElement("span");
        ttl.textContent = lbl;
        ttl.style.minWidth = "44px";
        wrap.appendChild(ttl);
        const inp = document.createElement("input");
        inp.type = "range";
        inp.min = min; inp.max = max; inp.value = val; inp.step = step;
        inp.style.cssText = `width:80px;accent-color:${C.accent};`;
        const out = document.createElement("span");
        out.textContent = val + suffix;
        out.style.cssText = `min-width:36px;color:${C.text};font-family:ui-monospace,monospace;font-size:10px;`;
        inp.oninput = () => {
            const v = +inp.value;
            out.textContent = v + suffix;
            onChange(v);
        };
        wrap.appendChild(inp);
        wrap.appendChild(out);
        return wrap;
    };
    top.appendChild(sliderWrap("Size", 2, 200, ed.brushRadius, 1,
        v => { ed.brushRadius = v; ed._syncBrushPref("brush_size", v); ed.draw(); }, "px"));
    top.appendChild(sliderWrap("Opacity", 5, 100, Math.round(ed.brushOpacity * 100), 1,
        v => { ed.brushOpacity = v / 100; ed._syncBrushPref("brush_opacity", ed.brushOpacity); }, "%"));
    top.appendChild(sliderWrap("Feather", 0, 100, Math.round(ed.brushFeather * 100), 1,
        v => { ed.brushFeather = v / 100; ed._syncBrushPref("brush_feather", ed.brushFeather); }, "%"));

    // Shape params (polygon/star sides, star point sharpness, rotation).
    // Shown only while a shape tool is active (toggled in setTool).
    const shapeCtrls = document.createElement("div");
    shapeCtrls.style.cssText = "display:none;align-items:center;gap:6px;";
    shapeCtrls.appendChild(sliderWrap("Sides", 3, 24, ed.shapeSides, 1,
        v => { ed.shapeSides = v | 0; ed.draw(); }));
    shapeCtrls.appendChild(sliderWrap("Point", 10, 90, Math.round(ed.starInner * 100), 1,
        v => { ed.starInner = v / 100; ed.draw(); }, "%"));
    shapeCtrls.appendChild(sliderWrap("Rotate", 0, 360, 0, 1,
        v => { ed.shapeRotation = v * Math.PI / 180; ed.draw(); }, "°"));
    top.appendChild(shapeCtrls);
    ed._shapeCtrls = shapeCtrls;

    const sep = () => { const d = document.createElement("div"); d.style.cssText = `width:1px;height:22px;background:${C.border};margin:0 4px;`; return d; };
    top.appendChild(sep());

    const btnUndo = mkBtn("↶", { title: "Undo (Ctrl+Z)" });
    btnUndo.onclick = () => ed.undo();
    top.appendChild(btnUndo);
    const btnRedo = mkBtn("↷", { title: "Redo (Ctrl+Y)" });
    btnRedo.onclick = () => ed.redoOp();
    top.appendChild(btnRedo);

    top.appendChild(sep());

    // Whole-frame ops.
    const btnInvert = mkBtn("⇋ Invert", { title: "Invert this frame's mask (I)" });
    btnInvert.onclick = () => ed._invertMask();
    top.appendChild(btnInvert);
    const btnClear = mkBtn("🗑 Clear", { title: "Clear this frame's mask (Del)" });
    btnClear.onclick = () => ed._clearMask();
    top.appendChild(btnClear);
    const btnFillFrame = mkBtn("▣ Fill", { title: "Fill the whole frame" });
    btnFillFrame.onclick = () => ed._fillFrame();
    top.appendChild(btnFillFrame);

    // Add / Subtract mode — shapes & roto cut holes when Subtract is on.
    const btnSub = mkBtn("➖ Subtract", { title: "Shapes/Roto SUBTRACT from the mask (X)" });
    const syncSub = () => {
        btnSub.style.background = ed.subtractMode ? C.danger + "55" : C.panel;
        btnSub.style.borderColor = ed.subtractMode ? C.danger : C.border;
        btnSub.innerHTML = ed.subtractMode ? "➖ Subtract" : "➕ Add";
    };
    btnSub.onclick = () => { ed.subtractMode = !ed.subtractMode; syncSub(); };
    syncSub();
    top.appendChild(btnSub);

    // Roto smoothing toggle.
    const btnSmooth = mkBtn("〜 Smooth", { title: "Roto: smooth spline vs straight edges" });
    const syncSmooth = () => {
        btnSmooth.style.background = ed.penSmooth ? C.accent + "44" : C.panel;
        btnSmooth.innerHTML = ed.penSmooth ? "〜 Smooth" : "⟋ Corners";
    };
    btnSmooth.onclick = () => { ed.penSmooth = !ed.penSmooth; syncSmooth(); ed.draw(); };
    syncSmooth();
    top.appendChild(btnSmooth);

    const btnOnion = mkBtn("🧅 Onion", { title: "Toggle onion-skin (O)", bg: ed.onion ? C.accent + "44" : C.panel });
    btnOnion.onclick = () => {
        ed.onion = !ed.onion;
        btnOnion.style.background = ed.onion ? C.accent + "44" : C.panel;
        ed.draw();
    };
    top.appendChild(btnOnion);

    const btnFit = mkBtn("⬛ Fit", { title: "Fit to view (F)" });
    btnFit.onclick = () => { ed.fitView(); ed.draw(); };
    top.appendChild(btnFit);

    // Reference-picture size: smaller = faster loading, blurrier when
    // zoomed in. Masks are always painted at full size regardless.
    const prevSel = document.createElement("select");
    prevSel.title = "Size of the video frames shown behind the mask (display only)";
    prevSel.style.cssText = `height:30px;padding:0 6px;border-radius:5px;font-size:12px;
        background:${C.panel};color:${C.text};border:1px solid ${C.border};cursor:pointer;`;
    for (const [v, t] of PREVIEW_CHOICES) {
        const o = document.createElement("option");
        o.value = String(v); o.textContent = `Preview: ${t}`;
        prevSel.appendChild(o);
    }
    if (!PREVIEW_CHOICES.some(([v]) => v === ed._previewMaxSide())) {
        const o = document.createElement("option");
        o.value = String(ed._previewMaxSide()); o.textContent = `Preview: ${ed._previewMaxSide()} px`;
        prevSel.appendChild(o);
    }
    prevSel.value = String(ed._previewMaxSide());
    prevSel.onchange = () => { ed.setPreviewMaxSide(Number(prevSel.value)); prevSel.blur(); };
    top.appendChild(prevSel);

    top.appendChild(sep());

    const btnPin = mkBtn("📌 Pin Keyframe", { title: "Pin current mask (K)", bg: C.okBg2, hover: C.okBg, fg: C.accent });
    btnPin.onclick = () => ed.pin();
    top.appendChild(btnPin);

    const btnUnpin = mkBtn("✕ Unpin", { title: "Remove keyframe", bg: C.dangerBg2, hover: C.dangerBg3, fg: C.danger });
    btnUnpin.onclick = () => ed.unpin();
    top.appendChild(btnUnpin);

    top.appendChild(sep());

    const btnSave = mkBtn("💾 Save & Close", { title: "Persist keyframes to server & close",
        bg: C.accent, fg: C.scrim6, border: C.accent, hover: C.okMid2 });
    top.appendChild(btnSave);

    const btnCancel = mkBtn("✕ Cancel", { title: "Discard changes & close",
        bg: C.panel, hover: C.violetBg, fg: C.danger });
    top.appendChild(btnCancel);

    // ── Body: canvas + sidebar ─────────────────────────────────────
    const body = document.createElement("div");
    body.style.cssText = `display:flex;flex:1;min-height:0;`;
    overlay.appendChild(body);

    const viewport = document.createElement("div");
    viewport.style.cssText = `flex:1;position:relative;background:${C.bg};overflow:hidden;cursor:crosshair;`;
    body.appendChild(viewport);

    const canvas = document.createElement("canvas");
    canvas.style.cssText = `display:block;width:100%;height:100%;`;
    canvas.tabIndex = 0;
    viewport.appendChild(canvas);

    const status = document.createElement("div");
    status.style.cssText = `
        position:absolute;left:10px;bottom:48px;padding:4px 10px;
        background:${C.panel}d8;border:1px solid ${C.border};border-radius:5px;
        font-size:11px;color:${C.sub};font-family:ui-monospace,monospace;
        pointer-events:none;letter-spacing:.2px;
    `;
    viewport.appendChild(status);

    const scrubCanvas = document.createElement("canvas");
    scrubCanvas.style.cssText = `
        position:absolute;left:0;right:0;bottom:0;height:36px;width:100%;
        background:${C.bg4};border-top:1px solid ${C.border};cursor:pointer;
    `;
    viewport.appendChild(scrubCanvas);

    // Sidebar
    const sidebar = document.createElement("div");
    sidebar.style.cssText = `
        width:240px;background:${C.panel};border-left:1px solid ${C.border};
        display:flex;flex-direction:column;flex:0 0 240px;
    `;
    body.appendChild(sidebar);
    const sbHead = document.createElement("div");
    sbHead.textContent = "KEYFRAMES";
    sbHead.style.cssText = `
        padding:10px 12px;font-size:10px;font-weight:600;letter-spacing:1px;
        color:${C.sub};border-bottom:1px solid ${C.border};
    `;
    sidebar.appendChild(sbHead);
    const kfList = document.createElement("div");
    kfList.style.cssText = `flex:1;overflow-y:auto;padding:6px;display:flex;flex-direction:column;gap:2px;`;
    sidebar.appendChild(kfList);

    const sbHelp = document.createElement("div");
    sbHelp.style.cssText = `
        padding:10px 12px;font-size:10px;color:${C.sub};line-height:1.6;
        border-top:1px solid ${C.border};font-family:ui-monospace,monospace;
    `;
    sbHelp.innerHTML = `
        <div style="color:${C.text};font-weight:600;margin-bottom:6px;">SHORTCUTS</div>
        <div>B / E / G / L · tools</div>
        <div>[ ] · brush size</div>
        <div>← / → · step frame</div>
        <div>K · pin · O · onion · F · fit</div>
        <div>Ctrl+Z / Y · undo / redo</div>
        <div>Mouse wheel · zoom</div>
        <div>Middle / Space-drag · pan</div>
    `;
    sidebar.appendChild(sbHelp);

    // ── Hook up editor DOM refs ────────────────────────────────────
    ed.dom = { viewport, canvas, status, scrub: scrubCanvas, kfList };

    // ── Pointer handling ───────────────────────────────────────────
    let panning = false; let panStart = null;
    let spaceDown = false;
    canvas.addEventListener("mousedown", (e) => {
        e.preventDefault();
        canvas.focus();
        const r = canvas.getBoundingClientRect();
        const vx = e.clientX - r.left, vy = e.clientY - r.top;
        if (e.button === 1 || (e.button === 0 && spaceDown)) {
            panning = true; panStart = { vx, vy, px: ed.panX, py: ed.panY };
            return;
        }
        if (e.button !== 0) return;
        const fp = ed._viewToFrame(vx, vy);
        if (ed.tool === "fill") {
            ed._pushUndo();
            ed._floodFill(fp.x, fp.y);
            ed.curDirty = true;
            ed.draw();
            return;
        }
        if (ed.tool === "lasso") {
            ed.lasso.push(fp);
            ed.draw();
            return;
        }
        if (SHAPE_IDS.has(ed.tool)) {
            ed._pushUndo();
            ed.shapeStart = fp;
            ed.shapeCur = fp;
            ed.shapeSquare = e.shiftKey;
            ed.shaping = true;
            ed.draw();
            return;
        }
        if (ed.tool === "pen") {
            const tol = 9 / ed.zoom;
            const hit = ed._penHit(fp, tol);
            if (hit === 0 && ed.penPoints.length >= 3) { ed._commitPen(); ed.draw(); return; }
            if (hit >= 0) { ed.penDragIdx = hit; ed.draw(); return; }  // grab to adjust
            ed.penPoints.push({ x: fp.x, y: fp.y });                    // place anchor
            ed.penHover = { x: fp.x, y: fp.y };
            ed.draw();
            return;
        }
        ed._pushUndo();
        ed.painting = true;
        ed._stamp(fp.x, fp.y, null);
        ed.lastPaint = fp;
        ed.curDirty = true;
        ed.draw();
    });

    canvas.addEventListener("mousemove", (e) => {
        const r = canvas.getBoundingClientRect();
        const vx = e.clientX - r.left, vy = e.clientY - r.top;
        ed._cursor = { vx, vy };
        if (panning && panStart) {
            ed.panX = panStart.px + (vx - panStart.vx);
            ed.panY = panStart.py + (vy - panStart.vy);
            ed.draw();
            return;
        }
        if (ed.painting) {
            const fp = ed._viewToFrame(vx, vy);
            ed._stamp(fp.x, fp.y, ed.lastPaint);
            ed.lastPaint = fp;
            ed.draw();
            return;
        }
        if (ed.shaping) {
            ed.shapeCur = ed._viewToFrame(vx, vy);
            ed.shapeSquare = e.shiftKey;
            ed.draw();                         // live preview outline
            return;
        }
        if (ed.tool === "pen") {
            const fp = ed._viewToFrame(vx, vy);
            if (ed.penDragIdx >= 0) { ed.penPoints[ed.penDragIdx] = { x: fp.x, y: fp.y }; }
            ed.penHover = { x: fp.x, y: fp.y };  // rubber-band to cursor
            ed.draw();
            return;
        }
        if (ed.tool === "brush" || ed.tool === "erase") {
            ed.draw();
        }
    });

    canvas.addEventListener("mouseup", (e) => {
        if (panning) { panning = false; panStart = null; }
        if (ed.painting) { ed.painting = false; ed.lastPaint = null; }
        if (ed.penDragIdx >= 0) { ed.penDragIdx = -1; }
        if (ed.shaping) {
            ed.shaping = false;
            ed._rasterizeShape(ed.tool);       // bake the shape into the keyframe alpha
            ed.shapeStart = ed.shapeCur = null;
            ed.draw();
        }
    });

    canvas.addEventListener("dblclick", (e) => {
        if (ed.tool === "lasso" && ed.lasso.length >= 3) {
            ed._pushUndo();
            ed._fillLasso();
            ed.lasso = [];
            ed.curDirty = true;
            ed.draw();
        }
        if (ed.tool === "pen" && ed.penPoints.length >= 3) { ed._commitPen(); ed.draw(); }
    });

    canvas.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        if (ed.tool === "lasso" && ed.lasso.length >= 3) {
            ed._pushUndo();
            ed._fillLasso();
            ed.lasso = [];
            ed.curDirty = true;
            ed.draw();
        }
    });

    canvas.addEventListener("wheel", (e) => {
        e.preventDefault();
        const r = canvas.getBoundingClientRect();
        const ax = e.clientX - r.left, ay = e.clientY - r.top;
        const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        const newZ = Math.max(0.05, Math.min(16, ed.zoom * factor));
        const k = newZ / ed.zoom;
        ed.panX = ax - (ax - ed.panX) * k;
        ed.panY = ay - (ay - ed.panY) * k;
        ed.zoom = newZ;
        ed.draw();
    }, { passive: false });

    // Keyboard.
    const onKey = (e) => {
        if (e.key === " ") { spaceDown = (e.type === "keydown"); e.preventDefault(); return; }
        if (e.type !== "keydown") return;
        if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT")) return;
        if (e.key === "Escape") {
            if (ed.tool === "pen" && ed.penPoints.length) { ed.penPoints = []; ed.penHover = null; ed.penDragIdx = -1; ed.draw(); e.preventDefault(); return; }
            close(false); e.preventDefault(); return;
        }
        if (e.key === "Enter" && ed.tool === "pen" && ed.penPoints.length >= 3) { ed._commitPen(); ed.draw(); e.preventDefault(); return; }
        if (e.key === "Backspace" && ed.tool === "pen" && ed.penPoints.length) { ed.penPoints.pop(); ed.draw(); e.preventDefault(); return; }
        const mod = e.ctrlKey || e.metaKey;
        // Whole-frame ops.
        if ((e.key === "i" || e.key === "I") && !mod) { ed._invertMask(); e.preventDefault(); return; }
        if ((e.key === "Delete") && !mod) { ed._clearMask(); e.preventDefault(); e.stopImmediatePropagation(); return; }
        if ((e.key === "x" || e.key === "X") && !mod) { btnSub.click(); e.preventDefault(); return; }
        if ((e.key === "y" || e.key === "Y") && !mod) { setTool("pen"); e.preventDefault(); return; }
        if (e.key === "b" || e.key === "B") { setTool("brush"); e.preventDefault(); return; }
        if (e.key === "e" || e.key === "E") { setTool("erase"); e.preventDefault(); return; }
        if (e.key === "g" || e.key === "G") { setTool("fill"); e.preventDefault(); return; }
        if (e.key === "l" || e.key === "L") { setTool("lasso"); e.preventDefault(); return; }
        if (e.key === "r" || e.key === "R") { setTool("rect"); e.preventDefault(); return; }
        if (e.key === "c" || e.key === "C") { setTool("ellipse"); e.preventDefault(); return; }
        if (e.key === "p" || e.key === "P") { setTool("polygon"); e.preventDefault(); return; }
        if (e.key === "t" || e.key === "T") { setTool("star"); e.preventDefault(); return; }
        if (e.key === "n" || e.key === "N") { setTool("line"); e.preventDefault(); return; }
        if (e.key === "k" || e.key === "K") { ed.pin(); e.preventDefault(); return; }
        if (e.key === "o" || e.key === "O") { btnOnion.click(); e.preventDefault(); return; }
        // NOTE: bare F is reserved by KJNodes.fillConnectSelected. Use Shift+F here.
        if ((e.key === "F" || e.key === "f") && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
            ed.fitView(); ed.draw(); e.preventDefault(); e.stopImmediatePropagation(); return;
        }
        if (e.key === "[") { ed.brushRadius = Math.max(2, ed.brushRadius - 4); ed._syncBrushPref("brush_size", ed.brushRadius); ed.draw(); e.preventDefault(); return; }
        if (e.key === "]") { ed.brushRadius = Math.min(200, ed.brushRadius + 4); ed._syncBrushPref("brush_size", ed.brushRadius); ed.draw(); e.preventDefault(); return; }
        if (e.key === "ArrowLeft") { ed._switchFrame(ed.curFrame - 1); e.preventDefault(); return; }
        if (e.key === "ArrowRight") { ed._switchFrame(ed.curFrame + 1); e.preventDefault(); return; }
        if ((e.key === "z" || e.key === "Z") && (e.ctrlKey || e.metaKey) && !e.shiftKey) { ed.undo(); e.preventDefault(); return; }
        if ((e.key === "y" || e.key === "Y") && (e.ctrlKey || e.metaKey)) { ed.redoOp(); e.preventDefault(); return; }
        if (e.key === "Z" && (e.ctrlKey || e.metaKey) && e.shiftKey) { ed.redoOp(); e.preventDefault(); return; }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);

    // Scrubber.
    let scrubbing = false;
    const scrubXToFrame = (clientX) => {
        const r = scrubCanvas.getBoundingClientRect();
        const t = (clientX - r.left - 8) / Math.max(1, r.width - 16);
        const n = Math.max(1, ed.frameCount);
        return Math.max(0, Math.min(n - 1, Math.round(t * (n - 1))));
    };
    scrubCanvas.addEventListener("mousedown", (e) => {
        scrubbing = true;
        ed._switchFrame(scrubXToFrame(e.clientX));
    });
    const onScrubMove = (e) => {
        if (scrubbing) ed._switchFrame(scrubXToFrame(e.clientX));
    };
    const onScrubUp = () => { scrubbing = false; };
    window.addEventListener("mousemove", onScrubMove);
    window.addEventListener("mouseup", onScrubUp);
    // Keep the "frames loaded n/N" counter moving while frames stream in.
    const statusTimer = setInterval(() => {
        if (ed.frames && ed.frameCount) ed._updateStatus();
    }, 400);

    // Resize observer.
    const ro = new ResizeObserver(() => ed.draw());
    ro.observe(viewport);

    // ── Save / Cancel handlers ─────────────────────────────────────
    let closing = false;
    const close = async (commit) => {
        if (closing) return;
        closing = true;
        window.removeEventListener("keydown", onKey);
        window.removeEventListener("keyup", onKey);
        window.removeEventListener("mousemove", onScrubMove);
        window.removeEventListener("mouseup", onScrubUp);
        clearInterval(statusTimer);
        ro.disconnect();
        if (commit) {
            btnSave.disabled = true;
            btnSave.textContent = "saving…";
            try {
                const n = await ed.save();
                console.log(`[VME] saved ${n} keyframes for session ${ed.sessionId}`);
            } catch (e) {
                console.error("[VME] save failed:", e);
                vmeAlert("Save failed:\n" + (e?.message || e));
                closing = false;
                btnSave.disabled = false;
                btnSave.innerHTML = "💾 Save & Close";
                return;
            }
            // Trigger a redraw of the node so the session_id field shows.
            ed.node.graph?.setDirtyCanvas(true, true);
        }
        ed.frames?.dispose();
        document.body.removeChild(overlay);
    };
    btnSave.onclick = () => close(true);
    btnCancel.onclick = () => close(false);

    // ── Init ───────────────────────────────────────────────────────
    setTool("brush");
    ed.loadFrames().then(ok => {
        if (!ok) { close(false); return; }
        ed.fitView();
        ed.draw();
        canvas.focus();
    });
}


// ─── Extension registration ─────────────────────────────────────────
app.registerExtension({
    name: "VideoMaskEditor.Editor",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;
        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            origCreated?.apply(this, arguments);
            const self = this;
            // Ensure session_id is populated.
            setTimeout(() => {
                const w = self.widgets?.find(w => w.name === "session_id");
                if (w && (!w.value || w.value.length < 8)) {
                    w.value = uuid();
                }
                for (const name of ["keyframes_data"]) {
                    const hw = self.widgets?.find(w => w.name === name);
                    if (!hw) continue;
                    hw.computeSize = () => [0, -4];
                    hw.type = "hidden";
                    if (hw.element) hw.element.style.display = "none";
                    if (hw.inputEl) hw.inputEl.style.display = "none";
                }
            }, 0);
            // Add an "Open Editor" big button widget at the top.
            this.addWidget(
                "button",
                "🎨 Open Video Mask Editor",
                null,
                () => openModal(self),
                { serialize: false }
            );
        };

        // Workflows saved by earlier versions had extra widgets after
        // keyframes_data: [.., keyframes_data, brush_size, brush_opacity,
        // brush_feather(, keyframe_frame_count)]. Saved values are matched
        // to widgets by position, so move those into their new homes.
        const origConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            origConfigure?.apply(this, arguments);
            const vals = Array.isArray(info?.widgets_values) ? info.widgets_values : null;
            if (!vals || vals.length < 8) return;
            if (!this.properties) this.properties = {};
            const names = ["brush_size", "brush_opacity", "brush_feather"];
            names.forEach((n, k) => {
                const v = vals[5 + k];
                if (typeof v === "number" && isFinite(v) && this.properties[BRUSH_PROPS[n]] == null) {
                    this.properties[BRUSH_PROPS[n]] = v;
                }
            });
            const kfw = this.widgets?.find(w => w.name === "keyframes_data");
            const n = vals[8];
            if (kfw?.value && Number.isInteger(n) && n > 0 && readKeyframeFrameCount(kfw.value) == null) {
                try {
                    const obj = JSON.parse(kfw.value);
                    if (obj && typeof obj === "object" && Object.keys(obj).some(k => /^\d+$/.test(k))) {
                        obj._frame_count = n;
                        kfw.value = JSON.stringify(obj);
                    }
                } catch (e) { __c2cReport("migrate", e); }
            }
        };
    },
});

