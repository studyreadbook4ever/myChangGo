from __future__ import annotations

import re
from dataclasses import dataclass

from markdown_it import MarkdownIt

from .identity import normalize_name
from .models import NodeDraft
from .prompts import GenerationContext

_CITATION_RE = re.compile(r"\[(S\d+)\]")
_SENTENCE_END_RE = re.compile(r"[!?。！？]+|(?<!\d)\.+(?!\d)|\.+(?=\s|$)")
_MARKDOWN_LINK_RE = re.compile(r"!?\[[^\]\n]*\](?:\[[^\]\n]*\]|\([^\)\n]*\))")
_MARKDOWN_REFERENCE_RE = re.compile(r"(?m)^\s{0,3}\[[^\]\n]*\]:\s*\S+")
_UNSAFE_AUTOLINK_RE = re.compile(r"<\s*(?:javascript|data|vbscript):[^>\n]*>", re.IGNORECASE)
_MARKDOWN_INSPECTOR = MarkdownIt("commonmark", {"html": True})


@dataclass(slots=True)
class _MarkdownInspection:
    prose: str
    h1_count: int
    h2_count: int
    has_raw_html: bool
    authored_links: list[str]


def _inspect_markdown(markdown: str) -> _MarkdownInspection:
    """코드 외 텍스트와 생성 모델이 넣은 제목·HTML·링크를 검사한다."""

    prose: list[str] = []
    h1_count = 0
    h2_count = 0
    has_raw_html = False
    authored_links: list[str] = []
    environment: dict[str, object] = {}
    for token in _MARKDOWN_INSPECTOR.parse(markdown, environment):
        if token.type == "heading_open":
            if token.tag == "h1":
                h1_count += 1
            elif token.tag == "h2":
                h2_count += 1
        if token.type == "html_block":
            has_raw_html = True
        if token.type != "inline" or not token.children:
            continue
        for child in token.children:
            if child.type == "html_inline":
                has_raw_html = True
            elif child.type == "text":
                prose.append(child.content)
            if child.type in {"link_open", "image"}:
                attribute = "href" if child.type == "link_open" else "src"
                authored_links.append(child.attrGet(attribute) or child.content or "Markdown link/image")
    prose_text = "\n".join(prose)
    authored_links.extend(_MARKDOWN_LINK_RE.findall(prose_text))
    authored_links.extend(_MARKDOWN_REFERENCE_RE.findall(prose_text))
    authored_links.extend(_UNSAFE_AUTOLINK_RE.findall(prose_text))
    references = environment.get("references")
    if isinstance(references, dict):
        authored_links.extend(
            str(reference.get("href", "Markdown reference"))
            for reference in references.values()
            if isinstance(reference, dict)
        )
    return _MarkdownInspection(
        prose=prose_text,
        h1_count=h1_count,
        h2_count=h2_count,
        has_raw_html=has_raw_html,
        authored_links=list(dict.fromkeys(authored_links)),
    )


def _citation_ids_from_prose(prose: str) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []
    for source_id in _CITATION_RE.findall(prose):
        if source_id not in seen:
            seen.add(source_id)
            ordered.append(source_id)
    return ordered


def citation_ids(markdown: str) -> list[str]:
    return _citation_ids_from_prose(_inspect_markdown(markdown).prose)


def sanitize_draft(draft: NodeDraft, context: GenerationContext) -> NodeDraft:
    unique_children = []
    seen: set[str] = set()
    if not context.terminal:
        for child in draft.children:
            child.name = child.name.strip()
            child.definition = child.definition.strip()
            key = normalize_name(child.name)
            if not key or key == context.node.normalized_name or key in seen:
                continue
            seen.add(key)
            unique_children.append(child)
            if len(unique_children) >= context.max_children:
                break
    draft.name = draft.name.strip() or context.node.name
    draft.summary = draft.summary.strip()
    draft.body_markdown = draft.body_markdown.strip()
    draft.decomposition_basis = draft.decomposition_basis.strip() if unique_children else ""
    draft.children = unique_children
    return draft


def validate_draft(draft: NodeDraft, context: GenerationContext, *, grounded: bool) -> list[str]:
    issues: list[str] = []
    inspection = _inspect_markdown(draft.body_markdown)
    prose = inspection.prose
    if not draft.name:
        issues.append("개념명이 비어 있습니다.")
    elif normalize_name(draft.name) != context.node.normalized_name:
        issues.append(f"개념명이 기대한 '{context.node.name}'과 다릅니다.")
    if not draft.summary:
        issues.append("요약이 비어 있습니다.")
    if len(draft.summary) > context.summary_max_chars:
        issues.append(f"요약이 {context.summary_max_chars}자를 넘습니다.")
    sentence_count = len(_SENTENCE_END_RE.findall(draft.summary))
    if sentence_count > 3:
        issues.append("요약이 3문장을 넘습니다.")
    if not re.search(r"[가-힣]", draft.summary + prose):
        issues.append("한국어 본문이 아닙니다.")
    if context.node.normalized_name not in normalize_name(draft.summary + prose):
        issues.append(f"요약이나 본문에서 현재 개념 '{context.node.name}'을 확인할 수 없습니다.")
    if not draft.body_markdown:
        issues.append("본문이 비어 있습니다.")
    if len(draft.body_markdown) > context.max_chars:
        issues.append(f"본문이 최대 {context.max_chars}자를 넘습니다.")
    if not 2 <= inspection.h2_count <= 5:
        issues.append("본문은 2개 이상 5개 이하의 H2 절로 구성해야 합니다.")
    if inspection.h1_count:
        issues.append("본문에는 문서 제목과 충돌하는 H1을 넣을 수 없습니다.")
    if inspection.has_raw_html:
        issues.append("순수 Markdown 본문에는 raw HTML 태그를 넣을 수 없습니다.")
    if inspection.authored_links:
        issues.append("LLM 본문에는 링크나 이미지 Markdown을 넣을 수 없습니다: " + ", ".join(inspection.authored_links))
    if len(draft.children) > context.max_children:
        issues.append(f"하위개념이 최대 {context.max_children}개를 넘습니다.")
    if context.terminal and draft.children:
        issues.append("terminal node에는 하위개념이 없어야 합니다.")
    if draft.children and not draft.decomposition_basis:
        issues.append("하위개념의 동일 분해 기준이 비어 있습니다.")
    for child in draft.children:
        if not child.name or not child.definition:
            issues.append("하위개념명과 정의는 비어 있을 수 없습니다.")
            break
        if normalize_name(child.name) not in normalize_name(prose):
            issues.append(f"본문에 하위개념 '{child.name}'의 요약 정의가 없습니다.")
    allowed_ids = {source.source_id for source in context.sources}
    used_ids = set(_citation_ids_from_prose(prose))
    unknown_ids = sorted(used_ids - allowed_ids)
    if unknown_ids:
        issues.append(f"제공되지 않은 출처 ID를 사용했습니다: {', '.join(unknown_ids)}")
    if grounded and allowed_ids and not used_ids:
        issues.append("근거가 제공됐지만 본문에 출처 ID 인용이 없습니다.")
    if grounded and not allowed_ids:
        issues.append("근거 기반 생성에 사용할 웹 출처가 없습니다.")
    return issues
