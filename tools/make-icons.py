"""Generates the extension icons from the product's source image.

The source is `tools/icon-source-512.png`, a copy of the main product icon
(512x512, RGBA) taken from the original Memo site icon
(a blue bookmark with a smiley). The script only downscales this image to
the three sizes Chrome requires for manifest v3: 16, 48 and 128 px.

The extension itself has no dependencies; Pillow is only needed to rebuild
the icons from the source. The PNGs already committed in `icons/` are correct
and need no rebuild — if Pillow is not installed, just use them.

Usage: python3 tools/make-icons.py
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SOURCE = os.path.join(HERE, "icon-source-512.png")
OUT_DIR = os.path.join(ROOT, "icons")
SIZES = (16, 48, 128)


def main():
    try:
        from PIL import Image
    except ImportError:
        sys.exit(
            "Pillow is not installed. It is only needed to rebuild the icons "
            "with `python3 tools/make-icons.py` — the extension itself "
            "has no dependencies, and the PNGs already committed in icons/ "
            "are correct. Install Pillow (`pip install Pillow`) only if you "
            "really need to regenerate the icons from "
            "tools/icon-source-512.png."
        )

    source = Image.open(SOURCE).convert("RGBA")
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in SIZES:
        resized = source.resize((size, size), Image.LANCZOS)
        path = os.path.join(OUT_DIR, "icon%d.png" % size)
        resized.save(path)
        print("wrote", path)


if __name__ == "__main__":
    main()
