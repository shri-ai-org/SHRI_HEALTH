"""
The Shri Health mark, from the master in brand/logo-source.png (3792×4096,
5 MB — never served) to the small files the site loads:

  public/favicon.ico            16, 32, 48 px — for anything that asks for /favicon.ico
  public/favicon-32.png         the tab icon
  public/apple-touch-icon.png   180 px on white — iOS fills transparency with black
  src/shri/app/logo-mark.webp   the AppBar mark at 2× its 36 px height, small enough
                                for Vite to inline it into the bundle — no request

Run from doctors-portal/:  python3 scripts/brand-assets.py
"""
import os
from PIL import Image

SRC = 'brand/logo-source.png'
src = Image.open(SRC).convert('RGBA')
mark = src.crop(src.getchannel('A').point(lambda a: 255 if a > 8 else 0).getbbox())


def square(size, pad=0.08, bg=(0, 0, 0, 0)):
    """The mark centred on a square canvas, `pad` of it left clear on every side."""
    canvas = Image.new('RGBA', (size, size), bg)
    inner = round(size * (1 - 2 * pad))
    m = mark.copy()
    m.thumbnail((inner, inner), Image.LANCZOS)
    canvas.alpha_composite(m, ((size - m.width) // 2, (size - m.height) // 2))
    return canvas


square(256).save('public/favicon.ico', sizes=[(16, 16), (32, 32), (48, 48)])
square(32).save('public/favicon-32.png', optimize=True)
square(180, pad=0.12, bg=(255, 255, 255, 255)).convert('RGB').save('public/apple-touch-icon.png', optimize=True)

h = 72
m = mark.copy()
m = m.resize((round(mark.width * h / mark.height), h), Image.LANCZOS)
m.save('src/shri/app/logo-mark.webp', 'WEBP', quality=90, method=6)

for f in ['public/favicon.ico', 'public/favicon-32.png', 'public/apple-touch-icon.png', 'src/shri/app/logo-mark.webp']:
    print(f'{f:32} {os.path.getsize(f):>6} bytes')
print('mark', m.size)

# The Indostates Health logo for the AppBar (brand/indostates-logo-source.png, white-backed). The white
# is turned to transparency ("colour to alpha"), so the logo sits on the bar in either theme; the dark
# theme's copy lifts the grey lettering to near-white, keeping the blue, so it stays readable.
logo = Image.open('brand/indostates-logo-source.png').convert('RGB')
W, H = logo.size
data = []
dark = []
for r, g, b in logo.getdata():
    a = 255 - min(r, g, b)
    if a < 18:
        data.append((0, 0, 0, 0))
        dark.append((0, 0, 0, 0))
        continue
    k = a / 255
    c = [max(0, min(255, round((v - 255 * (1 - k)) / k))) for v in (r, g, b)]
    data.append((*c, a))
    grey = max(c) - min(c) < 40
    dark.append((236, 236, 240, a) if grey else (min(255, c[0] + 50), min(255, c[1] + 55), min(255, c[2] + 50), a))
for name, px in [('indostates-logo', data), ('indostates-logo-dark', dark)]:
    im = Image.new('RGBA', (W, H))
    im.putdata(px)
    im = im.crop(im.getchannel('A').point(lambda a: 255 if a > 24 else 0).getbbox())
    h = 72  # 2× its 36 px height in the bar
    im = im.resize((round(im.width * h / im.height), h), Image.LANCZOS)
    path = f'src/shri/app/{name}.webp'
    im.save(path, 'WEBP', quality=90, method=6)
    print(f'{path:40} {os.path.getsize(path):>6} bytes', im.size)
