"""노트북을 빈 폴더의 새 커널에서 실행하고 별도 프로세스의 복원을 확인한다."""
from __future__ import annotations

import ast
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

import nbformat
from nbclient import NotebookClient
from nbconvert import HTMLExporter
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent
NOTEBOOK = ROOT / "Dense_Retrieval_From_Scratch.ipynb"


def reconstruction_program(notebook):
    """학습 셀을 실행하지 않고 노트북의 실제 정의만 사용해 복원하는 프로그램."""
    selected = {
        "normalize_text", "count_pairs", "merge_pair", "choose_pair", "apply_bpe_to_word",
        "ScratchBPE", "pack_batch", "ModelConfig", "BertEmbeddings", "MultiHeadSelfAttention",
        "EncoderBlock", "TinyBert", "masked_mean", "SentenceEncoder", "encode_texts", "search_documents",
    }
    parts = ['''import json, math, unicodedata, sys
from collections import Counter
from dataclasses import dataclass, asdict
from pathlib import Path
import torch
from torch import nn
from torch.nn import functional as F
torch.set_num_threads(1)
SPECIAL_PIECES = ["[PAD]", "[UNK]", "[CLS]", "[SEP]", "[MASK]"]
WORD_START = "▁"
bundle = torch.load(Path(sys.argv[1]), map_location="cpu", weights_only=True)
''']
    found = set()
    for cell in notebook.cells:
        if cell.cell_type != "code":
            continue
        for node in ast.parse(cell.source).body:
            if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in selected:
                parts.append(ast.unparse(node))
                found.add(node.name)
                if node.name == "ScratchBPE":
                    parts.append('tokenizer = ScratchBPE.from_dict(bundle["tokenizer"])')
    if found != selected:
        raise AssertionError(f"재구성할 정의가 없습니다: {selected - found}")
    parts.append('''
config = ModelConfig(**bundle["encoder_config"])
model = SentenceEncoder(TinyBert(config), **bundle["retriever_config"])
model.load_state_dict(bundle["state_dict"])
model.eval()
with torch.no_grad():
    vectors = encode_texts(model, bundle["documents"], tokenizer)
torch.testing.assert_close(vectors, bundle["document_vectors"], atol=0, rtol=0)
hits, info = search_documents("쥐 가 고양이 를 뒤쫓다 장면", model, tokenizer,
                              vectors, bundle["documents"], bundle["document_names"])
assert hits[0]["id"] == 1
for text in ["", "[PAD]", "고양이 [MASK]", "고양이 ▁ 쥐"]:
    try:
        tokenizer.encode(text)
    except ValueError:
        pass
    else:
        raise AssertionError(f"예약 표식/빈 입력이 허용됨: {text!r}")
# 기본값 96과 다른 저장 설정도 전처리에서 따라가는지 확인한다.
extended_config = ModelConfig(vocab_size=tokenizer.vocab_size, max_len=128)
extended_model = SentenceEncoder(TinyBert(extended_config)).eval()
long_query = " ".join(["쥐"] * 100)
with torch.no_grad():
    long_vector = encode_texts(extended_model, [long_query], tokenizer)
assert long_vector.shape == (1, 32)
print(json.dumps({"restored_vectors_exact": True, "top_document_id": hits[0]["id"],
                  "separate_process": True, "reserved_inputs_rejected": True,
                  "nondefault_max_length": True}, ensure_ascii=False))
''')
    return "\n\n".join(parts)


def export_html(notebook):
    exporter = HTMLExporter(template_name="lab", embed_images=True)
    page, _ = exporter.from_notebook_node(notebook)
    soup = BeautifulSoup(page, "html.parser")
    style = soup.new_tag("style")
    style.string = """
    .jp-Notebook { max-width: 1080px; margin: auto; padding: 36px 28px 80px; }
    .jp-RenderedHTMLCommon { font-size: 16px; line-height: 1.8; }
    .jp-RenderedHTMLCommon h2 { margin-top: 2.5em; border-top: 1px solid #ddd; padding-top: 1em; }
    .jp-RenderedHTMLCommon h3 { margin-top: 1.8em; }
    .jp-RenderedHTMLCommon p { max-width: 84ch; }
    .jp-RenderedHTMLCommon table { display: block; overflow-x: auto; max-width: 100%; font-size: 14px; line-height: 1.65; }
    .jp-RenderedHTMLCommon th, .jp-RenderedHTMLCommon td { text-align: left; padding: 7px 11px; }
    .jp-InputArea-editor { border-radius: 0; font-size: 13px; line-height: 1.55; overflow-x: auto; }
    .jp-OutputArea-output pre { font-size: 13px; line-height: 1.55; }
    details { border-left: 2px solid #aaa; padding: 8px 16px; margin: 14px 0; }
    summary { cursor: pointer; }
    .course-contents { line-height: 1.9; border-bottom: 1px solid #ddd; padding-bottom: 22px; margin: 22px 0 30px; }
    .course-contents a { display: block; text-decoration: none; }
    @media (max-width: 700px) { .jp-Notebook { padding: 16px 6px; } .jp-RenderedHTMLCommon { font-size: 15px; } }
    @media print { .jp-Notebook { padding: 0; } .jp-Cell { break-inside: avoid; } }
    """
    soup.head.append(style)
    headings = [h for h in soup.select("h2") if h.get_text(strip=True)[:1].isdigit()]
    nav = soup.new_tag("nav", attrs={"class": "course-contents", "aria-label": "장 바로가기"})
    for heading in headings:
        link = soup.new_tag("a", href="#" + heading.get("id", ""))
        link.string = heading.get_text(" ", strip=True).replace("¶", "").strip()
        nav.append(link)
    title = soup.find("h1")
    title.insert_after(nav)
    captions = [
        "첫 attention head의 query 위치별 key 확률. 토큰과 위치의 대응은 아래 표에 있다.",
        "MLM 학습 loss와 8 step 이동 평균. 각 step에서 새로 손상한 문장을 사용한다.",
        "평균 모델과 문맥 encoder의 검색 loss, 검증 Recall@1 비교.",
    ]
    for index, image in enumerate(soup.find_all("img")):
        image["alt"] = captions[index] if index < len(captions) else "교재에서 계산한 결과 시각화"
    target = NOTEBOOK.with_suffix(".html")
    target.write_text(str(soup), encoding="utf-8")
    assert len(soup.select(".jp-CodeCell")) == sum(c.cell_type == "code" for c in notebook.cells)
    assert len(headings) == 7
    assert soup.select("nav.course-contents a")
    return target


def main():
    started = time.perf_counter()
    notebook = nbformat.read(NOTEBOOK, as_version=4)
    code_cells = [c for c in notebook.cells if c.cell_type == "code"]
    forbidden_imports = {"lab", "data", "tokenizer_lab", "transformers", "tokenizers", "sentence_transformers"}
    for cell in code_cells:
        tree = ast.parse(cell.source)
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                assert all(n.name.split(".")[0] not in forbidden_imports for n in node.names)
            elif isinstance(node, ast.ImportFrom):
                assert (node.module or "").split(".")[0] not in forbidden_imports
        cell.outputs = []
        cell.execution_count = None
    with tempfile.TemporaryDirectory(prefix="retrieval-course-") as tmp:
        # 교재 원본 파일이 없는 새 디렉터리에서 실행한다.
        client = NotebookClient(notebook, timeout=180, kernel_name="python3",
                                resources={"metadata": {"path": tmp}}, record_timing=True)
        client.execute()
        assert all(c.execution_count is not None for c in code_cells)
        errors = [o for c in code_cells for o in c.outputs if o.output_type == "error"]
        assert not errors
        nbformat.validate(notebook)
        generated_artifacts = Path(tmp) / "artifacts" / "course"
        restore_program = Path(tmp) / "restore_from_notebook.py"
        restore_program.write_text(reconstruction_program(notebook), encoding="utf-8")
        completed = subprocess.run(
            [sys.executable, str(restore_program), str(generated_artifacts / "retriever.pt")],
            check=True, capture_output=True, text=True, cwd=tmp,
        )
        restore_result = json.loads(completed.stdout.strip())
        shutil.copytree(generated_artifacts, ROOT / "artifacts" / "course", dirs_exist_ok=True)
        shutil.copy2(restore_program, ROOT / "artifacts" / "course" / "restore_from_notebook.py")
    nbformat.write(notebook, NOTEBOOK)
    html_path = export_html(notebook)
    source_hashes = {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
                     for path in sorted((ROOT / "course").glob("*.md"))}
    report = {
        "executed_code_cells": len(code_cells),
        "markdown_cells": sum(c.cell_type == "markdown" for c in notebook.cells),
        "execution_directory_contained_course_sources": False,
        "all_cells_executed": True,
        "cell_errors": len(errors),
        "forbidden_imports_found": False,
        "saved_model_verification": restore_result,
        "html": html_path.name,
        "sources": source_hashes,
        "notebook_sha256": hashlib.sha256(NOTEBOOK.read_bytes()).hexdigest(),
        "verification_seconds": time.perf_counter() - started,
    }
    (ROOT / "artifacts" / "course" / "verification.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
