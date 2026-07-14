from __future__ import annotations

import json

from llm_orchestrator.identity import normalize_name
from llm_orchestrator.models import (
    ChildProposal,
    ConceptNode,
    DuplicateDecision,
    LLMResult,
    NodeDraft,
    NodeStatus,
    Source,
)
from llm_orchestrator.orchestrator import EagerOrchestrator
from llm_orchestrator.prompts import GenerationContext, generation_prompt, review_prompt
from llm_orchestrator.providers import MockLLMProvider
from llm_orchestrator.providers.llm import extract_json
from llm_orchestrator.validation import citation_ids, sanitize_draft, validate_draft
from llm_orchestrator.workspace import WorkStore


def test_citation_validation_rejects_hallucinated_ids_and_requires_grounding() -> None:
    node = ConceptNode(
        node_id="root",
        name="운영체제",
        normalized_name=normalize_name("운영체제"),
        seed_definition="",
        depth=0,
        primary_path=["운영체제"],
    )
    source = Source("S1", "공식 문서", "https://example.test/source", content="운영체제 근거")
    context = GenerationContext(node, "운영체제", 1, 4, 2_000, 5_000, 100, [source])
    draft = NodeDraft("운영체제", "운영체제를 설명합니다.", "운영체제의 핵심 주장입니다. [S9]")

    issues = validate_draft(draft, context, grounded=True)

    assert any("S9" in issue and "제공되지 않은" in issue for issue in issues)
    assert any("출처 ID 인용이 없습니다" in issue for issue in issues) is False

    draft.body_markdown = "운영체제의 핵심 주장입니다."
    assert any("출처 ID 인용이 없습니다" in issue for issue in validate_draft(draft, context, grounded=True))


def test_citation_ids_are_unique_and_keep_first_use_order() -> None:
    assert citation_ids("첫째 [S2], 둘째 [S1], 다시 [S2].") == ["S2", "S1"]


def test_summary_sentence_limit_cannot_be_bypassed_without_spaces() -> None:
    node = ConceptNode("root", "운영체제", normalize_name("운영체제"), "", 0, ["운영체제"])
    context = GenerationContext(node, "운영체제", 0, 4, 2_000, 5_000, 100, [])
    draft = NodeDraft(
        "운영체제",
        "운영체제 첫째.둘째.셋째.넷째.",
        "## 개요\n\n운영체제를 설명합니다.\n\n## 원리\n\n핵심 원리를 설명합니다.",
    )

    issues = validate_draft(draft, context, grounded=False)

    assert "요약이 3문장을 넘습니다." in issues


def test_citation_inside_code_does_not_count_as_grounding() -> None:
    node = ConceptNode(
        node_id="root",
        name="운영체제",
        normalized_name=normalize_name("운영체제"),
        seed_definition="",
        depth=0,
        primary_path=["운영체제"],
    )
    source = Source("S1", "공식 문서", "https://example.test/source", content="운영체제 근거")
    context = GenerationContext(node, "운영체제", 0, 4, 2_000, 5_000, 100, [source])
    body = "## 개요\n\n운영체제를 설명합니다.\n\n## 예제\n\n```text\n[S1]\n```"
    draft = NodeDraft("운영체제", "운영체제를 설명합니다.", body)

    assert citation_ids(body) == []
    assert any("출처 ID 인용이 없습니다" in issue for issue in validate_draft(draft, context, grounded=True))


def test_multiline_raw_html_is_rejected_but_fenced_html_example_is_allowed() -> None:
    node = ConceptNode(
        node_id="root",
        name="운영체제",
        normalized_name=normalize_name("운영체제"),
        seed_definition="",
        depth=0,
        primary_path=["운영체제"],
    )
    context = GenerationContext(node, "운영체제", 0, 4, 2_000, 5_000, 100, [])
    raw = "## 개요\n\n운영체제입니다.\n\n<img\nsrc=x\nonerror=alert(1)>\n\n## 원리\n\n설명"
    fenced = "## 개요\n\n운영체제입니다.\n\n## 예제\n\n```html\n<img src=x>\n```"

    assert any(
        "raw HTML" in issue for issue in validate_draft(NodeDraft("운영체제", "요약", raw), context, grounded=False)
    )
    assert not any(
        "raw HTML" in issue for issue in validate_draft(NodeDraft("운영체제", "요약", fenced), context, grounded=False)
    )


def test_model_authored_relative_link_is_rejected_before_site_rendering() -> None:
    node = ConceptNode(
        node_id="root",
        name="운영체제",
        normalized_name=normalize_name("운영체제"),
        seed_definition="",
        depth=0,
        primary_path=["운영체제"],
    )
    context = GenerationContext(node, "운영체제", 0, 4, 2_000, 5_000, 100, [])
    body = "## 개요\n\n운영체제 [누락 문서](missing.md)\n\n## 원리\n\n설명"

    issues = validate_draft(NodeDraft("운영체제", "운영체제 요약", body), context, grounded=False)

    assert any("링크나 이미지 Markdown" in issue and "missing.md" in issue for issue in issues)


def test_unsafe_markdown_link_and_external_image_are_rejected() -> None:
    node = ConceptNode("root", "운영체제", normalize_name("운영체제"), "", 0, ["운영체제"])
    context = GenerationContext(node, "운영체제", 0, 4, 2_000, 5_000, 100, [])
    bodies = (
        "## 개요\n\n운영체제 [클릭](javascript:alert(1))\n\n## 원리\n\n설명",
        "## 개요\n\n운영체제 ![추적](https://attacker.example/pixel)\n\n## 원리\n\n설명",
        "## 개요\n\n운영체제 [](javascript:alert(1))\n\n## 원리\n\n설명",
        "## 개요\n\n운영체제 ![](https://attacker.example/pixel)\n\n## 원리\n\n설명",
        "## 개요\n\n운영체제 [클릭]\n\n[클릭]: javascript:alert(1)\n\n## 원리\n\n설명",
        "## 개요\n\n운영체제 설명\n\n[미사용]: https://tracker.example/pixel\n\n## 원리\n\n설명",
        "## 개요\n\n운영체제 <javascript:alert(1)>\n\n## 원리\n\n설명",
    )

    for body in bodies:
        issues = validate_draft(NodeDraft("운영체제", "운영체제 요약", body), context, grounded=False)
        assert any("링크나 이미지 Markdown" in issue for issue in issues)


def test_body_h1_is_rejected_to_preserve_the_generated_document_title() -> None:
    node = ConceptNode("root", "운영체제", normalize_name("운영체제"), "", 0, ["운영체제"])
    context = GenerationContext(node, "운영체제", 0, 4, 2_000, 5_000, 100, [])
    body = "# 다른 제목\n\n## 개요\n\n운영체제 설명\n\n## 원리\n\n설명"

    issues = validate_draft(NodeDraft("운영체제", "운영체제 요약", body), context, grounded=False)

    assert any("H1" in issue for issue in issues)


def test_technical_symbols_remain_distinct_during_child_normalization() -> None:
    assert normalize_name("C") != normalize_name("C++")
    assert normalize_name("F#") != normalize_name("F")
    assert normalize_name(".NET") != normalize_name("NET")
    node = ConceptNode("root", "프로그래밍 언어", normalize_name("프로그래밍 언어"), "", 0, ["프로그래밍 언어"])
    context = GenerationContext(node, "프로그래밍 언어", 1, 4, 2_000, 5_000, 100, [])
    draft = NodeDraft(
        "프로그래밍 언어",
        "프로그래밍 언어를 설명합니다.",
        "## 개요\n\n프로그래밍 언어 C C++ F F#\n\n## 분류\n\n설명",
        "언어 계열",
        [ChildProposal(name, f"{name} 정의") for name in ("C", "C++", "F", "F#")],
    )

    assert [child.name for child in sanitize_draft(draft, context).children] == ["C", "C++", "F", "F#"]


def test_strict_review_prompt_includes_expected_path_and_decomposition_axis() -> None:
    node = ConceptNode("root", "운영체제", normalize_name("운영체제"), "", 0, ["운영체제"])
    context = GenerationContext(node, "운영체제", 1, 4, 2_000, 5_000, 100, [])
    draft = NodeDraft(
        "운영체제",
        "운영체제를 설명합니다.",
        "## 개요\n\n운영체제 설명\n\n## 원리\n\n설명",
        "핵심 기능",
        [ChildProposal("프로세스 관리", "프로세스를 관리합니다.")],
    )

    prompt = review_prompt(draft, context)

    assert "기대 개념명: 운영체제" in prompt
    assert "현재 경로: 운영체제" in prompt
    assert "분해 기준: 핵심 기능" in prompt
    assert "비슷한 추상화 수준" in prompt


def test_generation_and_review_prompts_apply_the_same_source_character_limit() -> None:
    node = ConceptNode("root", "운영체제", normalize_name("운영체제"), "", 0, ["운영체제"])
    source = Source(
        "S1",
        "긴 검색 결과",
        "https://example.test/source",
        snippet="Z" * 2_000,
        public_url_validated=True,
    )
    context = GenerationContext(
        node,
        "운영체제",
        0,
        4,
        2_000,
        5_000,
        100,
        [source],
        source_chars=500,
    )
    draft = NodeDraft(
        "운영체제",
        "운영체제 설명",
        "## 개요\n\n운영체제 설명\n\n## 원리\n\n설명",
    )

    for prompt in (generation_prompt(context), review_prompt(draft, context)):
        assert "Z" * 500 in prompt
        assert "Z" * 501 not in prompt


def test_draft_cannot_replace_requested_concept_with_unrelated_topic() -> None:
    node = ConceptNode(
        node_id="root",
        name="운영체제",
        normalized_name=normalize_name("운영체제"),
        seed_definition="",
        depth=0,
        primary_path=["운영체제"],
    )
    context = GenerationContext(node, "운영체제", 0, 4, 2_000, 5_000, 100, [])
    draft = NodeDraft(
        "고양이 사료 광고",
        "고양이 사료를 소개합니다.",
        "## 제품\n\n고양이 사료입니다.\n\n## 구매\n\n광고 문서입니다.",
    )

    issues = validate_draft(draft, context, grounded=False)

    assert any("개념명이 기대한" in issue for issue in issues)
    assert any("현재 개념 '운영체제'" in issue for issue in issues)


def test_extract_json_returns_outer_object_instead_of_last_child_object() -> None:
    raw = """모델 설명
```json
{"name":"운영체제","children":[{"name":"프로세스"},{"name":"메모리"}]}
```
"""

    assert extract_json(raw) == {
        "name": "운영체제",
        "children": [{"name": "프로세스"}, {"name": "메모리"}],
    }


class SynonymJudge(MockLLMProvider):
    def judge_duplicate(self, existing, candidate_name, candidate_definition, parent_path):
        self.duplicate_calls.append((existing.name, candidate_name))
        same = existing.name == "CPU 스케줄링"
        payload = {
            "relation": "same" if same else "distinct",
            "confidence": 0.97,
            "reason": "정의와 문맥이 같은 통용 표현" if same else "별개 개념",
            "canonical_name": existing.name if same else candidate_name,
        }
        return DuplicateDecision.from_dict(payload), LLMResult(payload, json.dumps(payload, ensure_ascii=False))


def test_semantic_duplicate_resolver_reuses_canonical_node_and_records_alias(config_factory) -> None:
    config = config_factory(web_enabled=False, allow_ungrounded=True)
    store = WorkStore.open(config)
    root = store.state.nodes[store.state.root_id]
    existing = ConceptNode(
        node_id="cpu-scheduler",
        name="CPU 스케줄링",
        normalized_name=normalize_name("CPU 스케줄링"),
        seed_definition="실행할 프로세스에 CPU 시간을 배정하는 운영체제 기법",
        depth=1,
        primary_path=["운영체제", "CPU 스케줄링"],
        parent_ids=[root.node_id],
        status=NodeStatus.COMPLETE,
    )
    store.state.nodes[existing.node_id] = existing
    llm = SynonymJudge()
    orchestrator = EagerOrchestrator(config, llm, None)
    orchestrator.store = store

    resolved = orchestrator._resolve_child(
        root,
        ChildProposal(
            "프로세스 스케줄링",
            "실행할 프로세스에 CPU 시간을 배정하는 운영체제 하위개념",
        ),
    )

    assert resolved is existing
    assert len(store.state.nodes) == 2
    assert "프로세스 스케줄링" in existing.aliases
    assert ("CPU 스케줄링", "프로세스 스케줄링") in llm.duplicate_calls
    assert llm.duplicate_batch_calls == [("프로세스 스케줄링", 1)]
    dedupe_files = list((store.node_dir(root.node_id) / "dedupe").glob("*.txt"))
    assert len(dedupe_files) == 1
    raw_batch = json.loads(dedupe_files[0].read_text(encoding="utf-8"))
    assert raw_batch["decisions"][0]["relation"] == "same"


def test_recorded_alias_is_reused_by_exact_identity_index(config_factory) -> None:
    config = config_factory(web_enabled=False, allow_ungrounded=True)
    store = WorkStore.open(config)
    root = store.state.nodes[store.state.root_id]
    existing = ConceptNode(
        node_id="central-processing-unit",
        name="중앙 처리 장치",
        normalized_name=normalize_name("중앙 처리 장치"),
        seed_definition="명령어를 실행하는 컴퓨터의 핵심 처리 장치",
        depth=1,
        primary_path=["운영체제", "중앙 처리 장치"],
        aliases=["CPU"],
        parent_ids=[root.node_id],
        status=NodeStatus.COMPLETE,
    )
    store.state.nodes[existing.node_id] = existing
    llm = MockLLMProvider()
    orchestrator = EagerOrchestrator(config, llm, None)
    orchestrator.store = store

    resolved = orchestrator._resolve_child(root, ChildProposal("CPU", "약어가 다시 제안됨"))

    assert resolved is existing
    assert len(store.state.nodes) == 2
    assert llm.duplicate_batch_calls == []


def test_duplicate_resolution_does_not_link_a_descendant_back_to_an_ancestor(config_factory) -> None:
    config = config_factory(web_enabled=False, allow_ungrounded=True)
    store = WorkStore.open(config)
    root = store.state.nodes[store.state.root_id]
    child = ConceptNode(
        node_id="child",
        name="프로세스 관리",
        normalized_name=normalize_name("프로세스 관리"),
        seed_definition="운영체제의 하위개념",
        depth=1,
        primary_path=["운영체제", "프로세스 관리"],
        parent_ids=[root.node_id],
        status=NodeStatus.COMPLETE,
    )
    root.child_ids.append(child.node_id)
    store.state.nodes[child.node_id] = child
    orchestrator = EagerOrchestrator(config, MockLLMProvider(), None)
    orchestrator.store = store

    resolved = orchestrator._resolve_child(child, ChildProposal("운영체제", "잘못 제안된 상위개념"))

    assert resolved is None
    assert root.node_id not in child.child_ids
