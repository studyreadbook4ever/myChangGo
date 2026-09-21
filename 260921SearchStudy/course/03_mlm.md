# 3. 빈칸을 복원하며 encoder를 학습한다

앞 장의 `TinyBert`는 토큰 ID를 문맥에 따라 변환한다. 아직 어떤 변환이 유용한지는 배우지 않았다. 층의 수를 늘리는 것만으로 문법이나 검색 관련성이 생기지는 않는다. 파라미터를 바꾸려면 먼저 **모델에게 풀 문제와 오답의 비용**을 정해야 한다.

이 장에서는 문장의 일부 토큰을 가리고 원래 ID를 맞히게 한다. 이 문제를 masked language modeling, 줄여서 MLM이라고 부른다. 입력은 손상된 문장이고 정답은 손상시키기 전의 토큰 ID이다. 사람이 별도로 정답을 달지 않아도 원문에서 정답을 만들 수 있으므로 자기지도학습에 해당한다.

원래 BERT는 WordPiece, 양방향 Transformer encoder, MLM과 다음 문장 예측(NSP)을 함께 사용했다. 여기서는 앞서 만든 BPE와 작은 encoder를 그대로 쓰고 MLM만 구현한다. 층 수와 학습량도 크게 줄였다. 따라서 BERT와 닮은 학습 경로를 직접 만드는 실습이지, 공개 BERT의 학습 결과를 재현하는 실험은 아니다. 원 논문의 MLM 설명은 [BERT §3.1](https://aclanthology.org/N19-1423.pdf)에 있다.

## 3.1 정답을 어디에 둘 것인가

토크나이저가 어떤 문장을 아래처럼 나눴다고 하자. 실제 분할 결과는 앞 장에서 학습한 merge에 따라 달라진다.

```text
원래 입력:  [CLS]   고양이   가   쥐   를   쫓다   [SEP]   [PAD]
학습 입력:  [CLS]   고양이   가 [MASK] 를   쫓다   [SEP]   [PAD]
정답 ID:     -100    -100 -100  쥐_ID -100  -100    -100    -100
```

`-100`은 vocabulary에 없는 값이다. 이 위치의 예측은 loss에서 제외하라는 표시로 사용한다. `[PAD]`의 ID인 `0`과 다르다. 정답을 `0`으로 채우면 모델은 거의 모든 위치에서 `[PAD]`를 맞히도록 학습된다.

빈칸을 만드는 mask와 attention mask도 다르다. `[MASK]`가 놓인 위치는 encoder 안에서 유효한 위치이므로 attention에 참여한다. `[PAD]` 위치만 key/value의 기여를 차단한다. 선택된 위치를 key mask에서도 지우면 다른 위치가 그 표현을 읽지 못하게 되어 별도의 모델이 된다. key mask는 query 위치의 출력을 없애는 연산은 아니라는 점도 구분하자.

| 이름 | 크기 | `True` 또는 유효한 값의 뜻 |
|---|---|---|
| `attention_mask` | `[B, T]` | 실제 입력에 속하는 위치 |
| `selected` | `[B, T]` | 이번에 복원을 학습할 위치 |
| `labels` | `[B, T]` | 선택 위치에는 원래 ID, 나머지에는 `-100` |
| `input_ids` | `[B, T]` | 선택 위치 일부를 바꾼 뒤 encoder에 넣을 ID |

일반 토큰 중 약 15%를 선택한다. 선택된 위치의 80%는 `[MASK]`, 10%는 임의의 일반 토큰으로 바꾸고, 나머지 10%는 그대로 둔다. 이 비율은 배치마다 정확히 맞추는 할당량이 아니라 각 위치의 추첨 확률이다. 짧은 문장에서 선택 위치가 하나도 없으면 이 실습은 한 위치를 추가로 뽑는다. 이 보정 때문에 실제 선택률은 15%보다 높을 수 있다.

그대로 두는 10%에서는 정답이 입력에 남는다. 임의 토큰 치환도 우연히 같은 ID를 뽑을 수 있다. 이는 정해 둔 학습 규칙의 일부이다. 따라서 모든 정답이 숨겨졌다고 해석하면 안 된다. 아래 진단에서는 선택 위치를 **전부 `[MASK]`로 바꿔서** 정답을 직접 보는 효과를 제외한다.

```python
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
```

표의 정답 열은 모델의 입력이 아니다. encoder에는 `input_ids`, `attention_mask`, `token_type_ids`만 전달할 것이다. 원문 ID를 별도 인자로 encoder에 전달하거나 손상시키기 전 embedding을 재사용하면 정답을 우회해서 보여 주게 된다.

여기서는 공개 문서 `DOCS`와 학습 질의 `TRAIN`만 MLM에 사용한다. 검색 대상 문서를 학습 때 볼 수 있는 고정 문서집 조건이다. 검증·테스트 질의는 이 목록에 넣지 않는다. 문서까지 처음 보는 검색 문제를 평가하려면 문서 집합도 따로 나누어야 한다.

## 3.2 문맥 벡터를 vocabulary의 점수로 바꾼다

encoder의 출력 `H`는 `[B, T, D]`이다. 각 위치의 벡터를 vocabulary의 ID 중 하나로 분류하려면 마지막 축을 `D`에서 `V`로 바꿔야 한다.

$$
u_{bt}=\operatorname{LayerNorm}(\operatorname{GELU}(W_h h_{bt}+b_h)),
\qquad \ell_{btv}=u_{bt}^{\mathsf T} E_v+b_v.
$$

`E`는 입력에서 사용한 바로 그 토큰 임베딩 행렬이다. PyTorch의 `F.linear(u, E, bias)`는 마지막 축에 `u @ E.T + bias`를 계산한다. `E`의 크기는 `[V, D]`이므로 결과는 `[B, T, V]`이다. 입력에서는 행을 조회하고, 출력에서는 모든 행과 내적한다. 같은 파라미터를 두 용도로 쓰는 것을 **weight tying**이라고 한다.

입력과 출력에 따로 행렬을 만들 수도 있다. 그 경우 두 행렬은 서로 다른 역할에 맞게 움직이고 파라미터 수도 늘어난다. 여기서는 공유했을 때 gradient가 어떻게 합쳐지는지를 볼 수 있게 tying을 사용한다.

```python
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
```

여기서 특수 토큰의 출력 점수를 `-inf`로 바꾼 것은 이 실습의 설계이다. 정답에서 특수 토큰을 제외하는 것과 출력 후보에서 제외하는 것은 서로 다른 조치이다. 정답으로 한 번도 등장하지 않아도 softmax의 분모에 있으면 gradient를 받을 수 있다.

또한 `[UNK]`를 정답에서 제외하므로, 새 도메인에서 미등록 문자가 잦다면 학습할 정보를 버리게 된다. 앞 장에서 미등록 문자의 처리 방식을 확인한 이유가 여기에도 연결된다.

## 3.3 loss를 한 위치씩 손으로 확인한다

정답이 있는 위치 집합을 $S$라고 쓰면, 이 배치의 loss는 다음과 같다.

$$
L_{\mathrm{MLM}}=-\frac{1}{|S|}\sum_{(b,t)\in S}
\log\frac{\exp(\ell_{bt,y_{bt}})}{\sum_{v=5}^{V-1}\exp(\ell_{btv})}.
$$

합의 분모는 문장 수가 아니라 선택한 토큰 수이다. 길이가 긴 문장은 보통 더 많은 복원 위치를 제공하므로 배치의 loss에도 더 많이 기여한다. 단어 하나가 세 subword로 나뉘면 세 개의 분류 위치가 된다. 이 구현은 단어 전체를 함께 가리는 whole-word masking을 하지 않는다.

`F.cross_entropy`는 logits에 log-softmax와 정답 log 확률 선택을 수행한다. 호출 전에 `softmax`를 적용하지 않는다. 먼저 확률로 바꾼 값을 넣으면 그 확률을 다시 점수로 취급해서 다른 목적함수가 된다. `ignore_index=-100`인 정답은 평균의 분모에서도 제외된다. [PyTorch CrossEntropyLoss](https://pytorch.org/docs/stable/generated/torch.nn.CrossEntropyLoss.html)

아래에서는 `[B,T,V]`에서 앞의 두 축을 합친다. 토큰 위치를 일렬로 펼쳐 B*T개의 위치를 각각 V개 후보로 분류하는 문제로 본 것이다. `-100`인 위치를 먼저 고르는 방법과 결과가 같아야 한다.

```python
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
```

일반 토큰이 `V-5`개이고 확률이 균등하다면 loss는 `log(V-5)`이다. 초기 모델은 완전히 균등하지 않으므로 그 값과 정확히 같지는 않는다. 이 기준은 규모를 읽는 용도이다. vocabulary가 다른 두 모델의 loss를 숫자만으로 비교하는 데 사용하면 안 된다.

## 3.4 입력에 없던 임베딩 행도 바뀔 수 있다

앞 장의 lookup 실험에서는 조회한 ID에만 gradient가 생겼다. 지금의 `E`는 출력 분류기에도 참여한다. 한 복원 위치에서 vocabulary 점수에 대한 미분은 다음과 같다.

$$
\frac{\partial L}{\partial\ell_v}=p_v-\mathbf{1}[v=y],
\qquad
\left.\frac{\partial L}{\partial E_v}\right|_{\mathrm{output}}
=(p_v-\mathbf{1}[v=y])u.
$$

여러 위치의 평균에서는 이 항들을 더하고 선택 위치 수로 나눈다. 정답이 아닌 일반 토큰도 `p_v`가 0이 아니면 output 쪽 gradient를 받는다. 전체 `E`의 gradient에는 이 항과 encoder의 lookup을 통해 돌아온 항이 더해진다.

`nn.Embedding(padding_idx=0)`은 lookup 연산이 PAD 행에 gradient를 쌓지 않게 한다. 그러나 같은 행렬을 `F.linear`에 넘기면 그 연산까지 차단해 주지는 않는다. 입력에 PAD가 없어도 출력 softmax의 PAD 점수로부터 gradient가 생길 수 있다. [PyTorch Embedding](https://pytorch.org/docs/stable/generated/torch.nn.Embedding.html)

아래 작은 실험은 encoder를 잠시 빼고 이 경로만 확인한다. 입력에는 ID 5 하나만 있다. 정답은 6이고 ID 7은 입력에도 정답에도 없다.

```python
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
```

PAD 행의 gradient가 0이라는 것과 PAD 행의 값이 0이라는 것도 구별해야 한다. optimizer에 weight decay가 있으면 gradient가 0이어도 기존의 0이 아닌 값은 달라질 수 있다. 여기서는 앞 장에서 PAD 행을 0으로 초기화했고, 입력과 출력의 gradient 경로를 모두 막았으므로 0이 유지된다.

## 3.5 같은 복원 문제를 학습 전후에 풀어 본다

작은 말뭉치 전체에서 진단용 빈칸을 한 번 만들어 고정한다. 학습 중에는 같은 원문에서 매번 새 위치를 선택한다. 진단용 빈칸은 전부 `[MASK]`로 바꾼다. 따라서 학습 loss와 진단 loss의 숫자는 직접 비교하지 않고 각각의 용도로 읽는다.

진단 원문은 학습 원문과 같다. 이 정확도는 외워서라도 주어진 문제를 잘 풀게 되었는지 확인하는 **학습 자료 내 진단**이다. 언어 이해 능력이나 새로운 질의에서의 검색 성능을 추정하는 평가가 아니다. 뒤에서 따로 보관한 검색 질의로 retrieval을 평가한다.

```python
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
```

아래 loop는 96번의 optimizer step을 수행한다. 문장을 모두 한 번씩 보는 epoch 수와는 다른 단위이다. 매번 문장을 복원 추출하므로 같은 문장을 다시 뽑을 수 있다. 이 경우에도 빈칸 위치는 다시 추첨된다.

`zero_grad → forward → loss → backward → clip → step`의 순서를 따라 읽어 보자. `loss.backward()`까지는 gradient를 계산할 뿐 파라미터 값은 바꾸지 않는다. `optimizer.step()`이 실제 값을 바꾼다. gradient clipping은 전체 gradient norm이 너무 클 때 모든 gradient를 같은 비율로 줄인다.

```python
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
```

정확도가 100%가 되어야 성공하는 실험은 아니다. 같은 주변 문맥에 여러 정답이 가능한 빈칸도 있고, 작은 모델은 위치나 빈도가 높은 토큰에 의존할 수 있다. 실행이 정상인지 볼 때는 loss가 유한한지, 파라미터가 바뀌는지, 같은 진단에서 예측이 어떻게 달라졌는지를 함께 본다.

```python
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
```

## 3.6 직접 바꾸어 볼 두 가지

첫째, `probability=1.0, mask_only=True`라면 문장 안의 일반 토큰이 모두 `[MASK]`가 된다. 위치와 길이, 특수 토큰은 남지만 원래 일반 토큰의 문맥은 사라진다. 이 입력에서 잘 맞히더라도 주변 단어를 이용했다고 말할 수 없다. 아래 셀은 실제로 그렇게 바뀌는지 확인한다.

둘째, 선택하지 않은 위치의 logits를 크게 바꾸면 loss가 변할까? 이 구현에서는 변하지 않아야 한다. `ignore_index`의 의미를 값과 미분 양쪽에서 확인한다. 모델을 재학습하지 않으므로 앞의 결과는 유지된다.

```python
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
```

마지막 결과를 encoder의 문맥 경로까지 확대 해석하면 안 된다. 선택하지 않은 위치의 **출력 logits**에는 직접 loss가 없지만, 그 위치의 입력 표현은 다른 위치의 attention에 쓰일 수 있다. 따라서 선택하지 않은 토큰의 입력 임베딩과 encoder 상태에는 gradient가 도달할 수 있다.

이제 `pretrained_encoder`에는 MLM으로 갱신한 파라미터가 들어 있다. 다음 장에서는 vocabulary를 맞히던 `dense`, `norm`, `vocab_bias`를 사용하지 않고 encoder의 `[B,T,D]` 출력을 문장별 `[B,D]`로 모은다. 이후 검색 관련성에 맞춘 loss와 새 optimizer로 학습한다. 토큰을 잘 복원하는 것과 관련 문서를 가까이 배치하는 것은 서로 다른 요구이므로, 이 두 번째 학습이 왜 필요한지 결과를 비교하며 확인한다.
