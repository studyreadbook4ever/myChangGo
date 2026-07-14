from __future__ import annotations

from pathlib import Path
from urllib.parse import unquote, urlparse

import pytest
from conftest import OfflineFetcher

from llm_orchestrator.models import NodeStatus, Source
from llm_orchestrator.orchestrator import BuildFailure, EagerOrchestrator
from llm_orchestrator.providers import MockLLMProvider, MockSearchProvider
from llm_orchestrator.render import SiteRenderer


def _run(config):
    llm = MockLLMProvider()
    search = MockSearchProvider() if config.web_enabled else None
    fetcher = OfflineFetcher()
    orchestrator = EagerOrchestrator(config, llm, search, fetcher=fetcher)
    output = orchestrator.run()
    assert orchestrator.store is not None
    return output, orchestrator, llm, search, fetcher


def test_default_depth_shape_is_fully_eager_with_mock_providers(config_factory) -> None:
    config = config_factory(depth=3, output_format="md")

    output, orchestrator, llm, search, fetcher = _run(config)
    nodes = list(orchestrator.store.state.nodes.values())

    assert len(nodes) == 85
    assert all(node.status is NodeStatus.COMPLETE for node in nodes)
    assert len(llm.generation_calls) == 85
    assert search is not None and len(search.queries) == 85
    assert fetcher.calls == []
    assert len(list((output / "markdown").glob("*.md"))) == 85
    assert not (output / "index.html").exists()


@pytest.fixture
def rendered_depth_one(config_factory):
    config = config_factory(
        depth=1,
        output_format="both",
        site_url="https://docs.example.test/knowledge/",
    )
    return _run(config)


def test_internal_node_has_child_links_but_leaf_html_has_no_link_region(rendered_depth_one) -> None:
    output, orchestrator, *_ = rendered_depth_one
    root_html = (output / "index.html").read_text(encoding="utf-8")
    leaf_paths = sorted((output / "pages").glob("*.html"))

    assert len(leaf_paths) == 4
    assert root_html.count('class="concept-child-link"') == 4
    assert 'class="concept-children"' in root_html
    for leaf_path in leaf_paths:
        leaf_html = leaf_path.read_text(encoding="utf-8")
        assert 'class="concept-child-link"' not in leaf_html
        assert 'class="concept-children"' not in leaf_html

    root = orchestrator.store.state.nodes[orchestrator.store.state.root_id]
    assert len(root.child_ids) == 4


def test_sitemap_contains_each_canonical_html_document_once_in_breadth_first_order(rendered_depth_one) -> None:
    output, *_ = rendered_depth_one
    lines = (output / "sitemap.txt").read_text(encoding="utf-8").splitlines()

    assert len(lines) == 5
    assert len(lines) == len(set(lines))
    assert lines[0] == "https://docs.example.test/knowledge/index.html"
    assert all(line.startswith("https://docs.example.test/knowledge/") for line in lines)
    assert all(not any("가" <= character <= "힣" for character in line) for line in lines)
    for line in lines:
        relative = unquote(urlparse(line).path).removeprefix("/knowledge/")
        assert (output / relative).is_file()


def test_grounded_citations_link_to_the_rendered_reference(rendered_depth_one) -> None:
    output, *_ = rendered_depth_one
    html = (output / "index.html").read_text(encoding="utf-8")
    markdown = (output / "markdown/index.md").read_text(encoding="utf-8")

    assert 'href="#ref-S1"' in html
    assert '<li id="ref-S1">' in html
    assert 'href="https://example.com/demo-source"' in html
    assert "[S1]" in markdown
    assert "데모 근거](https://example.com/demo-source)" in markdown
    assert "https://example.com/demo-source" in markdown


def test_html_citation_linking_does_not_modify_fenced_code(rendered_depth_one) -> None:
    _, orchestrator, *_ = rendered_depth_one
    root_id = orchestrator.store.state.root_id
    root = orchestrator.store.state.nodes[root_id]
    root.body_markdown = "## 개요\n\n운영체제 설명 [S1]\n\n## 예제\n\n```text\n[S1]\n```"
    root.used_source_ids = ["S1"]

    html = SiteRenderer(orchestrator.config)._render_html(root, [], Path("index.html"), root_id)

    assert html.count('href="#ref-S1"') == 1
    assert "[S1]\n</code>" in html
    assert "[[S1]](#ref-S1)" not in html


def test_markdown_only_output_is_standalone_markdown_without_site_wrappers(config_factory) -> None:
    config = config_factory(
        depth=1,
        output_format="md",
        web_enabled=False,
        allow_ungrounded=True,
    )

    output, *_ = _run(config)
    root_markdown = (output / "markdown/index.md").read_text(encoding="utf-8")

    assert root_markdown.startswith("# 운영체제\n")
    assert not root_markdown.startswith("---")
    assert "## 하위개념" in root_markdown
    assert "<html" not in root_markdown.casefold()
    assert "class=" not in root_markdown
    assert not (output / "index.html").exists()
    assert not (output / "assets").exists()
    assert not (output / "sitemap.txt").exists()


def test_html_only_output_copies_user_css_without_markdown(config_factory, tmp_path: Path) -> None:
    css = tmp_path / "theme.css"
    css.write_bytes(b".concept-page { color: rebeccapurple; }\n")
    config = config_factory(
        depth=0,
        output_format="html",
        css_file=css,
        web_enabled=False,
        allow_ungrounded=True,
    )

    output, *_ = _run(config)

    assert (output / "assets/site.css").read_bytes() == css.read_bytes()
    assert (output / "index.html").is_file()
    assert (output / "sitemap.txt").is_file()
    assert not (output / "markdown").exists()


class EmptyEvidenceSearch:
    def preflight(self) -> None:
        return None

    def search(self, query: str, limit: int) -> list[Source]:
        return [
            Source(
                "S1",
                "제목만 있는 결과",
                "https://example.test/empty",
                public_url_validated=True,
            )
        ]


class HostileTitleSearch:
    def preflight(self) -> None:
        return None

    def search(self, query: str, limit: int) -> list[Source]:
        return [
            Source(
                "S1",
                "<script>alert('source')</script>",
                "https://example.test/source",
                content="운영체제를 설명하는 테스트 근거입니다.",
                public_url_validated=True,
            )
        ]


def test_empty_search_result_is_not_accepted_as_grounding(config_factory) -> None:
    config = config_factory(depth=0, output_format="md")
    orchestrator = EagerOrchestrator(
        config,
        MockLLMProvider(),
        EmptyEvidenceSearch(),
        fetcher=OfflineFetcher(),
    )

    with pytest.raises(BuildFailure, match="웹 근거를 찾지 못했습니다"):
        orchestrator.run()


def test_untrusted_source_title_is_escaped_in_pure_markdown(config_factory) -> None:
    config = config_factory(depth=0, output_format="md")
    orchestrator = EagerOrchestrator(
        config,
        MockLLMProvider(),
        HostileTitleSearch(),
        fetcher=OfflineFetcher(),
    )

    output = orchestrator.run()
    markdown = (output / "markdown/index.md").read_text(encoding="utf-8")

    assert "<script>" not in markdown
    assert "&lt;script&gt;" in markdown
