import os
from pathlib import Path
import fitz  # PyMuPDF

src = Path("pdfs")
out = Path("pdfs_txt"); out.mkdir(exist_ok=True)

for pdf in src.glob("*.pdf"):
    doc = fitz.open(pdf)
    parts = []
    for page in doc:
        # 'text' uses layout-aware extraction; try 'blocks' if you need more structure
        parts.append(page.get_text("text"))
    out_path = out / (pdf.stem + ".txt")
    out_path.write_text("\n".join(parts), encoding="utf-8")
    print(f"[ok] wrote {out_path} ({doc.page_count} pages)")
    doc.close()
