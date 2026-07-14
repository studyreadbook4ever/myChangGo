from __future__ import annotations

import pytest

from llm_orchestrator.cli import _config_from_args, _make_search, build_parser, main
from llm_orchestrator.config import BuildConfig
from llm_orchestrator.providers import DDGSSearchProvider


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
