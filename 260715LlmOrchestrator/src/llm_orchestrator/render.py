from __future__ import annotations

import html
import os
import re
import shutil
import uuid
from importlib.resources import files
from pathlib import Path
from urllib.parse import quote, unquote, urljoin, urlparse

from markdown_it import MarkdownIt
from markdown_it.token import Token
from mdit_py_plugins.dollarmath import dollarmath_plugin

from .config import BuildConfig
from .identity import node_filename
from .models import ConceptNode, NodeStatus, RunState, Source

_CITATION_RE = re.compile(r"\[(S\d+)\]")


def _markdown_renderer() -> MarkdownIt:
    renderer = MarkdownIt("commonmark", {"html": False, "linkify": True, "typographer": False})
    renderer.enable("table")
    renderer.enable("strikethrough")
    renderer.use(dollarmath_plugin)
    return renderer


def _complete_nodes(state: RunState) -> list[ConceptNode]:
    return sorted(
        (node for node in state.nodes.values() if node.status is NodeStatus.COMPLETE),
        key=lambda node: (node.depth, node.sequence),
    )


def _html_route(node: ConceptNode, root_id: str) -> Path:
    return Path("index.html") if node.node_id == root_id else Path("pages") / f"{node_filename(node)}.html"


def _markdown_route(node: ConceptNode, root_id: str) -> Path:
    return Path("markdown/index.md") if node.node_id == root_id else Path("markdown") / f"{node_filename(node)}.md"


def _relative_link(from_path: Path, to_path: Path) -> str:
    return os.path.relpath(to_path, start=from_path.parent).replace(os.sep, "/")


def _used_sources(node: ConceptNode) -> list[Source]:
    by_id = {source.source_id: source for source in node.sources}
    return [by_id[source_id] for source_id in node.used_source_ids if source_id in by_id]


def _link_citation_tokens(children: list[Token]) -> list[Token]:
    linked: list[Token] = []
    link_depth = 0
    for child in children:
        if child.type == "link_open":
            link_depth += 1
            linked.append(child)
            continue
        if child.type == "link_close":
            link_depth = max(0, link_depth - 1)
            linked.append(child)
            continue
        if child.type != "text" or link_depth:
            linked.append(child)
            continue
        position = 0
        for match in _CITATION_RE.finditer(child.content):
            if match.start() > position:
                linked.append(Token("text", "", 0, content=child.content[position : match.start()]))
            source_id = match.group(1)
            linked.extend(
                [
                    Token("link_open", "a", 1, attrs={"href": f"#ref-{source_id}"}),
                    Token("text", "", 0, content=f"[{source_id}]"),
                    Token("link_close", "a", -1),
                ]
            )
            position = match.end()
        if position < len(child.content):
            linked.append(Token("text", "", 0, content=child.content[position:]))
        elif position == 0:
            linked.append(child)
    return linked


def _markdown_text(value: str) -> str:
    """생성기가 덧붙이는 일반 텍스트를 Markdown 문법과 raw HTML에서 격리한다."""

    collapsed = " ".join(value.split())
    escaped = collapsed.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return escaped.replace("\\", "\\\\").replace("[", "\\[").replace("]", "\\]")


def _markdown_url(value: str) -> str:
    return quote(value, safe=":/?&=#%+~@;,$!*'")


def _sitemap_url(base_url: str, route: str) -> str:
    parsed = urlparse(urljoin(base_url.rstrip("/") + "/", route))
    hostname = parsed.hostname or ""
    ascii_host = hostname if ":" in hostname else hostname.encode("idna").decode("ascii")
    netloc = f"[{ascii_host}]" if ":" in ascii_host else ascii_host
    if parsed.port:
        netloc += f":{parsed.port}"
    return parsed._replace(
        netloc=netloc,
        path=quote(parsed.path, safe="/%:@+~;,$!*'"),
    ).geturl()


def _write_staging_bytes(path: Path, data: bytes) -> None:
    """미공개 staging 파일은 최종 디렉터리 rename으로 보호되므로 개별 fsync를 생략한다."""

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def _write_staging_text(path: Path, value: str) -> None:
    _write_staging_bytes(path, value.encode("utf-8"))


class SiteRenderer:
    def __init__(self, config: BuildConfig) -> None:
        self.config = config
        self.markdown = _markdown_renderer()

    def render_and_publish(self, state: RunState) -> Path:
        output = self.config.output_dir.resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        staging = output.parent / f".{output.name}.staging-{uuid.uuid4().hex[:10]}"
        backup = output.parent / f".{output.name}.backup-{uuid.uuid4().hex[:10]}"
        try:
            staging.mkdir(parents=True, exist_ok=False)
            self._render_tree(state, staging)
            self._validate_tree(state, staging)
            if output.exists():
                if not self.config.overwrite:
                    raise FileExistsError(f"출력 경로가 이미 있습니다: {output}. 교체하려면 --overwrite를 사용하세요.")
                os.replace(output, backup)
            os.replace(staging, output)
            if backup.exists():
                shutil.rmtree(backup, ignore_errors=True)
            return output
        except BaseException:
            try:
                if backup.exists() and not output.exists():
                    os.replace(backup, output)
            finally:
                if staging.exists():
                    shutil.rmtree(staging, ignore_errors=True)
            raise

    def _render_tree(self, state: RunState, staging: Path) -> None:
        nodes = _complete_nodes(state)
        by_id = {node.node_id: node for node in nodes}
        if state.root_id not in by_id:
            raise ValueError("완성된 루트 노드가 없어 사이트를 만들 수 없습니다.")
        if self.config.html_enabled:
            css_bytes = (
                self.config.css_file.read_bytes()
                if self.config.css_file
                else files("llm_orchestrator").joinpath("assets/demo.css").read_bytes()
            )
            _write_staging_bytes(staging / "assets/site.css", css_bytes)
        for node in nodes:
            children = [by_id[child_id] for child_id in node.child_ids if child_id in by_id]
            if self.config.html_enabled:
                route = _html_route(node, state.root_id)
                _write_staging_text(staging / route, self._render_html(node, children, route, state.root_id))
            if self.config.markdown_enabled:
                route = _markdown_route(node, state.root_id)
                _write_staging_text(staging / route, self._render_markdown(node, children, route, state.root_id))
        if self.config.html_enabled:
            self._write_sitemap(nodes, state.root_id, staging)

    def _render_html(self, node: ConceptNode, children: list[ConceptNode], route: Path, root_id: str) -> str:
        css_href = _relative_link(route, Path("assets/site.css"))
        child_markup = ""
        if children:
            links = "\n".join(
                '<a class="concept-child-link" '
                f'href="{html.escape(_relative_link(route, _html_route(child, root_id)), quote=True)}">'
                f"{html.escape(child.name)}</a>"
                for child in children
            )
            child_markup = f'<nav class="concept-children" aria-label="하위개념">\n{links}\n</nav>\n'
        tokens = self.markdown.parse(node.body_markdown)
        for token in tokens:
            if token.type == "inline" and token.children:
                token.children = _link_citation_tokens(token.children)
        body_html = self.markdown.renderer.render(tokens, self.markdown.options, {})
        references = self._render_html_references(node)
        return f"""<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{html.escape(node.name)}</title>
  <link rel="stylesheet" href="{html.escape(css_href, quote=True)}">
</head>
<body>
  <main class="concept-page">
    <article class="concept-article">
      <h1 class="concept-title">{html.escape(node.name)}</h1>
      <p class="concept-summary">{html.escape(node.summary)}</p>
      {child_markup}<div class="concept-body">
{body_html.rstrip()}
      </div>
{references}    </article>
  </main>
</body>
</html>
"""

    def _render_html_references(self, node: ConceptNode) -> str:
        sources = _used_sources(node)
        if not sources:
            return ""
        items = "\n".join(
            f'          <li id="ref-{html.escape(source.source_id)}">'
            f"<strong>[{html.escape(source.source_id)}]</strong> "
            f'<a href="{html.escape(source.url, quote=True)}" rel="noopener noreferrer">'
            f"{html.escape(source.title)}</a> "
            f'<span class="reference-date">(확인: {html.escape(source.retrieved_at[:10])})</span></li>'
            for source in sources
        )
        return f"""      <section class="concept-references" aria-labelledby="references-title">
        <h2 id="references-title">참고 자료</h2>
        <ol>
{items}
        </ol>
      </section>
"""

    def _render_markdown(self, node: ConceptNode, children: list[ConceptNode], route: Path, root_id: str) -> str:
        parts = [f"# {_markdown_text(node.name)}", "", _markdown_text(node.summary)]
        if children:
            parts.extend(["", "## 하위개념", ""])
            for child in children:
                href = _relative_link(route, _markdown_route(child, root_id))
                parts.append(
                    f"- [{_markdown_text(child.name)}]({_markdown_url(href)}) — {_markdown_text(child.summary)}"
                )
        parts.extend(["", node.body_markdown.strip()])
        sources = _used_sources(node)
        if sources:
            parts.extend(["", "## 참고 자료", ""])
            for source in sources:
                parts.append(
                    f"- [{source.source_id}] [{_markdown_text(source.title)}]({_markdown_url(source.url)}) "
                    f"(확인: {source.retrieved_at[:10]})"
                )
        return "\n".join(parts).rstrip() + "\n"

    def _write_sitemap(self, nodes: list[ConceptNode], root_id: str, staging: Path) -> None:
        lines: list[str] = []
        for node in nodes:
            route = _html_route(node, root_id).as_posix()
            if self.config.site_url:
                route = _sitemap_url(self.config.site_url, route)
            lines.append(route)
        _write_staging_text(staging / "sitemap.txt", "\n".join(lines) + "\n")

    def _validate_tree(self, state: RunState, staging: Path) -> None:
        nodes = _complete_nodes(state)
        complete_ids = {node.node_id for node in nodes}
        html_nodes = {_html_route(node, state.root_id): node for node in nodes} if self.config.html_enabled else {}
        markdown_nodes = (
            {_markdown_route(node, state.root_id): node for node in nodes} if self.config.markdown_enabled else {}
        )
        expected_html = set(html_nodes)
        expected_md = set(markdown_nodes)
        for path in expected_html | expected_md:
            if not (staging / path).is_file():
                raise ValueError(f"생성되어야 할 문서가 없습니다: {path}")
        for path in expected_html:
            document = (staging / path).read_text(encoding="utf-8")
            node = html_nodes[path]
            complete_children = [child_id for child_id in node.child_ids if child_id in complete_ids]
            has_container = 'class="concept-children"' in document
            if bool(complete_children) != has_container:
                raise ValueError(f"하위개념 링크 영역 검증에 실패했습니다: {path}")
            for href in re.findall(r'href="([^"]+)"', document):
                if href.startswith(("http://", "https://", "#", "mailto:")):
                    continue
                target = (staging / path.parent / href).resolve()
                if not target.is_relative_to(staging.resolve()) or not target.is_file():
                    raise ValueError(f"깨진 HTML 내부 링크입니다: {path} -> {href}")
        for path in expected_md:
            document = (staging / path).read_text(encoding="utf-8")
            if document.startswith("---"):
                raise ValueError(f"순수 Markdown에 front matter가 들어갔습니다: {path}")
            for href in re.findall(r"\[[^\]]+\]\(([^)]+)\)", document):
                if href.startswith(("http://", "https://", "#", "mailto:")):
                    continue
                target = (staging / path.parent / unquote(href)).resolve()
                if not target.is_relative_to(staging.resolve()) or not target.is_file():
                    raise ValueError(f"깨진 Markdown 내부 링크입니다: {path} -> {href}")
        if self.config.html_enabled:
            sitemap_lines = (staging / "sitemap.txt").read_text(encoding="utf-8").splitlines()
            if len(sitemap_lines) != len(expected_html) or len(sitemap_lines) != len(set(sitemap_lines)):
                raise ValueError("sitemap.txt 문서 수 또는 중복 검증에 실패했습니다.")
            for line in sitemap_lines:
                if self.config.site_url:
                    parsed = urlparse(line)
                    sitemap_path = unquote(parsed.path)
                    base_path = unquote(urlparse(self.config.site_url).path)
                    relative = sitemap_path.removeprefix(base_path).lstrip("/")
                    target = staging / relative
                else:
                    target = staging / line
                if not target.is_file():
                    raise ValueError(f"sitemap.txt가 없는 파일을 가리킵니다: {line}")
