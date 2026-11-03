"""
ComfyUI-VideoMaskEditor
=======================
Two nodes extracted (and modified) from ComfyUI-CustomNodePacks by
Code2Collapse (Likhith) -- https://github.com/Code2Collapse
(https://github.com/Code2Collapse/ComfyUI-CustomNodePacks), Apache-2.0:

  - Video Mask Editor  (VideoMaskEditorMEC)  -- paint keyframe masks over a
    video in the browser; in-between frames are interpolated.
  - Mask Refiner       (MaskRefineMEC)       -- training-free mask cleanup.

The node type names are unchanged from the original pack, so workflows saved
with it load here. Don't install both packs at once: they register the same
node names.

This file is new (it replaces the original pack's much larger __init__.py).
"""

from .nodes.video_mask_editor import (
    VideoMaskEditorMEC,
    register_routes as _register_vme_routes,
)
from .nodes.refine_node import MaskRefineMEC

NODE_CLASS_MAPPINGS = {
    "VideoMaskEditorMEC": VideoMaskEditorMEC,
    "MaskRefineMEC": MaskRefineMEC,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "VideoMaskEditorMEC": "Video Mask Editor",
    "MaskRefineMEC": "Mask Refiner",
}

WEB_DIRECTORY = "./js"

try:
    import server as _comfy_server
    _register_vme_routes(_comfy_server.PromptServer.instance)
except Exception as _exc:  # not running inside ComfyUI (e.g. tests)
    print(f"[VideoMaskEditor] server routes not registered: {_exc}")

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
