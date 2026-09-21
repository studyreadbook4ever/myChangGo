"""교재 Markdown을 외부 소스 의존이 없는 Jupyter 노트북과 Python 파일로 만든다."""
from __future__ import annotations

import ast
import hashlib
import re
from pathlib import Path

import nbformat

ROOT = Path(__file__).resolve().parent
NOTEBOOK = ROOT / "Dense_Retrieval_From_Scratch.ipynb"


def source_cells(path):
    lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
    # 제목 하나 아래 장/절의 깊이를 통일한다. 코드 fence 안의 주석은 건드리지 않는다.
    demote = path.name != "00_opening.md" and lines[0].startswith("# ")
    markdown = []
    index = 0
    while index < len(lines):
        if lines[index].strip() == "```python":
            if "".join(markdown).strip():
                yield "markdown", "".join(markdown).strip()
                markdown = []
            index += 1
            code = []
            while index < len(lines) and lines[index].strip() != "```":
                code.append(lines[index])
                index += 1
            if index == len(lines):
                raise ValueError(f"닫히지 않은 Python fence: {path}")
            text = "".join(code).strip()
            ast.parse(text, filename=str(path))
            yield "code", text
        else:
            line = lines[index]
            if demote and re.match(r"^#{1,5} ", line):
                line = "#" + line
            markdown.append(line)
        index += 1
    if "".join(markdown).strip():
        yield "markdown", "".join(markdown).strip()


def build():
    cells = []
    python_parts = ["# Generated from course/*.md. All model code and data are included here.\n"]
    for path in sorted((ROOT / "course").glob("[0-9][0-9]_*.md")):
        for number, (kind, text) in enumerate(source_cells(path)):
            identity = hashlib.sha256(f"{path.name}:{number}:{text}".encode()).hexdigest()[:12]
            metadata = {"source_section": path.name, "tags": [path.stem]}
            if kind == "code":
                cell = nbformat.v4.new_code_cell(text, metadata=metadata)
                python_parts.append(f"\n# %% {path.name} / cell {number}\n{text}\n")
            else:
                cell = nbformat.v4.new_markdown_cell(text, metadata=metadata)
            cell.id = identity
            cells.append(cell)
    notebook = nbformat.v4.new_notebook(cells=cells)
    notebook.metadata.kernelspec = {
        "display_name": "Python 3 (course .venv)", "language": "python", "name": "python3"
    }
    notebook.metadata.language_info = {"name": "python", "version": "3.12.13"}
    notebook.metadata.title = "토크나이저에서 검색기까지"
    nbformat.validate(notebook)
    nbformat.write(notebook, NOTEBOOK)
    (ROOT / "retrieval_course.py").write_text("".join(python_parts), encoding="utf-8")
    print(f"{NOTEBOOK.name}: {sum(c.cell_type == 'code' for c in cells)} code cells, "
          f"{sum(c.cell_type == 'markdown' for c in cells)} markdown cells")


if __name__ == "__main__":
    build()
