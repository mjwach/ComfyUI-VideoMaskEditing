# ComfyUI-VideoMaskEditor

Two ComfyUI nodes, taken from a much larger node pack and modified:

- **Video Mask Editor**: paint masks over a video in a full-screen editor in
  the browser (brush, eraser, fill, lasso, shapes, roto spline, onion skin).
  You pin masks on a few keyframes; the frames in between are interpolated
  when the node runs.
- **Mask Refiner**: training-free mask cleanup (hole fill, morphology,
  guided filter, edge snapping, feathering, thresholding and more), each
  stage switchable.

## Origin and attribution

This work is derived from and includes code by:
"Code2Collapse (Likhith) -- https://github.com/Code2Collapse"

It was extracted from **ComfyUI-CustomNodePacks**
(https://github.com/Code2Collapse/ComfyUI-CustomNodePacks), as of commit
`91cd7e61d1f9fc9accd26e198bdb92d859fa778a` (2026-09-19), which is licensed
under the Apache License 2.0. Only these two nodes and the code they depend
on were kept; the rest of that pack (its other nodes, interface changes and
vendored third-party code) is not included. The files that were kept have
been modified. Each one says so in a header comment, and
[CHANGES.md](CHANGES.md) lists the changes.

This is an independent modified copy. It is not affiliated with or endorsed
by the original author, so please don't report problems with it to the
original project.

## Installation

Clone this repository into `ComfyUI/custom_nodes/` and restart ComfyUI:

```
cd ComfyUI/custom_nodes
git clone <this repository's URL>
```

Dependencies: `numpy`, `Pillow` and `torch` come with ComfyUI.
`opencv-python` and `scipy` are recommended (see `requirements.txt`). Mask
Refiner can also use `opencv-contrib-python`, `scikit-image` and
`pydensecrf` for some of its stages, and skips those stages if they're
missing.

**Don't install this alongside ComfyUI-CustomNodePacks.** The node type
names (`VideoMaskEditorMEC`, `MaskRefineMEC`) are deliberately unchanged so
that workflows saved with the original pack still load here, which means
the two packs would clash.

Both nodes are in the **mask** category of the Add Node menu.

## Using the Video Mask Editor

1. Connect a video (an IMAGE batch) to the node's `image` input.
2. **Run the node once.** That's how it gets the frames to show in the
   editor. Running the whole workflow works. Because the node is an output
   node, you can also select it and run just that node (and whatever feeds
   it). A Preview Image node is not needed.
3. Click **🎨 Open Video Mask Editor**. Frames load on demand as downscaled
   pictures. The **Preview** menu in the toolbar sets their size (smaller
   loads faster but looks blurrier when zoomed in). Masks are always painted
   at the video's full resolution, whatever the preview size.
4. Paint a mask, **Pin** it (K), move to another frame (arrow keys or the
   scrubber), and repeat. Then **Save & Close**. Keyframes are stored in the
   workflow itself.
5. Run the workflow. The `mask` output has one mask per input frame.

### When the input video changes

The node remembers the size of the video its keyframes were made for (the
masks' own width and height, and the frame count recorded when the first
keyframe was added). If you open the editor and the connected video has a
different width, height or frame count, a dialog compares the two and offers:

- **Cancel**: close the editor and change nothing.
- **Delete all keyframes**: start over. The remembered size is cleared too
  and gets recorded again with the next keyframe.
- **Apply** the choices shown above the buttons:
  - **Size**: if the width or height changed, every keyframe is resized,
    with **nearest neighbor** (keeps hard-edged masks hard) or **bilinear**.
  - **Timing**: either **keep keyframes on their current frames**, or
    **stretch timing** to the new length. Stretching multiplies each frame
    index by new frame count / old frame count and rounds it. If two
    keyframes land on the same frame, the one whose exact position was
    closest is kept. If the old frame count isn't known (keyframes saved by
    older versions), you type it in to stretch.
  - When keeping keyframes in place would leave some **past the end** of the
    video, a checkbox lets you delete them.

  The button names what will actually happen ("Rescale keyframes", "Delete
  those keyframes", or "Keep keyframes as they are"), and only the controls
  that would make a difference are shown. Changes take effect when you
  **Save & Close**.

### Keyframes past the end of the video

Keyframes may sit beyond the last frame, for example after keeping their
positions when the video got shorter. They aren't shown on any frame, but
the frames after the last visible keyframe blend toward them, as if they
were just off-screen. (If every keyframe is past the end, every frame gets
the earliest one.) In the editor they're listed in the sidebar as "past
end", where ✕ deletes them, and a hollow marker at the right end of the
scrubber shows they exist. Stretching timing keeps them proportionally past
the end. If the video later gets longer, they come back into view.

Until the keyframes are rescaled or deleted, running the node on a
mismatched video stops with an error that says what doesn't match, instead
of quietly stretching the masks.

## License

Apache License 2.0; see [LICENSE](LICENSE). The [NOTICE](NOTICE) file is
reproduced unchanged from the original project, as it asks. Some of the
third-party components it lists belong to parts of that project that are
not included here.
