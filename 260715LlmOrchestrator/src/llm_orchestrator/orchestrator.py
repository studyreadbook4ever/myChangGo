from __future__ import annotations

import json
import traceback
from collections.abc import Callable
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass, replace
from pathlib import Path
from urllib.parse import urlparse

from .config import BuildConfig
from .identity import normalize_name, shortlist_candidates, stable_node_id
from .models import (
    ChildProposal,
    ConceptNode,
    DuplicateRelation,
    NodeDraft,
    NodeStatus,
    Source,
    utc_now,
)
from .prompts import GenerationContext, generation_prompt, review_prompt
from .providers.base import LLMProvider, SearchProvider
from .providers.llm import LLMResponseError, extract_json
from .render import SiteRenderer
from .validation import citation_ids, sanitize_draft, validate_draft
from .web import WebPageFetcher
from .workspace import WorkStore


class BuildFailure(RuntimeError):
    pass


@dataclass(slots=True)
class GenerationOutcome:
    node_id: str
    draft: NodeDraft | None
    sources: list[Source]
    issues: list[str]
    error: str = ""

    @property
    def successful(self) -> bool:
        return self.draft is not None and not self.error


class EagerOrchestrator:
    def __init__(
        self,
        config: BuildConfig,
        llm: LLMProvider,
        search: SearchProvider | None,
        *,
        fetcher: WebPageFetcher | None = None,
        progress: Callable[[str], None] | None = None,
    ) -> None:
        self.config = config
        self.llm = llm
        self.search = search
        self.fetcher = fetcher or WebPageFetcher(timeout=min(config.timeout, 30.0), source_chars=config.source_chars)
        self.progress = progress or (lambda _: None)
        self.store: WorkStore | None = None

    def run(self) -> Path:
        self.config.validate()
        if self.config.output_dir.exists() and not self.config.overwrite:
            raise FileExistsError(
                f"출력 경로가 이미 있습니다: {self.config.output_dir}. "
                "기존 사이트를 보존했습니다. 교체하려면 --overwrite를 사용하세요."
            )
        if self.config.web_enabled:
            if self.search is None:
                raise ValueError("웹 검색이 기본 활성화되어 있지만 검색 공급자가 없습니다.")
            self.search.preflight()
        self.store = WorkStore.open(self.config)
        state = self.store.state
        self.progress(f"작업 {state.run_id}: 최대 {self.config.theoretical_nodes:,}개 노드")

        if not state.finished:
            self._generate_all()
            state.finished = True
            self.store.save_state()
            self.store.record_event("generation_finished", {"complete_nodes": self._complete_count()})
        renderer = SiteRenderer(self.config)
        output = renderer.render_and_publish(state)
        self.store.record_event("site_published", {"output": str(output)})
        self.progress(f"완료: {output} ({self._complete_count():,}개 문서)")
        return output

    def _generate_all(self) -> None:
        assert self.store is not None
        state = self.store.state
        while True:
            pending = [node for node in state.nodes.values() if node.status is NodeStatus.STUB]
            if not pending:
                break
            current_depth = min(node.depth for node in pending)
            level = [node for node in pending if node.depth == current_depth]
            self.progress(f"깊이 {current_depth}: {len(level):,}개 노드 생성")
            for node in level:
                node.status = NodeStatus.GENERATING
            self.store.save_state()

            outcomes = self._generate_level(level)

            for node in level:
                outcome = outcomes[node.node_id]
                if outcome.successful:
                    self._commit_node(node, outcome)
                else:
                    self._fail_node(node, outcome.error or "; ".join(outcome.issues))
            self.store.save_state()
            self.store.record_event(
                "level_checkpointed",
                {"depth": current_depth, "nodes": len(level), "complete_nodes": self._complete_count()},
            )

    def _generate_level(self, level: list[ConceptNode]) -> dict[str, GenerationOutcome]:
        """대기 작업을 jobs개로 제한하고 중단 시 아직 시작하지 않은 호출을 취소한다."""

        outcomes: dict[str, GenerationOutcome] = {}
        iterator = iter(level)
        pool = ThreadPoolExecutor(max_workers=min(self.config.jobs, len(level)))
        futures: dict[Future[GenerationOutcome], str] = {}

        def submit_next() -> bool:
            try:
                node = next(iterator)
            except StopIteration:
                return False
            futures[pool.submit(self._generate_one, node)] = node.node_id
            return True

        try:
            for _ in range(min(self.config.jobs, len(level))):
                submit_next()
            while futures:
                completed, _ = wait(futures, return_when=FIRST_COMPLETED)
                for future in completed:
                    node_id = futures.pop(future)
                    try:
                        outcomes[node_id] = future.result()
                    except Exception as exc:
                        outcomes[node_id] = GenerationOutcome(
                            node_id=node_id,
                            draft=None,
                            sources=[],
                            issues=[],
                            error=f"{type(exc).__name__}: {exc}",
                        )
                        if self.config.verbose:
                            self.progress(traceback.format_exc())
                    submit_next()
        except BaseException:
            for future in futures:
                future.cancel()
            pool.shutdown(wait=False, cancel_futures=True)
            raise
        pool.shutdown(wait=True)
        return outcomes

    def _generate_one(self, node: ConceptNode) -> GenerationOutcome:
        assert self.store is not None
        sources = self._usable_sources(self.store.load_sources(node.node_id))
        if not sources and self.config.web_enabled:
            assert self.search is not None
            query = self._search_query(node)
            sources = self.search.search(query, self.config.max_sources)
            pending_fetch = [source for source in sources if not source.public_url_validated]
            if pending_fetch:
                self.fetcher.fetch_all(pending_fetch, jobs=min(self.config.jobs, self.config.max_sources))
            sources = self._usable_sources(sources)
            self.store.save_sources(node.node_id, sources)
        grounded = self.config.web_enabled and not self.config.allow_ungrounded
        if grounded and not sources:
            return GenerationOutcome(node.node_id, None, sources, [], "웹 근거를 찾지 못했습니다.")

        base_context = GenerationContext(
            node=node,
            root_concept=self.config.concept,
            max_depth=self.config.depth,
            max_children=self.config.max_children,
            target_chars=self.config.target_chars,
            max_chars=self.config.max_chars,
            summary_max_chars=self.config.summary_max_chars,
            sources=sources,
        )
        recovered = self._recover_draft(node, base_context, grounded)
        if recovered is not None:
            return GenerationOutcome(node.node_id, recovered, sources, [])

        feedback: tuple[str, ...] = ()
        last_issues: list[str] = []
        for _ in range(self.config.retries + 1):
            context = replace(base_context, validation_feedback=feedback)
            attempt = self.store.next_attempt(node.node_id, "generation")
            self.store.save_prompt(node.node_id, "generation", attempt, generation_prompt(context))
            try:
                draft, result = self.llm.generate_node(context)
            except Exception as exc:
                if isinstance(exc, LLMResponseError):
                    self.store.save_raw(node.node_id, "generation", attempt, exc.raw_text)
                last_issues = [f"LLM 호출 실패: {type(exc).__name__}: {exc}"]
                feedback = tuple(last_issues)
                continue
            self.store.save_raw(node.node_id, "generation", attempt, result.raw_text)
            draft = sanitize_draft(draft, context)
            issues = validate_draft(draft, context, grounded=grounded)
            if not issues and self.config.review_mode == "strict":
                review_attempt = self.store.next_attempt(node.node_id, "review")
                self.store.save_prompt(
                    node.node_id,
                    "review",
                    review_attempt,
                    review_prompt(draft, context),
                )
                try:
                    review, review_result = self.llm.review_node(draft, context)
                    self.store.save_raw(node.node_id, "review", review_attempt, review_result.raw_text)
                    if not review.approved:
                        issues.extend(review.issues or ["근거 검수에서 승인되지 않았습니다."])
                except Exception as exc:
                    if isinstance(exc, LLMResponseError):
                        self.store.save_raw(node.node_id, "review", review_attempt, exc.raw_text)
                    issues.append(f"근거 검수 실패: {type(exc).__name__}: {exc}")
            if not issues:
                self.store.save_draft(node.node_id, draft)
                return GenerationOutcome(node.node_id, draft, sources, [])
            last_issues = issues
            feedback = tuple(issues)
        return GenerationOutcome(node.node_id, None, sources, last_issues, "; ".join(last_issues))

    def _recover_draft(self, node: ConceptNode, context: GenerationContext, grounded: bool) -> NodeDraft | None:
        assert self.store is not None
        draft = self.store.load_draft(node.node_id)
        if draft is None:
            raw = self.store.latest_raw(node.node_id, "generation")
            if raw:
                try:
                    draft = NodeDraft.from_dict(extract_json(raw))
                except (ValueError, json.JSONDecodeError):
                    draft = None
        if draft is None:
            return None
        draft = sanitize_draft(draft, context)
        if validate_draft(draft, context, grounded=grounded):
            return None
        if self.config.review_mode == "strict":
            attempt = self.store.next_attempt(node.node_id, "review")
            self.store.save_prompt(
                node.node_id,
                "review",
                attempt,
                review_prompt(draft, context),
            )
            try:
                review, result = self.llm.review_node(draft, context)
            except Exception as exc:
                if isinstance(exc, LLMResponseError):
                    self.store.save_raw(node.node_id, "review", attempt, exc.raw_text)
                return None
            self.store.save_raw(node.node_id, "review", attempt, result.raw_text)
            if not review.approved:
                return None
        self.store.save_draft(node.node_id, draft)
        return draft

    def _search_query(self, node: ConceptNode) -> str:
        terms = list(dict.fromkeys([self.config.concept, *node.primary_path, node.name]))
        return f"{' '.join(terms)} 개념 원리 공식 문서"

    def _usable_sources(self, sources: list[Source]) -> list[Source]:
        usable: list[Source] = []
        for source in sources[: self.config.max_sources]:
            parsed = urlparse(source.url)
            evidence = source.content.strip() or source.snippet.strip()
            if (
                parsed.scheme not in {"http", "https"}
                or not parsed.netloc
                or parsed.username
                or parsed.password
                or not source.public_url_validated
                or not evidence
            ):
                continue
            source.source_id = f"S{len(usable) + 1}"
            usable.append(source)
        return usable

    def _commit_node(self, node: ConceptNode, outcome: GenerationOutcome) -> None:
        assert self.store is not None and outcome.draft is not None
        draft = outcome.draft
        node.name = draft.name or node.name
        node.normalized_name = normalize_name(node.name)
        node.summary = draft.summary
        node.body_markdown = draft.body_markdown
        node.decomposition_basis = draft.decomposition_basis
        node.sources = outcome.sources
        node.used_source_ids = citation_ids(draft.body_markdown)
        node.status = NodeStatus.COMPLETE
        node.completed_at = utc_now()
        for proposal in draft.children:
            child = self._resolve_child(node, proposal)
            if child is None:
                continue
            if child.node_id not in node.child_ids:
                node.child_ids.append(child.node_id)
            if node.node_id not in child.parent_ids:
                child.parent_ids.append(node.node_id)
        self.store.record_event(
            "node_completed",
            {"node_id": node.node_id, "name": node.name, "depth": node.depth, "children": len(node.child_ids)},
        )

    def _resolve_child(self, parent: ConceptNode, proposal: ChildProposal) -> ConceptNode | None:
        assert self.store is not None
        state = self.store.state
        normalized = normalize_name(proposal.name)
        existing_nodes = [node for node in state.nodes.values() if node.status is not NodeStatus.FAILED]
        for existing in existing_nodes:
            if existing.normalized_name == normalized:
                if self._would_create_cycle(parent, existing):
                    self.store.record_event(
                        "cycle_link_skipped",
                        {"parent_id": parent.node_id, "candidate": proposal.name, "existing_id": existing.node_id},
                    )
                    return None
                if proposal.name != existing.name and proposal.name not in existing.aliases:
                    existing.aliases.append(proposal.name)
                return existing

        for existing, score in shortlist_candidates(existing_nodes, proposal.name, proposal.definition):
            try:
                decision, result = self.llm.judge_duplicate(
                    existing,
                    proposal.name,
                    proposal.definition,
                    parent.primary_path,
                )
                self.store.save_duplicate_raw(parent.node_id, proposal.name, existing.node_id, result.raw_text)
            except Exception as exc:
                if isinstance(exc, LLMResponseError):
                    self.store.save_duplicate_raw(parent.node_id, proposal.name, existing.node_id, exc.raw_text)
                continue
            if decision.relation is DuplicateRelation.SAME and decision.confidence >= self.config.duplicate_threshold:
                if self._would_create_cycle(parent, existing):
                    self.store.record_event(
                        "cycle_link_skipped",
                        {"parent_id": parent.node_id, "candidate": proposal.name, "existing_id": existing.node_id},
                    )
                    return None
                if proposal.name != existing.name and proposal.name not in existing.aliases:
                    existing.aliases.append(proposal.name)
                self.store.record_event(
                    "concept_merged",
                    {
                        "parent_id": parent.node_id,
                        "canonical_id": existing.node_id,
                        "alias": proposal.name,
                        "confidence": decision.confidence,
                        "lexical_score": score,
                    },
                )
                return existing

        sequence = state.next_sequence
        state.next_sequence += 1
        node_id = stable_node_id(proposal.name, proposal.definition, sequence)
        while node_id in state.nodes:
            sequence = state.next_sequence
            state.next_sequence += 1
            node_id = stable_node_id(proposal.name, proposal.definition, sequence)
        child = ConceptNode(
            node_id=node_id,
            name=proposal.name,
            normalized_name=normalized,
            seed_definition=proposal.definition,
            depth=parent.depth + 1,
            primary_path=[*parent.primary_path, proposal.name],
            sequence=sequence,
            parent_ids=[parent.node_id],
        )
        state.nodes[node_id] = child
        return child

    def _would_create_cycle(self, parent: ConceptNode, child: ConceptNode) -> bool:
        """parent -> child 간선을 추가했을 때 기존 DAG에 순환이 생기는지 확인한다."""

        assert self.store is not None
        if parent.node_id == child.node_id:
            return True
        state = self.store.state
        pending = [child.node_id]
        visited: set[str] = set()
        while pending:
            node_id = pending.pop()
            if node_id == parent.node_id:
                return True
            if node_id in visited:
                continue
            visited.add(node_id)
            node = state.nodes.get(node_id)
            if node is not None:
                pending.extend(node.child_ids)
        return False

    def _fail_node(self, node: ConceptNode, reason: str) -> None:
        assert self.store is not None
        node.status = NodeStatus.FAILED
        node.failure_reason = reason
        for parent_id in list(node.parent_ids):
            parent = self.store.state.nodes.get(parent_id)
            if parent and node.node_id in parent.child_ids:
                parent.child_ids.remove(node.node_id)
        self.store.record_event("node_failed", {"node_id": node.node_id, "name": node.name, "reason": reason})
        if node.node_id == self.store.state.root_id:
            raise BuildFailure(f"루트 개념 생성에 실패했습니다: {reason}")

    def _complete_count(self) -> int:
        assert self.store is not None
        return sum(node.status is NodeStatus.COMPLETE for node in self.store.state.nodes.values())
