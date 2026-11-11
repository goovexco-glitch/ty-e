# Renders the ty\e hexagon mark (tye-mark.svg, viewBox 0 0 24 24) into the desktop app's icon set and the
# NSIS sidebar bitmaps, without a browser: the mark is 4 polygons and one linear gradient, so it is drawn
# with Pillow at 4096 px and reduced (premultiplied alpha) to every size.
#   python mk_icons.py <out_dir>
# Writes icon.png (1024), icon.ico (16..256), icon.icns, tray.ico (16..48), tray.png (16) + tray@2x.png (32),
# installerSidebar.bmp / uninstallerSidebar.bmp (164x314, 24-bit), preview.png (contact sheet).
import sys, os
import numpy as np
from PIL import Image, ImageDraw

OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
S = 4096
K = S / 24.0

HEX = [(12, 1.9), (20.6, 6.9), (20.6, 17.1), (12, 22.1), (3.4, 17.1), (3.4, 6.9)]
TOP = [(12, 6.4), (17.2, 9.4), (12, 12.4), (6.8, 9.4)]
RIGHT = [(12, 12.4), (17.2, 9.4), (17.2, 15.4), (12, 18.4)]
LEFT = [(6.8, 9.4), (12, 12.4), (12, 18.4), (6.8, 15.4)]
STOPS = [(0.0, (0xdc, 0x26, 0x26)), (0.5, (0xf4, 0x3f, 0x5e)), (1.0, (0xfb, 0x92, 0x3c))]


def px(pts):
    return [(x * K, y * K) for x, y in pts]


def mask(pts, stroke=0.0):
    m = Image.new('L', (S, S), 0)
    d = ImageDraw.Draw(m)
    p = px(pts)
    d.polygon(p, fill=255)
    if stroke:
        w = stroke * K
        d.line(p + [p[0]], fill=255, width=int(round(w)), joint='curve')
        r = w / 2
        for x, y in p:  # round line-joins, as stroke-linejoin="round"
            d.ellipse((x - r, y - r, x + r, y + r), fill=255)
    return np.asarray(m, dtype=np.float64) / 255.0


def gradient():
    # x1=0 y1=0 -> x2=24 y2=24, userSpaceOnUse: t = (x + y) / 48 in mark units
    u = (np.arange(S) + 0.5) / K
    t = (u[None, :] + u[:, None]) / 48.0
    out = np.zeros((S, S, 3))
    for (t0, c0), (t1, c1) in zip(STOPS, STOPS[1:]):
        sel = (t >= t0) & (t <= t1)
        f = ((t - t0) / (t1 - t0))[sel]
        for ch in range(3):
            out[..., ch][sel] = c0[ch] + (c1[ch] - c0[ch]) * f
    return out


def mark_rgba():
    a_hex = mask(HEX, stroke=1.6)
    rgb = gradient()
    for pts, op in ((TOP, .95), (RIGHT, .55), (LEFT, .78)):
        a = mask(pts)[..., None] * op
        rgb = rgb * (1 - a) + 255.0 * a
    rgba = np.dstack([rgb, a_hex * 255.0]).round().clip(0, 255).astype(np.uint8)
    return Image.fromarray(rgba, 'RGBA')


def reduce(im, n):
    # premultiplied reduction so the transparent edge does not pick up dark fringes
    return im.convert('RGBa').resize((n, n), Image.LANCZOS, reducing_gap=3.0).convert('RGBA')


def tile_rgba():
    # the live app icon (icon-hex-192/512.png), measured: a #0a0a0a rounded square, corner radius
    # 112/512, a 4/512 #381010 inner border, the 24-unit mark box at 69.7% of the tile, centred
    t = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(t)
    r = round(S * 112 / 512)
    bw = round(S * 4 / 512)
    d.rounded_rectangle((0, 0, S - 1, S - 1), radius=r, fill=(0x38, 0x10, 0x10, 255))
    d.rounded_rectangle((bw, bw, S - 1 - bw, S - 1 - bw), radius=r - bw, fill=(0x0a, 0x0a, 0x0a, 255))
    n = round(S * 357 / 512)
    m = reduce(BIG, n)
    o = (S - n) // 2
    t.alpha_composite(m, (o, o))
    return t


BIG = mark_rgba()
TILE = tile_rgba()
ALL = (16, 20, 24, 32, 40, 48, 64, 96, 128, 256, 512, 1024)
marks = {n: reduce(BIG, n) for n in ALL}
tiles = {n: reduce(TILE, n) for n in ALL}
# like the live site: the favicon (32 px) is the bare mark, the app icons are the tile. Windows asks the ICO
# for 16-24 px in the title bar, taskbar (100 %) and lists, where a tile would shrink the hexagon to a dot.
sizes = {n: (marks[n] if n <= 24 else tiles[n]) for n in ALL}

tiles[1024].save(os.path.join(OUT, 'icon.png'), optimize=True)
ico_sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
sizes[256].save(os.path.join(OUT, 'icon.ico'), format='ICO', sizes=[(n, n) for n in ico_sizes],
                append_images=[sizes[n] for n in ico_sizes if n != 256])
tiles[1024].save(os.path.join(OUT, 'icon.icns'), format='ICNS')
# tray: the bare mark. Windows takes the .ico (it picks the size for the DPI); Linux takes the png pair.
tray_sizes = [16, 20, 24, 32, 40, 48]
marks[48].save(os.path.join(OUT, 'tray.ico'), format='ICO', sizes=[(n, n) for n in tray_sizes],
               append_images=[marks[n] for n in tray_sizes if n != 48])
marks[16].save(os.path.join(OUT, 'tray.png'), optimize=True)
marks[32].save(os.path.join(OUT, 'tray@2x.png'), optimize=True)

# NSIS welcome / finish sidebar: 164 x 314, 24-bit BMP. The tile's #0a0a0a with the mark centred in the
# upper part; nothing else (no text, no stripes).
W, H = 164, 314
side = Image.new('RGB', (W, H), (0x0a, 0x0a, 0x0a))
m = reduce(BIG, 76)
side.paste(m, ((W - 76) // 2, 92), m)
side.save(os.path.join(OUT, 'installerSidebar.bmp'), format='BMP')
side.save(os.path.join(OUT, 'uninstallerSidebar.bmp'), format='BMP')

# contact sheet for review: every icon size on light and dark, plus the sidebar
sheet = Image.new('RGB', (1100, 420), (255, 255, 255))
x = 16
for n in (16, 20, 24, 32, 48, 64, 128, 256):
    sheet.paste(sizes[n], (x, 16), sizes[n])
    dark = Image.new('RGB', (n, n), (0x08, 0x08, 0x08))
    dark.paste(sizes[n], (0, 0), sizes[n])
    sheet.paste(dark, (x, 290 - n if n < 128 else 290 - 128))
    x += n + 16
sheet.paste(side, (1100 - W - 16, 90))
sheet.save(os.path.join(OUT, 'preview.png'))

# self-checks: the ICO really carries every size; the BMP is 24-bit at the exact NSIS size
ico = Image.open(os.path.join(OUT, 'icon.ico'))
got = sorted(s[0] for s in ico.info['sizes'])
assert got == sorted(ico_sizes), got
tico = Image.open(os.path.join(OUT, 'tray.ico'))
assert sorted(s[0] for s in tico.info['sizes']) == tray_sizes, tico.info['sizes']
b = Image.open(os.path.join(OUT, 'installerSidebar.bmp'))
assert b.size == (W, H) and b.mode == 'RGB', (b.size, b.mode)
print('ICONS_OK ico', got, 'png', sizes[1024].size, 'sidebar', b.size, b.mode)
