from __future__ import annotations

import json

import httpx
import pytest

from llm_orchestrator.identity import normalize_name
from llm_orchestrator.models import ConceptNode
from llm_orchestrator.prompts import GenerationContext
from llm_orchestrator.providers.llm import LLMResponseError, OpenAICompatibleProvider


class FakeResponse:
    def __init__(self, content: str) -> None:
        self.content = content

    def raise_for_status(self) -> None:
        return None

    def json(self):
        return {"choices": [{"message": {"content": self.content}}]}


class FakeClient:
    def __init__(self, content: str) -> None:
        self.content = content
        self.post_calls = 0
        self.closed = False

    def post(self, *args, **kwargs):
        self.post_calls += 1
        return FakeResponse(self.content)

    def close(self) -> None:
        self.closed = True


def _context() -> GenerationContext:
    node = ConceptNode(
        node_id="root",
        name="운영체제",
        normalized_name=normalize_name("운영체제"),
        seed_definition="",
        depth=0,
        primary_path=["운영체제"],
    )
    return GenerationContext(node, "운영체제", 1, 4, 2_000, 5_000, 100, [])


def _dedupe_candidates() -> list[ConceptNode]:
    return [
        ConceptNode(
            node_id="cpu",
            name="중앙 처리 장치",
            normalized_name=normalize_name("중앙 처리 장치"),
            seed_definition="명령어를 실행하는 처리 장치",
            depth=1,
            primary_path=["컴퓨터", "중앙 처리 장치"],
        ),
        ConceptNode(
            node_id="scheduler",
            name="프로세스 스케줄러",
            normalized_name=normalize_name("프로세스 스케줄러"),
            seed_definition="실행 순서를 정하는 운영체제 구성 요소",
            depth=1,
            primary_path=["운영체제", "프로세스 스케줄러"],
        ),
    ]


def test_openai_compatible_provider_parses_full_generation_object() -> None:
    payload = {
        "name": "운영체제",
        "summary": "운영체제를 설명합니다.",
        "body_markdown": "## 개요\n\n설명\n\n## 원리\n\n설명",
        "decomposition_basis": "기능",
        "children": [
            {"name": "프로세스 관리", "definition": "프로세스를 관리합니다."},
            {"name": "메모리 관리", "definition": "메모리를 관리합니다."},
        ],
    }

    client = FakeClient(json.dumps(payload, ensure_ascii=False))
    provider = OpenAICompatibleProvider("http://localhost:1234/v1", "cheap-model", client=client)

    draft, result = provider.generate_node(_context())

    assert result.payload == payload
    assert [child.name for child in draft.children] == ["프로세스 관리", "메모리 관리"]


def test_openai_compatible_provider_exposes_malformed_raw_text(monkeypatch) -> None:
    malformed = "JSON 대신 반환된 설명문"
    provider = OpenAICompatibleProvider(
        "http://localhost:1234/v1",
        "cheap-model",
        client=FakeClient(malformed),
    )

    with pytest.raises(LLMResponseError) as caught:
        provider.generate_node(_context())

    assert caught.value.raw_text == malformed


def test_openai_compatible_provider_reuses_and_closes_owned_client(monkeypatch) -> None:
    payload = {
        "name": "운영체제",
        "summary": "운영체제를 설명합니다.",
        "body_markdown": "## 개요\n\n운영체제 설명\n\n## 원리\n\n설명",
        "children": [],
    }
    client = FakeClient(json.dumps(payload, ensure_ascii=False))
    constructions: list[dict] = []

    def make_client(**kwargs):
        constructions.append(kwargs)
        return client

    monkeypatch.setattr(httpx, "Client", make_client)
    provider = OpenAICompatibleProvider("http://localhost:1234/v1", "cheap-model", timeout=17.0)

    provider.generate_node(_context())
    provider.generate_node(_context())
    provider.close()

    assert constructions == [{"timeout": 17.0, "follow_redirects": True}]
    assert client.post_calls == 2
    assert client.closed is True


def test_duplicate_batch_maps_every_existing_id_from_the_outer_object() -> None:
    payload = {
        "candidate_name": "CPU",
        "decisions": [
            {
                "existing_id": "cpu",
                "relation": "same",
                "confidence": 0.98,
                "reason": "통용 약어",
                "canonical_name": "중앙 처리 장치",
            },
            {
                "existing_id": "scheduler",
                "relation": "distinct",
                "confidence": 0.99,
                "reason": "다른 개념",
                "canonical_name": "CPU",
            },
        ],
    }
    provider = OpenAICompatibleProvider(
        "http://localhost:1234/v1",
        "cheap-model",
        client=FakeClient(json.dumps(payload, ensure_ascii=False)),
    )

    decisions, result = provider.judge_duplicates(
        _dedupe_candidates(),
        "CPU",
        "명령어를 실행하는 장치의 약어",
        ["컴퓨터"],
    )

    assert result.payload == payload
    assert decisions["cpu"].relation.value == "same"
    assert decisions["scheduler"].relation.value == "distinct"


@pytest.mark.parametrize(
    "decisions",
    [
        [
            {"existing_id": "cpu", "relation": "same", "confidence": 0.9},
        ],
        [
            {"existing_id": "cpu", "relation": "same", "confidence": 0.9},
            {"existing_id": "cpu", "relation": "distinct", "confidence": 0.9},
        ],
        [
            {"existing_id": "cpu", "relation": "same", "confidence": 0.9},
            {"existing_id": "invented", "relation": "distinct", "confidence": 0.9},
        ],
    ],
)
def test_duplicate_batch_fails_closed_for_missing_duplicate_or_unknown_ids(decisions) -> None:
    payload = {"candidate_name": "CPU", "decisions": decisions}
    provider = OpenAICompatibleProvider(
        "http://localhost:1234/v1",
        "cheap-model",
        client=FakeClient(json.dumps(payload, ensure_ascii=False)),
    )

    with pytest.raises(LLMResponseError, match="batch"):
        provider.judge_duplicates(_dedupe_candidates(), "CPU", "후보 정의", ["컴퓨터"])
