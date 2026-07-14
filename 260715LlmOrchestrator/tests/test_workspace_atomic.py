from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import pytest

import llm_orchestrator.workspace as workspace
from llm_orchestrator.models import NodeStatus
from llm_orchestrator.orchestrator import EagerOrchestrator
from llm_orchestrator.providers import MockLLMProvider
from llm_orchestrator.providers.llm import LLMResponseError
from llm_orchestrator.workspace import WorkStore, atomic_write_text


def test_atomic_write_failure_keeps_previous_file_and_cleans_temporary_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = tmp_path / "state.json"
    target.write_text("old-state\n", encoding="utf-8")

    def fail_replace(source, destination) -> None:
        raise OSError("simulated replace failure")

    monkeypatch.setattr(workspace.os, "replace", fail_replace)

    with pytest.raises(OSError, match="simulated replace failure"):
        atomic_write_text(target, "new-state\n")

    assert target.read_text(encoding="utf-8") == "old-state\n"
    assert list(tmp_path.glob("*.tmp")) == []


def test_resume_preserves_raw_output_and_recovers_generating_state(config_factory) -> None:
    config = config_factory(web_enabled=False, allow_ungrounded=True)
    store = WorkStore.open(config)
    root = store.state.nodes[store.state.root_id]
    raw_text = '{"name":"운영체제","summary":"원자적으로 저장된 응답"}'

    raw_path = store.save_raw(root.node_id, "generation", 1, raw_text)
    root.status = NodeStatus.GENERATING
    store.save_state()

    resumed = WorkStore.open(replace(config, resume=True))

    assert raw_path.read_text(encoding="utf-8") == raw_text
    assert resumed.latest_raw(root.node_id, "generation") == raw_text
    assert resumed.state.nodes[root.node_id].status is NodeStatus.STUB
    state_payload = json.loads(resumed.state_path.read_text(encoding="utf-8"))
    assert state_payload["nodes"][root.node_id]["status"] == "stub"
    assert not list(resumed.root.rglob("*.tmp"))


class MalformedOnceLLM(MockLLMProvider):
    def __init__(self) -> None:
        super().__init__()
        self.failed = False

    def generate_node(self, context):
        if not self.failed:
            self.failed = True
            raise LLMResponseError("JSON 해석 실패", "이 응답은 JSON이 아닙니다")
        return super().generate_node(context)


def test_malformed_llm_output_is_preserved_before_retry(config_factory) -> None:
    config = config_factory(
        depth=0,
        web_enabled=False,
        allow_ungrounded=True,
        retries=1,
        output_format="md",
    )
    orchestrator = EagerOrchestrator(config, MalformedOnceLLM(), None)

    orchestrator.run()

    assert orchestrator.store is not None
    root_id = orchestrator.store.state.root_id
    node_dir = orchestrator.store.node_dir(root_id)
    assert (node_dir / "raw/generation-001.txt").read_text(encoding="utf-8") == "이 응답은 JSON이 아닙니다"
    assert (node_dir / "raw/generation-002.txt").is_file()
    assert (node_dir / "prompts/generation-001.txt").is_file()
    assert (node_dir / "prompts/generation-002.txt").is_file()


def test_state_is_compact_and_completed_content_is_hydrated_on_resume(config_factory) -> None:
    config = config_factory(
        depth=0,
        web_enabled=False,
        allow_ungrounded=True,
        output_format="md",
    )
    orchestrator = EagerOrchestrator(config, MockLLMProvider(), None)
    orchestrator.run()
    assert orchestrator.store is not None
    root_id = orchestrator.store.state.root_id
    payload = json.loads(orchestrator.store.state_path.read_text(encoding="utf-8"))

    assert "body_markdown" not in payload["nodes"][root_id]
    assert "summary" not in payload["nodes"][root_id]
    assert "sources" not in payload["nodes"][root_id]

    resumed = WorkStore.open(replace(config, resume=True))

    assert resumed.state.nodes[root_id].body_markdown
    assert resumed.state.nodes[root_id].summary


class InterruptingLLM(MockLLMProvider):
    def __init__(self) -> None:
        super().__init__()
        self.calls = 0

    def generate_node(self, context):
        self.calls += 1
        if self.calls == 2:
            raise KeyboardInterrupt
        return super().generate_node(context)


def test_keyboard_interrupt_is_not_converted_to_node_failure(config_factory) -> None:
    config = config_factory(depth=1, web_enabled=False, allow_ungrounded=True, output_format="md", jobs=1)
    llm = InterruptingLLM()
    orchestrator = EagerOrchestrator(config, llm, None)

    with pytest.raises(KeyboardInterrupt):
        orchestrator.run()

    assert orchestrator.store is not None
    saved = json.loads(orchestrator.store.state_path.read_text(encoding="utf-8"))
    assert saved["nodes"][saved["root_id"]]["status"] == "complete"
    assert sum(node["status"] == "generating" for node in saved["nodes"].values()) == 4
    assert llm.calls == 2
