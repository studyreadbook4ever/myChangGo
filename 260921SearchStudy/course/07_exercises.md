# 7. 코드를 바꾸는 연습

완성 코드를 실행하는 동안에는 구현의 선택을 그대로 따라갔다. 이제 작은 요구사항을 바꾸어 직접 작성해 보자. 각 문제는 앞의 모델을 지우지 않고 별도 함수로 실험할 수 있다. 먼저 문제만 읽고 빈 셀에 구현한 뒤, 아래의 해설 코드와 비교한다. 해설 셀도 실행되므로 전체 노트북을 처음부터 실행하는 데는 막히는 곳이 없다.

## 7.1 lookup의 backward를 직접 계산하기

**문제.** 토큰 ID가 `[2, 4, 2, 0]`이고 각 조회 위치에서 도착한 gradient가 `[T,D]`로 주어진다. 임베딩 행렬의 gradient `[V,D]`를 반환하는 함수를 작성하라. 같은 ID는 합산하고 PAD 행은 제외한다. 이 함수에서 autograd를 호출하지 않는다.

한 위치의 gradient를 테이블의 해당 행으로 보내면 된다. 같은 행이 반복될 수 있으므로 대입이 아니라 더하기다. `scatter`나 `index_add`를 쓰는 구현도 가능하지만, 먼저 반복문으로 작성하면 어떤 값을 어디에 더하는지 확인하기 쉽다.

```python
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
```

ID 2는 두 번 등장했지만 첫 좌표는 $1+(-1)=0$이다. 등장 횟수와 gradient norm이 비례하지 않는 이유를 숫자로 볼 수 있다. 저장 공간을 아끼기 위해 sparse gradient를 쓰는 구현도 있지만, 현재 모델은 작은 테이블이므로 dense gradient로 충분하다.

## 7.2 max pooling을 구현하기

**문제.** 내용 토큰들의 각 좌표별 최댓값을 반환하는 `masked_max(hidden, mask)`를 작성하라. PAD를 0으로 바꾸고 최댓값을 구하면 음수만 있는 좌표에서 오류가 난다. 그 반례를 먼저 만들고 고쳐 보라.

```python
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
```

`SentenceEncoder.forward`의 pooling 부분을 이 함수로 바꿀 수 있다. 이미 학습된 mean 모델의 pooling만 바꿔 본 결과는 추론 규칙 변경 실험이다. max pooling으로 학습한 모델과 비교하려면 같은 초기 encoder에서 새 projection과 optimizer로 다시 학습해야 한다. 두 실험의 질문을 섞지 않는다.

## 7.3 모든 positive를 학습시키는 목적함수

**문제.** 5장의 집합 확률 loss 대신, positive마다 negative log probability를 계산하고 평균하는 함수를 작성하라. 각 질의의 positive 수가 달라도 질의마다 같은 비중을 주어야 한다. positive가 하나라면 일반 CE와 같아야 한다.

$$L_i=-\frac{1}{|P_i|}\sum_{j\in P_i}\log p_{ij},\qquad L=\frac1B\sum_i L_i.$$

```python
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
```

positive가 두 개일 때 이 목적은 두 정답의 확률이 균형을 이루는 방향도 요구한다. 현재 첫 정답에 확률이 지나치게 몰려 있으면 첫 점수를 낮추는 gradient가 나올 수 있다. ‘정답 점수는 항상 올라야 한다’는 규칙을 기계적으로 적용하면 이런 목적을 이해하기 어렵다. 원하는 검색 행동이 무엇인지부터 정하고 식을 읽어야 한다.

한 질의에서 logit에 대한 미분은 $p_j-\mathbf{1}[j\in P]/|P|$이다. 정답이 두 개라면 각 정답에 1/2씩 확률을 배분하고 나머지에는 0을 주는 것이 최적이다. 그때 loss의 하한은 0이 아니라 $\log2$이다. 일반적으로 이 loss는 positive에 균등한 정답 분포 y의 entropy와 $\mathrm{KL}(y\Vert p)$의 합이므로, 하한은 $\log|P|$이다. 서로 다른 positive 수나 목적함수의 loss를 절대값만으로 비교하면 안 된다.

## 7.4 길이 제한을 넘는 문서를 chunk로 나누기

**문제.** encoder의 `max_len=96`에는 `[CLS]`, `[SEP]`도 포함된다. 원문을 BPE ID로 바꾼 뒤 내용 토큰을 최대 94개씩 자르고, 인접 chunk가 일부 토큰을 공유하게 하라. 각 chunk가 원문의 어느 ID 구간에서 왔는지도 남겨야 한다.

아래 구현은 토큰 수준의 chunking이다. 문장 경계를 보존하지 않으며, subword 중간에서 끊길 수 있다. 긴 글의 문단 구조가 중요하다면 문장·문단 경계와 길이 제한을 함께 사용해야 한다. 문서 정답 label을 chunk 정답으로 옮길 때에도 모든 chunk가 답을 담고 있다고 가정하면 안 된다.

```python
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
```

chunk 벡터를 검색해서 반환할 때에는 `(원문 문서 ID, 시작 위치, 끝 위치)`를 함께 보관한다. 여러 chunk가 같은 원문에서 나왔을 때 문서 하나로 합칠지, 답이 포함된 부분을 그대로 보여 줄지도 제품의 요구에 따라 결정한다. 이 예에서 위치는 문자 offset이 아니라 **BPE ID의 offset**이다. 원문을 정확히 하이라이트하려면 tokenizer 단계부터 문자 offset을 추적해야 한다.

## 7.5 다중 정답과 관련성 등급을 평가하기

**문제.** 문서의 관련성 등급이 0, 1, 2처럼 주어질 때 nDCG@k를 계산하라. 이 실습에서는 gain을 $2^{rel}-1$, 순위 discount를 $\log_2(r+1)$로 정한다. DCG를 가능한 이상적 순서의 DCG로 나눈 것이 nDCG다. 어떤 gain을 썼는지 명시해야 지표 숫자를 비교할 수 있다.

```python
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
```

관련성 판정이 없는 문서를 코드에서는 0으로 처리했다. 실제 평가 자료에서는 미판정 문서가 곧 무관한 문서라는 뜻은 아니다. 검색기가 새로 찾아낸 좋은 문서가 label에 없으면 점수가 낮아질 수 있다. 결과를 읽을 때 판정 자료의 범위도 확인해야 한다.

## 7.6 온톨로지로 더 어려운 평가 자료를 설계하기

**문제.** 현재 자료는 같은 entity를 여러 표현으로 반복한다. 새로운 entity와 관계 조합에도 학습한 규칙이 적용되는지 보려면 어떻게 나눌 것인가?

먼저 토크나이저가 그 entity를 표현할 수 있는지와, encoder가 새 조합을 처리하는지를 분리해야 한다. 토크나이저에서 전부 `[UNK]`로 바뀌었다면 이후 모델의 관계 추론을 검사한 것이 아니다. 다음 셀은 새 표현을 넣기 전에 입력 정보가 어디까지 보존되는지 조사하는 예다.

```python
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
```

새 실험에서는 먼저 train/validation/test의 entity 집합 또는 관계 조합을 정한다. 그 뒤 각 split 안에서만 문장을 만든다. 모든 문장을 만든 다음 무작위로 섞으면 거의 같은 template와 entity 조합이 여러 split에 들어가기 쉽다. 상위·하위 타입이나 동의 표현으로 positive를 늘릴 때도 ‘같은 개념’과 ‘이 질의에 답함’은 별도의 판정이다. `고양이 사료` 문서가 `고양이가 무엇을 쫓는가`의 정답은 아니다.

<details>
<summary>분할 설계의 한 가지 해설</summary>

세 평가를 따로 둔다. 첫째는 같은 entity와 관계에서 새 질의 표현을 평가한다. 둘째는 각 entity와 관계는 학습에 있지만 그 조합은 처음인 경우를 평가한다. 셋째는 entity 자체가 처음인 경우를 평가한다. tokenizer는 허용된 학습 corpus로만 학습하고 각 평가의 UNK 비율을 별도로 기록한다. 셋째 평가에 UNK가 많다면 tokenization 문제와 encoder 일반화 문제를 나누어 보고한다. 문서가 미리 알려진 실험과 문서 자체도 처음인 실험 역시 구분한다.

각 관계의 정방향과 역방향을 같은 split 안에 배치해 어려운 negative를 만든다. 단, 대칭 관계라면 역방향을 오답으로 만들지 않는다. 예를 들어 ‘형제 관계’를 방향이 있는 ‘가르치다’ 관계와 같은 방식으로 label하면 지식과 supervision이 충돌한다.

</details>

## 자주 막히는 지점

| 증상 | 먼저 확인할 것 | 이 교재에서 확인할 위치 |
|---|---|---|
| 토큰 ID가 embedding 범위를 벗어남 | 모델 생성 후 tokenizer를 다시 학습했는가 | 1장의 저장/복원, 2장의 config |
| 모든 loss가 NaN | 전부 PAD인 행, 전부 ignore인 label, 불안정한 exp, 너무 큰 update | 2장의 key mask, 3장의 선택 위치 검사 |
| padding 길이에 따라 결과가 크게 바뀜 | key mask와 pooling mask의 역할을 혼동했는가 | 6.3의 padding 불변성 |
| gradient가 계속 누적됨 | step 전에 zero_grad를 호출했는가 | 3.5와 5.5 |
| backward를 두 번 할 때 오류 | 소비한 그래프를 재사용했는가 | forward부터 재실행 |
| 학습 loss는 작지만 검색이 틀림 | 중복 정답을 negative로 뒀는가, label의 관련성이 타당한가 | 5.7 |
| eval인데 gradient가 만들어짐 | eval은 미분을 끄는 명령이 아님 | 2.1의 PyTorch 실행 규칙 |
| 저장 후 다른 문서가 반환됨 | tokenizer·모델·문서 벡터·행 ID가 같은 버전인가 | 6.5 |

## 여기서 규모를 늘릴 때

정확 검색은 N개 문서, d차원 벡터에 대해 질의당 대략 O(Nd)의 점수 계산을 한다. float32 벡터만 저장하면 대략 `4*N*d` byte가 필요하다. 백만 문서를 768차원으로 저장하면 벡터 값만 약 3.07 GB다. 이 수치는 원문과 인덱스의 부가 자료를 포함하지 않는다.

ANN 인덱스는 이 검색을 근사해서 계산량과 정확도의 교환관계를 만든다. 이때 ‘정확한 벡터 검색의 top-k를 얼마나 재현하는가’와 ‘실제 관련 문서를 얼마나 찾는가’는 다른 지표다. 좋은 ANN 설정도 잘못 학습된 임베딩의 관련성을 고쳐 주지는 않는다. 이후에 cross-encoder로 후보를 재정렬하면 토큰 간 상호작용을 더 계산할 수 있지만, 첫 검색에서 빠진 문서는 후보를 추가하지 않는 한 복구할 수 없다.

실제 데이터로 옮길 때에는 BM25 같은 어휘 검색도 같은 정답 자료에서 비교한다. 제품 번호, 숫자, 희귀 고유명사는 벡터 모델이 놓칠 수 있다. 어느 방법이 좋은지는 모델 이름보다 검색할 자료와 질문의 분포에 달려 있다. 작은 교육 자료에서 얻은 100%를 모델 선택의 근거로 사용하지 않는다.

## 스스로 다시 작성해 볼 순서

완성 코드를 닫고 다음 네 인터페이스를 빈 파일에 적는다. 각 함수의 입력과 출력 shape부터 적은 뒤 구현한다.

1. `encode(text) -> list[int]`: 정규화, BPE rank 적용, 특수 토큰, 미등록 문자 처리.
2. `encoder(input_ids, attention_mask) -> [B,T,D]`: lookup, 위치, QKV, mask, residual, FFN.
3. `sentence_encoder(batch) -> [B,d]`: 내용 mask의 평균, projection, 정규화.
4. `loss(queries, documents, targets) -> scalar`: 독립 인코딩, 점수 행렬, 후보 집합, CE.

그 뒤 한 토큰 행의 gradient를 수치 미분으로 확인하고, 역할을 뒤집은 문서 쌍을 만들고, 저장한 모델의 검색 결과를 복원한다. 이 네 함수와 세 검사를 자신의 코드로 작성하면, 이 노트북에서 사용한 구조의 계산과 학습을 직접 재구성한 것이다.

## 원전과 구현 문서

토크나이저의 BPE 학습은 [Sennrich et al., 2016](https://aclanthology.org/P16-1162/)에서 번역의 희귀어 문제와 함께 읽을 수 있다. 경계 표식과 Unicode 정규화는 이 교재가 선택한 구체적인 구현 규칙이다.

attention 계산과 차원별 scaling은 [Vaswani et al., 2017](https://arxiv.org/abs/1706.03762)의 3절에 설명되어 있다. BERT의 입력 표현과 MLM·NSP는 [Devlin et al., 2019](https://aclanthology.org/N19-1423/)의 3절을 참고한다. 이 교재는 그중 양방향 encoder와 MLM을 사용하며 원형 BERT 전체를 재현하지 않는다.

문장 벡터를 비교 가능하게 학습하는 문제는 [Sentence-BERT](https://aclanthology.org/D19-1410/)로, 질의와 문서의 독립 인코딩을 검색 supervision과 연결하는 문제는 [DPR](https://aclanthology.org/2020.emnlp-main.550/)로 이어진다. 코드와 라이브러리의 경계를 확인할 때에는 [Embedding](https://docs.pytorch.org/docs/stable/generated/torch.nn.Embedding.html)과 [CrossEntropyLoss](https://docs.pytorch.org/docs/stable/generated/torch.nn.CrossEntropyLoss.html)의 파라미터 정의를 함께 읽는다.
