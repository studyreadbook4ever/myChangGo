from __future__ import annotations

import json
import os
import tempfile
from dataclasses import asdict
from hashlib import sha256
from pathlib import Path
from typing import Any

from .config import BuildConfig
from .identity import normalize_name, slugify, stable_node_id
from .models import ConceptNode, NodeDraft, NodeStatus, RunState, Source, utc_now
from .prompts import PROMPT_VERSION
from .validation import citation_ids

SCHEMA_VERSION = 1


def atomic_write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temp_path = Path(temp_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
    except BaseException:
        temp_path.unlink(missing_ok=True)
        raise


def atomic_write_text(path: Path, text: str) -> None:
    atomic_write_bytes(path, text.encode("utf-8"))


def atomic_write_json(path: Path, value: Any) -> None:
    text = json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    atomic_write_text(path, text)


class WorkStore:
    def __init__(self, config: BuildConfig, state: RunState, root: Path) -> None:
        self.config = config
        self.state = state
        self.root = root

    @classmethod
    def open(cls, config: BuildConfig) -> WorkStore:
        run_id = f"{slugify(config.concept)}-{config.config_hash}"
        root = config.work_dir / run_id
        state_path = root / "state.json"
        if state_path.exists():
            if not config.resume:
                raise FileExistsError(
                    f"동일 설정의 작업 폴더가 이미 있습니다: {root}\n"
                    "이어 하려면 --resume을 사용하거나 다른 --work-dir을 지정하세요."
                )
            value = json.loads(state_path.read_text(encoding="utf-8"))
            if int(value.get("schema_version", -1)) != SCHEMA_VERSION:
                raise ValueError("저장된 작업 상태의 스키마 버전이 현재 프로그램과 호환되지 않습니다.")
            state = RunState.from_dict(value)
            if state.config_hash != config.config_hash:
                raise ValueError("저장된 작업과 현재 핵심 설정이 달라 재개할 수 없습니다.")
            store = cls(config, state, root)
            store._hydrate_complete_nodes()
            for node in state.nodes.values():
                if node.status is NodeStatus.GENERATING:
                    node.status = NodeStatus.STUB
            store.save_state()
            store.record_event("run_resumed", {"run_id": run_id})
            return store
        if config.resume:
            raise FileNotFoundError(f"재개할 작업 상태를 찾을 수 없습니다: {root}")

        root.mkdir(parents=True, exist_ok=False)
        root_id = stable_node_id(config.concept, "", 0)
        root_node = ConceptNode(
            node_id=root_id,
            name=config.concept.strip(),
            normalized_name=normalize_name(config.concept),
            seed_definition="",
            depth=0,
            primary_path=[config.concept.strip()],
            sequence=0,
        )
        state = RunState(
            schema_version=SCHEMA_VERSION,
            run_id=run_id,
            config_hash=config.config_hash,
            root_id=root_id,
            nodes={root_id: root_node},
        )
        store = cls(config, state, root)
        atomic_write_json(
            root / "run.json",
            {
                "schema_version": SCHEMA_VERSION,
                "prompt_version": PROMPT_VERSION,
                "run_id": run_id,
                "config_hash": config.config_hash,
                "config": config.semantic_dict(),
                "created_at": state.created_at,
            },
        )
        store.save_state()
        store.record_event("run_created", {"run_id": run_id})
        return store

    @property
    def state_path(self) -> Path:
        return self.root / "state.json"

    def node_dir(self, node_id: str) -> Path:
        return self.root / "nodes" / node_id

    def _hydrate_complete_nodes(self) -> None:
        for node in self.state.nodes.values():
            if node.status is not NodeStatus.COMPLETE:
                continue
            draft = self.load_draft(node.node_id)
            if draft is None:
                raise ValueError(f"완성 노드의 draft.json이 없습니다: {node.node_id}")
            node.summary = draft.summary
            node.body_markdown = draft.body_markdown
            node.decomposition_basis = draft.decomposition_basis
            node.sources = self.load_sources(node.node_id)
            node.used_source_ids = citation_ids(draft.body_markdown)

    def save_state(self) -> None:
        self.state.updated_at = utc_now()
        atomic_write_json(self.state_path, self.state.to_dict())

    def record_event(self, event: str, data: dict[str, Any]) -> None:
        path = self.root / "events.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps({"at": utc_now(), "event": event, **data}, ensure_ascii=False, sort_keys=True) + "\n"
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
        try:
            os.write(descriptor, line.encode("utf-8"))
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def save_prompt(self, node_id: str, kind: str, attempt: int, text: str) -> None:
        atomic_write_text(self.node_dir(node_id) / "prompts" / f"{kind}-{attempt:03d}.txt", text)

    def save_raw(self, node_id: str, kind: str, attempt: int, text: str) -> Path:
        path = self.node_dir(node_id) / "raw" / f"{kind}-{attempt:03d}.txt"
        atomic_write_text(path, text)
        self.record_event("raw_saved", {"node_id": node_id, "kind": kind, "attempt": attempt, "path": str(path)})
        return path

    def latest_raw(self, node_id: str, kind: str) -> str | None:
        paths = sorted((self.node_dir(node_id) / "raw").glob(f"{kind}-*.txt"))
        if not paths:
            return None
        return paths[-1].read_text(encoding="utf-8")

    def next_attempt(self, node_id: str, kind: str) -> int:
        paths = [
            *(self.node_dir(node_id) / "raw").glob(f"{kind}-*.txt"),
            *(self.node_dir(node_id) / "prompts").glob(f"{kind}-*.txt"),
        ]
        attempts: list[int] = []
        for path in paths:
            try:
                attempts.append(int(path.stem.rsplit("-", 1)[1]))
            except (IndexError, ValueError):
                continue
        return max(attempts, default=0) + 1

    def save_sources(self, node_id: str, sources: list[Source]) -> None:
        atomic_write_json(self.node_dir(node_id) / "sources.json", [asdict(source) for source in sources])

    def load_sources(self, node_id: str) -> list[Source]:
        path = self.node_dir(node_id) / "sources.json"
        if not path.exists():
            return []
        return [Source.from_dict(item) for item in json.loads(path.read_text(encoding="utf-8"))]

    def save_draft(self, node_id: str, draft: NodeDraft) -> None:
        atomic_write_json(self.node_dir(node_id) / "draft.json", draft.to_dict())

    def load_draft(self, node_id: str) -> NodeDraft | None:
        path = self.node_dir(node_id) / "draft.json"
        if not path.exists():
            return None
        return NodeDraft.from_dict(json.loads(path.read_text(encoding="utf-8")))

    def save_duplicate_raw(self, parent_id: str, candidate_name: str, existing_id: str, raw_text: str) -> None:
        identity_hash = sha256(normalize_name(candidate_name).encode("utf-8")).hexdigest()[:8]
        key = f"{slugify(candidate_name)}-{identity_hash}--{existing_id[:8]}"
        directory = self.node_dir(parent_id) / "dedupe"
        attempts: list[int] = []
        for existing_path in directory.glob(f"{key}-*.txt"):
            try:
                attempts.append(int(existing_path.stem.rsplit("-", 1)[1]))
            except (IndexError, ValueError):
                continue
        attempt = max(attempts, default=0) + 1
        path = directory / f"{key}-{attempt:03d}.txt"
        atomic_write_text(path, raw_text)
