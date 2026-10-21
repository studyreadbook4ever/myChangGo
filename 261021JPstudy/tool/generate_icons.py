#!/usr/bin/env python3
"""Render the native 学 monogram from the bundled OFL font.

Optional artwork regeneration only: python3 -m pip install fonttools Pillow
The app build consumes the committed assets and needs neither dependency.
"""
from pathlib import Path
import json

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
FONT = ROOT / "assets/fonts/NotoSansJP.ttf"
GREEN = "#175B47"
CREAM = "#FFF9EC"
font = instantiateVariableFont(TTFont(FONT), {"wght": 700})
glyphs = font.getGlyphSet()
pen = SVGPathPen(glyphs)
glyphs[font.getBestCmap()[ord("学")]].draw(pen)
path = pen.getCommands()
res = ROOT / "android/app/src/main/res"


def write(relative, content):
    destination = ROOT / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(content, encoding="utf-8")


group = f'''    <group android:scaleX="0.06" android:scaleY="-0.06"
        android:translateX="24" android:translateY="77">
        <path android:fillColor="{CREAM}" android:pathData="{path}" />
    </group>'''
vector = '''<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp" android:height="108dp"
    android:viewportWidth="108" android:viewportHeight="108">\n'''
write("android/app/src/main/res/drawable/ic_launcher_foreground.xml", vector + group + "\n</vector>\n")
write("android/app/src/main/res/mipmap-anydpi/ic_launcher.xml", vector +
      f'    <path android:fillColor="{GREEN}" android:pathData="M0,0H108V108H0Z" />\n' + group + "\n</vector>\n")
write("android/app/src/main/res/values/icon_colors.xml", f'<resources><color name="icon_background">{GREEN}</color></resources>\n')
write("android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml", '''<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/icon_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
    <monochrome android:drawable="@drawable/ic_launcher_foreground" />
</adaptive-icon>
''')
write("web/icons/icon.svg", f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108">
<rect width="108" height="108" rx="24" fill="{GREEN}"/>
<path transform="translate(24 77) scale(.06 -.06)" fill="{CREAM}" d="{path}"/>
</svg>
''')


def png(destination, size):
    # Supersample the same font glyph for legacy Android and browser icons.
    scale = 4
    image = Image.new("RGB", (size * scale, size * scale), GREEN)
    draw = ImageDraw.Draw(image)
    glyph_font = ImageFont.truetype(str(FONT), int(size * scale * 0.60))
    glyph_font.set_variation_by_axes([700])
    draw.text((size * scale / 2, size * scale * 0.48), "学", font=glyph_font,
              fill=CREAM, anchor="mm")
    image.resize((size, size), Image.Resampling.LANCZOS).save(destination)


for density, size in {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}.items():
    png(res / f"mipmap-{density}/ic_launcher.png", size)
for size in (192, 512):
    for name in (f"Icon-{size}.png", f"Icon-maskable-{size}.png"):
        png(ROOT / "web/icons" / name, size)
png(ROOT / "web/favicon.png", 32)

manifest = json.loads((ROOT / "web/manifest.json").read_text())
manifest.update(name="한자 잇다", short_name="한자 잇다", lang="ko",
                background_color="#FAF8F1", theme_color=GREEN,
                description="한국인을 위한 일본어 한자 연결 학습")
write("web/manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
print("Native and web monogram icons regenerated.")
