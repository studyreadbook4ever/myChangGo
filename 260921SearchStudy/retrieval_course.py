# Generated from course/*.md. All model code and data are included here.

# %% 00_opening.md / cell 1
import sys
import math
import random
import json
import re
import unicodedata
import copy
import time
import hashlib
import html
from pathlib import Path
from collections import Counter
from dataclasses import dataclass, asdict

import numpy as np
import torch
from torch import nn
from torch.nn import functional as F
import matplotlib.pyplot as plt
from IPython.display import display, HTML, Markdown

torch.set_num_threads(1)
SEED = 42
random.seed(SEED)
np.random.seed(SEED)
torch.manual_seed(SEED)
STARTED_AT = time.perf_counter()
ARTIFACT_DIR = Path.cwd() / "artifacts" / "course"
ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
print("Python:", sys.executable)
print("PyTorch:", torch.__version__)
print("계산 장치: CPU")

def show_table(headers, rows):
    """노트북의 작은 표를 표시한다. 모델 계산에는 관여하지 않는다."""
    def cell(value):
        return html.escape(str(value))
    heading = "".join(f"<th>{cell(x)}</th>" for x in headers)
    body = "".join("<tr>" + "".join(f"<td>{cell(x)}</td>" for x in row) + "</tr>" for row in rows)
    display(HTML(f"<table><thead><tr>{heading}</tr></thead><tbody>{body}</tbody></table>"))

# %% 00_opening.md / cell 3
DOC_NAMES: list[str] = [
    "고양이가 쥐를 쫓음",
    "쥐가 고양이를 쫓음",
    "개가 토끼를 도움",
    "토끼가 개를 도움",
    "교사가 제자를 가르침",
    "제자가 교사를 가르침",
    "비밀번호 초기화",
    "환불 입금 소요 기간",
    "택배 위치 조회",
    "카드 결제 실패",
    "진료 예약 취소",
    "반려묘 먹이 선택",
]

DOCS: list[str] = [
    "고양이 가 쥐 를 쫓다",
    "쥐 가 고양이 를 쫓다",
    "개 가 토끼 를 돕다",
    "토끼 가 개 를 돕다",
    "교사 가 제자 를 가르치다",
    "제자 가 교사 를 가르치다",
    "계정 비밀번호 초기화 안내",
    "환불 처리 이후 입금 소요 기간",
    "택배 현재 위치 조회 안내",
    "카드 결제 실패 원인 해결",
    "진료 예약 취소 방법",
    "반려묘 사료 선택 안내",
]

# 0/1, 2/3, 4/5는 순서를 제외하면 완전히 같은 토큰과 토큰 수를 갖는다.
# 따라서 위치 정보를 사용하지 않는 토큰 임베딩의 평균으로는 구별 불가.
ORDER_PAIR: tuple[int, int] = (0, 1)
ORDER_PAIRS: tuple[tuple[int, int], ...] = ((0, 1), (2, 3), (4, 5))
PROBE_TOKEN = "추격"
SEMANTIC_PAIR: tuple[str, str] = ("추격", "쫓다")

# %% 00_opening.md / cell 5
TRAIN: list[tuple[str, int]] = [
    ("고양이 가 쥐 를 추격 하다", 0),
    ("고양이 가 쥐 를 뒤쫓다", 0),
    ("고양이 가 쥐 를 쫓다 설명", 0),
    ("고양이 가 쥐 를 추격 장면", 0),
    ("쥐 가 고양이 를 추격 하다", 1),
    ("쥐 가 고양이 를 뒤쫓다", 1),
    ("쥐 가 고양이 를 쫓다 설명", 1),
    ("쥐 가 고양이 를 추격 장면", 1),
    ("개 가 토끼 를 지원 하다", 2),
    ("개 가 토끼 를 도와주다", 2),
    ("개 가 토끼 를 돕다 설명", 2),
    ("개 가 토끼 를 지원 장면", 2),
    ("토끼 가 개 를 지원 하다", 3),
    ("토끼 가 개 를 도와주다", 3),
    ("토끼 가 개 를 돕다 설명", 3),
    ("토끼 가 개 를 지원 장면", 3),
    ("교사 가 제자 를 교육 하다", 4),
    ("교사 가 제자 를 지도 하다", 4),
    ("교사 가 제자 를 가르치다 설명", 4),
    ("교사 가 제자 를 교육 장면", 4),
    ("제자 가 교사 를 교육 하다", 5),
    ("제자 가 교사 를 지도 하다", 5),
    ("제자 가 교사 를 가르치다 설명", 5),
    ("제자 가 교사 를 교육 장면", 5),
    ("로그인 암호 분실 재설정 방법", 6),
    ("잊어버린 암호 다시 설정", 6),
    ("로그인 비밀번호 잊어버린 경우", 6),
    ("계정 암호 재설정 절차", 6),
    ("돈 돌려받기 며칠 걸리나", 7),
    ("환불 완료 뒤 돈 언제 오나", 7),
    ("돌려받기 완료 뒤 며칠 기다리나", 7),
    ("입금 까지 얼마나 기다리나", 7),
    ("배송 물건 어디 왔나", 8),
    ("주문 물건 이동 경로 확인", 8),
    ("배송 중 물건 위치 확인", 8),
    ("택배 어디 있는지 확인", 8),
    ("신용카드 승인 거절 대처", 9),
    ("지불 오류 어떻게 고치나", 9),
    ("카드 승인 거절 원인", 9),
    ("지불 실패 어떻게 해결", 9),
    ("병원 방문 약속 철회 절차", 10),
    ("의사 만남 약속 없애기", 10),
    ("병원 예약 철회 방법", 10),
    ("진료 약속 없애기 절차", 10),
    ("고양이 먹이 고르기 방법", 11),
    ("냥이 밥 어떤 것 고르나", 11),
    ("반려묘 먹이 선택 방법", 11),
    ("고양이 밥 고르기 안내", 11),
]

# %% 00_opening.md / cell 7
VALID: list[tuple[str, int]] = [
    ("고양이 가 쥐 를 뒤쫓다 장면", 0),
    ("고양이 가 쥐 를 추격 하다 설명", 0),
    ("쥐 가 고양이 를 뒤쫓다 장면", 1),
    ("쥐 가 고양이 를 추격 하다 설명", 1),
    ("개 가 토끼 를 도와주다 장면", 2),
    ("개 가 토끼 를 지원 하다 설명", 2),
    ("토끼 가 개 를 도와주다 장면", 3),
    ("토끼 가 개 를 지원 하다 설명", 3),
    ("교사 가 제자 를 지도 하다 장면", 4),
    ("교사 가 제자 를 교육 하다 설명", 4),
    ("제자 가 교사 를 지도 하다 장면", 5),
    ("제자 가 교사 를 교육 하다 설명", 5),
    ("잊어버린 로그인 암호 재설정", 6),
    ("계정 비밀번호 다시 설정 방법", 6),
    ("환불 완료 뒤 며칠 기다리나", 7),
    ("돈 돌려받기 까지 얼마나 걸리나", 7),
    ("주문 물건 현재 위치 확인", 8),
    ("배송 중 물건 어디 있는지 확인", 8),
    ("신용카드 승인 거절 어떻게 해결", 9),
    ("카드 지불 오류 원인", 9),
    ("병원 진료 약속 철회 방법", 10),
    ("의사 만남 예약 없애기 절차", 10),
    ("냥이 먹이 고르기 방법", 11),
    ("반려묘 밥 어떤 것 고르나", 11),
]

# 의도적으로 어휘에 없는 표현. 실제 검색 평가가 아니라 UNK 진단용이다.
OOV_QUERY = "패스워드 리커버리"

# %% 00_opening.md / cell 9
# TEST는 최종 확인까지 평가에 쓰지 않는다. 문자열 분리는 구성상 보장한다.
TEST = [
    ("고양이 가 쥐 를 뒤쫓다 설명", 0),
    ("고양이 가 쥐 를 추격 하다 장면 설명", 0),
    ("쥐 가 고양이 를 뒤쫓다 설명", 1),
    ("쥐 가 고양이 를 추격 하다 장면 설명", 1),
    ("개 가 토끼 를 도와주다 설명", 2),
    ("개 가 토끼 를 지원 하다 장면 설명", 2),
    ("토끼 가 개 를 도와주다 설명", 3),
    ("토끼 가 개 를 지원 하다 장면 설명", 3),
    ("교사 가 제자 를 지도 하다 설명", 4),
    ("교사 가 제자 를 교육 하다 장면 설명", 4),
    ("제자 가 교사 를 지도 하다 설명", 5),
    ("제자 가 교사 를 교육 하다 장면 설명", 5),
    ("로그인 암호 다시 설정 절차", 6),
    ("잊어버린 계정 비밀번호 재설정", 6),
    ("환불 입금 까지 며칠 걸리나", 7),
    ("돈 돌려받기 완료 뒤 언제 오나", 7),
    ("배송 물건 이동 경로 조회", 8),
    ("주문 택배 현재 어디 왔나", 8),
    ("신용카드 결제 실패 어떻게 고치나", 9),
    ("카드 승인 오류 대처", 9),
    ("병원 방문 예약 없애기 방법", 10),
    ("의사 만남 약속 취소 절차", 10),
    ("냥이 사료 어떤 것 고르나", 11),
    ("고양이 먹이 선택 안내", 11),
]
assert len(DOCS) == len(DOC_NAMES) == 12
query_sets = [{q for q, _ in pairs} for pairs in (TRAIN, VALID, TEST)]
assert not (query_sets[0] & query_sets[1] or query_sets[0] & query_sets[2] or query_sets[1] & query_sets[2])
assert all(0 <= target < len(DOCS) for pairs in (TRAIN, VALID, TEST) for _, target in pairs)
show_table(["문서 ID", "문서"], list(enumerate(DOCS)))
print("학습/검증/최종 확인 질의 수:", len(TRAIN), len(VALID), len(TEST))

# %% 01_tokenizer.md / cell 1
SPECIAL_PIECES = ["[PAD]", "[UNK]", "[CLS]", "[SEP]", "[MASK]"]
WORD_START = "▁"


def normalize_text(text):
    if not isinstance(text, str):
        raise TypeError("입력은 문자열이어야 합니다.")
    text = unicodedata.normalize("NFKC", text)
    if WORD_START in text or any(piece in text for piece in SPECIAL_PIECES):
        raise ValueError("입력에 내부용 표식 또는 special-token 표기가 있습니다.")
    text = " ".join(text.split())
    if not text:
        raise ValueError("공백만 있는 문장은 처리하지 않습니다.")
    return text


assert normalize_text("  Ａ\t고양이\n쥐  ") == "A 고양이 쥐"
print(repr(normalize_text("  Ａ\t고양이\n쥐  ")))

# %% 01_tokenizer.md / cell 3
def count_pairs(segmented_words):
    counts = Counter()
    for symbols, frequency in segmented_words.items():
        for pair in zip(symbols, symbols[1:]):
            counts[pair] += frequency
    return counts


def merge_pair(symbols, pair):
    result = []
    index = 0
    while index < len(symbols):
        if index + 1 < len(symbols) and (symbols[index], symbols[index + 1]) == pair:
            result.append(symbols[index] + symbols[index + 1])
            index += 2
        else:
            result.append(symbols[index])
            index += 1
    return tuple(result)


assert merge_pair(("a", "a", "a"), ("a", "a")) == ("aa", "a")
tiny_words = Counter({tuple("▁가나"): 2, tuple("▁가다"): 1})
show_table(["인접 쌍", "가중 빈도"], sorted(count_pairs(tiny_words).items()))

# %% 01_tokenizer.md / cell 5
def choose_pair(pair_counts):
    return min(pair_counts, key=lambda pair: (-pair_counts[pair], pair))


trace_words = tiny_words.copy()
for step in range(2):
    pair_counts = count_pairs(trace_words)
    chosen = choose_pair(pair_counts)
    merged_words = Counter()
    for symbols, frequency in trace_words.items():
        merged_words[merge_pair(symbols, chosen)] += frequency
    trace_words = merged_words
    print(f"{step + 1}회: {chosen}, 빈도={pair_counts[chosen]}")
    print("      ", dict(trace_words))

# %% 01_tokenizer.md / cell 7
def apply_bpe_to_word(word, merge_ranks):
    symbols = tuple(WORD_START + word)
    while len(symbols) > 1:
        candidates = [pair for pair in zip(symbols, symbols[1:]) if pair in merge_ranks]
        if not candidates:
            break
        chosen = min(candidates, key=merge_ranks.__getitem__)
        symbols = merge_pair(symbols, chosen)
    return symbols


rank_example = {("b", "c"): 0, ("a", "b"): 1}
assert apply_bpe_to_word("abc", rank_example) == ("▁", "a", "bc")
print(apply_bpe_to_word("abc", rank_example))

# %% 01_tokenizer.md / cell 9
class ScratchBPE:
    pad_id, unk_id, cls_id, sep_id, mask_id = range(5)

    def __init__(self):
        self.pieces = list(SPECIAL_PIECES)
        self.piece_to_id = {piece: i for i, piece in enumerate(self.pieces)}
        self.merges = []
        self.merge_ranks = {}
        self.ready = False

    @property
    def vocab_size(self):
        return len(self.pieces)

    def fit(self, texts, num_merges=100, min_pair_frequency=2):
        if num_merges < 0 or min_pair_frequency < 1:
            raise ValueError("num_merges는 0 이상, min_pair_frequency는 1 이상입니다.")
        word_counts = Counter(word for text in texts for word in normalize_text(text).split())
        if not word_counts:
            raise ValueError("토크나이저를 학습할 문장이 없습니다.")
        self.__init__()
        alphabet = sorted(set(WORD_START + "".join(word_counts)))
        self.pieces.extend(alphabet)
        self.piece_to_id = {piece: i for i, piece in enumerate(self.pieces)}
        segmented = Counter({tuple(WORD_START + word): freq for word, freq in word_counts.items()})
        for _ in range(num_merges):
            counts = count_pairs(segmented)
            if not counts:
                break
            pair = choose_pair(counts)
            if counts[pair] < min_pair_frequency:
                break
            self.merges.append(pair)
            joined = "".join(pair)
            if joined not in self.piece_to_id:
                self.piece_to_id[joined] = len(self.pieces)
                self.pieces.append(joined)
            updated = Counter()
            for symbols, frequency in segmented.items():
                updated[merge_pair(symbols, pair)] += frequency
            segmented = updated
        self.merge_ranks = {pair: rank for rank, pair in enumerate(self.merges)}
        self.ready = True
        return self

    def encode(self, text, add_special_tokens=True):
        if not self.ready:
            raise RuntimeError("fit 또는 from_dict를 먼저 실행하세요.")
        ids = []
        for word in normalize_text(text).split():
            symbols = apply_bpe_to_word(word, self.merge_ranks)
            ids.extend(self.piece_to_id.get(piece, self.unk_id) for piece in symbols)
        return [self.cls_id, *ids, self.sep_id] if add_special_tokens else ids

    def decode(self, ids, skip_special_tokens=True):
        if not self.ready:
            raise RuntimeError("fit 또는 from_dict를 먼저 실행하세요.")
        pieces = []
        controls = {self.pad_id, self.cls_id, self.sep_id, self.mask_id}
        for index in ids:
            index = int(index)
            if not 0 <= index < self.vocab_size:
                raise ValueError(f"어휘 밖 ID: {index}")
            if not (skip_special_tokens and index in controls):
                pieces.append(self.pieces[index])
        return "".join(pieces).replace(WORD_START, " ").strip()

    def to_dict(self):
        if not self.ready:
            raise RuntimeError("학습한 상태만 저장할 수 있습니다.")
        return {"version": 1, "normalization": "NFKC+collapse_whitespace",
                "word_start": WORD_START, "pieces": list(self.pieces),
                "merges": [list(pair) for pair in self.merges]}

    @classmethod
    def from_dict(cls, state):
        if (state.get("version") != 1 or state.get("word_start") != WORD_START
                or state.get("normalization") != "NFKC+collapse_whitespace"):
            raise ValueError("지원하지 않는 토크나이저 저장 형식입니다.")
        obj = cls()
        obj.pieces = list(state["pieces"])
        if obj.pieces[:5] != SPECIAL_PIECES or len(set(obj.pieces)) != len(obj.pieces):
            raise ValueError("special-token ID 또는 어휘의 유일성이 깨졌습니다.")
        obj.piece_to_id = {piece: i for i, piece in enumerate(obj.pieces)}
        obj.merges = [tuple(pair) for pair in state["merges"]]
        if any(len(pair) != 2 or any(p not in obj.piece_to_id for p in pair)
               or "".join(pair) not in obj.piece_to_id for pair in obj.merges):
            raise ValueError("어휘와 merge 규칙이 일치하지 않습니다.")
        obj.merge_ranks = {pair: rank for rank, pair in enumerate(obj.merges)}
        if len(obj.merge_ranks) != len(obj.merges):
            raise ValueError("merge 규칙이 중복되었습니다.")
        obj.ready = True
        return obj

# %% 01_tokenizer.md / cell 11
tokenizer_corpus = DOCS + [query for query, _ in TRAIN]
tokenizer = ScratchBPE().fit(tokenizer_corpus, num_merges=100)
example_text = TRAIN[0][0]
example_ids = tokenizer.encode(example_text)
show_table(["위치", "ID", "문자열 조각"],
           [(i, token_id, tokenizer.pieces[token_id]) for i, token_id in enumerate(example_ids)])
print("어휘 크기:", tokenizer.vocab_size, "/ 학습한 merge 수:", len(tokenizer.merges))
print("복원:", tokenizer.decode(example_ids))
assert tokenizer.decode(example_ids) == normalize_text(example_text)
assert tokenizer.pieces[:5] == SPECIAL_PIECES
assert tokenizer.unk_id not in example_ids

# %% 01_tokenizer.md / cell 13
unseen_word = "고양이쥐"
assert unseen_word not in set(" ".join(tokenizer_corpus).split())
assert tokenizer.unk_id not in tokenizer.encode(unseen_word)
assert tokenizer.decode(tokenizer.encode(unseen_word)) == unseen_word
unknown_character = "🧬"
assert unknown_character not in tokenizer.piece_to_id
for sentence in [unseen_word, "고양이 " + unknown_character]:
    ids = tokenizer.encode(sentence)
    print(sentence, "→", [tokenizer.pieces[i] for i in ids], "→", tokenizer.decode(ids))

# 같은 학습 입력의 순서를 뒤집어도 동률 처리 규칙 때문에 결과는 같다.
repeated_tokenizer = ScratchBPE().fit(list(reversed(tokenizer_corpus)), num_merges=100)
assert repeated_tokenizer.to_dict() == tokenizer.to_dict()

# %% 01_tokenizer.md / cell 15
tokenizer_tradeoffs = []
for merge_budget in [0, 20, 100]:
    candidate = ScratchBPE().fit(tokenizer_corpus, num_merges=merge_budget)
    lengths = [len(candidate.encode(text, add_special_tokens=False)) for text in tokenizer_corpus]
    tokenizer_tradeoffs.append((merge_budget, len(candidate.merges), candidate.vocab_size,
                               round(sum(lengths) / len(lengths), 2), max(lengths)))
show_table(["최대 merge", "실제 merge", "어휘 크기", "평균 내용 토큰 수", "최대 내용 토큰 수"],
           tokenizer_tradeoffs)

# %% 01_tokenizer.md / cell 17
def pack_batch(texts, tokenizer=tokenizer, max_len=96):
    if isinstance(texts, str):
        raise TypeError("문장 하나도 [문장] 형태로 전달하세요.")
    texts = list(texts)
    if not texts or not isinstance(max_len, int) or max_len < 3:
        raise ValueError("배치는 비어 있을 수 없고 max_len은 3 이상의 정수입니다.")
    encoded = [tokenizer.encode(text) for text in texts]
    lengths = [len(ids) for ids in encoded]
    if max(lengths) > max_len:
        raise ValueError(f"토큰 길이 {max(lengths)}가 max_len={max_len}을 넘었습니다. chunk 설계가 필요합니다.")
    input_ids = torch.full((len(encoded), max(lengths)), tokenizer.pad_id, dtype=torch.long)
    attention_mask = torch.zeros_like(input_ids, dtype=torch.bool)
    pool_mask = torch.zeros_like(input_ids, dtype=torch.bool)
    for row, ids in enumerate(encoded):
        input_ids[row, :len(ids)] = torch.tensor(ids, dtype=torch.long)
        attention_mask[row, :len(ids)] = True
        pool_mask[row, 1:len(ids) - 1] = True
    return {"input_ids": input_ids, "attention_mask": attention_mask,
            "pool_mask": pool_mask, "token_type_ids": torch.zeros_like(input_ids)}


packed_example = pack_batch([DOCS[0], "쥐"])
for name, tensor in packed_example.items():
    print(name, tuple(tensor.shape), tensor.dtype)
    print(tensor)
assert torch.equal(packed_example["attention_mask"], packed_example["input_ids"] != tokenizer.pad_id)
assert torch.all(packed_example["pool_mask"].sum(dim=1) > 0)
assert not (packed_example["pool_mask"] & ~packed_example["attention_mask"]).any()

# %% 01_tokenizer.md / cell 19
# 학습·추론의 경계에서 잘못된 입력이 실제로 차단되는지 확인한다.
for invalid_text in ["   ", "고양이 ▁ 쥐", "고양이 [MASK]"]:
    try:
        pack_batch([invalid_text])
    except ValueError as error:
        print(type(error).__name__, ":", str(error))
    else:
        raise AssertionError("예약 표식 또는 빈 입력을 거부해야 합니다.")
try:
    pack_batch([example_text], max_len=3)
except ValueError as error:
    print(type(error).__name__, ":", str(error))
else:
    raise AssertionError("길이 초과를 조용히 잘라서는 안 됩니다.")

# %% 01_tokenizer.md / cell 21
ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
tokenizer_path = ARTIFACT_DIR / "tokenizer.json"
tokenizer_path.write_text(json.dumps(tokenizer.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
restored_tokenizer = ScratchBPE.from_dict(json.loads(tokenizer_path.read_text(encoding="utf-8")))
for text in tokenizer_corpus + [unseen_word, "고양이 " + unknown_character]:
    assert restored_tokenizer.encode(text) == tokenizer.encode(text)
assert restored_tokenizer.to_dict() == tokenizer.to_dict()
print("저장/복원 후 ID 일치:", tokenizer_path.name)

# %% 02_encoder.md / cell 1
lookup_table = nn.Embedding(6, 3, padding_idx=0)
with torch.no_grad():
    lookup_table.weight.copy_(torch.arange(18).reshape(6, 3) / 10)
    lookup_table.weight[0].zero_()
lookup_ids = torch.tensor([2, 4, 2, 0])
lookup_values = lookup_table(lookup_ids)
lookup_onehot = F.one_hot(lookup_ids, num_classes=6).float()
assert torch.equal(lookup_values, lookup_onehot @ lookup_table.weight)
show_table(
    ["입력 위치", "토큰 ID", "조회한 벡터"],
    [[i, int(t), lookup_values[i].detach().tolist()]
     for i, t in enumerate(lookup_ids)],
)

# %% 02_encoder.md / cell 3
lookup_coeff = torch.tensor([1., 2., 3., 9.])
lookup_loss = (lookup_values * lookup_coeff[:, None]).sum()
lookup_loss.backward()
lookup_expected_grad = torch.zeros_like(lookup_table.weight)
lookup_expected_grad[2] = 4
lookup_expected_grad[4] = 2
assert torch.equal(lookup_table.weight.grad, lookup_expected_grad)
show_table(
    ["ID", "gradient"],
    [[i, row.tolist()] for i, row in enumerate(lookup_table.weight.grad)],
)

# %% 02_encoder.md / cell 5
@dataclass
class ModelConfig:
    vocab_size: int
    max_len: int = 96
    d_model: int = 48
    n_heads: int = 4
    n_layers: int = 2
    d_ff: int = 96
    dropout: float = 0.0

    def __post_init__(self):
        if min(self.vocab_size, self.max_len, self.d_model,
               self.n_heads, self.n_layers, self.d_ff) <= 0:
            raise ValueError("모델 크기는 양수여야 합니다.")
        if self.d_model % self.n_heads != 0:
            raise ValueError("d_model은 n_heads로 나누어떨어져야 합니다.")
        if not 0 <= self.dropout < 1:
            raise ValueError("dropout은 0 이상 1 미만이어야 합니다.")

# %% 02_encoder.md / cell 7
class BertEmbeddings(nn.Module):
    def __init__(self, config):
        super().__init__()
        self.token = nn.Embedding(config.vocab_size, config.d_model,
                                  padding_idx=0)
        self.position = nn.Embedding(config.max_len, config.d_model)
        self.segment = nn.Embedding(2, config.d_model)
        self.norm = nn.LayerNorm(config.d_model, eps=1e-5)
        self.dropout = nn.Dropout(config.dropout)
        for table in (self.token, self.position, self.segment):
            nn.init.normal_(table.weight, mean=0.0, std=0.02)
        with torch.no_grad():
            self.token.weight[0].zero_()

    def forward(self, input_ids, token_type_ids=None, use_positions=True):
        if input_ids.ndim != 2 or input_ids.shape[1] == 0:
            raise ValueError("input_ids는 비어 있지 않은 [B,T] 배열이어야 합니다.")
        length = input_ids.shape[1]
        if length > self.position.num_embeddings:
            raise ValueError("입력 길이가 위치 테이블의 max_len을 넘었습니다.")
        if token_type_ids is None:
            token_type_ids = torch.zeros_like(input_ids)
        if token_type_ids.shape != input_ids.shape:
            raise ValueError("token_type_ids와 input_ids의 크기가 다릅니다.")
        hidden = self.token(input_ids) + self.segment(token_type_ids)
        if use_positions:
            positions = torch.arange(length, device=input_ids.device)[None, :]
            hidden = hidden + self.position(positions)
        return self.dropout(self.norm(hidden))

# %% 02_encoder.md / cell 9
torch.manual_seed(2026)
enc_demo_config = ModelConfig(vocab_size=tokenizer.vocab_size)
enc_demo_batch = pack_batch(["고양이 가 쥐 를 쫓다", "쥐 가 고양이 를 쫓다"])
enc_demo_embeddings = BertEmbeddings(enc_demo_config)
enc_demo_x = enc_demo_embeddings(
    enc_demo_batch["input_ids"], enc_demo_batch["token_type_ids"]
)
show_table(
    ["배열", "shape", "내용"],
    [["input_ids", list(enc_demo_batch["input_ids"].shape), "정수 ID"],
     ["token table", list(enc_demo_embeddings.token.weight.shape), "학습할 V×D개 수"],
     ["embedding 출력", list(enc_demo_x.shape), "위치별 입력 벡터"]],
)
assert enc_demo_x.shape[-1] == 48

# %% 02_encoder.md / cell 11
attn_small_q = torch.tensor([[1., 0.], [0., 1.], [1., 1.]])
attn_small_k = torch.tensor([[1., 0.], [0., 1.], [1., 1.]])
attn_small_v = torch.tensor([[10., 0.], [0., 20.], [5., 5.]])
attn_small_scores = attn_small_q @ attn_small_k.T / math.sqrt(2)
attn_small_weights = torch.softmax(attn_small_scores, dim=-1)
attn_small_output = attn_small_weights @ attn_small_v
attn_row0 = sum(attn_small_weights[0, j] * attn_small_v[j]
                for j in range(3))
assert torch.allclose(attn_row0, attn_small_output[0])
show_table(
    ["query 위치", "key별 점수", "key별 확률", "출력"],
    [[i, [round(x, 3) for x in attn_small_scores[i].tolist()],
      [round(x, 3) for x in attn_small_weights[i].tolist()],
      [round(x, 3) for x in attn_small_output[i].tolist()]] for i in range(3)],
)

# %% 02_encoder.md / cell 13
attn_large_scores = torch.tensor([1000., 1001., 1002.])
attn_stable_exp = torch.exp(attn_large_scores - attn_large_scores.max())
attn_manual_softmax = attn_stable_exp / attn_stable_exp.sum()
assert torch.allclose(attn_manual_softmax,
                      torch.softmax(attn_large_scores, dim=-1))
print("큰 점수에서도 유한한 확률:", attn_manual_softmax.tolist())

# %% 02_encoder.md / cell 15
attn_small_valid = torch.tensor([True, True, False])
attn_masked_scores = attn_small_scores.masked_fill(
    ~attn_small_valid[None, :], float("-inf")
)
attn_masked_weights = torch.softmax(attn_masked_scores, dim=-1)
assert torch.equal(attn_masked_weights[:, 2], torch.zeros(3))
assert torch.allclose(attn_masked_weights.sum(dim=-1), torch.ones(3))
print("PAD key의 확률:", attn_masked_weights[:, 2].tolist())
print("각 query가 읽는 확률의 합:", attn_masked_weights.sum(-1).tolist())

# %% 02_encoder.md / cell 17
attn_padding_allowed = attn_small_valid[None, :].expand(3, 3)
attn_causal_allowed = torch.tril(torch.ones(3, 3, dtype=torch.bool))
show_table(
    ["query 위치", "padding만 적용", "causal만 적용", "둘 다 적용"],
    [[i, attn_padding_allowed[i].int().tolist(),
      attn_causal_allowed[i].int().tolist(),
      (attn_padding_allowed & attn_causal_allowed)[i].int().tolist()]
     for i in range(3)],
)

# %% 02_encoder.md / cell 19
class MultiHeadSelfAttention(nn.Module):
    def __init__(self, config):
        super().__init__()
        self.n_heads = config.n_heads
        self.head_dim = config.d_model // config.n_heads
        self.q_proj = nn.Linear(config.d_model, config.d_model)
        self.k_proj = nn.Linear(config.d_model, config.d_model)
        self.v_proj = nn.Linear(config.d_model, config.d_model)
        self.out_proj = nn.Linear(config.d_model, config.d_model)
        self.dropout = nn.Dropout(config.dropout)

    def split_heads(self, hidden):
        batch, length, _ = hidden.shape
        return hidden.reshape(batch, length, self.n_heads,
                              self.head_dim).transpose(1, 2)

    def forward(self, hidden, attention_mask):
        if attention_mask.shape != hidden.shape[:2]:
            raise ValueError("attention_mask는 hidden의 [B,T]와 맞아야 합니다.")
        valid = attention_mask.bool()
        if not bool(valid.any(dim=1).all()):
            raise ValueError("각 입력에는 최소 한 개의 유효한 key가 필요합니다.")
        q = self.split_heads(self.q_proj(hidden))
        k = self.split_heads(self.k_proj(hidden))
        v = self.split_heads(self.v_proj(hidden))
        scores = (q @ k.transpose(-2, -1)) / math.sqrt(self.head_dim)
        scores = scores.masked_fill(~valid[:, None, None, :], float("-inf"))
        weights = torch.softmax(scores, dim=-1)
        context = self.dropout(weights) @ v
        batch, _, length, _ = context.shape
        merged = context.transpose(1, 2).contiguous().reshape(batch, length, -1)
        return self.out_proj(merged), weights

# %% 02_encoder.md / cell 21
enc_demo_attention = MultiHeadSelfAttention(enc_demo_config).eval()
enc_demo_attn_out, enc_demo_weights = enc_demo_attention(
    enc_demo_x, enc_demo_batch["attention_mask"]
)
enc_demo_q = enc_demo_attention.split_heads(enc_demo_attention.q_proj(enc_demo_x))
enc_demo_k = enc_demo_attention.split_heads(enc_demo_attention.k_proj(enc_demo_x))
enc_demo_v = enc_demo_attention.split_heads(enc_demo_attention.v_proj(enc_demo_x))
enc_demo_einsum = torch.einsum("bhid,bhjd->bhij", enc_demo_q, enc_demo_k)
assert torch.allclose(enc_demo_einsum, enc_demo_q @ enc_demo_k.transpose(-2, -1))
enc_demo_ref_heads = []
for h in range(enc_demo_config.n_heads):
    scores_h = enc_demo_q[:, h] @ enc_demo_k[:, h].transpose(-2, -1)
    scores_h = scores_h / math.sqrt(enc_demo_attention.head_dim)
    scores_h = scores_h.masked_fill(
        ~enc_demo_batch["attention_mask"][:, None, :].bool(), float("-inf")
    )
    enc_demo_ref_heads.append(torch.softmax(scores_h, -1) @ enc_demo_v[:, h])
enc_demo_ref = enc_demo_attention.out_proj(torch.cat(enc_demo_ref_heads, dim=-1))
assert torch.allclose(enc_demo_ref, enc_demo_attn_out, atol=1e-6)
print("head별 반복문과 벡터화 구현의 최대 오차:",
      float((enc_demo_ref - enc_demo_attn_out).abs().max().detach()))

# %% 02_encoder.md / cell 23
ln_demo_input = torch.tensor([[[1., 2., 5.], [3., 3., 6.]]])
ln_demo_layer = nn.LayerNorm(3, eps=1e-5)
ln_demo_mean = ln_demo_input.mean(dim=-1, keepdim=True)
ln_demo_var = ln_demo_input.var(dim=-1, keepdim=True, unbiased=False)
ln_demo_manual = (ln_demo_input - ln_demo_mean) / torch.sqrt(ln_demo_var + 1e-5)
assert torch.allclose(ln_demo_layer(ln_demo_input), ln_demo_manual, atol=1e-6)
print("토큰별 평균:", ln_demo_mean.flatten().tolist())
print("정규화된 토큰별 벡터:", ln_demo_manual.squeeze(0).tolist())

# %% 02_encoder.md / cell 25
class EncoderBlock(nn.Module):
    def __init__(self, config):
        super().__init__()
        self.attention = MultiHeadSelfAttention(config)
        self.attention_dropout = nn.Dropout(config.dropout)
        self.norm1 = nn.LayerNorm(config.d_model, eps=1e-5)
        self.ffn = nn.Sequential(
            nn.Linear(config.d_model, config.d_ff),
            nn.GELU(),
            nn.Linear(config.d_ff, config.d_model),
        )
        self.ffn_dropout = nn.Dropout(config.dropout)
        self.norm2 = nn.LayerNorm(config.d_model, eps=1e-5)

    def forward(self, hidden, attention_mask):
        attended, weights = self.attention(hidden, attention_mask)
        hidden = self.norm1(hidden + self.attention_dropout(attended))
        hidden = self.norm2(hidden + self.ffn_dropout(self.ffn(hidden)))
        return hidden, weights

# %% 02_encoder.md / cell 27
class TinyBert(nn.Module):
    def __init__(self, config):
        super().__init__()
        self.config = config
        self.embeddings = BertEmbeddings(config)
        self.layers = nn.ModuleList(
            [EncoderBlock(config) for _ in range(config.n_layers)]
        )

    def forward(self, input_ids, attention_mask, token_type_ids=None,
                use_positions=True, return_attentions=False):
        if input_ids.ndim != 2 or input_ids.numel() == 0:
            raise ValueError("input_ids는 비어 있지 않은 [B,T] 배열이어야 합니다.")
        if input_ids.dtype != torch.long:
            raise TypeError("input_ids는 torch.long이어야 합니다.")
        if attention_mask.shape != input_ids.shape:
            raise ValueError("attention_mask와 input_ids의 크기가 다릅니다.")
        if not bool(attention_mask.bool().any(dim=1).all()):
            raise ValueError("모든 위치가 PAD인 문장은 처리할 수 없습니다.")
        hidden = self.embeddings(input_ids, token_type_ids, use_positions)
        attentions = []
        for layer in self.layers:
            hidden, weights = layer(hidden, attention_mask)
            if return_attentions:
                attentions.append(weights)
        if return_attentions:
            return hidden, attentions
        return hidden

# %% 02_encoder.md / cell 29
torch.manual_seed(2026)
enc_demo_model = TinyBert(enc_demo_config).eval()
with torch.no_grad():
    enc_demo_hidden, enc_demo_attentions = enc_demo_model(
        enc_demo_batch["input_ids"],
        enc_demo_batch["attention_mask"],
        enc_demo_batch["token_type_ids"],
        return_attentions=True,
    )
show_table(
    ["대상", "값"],
    [["hidden shape", list(enc_demo_hidden.shape)],
     ["attention 하나의 shape", list(enc_demo_attentions[0].shape)],
     ["block 수", len(enc_demo_model.layers)],
     ["전체 파라미터 수", sum(p.numel() for p in enc_demo_model.parameters())],
     ["토큰 테이블 파라미터 수", enc_demo_model.embeddings.token.weight.numel()]],
)
assert enc_demo_model.layers[0].attention.q_proj.weight is not \
       enc_demo_model.layers[1].attention.q_proj.weight

# %% 02_encoder.md / cell 31
enc_pad_batch = pack_batch(["고양이 가 쥐 를 쫓다"])
enc_pad_ids = enc_pad_batch["input_ids"]
enc_pad_mask = enc_pad_batch["attention_mask"]
enc_pad_extra = 3
assert enc_pad_ids.shape[1] + enc_pad_extra <= enc_demo_config.max_len
enc_extended_ids = F.pad(enc_pad_ids, (0, enc_pad_extra), value=tokenizer.pad_id)
enc_extended_mask = F.pad(enc_pad_mask, (0, enc_pad_extra), value=False)
with torch.no_grad():
    enc_original_h = enc_demo_model(enc_pad_ids, enc_pad_mask)
    enc_extended_h = enc_demo_model(enc_extended_ids, enc_extended_mask)
enc_padding_error = (enc_original_h - enc_extended_h[:, :enc_pad_ids.shape[1]]).abs().max()
assert torch.allclose(enc_original_h, enc_extended_h[:, :enc_pad_ids.shape[1]], atol=1e-5)
print("PAD를 추가한 뒤 유효한 출력의 최대 오차:", float(enc_padding_error))

# %% 02_encoder.md / cell 33
enc_perm_length = enc_pad_ids.shape[1]
enc_permutation = torch.arange(enc_perm_length - 1, -1, -1)
with torch.no_grad():
    enc_no_position = enc_demo_model(enc_pad_ids, enc_pad_mask, use_positions=False)
    enc_permuted_no_position = enc_demo_model(
        enc_pad_ids[:, enc_permutation], enc_pad_mask[:, enc_permutation],
        use_positions=False,
    )
    enc_permuted_position = enc_demo_model(
        enc_pad_ids[:, enc_permutation], enc_pad_mask[:, enc_permutation]
    )
enc_equivariance_error = (
    enc_no_position[:, enc_permutation] - enc_permuted_no_position
).abs().max()
enc_position_difference = (
    enc_original_h[:, enc_permutation] - enc_permuted_position
).abs().max()
assert torch.allclose(enc_no_position[:, enc_permutation],
                      enc_permuted_no_position, atol=1e-5)
show_table(
    ["비교", "최대 절대 차이"],
    [["위치 없음: 입력 순열 = 출력 순열", float(enc_equivariance_error)],
     ["위치 있음: 두 계산이 달라질 수 있음", float(enc_position_difference)]],
)

# %% 02_encoder.md / cell 35
enc_plot_ids = enc_demo_batch["input_ids"][0].tolist()
enc_plot_labels = [str(i) for i in range(len(enc_plot_ids))]
show_table(["그림의 위치", "토큰 ID", "조각"],
           [[i, t, tokenizer.pieces[t]] for i, t in enumerate(enc_plot_ids)])
enc_plot_matrix = enc_demo_attentions[0][0, 0].cpu().numpy()
fig, ax = plt.subplots(figsize=(8, 6))
enc_plot_image = ax.imshow(enc_plot_matrix, cmap="Blues", vmin=0)
ax.set_xticks(range(len(enc_plot_labels)), enc_plot_labels, rotation=90)
ax.set_yticks(range(len(enc_plot_labels)), enc_plot_labels)
ax.set_xlabel("Key position (read from)")
ax.set_ylabel("Query position (read by)")
ax.set_title("Untrained encoder: layer 0, head 0")
fig.colorbar(enc_plot_image, ax=ax, label="Attention probability")
plt.tight_layout()
plt.show()
assert torch.allclose(enc_demo_attentions[0].sum(-1),
                      torch.ones_like(enc_demo_attentions[0].sum(-1)), atol=1e-6)

# %% 02_encoder.md / cell 37
axis_demo_scores = torch.tensor([[2., 0., 1.], [3., -1., 0.], [0., 1., 4.]])
axis_demo_right = torch.softmax(axis_demo_scores, dim=-1)
axis_demo_wrong = torch.softmax(axis_demo_scores, dim=-2)
show_table(
    ["구현", "행의 합", "열의 합"],
    [["마지막 축", axis_demo_right.sum(-1).tolist(), axis_demo_right.sum(-2).tolist()],
     ["끝에서 두 번째 축", axis_demo_wrong.sum(-1).tolist(),
      axis_demo_wrong.sum(-2).tolist()]],
)
assert torch.allclose(axis_demo_right.sum(-1), torch.ones(3))
assert not torch.allclose(axis_demo_wrong.sum(-1), torch.ones(3))

# %% 03_mlm.md / cell 1
MLM_IGNORE = -100
MLM_FIRST_CONTENT_ID = 5  # 0..4 = PAD, UNK, CLS, SEP, MASK
MLM_MASK_ID = 4

def make_mlm_batch(clean_batch, generator, probability=0.15, mask_only=False):
    """원본 batch를 보존하고, 손상 입력과 별도 정답을 만든다. CPU 실습용."""
    if not 0.0 < probability <= 1.0:
        raise ValueError("probability는 (0, 1]이어야 합니다.")
    if tokenizer.vocab_size <= MLM_FIRST_CONTENT_ID:
        raise ValueError("일반 토큰이 한 개 이상 필요합니다.")
    original = clean_batch["input_ids"]
    eligible = clean_batch["attention_mask"].bool() & (original >= MLM_FIRST_CONTENT_ID)
    if not eligible.any(dim=1).all():
        raise ValueError("각 문장에 MLM 대상으로 쓸 일반 토큰이 필요합니다.")
    selected = (torch.rand(original.shape, generator=generator) < probability) & eligible
    for row in range(original.size(0)):
        if not selected[row].any():
            candidates = eligible[row].nonzero(as_tuple=True)[0]
            choice = torch.randint(len(candidates), (1,), generator=generator).item()
            selected[row, candidates[choice]] = True

    labels = torch.full_like(original, MLM_IGNORE)
    labels[selected] = original[selected]  # 입력을 바꾸기 전에 정답을 저장한다.
    changed = {key: value.clone() for key, value in clean_batch.items()}
    branch = torch.rand(original.shape, generator=generator)
    masked = selected if mask_only else selected & (branch < 0.8)
    randomized = torch.zeros_like(selected) if mask_only else selected & (branch >= 0.8) & (branch < 0.9)
    unchanged = selected & ~(masked | randomized)
    replacement = torch.randint(
        MLM_FIRST_CONTENT_ID, tokenizer.vocab_size, original.shape, generator=generator
    )
    changed["input_ids"][masked] = MLM_MASK_ID
    changed["input_ids"][randomized] = replacement[randomized]
    return changed, labels, {"selected": selected, "masked": masked,
                             "randomized": randomized, "unchanged": unchanged}

mlm_corpus = list(dict.fromkeys(DOCS + [query for query, _ in TRAIN]))
mlm_clean = pack_batch(mlm_corpus)
preview_clean = pack_batch([DOCS[0], DOCS[1]])
preview_batch, preview_labels, preview_marks = make_mlm_batch(
    preview_clean, torch.Generator().manual_seed(31), probability=0.4, mask_only=True
)
preview_rows = []
for position in range(int(preview_clean["attention_mask"][0].sum())):
    original_id = int(preview_clean["input_ids"][0, position])
    changed_id = int(preview_batch["input_ids"][0, position])
    label = int(preview_labels[0, position])
    preview_rows.append([position, tokenizer.pieces[original_id],
                         tokenizer.pieces[changed_id], label,
                         "loss에 포함" if label != MLM_IGNORE else "제외"])
show_table(["위치", "원문 토큰", "encoder가 보는 토큰", "정답 ID", "용도"], preview_rows)
assert preview_marks["selected"].any(dim=1).all()
assert torch.equal(preview_batch["attention_mask"], preview_clean["attention_mask"])
assert torch.all(preview_batch["input_ids"][preview_marks["selected"]] == MLM_MASK_ID)
assert torch.all(preview_labels[~preview_marks["selected"]] == MLM_IGNORE)

# %% 03_mlm.md / cell 3
class MaskedLanguageModel(nn.Module):
    def __init__(self, config):
        super().__init__()
        self.encoder = TinyBert(config)
        self.dense = nn.Linear(config.d_model, config.d_model)
        self.norm = nn.LayerNorm(config.d_model)
        self.vocab_bias = nn.Parameter(torch.zeros(config.vocab_size))
        forbidden = torch.arange(config.vocab_size) < MLM_FIRST_CONTENT_ID
        self.register_buffer("forbidden_output", forbidden)

    def forward(self, input_ids, attention_mask, token_type_ids=None):
        hidden = self.encoder(input_ids, attention_mask, token_type_ids)
        transformed = self.norm(F.gelu(self.dense(hidden)))
        logits = F.linear(transformed, self.encoder.embeddings.token.weight, self.vocab_bias)
        # 이 교재의 정답은 일반 토큰뿐이다. 특수 ID는 출력 후보에서 제외한다.
        return logits.masked_fill(self.forbidden_output, float("-inf"))

def mlm_forward(model, batch):
    return model(batch["input_ids"], batch["attention_mask"], batch["token_type_ids"])

def mlm_loss(logits, labels):
    if not (labels != MLM_IGNORE).any():
        raise ValueError("복원 정답이 없습니다. 전부 ignore인 loss는 계산하지 않습니다.")
    return F.cross_entropy(
        logits.reshape(-1, logits.size(-1)), labels.reshape(-1), ignore_index=MLM_IGNORE
    )

torch.manual_seed(41)
encoder_config = ModelConfig(vocab_size=tokenizer.vocab_size)
mlm_model = MaskedLanguageModel(encoder_config)
preview_logits = mlm_forward(mlm_model, preview_batch)
print("encoder 입력:", tuple(preview_batch["input_ids"].shape))
print("vocabulary 점수:", tuple(preview_logits.shape))
print("복원할 위치 수:", int((preview_labels != MLM_IGNORE).sum()))
print("초기 loss:", round(float(mlm_loss(preview_logits, preview_labels).detach()), 4))

# %% 03_mlm.md / cell 5
selected_logits = preview_logits[preview_labels != MLM_IGNORE]  # [선택 위치 수, V]
selected_targets = preview_labels[preview_labels != MLM_IGNORE]
log_probabilities = selected_logits.log_softmax(dim=-1)
manual_terms = -log_probabilities[torch.arange(len(selected_targets)), selected_targets]
manual_loss = manual_terms.mean()
library_loss = mlm_loss(preview_logits, preview_labels)
torch.testing.assert_close(manual_loss, library_loss)
show_table(["선택 위치", "정답 토큰", "정답 확률", "-log 확률"], [
    [i, tokenizer.pieces[int(selected_targets[i])],
     f"{float((-manual_terms[i]).exp().detach()):.5f}",
     f"{float(manual_terms[i].detach()):.4f}"]
    for i in range(min(6, len(selected_targets)))
])
print("손계산 평균과 cross_entropy의 차이:", float((manual_loss - library_loss).abs().detach()))

# %% 03_mlm.md / cell 7
torch.manual_seed(42)
toy_table = nn.Embedding(8, 3, padding_idx=0)
toy_ids = torch.tensor([5])
toy_target = torch.tensor([6])
toy_forbidden = torch.arange(8) < MLM_FIRST_CONTENT_ID

def inspect_tied_grad(block_special):
    toy_table.zero_grad(set_to_none=True)
    representation = toy_table(toy_ids)  # [1, 3]
    scores = F.linear(representation, toy_table.weight)  # [1, 8]
    if block_special:
        scores = scores.masked_fill(toy_forbidden, float("-inf"))
    F.cross_entropy(scores, toy_target).backward()
    return toy_table.weight.grad.detach().norm(dim=-1).clone()

all_output_grad = inspect_tied_grad(False)
content_output_grad = inspect_tied_grad(True)
show_table(["행", "입력에 등장", "전체 ID를 출력 후보로", "일반 ID만 출력 후보로"], [
    [token_id, token_id == 5, f"{float(all_output_grad[token_id]):.6f}",
     f"{float(content_output_grad[token_id]):.6f}"] for token_id in [0, 5, 6, 7]
])
assert all_output_grad[0] > 0             # padding_idx만으로는 막히지 않는다.
assert content_output_grad[0] == 0        # 출력 경로도 막았을 때 0이다.
assert content_output_grad[7] > 0         # 입력에 없던 일반 토큰도 업데이트된다.

# %% 03_mlm.md / cell 9
diagnostic_batch, diagnostic_labels, diagnostic_marks = make_mlm_batch(
    mlm_clean, torch.Generator().manual_seed(44), probability=0.2, mask_only=True
)

@torch.no_grad()
def diagnose_mlm(model, batch, labels):
    was_training = model.training
    model.eval()
    logits = mlm_forward(model, batch)
    active = labels != MLM_IGNORE
    metrics = {
        "loss": float(mlm_loss(logits, labels)),
        "accuracy": float((logits.argmax(-1)[active] == labels[active]).float().mean()),
        "count": int(active.sum()),
    }
    model.train(was_training)
    return metrics

mlm_before = diagnose_mlm(mlm_model, diagnostic_batch, diagnostic_labels)
print("고정 진단 위치:", mlm_before["count"])
print("학습 전 loss:", round(mlm_before["loss"], 4),
      "정확도:", f"{mlm_before['accuracy']:.1%}")

# %% 03_mlm.md / cell 11
torch.set_num_threads(1)
mlm_training_rng = torch.Generator().manual_seed(45)
mlm_optimizer = torch.optim.AdamW(mlm_model.parameters(), lr=3e-3, weight_decay=0.01)
mlm_history = []
mlm_steps = 96
mlm_batch_size = min(16, len(mlm_corpus))
mlm_started = time.perf_counter()
mlm_model.train()
mlm_embedding_before = mlm_model.encoder.embeddings.token.weight.detach().clone()

for step in range(mlm_steps):
    indices = torch.randint(len(mlm_corpus), (mlm_batch_size,), generator=mlm_training_rng)
    clean = {key: value[indices] for key, value in mlm_clean.items()}
    damaged, labels, _ = make_mlm_batch(clean, mlm_training_rng)
    mlm_optimizer.zero_grad(set_to_none=True)
    logits = mlm_forward(mlm_model, damaged)
    loss = mlm_loss(logits, labels)
    if not torch.isfinite(loss):
        raise FloatingPointError(f"MLM step {step}에서 loss가 유한하지 않습니다.")
    loss.backward()
    nn.utils.clip_grad_norm_(mlm_model.parameters(), max_norm=1.0)
    assert torch.count_nonzero(mlm_model.encoder.embeddings.token.weight.grad[0]) == 0
    mlm_optimizer.step()
    mlm_history.append(float(loss.detach()))

mlm_after = diagnose_mlm(mlm_model, diagnostic_batch, diagnostic_labels)
pretrained_encoder = copy.deepcopy(mlm_model.encoder).eval()
assert torch.count_nonzero(pretrained_encoder.embeddings.token.weight[0]) == 0
show_table(["고정 빈칸 진단", "학습 전", "학습 후"], [
    ["loss", f"{mlm_before['loss']:.4f}", f"{mlm_after['loss']:.4f}"],
    ["선택 토큰 정확도", f"{mlm_before['accuracy']:.1%}", f"{mlm_after['accuracy']:.1%}"],
])
print(f"{mlm_steps} step / {time.perf_counter() - mlm_started:.2f}초")
print("토큰 테이블 변화의 L2 norm:", round(float(
    (pretrained_encoder.embeddings.token.weight.detach() - mlm_embedding_before).norm()
), 4))

# %% 03_mlm.md / cell 13
fig, ax = plt.subplots(figsize=(7, 2.7))
ax.plot(range(1, len(mlm_history) + 1), mlm_history, alpha=0.45, label="new corruption each step")
window = 8
running = np.convolve(mlm_history, np.ones(window) / window, mode="valid")
ax.plot(range(window, len(mlm_history) + 1), running, label="8-step mean")
ax.set(xlabel="Optimizer step", ylabel="MLM cross-entropy", title="Training corpus, dynamic corruption")
ax.legend()
plt.tight_layout()
plt.show()

mlm_model.eval()
with torch.no_grad():
    diagnostic_predictions = mlm_forward(mlm_model, diagnostic_batch).argmax(-1)
examples = []
for row, position in diagnostic_marks["selected"].nonzero().tolist()[:10]:
    target_id = int(diagnostic_labels[row, position])
    prediction_id = int(diagnostic_predictions[row, position])
    examples.append([mlm_corpus[row], position, tokenizer.pieces[target_id],
                     tokenizer.pieces[prediction_id], target_id == prediction_id])
show_table(["원문", "가린 위치", "정답 조각", "예측 조각", "일치"], examples)

# %% 03_mlm.md / cell 15
# 연습 해설 1: 모든 일반 토큰을 숨겨도 attention_mask는 유지된다.
fully_hidden, fully_hidden_labels, _ = make_mlm_batch(
    preview_clean, torch.Generator().manual_seed(48), probability=1.0, mask_only=True
)
content_positions = preview_clean["input_ids"] >= MLM_FIRST_CONTENT_ID
assert torch.all(fully_hidden["input_ids"][content_positions] == MLM_MASK_ID)
assert torch.equal(fully_hidden["attention_mask"], preview_clean["attention_mask"])
assert torch.equal(fully_hidden_labels[content_positions], preview_clean["input_ids"][content_positions])

# 연습 해설 2: 무시한 위치에는 직접적인 출력 loss의 gradient가 없다.
torch.manual_seed(49)
exercise_logits = torch.randn(1, 3, 8, requires_grad=True)
exercise_labels = torch.tensor([[6, MLM_IGNORE, 5]])
exercise_loss = mlm_loss(exercise_logits, exercise_labels)
exercise_gradient, = torch.autograd.grad(exercise_loss, exercise_logits)
perturbed = exercise_logits.detach().clone()
perturbed[0, 1] = torch.arange(8) * 100.0
torch.testing.assert_close(exercise_loss.detach(), mlm_loss(perturbed, exercise_labels))
assert torch.count_nonzero(exercise_gradient[0, 1]) == 0
print("전체 가림과 ignore_index의 값·미분 확인 완료")

# %% 04_sentence_vectors.md / cell 1
def masked_mean(hidden, pool_mask):
    counts = pool_mask.sum(dim=1, keepdim=True)
    if (counts == 0).any():
        raise ValueError("평균을 낼 내용 토큰이 없는 문장이 있습니다.")
    weights = pool_mask.unsqueeze(-1).to(hidden.dtype)
    return (hidden * weights).sum(dim=1) / counts.to(hidden.dtype)

pool_example = torch.tensor([[[1., 2.], [3., 4.], [100., 100.]]])
pool_example_mask = torch.tensor([[True, True, False]])
print("올바른 평균:", masked_mean(pool_example, pool_example_mask))
print("mask를 생략한 평균:", pool_example.mean(dim=1))
torch.testing.assert_close(masked_mean(pool_example, pool_example_mask), torch.tensor([[2., 3.]]))

# %% 04_sentence_vectors.md / cell 3
class SentenceEncoder(nn.Module):
    def __init__(self, encoder, output_dim=32, pooling="mean", use_positions=True):
        super().__init__()
        if pooling not in {"mean", "cls"}:
            raise ValueError("pooling은 mean 또는 cls여야 합니다.")
        self.encoder = encoder
        self.max_len = encoder.config.max_len
        self.pooling = pooling
        self.use_positions = use_positions
        self.output_dim = output_dim
        self.projection = nn.Linear(encoder.config.d_model, output_dim, bias=False)

    def forward(self, batch):
        hidden = self.encoder(
            batch["input_ids"], batch["attention_mask"], batch["token_type_ids"],
            use_positions=self.use_positions,
        )
        pooled = masked_mean(hidden, batch["pool_mask"]) if self.pooling == "mean" else hidden[:, 0]
        projected = self.projection(pooled)
        return F.normalize(projected, p=2, dim=-1, eps=1e-12)

def encode_texts(model, texts, tokenizer=tokenizer):
    return model(pack_batch(texts, tokenizer=tokenizer, max_len=model.max_len))

torch.manual_seed(17)
initial_retriever = SentenceEncoder(copy.deepcopy(pretrained_encoder)).eval()
with torch.no_grad():
    sample_vectors = encode_texts(initial_retriever, DOCS[:3])
show_table(["내용", "값"], [
    ["문장 벡터 shape", tuple(sample_vectors.shape)],
    ["각 벡터의 L2 norm", [round(x, 5) for x in sample_vectors.norm(dim=-1).tolist()]],
    ["문서 0과 1의 cosine", round(float(sample_vectors[0] @ sample_vectors[1]), 5)],
])

# %% 04_sentence_vectors.md / cell 5
torch.manual_seed(19)
rotation, _ = torch.linalg.qr(torch.randn(32, 32))
original_scores = sample_vectors @ sample_vectors.T
rotated_vectors = sample_vectors @ rotation
rotated_scores = rotated_vectors @ rotated_vectors.T
torch.testing.assert_close(original_scores, rotated_scores, atol=1e-6, rtol=1e-5)
print("좌표를 회전시킨 뒤 점수의 최대 차이:", float((original_scores - rotated_scores).abs().max()))

# %% 04_sentence_vectors.md / cell 7
class MeanRetriever(nn.Module):
    def __init__(self, token_embedding, output_dim=32, max_len=96):
        super().__init__()
        self.token = copy.deepcopy(token_embedding)
        self.max_len = max_len
        self.projection = nn.Linear(token_embedding.embedding_dim, output_dim, bias=False)

    def forward(self, batch):
        ids = batch["input_ids"]
        vectors = self.token(ids)
        # 같은 multiset은 합산 순서까지 맞춰 부동소수점 오차에 의한 가짜 순위를 없앤다.
        order = ids.argsort(dim=1, stable=True)
        vectors = vectors.gather(1, order.unsqueeze(-1).expand_as(vectors))
        pool_mask = batch["pool_mask"].gather(1, order)
        pooled = masked_mean(vectors, pool_mask)
        return F.normalize(self.projection(pooled), dim=-1)

torch.manual_seed(17)
mean_initial = MeanRetriever(pretrained_encoder.embeddings.token, max_len=encoder_config.max_len).eval()
pair_ids = [0, 1]
pair_batch = pack_batch([DOCS[i] for i in pair_ids])
content_id_rows = [row[mask].tolist() for row, mask in zip(pair_batch["input_ids"], pair_batch["pool_mask"])]
assert sorted(content_id_rows[0]) == sorted(content_id_rows[1])
with torch.no_grad():
    pair_mean_vectors = mean_initial(pair_batch)
torch.testing.assert_close(pair_mean_vectors[0], pair_mean_vectors[1], atol=0, rtol=0)
print("같은 BPE 토큰 구성:", sorted(content_id_rows[0]) == sorted(content_id_rows[1]))
print("평균 모델의 두 문서 벡터 차이:", float((pair_mean_vectors[0] - pair_mean_vectors[1]).norm()))

# %% 05_retrieval.md / cell 1
train_batch = pack_batch([query for query, _ in TRAIN], max_len=encoder_config.max_len)
document_batch = pack_batch(DOCS, max_len=encoder_config.max_len)
train_targets = torch.tensor([target for _, target in TRAIN], dtype=torch.long)

with torch.no_grad():
    Q = initial_retriever(train_batch)
    D = initial_retriever(document_batch)
    S = Q @ D.T
print("Q:", tuple(Q.shape), "D:", tuple(D.shape), "S:", tuple(S.shape))
show_table(["질의", "정답 열", "그 열의 문서"],
           [(query, target, DOC_NAMES[target]) for query, target in TRAIN[:5]])

# %% 05_retrieval.md / cell 3
temperature = 0.1
tiny_logits = torch.tensor([[2., 1., -1.]])
tiny_target = torch.tensor([0])
manual_loss = torch.logsumexp(tiny_logits, dim=1) - tiny_logits[:, 0]
library_loss = F.cross_entropy(tiny_logits, tiny_target)
torch.testing.assert_close(manual_loss.mean(), library_loss)
print("logsumexp로 계산:", float(manual_loss))
print("cross_entropy로 계산:", float(library_loss))
print("실제 검색 초기 loss:", float(F.cross_entropy(S / temperature, train_targets)))

# %% 05_retrieval.md / cell 5
temperature_rows = []
for tau in [1.0, 0.1, 0.01]:
    fixed_scores = torch.tensor([[0.8, 0.7, 0.1]], requires_grad=True)
    tau_loss = F.cross_entropy(fixed_scores / tau, torch.tensor([0]))
    tau_gradient, = torch.autograd.grad(tau_loss, fixed_scores)
    tau_probabilities = (fixed_scores.detach() / tau).softmax(-1)
    temperature_rows.append([
        tau, [round(p, 5) for p in tau_probabilities[0].tolist()],
        round(tau_loss.item(), 6), [round(g, 5) for g in tau_gradient[0].tolist()],
    ])
show_table(["temperature", "후보 확률", "loss", "점수 gradient"], temperature_rows)

# %% 05_retrieval.md / cell 7
gradient_model = copy.deepcopy(initial_retriever).double()
gradient_model.zero_grad(set_to_none=True)
one_query, one_target = TRAIN[0]
one_batch = pack_batch([one_query])
zq = gradient_model(one_batch)
zd = gradient_model(document_batch)
single_scores = zq @ zd.T
single_scores.retain_grad()
single_loss = F.cross_entropy(single_scores / temperature, torch.tensor([one_target]))
single_loss.backward()

probabilities = (single_scores.detach() / temperature).softmax(dim=-1)
expected_gradient = probabilities.clone()
expected_gradient[0, one_target] -= 1
expected_gradient /= temperature
torch.testing.assert_close(single_scores.grad, expected_gradient)
show_table(["문서", "정답", "p", "dL/ds"], [
    [DOC_NAMES[j], j == one_target, round(float(probabilities[0, j]), 5),
     round(float(single_scores.grad[0, j]), 5)] for j in range(len(DOCS))
])

# %% 05_retrieval.md / cell 9
embedding_gradient = gradient_model.encoder.embeddings.token.weight.grad.detach().clone()
query_token_ids = sorted(set(tokenizer.encode(one_query, add_special_tokens=False)))
show_table(["ID", "조각", "임베딩 행 gradient의 norm"], [
    [token_id, tokenizer.pieces[token_id], round(float(embedding_gradient[token_id].norm()), 6)]
    for token_id in query_token_ids
])
assert embedding_gradient[tokenizer.pad_id].abs().max().item() == 0

# 검색 모델에는 MLM 출력층이 없으므로, 어느 입력에서도 조회하지 않은 행의 데이터 gradient는 0이다.
used_ids = set(one_batch["input_ids"].flatten().tolist() + document_batch["input_ids"].flatten().tolist())
unused_ids = [i for i in range(tokenizer.vocab_size) if i not in used_ids]
assert unused_ids
assert embedding_gradient[unused_ids].abs().max().item() == 0
print("이번 forward에서 미조회한 행 수:", len(unused_ids))

# %% 05_retrieval.md / cell 11
E_parameter = gradient_model.encoder.embeddings.token.weight
largest_coordinate = embedding_gradient.abs().argmax().item()
row_id, column_id = divmod(largest_coordinate, E_parameter.shape[1])
epsilon = 1e-6
with torch.no_grad():
    original_value = E_parameter[row_id, column_id].item()
    E_parameter[row_id, column_id] = original_value + epsilon
    loss_plus = F.cross_entropy(gradient_model(one_batch) @ gradient_model(document_batch).T / temperature,
                                torch.tensor([one_target])).item()
    E_parameter[row_id, column_id] = original_value - epsilon
    loss_minus = F.cross_entropy(gradient_model(one_batch) @ gradient_model(document_batch).T / temperature,
                                 torch.tensor([one_target])).item()
    E_parameter[row_id, column_id] = original_value
numeric_gradient = (loss_plus - loss_minus) / (2 * epsilon)
autograd_gradient = embedding_gradient[row_id, column_id].item()
assert math.isclose(numeric_gradient, autograd_gradient, rel_tol=2e-4, abs_tol=2e-6)
show_table(["확인한 좌표", "값"], [
    [f"E[{row_id}, {column_id}] ({tokenizer.pieces[row_id]})", original_value],
    ["autograd", autograd_gradient], ["중앙 차분", numeric_gradient],
])

# %% 05_retrieval.md / cell 13
@torch.no_grad()
def evaluate_retrieval(model, pairs, docs=DOCS, tokenizer=tokenizer):
    previous_mode = model.training
    model.eval()
    query_vectors = encode_texts(model, [query for query, _ in pairs], tokenizer)
    document_vectors = encode_texts(model, docs, tokenizer)
    scores = query_vectors @ document_vectors.T
    order = scores.argsort(dim=1, descending=True, stable=True)
    targets = torch.tensor([target for _, target in pairs])
    ranks = (order == targets[:, None]).nonzero(as_tuple=False)[:, 1] + 1
    metrics = {
        "Recall@1": (ranks <= 1).float().mean().item(),
        "Recall@3": (ranks <= 3).float().mean().item(),
        "MRR": ranks.float().reciprocal().mean().item(),
    }
    rows = [{"query": query, "target": target, "rank": int(ranks[i]),
             "top3": order[i, :3].tolist()}
            for i, (query, target) in enumerate(pairs)]
    model.train(previous_mode)
    return metrics, rows

initial_metrics, initial_rows = evaluate_retrieval(initial_retriever, VALID)
show_table(["지표", "검색 학습 전"], [[key, round(value, 4)] for key, value in initial_metrics.items()])

# %% 05_retrieval.md / cell 15
@dataclass
class RetrievalTraining:
    steps: int = 300
    learning_rate: float = 0.003
    temperature: float = 0.1

def train_retriever(model, training, freeze_tokens=False):
    if training.steps < 1 or training.temperature <= 0 or training.learning_rate <= 0:
        raise ValueError("steps, temperature, learning_rate는 양수여야 합니다.")
    token_weight = model.token.weight if isinstance(model, MeanRetriever) else model.encoder.embeddings.token.weight
    token_weight.requires_grad_(not freeze_tokens)
    before_weights = token_weight.detach().clone()
    optimizer = torch.optim.Adam([p for p in model.parameters() if p.requires_grad],
                                 lr=training.learning_rate, weight_decay=0)
    history = []
    model.train()
    for step in range(training.steps):
        optimizer.zero_grad(set_to_none=True)
        query_vectors = model(train_batch)
        document_vectors = model(document_batch)
        logits = query_vectors @ document_vectors.T / training.temperature
        loss = F.cross_entropy(logits, train_targets)
        loss.backward()
        optimizer.step()
        history.append(loss.detach().item())
    model.eval()
    table_change = float((token_weight.detach() - before_weights).norm())
    if freeze_tokens:
        assert table_change == 0
    else:
        assert table_change > 0
    assert token_weight[tokenizer.pad_id].abs().max().item() == 0
    return history, table_change

retrieval_training = RetrievalTraining()
mean_model = copy.deepcopy(mean_initial)
retriever = copy.deepcopy(initial_retriever)
mean_history, mean_table_change = train_retriever(mean_model, retrieval_training)
retrieval_history, retrieval_table_change = train_retriever(retriever, retrieval_training)

# %% 05_retrieval.md / cell 17
mean_metrics, mean_rows = evaluate_retrieval(mean_model, VALID)
retrieval_metrics, retrieval_rows = evaluate_retrieval(retriever, VALID)
show_table(["구조", "검증 Recall@1", "검증 Recall@3", "검증 MRR", "E의 변화량"], [
    ["평균", *(round(mean_metrics[k], 4) for k in ("Recall@1", "Recall@3", "MRR")),
     round(mean_table_change, 5)],
    ["문맥 encoder", *(round(retrieval_metrics[k], 4) for k in ("Recall@1", "Recall@3", "MRR")),
     round(retrieval_table_change, 5)],
])
fig, axes = plt.subplots(1, 2, figsize=(10, 3.5))
axes[0].plot(mean_history, label="Mean")
axes[0].plot(retrieval_history, label="Contextual")
axes[0].axhline(0.5 * math.log(2), color="gray", linestyle="--", label="Mean lower bound")
axes[0].set(xlabel="Update", ylabel="Training cross entropy")
axes[0].legend()
axes[1].bar(["Before", "Mean", "Contextual"],
            [initial_metrics["Recall@1"], mean_metrics["Recall@1"], retrieval_metrics["Recall@1"]])
axes[1].set(ylim=(0, 1.05), ylabel="Validation Recall@1")
fig.tight_layout()
fig.savefig(ARTIFACT_DIR / "retrieval_training.svg")
fig.savefig(ARTIFACT_DIR / "retrieval_training.png", dpi=160)
plt.show()

# %% 05_retrieval.md / cell 19
show_table(["평균 모델", "값"], [
    ["구조에서 나온 loss 하한", round(0.5 * math.log(2), 6)],
    ["관측한 마지막 training loss", round(mean_history[-1], 6)],
    ["검증 Recall@1 상한", 0.75],
    ["관측한 검증 Recall@1", mean_metrics["Recall@1"]],
])
assert mean_metrics["Recall@1"] <= 0.75 + 1e-6
assert mean_history[-1] >= 0.5 * math.log(2) - 1e-5

# %% 05_retrieval.md / cell 21
def positive_set_loss(logits, positive_mask):
    if positive_mask.shape != logits.shape or not positive_mask.any(dim=1).all():
        raise ValueError("각 질의에 적어도 하나의 positive가 필요합니다.")
    positive_logits = logits.masked_fill(~positive_mask, float("-inf"))
    return (torch.logsumexp(logits, dim=1) - torch.logsumexp(positive_logits, dim=1)).mean()

set_logits = torch.tensor([[5., 0., -2.]], requires_grad=True)
set_mask = torch.tensor([[True, True, False]])
set_loss = positive_set_loss(set_logits, set_mask)
set_loss.backward()
print("두 문서가 정답인 집합 loss:", round(set_loss.item(), 6))
print("softmax 확률:", set_logits.detach().softmax(-1).tolist())
print("각 logit의 gradient:", set_logits.grad.tolist())

# %% 06_search_and_checks.md / cell 1
no_position_model = copy.deepcopy(retriever).eval()
no_position_model.use_positions = False
order_diagnostics = []
with torch.no_grad():
    for left, right in ORDER_PAIRS:
        texts = [DOCS[left], DOCS[right]]
        normal_vectors = encode_texts(retriever, texts)
        no_position_vectors = encode_texts(no_position_model, texts)
        average_vectors = encode_texts(mean_model, texts)
        no_position_gap = float((no_position_vectors[0] - no_position_vectors[1]).norm())
        order_diagnostics.append([
            f"{left} / {right}", float((normal_vectors[0] - normal_vectors[1]).norm()),
            no_position_gap, float((average_vectors[0] - average_vectors[1]).norm()),
        ])
        torch.testing.assert_close(no_position_vectors[0], no_position_vectors[1], atol=2e-5, rtol=2e-5)
show_table(["문서 쌍", "학습된 문맥 모델 거리", "위치 제거 후 거리", "평균 모델 거리"], order_diagnostics)

# %% 06_search_and_checks.md / cell 3
frozen_retriever = copy.deepcopy(initial_retriever)
frozen_history, frozen_table_change = train_retriever(
    frozen_retriever, retrieval_training, freeze_tokens=True
)
frozen_metrics, _ = evaluate_retrieval(frozen_retriever, VALID)
assert frozen_table_change == 0
show_table(["학습할 파라미터", "검증 Recall@1", "검증 MRR", "E 변화량"], [
    ["전체", retrieval_metrics["Recall@1"], retrieval_metrics["MRR"], retrieval_table_change],
    ["E를 제외한 나머지", frozen_metrics["Recall@1"], frozen_metrics["MRR"], frozen_table_change],
])

# %% 06_search_and_checks.md / cell 5
padding_batch = pack_batch([DOCS[0]])
longer_batch = {
    "input_ids": F.pad(padding_batch["input_ids"], (0, 5), value=tokenizer.pad_id),
    "attention_mask": F.pad(padding_batch["attention_mask"], (0, 5), value=False),
    "pool_mask": F.pad(padding_batch["pool_mask"], (0, 5), value=False),
    "token_type_ids": F.pad(padding_batch["token_type_ids"], (0, 5), value=0),
}
with torch.no_grad():
    ordinary_vector = retriever(padding_batch)
    padded_vector = retriever(longer_batch)
torch.testing.assert_close(ordinary_vector, padded_vector, atol=2e-5, rtol=2e-5)
padding_error = float((ordinary_vector - padded_vector).abs().max())
print("padding 추가 후 좌표별 최대 차이:", padding_error)

# %% 06_search_and_checks.md / cell 7
retriever.eval()
with torch.no_grad():
    document_index = encode_texts(retriever, DOCS).detach().clone()
assert document_index.shape == (len(DOCS), 32)
torch.testing.assert_close(document_index.norm(dim=1), torch.ones(len(DOCS)), atol=1e-6, rtol=1e-5)

@torch.no_grad()
def search_documents(query, model, tokenizer, document_vectors, documents, names, top_k=3):
    if not 1 <= top_k <= len(documents):
        raise ValueError("top_k는 1 이상 문서 수 이하여야 합니다.")
    if document_vectors.shape[0] != len(documents) or len(names) != len(documents):
        raise ValueError("벡터의 행 순서와 문서 목록이 맞아야 합니다.")
    model.eval()
    batch = pack_batch([query], tokenizer=tokenizer, max_len=model.max_len)
    query_vector = model(batch)
    scores = (query_vector @ document_vectors.T)[0]
    if not torch.isfinite(scores).all():
        raise FloatingPointError("검색 점수에 NaN 또는 무한대가 있습니다.")
    ranking = scores.argsort(descending=True, stable=True)[:top_k].tolist()
    content_ids = batch["input_ids"][batch["pool_mask"]]
    unknown_count = int((content_ids == tokenizer.unk_id).sum())
    rows = [{"id": index, "score": float(scores[index]), "name": names[index], "text": documents[index]}
            for index in ranking]
    return rows, {"unknown_tokens": unknown_count, "content_tokens": len(content_ids)}

my_query = "쥐 가 고양이 를 뒤쫓다 장면"
hits, input_info = search_documents(my_query, retriever, tokenizer, document_index, DOCS, DOC_NAMES)
print("질의:", my_query, "/ 토큰 정보:", input_info)
show_table(["순위", "문서 ID", "cosine", "문서"],
           [[rank, hit["id"], round(hit["score"], 5), hit["text"]] for rank, hit in enumerate(hits, 1)])

# %% 06_search_and_checks.md / cell 9
oov_rows = []
for query in ["고양이쥐", "패스워드 리커버리", "고양이 🧬"]:
    oov_hits, info = search_documents(query, retriever, tokenizer, document_index, DOCS, DOC_NAMES)
    oov_rows.append([query, info["unknown_tokens"], info["content_tokens"],
                     oov_hits[0]["name"], round(oov_hits[0]["score"], 4)])
show_table(["입력", "UNK 수", "내용 토큰 수", "반환된 1위", "점수"], oov_rows)

# %% 06_search_and_checks.md / cell 11
bundle = {
    "format_version": 1,
    "tokenizer": tokenizer.to_dict(),
    "encoder_config": asdict(encoder_config),
    "retriever_config": {"output_dim": retriever.output_dim,
                         "pooling": retriever.pooling, "use_positions": retriever.use_positions},
    "state_dict": retriever.state_dict(),
    "documents": list(DOCS),
    "document_names": list(DOC_NAMES),
    "document_vectors": document_index,
}
bundle_path = ARTIFACT_DIR / "retriever.pt"
torch.save(bundle, bundle_path)

loaded = torch.load(bundle_path, map_location="cpu", weights_only=True)
if loaded["format_version"] != 1:
    raise ValueError("지원하지 않는 checkpoint 버전입니다.")
loaded_tokenizer = ScratchBPE.from_dict(loaded["tokenizer"])
loaded_config = ModelConfig(**loaded["encoder_config"])
assert loaded_config.vocab_size == loaded_tokenizer.vocab_size
loaded_model = SentenceEncoder(TinyBert(loaded_config), **loaded["retriever_config"])
loaded_model.load_state_dict(loaded["state_dict"])
loaded_model.eval()
loaded_documents = loaded["documents"]
loaded_names = loaded["document_names"]
loaded_index = loaded["document_vectors"]

with torch.no_grad():
    recomputed_index = encode_texts(loaded_model, loaded_documents, loaded_tokenizer)
torch.testing.assert_close(recomputed_index, loaded_index, atol=0, rtol=0)
loaded_hits, _ = search_documents(my_query, loaded_model, loaded_tokenizer,
                                   loaded_index, loaded_documents, loaded_names)
assert [hit["id"] for hit in loaded_hits] == [hit["id"] for hit in hits]
print("새 인스턴스에서 벡터와 검색 순위 복원:", bundle_path.name)

# %% 06_search_and_checks.md / cell 13
test_metrics, test_rows = evaluate_retrieval(retriever, TEST)
test_mean_metrics, _ = evaluate_retrieval(mean_model, TEST)
show_table(["구조", "TEST Recall@1", "TEST Recall@3", "TEST MRR"], [
    ["평균", *(round(test_mean_metrics[k], 4) for k in ("Recall@1", "Recall@3", "MRR"))],
    ["문맥 encoder", *(round(test_metrics[k], 4) for k in ("Recall@1", "Recall@3", "MRR"))],
])
errors = [row for row in test_rows if row["rank"] != 1]
show_table(["질의", "정답", "정답 순위", "상위 3개"], [
    [row["query"], DOC_NAMES[row["target"]], row["rank"],
     ", ".join(DOC_NAMES[i] for i in row["top3"])] for row in errors
])
print("1위 오류 질의 수:", len(errors), "/", len(TEST))

# %% 06_search_and_checks.md / cell 15
course_report = {
    "python": sys.version.split()[0], "torch": torch.__version__,
    "seeds": {"global": SEED, "mlm_initialization": 41, "mlm_corruption": 45,
              "mlm_diagnostic": 44, "retrieval_projection": 17},
    "vocabulary_size": tokenizer.vocab_size, "bpe_merges": len(tokenizer.merges),
    "encoder_config": asdict(encoder_config), "retrieval_training": asdict(retrieval_training),
    "data": {"documents": len(DOCS), "train": len(TRAIN), "validation": len(VALID), "test": len(TEST)},
    "mlm_diagnostic_before": mlm_before, "mlm_diagnostic_after": mlm_after,
    "retrieval_validation_before": initial_metrics,
    "retrieval_validation_after": retrieval_metrics, "mean_validation_after": mean_metrics,
    "frozen_validation_after": frozen_metrics,
    "retrieval_test": test_metrics, "mean_test": test_mean_metrics,
    "embedding_gradient": {"autograd": autograd_gradient, "finite_difference": numeric_gradient},
    "padding_error": padding_error, "frozen_table_change": frozen_table_change,
    "order_diagnostics": order_diagnostics,
    "test_predictions": test_rows,
    "elapsed_seconds": time.perf_counter() - STARTED_AT,
    "evaluation_scope": "Synthetic queries against a known corpus; not a natural-language benchmark.",
}
(ARTIFACT_DIR / "results.json").write_text(json.dumps(course_report, ensure_ascii=False, indent=2), encoding="utf-8")
print("실행 결과 저장:", Path("artifacts/course/results.json"))
print("여기까지의 실행 시간:", round(course_report["elapsed_seconds"], 2), "초")

# %% 07_exercises.md / cell 1
def lookup_backward(ids, incoming_gradient, vocabulary_size, padding_id=0):
    if ids.ndim != 1 or incoming_gradient.shape[0] != ids.numel():
        raise ValueError("ids는 [T], incoming_gradient는 [T,D]여야 합니다.")
    table_gradient = incoming_gradient.new_zeros(vocabulary_size, incoming_gradient.shape[-1])
    for position, token_id in enumerate(ids.tolist()):
        if token_id != padding_id:
            table_gradient[token_id] += incoming_gradient[position]
    return table_gradient

exercise_ids = torch.tensor([2, 4, 2, 0])
incoming = torch.tensor([[1., 2.], [3., 4.], [-1., 5.], [9., 9.]])
hand_gradient = lookup_backward(exercise_ids, incoming, vocabulary_size=6)
assert torch.equal(hand_gradient[2], torch.tensor([0., 7.]))
assert torch.equal(hand_gradient[4], torch.tensor([3., 4.]))
assert torch.equal(hand_gradient[0], torch.zeros(2))
print(hand_gradient)

# %% 07_exercises.md / cell 3
def masked_max(hidden, pool_mask):
    if not pool_mask.any(dim=1).all():
        raise ValueError("내용 토큰이 없는 문장을 max pooling할 수 없습니다.")
    masked = hidden.masked_fill(~pool_mask.unsqueeze(-1), float("-inf"))
    return masked.max(dim=1).values

negative_states = torch.tensor([[[-3., -2.], [-1., -4.], [100., 100.]]])
negative_mask = torch.tensor([[True, True, False]])
bad_max = (negative_states * negative_mask.unsqueeze(-1)).max(dim=1).values
good_max = masked_max(negative_states, negative_mask)
print("PAD를 0으로 덮은 잘못된 결과:", bad_max)
print("PAD를 후보에서 제외한 결과:", good_max)
torch.testing.assert_close(good_max, torch.tensor([[-1., -2.]]))

# %% 07_exercises.md / cell 5
def average_positive_loss(logits, positive_mask):
    counts = positive_mask.sum(dim=1)
    if logits.shape != positive_mask.shape or (counts == 0).any():
        raise ValueError("각 질의에 하나 이상의 positive가 필요합니다.")
    log_prob = logits.log_softmax(dim=-1)
    chosen_log_prob = log_prob.masked_fill(~positive_mask, 0)
    per_query_loss = -chosen_log_prob.sum(dim=1) / counts
    return per_query_loss.mean()

multi_logits = torch.tensor([[5., 0., -2.]], requires_grad=True)
multi_mask = torch.tensor([[True, True, False]])
uniform_positive_loss = average_positive_loss(multi_logits, multi_mask)
uniform_gradient, = torch.autograd.grad(uniform_positive_loss, multi_logits)
singleton_mask = torch.tensor([[True, False, False]])
torch.testing.assert_close(average_positive_loss(multi_logits, singleton_mask),
                           F.cross_entropy(multi_logits, torch.tensor([0])))
print("positive별 평균 loss:", float(uniform_positive_loss.detach()))
print("logit gradient:", uniform_gradient.tolist())

# %% 07_exercises.md / cell 7
def make_token_chunks(text, tokenizer, max_content_tokens=94, overlap=16):
    if max_content_tokens < 1 or not 0 <= overlap < max_content_tokens:
        raise ValueError("0 <= overlap < max_content_tokens여야 합니다.")
    content_ids = tokenizer.encode(text, add_special_tokens=False)
    stride = max_content_tokens - overlap
    chunks = []
    start = 0
    while start < len(content_ids):
        end = min(start + max_content_tokens, len(content_ids))
        chunks.append({"start": start, "end": end,
                       "ids": [tokenizer.cls_id, *content_ids[start:end], tokenizer.sep_id]})
        if end == len(content_ids):
            break
        start += stride
    return chunks

def pack_chunks(chunks, tokenizer):
    width = max(len(chunk["ids"]) for chunk in chunks)
    ids = torch.full((len(chunks), width), tokenizer.pad_id, dtype=torch.long)
    attention = torch.zeros_like(ids, dtype=torch.bool)
    pool = torch.zeros_like(ids, dtype=torch.bool)
    for row, chunk in enumerate(chunks):
        length = len(chunk["ids"])
        ids[row, :length] = torch.tensor(chunk["ids"])
        attention[row, :length] = True
        pool[row, 1:length - 1] = True
    return {"input_ids": ids, "attention_mask": attention,
            "pool_mask": pool, "token_type_ids": torch.zeros_like(ids)}

long_text = " ".join([DOCS[6], DOCS[8], DOCS[9]] * 8)
chunks = make_token_chunks(long_text, loaded_tokenizer, max_content_tokens=loaded_config.max_len - 2)
chunk_batch = pack_chunks(chunks, loaded_tokenizer)
assert chunk_batch["input_ids"].shape[1] <= loaded_config.max_len
with torch.no_grad():
    chunk_vectors = loaded_model(chunk_batch)
show_table(["chunk", "내용 ID 시작", "내용 ID 끝(미포함)", "special 포함 길이"],
           [[i, c["start"], c["end"], len(c["ids"])] for i, c in enumerate(chunks)])
print("chunk 벡터:", tuple(chunk_vectors.shape))
original_long_ids = loaded_tokenizer.encode(long_text, add_special_tokens=False)
covered = set()
for chunk in chunks:
    assert chunk["ids"][1:-1] == original_long_ids[chunk["start"]:chunk["end"]]
    covered.update(range(chunk["start"], chunk["end"]))
assert covered == set(range(len(original_long_ids)))

# %% 07_exercises.md / cell 9
def ndcg_at_k(ranking, relevance, k):
    if not isinstance(k, int) or k < 1:
        raise ValueError("k는 양의 정수여야 합니다.")
    if len(ranking) != len(set(ranking)):
        raise ValueError("ranking에는 중복 문서가 없어야 합니다. chunk를 문서로 합칠 때 먼저 중복을 처리하세요.")
    if any(grade < 0 for grade in relevance.values()):
        raise ValueError("이 gain 정의에서는 관련성 등급이 0 이상이어야 합니다.")
    def dcg(grades):
        return sum((2 ** grade - 1) / math.log2(rank + 2)
                   for rank, grade in enumerate(grades))
    actual = [relevance.get(document_id, 0) for document_id in ranking[:k]]
    ideal = sorted(relevance.values(), reverse=True)[:k]
    ideal_score = dcg(ideal)
    return dcg(actual) / ideal_score if ideal_score else 0.0

grades = {"A": 2, "B": 1, "C": 0}
assert ndcg_at_k(["A", "B", "C"], grades, 3) == 1.0
assert 0 < ndcg_at_k(["B", "A", "C"], grades, 3) < 1
assert ndcg_at_k(["X"], {}, 1) == 0.0
try:
    ndcg_at_k(["A", "A"], grades, 2)
except ValueError:
    pass
else:
    raise AssertionError("중복 문서는 nDCG가 1을 넘도록 만들 수 있으므로 거부해야 합니다.")
print("이상적 순위의 nDCG:", ndcg_at_k(["A", "B", "C"], grades, 3))
print("정답은 같지만 순서가 바뀐 nDCG:", ndcg_at_k(["B", "A", "C"], grades, 3))

# %% 07_exercises.md / cell 11
new_relation_texts = [
    "고양이 가 토끼 를 쫓다",
    "토끼 가 고양이 를 쫓다",
    "여우 가 사슴 를 쫓다",
]
show_table(["새 조합", "BPE 조각", "UNK 수"], [
    [text, " | ".join(tokenizer.pieces[i] for i in tokenizer.encode(text, add_special_tokens=False)),
     tokenizer.encode(text, add_special_tokens=False).count(tokenizer.unk_id)]
    for text in new_relation_texts
])
