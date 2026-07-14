from __future__ import annotations

import json

import pytest

from llm_orchestrator.cli import _config_from_args, _make_search, build_parser, main
from llm_orchestrator.config import BuildConfig
from llm_orchestrator.providers import BraveSearchProvider, DDGSSearchProvider
from llm_orchestrator.workspace import WorkStore


@pytest.mark.parametrize(
    ("depth", "expected"),
    [(0, 1), (1, 5), (2, 21), (3, 85), (4, 341), (5, 1_365)],
)
def test_theoretical_four_way_tree_counts(depth: int, expected: int) -> None:
    config = BuildConfig(concept="운영체제", depth=depth)

    assert config.theoretical_nodes == expected


def test_cli_defaults_match_product_contract() -> None:
    args = build_parser().parse_args(["운영체제"])
    config = _config_from_args(args)

    assert config.concept == "운영체제"
    assert config.depth == 3
    assert config.max_children == 4
    assert config.theoretical_nodes == 85
    assert config.output_format == "both"
    assert config.target_chars == 2_000
    assert config.max_chars == 5_000
    assert config.web_enabled is True


def test_default_ddgs_search_receives_the_cli_timeout(config_factory) -> None:
    provider = _make_search(config_factory(search_provider="ddgs", timeout=12.25))

    assert isinstance(provider, DDGSSearchProvider)
    assert provider.timeout == 12.25


def test_auto_search_provider_is_part_of_the_resume_fingerprint(config_factory, monkeypatch) -> None:
    config = config_factory(search_provider="auto")
    monkeypatch.delenv(config.brave_api_key_env, raising=False)

    ddgs_hash = config.config_hash
    assert config.effective_search_provider == "ddgs"
    assert isinstance(_make_search(config), DDGSSearchProvider)
    store = WorkStore.open(config)
    metadata = json.loads((store.root / "run.json").read_text(encoding="utf-8"))
    assert metadata["config"]["effective_search_provider"] == "ddgs"

    monkeypatch.setenv(config.brave_api_key_env, "test-key")
    brave_config = config_factory(search_provider="auto")
    brave_hash = brave_config.config_hash
    brave = _make_search(brave_config)
    assert config.effective_search_provider == "ddgs"
    assert brave_config.effective_search_provider == "brave"
    assert isinstance(brave, BraveSearchProvider)
    brave.close()

    assert brave_hash != ddgs_hash
    with pytest.raises(FileNotFoundError, match="재개할 작업 상태"):
        WorkStore.open(config_factory(search_provider="auto", resume=True))


def test_cli_requires_root_concept() -> None:
    with pytest.raises(SystemExit) as caught:
        build_parser().parse_args([])

    assert caught.value.code == 2


def test_help_exposes_core_and_safety_flags(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as caught:
        build_parser().parse_args(["--help"])

    assert caught.value.code == 0
    help_text = capsys.readouterr().out
    for flag in (
        "--depth",
        "--format",
        "--css",
        "--site-url",
        "--target-chars",
        "--max-chars",
        "--provider",
        "--search-provider",
        "--no-web",
        "--allow-ungrounded",
        "--resume",
        "--dry-run",
        "--force",
    ):
        assert flag in help_text


def test_dry_run_never_constructs_or_calls_network(capsys: pytest.CaptureFixture[str]) -> None:
    result = main(["운영체제", "--depth", "3", "--dry-run"])

    captured = capsys.readouterr()
    assert result == 0
    assert "이론상 최대 노드: 85" in captured.out
    assert "웹 검색: 기본 활성화" in captured.out


def test_disabling_default_web_requires_explicit_ungrounded_opt_in(config_factory) -> None:
    config = config_factory(web_enabled=False, allow_ungrounded=False)

    with pytest.raises(ValueError, match="--allow-ungrounded"):
        config.validate()


def test_node_safety_limit_can_only_be_overridden_explicitly(config_factory) -> None:
    config = config_factory(depth=5, max_nodes=100, force=False)

    with pytest.raises(ValueError, match="--force"):
        config.validate()

    config_factory(depth=5, max_nodes=100, force=True).validate()


def test_output_and_work_directories_must_not_overlap(config_factory, tmp_path) -> None:
    config = config_factory(output_dir=tmp_path / "shared", work_dir=tmp_path / "shared/work")

    with pytest.raises(ValueError, match="서로 같거나"):
        config.validate()


def test_service_urls_reject_embedded_credentials(config_factory) -> None:
    llm_config = config_factory(
        llm_provider="openai-compatible",
        model="local-model",
        base_url="https://alice:LLM-SECRET@llm.example.test/v1",
    )
    search_config = config_factory(
        search_provider="searxng",
        searxng_url="https://bob:SEARCH-SECRET@search.example.test",
    )

    with pytest.raises(ValueError, match="--base-url.*자격증명"):
        llm_config.validate()
    with pytest.raises(ValueError, match="--searxng-url.*자격증명"):
        search_config.validate()


def test_workspace_metadata_redacts_url_credentials_defensively(config_factory) -> None:
    config = config_factory(
        base_url="https://alice:LLM-SECRET@llm.example.test/v1",
        searxng_url="https://bob:SEARCH-SECRET@search.example.test",
    )

    store = WorkStore.open(config)
    metadata = json.loads((store.root / "run.json").read_text(encoding="utf-8"))
    serialized = json.dumps(metadata, ensure_ascii=False)

    assert "LLM-SECRET" not in serialized
    assert "SEARCH-SECRET" not in serialized
    assert metadata["config"]["base_url"] == "<credentials-redacted>"
    assert metadata["config"]["searxng_url"] == "<credentials-redacted>"


def test_unused_url_query_secrets_are_rejected_and_redacted(config_factory, monkeypatch) -> None:
    monkeypatch.setenv("BRAVE_SEARCH_API_KEY", "provider-key")
    config = config_factory(
        llm_provider="mock",
        search_provider="auto",
        base_url="https://unused.example.test/v1?token=LLM-QUERY-SECRET",
        searxng_url="https://unused-search.example.test/?token=SEARCH-QUERY-SECRET",
    )

    with pytest.raises(ValueError) as caught:
        config.validate()
    assert "--base-url에는 query string" in str(caught.value)
    assert "--searxng-url에는 query string" in str(caught.value)

    store = WorkStore.open(config)
    serialized = (store.root / "run.json").read_text(encoding="utf-8")
    assert "LLM-QUERY-SECRET" not in serialized
    assert "SEARCH-QUERY-SECRET" not in serialized
    assert serialized.count("<query-fragment-redacted>") == 2
