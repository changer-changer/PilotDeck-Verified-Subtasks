"""Build the printable field guide from its editable Markdown (ReportLab required)."""
from pathlib import Path
import argparse
import re
import subprocess
from html import escape
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("--font", help="Path to a Chinese TrueType font")
parser.add_argument("--output", type=Path, default=ROOT / "docs/verified-subtasks/assets/现场演示与答辩手册.pdf")
args = parser.parse_args()
font = args.font or subprocess.check_output(["fc-match", "-f", "%{file}", "DengXian"], text=True).strip()
pdfmetrics.registerFont(TTFont("Guide", font))
pdfmetrics.registerFontFamily("Guide", normal="Guide", bold="Guide", italic="Guide", boldItalic="Guide")
green, ink, muted = colors.HexColor("#174C3C"), colors.HexColor("#23332E"), colors.HexColor("#68786F")
base = dict(fontName="Guide", textColor=ink, wordWrap="CJK", alignment=TA_LEFT)
styles = {
    "body": ParagraphStyle("body", fontSize=10, leading=16.5, spaceAfter=9, **base),
    "title": ParagraphStyle("title", fontSize=25, leading=34, spaceAfter=16, **base),
    "h2": ParagraphStyle("h2", fontSize=17, leading=25, spaceBefore=10, spaceAfter=13, keepWithNext=True, **base),
    "h3": ParagraphStyle("h3", fontSize=12, leading=19, spaceBefore=8, spaceAfter=7, keepWithNext=True, **base),
    "quote": ParagraphStyle("quote", fontSize=11, leading=19, leftIndent=13, borderColor=green, borderWidth=0.6, borderPadding=10, spaceBefore=6, spaceAfter=12, **base),
    "code": ParagraphStyle("code", fontSize=8.8, leading=14, backColor=colors.HexColor("#EEF3F0"), borderPadding=8, spaceAfter=11, **base),
    "cell": ParagraphStyle("cell", fontSize=8.5, leading=13, **base),
}

def rich(s):
    s = escape(s.replace("–", "-").replace("—", "-"))
    s = re.sub(r"\[([^]]+)\]\((https?://[^)]+)\)", r'<link href="\2" color="#174C3C"><u>\1</u></link>', s)
    s = re.sub(r"\*\*([^*]+)\*\*", r'<font color="#174C3C">\1</font>', s)
    return re.sub(r"`([^`]+)`", r'<font color="#174C3C">\1</font>', s)

def p(text, style="body"):
    return Paragraph(rich(text), styles[style])

story = []
lines = (ROOT / "docs/verified-subtasks/FIELD-GUIDE.zh-CN.md").read_text().splitlines()
i = 0
while i < len(lines):
    line = lines[i].strip()
    if not line:
        i += 1
        continue
    if line.startswith("```"):
        block = []
        i += 1
        while i < len(lines) and not lines[i].startswith("```"):
            block.append(escape(lines[i]))
            i += 1
        story.append(Paragraph("<br/>".join(block), styles["code"]))
    elif line.startswith("| "):
        rows = []
        while i < len(lines) and lines[i].startswith("|"):
            cells = [c.strip() for c in lines[i].strip().strip("|").split("|")]
            if not all(re.fullmatch(r"[-: ]+", c) for c in cells):
                rows.append([p(c, "cell") for c in cells])
            i += 1
        widths = [92, 156, 255] if len(rows[0]) == 3 else [503/len(rows[0])] * len(rows[0])
        t = Table(rows, colWidths=widths, repeatRows=1, hAlign="LEFT")
        t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#DCE9E2")),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F3F6F3")]),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 8), ("RIGHTPADDING", (0, 0), (-1, -1), 8),
            ("TOPPADDING", (0, 0), (-1, -1), 8), ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
            ("LINEBELOW", (0, 0), (-1, 0), 0.7, green),
        ]))
        story.extend([t, Spacer(1, 12)])
        continue
    elif line.startswith("### "):
        story.append(p(line[4:], "h3"))
    elif line.startswith("## "):
        number = re.match(r"## (\d+)", line)
        if number and int(number[1]) in [3, 4, 6, 7, 8, 9]:
            story.append(PageBreak())
        story.append(p(line[3:], "h2"))
    elif line.startswith("# "):
        story.append(p(line[2:], "title"))
    elif line.startswith("> "):
        story.append(p(line[2:], "quote"))
    else:
        story.append(p(line))
    i += 1

def page_chrome(c, doc):
    c.saveState()
    w, h = A4
    c.setFillColor(green)
    c.rect(0, h - 11, w, 11, fill=1, stroke=0)
    c.setFont("Guide", 8)
    c.drawString(46, h - 33, "PILOTDECK / VERIFIED SUBTASKS")
    c.setFillColor(muted)
    c.drawRightString(w - 46, h - 33, "方向三 · 现场演示与答辩")
    c.setStrokeColor(colors.HexColor("#CEDBD4"))
    c.line(46, 37, w - 46, 37)
    c.drawString(46, 24, "2026-09-11 / 受控故障 · 真实执行 · 证据与限制")
    c.drawRightString(w - 46, 24, str(doc.page))
    c.restoreState()

args.output.parent.mkdir(parents=True, exist_ok=True)
doc = SimpleDocTemplate(str(args.output), pagesize=A4, leftMargin=46, rightMargin=46, topMargin=55, bottomMargin=52,
                        title="PilotDeck 现场演示与答辩手册", author="PilotDeck Verified Subtasks")
doc.build(story, onFirstPage=page_chrome, onLaterPages=page_chrome)
print(args.output)
