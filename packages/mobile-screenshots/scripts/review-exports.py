"""Audit PNG exports and make review contact sheets. Requires Pillow."""
import json
import sys
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(sys.argv[1])
manifest = json.loads((root / "manifest.json").read_text())
checks = []
groups = {}
for entry in manifest["exports"]:
    path = root / entry["file"]
    with Image.open(path) as original:
        image = original.convert("RGBA")
        opaque = image.getchannel("A").getextrema() == (255, 255)
        expected = (entry["width"], entry["height"])
        if image.size != expected or not opaque:
            raise SystemExit(f"Invalid export {entry['file']}: size={image.size}, opaque={opaque}")
        checks.append({"file": entry["file"], "size": list(image.size), "opaque": opaque})
        preview = image.convert("RGB")
        preview.thumbnail((400, 850))
        groups.setdefault(path.parent.name, []).append((path.name, preview.copy()))
for group, items in groups.items():
    cell_width = 430
    height = max(image.height for _, image in items) + 65
    sheet = Image.new("RGB", (cell_width * len(items), height), "#e4e2dd")
    draw = ImageDraw.Draw(sheet)
    for index, (name, image) in enumerate(items):
        x = index * cell_width + (cell_width - image.width) // 2
        sheet.paste(image, (x, 40))
        draw.text((index * cell_width + 15, 15), name, fill="#302c27")
    sheet.save(root / f"contact-{group}.jpg", quality=95)
(root / "image-checks.json").write_text(json.dumps(checks, indent=2) + "\n")
print(f"Passed {len(checks)} dimension/opacity checks; review contact sheets in {root}")
