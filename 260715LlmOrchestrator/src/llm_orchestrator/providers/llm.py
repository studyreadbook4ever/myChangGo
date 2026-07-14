from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import urljoin

import httpx

from ..identity import normalize_name
from ..models import (
    ChildProposal,
    ConceptNode,
    DuplicateDecision,
    DuplicateRelation,
    LLMResult,
    NodeDraft,
    ReviewResult,
)
from ..prompts import SYSTEM_PROMPT, GenerationContext, duplicate_prompt, generation_prompt, review_prompt


class LLMResponseError(ValueError):
    """모델이 텍스트를 반환했지만 구조화 응답으로 해석할 수 없을 때의 오류."""

    def __init__(self, message: str, raw_text: str) -> None:
        super().__init__(message)
        self.raw_text = raw_text


def extract_json(text: str) -> dict[str, Any]:
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = re.sub(r"^```(?:json)?\s*", "", stripped, flags=re.IGNORECASE)
        stripped = re.sub(r"\s*```$", "", stripped)
    decoder = json.JSONDecoder()
    candidates: list[tuple[int, int, dict[str, Any]]] = []
    schema_keys = (
        {"name", "summary", "body_markdown"},
        {"relation", "confidence"},
        {"approved", "issues"},
    )
    for index, char in enumerate(stripped):
        if char != "{":
            continue
        try:
            value, end = decoder.raw_decode(stripped[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            key_score = max(len(set(value) & expected) for expected in schema_keys)
            candidates.append((key_score, end, value))
    if not candidates:
        raise ValueError("LLM 응답에서 JSON 객체를 찾을 수 없습니다.")
    # 스키마 핵심 키를 가장 많이 가지며 디코딩 범위가 큰 객체를 고른다.
    # 그러면 children 안의 작은 객체나 앞뒤의 짧은 예시 JSON을 피할 수 있다.
    return max(candidates, key=lambda item: (item[0], item[1]))[2]


@dataclass(slots=True)
class OpenAICompatibleProvider:
    base_url: str
    model: str
    api_key_env: str = "LLM_API_KEY"
    timeout: float = 60.0
    temperature: float = 0.2
    max_tokens: int = 4_096

    def _complete(self, system: str, user: str) -> LLMResult:
        endpoint = urljoin(self.base_url.rstrip("/") + "/", "chat/completions")
        api_key = os.environ.get(self.api_key_env, "")
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
        }
        response = httpx.post(endpoint, headers=headers, json=payload, timeout=self.timeout, follow_redirects=True)
        response.raise_for_status()
        data = response.json()
        try:
            choice = data["choices"][0]
            message = choice.get("message", {})
            content = message.get("content") or choice.get("text")
        except (KeyError, IndexError, TypeError) as exc:
            raise ValueError("OpenAI 호환 응답에 choices[0]가 없습니다.") from exc
        if content is None:
            raise ValueError("OpenAI 호환 응답에 message.content 또는 text가 없습니다.")
        if isinstance(content, list):
            content = "".join(str(item.get("text", "")) if isinstance(item, dict) else str(item) for item in content)
        raw_text = str(content)
        try:
            parsed = extract_json(raw_text)
        except ValueError as exc:
            raise LLMResponseError(str(exc), raw_text) from exc
        return LLMResult(payload=parsed, raw_text=raw_text)

    def generate_node(self, context: GenerationContext) -> tuple[NodeDraft, LLMResult]:
        result = self._complete(SYSTEM_PROMPT, generation_prompt(context))
        try:
            draft = NodeDraft.from_dict(result.payload)
        except (TypeError, ValueError) as exc:
            raise LLMResponseError(f"생성 응답 스키마가 올바르지 않습니다: {exc}", result.raw_text) from exc
        return draft, result

    def judge_duplicate(
        self,
        existing: ConceptNode,
        candidate_name: str,
        candidate_definition: str,
        parent_path: list[str],
    ) -> tuple[DuplicateDecision, LLMResult]:
        result = self._complete(
            SYSTEM_PROMPT, duplicate_prompt(existing, candidate_name, candidate_definition, parent_path)
        )
        try:
            decision = DuplicateDecision.from_dict(result.payload)
        except (TypeError, ValueError) as exc:
            raise LLMResponseError(f"중복 판정 응답 스키마가 올바르지 않습니다: {exc}", result.raw_text) from exc
        return decision, result

    def review_node(self, draft: NodeDraft, context: GenerationContext) -> tuple[ReviewResult, LLMResult]:
        result = self._complete(SYSTEM_PROMPT, review_prompt(draft, context))
        try:
            review = ReviewResult.from_dict(result.payload)
        except (TypeError, ValueError) as exc:
            raise LLMResponseError(f"검수 응답 스키마가 올바르지 않습니다: {exc}", result.raw_text) from exc
        return review, result


class MockLLMProvider:
    """키 없이 파이프라인과 데모 출력을 확인하는 결정적 공급자."""

    def __init__(self) -> None:
        self.generation_calls: list[str] = []
        self.duplicate_calls: list[tuple[str, str]] = []
        self.review_calls: list[str] = []

    def generate_node(self, context: GenerationContext) -> tuple[NodeDraft, LLMResult]:
        self.generation_calls.append(context.node.name)
        citation = f" [{context.sources[0].source_id}]" if context.sources else ""
        children: list[ChildProposal] = []
        if not context.terminal:
            suffixes = ["핵심 원리", "구조와 구성", "동작 과정", "응용과 한계"]
            children = [
                ChildProposal(
                    name=f"{context.node.name}의 {suffix}",
                    definition=f"{context.node.name}을 이해하기 위한 {suffix} 하위개념입니다.",
                )
                for suffix in suffixes[: context.max_children]
            ]
        child_lines = "\n".join(f"- **{child.name}**: {child.definition}" for child in children)
        body = (
            f"## 개념과 중요성\n\n{context.node.name}은 상위 주제를 체계적으로 이해하기 위한 "
            f"핵심 개념입니다.{citation}\n\n"
            f"## 핵심 구조\n\n이 문서는 실제 LLM 연결 전에 전체 생성 흐름을 점검하는 데모 콘텐츠입니다.{citation}"
        )
        if child_lines:
            body += f"\n\n## 주요 하위개념\n\n{child_lines}"
        payload = {
            "name": context.node.name,
            "summary": f"{context.node.name}의 핵심 구조와 학습 순서를 간결하게 설명합니다.",
            "body_markdown": body,
            "decomposition_basis": "교육적 이해 순서" if children else "",
            "children": [{"name": child.name, "definition": child.definition} for child in children],
        }
        raw = json.dumps(payload, ensure_ascii=False)
        return NodeDraft.from_dict(payload), LLMResult(payload=payload, raw_text=raw)

    def judge_duplicate(
        self,
        existing: ConceptNode,
        candidate_name: str,
        candidate_definition: str,
        parent_path: list[str],
    ) -> tuple[DuplicateDecision, LLMResult]:
        self.duplicate_calls.append((existing.name, candidate_name))
        relation = (
            DuplicateRelation.SAME
            if existing.normalized_name == normalize_name(candidate_name)
            else DuplicateRelation.DISTINCT
        )
        payload = {
            "relation": relation.value,
            "confidence": 1.0,
            "reason": "데모 공급자의 결정적 판정",
            "canonical_name": existing.name if relation is DuplicateRelation.SAME else candidate_name,
        }
        return DuplicateDecision.from_dict(payload), LLMResult(
            payload=payload, raw_text=json.dumps(payload, ensure_ascii=False)
        )

    def review_node(self, draft: NodeDraft, context: GenerationContext) -> tuple[ReviewResult, LLMResult]:
        self.review_calls.append(draft.name)
        payload = {"approved": len(draft.body_markdown) <= context.max_chars, "issues": []}
        return ReviewResult.from_dict(payload), LLMResult(
            payload=payload, raw_text=json.dumps(payload, ensure_ascii=False)
        )
