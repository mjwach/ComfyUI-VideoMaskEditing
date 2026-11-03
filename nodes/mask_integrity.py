# Derived from nodes/mask_matting/temporal_node.py in ComfyUI-CustomNodePacks
# by Code2Collapse (Likhith) -- https://github.com/Code2Collapse
# (https://github.com/Code2Collapse/ComfyUI-CustomNodePacks), Apache-2.0.
# Modified: only the per-frame integrity check used by Mask Refiner was kept
# (_mask_stats, _iou, compute_integrity, copied unchanged); the
# MaskTemporalMEC node, RAFT optical-flow code and their imports were removed.
"""Per-frame mask integrity check (area / centroid / IoU drift)."""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

import torch


def _mask_stats(m_hw: torch.Tensor) -> Tuple[float, Tuple[float, float]]:
    """Return (area_fraction, (cx_norm, cy_norm))."""
    H, W = m_hw.shape[-2:]
    bin_m = (m_hw > 0.5).float()
    area = float(bin_m.sum().item())
    total = float(H * W)
    if area < 1e-6:
        return 0.0, (0.5, 0.5)
    ys, xs = torch.nonzero(bin_m, as_tuple=True)
    cx = float(xs.float().mean().item()) / max(W - 1, 1)
    cy = float(ys.float().mean().item()) / max(H - 1, 1)
    return area / total, (cx, cy)


def _iou(a_hw: torch.Tensor, b_hw: torch.Tensor) -> float:
    a = (a_hw > 0.5).float()
    b = (b_hw > 0.5).float()
    inter = float((a * b).sum().item())
    union = float(((a + b) > 0).float().sum().item())
    return inter / max(union, 1e-6)


def compute_integrity(mask_bhw: torch.Tensor,
                       drop_threshold: float = 0.4,
                       jump_threshold: float = 0.15) -> Dict[str, Any]:
    """Per-frame drift detection.

    * Total mask dropout (area falls to 0) and re-appearance are always
      flagged.
    * area_ratio: frame i's area / frame i-1's area; when the relative
      drop meets or exceeds ``drop_threshold`` the frame is flagged
      (e.g. ``drop_threshold=0.4`` flags any frame whose mask shrank to
      60% or less of the previous frame).
    * centroid_delta: L2 distance in normalised coords; values greater
      than ``jump_threshold`` flag the frame.
    * iou_prev: IoU with the previous binary mask; when both frames
      are non-empty but IoU is below ``1 - drop_threshold`` the
      subject has likely jumped or been re-targeted.

    Returns dict suitable for JSON serialisation + a list of flagged
    frame indices.
    """
    B = mask_bhw.shape[0]
    frames: List[Dict[str, Any]] = []
    flagged: List[int] = []
    prev_area: Optional[float] = None
    prev_cx: Optional[float] = None
    prev_cy: Optional[float] = None
    prev_mask: Optional[torch.Tensor] = None
    for i in range(B):
        area, (cx, cy) = _mask_stats(mask_bhw[i])
        rec: Dict[str, Any] = {"i": i, "area": round(area, 5),
                                "cx": round(cx, 4), "cy": round(cy, 4)}
        if prev_area is not None:
            ratio = area / max(prev_area, 1e-6)
            cdist = float(((cx - prev_cx) ** 2 + (cy - prev_cy) ** 2) ** 0.5)
            iou = _iou(mask_bhw[i], prev_mask) if prev_mask is not None else 1.0
            rec.update({
                "area_ratio": round(ratio, 4),
                "centroid_delta": round(cdist, 4),
                "iou_prev": round(iou, 4),
            })
            why: List[str] = []
            # Total mask dropout (mask had area, now zero) — always
            # flagged regardless of drop_threshold; this is the single
            # most important integrity event.
            if prev_area > 0 and area <= 0:
                why.append("mask dropout (area=0)")
            # Total mask reappearance after dropout.
            elif prev_area <= 0 and area > 0:
                why.append("mask reappeared after dropout")
            # Partial area drop (relative).  ratio = area / prev_area;
            # a drop of >= drop_threshold means new area is <= (1 - dt) of
            # previous — e.g. dt=0.4 flags any frame where mask shrank to
            # 60% or less of its previous size.
            elif area > 0 and prev_area > 0 and ratio <= (1.0 - drop_threshold):
                why.append(f"area drop to {ratio:.2f}x")
            if cdist > jump_threshold:
                why.append(f"centroid jump {cdist:.2f}")
            # IoU disconnect: when both masks are non-empty but their
            # overlap is below (1 - drop_threshold), the subject has
            # likely jumped or been re-targeted.
            if iou < (1.0 - drop_threshold) and prev_area > 0 and area > 0:
                why.append(f"low IoU {iou:.2f}")
            if why:
                rec["warn"] = "; ".join(why)
                flagged.append(i)
        frames.append(rec)
        prev_area, prev_cx, prev_cy = area, cx, cy
        prev_mask = mask_bhw[i]
    return {
        "B": B,
        "flagged_count": len(flagged),
        "flagged_frames": flagged,
        "frames": frames,
        "drop_threshold": drop_threshold,
        "jump_threshold": jump_threshold,
    }

