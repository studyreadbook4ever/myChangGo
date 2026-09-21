"""CPU 실습: 토큰 임베딩을 무작위 초기화하여 검색 목적함수로 직접 학습한다.

python lab.py --model both
python lab.py --query '고양이 가 쥐 를 추격 하다'
핵심 코드를 숨기는 pretrained model / Trainer / vector DB는 사용하지 않는다.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
from dataclasses import asdict, dataclass
from pathlib import Path

import torch
from torch import nn
from torch.nn import functional as F

from data import DOCS, DOC_NAMES, TRAIN, VALID, ORDER_PAIR, PROBE_TOKEN

ROOT = Path(__file__).resolve().parent
ARTIFACTS = ROOT / "artifacts"
torch.set_num_threads(1)


@dataclass
class Config:
    model: str = "transformer"
    seed: int = 42
    dim: int = 48
    output_dim: int = 32
    heads: int = 4
    layers: int = 2
    max_length: int = 48
    temperature: float = 0.1
    lr: float = 0.003
    steps: int = 300
    freeze_tokens: bool = False


class Vocabulary:
    """의도적으로 투명한 공백 tokenizer. 실제 한국어 형태소/서브워드 분석기는 아니다."""

    def __init__(self, words=None):
        if words is None:
            train_text = DOCS + [q for q, _ in TRAIN]
            words = ["[PAD]", "[UNK]", "[UNUSED]"] + sorted(
                {t for text in train_text for t in text.split()}
            )
        self.words = list(words)
        self.ids = {word: idx for idx, word in enumerate(self.words)}

    def __len__(self):
        return len(self.words)

    def batch(self, texts, max_length=48):
        rows = []
        for text in texts:
            tokens = text.split()
            if not tokens:
                raise ValueError("빈 입력은 검색할 수 없습니다.")
            if any(token in self.words[:3] for token in tokens):
                raise ValueError("[PAD], [UNK], [UNUSED]는 내부 예약 토큰이며 직접 입력할 수 없습니다.")
            if len(tokens) > max_length:
                raise ValueError(f"입력은 {max_length} 토큰 이하여야 합니다. 자동 절단하지 않습니다.")
            rows.append([self.ids.get(token, 1) for token in tokens])
        if not rows:
            raise ValueError("입력 목록이 비어 있습니다.")
        ids = torch.zeros(len(rows), max(map(len, rows)), dtype=torch.long)
        for i, row in enumerate(rows):
            ids[i, :len(row)] = torch.tensor(row)
        return ids, ids.ne(0)

    def unknown(self, text):
        return [token for token in text.split() if token not in self.ids]


class TokenTable(nn.Module):
    """nn.Embedding의 중심: 학습 가능한 V x D 행렬과 ID에 따른 행 조회."""

    def __init__(self, vocab_size, dim):
        super().__init__()
        self.weight = nn.Parameter(torch.empty(vocab_size, dim))
        nn.init.normal_(self.weight, mean=0.0, std=0.1)
        with torch.no_grad():
            self.weight[0].zero_()

    def forward(self, ids):
        # one_hot(ids) @ E와 같은 조회. padding_idx는 PAD의 조회 gradient를 막는다.
        return F.embedding(ids, self.weight, padding_idx=0)


class AttentionBlock(nn.Module):
    """양방향 multi-head attention + Post-LN + FFN. BERT 전체 재현은 아니다."""

    def __init__(self, dim, heads):
        super().__init__()
        if dim % heads:
            raise ValueError("dim은 heads의 배수여야 합니다.")
        self.heads = heads
        self.qkv = nn.Linear(dim, 3 * dim)
        self.out = nn.Linear(dim, dim)
        self.norm1 = nn.LayerNorm(dim)
        self.ffn = nn.Sequential(nn.Linear(dim, 4 * dim), nn.GELU(), nn.Linear(4 * dim, dim))
        self.norm2 = nn.LayerNorm(dim)

    def forward(self, x, mask):
        batch, length, dim = x.shape
        qkv = self.qkv(x).reshape(batch, length, 3, self.heads, dim // self.heads)
        q, k, v = qkv.permute(2, 0, 3, 1, 4).unbind(0)
        logits = q @ k.transpose(-2, -1) / math.sqrt(dim // self.heads)
        # key 방향의 PAD를 가린다. causal mask는 없으므로 양쪽 문맥을 본다.
        logits = logits.masked_fill(~mask[:, None, None, :], float("-inf"))
        attention = logits.softmax(dim=-1)
        values = (attention @ v).transpose(1, 2).contiguous().reshape(batch, length, dim)
        x = self.norm1(x + self.out(values))
        x = self.norm2(x + self.ffn(x))
        return x, attention


class Retriever(nn.Module):
    def __init__(self, vocab_size, config):
        super().__init__()
        if config.model not in {"mean", "transformer"}:
            raise ValueError("model은 mean 또는 transformer여야 합니다.")
        self.config = config
        self.tokens = TokenTable(vocab_size, config.dim)
        self.tokens.weight.requires_grad_(not config.freeze_tokens)
        if config.model == "transformer":
            self.position = nn.Embedding(config.max_length, config.dim)
            nn.init.normal_(self.position.weight, std=0.1)
            self.input_norm = nn.LayerNorm(config.dim)
            self.blocks = nn.ModuleList([
                AttentionBlock(config.dim, config.heads) for _ in range(config.layers)
            ])
        self.projection = nn.Linear(config.dim, config.output_dim, bias=False)

    def forward(self, ids, mask, *, use_positions=True, trace=False):
        x = self.tokens(ids)
        raw = x
        attentions = []
        if self.config.model == "transformer":
            if use_positions:
                positions = torch.arange(ids.shape[1], device=ids.device)
                x = x + self.position(positions)[None, :, :]
            x = self.input_norm(x)
            for block in self.blocks:
                x, attention = block(x, mask)
                if trace:
                    attentions.append(attention)
        # PAD query 위치에도 값은 생기지만 pooling에서는 제외한다.
        pool_x, pool_mask = x, mask
        if self.config.model == "mean":
            # 덧셈의 부동소수점 오차까지 동일하게: 같은 multiset은 같은 순서로 더한다.
            # 의미/위치 정보를 추가하는 연산이 아니며 mean의 수학적 결과는 같다.
            order = ids.argsort(dim=1, stable=True)
            pool_x = x.gather(1, order.unsqueeze(-1).expand_as(x))
            pool_mask = mask.gather(1, order)
        float_mask = pool_mask.unsqueeze(-1).to(x.dtype)
        pooled = (pool_x * float_mask).sum(1) / float_mask.sum(1).clamp_min(1)
        vector = F.normalize(self.projection(pooled), p=2, dim=-1)
        if trace:
            return vector, {"lookup": raw, "contextual": x, "pooled": pooled,
                            "attention": attentions}
        return vector


def new_model(vocab, config):
    torch.manual_seed(config.seed)
    return Retriever(len(vocab), config)


def encode(model, vocab, texts, **kwargs):
    return model(*vocab.batch(texts, model.config.max_length), **kwargs)


def validate_data(vocab):
    train_queries = {q for q, _ in TRAIN}
    valid_queries = {q for q, _ in VALID}
    assert not (train_queries & valid_queries), "train/valid query가 중복되었습니다."
    assert len(DOCS) == len(DOC_NAMES) == len(set(DOCS))
    assert len(train_queries) == len(TRAIN) and len(valid_queries) == len(VALID)
    assert all(0 <= label < len(DOCS) for _, label in TRAIN + VALID)
    assert all(not vocab.unknown(q) for q, _ in VALID), "VALID에 OOV가 있습니다."
    a, b = ORDER_PAIR
    assert sorted(DOCS[a].split()) == sorted(DOCS[b].split())
    return {"documents": len(DOCS), "train_queries": len(TRAIN),
            "valid_queries": len(VALID), "vocabulary": len(vocab)}


def lookup_demo():
    """중복 토큰의 gradient 누적을 직접 확인. padding은 별도 검사한다."""
    torch.manual_seed(0)
    table = torch.randn(7, 4, dtype=torch.double, requires_grad=True)
    ids = torch.tensor([2, 2, 5])
    selected = table[ids]
    one_hot = F.one_hot(ids, num_classes=7).to(table.dtype)
    torch.testing.assert_close(selected, one_hot @ table)
    selected.sum().backward()
    expected = torch.zeros_like(table)
    expected[2] = 2
    expected[5] = 1
    torch.testing.assert_close(table.grad, expected)
    return {"ids": ids.tolist(), "row_gradient": table.grad.tolist(),
            "explanation": "E[2]는 2회 조회되어 각 좌표의 gradient가 2, E[5]는 1입니다."}


@torch.no_grad()
def evaluate(model, vocab, pairs):
    model.eval()
    scores = encode(model, vocab, [q for q, _ in pairs]) @ encode(model, vocab, DOCS).T
    # 동점은 문서 인덱스 오름차순. mean에서는 합산 순서도 고정해 같은 bag의 동점을 보존한다.
    ranking = scores.argsort(dim=1, descending=True, stable=True)
    labels = torch.tensor([label for _, label in pairs])
    rank = (ranking == labels[:, None]).nonzero()[:, 1] + 1
    metrics = {"recall@1": (rank <= 1).float().mean().item(),
               "recall@3": (rank <= 3).float().mean().item(),
               "mrr": rank.float().reciprocal().mean().item()}
    rows = [{"query": q, "target": DOC_NAMES[label], "rank": int(rank[i]),
             "top3": [DOC_NAMES[j] for j in ranking[i, :3].tolist()]}
            for i, (q, label) in enumerate(pairs)]
    return metrics, rows


def gradient_probe(model, vocab):
    """검색 loss → score → token table 추적. 복제본의 동결을 해제한 미분 진단이다."""
    probe = copy.deepcopy(model).double()
    probe.tokens.weight.requires_grad_(True)
    probe.train()
    query, label = next((q, y) for q, y in TRAIN if PROBE_TOKEN in q.split())
    q = encode(probe, vocab, [query])
    d = encode(probe, vocab, DOCS)
    scores = q @ d.T
    scores.retain_grad()
    target = torch.tensor([label])
    temperature = probe.config.temperature
    loss = F.cross_entropy(scores / temperature, target)
    loss.backward()
    expected = (scores.detach() / temperature).softmax(-1)
    expected[0, label] -= 1
    expected /= temperature
    torch.testing.assert_close(scores.grad, expected)
    grad = probe.tokens.weight.grad.detach().clone()
    assert grad[0].abs().max().item() == 0  # PAD
    assert grad[2].abs().max().item() == 0  # UNUSED
    assert grad.abs().max().item() > 0
    # autograd를 수치 미분과 대조한다. 최대 gradient 좌표를 골라 반올림 오차를 줄인다.
    flat = grad.abs().argmax().item()
    row, col = divmod(flat, grad.shape[1])
    weight = probe.tokens.weight
    epsilon = 1e-6
    with torch.no_grad():
        original = weight[row, col].item()
        weight[row, col] = original + epsilon
        plus = F.cross_entropy(encode(probe, vocab, [query]) @
                               encode(probe, vocab, DOCS).T / temperature, target).item()
        weight[row, col] = original - epsilon
        minus = F.cross_entropy(encode(probe, vocab, [query]) @
                                encode(probe, vocab, DOCS).T / temperature, target).item()
        weight[row, col] = original
    numerical = (plus - minus) / (2 * epsilon)
    analytic = grad[row, col].item()
    assert math.isclose(numerical, analytic, rel_tol=1e-4, abs_tol=1e-6)
    token_id = vocab.ids[PROBE_TOKEN]
    before = weight[token_id].detach().clone()
    # 1 step만 관찰: 모멘텀/weight decay 없이 gradient 자체의 효과를 확인.
    torch.optim.SGD(probe.parameters(), lr=0.01).step()
    delta = (weight[token_id].detach() - before).norm().item()
    norms = grad.norm(dim=1)
    top = norms.argsort(descending=True)[:8].tolist()
    return {"query": query, "target": DOC_NAMES[label], "loss": loss.item(),
            "diagnostic_unfreezes_tokens": model.config.freeze_tokens,
            "probe_token": PROBE_TOKEN, "probe_gradient_norm": norms[token_id].item(),
            "probe_update_norm": delta,
            "pad_gradient_norm": norms[0].item(), "unused_gradient_norm": norms[2].item(),
            "analytic_gradient": analytic, "finite_difference": numerical,
            "coordinate": [vocab.words[row], col],
            "largest_row_gradients": [[vocab.words[i], norms[i].item()] for i in top]}


@torch.no_grad()
def invariants(model, vocab):
    model.eval()
    text = DOCS[ORDER_PAIR[0]]
    ids, mask = vocab.batch([text])
    z = model(ids, mask)
    extended_ids = F.pad(ids, (0, 4), value=0)
    extended_mask = F.pad(mask, (0, 4), value=False)
    padded_z = model(extended_ids, extended_mask)
    torch.testing.assert_close(z, padded_z, atol=2e-6, rtol=2e-5)
    pair = [DOCS[i] for i in ORDER_PAIR]
    pair_z = encode(model, vocab, pair)
    difference = (pair_z[0] - pair_z[1]).norm().item()
    no_pos = encode(model, vocab, pair, use_positions=False)
    torch.testing.assert_close(no_pos[0], no_pos[1], atol=2e-6, rtol=2e-5)
    if model.config.model == "mean":
        assert difference < 2e-6
    torch.testing.assert_close(pair_z.norm(dim=-1), torch.ones(2), atol=1e-6, rtol=1e-5)
    return {"padding_difference": (z - padded_z).abs().max().item(),
            "order_pair_vector_distance": difference,
            "without_positions_distance": (no_pos[0] - no_pos[1]).norm().item(),
            "note": "위치 제거는 구조의 순서 불변성을 확인하며, 별도 재학습 성능 비교는 아닙니다."}


def train_experiment(config, vocab=None, verbose=True):
    if config.steps < 1 or config.temperature <= 0:
        raise ValueError("steps와 temperature는 양수여야 합니다.")
    vocab = vocab or Vocabulary()
    validate_data(vocab)
    model = new_model(vocab, config)
    token_before = model.tokens.weight.detach().clone()
    before, before_rows = evaluate(model, vocab, VALID)
    probe = gradient_probe(model, vocab)
    queries = vocab.batch([q for q, _ in TRAIN], config.max_length)
    documents = vocab.batch(DOCS, config.max_length)
    labels = torch.tensor([label for _, label in TRAIN])
    # weight_decay=0: 현재 실습에서는 미등장 임베딩 행의 변화 원인을 없앤다.
    optimizer = torch.optim.Adam(model.parameters(), lr=config.lr, weight_decay=0)
    history = []
    model.train()
    for step in range(1, config.steps + 1):
        optimizer.zero_grad(set_to_none=True)
        q = model(*queries)
        d = model(*documents)
        # 전체 12개 문서가 후보. 같은 label의 여러 query가 서로 negative가 되지 않는다.
        scores = q @ d.T / config.temperature
        loss = F.cross_entropy(scores, labels)
        loss.backward()
        optimizer.step()
        history.append(float(loss.detach()))
        if verbose and (step == 1 or step % 50 == 0 or step == config.steps):
            print(f"[{config.model}] step={step:3d} train_loss={loss.item():.5f}")
    after, after_rows = evaluate(model, vocab, VALID)
    train_metrics, _ = evaluate(model, vocab, TRAIN)
    checks = invariants(model, vocab)
    unchanged = (model.tokens.weight.detach() - token_before).norm().item()
    if config.freeze_tokens:
        assert unchanged == 0
    else:
        assert unchanged > 0
    torch.testing.assert_close(model.tokens.weight[0], token_before[0], atol=0, rtol=0)
    torch.testing.assert_close(model.tokens.weight[2], token_before[2], atol=0, rtol=0)
    result = {"config": asdict(config), "before": before, "after": after,
              "train": train_metrics, "loss": history, "gradient_probe": probe,
              "checks": checks, "token_table_change_norm": unchanged,
              "before_rankings": before_rows, "after_rankings": after_rows}
    return model, result


def save_experiment(model, vocab, result, tag=None):
    ARTIFACTS.mkdir(exist_ok=True)
    tag = tag or model.config.model
    payload = {"config": asdict(model.config), "vocabulary": vocab.words,
               "state_dict": model.state_dict(), "documents": DOCS, "doc_names": DOC_NAMES}
    path = ARTIFACTS / f"{tag}.pt"
    torch.save(payload, path)
    restored, restored_vocab, docs, _ = load_checkpoint(path)
    torch.testing.assert_close(encode(model, vocab, docs),
                               encode(restored, restored_vocab, docs), atol=0, rtol=0)
    (ARTIFACTS / f"{tag}.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def load_checkpoint(path):
    checkpoint = torch.load(path, map_location="cpu", weights_only=True)
    vocab = Vocabulary(checkpoint["vocabulary"])
    model = new_model(vocab, Config(**checkpoint["config"]))
    model.load_state_dict(checkpoint["state_dict"])
    model.eval()
    return model, vocab, checkpoint["documents"], checkpoint["doc_names"]


@torch.no_grad()
def search(query, checkpoint=None, top_k=3):
    path = checkpoint or ARTIFACTS / "transformer.pt"
    model, vocab, docs, names = load_checkpoint(path)
    unknown = vocab.unknown(query)
    if unknown:
        print(f"[UNK] 처리된 토큰: {unknown} — 교육용 공백 tokenizer의 한계입니다.")
    scores = (encode(model, vocab, [query]) @ encode(model, vocab, docs).T)[0]
    order = scores.argsort(descending=True, stable=True)[:top_k].tolist()
    results = [{"score": scores[i].item(), "name": names[i], "document": docs[i]} for i in order]
    for row in results:
        print(f"{row['score']:+.4f}  {row['name']}  |  {row['document']}")
    return results


def plot_results(results):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, axes = plt.subplots(1, 2, figsize=(10, 3.6))
    for name, result in results.items():
        axes[0].plot(range(1, len(result["loss"]) + 1), result["loss"], label=name)
    axes[0].set(xlabel="Optimization step", ylabel="Training cross entropy")
    axes[0].legend()
    labels = list(results)
    x = list(range(len(labels)))
    axes[1].bar([i - .18 for i in x], [results[k]["before"]["recall@1"] for k in labels],
                width=.36, label="Before")
    axes[1].bar([i + .18 for i in x], [results[k]["after"]["recall@1"] for k in labels],
                width=.36, label="After")
    axes[1].set(xticks=x, xticklabels=labels, ylim=(0, 1.05), ylabel="Held-out query Recall@1")
    axes[1].legend()
    fig.suptitle("Synthetic teaching data: known documents, unseen query strings")
    fig.tight_layout()
    ARTIFACTS.mkdir(exist_ok=True)
    fig.savefig(ARTIFACTS / "learning.png", dpi=160)
    fig.savefig(ARTIFACTS / "learning.svg")
    plt.close(fig)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", choices=["mean", "transformer", "both"], default="both")
    parser.add_argument("--steps", type=int, default=300)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--temperature", type=float, default=.1)
    parser.add_argument("--freeze-tokens", action="store_true")
    parser.add_argument("--query")
    parser.add_argument("--checkpoint", type=Path)
    args = parser.parse_args()
    if args.query is not None:
        try:
            search(args.query, args.checkpoint)
        except (ValueError, FileNotFoundError) as error:
            parser.exit(2, f"{error}\n먼저 python lab.py --model both 를 실행하세요.\n")
        return
    vocab = Vocabulary()
    print("데이터:", validate_data(vocab))
    print("조회 실험:", lookup_demo()["explanation"])
    results = {}
    for kind in (["mean", "transformer"] if args.model == "both" else [args.model]):
        config = Config(model=kind, steps=args.steps, seed=args.seed,
                        temperature=args.temperature, freeze_tokens=args.freeze_tokens)
        model, result = train_experiment(config, vocab)
        tag = kind + ("_frozen" if args.freeze_tokens else "")
        save_experiment(model, vocab, result, tag)
        results[tag] = result
        print(f"{tag}: validation before={result['before']} after={result['after']}")
        print("구조 확인:", result["checks"])
        print("임베딩 gradient:", result["gradient_probe"]["probe_gradient_norm"])
        if args.freeze_tokens:
            print("위 gradient는 동결을 해제한 별도 복사본의 진단값입니다. 실제 학습 E 변화량:",
                  result["token_table_change_norm"])
    plot_results(results)
    manifest = {"torch": torch.__version__, "data_sha256": hashlib.sha256(
        (ROOT / "data.py").read_bytes()).hexdigest(), "dataset": validate_data(vocab),
        "evaluation_scope": "Known documents; held-out synthetic query strings. Not an external benchmark.",
        "results": results}
    (ARTIFACTS / "results.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print("저장 위치:", ARTIFACTS)


if __name__ == "__main__":
    main()
