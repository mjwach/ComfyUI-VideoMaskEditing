# Changes from the original

This repository is derived from **ComfyUI-CustomNodePacks** by
Code2Collapse (Likhith) -- https://github.com/Code2Collapse
(https://github.com/Code2Collapse/ComfyUI-CustomNodePacks), Apache-2.0,
taken at commit `91cd7e61d1f9fc9accd26e198bdb92d859fa778a` (2026-09-19).

This file records what was changed, as Apache-2.0 section 4(b) asks. Every
modified file also carries a notice in its header. The git history starts
with the unmodified upstream files, so `git diff` against the first commit
shows every change in detail.

## What was kept

| File here | Original file | Status |
|---|---|---|
| `nodes/video_mask_editor.py` | `nodes/video_mask_editor.py` | modified |
| `js/video_mask_editor.js` | `js/video_mask_editor.js` | modified |
| `nodes/refine_node.py` | `nodes/mask_matting/refine_node.py` | modified |
| `nodes/mask_integrity.py` | part of `nodes/mask_matting/temporal_node.py` | extracted |
| `nodes/_is_changed_util.py` | `nodes/_is_changed_util.py` | unchanged |
| `LICENSE` | `LICENSE` | unchanged |
| `NOTICE` | `NOTICE` | unchanged |
| `__init__.py`, `nodes/__init__.py` | — | new (replace the original package files) |
| `README.md`, `CHANGES.md`, `requirements.txt`, `.gitignore` | — | new |

## What was removed

Everything else in the original pack: its 87 other nodes, its
global interface extensions, its theme, dialog and error-reporting helper
scripts, its background services (preview guard, integrity scanner,
parameter history and so on), its documentation, tests, example workflows
and vendored third-party code.

## Video Mask Editor

`nodes/video_mask_editor.py` and `js/video_mask_editor.js`:

- **Keyframes saved in the workflow.** A hidden `keyframes_data` input holds
  the pinned keyframes as base64 PNGs, so they survive a server restart and
  travel with the workflow. It takes priority over the in-memory session.
- **Brush settings remembered.** Brush size, opacity and feather are kept in
  the node's properties, which are saved with the workflow but never sent to
  the backend. As node inputs (an intermediate version) any change to them
  made ComfyUI re-run the node and everything downstream. Workflows saved
  with those inputs are converted when loaded. Feather now defaults to 0.
- **Frames come from the node itself.** The editor used to find its frames
  in an upstream preview (in practice a Preview Image node holding every
  frame). Now each run of the node remembers its input, and the editor
  fetches frames from new `/vme/frames/info` and `/vme/frames/frame` routes:
  downscaled, JPEG-encoded on request, cached on the server, prefetched
  outward from the current frame, with only a small window decoded in the
  browser at a time. A new Preview size menu in the editor (stored as a node
  property, not an input) sets the downscaling.
- **Keyframe dimension memory and rescaling.** The input's frame count is
  recorded when keyframes are first added, stored as a `_frame_count` entry
  inside `keyframes_data`. When the editor opens on an input whose
  width, height or frame count differs from the keyframes', a dialog offers
  Cancel, Delete all keyframes, or Rescale (nearest-neighbor or bilinear;
  frame indices scaled by new/old count and rounded). Keyframes are now
  loaded at their own size instead of being stretched to the current
  frames.
- **Mismatch check when running.** The node raises a clear error when its
  keyframes don't match the input's size, or a recorded frame count doesn't
  match the input's length.
- The node is now an output node, so it can be run on its own to load
  frames into the editor.
- Server routes moved from `/mec/video_mask_editor/*` to `/vme/*`.
- The editor's dependencies on the pack's shared scripts (`_frame_finder.js`,
  `_c2c_dialog.js`, `_c2c_report.js`, and CSS variables from
  `_c2c_theme.js`) were replaced by small local code and fixed colours.
  Event listeners are now removed when the editor closes.
- Menu category changed from `C2C/VideoMask` to `mask`.

## Mask Refiner

`nodes/refine_node.py`:

- Moved from `nodes/mask_matting/` to `nodes/`, with imports adjusted.
- The optional integrity check imports `compute_integrity` from
  `nodes/mask_integrity.py`. It no longer publishes its report to the
  original pack's diagnostics panel, which isn't included. The report still
  appears in the `info` output.
- Menu category changed from `C2C/Pipeline` to `mask`.

`nodes/mask_integrity.py` contains `_mask_stats`, `_iou` and
`compute_integrity`, copied unchanged from
`nodes/mask_matting/temporal_node.py`. The rest of that file (the Mask
Temporal Stabilizer node and its RAFT optical-flow code) was not kept.
