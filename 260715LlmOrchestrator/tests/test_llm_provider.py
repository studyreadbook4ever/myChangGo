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


def test_openai_compatible_provider_parses_full_generation_object(monkeypatch) -> None:
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

    def fake_post(*args, **kwargs):
        return FakeResponse(json.dumps(payload, ensure_ascii=False))

    monkeypatch.setattr(httpx, "post", fake_post)
    provider = OpenAICompatibleProvider("http://localhost:1234/v1", "cheap-model")

    draft, result = provider.generate_node(_context())

    assert result.payload == payload
    assert [child.name for child in draft.children] == ["프로세스 관리", "메모리 관리"]


def test_openai_compatible_provider_exposes_malformed_raw_text(monkeypatch) -> None:
    malformed = "JSON 대신 반환된 설명문"
    monkeypatch.setattr(httpx, "post", lambda *args, **kwargs: FakeResponse(malformed))
    provider = OpenAICompatibleProvider("http://localhost:1234/v1", "cheap-model")

    with pytest.raises(LLMResponseError) as caught:
        provider.generate_node(_context())

    assert caught.value.raw_text == malformed
