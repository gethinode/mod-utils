# Generates the GetImage orientation fixtures: a 16x8 image with four coloured quadrants
# (red top-left, green top-right, blue bottom-left, yellow bottom-right), stored once per
# EXIF orientation value 1-8 and once without EXIF; then with orientation 6 as PNG, TIFF and WebP;
# and as GIF and BMP, which carry no EXIF.
# Run with Pillow installed: python3 generate.py
from pathlib import Path

from PIL import Image

here = Path(__file__).parent
img = Image.new('RGB', (16, 8))
for x in range(16):
    for y in range(8):
        img.putpixel((x, y), [(255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 0)][(x >= 8) + 2 * (y >= 4)])

for orientation in range(1, 9):
    exif = Image.Exif()
    exif[0x0112] = orientation
    img.save(here / f'orientation-{orientation}.jpg', quality=100, exif=exif)

img.save(here / 'no-exif.jpg', quality=100)
exif = Image.Exif()
exif[0x0112] = 6
img.save(here / 'orientation-6.png', exif=exif)
img.save(here / 'orientation-6.tif', exif=exif)
img.save(here / 'orientation-6.webp', lossless=True, exif=exif)
img.save(here / 'no-exif.gif')
img.save(here / 'no-exif.bmp')
