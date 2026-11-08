"""Export Apple icons from public/logo.svg. Requires macOS, pnpm, and Pillow."""

from copy import deepcopy
from pathlib import Path
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET

from PIL import Image
from PIL.PngImagePlugin import PngInfo


ROOT = Path(__file__).resolve().parents[1]
ICONS = ROOT / "src-tauri/icons"
SVG = "http://www.w3.org/2000/svg"
ET.register_namespace("", SVG)
srgb = PngInfo()
srgb.add(b"sRGB", b"\x00")

# Keep the existing brand artwork; only the platform's background shape changes.
source = ET.parse(ROOT / "public/logo.svg").getroot()
source.set("viewBox", "0 0 192 192")
source.set("width", "1024")
source.set("height", "1024")
background = source.find(f".//{{{SVG}}}rect")
background.attrib.pop("rx", None)
background.attrib.pop("ry", None)

macos = ET.Element(f"{{{SVG}}}svg", {
    "width": "1024", "height": "1024", "viewBox": "0 0 1024 1024",
})
# Optical inset for the legacy ICNS path, not for the App Store PNG.
body = ET.SubElement(macos, f"{{{SVG}}}g", {
    "transform": "translate(100 100) scale(4.291666666666667)",
})
macos_source = deepcopy(source)
macos_background = macos_source.find(f".//{{{SVG}}}rect")
macos_background.tag = f"{{{SVG}}}path"
macos_background.attrib.pop("width")
macos_background.attrib.pop("height")
# Smoothly transitioning corners on an 824px body inside a 1024px canvas.
macos_background.set("d", (
    "M43 0H149C164 0 175 0 183.5 8.5C192 17 192 28 192 43"
    "V149C192 164 192 175 183.5 183.5C175 192 164 192 149 192"
    "H43C28 192 17 192 8.5 183.5C0 175 0 164 0 149"
    "V43C0 28 0 17 8.5 8.5C17 0 28 0 43 0Z"
))
body.extend(macos_source)

ios_sizes = {
    "AppIcon-20x20@1x.png": 20,
    "AppIcon-20x20@2x.png": 40,
    "AppIcon-20x20@2x-1.png": 40,
    "AppIcon-20x20@3x.png": 60,
    "AppIcon-29x29@1x.png": 29,
    "AppIcon-29x29@2x.png": 58,
    "AppIcon-29x29@2x-1.png": 58,
    "AppIcon-29x29@3x.png": 87,
    "AppIcon-40x40@1x.png": 40,
    "AppIcon-40x40@2x.png": 80,
    "AppIcon-40x40@2x-1.png": 80,
    "AppIcon-40x40@3x.png": 120,
    "AppIcon-60x60@2x.png": 120,
    "AppIcon-60x60@3x.png": 180,
    "AppIcon-76x76@1x.png": 76,
    "AppIcon-76x76@2x.png": 152,
    "AppIcon-83.5x83.5@2x.png": 167,
    "AppIcon-512@2x.png": 1024,
}

with tempfile.TemporaryDirectory(prefix="open-builder-icons-") as directory:
    temporary = Path(directory)
    images = {}
    for name, artwork in (("app-store", source), ("macos", macos)):
        vector = temporary / f"{name}.svg"
        ET.ElementTree(artwork).write(vector, encoding="utf-8", xml_declaration=True)
        output = temporary / name
        subprocess.run([
            "pnpm", "exec", "tauri", "icon", str(vector),
            "--png", "1024", "--output", str(output),
        ], cwd=ROOT, check=True)
        with Image.open(output / "1024x1024.png") as rendered:
            images[name] = rendered.copy()

    # Store images are RGB: no alpha channel, no pre-rounded corners or padding.
    store = images["app-store"].convert("RGB")
    store.save(ICONS / "app-store.png", pnginfo=srgb)
    for filename, pixels in ios_sizes.items():
        store.resize((pixels, pixels), Image.Resampling.LANCZOS).save(
            ICONS / "ios" / filename,
            pnginfo=srgb,
        )

    macos_image = images["macos"]
    macos_image.save(ICONS / "macos.png", pnginfo=srgb)
    iconset = temporary / "AppIcon.iconset"
    iconset.mkdir()
    for points in (16, 32, 128, 256, 512):
        for scale in (1, 2):
            suffix = "@2x" if scale == 2 else ""
            pixels = points * scale
            macos_image.resize((pixels, pixels), Image.Resampling.LANCZOS).save(
                iconset / f"icon_{points}x{points}{suffix}.png",
                pnginfo=srgb,
            )
    compiled = temporary / "icon.icns"
    subprocess.run([
        "iconutil", "-c", "icns", str(iconset), "-o", str(compiled),
    ], check=True)
    shutil.copyfile(compiled, ICONS / "icon.icns")

print("Exported app-store.png, macos.png, icon.icns, and 18 opaque iOS icons.")
