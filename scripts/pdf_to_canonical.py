#!/usr/bin/env python3
"""
Convert Salesforce "Kvalitetsdokument" PDF printouts (Mio) into canonical articles.

    pip install pymupdf
    python3 scripts/pdf_to_canonical.py data/pdf/*.pdf -o data/raw/kvalitetsdokumenter.json
    npm run kb:normalize && npm run kb:ingest

The printouts come from .../apex/Kvalitetsdokument_Utskrift?id=ka0... and have a fixed layout:
  page 1   title (19pt bold), metadata table (Dokumentnr., Versjon, Dokumenttype, Dokumentansvarlig,
           Selskap, Publisert, Neste revidering, Utskrevet)
  pages 2+ sections as 13pt bold headings (Formål, Omfang/virkeområde, Definisjoner,
           Aktivitet/beskrivelse, Ansvar, ...), 11pt bold sub-headings, body text, bullet lists
           (bullets are drawn squares, not characters), numbered lists, tables, inline links.

Output follows src/lib/schema.ts (Article). Everything Salesforce-specific lives in this file.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

try:
    import pymupdf
except ImportError:  # pragma: no cover
    sys.exit("pymupdf is required: pip install pymupdf")

INSTANCE_URL = "https://miofamilien.lightning.force.com"
FOOTER_MAX_SIZE = 8.5
HEADING_SIZE = 12.5          # 13pt bold = section heading
TITLE_SIZE = 16              # 19pt bold = document title
PARAGRAPH_GAP = 20           # vertical gap (pt) that starts a new paragraph
FULL_LINE_X1 = 430           # a line ending left of this was a hard line break, not a wrap
LINK_COLORS = {0x0B5E98, 0x0B5F98}  # blue link text in the printouts
BOLD_FLAG = 16
PRINT_DISCLAIMER = "Utskrifter er ukontrollerte kopier"


@dataclass
class Line:
    y0: float
    y1: float
    x0: float
    x1: float
    spans: list[dict]

    @property
    def text(self) -> str:
        return "".join(s["text"] for s in self.spans).replace("\xa0", " ").strip()

    @property
    def all_bold(self) -> bool:
        visible = [s for s in self.spans if s["text"].strip()]
        return bool(visible) and all(s["flags"] & BOLD_FLAG for s in visible)

    @property
    def size(self) -> float:
        return max(s["size"] for s in self.spans)


@dataclass
class Element:
    kind: str                 # heading | subheading | para | bullet | numbered | table
    text: str = ""
    level: int = 0
    y: float = 0
    rows: list[list[str]] = field(default_factory=list)


def span_markdown(span: dict, links: list[str]) -> str:
    text = span["text"].replace("\xa0", " ")
    if not text.strip():
        return text
    if span["color"] in LINK_COLORS:
        t = text.strip()
        if t and t not in links:
            links.append(t)
        return text
    if span["flags"] & BOLD_FLAG:
        lead, body, trail = re.match(r"^(\s*)(.*?)(\s*)$", text, re.S).groups()
        return f"{lead}**{body}**{trail}" if body else text
    return text


def line_markdown(line: Line, links: list[str], strip_bold: bool = False) -> str:
    if strip_bold:
        return line.text
    md = "".join(span_markdown(s, links) for s in line.spans).strip()
    return re.sub(r"\*\*\s*\*\*", "", md)


def page_lines(page: "pymupdf.Page", exclude: list["pymupdf.Rect"]) -> list[Line]:
    """Text lines on a page, excluding header/footer and any rectangles (tables)."""
    lines: list[Line] = []
    for block in page.get_text("dict")["blocks"]:
        if block["type"] != 0:
            continue
        for ln in block["lines"]:
            spans = [s for s in ln["spans"] if s["text"]]
            if not spans:
                continue
            if max(s["size"] for s in spans) <= FOOTER_MAX_SIZE:
                continue
            bbox = pymupdf.Rect(ln["bbox"])
            if any(r.intersects(bbox) for r in exclude):
                continue
            line = Line(bbox.y0, bbox.y1, bbox.x0, bbox.x1, spans)
            if not line.text or line.text.startswith(PRINT_DISCLAIMER):
                continue
            lines.append(line)
    lines.sort(key=lambda l: (round(l.y0), l.x0))
    # Merge spans that sit on the same baseline (pymupdf splits lines at colour changes).
    merged: list[Line] = []
    for line in lines:
        if merged and abs(merged[-1].y0 - line.y0) < 2 and line.x0 >= merged[-1].x0:
            merged[-1].spans.extend(line.spans)
            merged[-1].y1 = max(merged[-1].y1, line.y1)
            merged[-1].x1 = max(merged[-1].x1, line.x1)
        else:
            merged.append(line)
    return merged


def bullet_positions(page: "pymupdf.Page") -> list[tuple[float, float]]:
    """(x, y-center) of drawn bullet squares."""
    out = []
    for d in page.get_drawings():
        r = d["rect"]
        if 1.5 <= r.width <= 6 and 1.5 <= r.height <= 6 and d.get("fill"):
            out.append((r.x0, (r.y0 + r.y1) / 2))
    return out


def table_markdown(rows: list[list[str | None]]) -> str:
    clean = [[(c or "").replace("\n", " ").strip() for c in row] for row in rows]
    clean = [r for r in clean if any(r)]
    if not clean:
        return ""
    width = max(len(r) for r in clean)
    clean = [r + [""] * (width - len(r)) for r in clean]
    # Carry merged first-column values down so each row is self-describing.
    for i in range(1, len(clean)):
        if not clean[i][0]:
            clean[i][0] = clean[i - 1][0]
    header, body = clean[0], clean[1:]
    esc = lambda c: c.replace("|", "\\|")
    out = ["| " + " | ".join(esc(c) for c in header) + " |", "|" + "---|" * width]
    out += ["| " + " | ".join(esc(c) for c in r) + " |" for r in body]
    return "\n".join(out)


def extract_elements(doc: "pymupdf.Document", links: list[str], body_start_y: float) -> list[Element]:
    elements: list[Element] = []
    prev_page_full = False
    for page in doc:
        tables = page.find_tables(strategy="lines_strict").tables
        table_rects = []
        table_elements = []
        for t in tables:
            rect = pymupdf.Rect(t.bbox)
            if page.number == 0 and rect.y0 < body_start_y:
                continue  # metadata table
            table_rects.append(rect)
            table_elements.append(Element("table", y=rect.y0, rows=t.extract()))

        bullets = bullet_positions(page)
        lines = page_lines(page, table_rects)
        if page.number == 0:
            lines = [l for l in lines if l.y0 >= body_start_y]

        page_elements: list[Element] = []
        prev: Line | None = None
        for line in lines:
            text = line.text
            is_bullet = any(abs(by - (line.y0 + line.y1) / 2) < 5 and bx < line.x0 for bx, by in bullets)
            numbered = re.match(r"^(\d+)\.\s+(.*)", text)
            gap = (line.y0 - prev.y1) if prev else 999
            # A line continues the previous one only if the previous line ran to the right margin.
            wraps = prev is not None and gap < PARAGRAPH_GAP and prev.x1 > FULL_LINE_X1
            last = page_elements[-1] if page_elements else None

            if line.all_bold and line.size >= HEADING_SIZE:
                page_elements.append(Element("heading", text, y=line.y0))
            elif line.all_bold and len(text) < 120 and not text.endswith((".", ":")) and not is_bullet:
                page_elements.append(Element("subheading", text, y=line.y0))
            elif is_bullet:
                level = 0 if line.x0 < 75 else 1
                page_elements.append(Element("bullet", line_markdown(line, links), level, y=line.y0))
            elif numbered and 48 < line.x0 < 75 and not wraps:
                page_elements.append(Element("numbered", line_markdown(line, links), y=line.y0))
            elif last and last.kind in ("bullet", "numbered") and wraps and line.x0 > 55:
                last.text += " " + line_markdown(line, links)          # wrapped list item
            elif last and last.kind == "para" and wraps:
                last.text += " " + line_markdown(line, links)          # wrapped paragraph
            else:
                page_elements.append(Element("para", line_markdown(line, links), y=line.y0))
            prev = line

        page_elements.extend(table_elements)
        page_elements.sort(key=lambda e: e.y)
        # Paragraph continuation across a page break (previous page ended with a full, unterminated line).
        if elements and page_elements and elements[-1].kind == "para" and page_elements[0].kind == "para" \
                and prev_page_full and not elements[-1].text.rstrip().endswith((".", ":", "!", "?")):
            elements[-1].text += " " + page_elements.pop(0).text
        elements.extend(page_elements)
        prev_page_full = bool(lines) and lines[-1].x1 > FULL_LINE_X1
    return elements


def elements_to_markdown(elements: list[Element]) -> str:
    out: list[str] = []
    prev_kind = None
    for el in elements:
        if el.kind == "heading":
            out.append(f"\n## {el.text}\n")
        elif el.kind == "subheading":
            out.append(f"\n### {el.text}\n")
        elif el.kind == "bullet":
            if prev_kind not in ("bullet", "numbered"):
                out.append("")
            out.append("  " * el.level + f"- {el.text}")
        elif el.kind == "numbered":
            if prev_kind not in ("bullet", "numbered"):
                out.append("")
            out.append(el.text)
        elif el.kind == "table":
            out.append("\n" + table_markdown(el.rows) + "\n")
        else:
            out.append("\n" + el.text)
        prev_kind = el.kind
    md = "\n".join(out)
    md = re.sub(r"[ \t]+\n", "\n", md)
    md = re.sub(r"\n{3,}", "\n\n", md)
    return md.strip()


def parse_metadata(doc: "pymupdf.Document") -> tuple[str, dict[str, str], float]:
    page = doc[0]
    title_parts = []
    for block in page.get_text("dict")["blocks"]:
        if block["type"] != 0:
            continue
        for ln in block["lines"]:
            for s in ln["spans"]:
                if s["size"] >= TITLE_SIZE and s["text"].strip():
                    title_parts.append(s["text"].strip())
    title = " ".join(title_parts)

    meta: dict[str, str] = {}
    body_start_y = 0.0
    for t in page.find_tables(strategy="lines_strict").tables:
        rows = t.extract()
        if rows and (rows[0][0] or "").startswith("Dokumentnr"):
            for k, v in rows:
                if k:
                    meta[k.strip().rstrip(".")] = (v or "").strip()
            body_start_y = t.bbox[3] + 1
    return title, meta, body_start_y


def article_id(doc: "pymupdf.Document") -> str | None:
    for page in doc:
        m = re.search(r"[?&]id=(ka0[A-Za-z0-9]+)", page.get_text())
        if m:
            return m.group(1)
    return None


def to_iso(d: str) -> str | None:
    try:
        return datetime.strptime(d.strip(), "%d.%m.%Y").replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
    except ValueError:
        return None


def convert(path: Path) -> dict:
    doc = pymupdf.open(path)
    title, meta, body_start_y = parse_metadata(doc)
    aid = article_id(doc) or path.stem
    links: list[str] = []
    elements = extract_elements(doc, links, body_start_y)
    body = elements_to_markdown(elements)

    companies = [c.strip() for c in meta.get("Selskap", "").split(",") if c.strip()]
    doc_type = meta.get("Dokumenttype", "")
    owner = meta.get("Dokumentansvarlig", "")

    header_bits = [f"Dokumenttype: {doc_type}" if doc_type else None,
                   f"Dokumentansvarlig: {owner}" if owner else None,
                   f"Selskap: {', '.join(companies)}" if companies else None,
                   f"Publisert: {meta['Publisert']}" if meta.get("Publisert") else None,
                   f"Neste revidering: {meta['Neste revidering']}" if meta.get("Neste revidering") else None]
    header = " · ".join(b for b in header_bits if b)
    if links and "## Relaterte dokumenter" not in body:
        body += "\n\n## Se også\n\n" + "\n".join(f"- {l}" for l in links)
    body_md = (header + "\n\n" + body).strip()

    # Summary: first paragraph under "Formål".
    summary = None
    m = re.search(r"## Formål\s*\n+(.+?)(?:\n\n|\Z)", body, re.S)
    if m:
        summary = re.sub(r"\s+", " ", m.group(1)).strip()[:300]

    categories = []
    if doc_type:
        categories.append(f"Dokumenttype/{doc_type}")
    categories += [f"Selskap/{c}" for c in companies]
    if owner:
        categories.append(f"Dokumentansvarlig/{owner}")

    version = meta.get("Versjon")
    article = {
        "id": aid,
        "articleNumber": meta.get("Dokumentnr") or None,
        "title": title or path.stem,
        "summary": summary,
        "bodyMd": body_md,
        "categories": sorted(set(categories)),
        "language": "no",
        "version": int(version) if version and version.isdigit() else None,
        "lastPublished": to_iso(meta.get("Publisert", "")),
        "sourceUrl": f"{INSTANCE_URL}/lightning/r/Knowledge__kav/{aid}/view",
        "metadata": {k: v for k, v in meta.items() if k != "Utskrevet"},
    }
    return {k: v for k, v in article.items() if v is not None}


def main() -> None:
    global INSTANCE_URL
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pdfs", nargs="+", type=Path)
    ap.add_argument("-o", "--out", type=Path, default=Path("data/raw/kvalitetsdokumenter.json"))
    ap.add_argument("--instance-url", default=INSTANCE_URL)
    args = ap.parse_args()
    INSTANCE_URL = args.instance_url.rstrip("/")

    articles = []
    for pdf in args.pdfs:
        try:
            a = convert(pdf)
            articles.append(a)
            print(f"  {pdf.name}: {a['title']!r} ({len(a['bodyMd'])} chars, {len(a['categories'])} categories)")
        except Exception as e:  # keep going; report at the end
            print(f"  {pdf.name}: FAILED {e}", file=sys.stderr)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(articles, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {len(articles)} articles to {args.out}")


if __name__ == "__main__":
    main()
