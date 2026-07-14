from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat()


class NodeStatus(StrEnum):
    STUB = "stub"
    GENERATING = "generating"
    COMPLETE = "complete"
    FAILED = "failed"


class DuplicateRelation(StrEnum):
    SAME = "same"
    BROADER = "broader"
    NARROWER = "narrower"
    RELATED = "related"
    DISTINCT = "distinct"
    UNCERTAIN = "uncertain"


@dataclass(slots=True)
class Source:
    source_id: str
    title: str
    url: str
    snippet: str = ""
    content: str = ""
    public_url_validated: bool = False
    retrieved_at: str = field(default_factory=utc_now)

    def prompt_text(self, max_chars: int = 6_000) -> str:
        evidence = self.content.strip() or self.snippet.strip()
        return f"[{self.source_id}] {self.title}\nURL: {self.url}\n근거 본문:\n{evidence[:max_chars]}"

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> Source:
        return cls(**value)


@dataclass(slots=True)
class ChildProposal:
    name: str
    definition: str

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> ChildProposal:
        return cls(name=str(value.get("name", "")).strip(), definition=str(value.get("definition", "")).strip())


@dataclass(slots=True)
class NodeDraft:
    name: str
    summary: str
    body_markdown: str
    decomposition_basis: str = ""
    children: list[ChildProposal] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> NodeDraft:
        children = [ChildProposal.from_dict(item) for item in value.get("children", []) if isinstance(item, dict)]
        return cls(
            name=str(value.get("name", "")).strip(),
            summary=str(value.get("summary", "")).strip(),
            body_markdown=str(value.get("body_markdown", "")).strip(),
            decomposition_basis=str(value.get("decomposition_basis", "")).strip(),
            children=children,
        )


@dataclass(slots=True)
class DuplicateDecision:
    relation: DuplicateRelation
    confidence: float
    reason: str = ""
    canonical_name: str = ""

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> DuplicateDecision:
        raw_relation = str(value.get("relation", "uncertain")).strip().lower()
        try:
            relation = DuplicateRelation(raw_relation)
        except ValueError:
            relation = DuplicateRelation.UNCERTAIN
        try:
            confidence = min(1.0, max(0.0, float(value.get("confidence", 0.0))))
        except (TypeError, ValueError):
            confidence = 0.0
        return cls(
            relation=relation,
            confidence=confidence,
            reason=str(value.get("reason", "")).strip(),
            canonical_name=str(value.get("canonical_name", "")).strip(),
        )


@dataclass(slots=True)
class ReviewResult:
    approved: bool
    issues: list[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> ReviewResult:
        raw_approved = value.get("approved", False)
        approved = (
            raw_approved
            if isinstance(raw_approved, bool)
            else str(raw_approved).strip().lower() in {"true", "yes", "1", "승인"}
        )
        return cls(
            approved=approved,
            issues=[str(item).strip() for item in value.get("issues", []) if str(item).strip()],
        )


@dataclass(slots=True)
class LLMResult:
    payload: dict[str, Any]
    raw_text: str


@dataclass(slots=True)
class ConceptNode:
    node_id: str
    name: str
    normalized_name: str
    seed_definition: str
    depth: int
    primary_path: list[str]
    sequence: int = 0
    status: NodeStatus = NodeStatus.STUB
    summary: str = ""
    body_markdown: str = ""
    decomposition_basis: str = ""
    parent_ids: list[str] = field(default_factory=list)
    child_ids: list[str] = field(default_factory=list)
    aliases: list[str] = field(default_factory=list)
    sources: list[Source] = field(default_factory=list)
    used_source_ids: list[str] = field(default_factory=list)
    failure_reason: str = ""
    created_at: str = field(default_factory=utc_now)
    completed_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        # 긴 본문·근거는 nodes/<id>/draft.json과 sources.json에만 둔다.
        # 중앙 state.json은 재귀 그래프와 재개 상태만 유지해 Eager 확장 시
        # 매 checkpoint마다 수백 MB를 다시 쓰지 않도록 한다.
        return {
            "node_id": self.node_id,
            "name": self.name,
            "normalized_name": self.normalized_name,
            "seed_definition": self.seed_definition,
            "depth": self.depth,
            "primary_path": self.primary_path,
            "sequence": self.sequence,
            "status": self.status.value,
            "parent_ids": self.parent_ids,
            "child_ids": self.child_ids,
            "aliases": self.aliases,
            "used_source_ids": self.used_source_ids,
            "failure_reason": self.failure_reason,
            "created_at": self.created_at,
            "completed_at": self.completed_at,
        }

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> ConceptNode:
        copied = dict(value)
        copied["status"] = NodeStatus(copied.get("status", NodeStatus.STUB))
        copied["sources"] = [Source.from_dict(item) for item in copied.get("sources", [])]
        return cls(**copied)


@dataclass(slots=True)
class RunState:
    schema_version: int
    run_id: str
    config_hash: str
    root_id: str
    nodes: dict[str, ConceptNode]
    next_sequence: int = 1
    created_at: str = field(default_factory=utc_now)
    updated_at: str = field(default_factory=utc_now)
    finished: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "run_id": self.run_id,
            "config_hash": self.config_hash,
            "root_id": self.root_id,
            "nodes": {node_id: node.to_dict() for node_id, node in self.nodes.items()},
            "next_sequence": self.next_sequence,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "finished": self.finished,
        }

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> RunState:
        nodes = {node_id: ConceptNode.from_dict(node) for node_id, node in value.get("nodes", {}).items()}
        return cls(
            schema_version=int(value["schema_version"]),
            run_id=str(value["run_id"]),
            config_hash=str(value["config_hash"]),
            root_id=str(value["root_id"]),
            nodes=nodes,
            next_sequence=int(value.get("next_sequence", 1)),
            created_at=str(value.get("created_at", utc_now())),
            updated_at=str(value.get("updated_at", utc_now())),
            finished=bool(value.get("finished", False)),
        )
