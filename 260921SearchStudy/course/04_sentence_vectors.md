# 4. 토큰마다 나온 벡터를 문장 하나의 벡터로 묶기

MLM head에 들어가던 encoder의 출력은 토큰 위치마다 있다. 길이 20인 문장의 hidden state는 `[1, 20, 48]`이고, MLM head는 이를 `[1, 20, V]`의 어휘 점수로 바꾸었다. 이제 그 head를 떼고 문장 하나의 벡터를 만든다. 문서마다 벡터 하나를 미리 계산해 두면 질의가 들어올 때 행렬곱으로 관련성 점수를 계산할 수 있다.

토큰 표현을 문장 표현으로 묶는 연산을 pooling이라고 부른다. 여기에는 정답 하나가 정해져 있지 않다. `[CLS]` 위치를 쓰거나, 내용 토큰의 평균을 쓰거나, 추가적인 attention pooling을 학습할 수 있다. 어떤 방법을 택하든 그 표현이 검색 관련성을 담도록 학습해야 한다. `[CLS]`라는 이름 자체가 그 벡터를 좋은 문장 요약으로 만들지는 않는다.

## 4.1 평균을 낼 때 무엇을 분모에 넣을 것인가

내용 토큰을 가리키는 mask를 $m_t\in\{0,1\}$라고 쓰면 평균은 다음과 같다.

$$u_b=\frac{\sum_t m_{bt}H_{bt}}{\sum_t m_{bt}}.$$

`H`의 shape는 `[B, T, D]`, mask는 `[B, T]`다. mask 끝에 차원 하나를 더해 `[B, T, 1]`로 만들면 같은 mask 값이 D개의 좌표에 적용된다. 합산할 축은 토큰 축인 `dim=1`이다. 분모는 실제 내용 토큰 수다. 배치에서 가장 긴 문장에 맞춘 T를 분모에 넣으면, 같은 문장이 어떤 문장과 함께 배치되는지에 따라 크기가 달라진다.

encoder의 key padding mask와 이 mask는 역할이 다르다. 앞의 mask는 PAD를 읽지 못하게 하고, 지금의 mask는 PAD 위치에서 나온 출력을 평균에 넣지 못하게 한다. 앞에서 위치와 segment 벡터, bias를 더했으므로 PAD 위치의 hidden state가 0이라고 가정하면 안 된다. 이 실습에서는 `[CLS]`, `[SEP]`도 평균에서 뺀다. 다른 선택도 가능하지만 학습과 추론에서 같은 규칙을 써야 한다.

```python
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
```

마지막 위치의 100은 PAD의 hidden state를 흉내 낸 값이다. 값이 크든 작든 mask가 False인 위치는 결과에 영향을 주지 않아야 한다. 위의 첫 출력은 `[2, 3]`이다.

## 4.2 차원 축소와 길이 정규화

encoder의 48차원 평균을 32차원으로 바꾼다. 이는 검색 벡터의 저장 비용을 정하는 별도의 설계다. 선형층의 가중치도 검색 loss로 학습한다.

$$v=Wu,\qquad z=\frac{v}{\|v\|_2}.$$

두 벡터의 길이가 1이면 내적은 cosine similarity와 같다. 아래 구현은 norm이 0에 가까울 때 0으로 나누지 않도록 epsilon을 사용한다. 정규화를 생략한 내적에서는 벡터 길이도 점수에 관여한다. 따라서 정규화 여부는 인덱스를 만들 때와 질의를 처리할 때 함께 고정해야 한다.

정규화의 미분도 계산해 둘 수 있다. $r=\sqrt{v^Tv}$, $z=v/r$일 때 $dr=v^Tdv/r$이다. 이를 대입하면

$$dz=\frac{1}{r}dv-\frac{v}{r^2}dr
=\frac{I-zz^T}{r}dv.$$

따라서 앞에서 도착한 gradient가 $g_z$라면 $g_v=(I-zz^T)g_z/r$이다. 현재 벡터 방향의 성분을 빼므로 점수 학습은 단순히 벡터를 길게 늘리는 방식으로 해결되지 않는다. 이 식은 norm이 epsilon보다 큰 영역에 적용된다.

```python
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
```

이 시점의 encoder는 MLM을 배웠지만 projection은 새로 초기화했다. 문장 벡터를 계산할 수 있게 됐다는 사실과 검색이 잘된다는 사실을 구분해야 한다. 다음 장에서 이 벡터들의 관계를 검색 정답에 맞춰 바꾼다.

## 4.3 모든 좌표에 이름을 붙일 수는 없다

온톨로지에서는 관계의 이름과 방향을 명시한다. 임베딩의 한 좌표가 그 관계 하나를 전담해야 하는 것은 아니다. 검색 출력 벡터 전체에 같은 직교행렬 R을 곱하면

$$ (Rz_q)^T(Rz_d)=z_q^TR^TRz_d=z_q^Tz_d $$

이므로 점수는 변하지 않는다. 그만큼 검색 목적만으로 좌표축의 의미가 유일하게 결정되지는 않는다. 이를 실제 벡터로 확인해 보자.

```python
torch.manual_seed(19)
rotation, _ = torch.linalg.qr(torch.randn(32, 32))
original_scores = sample_vectors @ sample_vectors.T
rotated_vectors = sample_vectors @ rotation
rotated_scores = rotated_vectors @ rotated_vectors.T
torch.testing.assert_close(original_scores, rotated_scores, atol=1e-6, rtol=1e-5)
print("좌표를 회전시킨 뒤 점수의 최대 차이:", float((original_scores - rotated_scores).abs().max()))
```

이것은 검색 출력 공간에 관한 성질이다. encoder의 모든 중간 파라미터를 마음대로 회전해도 동일한 모델이 된다는 뜻은 아니다. 또한 입력 임베딩에서 ‘추격’에 가까운 토큰을 나열하는 것만으로 최종 검색 결과를 설명할 수도 없다. 입력 표현은 attention과 projection을 거쳐 다른 표현으로 바뀐다.

## 4.4 비교할 평균 모델을 하나 더 만든다

문맥 encoder 없이도 검색 loss로 토큰 테이블을 학습할 수 있다. 이 모델을 같이 두면 학습 목적의 효과와 구조의 제한을 구분하기 쉽다. 시작 토큰 테이블은 위 MLM encoder에서 복사하고 projection의 초기값도 같은 seed로 맞춘다. 이후 두 모델은 독립적으로 학습한다.

평균 모델에서는 같은 ID들의 multiset을 가진 두 문서를 구분할 수 없다. 같은 행들을 같은 횟수 더하기 때문이다. 그 뒤에 선형층이나 비선형층을 더해도, 동일한 입력 벡터에 적용하면 동일한 출력이 나온다.

```python
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
```

문자열을 보며 ‘단어가 같으니 평균도 같다’고 추측하는 데서 끝내지 않고, 실제 tokenizer의 ID까지 확인했다. BPE가 단어 경계를 넘어 merge하거나, 두 표현의 정규화 결과가 달라지면 이 최소쌍의 조건도 달라질 수 있다. 구조에 관한 주장은 모델에 들어가는 실제 입력으로 확인해야 한다.
