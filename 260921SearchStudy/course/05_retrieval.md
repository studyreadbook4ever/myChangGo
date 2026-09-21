# 5. 검색 정답으로 벡터 공간을 학습하기

이제 문장마다 32차원 벡터가 나온다. 검색 결과는 질의 벡터와 각 문서 벡터의 내적을 큰 순서로 정렬하면 얻을 수 있다. 아직 학습할 것이 남아 있다. 앞의 MLM은 가려진 토큰을 복원하는 문제였고, 지금 풀 문제는 질의에 답하는 문서를 고르는 문제다. 두 문제는 사용하는 encoder가 같아도 정답의 단위와 loss가 다르다.

## 5.1 점수 행렬의 행과 열

학습 질의 48개를 쌓은 벡터를 $Q\in\mathbb{R}^{48\times32}$, 문서 12개를 쌓은 벡터를 $D\in\mathbb{R}^{12\times32}$라고 하자. $QD^T$는 `[48, 12]`다. **행 하나가 질의 하나이고 열 하나가 문서 하나**다. 여기서 Q와 D는 완성된 문장 벡터다. 앞 장 attention 내부의 query/key/value와는 계산 단계가 다르다.

정답 배열에는 각 질의가 가리키는 문서의 열 번호를 넣는다. 같은 문서를 가리키는 질의가 여러 개 있으므로 대각선이 정답인 행렬은 아니다. `torch.arange(48)`을 정답으로 쓰면 이 데이터의 label 구조를 잘못 옮긴 것이다.

```python
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
```

질의와 문서는 같은 encoder 파라미터를 쓰지만 입력은 따로 처리한다. 이를 가중치를 공유하는 bi-encoder라고 부른다. 두 개의 서로 다른 encoder를 학습하는 설계도 가능하다. 문서를 질의와 독립적으로 인코딩한다는 성질 때문에 추론 시 문서 벡터를 미리 저장할 수 있다. 반대로 질의와 문서의 모든 토큰을 한 번에 넣는 cross-encoder는 질의마다 세밀한 상호작용을 계산할 수 있지만, 문서별 벡터 하나만 미리 계산해 두는 방식으로 같은 점수를 얻을 수 없다. [DPR 논문](https://aclanthology.org/2020.emnlp-main.550/)은 이런 독립 인코딩을 검색 학습으로 연결한 대표적인 출발점이다.

## 5.2 softmax와 정답의 음의 로그 확률

한 질의의 문서 점수를 $s_0,\ldots,s_{11}$이라 쓰자. temperature $\tau>0$로 나눈 값을 softmax의 logit으로 사용한다.

$$p_j=\frac{\exp(s_j/\tau)}{\sum_k\exp(s_k/\tau)},\qquad L=-\log p_y.$$

이 확률은 **현재 후보 집합 안에서 정답 열을 선택하는 학습용 분포**다. 서비스 질의의 정답 여부를 보정한 확률은 아니다. corpus가 달라지면 분모도 바뀐다. 정답이 없는 질의라도 softmax는 모든 확률의 합을 1로 만든다.

PyTorch의 `cross_entropy`에는 softmax를 거치기 전 logit을 넣는다. 이 함수가 `log_softmax`와 정답 위치의 선택을 수치적으로 안정하게 합쳐 처리한다. 미리 `softmax`를 호출하면 확률에 다시 softmax를 적용하는 다른 계산이 된다.

```python
temperature = 0.1
tiny_logits = torch.tensor([[2., 1., -1.]])
tiny_target = torch.tensor([0])
manual_loss = torch.logsumexp(tiny_logits, dim=1) - tiny_logits[:, 0]
library_loss = F.cross_entropy(tiny_logits, tiny_target)
torch.testing.assert_close(manual_loss.mean(), library_loss)
print("logsumexp로 계산:", float(manual_loss))
print("cross_entropy로 계산:", float(library_loss))
print("실제 검색 초기 loss:", float(F.cross_entropy(S / temperature, train_targets)))
```

`logsumexp(a)=log(sum(exp(a)))`는 가장 큰 logit을 빼고 계산하는 방식으로 overflow를 피한다. 직접 `exp`를 구현해서 손실이 NaN이 되는 경우, 모델을 바꾸기 전에 이 수치 계산부터 확인해야 한다.

temperature를 양수로 나누어도 현재 점수의 순서는 바뀌지 않는다. 바뀌는 것은 학습 때 사용하는 확률 분포와 gradient다. 같은 점수 `[0.8, 0.7, 0.1]`에서 세 값을 비교해 보자. 첫 후보가 정답이다.

```python
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
```

temperature가 아주 작아지면 이미 1위인 정답에 확률이 거의 몰려 gradient가 오히려 작아질 수 있다. ‘temperature가 작을수록 모든 gradient가 커진다’는 설명은 맞지 않는다. 아직 정답보다 높은 hard negative가 있는 경우도 같은 셀에서 정답을 1번 열로 바꿔 비교할 수 있다. 설정을 바꾼 모델의 학습 loss가 더 작다는 사실만으로 검색 품질이 좋아졌다고 판단하지 말고 같은 검색 지표를 비교해야 한다.

## 5.3 gradient를 식으로 구하고 실제 텐서와 비교한다

한 질의의 loss를 $L=-s_y/\tau+\log\sum_j\exp(s_j/\tau)$로 펼치면

$$\frac{\partial L}{\partial s_j}=\frac{p_j-\mathbf{1}[j=y]}{\tau}.$$

정답 열의 값은 음수이고 나머지 열은 양수다. 경사하강법은 gradient의 반대 방향으로 움직이므로 정답 점수를 올리고 오답 점수를 내리려 한다. 배치 평균 loss를 사용하면 각 행의 gradient에 $1/B$가 추가로 곱해진다.

점수 $s_j=z_q^Tz_j$의 미분을 연결하면

$$\frac{\partial L}{\partial z_q}=\frac{\sum_jp_jz_j-z_y}{\tau},\qquad
\frac{\partial L}{\partial z_j}=\frac{(p_j-\mathbf{1}[j=y])z_q}{\tau}.$$

문서 쪽에도 gradient가 있다. 질의에 없고 문서에만 있는 토큰도 이 경로를 통해 학습될 수 있다. 정답 문서만이 아니라 negative 문서도 참여한다. 실제 encoder 파라미터는 여러 벡터가 공유하므로, update 한 번 후 모든 개별 점수가 이 직관대로 독립적으로 움직인다는 뜻은 아니다.

```python
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
```

이제 같은 backward에서 나온 임베딩 gradient를 읽어 보자. 토큰화를 BPE로 바꾸었으므로 한 단어가 반드시 한 행에 대응하지는 않는다. 문자열 이름을 추측하는 대신, 실제 query ID에 대응하는 행을 조회한다.

```python
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
```

앞의 tied MLM 출력에서는 입력에 없던 토큰 행에도 softmax 경로로 gradient가 생길 수 있었다. 지금은 MLM 출력층을 버렸으므로 그 경로가 사라졌다. ‘임베딩의 미조회 행에는 gradient가 없다’는 문장은 **어떤 계산 경로로 테이블을 사용했는지**까지 지정해야 정확하다. optimizer의 weight decay나 이전 step의 momentum에 의해 값이 변하는 경우도 별도로 구분해야 한다.

자동 미분을 믿는 것과 계산을 검증하는 것은 다른 작업이다. 가장 큰 gradient를 가진 좌표 하나에 작은 변화를 주고 중앙 차분을 계산한다.

$$\frac{\partial L}{\partial E_{ab}}\approx\frac{L(E+\epsilon e_{ab})-L(E-\epsilon e_{ab})}{2\epsilon}.$$

```python
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
```

이 셀은 float64 복사본을 사용한다. 차분의 epsilon을 무조건 작게 만들면 두 loss를 뺄 때 유효 숫자를 잃는다. 너무 크게 만들면 국소 미분의 근사가 나빠진다. 하나의 좌표가 일치했다는 사실이 모든 구현을 증명하지는 않지만, lookup부터 loss까지 연결된 실제 경로를 검사하는 유용한 증거다.

## 5.4 검색 지표와 동점의 의미

질의마다 정답이 하나인 지금 자료에서는 Recall@k가 ‘정답 문서가 상위 k개 안에 있는 질의의 비율’과 같다. MRR은 각 정답 순위의 역수 평균이다. 정답이 1, 2, 4위인 세 질의라면 MRR은 $(1+1/2+1/4)/3$이다. 여러 문서가 정답인 문제에서는 Recall의 분모가 정답 문서 수가 되고, MRR은 가장 먼저 나온 정답의 순위를 사용한다.

동점인 문서는 ID가 작은 것을 먼저 둔다. 평균 모델의 역할 역전 쌍은 구조상 동점이므로 tie-breaking도 평가 정의에 포함해야 한다. 다음 함수는 평가 때 gradient를 만들지 않고 model의 dropout을 끄지만, 학습 상태를 호출 전 값으로 되돌린다.

```python
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
```

## 5.5 학습 loop를 한 줄씩 읽는다

여기서는 매 step마다 질의 48개와 문서 12개를 모두 처리한다. 어느 문서가 negative인지 확인하기 쉬운 구성이다. encoder가 변하므로 문서 벡터도 매번 다시 계산한다. 이전 step의 문서 벡터를 그대로 쓰면 현재 encoder가 만든 벡터를 비교하는 학습과는 달라진다.

`optimizer.zero_grad()`는 이전 gradient를 지운다. `backward()`는 이번 loss를 미분해서 각 파라미터의 gradient에 쌓고, `step()`이 그 값을 이용해 파라미터를 갱신한다. loss를 계산하거나 출력하는 것만으로는 학습이 일어나지 않는다.

아래 코드는 앞서 읽은 한 step을 반복한다. Adam의 weight decay는 0이다. temperature 0.1, learning rate 0.003, 300 steps를 미리 정하고, 검증 점수로 중간에 멈추거나 가장 좋은 checkpoint를 고르지 않는다. 이 설정은 작은 자료를 실행하기 위한 값이며 보편적인 최적값은 아니다.

```python
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
```

한 줄을 바꾸어 읽어 보자. `document_vectors = model(document_batch).detach()`로 바꾸면 문서 쪽 gradient 경로가 끊어진다. 그래도 공유 encoder의 파라미터는 질의 쪽에서 갱신되므로 다음 step의 문서 벡터는 달라질 수 있다. `detach`만으로 문서 표현이 고정되는 것은 아니다. 고정하려면 문서 encoder를 별도로 관리하거나 고정된 벡터를 사용해야 한다.

```python
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
```

## 5.6 평균 모델의 loss가 멈추는 이유를 계산한다

앞의 여섯 문서는 세 개의 역할 역전 쌍이다. 같은 쌍의 두 문서는 평균 모델에서 항상 같은 벡터이므로 어떤 질의에도 같은 점수를 받는다. 둘 중 하나가 정답일 때 그 정답의 softmax 확률은 최대 1/2다. 따라서 그 질의의 loss는 최소 $-\log(1/2)=\log2$다.

이런 질의가 전체 학습 질의의 절반이다. 나머지 절반의 loss를 0까지 줄일 수 있다고 가정해도 전체 평균 loss는 $0.5\log2\approx0.34657$보다 작아질 수 없다. 실제 cosine 점수의 범위와 유한한 temperature 때문에 정확히 그 값에 도달하지는 않을 수 있다.

동일한 이유로 균형 검증 질의에서 평균 모델의 Recall@1 상한은 75%다. 앞 절의 코드가 잘 실행됐는지 볼 때, 평균 모델이 이 한계를 넘지 못한다는 사실은 optimizer를 더 오래 돌려야 한다는 증거가 아니다.

```python
show_table(["평균 모델", "값"], [
    ["구조에서 나온 loss 하한", round(0.5 * math.log(2), 6)],
    ["관측한 마지막 training loss", round(mean_history[-1], 6)],
    ["검증 Recall@1 상한", 0.75],
    ["관측한 검증 Recall@1", mean_metrics["Recall@1"]],
])
assert mean_metrics["Recall@1"] <= 0.75 + 1e-6
assert mean_history[-1] >= 0.5 * math.log(2) - 1e-5
```

## 5.7 negative와 정답 집합을 바꾸면 loss도 바뀐다

지금은 모든 문서를 후보로 넣을 수 있지만 실제 corpus는 훨씬 크다. 다른 질의의 정답 문서를 같은 배치의 negative로 재사용하는 in-batch negative는 계산을 줄이는 한 방법이다. 배치의 각 질의가 서로 다른 정답 문서를 가진다면 B×B 점수 행렬의 대각선을 정답으로 둘 수 있다. 그러나 지금처럼 같은 정답을 가진 질의들이 있으면 단순 대각선 CE가 그 문서를 다른 행에서 오답으로 밀어낸다. 이때는 문서 ID로 중복을 없애거나, 같은 정답을 모두 positive로 표시해야 한다.

hard negative는 모델이 높은 점수를 주지만 실제로는 관련 없는 문서다. 단어가 겹치는 역관계 문서는 이 수업에서 그런 역할을 한다. 그러나 ‘같은 주제이므로 hard negative’라고 정하면 실제 정답을 오답으로 학습시키는 false negative가 생길 수 있다.

온톨로지의 상위 타입을 묻는 질의에는 여러 하위 개념 문서가 정답일 수 있다. `포유류의 예`에 고래 문서와 개 문서를 모두 정답으로 지정한다면 정답 집합 $P(q)$를 사용한다. 정답 집합의 전체 확률을 높이는 한 가지 목적은

$$L=-\log\frac{\sum_{j\in P(q)}\exp(s_j/\tau)}{\sum_j\exp(s_j/\tau)}$$

이다. 이 목적은 정답 하나에 높은 확률을 집중시켜도 작아질 수 있다. 모든 정답을 고르게 상위로 올려야 한다면 positive별 loss 평균 등의 다른 목적을 검토해야 한다. 아래 계산은 그 차이를 드러내는 작은 예다.

```python
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
```

두 번째 문서도 정답인데 확률은 첫 번째보다 훨씬 작다. 이 상황에서 loss가 작다는 것은 식이 요구한 일을 하고 있다는 뜻이며, 모든 정답을 균등하게 찾았다는 뜻은 아니다. label의 의미와 loss의 최적점이 맞는지 먼저 따져야 한다.
