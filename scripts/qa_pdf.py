#!/usr/bin/env python3
"""Render every PDF page and create contact sheets for a manual layout review."""
import json
from pathlib import Path
import subprocess
import sys

from PIL import Image, ImageDraw
import pdfplumber

ROOT = Path(__file__).resolve().parents[1]


def main():
    pdf = ROOT / "dist/deepseek-harness-book.pdf"
    output = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "build/qa"
    output.mkdir(parents=True, exist_ok=True)
    subprocess.run(["pdftoppm", "-scale-to", "600", "-png", str(pdf), str(output / "page")], check=True)
    pages = sorted(output.glob("page-*.png"))
    for start in range(0, len(pages), 20):
        sheet = Image.new("RGB", (4 * 440, 5 * 645), "#cbd5e1")
        draw = ImageDraw.Draw(sheet)
        for index, path in enumerate(pages[start:start + 20]):
            thumb = Image.open(path).convert("RGB")
            thumb.thumbnail((420, 600))
            x, y = (index % 4) * 440, (index // 4) * 645
            sheet.paste(thumb, (x + (440 - thumb.width) // 2, y + 25))
            draw.text((x + 12, y + 6), path.stem, fill="black")
        sheet.save(output / f"sheet-{start // 20 + 1:02}.jpg", quality=92)
    bounds = []
    with pdfplumber.open(pdf) as document:
        for index, page in enumerate(document.pages, 1):
            # Running headers and page numbers are deliberately outside the body.
            body = [c for c in page.chars if 50 < c["top"] < page.height - 40]
            bad = [c for c in body if c["x0"] < 45 or c["x1"] > page.width - 45]
            if index > 1 and bad:
                bounds.append({"page": index, "characters_outside_body": "".join(c["text"] for c in bad)})
    report = {"pages_rendered": len(pages), "contact_sheets": (len(pages) + 19) // 20,
        "horizontal_overflow_candidates": bounds,
        "manual_review_required": True}
    (output / "layout-check.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
