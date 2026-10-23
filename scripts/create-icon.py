"""Build the geometric Wayfarer app icon. Requires Pillow (development only)."""
from pathlib import Path
from PIL import Image, ImageDraw

output = Path(__file__).resolve().parents[1] / 'assets'
output.mkdir(exist_ok=True)
scale = 4
size = 256
im = Image.new('RGBA', (size * scale, size * scale), '#183D32')
d = ImageDraw.Draw(im)
def line(points):
    pts = [(round(x * size * scale / 28), round(y * size * scale / 28)) for x, y in points]
    width = round(2 * size * scale / 28)
    d.line(pts, fill='#D8EC9A', width=width, joint='curve')
    r = width / 2
    for x, y in pts:
        d.ellipse((x-r, y-r, x+r, y+r), fill='#D8EC9A')
line([(5, 7), (10, 21), (14, 11), (18, 21), (23, 7)])
line([(10, 7), (14, 17), (18, 7)])
im = im.resize((256, 256), Image.LANCZOS)
im.save(output / 'icon.png')
im.save(output / 'icon.ico', sizes=[(16,16), (24,24), (32,32), (48,48), (64,64), (128,128), (256,256)])
