from __future__ import annotations

import hashlib
import heapq
import re
import unicodedata
from collections.abc import Iterable
from functools import lru_cache

from .models import ConceptNode

_WORD_RE = re.compile(r"[0-9A-Za-z가-힣]{2,}")


@lru_cache(maxsize=65_536)
def normalize_name(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold().strip()
    result: list[str] = []
    for index, char in enumerate(normalized):
        if char.isalnum() or char in {"+", "#"}:
            result.append(char)
            continue
        # .NET, Node.js, 버전명처럼 식별자 일부인 점만 보존한다.
        if char == "." and index + 1 < len(normalized) and normalized[index + 1].isalnum():
            result.append(char)
    return "".join(result)


def slugify(value: str, *, fallback: str = "concept") -> str:
    normalized = unicodedata.normalize("NFKC", value).strip().casefold()
    slug = re.sub(r"[^0-9a-z가-힣]+", "-", normalized).strip("-")
    return (slug or fallback)[:70].rstrip("-")


def stable_node_id(name: str, definition: str, sequence: int) -> str:
    digest = hashlib.sha256(f"{normalize_name(name)}\0{definition.strip()}\0{sequence}".encode()).hexdigest()
    return digest[:16]


def node_filename(node: ConceptNode) -> str:
    return f"{slugify(node.name)}-{node.node_id[:8]}"


@lru_cache(maxsize=65_536)
def _ngrams(value: str, size: int = 2) -> frozenset[str]:
    if len(value) <= size:
        return frozenset({value}) if value else frozenset()
    return frozenset(value[index : index + size] for index in range(len(value) - size + 1))


def _jaccard(left: frozenset[str], right: frozenset[str]) -> float:
    if not left or not right:
        return 0.0
    return len(left & right) / len(left | right)


@lru_cache(maxsize=65_536)
def _words(value: str) -> frozenset[str]:
    return frozenset(word.casefold() for word in _WORD_RE.findall(unicodedata.normalize("NFKC", value)))


def identity_similarity(node: ConceptNode, candidate_name: str, candidate_definition: str) -> float:
    left_name = node.normalized_name
    right_name = normalize_name(candidate_name)
    if left_name == right_name:
        return 1.0
    name_score = _jaccard(_ngrams(left_name), _ngrams(right_name))
    if left_name in right_name or right_name in left_name:
        name_score = max(name_score, 0.72)
    left_definition = node.seed_definition or node.summary
    definition_score = _jaccard(_words(left_definition), _words(candidate_definition))
    return 0.72 * name_score + 0.28 * definition_score


def shortlist_candidates(
    nodes: Iterable[ConceptNode],
    candidate_name: str,
    candidate_definition: str,
    *,
    limit: int = 5,
    minimum_score: float = 0.18,
) -> list[tuple[ConceptNode, float]]:
    scored: list[tuple[ConceptNode, float]] = []
    for node in nodes:
        if node.status.value == "failed":
            continue
        score = identity_similarity(node, candidate_name, candidate_definition)
        if score >= minimum_score:
            scored.append((node, score))
    return heapq.nsmallest(limit, scored, key=lambda item: (-item[1], item[0].depth, item[0].name))
