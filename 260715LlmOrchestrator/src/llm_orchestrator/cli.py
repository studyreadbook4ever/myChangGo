from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from . import __version__
from .config import BuildConfig
from .orchestrator import EagerOrchestrator
from .providers import (
    BraveSearchProvider,
    DDGSSearchProvider,
    MockLLMProvider,
    MockSearchProvider,
    OpenAICompatibleProvider,
    SearXNGSearchProvider,
)


class KoreanArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        self.print_usage(sys.stderr)
        self.exit(2, f"오류: {message}\n자세한 사용법은 --help를 확인하세요.\n")


def build_parser() -> argparse.ArgumentParser:
    parser = KoreanArgumentParser(
        prog="llm-orchestrator",
        description="저가형·소버린 LLM으로 한국어 개념 트리 웹사이트를 완전 Eager 생성합니다.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("concept", help="사이트의 루트가 될 최초 한국어 개념")
    parser.add_argument("--depth", type=int, default=3, help="루트를 0으로 보는 재귀 생성 깊이")
    parser.add_argument("--max-children", type=int, default=4, help="내부 노드가 가질 최대 하위개념 수")
    parser.add_argument("--output", type=Path, default=Path("generated-site"), help="완성된 사이트 출력 디렉터리")
    parser.add_argument(
        "--work-dir",
        "--workdir",
        type=Path,
        default=Path(".llm-orchestrator-work"),
        help="raw 응답과 재개 상태 작업 디렉터리",
    )
    parser.add_argument("--format", choices=("both", "html", "md"), default="both", help="생성할 문서 형식")
    parser.add_argument("--css", type=Path, help="HTML에 복사할 사용자 CSS 파일")
    parser.add_argument("--site-url", default="", help="sitemap.txt의 절대 URL을 만들 배포 기준 URL")
    parser.add_argument("--target-chars", type=int, default=2_000, help="본문 목표 글자 수")
    parser.add_argument("--max-chars", type=int, default=5_000, help="본문 최대 글자 수(상한 5000)")
    parser.add_argument("--summary-max-chars", type=int, default=100, help="요약 최대 글자 수(상한 100)")

    model = parser.add_argument_group("LLM 공급자")
    model.add_argument(
        "--provider", choices=("openai-compatible", "mock"), default="openai-compatible", help="LLM 공급자 종류"
    )
    model.add_argument("--model", default=os.environ.get("LLM_MODEL", ""), help="OpenAI 호환 모델명")
    model.add_argument("--base-url", default=os.environ.get("LLM_BASE_URL", ""), help="OpenAI 호환 /v1 기준 URL")
    model.add_argument("--api-key-env", default="LLM_API_KEY", help="LLM API 키를 읽을 환경 변수명")
    model.add_argument("--temperature", type=float, default=0.2, help="생성 temperature")
    model.add_argument("--max-tokens", type=int, default=4_096, help="LLM 응답 최대 토큰 수")
    model.add_argument(
        "--review-mode", choices=("strict", "basic", "off"), default="strict", help="strict는 별도 LLM 근거 검수를 수행"
    )

    web = parser.add_argument_group("웹 근거")
    web.add_argument(
        "--search-provider", choices=("auto", "ddgs", "searxng", "brave", "mock"), default="auto", help="웹 검색 공급자"
    )
    web.add_argument("--searxng-url", default=os.environ.get("SEARXNG_URL", ""), help="자체 SearXNG 인스턴스 URL")
    web.add_argument("--brave-api-key-env", default="BRAVE_SEARCH_API_KEY", help="Brave Search API 키 환경 변수명")
    web.add_argument("--max-sources", type=int, default=4, help="노드마다 사용할 최대 웹 출처 수")
    web.add_argument("--source-chars", type=int, default=4_000, help="출처 하나에서 LLM에 제공할 최대 글자 수")
    web.add_argument("--no-web", action="store_true", help="기본 활성화된 웹 검색을 끔")
    web.add_argument(
        "--allow-ungrounded", action="store_true", help="웹 근거가 없어도 모델 자체 지식 생성을 명시적으로 허용"
    )

    execution = parser.add_argument_group("실행과 안전장치")
    execution.add_argument("--jobs", type=int, default=4, help="같은 깊이에서 병렬 생성할 노드 수")
    execution.add_argument("--timeout", type=float, default=60.0, help="LLM·검색 요청 제한 시간(초)")
    execution.add_argument("--retries", type=int, default=2, help="형식·근거 검증 실패 후 재시도 횟수")
    execution.add_argument(
        "--duplicate-threshold", type=float, default=0.82, help="LLM의 SAME 판정을 병합할 최소 신뢰도"
    )
    execution.add_argument(
        "--max-nodes", type=int, default=5_000, help="실수로 과도한 Eager 실행을 막는 예상 노드 안전선"
    )
    execution.add_argument("--force", action="store_true", help="예상 노드 안전선을 넘는 실행을 명시적으로 허용")
    execution.add_argument("--resume", action="store_true", help="동일 설정의 작업 폴더에서 중단된 생성을 재개")
    execution.add_argument("--overwrite", action="store_true", help="완성 후 기존 출력 사이트를 교체")
    execution.add_argument("--dry-run", action="store_true", help="네트워크 호출 없이 예상 규모와 설정만 확인")
    execution.add_argument("--verbose", action="store_true", help="상세 오류와 진행 정보 출력")
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    return parser


def _config_from_args(args: argparse.Namespace) -> BuildConfig:
    return BuildConfig(
        concept=args.concept,
        depth=args.depth,
        max_children=args.max_children,
        output_format=args.format,
        target_chars=args.target_chars,
        max_chars=args.max_chars,
        summary_max_chars=args.summary_max_chars,
        output_dir=args.output,
        work_dir=args.work_dir,
        site_url=args.site_url,
        css_file=args.css,
        jobs=args.jobs,
        timeout=args.timeout,
        retries=args.retries,
        llm_provider=args.provider,
        model=args.model,
        base_url=args.base_url,
        api_key_env=args.api_key_env,
        temperature=args.temperature,
        max_tokens=args.max_tokens,
        search_provider=args.search_provider,
        searxng_url=args.searxng_url,
        brave_api_key_env=args.brave_api_key_env,
        web_enabled=not args.no_web,
        allow_ungrounded=args.allow_ungrounded,
        max_sources=args.max_sources,
        source_chars=args.source_chars,
        review_mode=args.review_mode,
        duplicate_threshold=args.duplicate_threshold,
        max_nodes=args.max_nodes,
        force=args.force,
        overwrite=args.overwrite,
        resume=args.resume,
        verbose=args.verbose,
    )


def _make_llm(config: BuildConfig):
    if config.llm_provider == "mock":
        return MockLLMProvider()
    return OpenAICompatibleProvider(
        base_url=config.base_url,
        model=config.model,
        api_key_env=config.api_key_env,
        timeout=config.timeout,
        temperature=config.temperature,
        max_tokens=config.max_tokens,
    )


def _make_search(config: BuildConfig):
    if not config.web_enabled:
        return None
    provider = config.effective_search_provider
    if provider == "mock":
        return MockSearchProvider()
    if provider == "brave":
        return BraveSearchProvider(config.brave_api_key_env, config.timeout)
    if provider == "searxng":
        return SearXNGSearchProvider(config.searxng_url, config.timeout)
    return DDGSSearchProvider(config.timeout)


def _print_dry_run(config: BuildConfig) -> None:
    review_multiplier = 2 if config.review_mode == "strict" else 1
    print(f"루트 개념: {config.concept}")
    print(f"깊이: {config.depth}")
    print(f"노드당 최대 자식: {config.max_children}")
    print(f"이론상 최대 노드: {config.theoretical_nodes:,}")
    print(f"예상 기본 LLM 호출: 최대 {config.theoretical_nodes * review_multiplier:,}회 + 의미 중복 판정")
    print(f"웹 검색: {'기본 활성화' if config.web_enabled else '비활성화'}")
    print(f"실제 검색 공급자: {config.effective_search_provider}")
    print(f"출력 형식: {config.output_format}")
    print(f"최종 출력: {config.output_dir.resolve()}")
    print(f"작업 폴더: {config.work_dir.resolve()}")


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    config = _config_from_args(args)
    llm = None
    search = None
    try:
        config.validate(check_providers=not args.dry_run)
        if args.dry_run:
            _print_dry_run(config)
            return 0
        if config.html_enabled and not config.site_url:
            print("주의: --site-url이 없어 sitemap.txt는 로컬 상대경로 목록으로 생성됩니다.", file=sys.stderr)
        llm = _make_llm(config)
        search = _make_search(config)
        orchestrator = EagerOrchestrator(config, llm, search, progress=print)
        orchestrator.run()
        return 0
    except KeyboardInterrupt:
        print("중단됨: 완성된 raw 응답과 작업 상태는 작업 폴더에 보존되었습니다.", file=sys.stderr)
        return 130
    except (ValueError, FileNotFoundError, FileExistsError) as exc:
        print(f"오류: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:
        print(f"생성 실패: {type(exc).__name__}: {exc}", file=sys.stderr)
        if args.verbose:
            import traceback

            traceback.print_exc()
        return 1
    finally:
        for provider in (search, llm):
            close = getattr(provider, "close", None)
            if callable(close):
                try:
                    close()
                except Exception:
                    if args.verbose:
                        print(f"주의: {type(provider).__name__} 연결 정리에 실패했습니다.", file=sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())
