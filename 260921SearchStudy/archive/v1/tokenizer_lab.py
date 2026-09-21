"""Train tokenization rules, then inspect a separately initialized embedding table.

Run: .venv/bin/python tokenizer_lab.py
Only DOCS and TRAIN queries enter tokenizer training. OOV_QUERY is inspection-only.
This is character BPE with word-end markers, not BERT's WordPiece tokenizer.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import torch
from tokenizers import Tokenizer, decoders, models, normalizers, pre_tokenizers, trainers
from torch import nn

from data import DOCS, OOV_QUERY, TRAIN


SPECIAL_TOKENS = ["[PAD]", "[UNK]", "[MASK]"]
WORD_END = "</w>"


def train_tokenizer(vocab_size: int = 256, min_frequency: int = 2) -> Tokenizer:
    """Frequency-based BPE training: no torch parameters or gradient descent."""
    tokenizer = Tokenizer(models.BPE(unk_token="[UNK]", end_of_word_suffix=WORD_END))
    tokenizer.normalizer = normalizers.NFKC()
    tokenizer.pre_tokenizer = pre_tokenizers.WhitespaceSplit()
    # A suffix marks each pre-token's end, so decoding does not insert a space
    # between every subword. Exact original whitespace is intentionally lost.
    tokenizer.decoder = decoders.BPEDecoder(suffix=WORD_END)
    trainer = trainers.BpeTrainer(
        vocab_size=vocab_size,
        min_frequency=min_frequency,
        special_tokens=SPECIAL_TOKENS,
        end_of_word_suffix=WORD_END,
        show_progress=False,
    )
    corpus = list(DOCS) + [query for query, _ in TRAIN]
    tokenizer.train_from_iterator(corpus, trainer=trainer, length=len(corpus))
    return tokenizer


def inspect_text(tokenizer: Tokenizer, label: str, text: str) -> None:
    encoded = tokenizer.encode(text)
    unk_id = tokenizer.token_to_id("[UNK]")
    unknowns = [
        text[start:end]
        for token_id, (start, end) in zip(encoded.ids, encoded.offsets)
        if token_id == unk_id
    ]
    print(f"\n{label}: {text!r}")
    print(f"  tokens: {encoded.tokens}")
    print(f"  ids:    {encoded.ids}")
    print(f"  UNK: {len(unknowns)}/{len(encoded.ids)} tokens; 원문 위치: {unknowns}")
    print(f"  decode: {tokenizer.decode(encoded.ids, skip_special_tokens=False)!r}")


def inspect_embedding(tokenizer: Tokenizer) -> None:
    """Isolate lookup and row-gradient accumulation without claiming semantics."""
    torch.manual_seed(7)
    pad_id = tokenizer.token_to_id("[PAD]")
    assert pad_id is not None
    embedding = nn.Embedding(tokenizer.get_vocab_size(), 48, padding_idx=pad_id)
    # Initialization is a distinct operation AFTER tokenizer training.
    tokenizer.enable_padding(pad_id=pad_id, pad_token="[PAD]")
    batch = tokenizer.encode_batch([TRAIN[0][0], DOCS[TRAIN[0][1]]])
    ids = torch.tensor([item.ids for item in batch], dtype=torch.long)
    mask = torch.tensor([item.attention_mask for item in batch], dtype=torch.bool)
    vectors = embedding(ids)
    print("\n[2] 별도로 생성한 난수 임베딩 테이블")
    print(f"  E.shape = {tuple(embedding.weight.shape)}")
    print(f"  ids.shape = {tuple(ids.shape)} -> E[ids].shape = {tuple(vectors.shape)}")
    print(f"  attention_mask.sum(1) = {mask.sum(1).tolist()}")
    print(f"  학습 가능한 파라미터: {embedding.weight.numel():,}개")
    print("  아직 의미를 학습하지 않았습니다. BPE merge 학습은 E를 갱신하지 않습니다.")

    # Access the SAME actual token twice: its two gradient contributions add.
    # The target vector of all ones is arbitrary and has no semantic meaning.
    token_id = next(token_id for token_id in batch[0].ids if token_id != pad_id)
    probe_ids = torch.tensor([[token_id, token_id, pad_id]])
    probe_mask = (probe_ids != pad_id).unsqueeze(-1)
    optimizer = torch.optim.SGD(embedding.parameters(), lr=0.01)
    before = embedding.weight.detach().clone()
    tokenizer_before = tokenizer.to_str()
    optimizer.zero_grad()
    loss = ((embedding(probe_ids) - 1.0).square() * probe_mask).sum()
    loss.backward()
    grad = embedding.weight.grad
    assert grad is not None
    # L = 2 * sum_j (E[token_id, j] - 1)^2, hence dL/dE = 4*(E-1).
    expected_gradient = 4.0 * (before[token_id] - 1.0)
    torch.testing.assert_close(grad[token_id], expected_gradient)
    active_rows = torch.nonzero(grad.abs().sum(dim=1) > 0).flatten().tolist()
    assert active_rows == [token_id], active_rows
    optimizer.step()
    delta = (embedding.weight.detach() - before).norm(dim=1)
    assert delta[pad_id].item() == 0.0
    assert torch.count_nonzero(delta).item() == 1
    assert tokenizer.to_str() == tokenizer_before

    print("\n[3] 진단용 한 번의 gradient update — 의미 학습 실험은 아닙니다")
    print(f"  선택 토큰: {tokenizer.id_to_token(token_id)!r}, id={token_id}")
    print(f"  probe_ids = {probe_ids.tolist()} (동일 토큰 2번 + PAD)")
    print("  임의의 목표 [1, ..., 1]에 대한 제곱오차 합을 최소화합니다.")
    print("  같은 ID의 gradient는 한 행에 합산: grad[row] == 4*(E[row]-1) 확인")
    print(f"  gradient가 있는 행: {active_rows}")
    print(f"  선택 행 이동량(L2): {delta[token_id].item():.6f}; PAD 이동량: 0")
    print("  SGD 후에도 tokenizer의 vocab/merge/ID는 그대로입니다.")
    print("  실제 의미/검색 학습에서는 목표를 MLM 또는 질의-문서 대조손실로 바꿉니다.")
    tokenizer.no_padding()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vocab-size", type=int, default=256)
    parser.add_argument("--min-frequency", type=int, default=2)
    args = parser.parse_args()
    if args.vocab_size < len(SPECIAL_TOKENS) or args.min_frequency < 1:
        parser.error("vocab-size >= 3, min-frequency >= 1 이어야 합니다.")

    tokenizer = train_tokenizer(args.vocab_size, args.min_frequency)
    model_state = json.loads(tokenizer.to_str())["model"]
    artifact = Path(__file__).resolve().parent / "artifacts" / "tokenizer.json"
    artifact.parent.mkdir(parents=True, exist_ok=True)
    tokenizer.save(str(artifact))

    print("[1] 토크나이저 학습: 빈도에 따른 subword vocabulary + merge 규칙")
    print(f"  자료: 검색 문서 {len(DOCS)}개 + TRAIN 질의 {len(TRAIN)}개")
    print("  VALID 질의와 OOV_QUERY는 tokenizer 학습에 사용하지 않았습니다.")
    print(f"  목표 vocab: {args.vocab_size}; 실제 vocab: {tokenizer.get_vocab_size()}")
    print(f"  배운 merge 수: {len(model_state['merges'])}")
    print(f"  첫 merge 10개: {model_state['merges'][:10]}")
    print(f"  특수 토큰: {[(token, tokenizer.token_to_id(token)) for token in SPECIAL_TOKENS]}")
    if tokenizer.get_vocab_size() > args.vocab_size:
        print("  기본 문자 + 단어 끝 문자 + 특수 토큰만으로 목표 vocab을 넘었습니다.")
        print("  --vocab-size 512로 다시 실행해 merge가 늘어나는지 비교하세요.")
    print(f"  저장: {artifact}")

    query = TRAIN[0][0]
    inspect_text(tokenizer, "학습에 사용한 질의", query)
    spaced_query = "  " + "\t  ".join(query.split()) + "  "
    inspect_text(tokenizer, "공백/탭을 늘린 질의", spaced_query)
    assert tokenizer.encode(query).ids == tokenizer.encode(spaced_query).ids
    inspect_text(tokenizer, "띄어쓰기를 모두 제거한 질의", "".join(query.split()))
    inspect_text(tokenizer, "미학습 질의", OOV_QUERY)
    inspect_text(tokenizer, "새 문자를 추가한 질의", query + " 🛸")

    reloaded = Tokenizer.from_file(str(artifact))
    assert reloaded.encode(query).ids == tokenizer.encode(query).ids
    normalized = " ".join(tokenizer.normalizer.normalize_str(query).split())
    assert tokenizer.decode(tokenizer.encode(query).ids) == normalized
    inspect_embedding(tokenizer)

    print("\n설계 관찰")
    print("  1. BPE는 자주 인접한 조각을 합칩니다. 온톨로지 관계를 직접 입력받지 않습니다.")
    print("  2. 이 toy tokenizer는 한국어 품질을 평가하기에 매우 작은 corpus를 사용합니다.")
    print("  3. NFKC와 공백 분할은 원문을 바꿀 수 있습니다. 정확한 원문 복원을 보장하지 않습니다.")
    print("  4. Byte-level BPE는 256개 byte 기본 기호를 모두 포함하면 새 문자도 표현합니다.")
    print("     단, UNK 회피가 새 단어의 의미 이해를 보장하지는 않습니다.")
    print("  5. vocab 크기/평균 토큰 수/UNK 비율/검색 품질/비용을 함께 비교해야 합니다.")
    print("  6. tokenizer를 교체하면 ID 의미가 달라집니다. E와 모델도 함께 버전 관리하세요.")
    print("  비교 실험: --vocab-size 160 / 256 / 512로 실행하고 merge 수와 분할을 비교하세요.")


if __name__ == "__main__":
    main()
