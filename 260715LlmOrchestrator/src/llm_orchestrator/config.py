from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from pathlib import Path
from urllib.parse import urlparse

from .prompts import PROMPT_VERSION


@dataclass(frozen=True, slots=True)
class BuildConfig:
    concept: str
    depth: int = 3
    max_children: int = 4
    output_format: str = "both"
    target_chars: int = 2_000
    max_chars: int = 5_000
    summary_max_chars: int = 100
    output_dir: Path = Path("generated-site")
    work_dir: Path = Path(".llm-orchestrator-work")
    site_url: str = ""
    css_file: Path | None = None
    jobs: int = 4
    timeout: float = 60.0
    retries: int = 2
    llm_provider: str = "openai-compatible"
    model: str = ""
    base_url: str = ""
    api_key_env: str = "LLM_API_KEY"
    temperature: float = 0.2
    max_tokens: int = 4_096
    search_provider: str = "auto"
    searxng_url: str = ""
    brave_api_key_env: str = "BRAVE_SEARCH_API_KEY"
    web_enabled: bool = True
    allow_ungrounded: bool = False
    max_sources: int = 4
    source_chars: int = 4_000
    review_mode: str = "strict"
    duplicate_threshold: float = 0.82
    max_nodes: int = 5_000
    force: bool = False
    overwrite: bool = False
    resume: bool = False
    keep_raw: bool = True
    verbose: bool = False

    @property
    def theoretical_nodes(self) -> int:
        if self.max_children == 1:
            return self.depth + 1
        return (self.max_children ** (self.depth + 1) - 1) // (self.max_children - 1)

    @property
    def html_enabled(self) -> bool:
        return self.output_format in {"both", "html"}

    @property
    def markdown_enabled(self) -> bool:
        return self.output_format in {"both", "md"}

    def validate(self, *, check_providers: bool = True) -> None:
        errors: list[str] = []
        if not self.concept.strip():
            errors.append("최초 개념은 비어 있을 수 없습니다.")
        if self.depth < 0:
            errors.append("--depth는 0 이상이어야 합니다.")
        if not 1 <= self.max_children <= 16:
            errors.append("--max-children은 1 이상 16 이하여야 합니다.")
        if self.output_format not in {"both", "html", "md"}:
            errors.append("--format은 both, html, md 중 하나여야 합니다.")
        if not 200 <= self.target_chars <= self.max_chars:
            errors.append("--target-chars는 200 이상이며 --max-chars 이하여야 합니다.")
        if not 200 <= self.max_chars <= 5_000:
            errors.append("--max-chars는 200 이상 5000 이하여야 합니다.")
        if not 20 <= self.summary_max_chars <= 100:
            errors.append("--summary-max-chars는 20 이상 100 이하여야 합니다.")
        if self.jobs < 1:
            errors.append("--jobs는 1 이상이어야 합니다.")
        if self.timeout <= 0:
            errors.append("--timeout은 0보다 커야 합니다.")
        if self.retries < 0:
            errors.append("--retries는 0 이상이어야 합니다.")
        if not 0 <= self.temperature <= 2:
            errors.append("--temperature는 0 이상 2 이하여야 합니다.")
        if self.max_tokens < 1:
            errors.append("--max-tokens는 1 이상이어야 합니다.")
        if self.llm_provider not in {"openai-compatible", "mock"}:
            errors.append("지원하지 않는 LLM 공급자입니다.")
        if check_providers and self.llm_provider == "openai-compatible" and not self.model:
            errors.append("openai-compatible 공급자에는 --model이 필요합니다.")
        if check_providers and self.llm_provider == "openai-compatible" and not self.base_url:
            errors.append("openai-compatible 공급자에는 --base-url이 필요합니다.")
        elif self.llm_provider == "openai-compatible" and self.base_url:
            parsed_base = urlparse(self.base_url)
            if parsed_base.scheme not in {"http", "https"} or not parsed_base.netloc:
                errors.append("--base-url은 http:// 또는 https://로 시작하는 절대 URL이어야 합니다.")
        if self.search_provider not in {"auto", "ddgs", "searxng", "brave", "mock"}:
            errors.append("지원하지 않는 검색 공급자입니다.")
        if not self.web_enabled and not self.allow_ungrounded:
            errors.append("웹 검색을 끄려면 --allow-ungrounded도 명시해야 합니다.")
        if self.web_enabled and self.search_provider == "searxng" and not self.searxng_url:
            errors.append("SearXNG 검색에는 --searxng-url이 필요합니다.")
        elif self.web_enabled and self.search_provider == "searxng":
            parsed_searxng = urlparse(self.searxng_url)
            if parsed_searxng.scheme not in {"http", "https"} or not parsed_searxng.netloc:
                errors.append("--searxng-url은 http:// 또는 https://로 시작하는 절대 URL이어야 합니다.")
        if self.review_mode not in {"strict", "basic", "off"}:
            errors.append("--review-mode은 strict, basic, off 중 하나여야 합니다.")
        if not 0.5 <= self.duplicate_threshold <= 1.0:
            errors.append("--duplicate-threshold는 0.5 이상 1.0 이하여야 합니다.")
        if self.max_sources < 1 and self.web_enabled:
            errors.append("웹 검색 사용 시 --max-sources는 1 이상이어야 합니다.")
        if self.source_chars < 500:
            errors.append("--source-chars는 500 이상이어야 합니다.")
        if self.max_nodes < 1:
            errors.append("--max-nodes는 1 이상이어야 합니다.")
        if self.theoretical_nodes > self.max_nodes and not self.force:
            errors.append(
                f"최대 {self.theoretical_nodes:,}개 노드가 예상됩니다. "
                f"--max-nodes={self.max_nodes:,}를 넘으므로 의도한 실행이면 --force를 추가하세요."
            )
        if self.site_url:
            parsed = urlparse(self.site_url)
            if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username or parsed.password:
                errors.append("--site-url은 http:// 또는 https://로 시작하는 절대 URL이어야 합니다.")
            elif parsed.query or parsed.fragment:
                errors.append("--site-url에는 query string이나 fragment를 넣을 수 없습니다.")
            else:
                try:
                    _ = parsed.port
                except ValueError:
                    errors.append("--site-url의 포트 번호가 올바르지 않습니다.")
        if self.css_file and not self.css_file.is_file():
            errors.append(f"CSS 파일을 찾을 수 없습니다: {self.css_file}")
        output = self.output_dir.resolve()
        work = self.work_dir.resolve()
        if output == work or output.is_relative_to(work) or work.is_relative_to(output):
            errors.append("--output과 --work-dir은 서로 같거나 한쪽에 포함될 수 없습니다.")
        if errors:
            raise ValueError("\n".join(errors))

    def semantic_dict(self) -> dict[str, object]:
        value = asdict(self)
        for key in {"overwrite", "resume", "verbose", "force", "keep_raw"}:
            value.pop(key, None)
        value["output_dir"] = str(self.output_dir.resolve())
        value["work_dir"] = str(self.work_dir.resolve())
        value["css_file"] = str(self.css_file.resolve()) if self.css_file else ""
        value["prompt_version"] = PROMPT_VERSION
        return value

    @property
    def config_hash(self) -> str:
        encoded = json.dumps(self.semantic_dict(), ensure_ascii=False, sort_keys=True).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()[:16]
