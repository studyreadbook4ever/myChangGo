from __future__ import annotations

from typing import Protocol

from ..models import ConceptNode, DuplicateDecision, LLMResult, NodeDraft, ReviewResult, Source
from ..prompts import GenerationContext


class LLMProvider(Protocol):
    def generate_node(self, context: GenerationContext) -> tuple[NodeDraft, LLMResult]: ...

    def judge_duplicate(
        self,
        existing: ConceptNode,
        candidate_name: str,
        candidate_definition: str,
        parent_path: list[str],
    ) -> tuple[DuplicateDecision, LLMResult]: ...

    def review_node(self, draft: NodeDraft, context: GenerationContext) -> tuple[ReviewResult, LLMResult]: ...


class SearchProvider(Protocol):
    def search(self, query: str, limit: int) -> list[Source]: ...

    def preflight(self) -> None: ...
