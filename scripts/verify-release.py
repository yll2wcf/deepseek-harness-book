#!/usr/bin/env python3
"""Check book artifacts and write checksums without altering the artifacts."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import posixpath
import re
from urllib.parse import unquote, urlsplit
import xml.etree.ElementTree as ET
from zipfile import ZipFile

from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
XHTML = {"h": "http://www.w3.org/1999/xhtml"}


def main():
    meta = json.loads((ROOT / "book.json").read_text())
    epub = DIST / "deepseek-harness-book.epub"
    pdf = DIST / "deepseek-harness-book.pdf"
    source_links = 0
    with ZipFile(epub) as book:
        names = set(book.namelist())
        assert book.namelist()[0] == "mimetype"
        assert book.read("mimetype") == b"application/epub+zip"
        assert book.getinfo("mimetype").compress_type == 0
        nav = ET.fromstring(book.read("EPUB/nav.xhtml"))
        toc = nav.find("h:body/h:nav", XHTML)
        entries = toc.findall(".//h:a", XHTML)
        assert len(entries) == 18, f"Expected 18 contents entries, got {len(entries)}"
        images = [n for n in names if n.startswith("EPUB/media/")]
        assert len(images) == 11, images
        assert toc.find("h:h1", XHTML).text == "目录"
        for name in names:
            if not name.endswith(".xhtml"): continue
            doc = ET.fromstring(book.read(name))
            for element in doc.iter():
                if element.tag.endswith("}img"):
                    assert element.attrib.get("alt"), f"Missing alt in {name}"
                for key in ("href", "src", "{http://www.w3.org/1999/xlink}href"):
                    if key not in element.attrib: continue
                    target = element.attrib[key]
                    parts = urlsplit(target)
                    if parts.scheme:
                        assert parts.scheme in ("https", "http", "mailto"), target
                        if "github.com/deepseek-ai/deepseek-harness/blob/" in target:
                            assert re.search(r"/blob/[a-f0-9]{40}/", target), target
                            source_links += 1
                        continue
                    assert not parts.path.endswith(".md"), target
                    actual = posixpath.normpath(posixpath.join(posixpath.dirname(name), unquote(parts.path))) if parts.path else name
                    assert actual in names, (name, target, actual)
                    if parts.fragment and actual.endswith(".xhtml"):
                        linked = ET.fromstring(book.read(actual))
                        ids = {e.attrib["id"] for e in linked.iter() if "id" in e.attrib}
                        assert unquote(parts.fragment) in ids, (name, target)
    reader = PdfReader(pdf)
    assert len(reader.pages) > 30
    assert reader.metadata.author == meta["author"]
    text = "\n".join(page.extract_text() or "" for page in reader.pages)
    normalized = re.sub(r"\s+", "", text)
    for title in ["前言", "结语", "源码升级说明", *[f"第{i}章" for i in range(1, 15)]]:
        assert title in normalized, f"Missing PDF content: {title}"
    assert "e8f7b93a344964de3dca1ace9e72b6e4d6de87cb" in normalized
    for pattern in (r"/Users/[^/\s]+/", r"gho_[a-zA-Z0-9]{20,}", r"sk-[a-zA-Z0-9]{20,}"):
        assert not re.search(pattern, text), f"Private path/token pattern in PDF: {pattern}"
    checksums = []
    for artifact in (pdf, epub):
        digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
        checksums.append(f"{digest}  {artifact.name}")
    (DIST / "SHA256SUMS.txt").write_text("\n".join(checksums) + "\n")
    summary = {"pdf_pages": len(reader.pages), "epub_contents": len(entries),
        "image_resources": len(images), "pinned_source_links": source_links,
        "pdf_bytes": pdf.stat().st_size, "epub_bytes": epub.stat().st_size,
        "source_commit": meta["source_commit"], "author": meta["author"]}
    (DIST / "verification.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
