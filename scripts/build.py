#!/usr/bin/env python3
"""Build both book formats from the same ordered Pandoc document."""
import argparse
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--format", choices=["all", "pdf", "epub"], default="all")
    args = parser.parse_args()
    meta = json.loads((ROOT / "book.json").read_text())
    sources = [ROOT / "epub/00-trial-notice.md", ROOT / "preface.md"]
    sources += sorted((ROOT / "chapters").glob("[0-9][0-9]-*.md"))
    sources += [ROOT / "conclusion.md", ROOT / "appendices/source-update-2026-11.md"]
    dist = ROOT / "dist"
    build = ROOT / "build"
    dist.mkdir(exist_ok=True)
    build.mkdir(exist_ok=True)
    common = ["pandoc", "--from=gfm", "--lua-filter=" + str(ROOT / "epub/rewrite-links.lua")]
    for key in ("title", "subtitle", "author", "date"):
        common += ["--metadata", f"{key}={meta[key]}"]
    common += ["--metadata", "lang=zh-CN", "--metadata", "toc-title=目录"]
    common += ["--metadata", "rights=原创文字与教学图 CC BY-SA 4.0；原创示例代码 MIT"]
    common += ["--resource-path=" + os.pathsep.join([str(ROOT), str(ROOT / "chapters"), str(ROOT / "assets")])]
    common += list(map(str, sources))
    if args.format in ("all", "epub"):
        subprocess.run(common + ["--to=epub3", "--standalone", "--toc", "--toc-depth=1",
            "--split-level=1", "--css=" + str(ROOT / "epub/style.css"),
            "--epub-cover-image=" + str(ROOT / "epub/cover.png"),
            "--output=" + str(dist / "deepseek-harness-book.epub")], check=True, cwd=ROOT)
    if args.format in ("all", "pdf"):
        ast = subprocess.run(common + ["--to=json"], check=True, cwd=ROOT, capture_output=True).stdout
        (build / "book.json").write_bytes(ast)
        subprocess.run([os.sys.executable, str(ROOT / "scripts/render_pdf.py"),
            str(build / "book.json"), str(dist / "deepseek-harness-book.pdf")], check=True, cwd=ROOT)
    print("Book outputs:", dist)


if __name__ == "__main__":
    main()
