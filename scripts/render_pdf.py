#!/usr/bin/env python3
"""Typeset the Pandoc AST with embedded Chinese fonts and linked contents."""
import html
import json
import os
from pathlib import Path
import sys

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate, Frame, Image, PageBreak, PageTemplate, Paragraph,
    Spacer, Table, TableStyle,
)
from reportlab.platypus.tableofcontents import TableOfContents

ROOT = Path(__file__).resolve().parents[1]
PAGE_W, PAGE_H = A4
LEFT = RIGHT = 19 * mm
TOP, BOTTOM = 21 * mm, 19 * mm
WIDTH = PAGE_W - LEFT - RIGHT
BLUE = colors.HexColor("#2563eb")
INK = colors.HexColor("#172033")
MUTED = colors.HexColor("#64748b")


def register_fonts():
    choices = [os.environ.get("BOOK_FONT", ""), "/Library/Fonts/Arial Unicode.ttf",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc"]
    selected = next((p for p in choices if p and Path(p).is_file()), None)
    if not selected:
        raise SystemExit("Set BOOK_FONT to a Chinese TrueType font (TTF/TTC). See BUILD.md.")
    pdfmetrics.registerFont(TTFont("Book", selected))
    pdfmetrics.registerFontFamily("Book", normal="Book", bold="Book", italic="Book", boldItalic="Book")


def make_styles():
    body = ParagraphStyle("Body", fontName="Book", fontSize=10.3, leading=17,
        textColor=INK, spaceAfter=7, wordWrap="CJK", splitLongWords=True)
    return {
        "body": body,
        "h1": ParagraphStyle("H1", parent=body, fontSize=22, leading=32,
            textColor=INK, spaceAfter=22, keepWithNext=True),
        "h2": ParagraphStyle("H2", parent=body, fontSize=15, leading=23,
            textColor=BLUE, spaceBefore=17, spaceAfter=10, keepWithNext=True),
        "h3": ParagraphStyle("H3", parent=body, fontSize=12, leading=20,
            spaceBefore=12, spaceAfter=7, keepWithNext=True),
        "code": ParagraphStyle("Code", parent=body, fontSize=8, leading=12,
            leftIndent=9, rightIndent=9, borderPadding=8,
            textColor=colors.HexColor("#e2e8f0"), backColor=colors.HexColor("#142033"),
            spaceBefore=5, spaceAfter=12),
        "quote": ParagraphStyle("Quote", parent=body, leftIndent=12, rightIndent=10,
            borderColor=BLUE, borderWidth=0.5, borderPadding=8,
            backColor=colors.HexColor("#eff6ff"), spaceBefore=8, spaceAfter=12),
        "cell": ParagraphStyle("Cell", parent=body, fontSize=8.3, leading=13, spaceAfter=2),
        "caption": ParagraphStyle("Caption", parent=body, fontSize=8.5, leading=13,
            textColor=MUTED, alignment=TA_CENTER, spaceAfter=14),
        "list": ParagraphStyle("List", parent=body, leftIndent=13, firstLineIndent=-10),
    }


def inlines(items):
    output = []
    for item in items:
        kind, value = item["t"], item.get("c")
        if kind == "Str": output.append(html.escape(value))
        elif kind in ("Space", "SoftBreak"): output.append(" ")
        elif kind == "LineBreak": output.append("<br/>")
        elif kind == "Code": output.append('<font color="#334155">' + html.escape(value[1]) + "</font>")
        elif kind in ("Strong", "Emph", "Underline", "Strikeout", "SmallCaps"):
            output.append(inlines(value))
        elif kind == "Link":
            text, target = inlines(value[1]), value[2][0]
            if target.startswith(("https://", "http://", "mailto:")):
                output.append('<a href="' + html.escape(target, quote=True) + '" color="#2563eb">' + text + "</a>")
            else: output.append(text)
        elif kind == "Quoted": output.append("“" + inlines(value[1]) + "”")
        elif kind == "Span": output.append(inlines(value[1]))
        elif kind == "Math": output.append(html.escape(value[1]))
        elif kind == "Image": output.append(inlines(value[1]))
        elif kind == "Note": output.append("（" + plain_blocks(value) + "）")
        elif kind in ("Superscript", "Subscript"): output.append(inlines(value))
        elif kind in ("RawInline",): pass
        else: raise ValueError(f"Unhandled Pandoc inline: {kind}")
    return "".join(output)


def plain_blocks(blocks):
    return " ".join(inlines(b["c"]) for b in blocks if b["t"] in ("Para", "Plain"))


def wrap_code(text):
    result = []
    limit = WIDTH - 38
    for line in text.expandtabs(4).splitlines():
        chunk = ""
        for char in line:
            if pdfmetrics.stringWidth(chunk + char, "Book", 8) > limit:
                result.append(chunk)
                chunk = "  " + char
            else: chunk += char
        result.append(chunk)
    return "<br/>".join(html.escape(line).replace(" ", "&#160;") or "&#160;" for line in result)


def figure(image_inline, styles):
    alt, target = image_inline["c"][1], image_inline["c"][2][0]
    candidates = [ROOT / target, ROOT / "chapters" / target]
    selected = next((p.resolve() for p in candidates if p.is_file()), None)
    if selected is None: raise FileNotFoundError(target)
    img = Image(str(selected))
    scale = min(WIDTH / img.imageWidth, 175 * mm / img.imageHeight)
    img.drawWidth, img.drawHeight = img.imageWidth * scale, img.imageHeight * scale
    img.hAlign = "CENTER"
    img.spaceBefore, img.spaceAfter = 9, 5
    return [img, Paragraph(inlines(alt), styles["caption"])]


def convert(blocks, styles, cell=False):
    result = []
    for block in blocks:
        kind, value = block["t"], block.get("c")
        if kind in ("Para", "Plain"):
            if len(value) == 1 and value[0]["t"] == "Image":
                result.extend(figure(value[0], styles))
            else:
                text = inlines(value)
                if text: result.append(Paragraph(text, styles["cell" if cell else "body"]))
        elif kind == "Header":
            level, attr, parts = value
            if level == 1 and result: result.append(PageBreak())
            paragraph = Paragraph(inlines(parts), styles[f"h{min(level, 3)}"])
            if level == 1:
                paragraph.book_heading = (inlines(parts), attr[0])
            result.append(paragraph)
        elif kind == "CodeBlock":
            result.append(Paragraph(wrap_code(value[1]), styles["code"]))
        elif kind == "BlockQuote":
            quote = "<br/>".join(plain_blocks([b]) for b in value)
            if quote: result.append(Paragraph(quote, styles["quote"]))
        elif kind in ("BulletList", "OrderedList"):
            items = value if kind == "BulletList" else value[1]
            first = 1 if kind == "BulletList" else value[0][0]
            for index, item in enumerate(items, start=first):
                rendered = convert(item, styles, cell)
                if rendered and isinstance(rendered[0], Paragraph):
                    prefix = "• " if kind == "BulletList" else f"{index}. "
                    rendered[0] = Paragraph(prefix + rendered[0].text, styles["cell" if cell else "list"])
                result += rendered
        elif kind == "Table":
            # Pandoc >= 3: attr, caption, colspec, head, bodies, foot.
            _, caption, specs, head, bodies, foot = value
            rows = list(head[1])
            for body in bodies: rows.extend(body[2] + body[3])
            rows.extend(foot[1])
            data = []
            for row in rows:
                data.append([convert(c[4], styles, True) or [Paragraph(" ", styles["cell"])] for c in row[1]])
            if data:
                count = len(data[0])
                table = Table(data, colWidths=[WIDTH / count] * count, repeatRows=len(head[1]),
                    hAlign="LEFT", splitByRow=1, splitInRow=1)
                table.setStyle(TableStyle([
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("BACKGROUND", (0, 0), (-1, len(head[1]) - 1), colors.HexColor("#eaf0fa")),
                    ("ROWBACKGROUNDS", (0, len(head[1])), (-1, -1), [colors.white, colors.HexColor("#f8fafc")]),
                    ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#cbd5e1")),
                    ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                    ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
                ]))
                table.spaceBefore, table.spaceAfter = 8, 13
                result.append(table)
        elif kind == "Div": result.extend(convert(value[1], styles, cell))
        elif kind == "Figure": result.extend(convert(value[2], styles, cell))
        elif kind == "HorizontalRule": result.append(Spacer(1, 12))
        elif kind == "RawBlock": pass
        elif kind == "DefinitionList":
            for term, definitions in value:
                result.append(Paragraph(inlines(term), styles["h3"]))
                for definition in definitions: result.extend(convert(definition, styles, cell))
        elif kind == "Null": pass
        else: raise ValueError(f"Unhandled Pandoc block: {kind}")
    return result


class BookDoc(BaseDocTemplate):
    def afterFlowable(self, flowable):
        if hasattr(flowable, "book_heading"):
            label, key = flowable.book_heading
            self.canv.bookmarkPage(key)
            self.canv.addOutlineEntry(label, key, 0)
            self.notify("TOCEntry", (0, label, self.page, key))


def main():
    register_fonts()
    styles = make_styles()
    metadata = json.loads((ROOT / "book.json").read_text())
    ast = json.loads(Path(sys.argv[1]).read_text())
    target = Path(sys.argv[2])
    target.parent.mkdir(parents=True, exist_ok=True)
    frame = Frame(LEFT, BOTTOM, WIDTH, PAGE_H - TOP - BOTTOM,
        leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0, id="text")

    def page_decoration(canvas, doc):
        if doc.page == 1:
            canvas.drawImage(str(ROOT / "epub/cover.png"), 0, 0, width=PAGE_W, height=PAGE_H)
            return
        canvas.setFont("Book", 8)
        canvas.setFillColor(MUTED)
        canvas.drawString(LEFT, PAGE_H - 12 * mm, metadata["title"] + " · 开源学习版")
        canvas.drawRightString(PAGE_W - RIGHT, 10 * mm, str(doc.page))
        canvas.setStrokeColor(colors.HexColor("#e2e8f0"))
        canvas.setLineWidth(0.4)
        canvas.line(LEFT, PAGE_H - 15 * mm, PAGE_W - RIGHT, PAGE_H - 15 * mm)

    doc = BookDoc(str(target), pagesize=A4, title=metadata["title"], author=metadata["author"],
        subject=metadata["subtitle"], leftMargin=LEFT, rightMargin=RIGHT,
        topMargin=TOP, bottomMargin=BOTTOM)
    doc.addPageTemplates(PageTemplate(id="book", frames=[frame], onPage=page_decoration))
    toc = TableOfContents()
    toc.levelStyles = [ParagraphStyle("TOC", parent=styles["body"], fontSize=9.5, leading=15,
        leftIndent=0, rightIndent=16, spaceBefore=3, spaceAfter=3)]
    story = [Spacer(1, 1), PageBreak(), Paragraph(metadata["title"], styles["h1"]),
        Paragraph(metadata["subtitle"], styles["h2"]),
        Paragraph(metadata["author"] + " · " + metadata["edition"], styles["body"]),
        Paragraph("源码基线 " + metadata["source_commit"][:10] + " / " + metadata["source_version"], styles["body"]),
        Paragraph('<a href="' + metadata["repository"] + '">书稿、勘误与免费下载</a>', styles["body"]),
        PageBreak(), Paragraph("目录", styles["h1"]), toc, PageBreak()]
    story.extend(convert(ast["blocks"], styles))
    doc.multiBuild(story)
    print(target)


if __name__ == "__main__":
    main()
