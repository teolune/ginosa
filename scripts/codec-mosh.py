#!/usr/bin/env python3
"""
Codec-level datamosh references for M14's side-by-side tests: a stand-in until Engine B (M15).

The plain export is encoded as an MPEG-4 Part 2 elementary stream (no B-frames, one I-frame at
the start, plus one at the cut when asked), the compressed frames are edited, and FFmpeg decodes
the broken stream back:

  cut   <plain.mov> <frame> <out.mov>          the I-frame at <frame> is removed, so the next shot's
                                               P-frames (motion and residual) land on the last shot
  bloom <plain.mov> <frame> <count> <out.mov>  P-frame <frame> repeated <count> times, in place of
                                               the frames after it (the length stays the same)
  video <out.mp4> <from> <to> <label=file>...  the same files side by side as a video, frames <from> to <to>
  sheet <out.png> <title> <rows> <label=file[@offset]>...
                                               stills side by side: one row per timeline frame in
                                               <rows> (comma-separated), one column per file; a
                                               file whose frames run <offset> behind the timeline
                                               (cut: 1 after the cut) is read that much earlier

Only FFmpeg and Python 3 are needed. Inputs are read, never changed.
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile

VOP = b"\x00\x00\x01\xb6"
GOV = b"\x00\x00\x01\xb3"


def ffmpeg(*args: str) -> None:
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args], check=True)


def encode(plain: str, keyframe: int | None, out: str) -> None:
    """Plain → MPEG-4 Part 2 (q 2, no B-frames, no scene-cut keyframes)."""
    force = ["-force_key_frames", f"expr:eq(n,{keyframe})"] if keyframe is not None else []
    ffmpeg("-i", plain, "-an", "-c:v", "mpeg4", "-q:v", "2", "-bf", "0", "-g", "600", "-sc_threshold", "1000000000", *force, "-f", "m4v", out)


def split(stream: bytes) -> tuple[bytes, list[bytes]]:
    """The headers before the first frame, and each frame (a VOP, with any GOV header before it)."""
    starts = []
    i = stream.find(VOP)
    while i >= 0:
        starts.append(i)
        i = stream.find(VOP, i + 4)
    frames = []
    for n, at in enumerate(starts):
        end = starts[n + 1] if n + 1 < len(starts) else len(stream)
        frames.append(stream[at:end])
    head = stream[: starts[0]]
    # A GOV header belongs with the frame after it.
    for n in range(len(frames) - 1):
        g = frames[n].find(GOV)
        if g > 0:
            frames[n + 1] = frames[n][g:] + frames[n + 1]
            frames[n] = frames[n][:g]
    g = head.find(GOV)
    if g >= 0:
        frames[0] = head[g:] + frames[0]
        head = head[:g]
    return head, frames


def kind(frame: bytes) -> str:
    at = frame.find(VOP) + 4
    return "IPBS"[frame[at] >> 6]


def decode(head: bytes, frames: list[bytes], out: str, tmp: str) -> None:
    moshed = os.path.join(tmp, "moshed.m4v")
    with open(moshed, "wb") as f:
        f.write(head + b"".join(frames))
    ffmpeg("-r", "25", "-i", moshed, "-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le", out)


def cut(plain: str, frame: int, out: str) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        m4v = os.path.join(tmp, "plain.m4v")
        encode(plain, frame, m4v)
        head, frames = split(open(m4v, "rb").read())
        kinds = "".join(kind(f) for f in frames)
        if kinds[frame] != "I" or kinds.count("I") != 2:
            sys.exit(f"expected I-frames at 0 and {frame} only, got {[i for i, k in enumerate(kinds) if k == 'I']}")
        decode(head, frames[:frame] + frames[frame + 1 :], out, tmp)
        print(f"{out}: {len(frames)} frames, the I-frame at {frame} removed (frames after it are one earlier)")


def bloom(plain: str, frame: int, count: int, out: str) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        m4v = os.path.join(tmp, "plain.m4v")
        encode(plain, None, m4v)
        head, frames = split(open(m4v, "rb").read())
        kinds = "".join(kind(f) for f in frames)
        if kinds.count("I") != 1 or kinds[frame] != "P":
            sys.exit(f"expected one I-frame and a P-frame at {frame}, got {kinds[: frame + 2]}")
        decode(head, frames[:frame] + [frames[frame]] * count + frames[frame + count :], out, tmp)
        print(f"{out}: P-frame {frame} repeated {count} times")


FONTS = [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]


def sheet(out: str, title: str, rows: str, columns: list[str], labels: bool = True) -> None:
    """Stills side by side, with FFmpeg alone: select the frames, tile them into a column per file, stack."""
    times = [int(r) for r in rows.split(",")]
    w, h, top, left = 480, 270, 72, 64
    font = next((f for f in FONTS if os.path.exists(f)), None) if labels else None
    with tempfile.TemporaryDirectory() as tmp:
        def text(name: str, value: str, x: int, y: int, size: int) -> str:
            # From a file, so nothing in the text needs escaping for the filter graph.
            path = os.path.join(tmp, f"{name}.txt")
            with open(path, "w") as f:
                f.write(value)
            return f"drawtext=fontfile={font}:textfile={path}:x={x}:y={y}:fontsize={size}:fontcolor=white" if font else "null"

        inputs: list[str] = []
        chains: list[str] = []
        for c, spec in enumerate(columns):
            label, _, rest = spec.partition("=")
            path, _, offset = rest.partition("@")
            picks = [max(0, t - int(offset or 0)) for t in times]
            if picks != sorted(set(picks)):
                sys.exit("rows must be increasing (after any offset)")
            inputs += ["-i", path]
            select = "+".join(f"eq(n\\,{p})" for p in picks)
            chains.append(f"[{c}:v]select='{select}',scale={w}:{h},setsar=1,tile=1x{len(picks)}:padding=6:color=0x18181a,pad=iw+6:ih+{top}:0:{top}:color=0x18181a,{text(f'c{c}', label, 0, top - 26, 18)}[c{c}]")
        stacked = "".join(f"[c{c}]" for c in range(len(columns)))
        marks = ",".join(text(f"r{r}", str(t), 10, top + r * (h + 6) + 8, 18) for r, t in enumerate(times))
        chains.append(f"{stacked}hstack=inputs={len(columns)},pad=iw+{left}:ih:{left}:0:color=0x18181a,{marks},{text('title', title, 10, 10, 24)}[out]")
        graph = os.path.join(tmp, "graph.txt")
        with open(graph, "w") as f:
            f.write(";\n".join(chains))
        try:
            ffmpeg(*inputs, "-filter_complex_script", graph, "-map", "[out]", "-frames:v", "1", out)
        except subprocess.CalledProcessError:
            if not font:
                raise
            # An FFmpeg built without drawtext: the same sheet, unlabelled.
            print("(no labels: this FFmpeg can't draw text)")
            return sheet(out, title, rows, columns, labels=False)
    print(out)


def video(out: str, start: int, end: int, columns: list[str], labels: bool = True) -> None:
    """Files side by side in one row, 640 × 360 each, from frame `start` to `end`, labelled."""
    font = next((f for f in FONTS if os.path.exists(f)), None) if labels else None
    with tempfile.TemporaryDirectory() as tmp:
        inputs: list[str] = []
        chains: list[str] = []
        for c, spec in enumerate(columns):
            label, _, path = spec.partition("=")
            inputs += ["-i", path]
            draw = "null"
            if font:
                name = os.path.join(tmp, f"{c}.txt")
                with open(name, "w") as f:
                    f.write(label)
                draw = f"drawtext=fontfile={font}:textfile={name}:x=12:y=10:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=6"
            chains.append(f"[{c}:v]trim=start_frame={start}:end_frame={end},setpts=PTS-STARTPTS,scale=640:360,setsar=1,{draw}[c{c}]")
        chains.append("".join(f"[c{c}]" for c in range(len(columns))) + f"hstack=inputs={len(columns)},format=yuv420p[out]")
        graph = os.path.join(tmp, "graph.txt")
        with open(graph, "w") as f:
            f.write(";\n".join(chains))
        try:
            ffmpeg(*inputs, "-filter_complex_script", graph, "-map", "[out]", "-c:v", "libx264", "-crf", "18", "-r", "25", out)
        except subprocess.CalledProcessError:
            if not font:
                raise
            print("(no labels: this FFmpeg can't draw text)")
            return video(out, start, end, columns, labels=False)
    print(out)


if __name__ == "__main__":
    a = sys.argv[1:]
    if a[:1] == ["cut"] and len(a) == 4:
        cut(a[1], int(a[2]), a[3])
    elif a[:1] == ["bloom"] and len(a) == 5:
        bloom(a[1], int(a[2]), int(a[3]), a[4])
    elif a[:1] == ["video"] and len(a) >= 5:
        video(a[1], int(a[2]), int(a[3]), a[4:])
    elif a[:1] == ["sheet"] and len(a) >= 5:
        sheet(a[1], a[2], a[3], a[4:])
    else:
        sys.exit(__doc__)
