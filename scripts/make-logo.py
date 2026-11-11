#!/usr/bin/env python3
"""
The ginosa mark (decision 113), built from assets/logo/ginosa-clef.txt: your 8-bit treble clef
(Reference Materials/8bitG (high res).png) one character per pixel, '#' on, '.' off, read off
your file's 20 x 57 pixel grid. Writes:

  assets/logo/ginosa-logo.svg              the mark as a vector, pixel for pixel
  assets/logo/ginosa-icon.png              the Dock icon (1024 px) after your Icon Composer file
  assets/logo/Ginosa.icon/                 an Icon Composer file with the mark as its layer
  src/renderer/src/app/logo-path.ts        the outline for the interface's Logo

Run from the ginosa folder:  python3 scripts/make-logo.py   (needs numpy and Pillow)
"""
import json
import os
from collections import defaultdict

import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOGO = os.path.join(ROOT, 'assets', 'logo')

# Your Icon Composer file (Reference Materials/Ginosa.icon), as Display P3
BG_TOP = (0.17911, 0.12834, 0.43576)
BG_BOTTOM = (0.25388, 0.05574, 0.47668)   # reached 70% of the way down
CLEF_FILL = (0.67103, 0.64242, 1.0)
LAYER_SCALE = 0.32                        # of the 3000 px layer image, on the 1024 pt canvas
IMAGE = 3000
# Where the clef's pixel grid sits in your 3000 px image, and the size of its pixels (a touch
# taller than wide there; the interface draws them square, so they land on whole screen pixels)
CLEF_ORIGIN = (1035.79, 140.51)
CELL_W, CELL_H = 45.1, 46.3


def p3_to_srgb(rgb):
    p3_to_xyz = np.array([[0.4865709, 0.2656677, 0.1982173], [0.2289746, 0.6917385, 0.0792869], [0.0, 0.0451134, 1.0439444]])
    xyz_to_srgb = np.array([[3.2404542, -1.5371385, -0.4985314], [-0.9692660, 1.8760108, 0.0415560], [0.0556434, -0.2040259, 1.0572252]])
    v = np.asarray(rgb, float)
    lin = np.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055) ** 2.4)
    s = np.clip(xyz_to_srgb @ (p3_to_xyz @ lin), 0, 1)
    return np.where(s <= 0.0031308, s * 12.92, 1.055 * s ** (1 / 2.4) - 0.055)


def hex_of(rgb):
    return '#%02x%02x%02x' % tuple(int(round(x * 255)) for x in rgb)


def read_grid():
    rows = [line.rstrip('\n') for line in open(os.path.join(LOGO, 'ginosa-clef.txt')) if line.strip()]
    return np.array([[ch == '#' for ch in row] for row in rows])


def outline(grid):
    """The clef's outline: loops of whole-pixel corners, clockwise round the pixels (y down)."""
    h, w = grid.shape
    on = lambda r, c: 0 <= r < h and 0 <= c < w and grid[r, c]
    edges = defaultdict(list)
    for r in range(h):
        for c in range(w):
            if not grid[r, c]:
                continue
            if not on(r - 1, c): edges[(c, r)].append((c + 1, r))
            if not on(r, c + 1): edges[(c + 1, r)].append((c + 1, r + 1))
            if not on(r + 1, c): edges[(c + 1, r + 1)].append((c, r + 1))
            if not on(r, c - 1): edges[(c, r + 1)].append((c, r))
    loops = []
    while any(edges.values()):
        start = next(p for p, v in edges.items() if v)
        cur = edges[start].pop(0)
        loop = [start, cur]
        prev = (cur[0] - start[0], cur[1] - start[1])
        while cur != start:
            options = edges[cur]
            # Where pixels touch at a corner only, take the sharpest right turn: they stay apart.
            nxt = min(options, key=lambda e: (-(prev[0] * (e[1] - cur[1]) - prev[1] * (e[0] - cur[0])), -(prev[0] * (e[0] - cur[0]) + prev[1] * (e[1] - cur[1]))))
            options.remove(nxt)
            prev = (nxt[0] - cur[0], nxt[1] - cur[1])
            loop.append(nxt)
            cur = nxt
        pts = loop[:-1]
        n = len(pts)
        loops.append([pts[i] for i in range(n) if (pts[i][0] - pts[i - 1][0]) * (pts[(i + 1) % n][1] - pts[i][1]) - (pts[i][1] - pts[i - 1][1]) * (pts[(i + 1) % n][0] - pts[i][0]) != 0])
    return loops


def path_data(loops, sx=1.0, sy=1.0, dx=0.0, dy=0.0):
    fmt = lambda v: ('%.2f' % v).rstrip('0').rstrip('.')
    out = []
    for lp in loops:
        x0, y0 = lp[0]
        s = ['M%s %s' % (fmt(x0 * sx + dx), fmt(y0 * sy + dy))]
        py = y0
        for x, y in lp[1:]:
            s.append(('H%s' % fmt(x * sx + dx)) if y == py else ('V%s' % fmt(y * sy + dy)))
            py = y
        out.append(''.join(s) + 'Z')
    return ''.join(out)


def box_blur(a, radius, axis):
    if radius < 1:
        return a
    k = 2 * radius + 1
    pad = [(0, 0)] * a.ndim
    pad[axis] = (radius + 1, radius)
    c = np.cumsum(np.pad(a, pad), axis=axis)
    hi = np.take(c, range(k, c.shape[axis]), axis=axis)
    lo = np.take(c, range(0, c.shape[axis] - k), axis=axis)
    return (hi - lo) / k


def blur(a, sigma):
    """Gaussian blur, near enough: three box blurs each way."""
    r = int(round((np.sqrt(12 * sigma * sigma / 3 + 1) - 1) / 2))
    for axis in (0, 1):
        for _ in range(3):
            a = box_blur(a, r, axis)
    return a


def shift(a, dx, dy):
    out = np.zeros_like(a)
    h, w = a.shape
    out[max(0, dy):h + min(0, dy), max(0, dx):w + min(0, dx)] = a[max(0, -dy):h - max(0, dy), max(0, -dx):w - max(0, dx)]
    return out


def dock_icon(grid, path_out):
    """
    The Dock icon after your Icon Composer file: its gradient, the clef in its lavender at
    its size and place, and its glass drawn by hand (a light top edge, a soft shade at the
    bottom, a little of the background through it, a neutral shadow under it). Apple's own
    rendering of the glass comes from Icon Composer itself (Ginosa.icon).
    """
    ss = 2
    n = 1024 * ss
    body = 824 * ss                      # the macOS icon grid: an 824 px shape in 1024
    off = (n - body) // 2
    top, bottom, fill = p3_to_srgb(BG_TOP), p3_to_srgb(BG_BOTTOM), p3_to_srgb(CLEF_FILL)

    y, x = np.mgrid[0:body, 0:body].astype(float)
    u = np.abs((x + 0.5) / body * 2 - 1)
    v = np.abs((y + 0.5) / body * 2 - 1)
    d = u ** 5 + v ** 5                  # continuous corners, near enough Apple's
    shape = np.zeros((n, n))
    shape[off:off + body, off:off + body] = np.clip((1 - d) / (2 * 5 * 1.5 / body) + 0.5, 0, 1)

    t = np.clip((np.arange(n) - off) / body / 0.7, 0, 1)[:, None, None]
    bg = np.broadcast_to(top * (1 - t) + bottom * t, (n, n, 3)).copy()

    # The clef where your image has it, drawn 4x and averaged down.
    unit = body / 1024 * LAYER_SCALE     # one pixel of your 3000 px image, here
    gh, gw = grid.shape
    x0 = n / 2 + (CLEF_ORIGIN[0] - IMAGE / 2) * unit
    y0 = n / 2 + (CLEF_ORIGIN[1] - IMAGE / 2) * unit
    cw, ch = CELL_W * unit, CELL_H * unit
    big = Image.new('L', (n * 4, n * 4), 0)
    draw = ImageDraw.Draw(big)
    for r in range(gh):
        for c in range(gw):
            if grid[r, c]:
                draw.rectangle([round((x0 + c * cw) * 4), round((y0 + r * ch) * 4), round((x0 + (c + 1) * cw) * 4) - 1, round((y0 + (r + 1) * ch) * 4) - 1], fill=255)
    clef = np.array(big.reduce(4), float) / 255

    shadow = shift(blur(clef, 14 * ss), 0, 7 * ss)
    bg = bg * (1 - 0.5 * 0.75 * shadow[..., None])
    under = np.stack([blur(bg[..., k], 10 * ss) for k in range(3)], axis=-1)
    glass = fill * 0.78 + under * 0.22
    rows = np.nonzero(clef.max(axis=1) > 0.5)[0]
    light = np.clip((np.arange(n) - rows.min()) / (rows.max() - rows.min()), 0, 1)[:, None, None]
    glass = glass * (1.08 - 0.16 * light)
    gy, gx = np.gradient(blur(clef, 2.2 * ss))
    facing = -(gx * -0.45 + gy * -0.89) * 2.4 * ss
    spec = np.clip(-facing, 0, 1) * clef
    shade = np.clip(facing, 0, 1) * clef
    glass = glass + (1 - glass) * 0.75 * spec[..., None] - glass * 0.22 * shade[..., None]
    img = bg * (1 - clef[..., None]) + np.clip(glass, 0, 1) * clef[..., None]

    drop = shift(blur(shape, 18 * ss), 0, 12 * ss) * 0.32
    alpha = shape + drop * (1 - shape)
    rgb = img * (shape / np.maximum(alpha, 1e-6))[..., None]
    rgba = np.dstack([np.clip(rgb, 0, 1), np.clip(alpha, 0, 1)])
    Image.fromarray((rgba * 255 + 0.5).astype(np.uint8), 'RGBA').resize((1024, 1024), Image.LANCZOS).save(path_out, optimize=True)


def main():
    grid = read_grid()
    loops = outline(grid)
    d = path_data(loops)
    gh, gw = grid.shape
    fill = hex_of(p3_to_srgb(CLEF_FILL))

    with open(os.path.join(LOGO, 'ginosa-logo.svg'), 'w') as f:
        f.write(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" width="%d" height="%d" shape-rendering="crispEdges">\n'
            '  <!-- The ginosa mark (decision 113): your 8-bit treble clef, pixel for pixel. Built from ginosa-clef.txt by\n'
            '       scripts/make-logo.py. Fill: your Icon Composer lavender, display-p3(0.671 0.642 1), %s in sRGB. -->\n'
            '  <path fill="%s" fill-rule="evenodd" d="%s"/>\n'
            '</svg>\n' % (gw, gh, gw * 10, gh * 10, fill, fill, d)
        )

    with open(os.path.join(ROOT, 'src', 'renderer', 'src', 'app', 'logo-path.ts'), 'w') as f:
        f.write(
            '// Generated by scripts/make-logo.py from assets/logo/ginosa-clef.txt: do not edit by hand.\n'
            '\n'
            '/** The ginosa mark\'s outline, one unit per pixel of your 8-bit clef (decision 113). */\n'
            'export const CLEF_PATH =\n'
            "  '%s'\n"
            '\n'
            'export const CLEF_SIZE = { width: %d, height: %d }\n' % (d, gw, gh)
        )

    # Icon Composer: your settings, with the mark as an SVG layer where your image had the clef.
    bundle = os.path.join(LOGO, 'Ginosa.icon')
    os.makedirs(os.path.join(bundle, 'Assets'), exist_ok=True)
    with open(os.path.join(bundle, 'Assets', 'ginosa-clef.svg'), 'w') as f:
        f.write(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" width="%d" height="%d">\n'
            '  <path fill="#000" fill-rule="evenodd" d="%s"/>\n'
            '</svg>\n' % (IMAGE, IMAGE, IMAGE, IMAGE, path_data(loops, CELL_W, CELL_H, *CLEF_ORIGIN))
        )
    p3 = lambda c: 'display-p3:%.5f,%.5f,%.5f,1.00000' % c
    icon = {
        'fill': {'linear-gradient': [p3(BG_TOP), p3(BG_BOTTOM)], 'orientation': {'start': {'x': 0.5, 'y': 0}, 'stop': {'x': 0.5, 'y': 0.7}}},
        'groups': [{
            'layers': [{
                'fill': {'solid': p3(CLEF_FILL)},
                'glass': True,
                'image-name': 'ginosa-clef.svg',
                'name': 'ginosa-clef',
                'position': {'scale': LAYER_SCALE, 'translation-in-points': [0, 0]},
            }],
            'shadow': {'kind': 'neutral', 'opacity': 0.5},
            'translucency': {'enabled': True, 'value': 0.5},
        }],
        'supported-platforms': {'circles': ['watchOS'], 'squares': 'shared'},
    }
    with open(os.path.join(bundle, 'icon.json'), 'w') as f:
        json.dump(icon, f, indent=2)
        f.write('\n')

    dock_icon(grid, os.path.join(LOGO, 'ginosa-icon.png'))
    print('mark: %d x %d pixels, %d of them on, %d outline loops; fill %s' % (gw, gh, int(grid.sum()), len(loops), fill))


if __name__ == '__main__':
    main()
