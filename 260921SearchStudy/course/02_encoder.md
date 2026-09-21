## 2. 토큰 테이블에서 문맥을 계산하는 encoder까지

앞 장의 토크나이저는 문자열을 정수 배열로 바꾸었다. 이제 정수 배열에서 검색에 쓸 표현을 계산하는 함수를 만든다. 입력 ID는 학습 중에도 그대로이고, ID에 연결된 벡터와 그 벡터를 변환하는 가중치가 바뀐다.

이번 장의 출력은 아직 문장 벡터가 아니다. 길이가 $T$인 문장을 넣으면 토큰마다 하나씩, 모두 $T$개의 벡터를 돌려주는 encoder다. 3장에서는 이 출력으로 빈칸을 복원하고, 4장에서는 출력들을 모아 문장 하나를 벡터 하나로 바꾼다.

구현은 다음 순서로 쌓는다. 각 상자의 입력과 출력에 배치 차원 $B$가 붙는다.

```text
input_ids [B,T]
    ↓ 토큰·위치·구간 임베딩의 합 + LayerNorm
X₀ [B,T,D]
    ↓ self-attention → residual + LayerNorm → FFN → residual + LayerNorm
X₁ [B,T,D]
    ↓ 같은 구조의 두 번째 block (가중치는 서로 다름)
H  [B,T,D]
```

우리는 양방향 attention, 학습하는 위치 임베딩, 구간 임베딩, GELU, Post-LayerNorm을 사용한다. 원래 BERT는 WordPiece와 MLM·NSP 사전학습을 사용한다. 이 수업은 앞에서 만든 BPE와 작은 encoder를 쓰며, NSP는 구현하지 않는다. 따라서 이름 `TinyBert`는 구조를 설명하기 위한 이름이다. 원래 BERT의 축소 재현 실험이라고 해석하지 않는다. [BERT 논문, 3절](https://aclanthology.org/N19-1423.pdf)

### 2.1 lookup의 역전파를 먼저 손으로 확인한다

임베딩 lookup은 $E\in\mathbb{R}^{V\times D}$에서 행을 고르는 연산이다. 같은 토큰 ID가 문장 안에 두 번 등장해도 테이블에 그 토큰의 행이 두 개 생기지는 않는다. 두 위치에서 계산된 gradient가 같은 행에 더해진다.

손으로 검산할 수 있도록 어휘 6개, 차원 3개의 테이블을 만든다. 실제 모델의 테이블과 분리된 연습용 변수다.

PyTorch 문법을 처음 쓰는 경우에는 다음 약속을 먼저 읽으면 된다. `nn.Module`은 파라미터와 계산을 함께 담는 기본 클래스다. 이를 상속하고 `super().__init__()`을 호출한 뒤 `self.layer = nn.Linear(...)`처럼 층을 연결하면, `model.parameters()`가 그 층의 학습할 값까지 모아 준다. `model(x)`는 우리가 정의한 `forward(x)`를 호출한다. `Embedding.weight`는 lookup할 실제 행렬이다.

`model.eval()`은 dropout 같은 층을 추론 방식으로 바꾸지만 미분을 끄지는 않는다. `torch.no_grad()`는 그 구간의 계산 그래프를 기록하지 않는다. `tensor.detach()`는 해당 텐서에서 이전 계산으로 이어지는 미분 경로를 끊는다. 학습에서는 그래프를 보존하고, 출력 표시나 순수 평가에서는 불필요한 그래프를 만들지 않도록 이들을 구분해 쓴다.

```python
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
```

수식으로는 one-hot 행렬 $O\in\{0,1\}^{T\times V}$와의 곱 $X=OE$다. 실제 lookup 구현은 거대한 one-hot 행렬을 만들 필요가 없다. ID로 필요한 행만 읽는다. 토큰마다 독립된 벡터를 **조회**한다는 뜻이며, gradient가 자동으로 그 토큰의 뜻을 알아낸다는 뜻은 아니다. 어떤 loss를 달아 주는지가 무엇을 배우는지 결정한다.

위치별 계수를 $a=[1,2,3,9]$로 두고 다음처럼 단순한 loss를 만든다.

$$L=\sum_{i=0}^{3}a_i\sum_{k=0}^{2}E_{\mathrm{id}_i,k}.$$

ID 2는 위치 0과 2에서 사용되므로 각 좌표의 gradient가 $1+3=4$다. ID 4는 $2$다. 사용되지 않은 ID 1·3·5는 $0$이다. PAD는 `padding_idx=0`으로 지정했으므로 lookup을 통한 gradient 누적에서 제외된다. 이 PAD 처리만큼은 보통의 one-hot 곱과 역전파 규칙이 다르다. [PyTorch Embedding](https://docs.pytorch.org/docs/stable/generated/torch.nn.Embedding.html)

```python
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
```

**실행 후 짚을 점.** 등장 횟수가 많으면 gradient가 더해지는 것은 맞다. 실제 검색 loss에서는 위치별 gradient의 방향도 서로 다를 수 있으므로, 빈도가 두 배라고 업데이트 크기가 반드시 두 배가 되지는 않는다. 또한 `padding_idx`는 해당 lookup 경로의 gradient를 막는다. 다른 loss가 `weight`를 직접 사용하면 그 경로는 별도로 생각해야 한다. 뒤의 MLM에서 입력 테이블과 출력 가중치를 공유할 때 이 차이가 다시 나온다.

### 2.2 토큰·위치·구간의 세 좌표계를 더한다

이제 실제 모델 크기를 정한다. 기본값은 $D=48$, head 4개, block 2개다. 따라서 한 head의 차원 $d_h$는 $48/4=12$다. 작은 CPU 실습이 가능하도록 정한 값이며, $48$에 언어적인 의미가 있는 것은 아니다.

`@dataclass`는 이 설정값을 모으기 위한 Python 문법이다. 필드 목록으로 초기화 함수를 만들고, 객체를 만든 직후 `__post_init__`을 실행한다. 신경망의 계산을 수행하는 클래스는 아니다. 예를 들어 `ModelConfig(vocab_size=242, n_heads=4)`는 크기에 관한 약속을 만들고, 실제 파라미터는 다음 클래스에서 생성한다.

```python
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
```

토큰 ID $t_i$, 위치 $i$, 구간 ID $s_i$가 주어지면 입력은 다음과 같다.

$$x_i=\operatorname{Dropout}(\operatorname{LN}(E_{t_i}+P_i+S_{s_i})).$$

$E$는 토큰 테이블, $P$는 위치 테이블, $S$는 두 구간을 구별하는 테이블이다. 모두 $D$차원 벡터를 돌려주므로 더할 수 있다. 이어 붙이면 $3D$차원이 되고 뒤의 모든 층도 달라져야 한다.

구간 ID는 문장의 의미 분류가 아니다. 두 텍스트를 한 입력에 넣는 경우 어느 쪽에서 왔는지 구별하는 입력 표식이다. 이후 검색에서는 질의와 문서를 각각 encoder에 넣으므로 모든 구간 ID를 0으로 둔다. 같은 구간 벡터라도 LayerNorm 이전에 들어가므로 단순히 계산에서 제거해도 항상 결과가 같다고 할 수는 없다.

```python
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
```

입력 테이블들은 $\mathcal{N}(0,0.02^2)$로 초기화했다. 이후 만드는 Linear 층은 PyTorch 기본 초기화를 사용한다. LayerNorm의 $\epsilon$도 여기서 명시한 값이다. 이 선택들은 실습의 고정 조건이며 원래 BERT의 모든 초기화 규칙을 재현하려는 설정은 아니다. `dropout=0`은 학습 중간의 검산과 비교를 재현하기 쉽게 한다. 모델 규모나 데이터를 늘리는 실험에서는 별도로 검증할 값이다.

PAD의 토큰 벡터가 0이어도 PAD 위치에 위치·구간 벡터가 더해지면 그 위치의 출력은 0이 아닐 수 있다. 이후 attention에서 PAD를 읽지 않게 하고 pooling에서도 제외해야 한다. `padding_idx=0` 하나로 padding 처리가 전부 끝나지 않는다.

```python
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
```

### 2.3 attention 한 행을 숫자로 계산한다

Self-attention은 각 위치의 표현을 읽어 세 종류의 벡터를 계산한다.

$$Q=XW_Q+b_Q,\qquad K=XW_K+b_K,\qquad V=XW_V+b_V.$$

위치 $i$의 query $q_i$가 위치 $j$의 key $k_j$와 내적한다. 이 점수들을 같은 $i$ 안에서 softmax한 값이 $v_j$들을 섞는 가중치다.

$$a_{ij}=\frac{\exp(q_i^\top k_j/\sqrt{d_h})}
{\sum_{r\text{가 유효한 key}}\exp(q_i^\top k_r/\sqrt{d_h})},
\qquad o_i=\sum_j a_{ij}v_j.$$

여기서 **query는 attention 내부 벡터의 이름**이다. 검색 질의 문장이라는 뜻이 아니다. 문서 encoder에도 각 토큰 위치의 attention query가 있다. 검색의 질의·문서 구분과 attention의 Q·K·V 구분은 서로 다른 층위다.

우선 투영 가중치를 건너뛰고 Q·K·V가 이미 주어진 작은 경우를 계산한다. 첫 위치의 Q는 `[1,0]`이므로 K의 첫 좌표가 큰 위치에 더 높은 점수를 준다. 출력은 V의 가중합이며, 반드시 입력 V 중 하나와 같아야 하는 것은 아니다.

```python
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
```

왜 $\sqrt{d_h}$로 나누는가? Q와 K의 모든 좌표가 서로 독립이고 각각 평균 0, 분산 1이라고 가정하면 $q^\top k=\sum_{m=1}^{d_h}q_mk_m$의 분산은 $d_h$다. 좌표가 많아지면 softmax에 들어가는 점수의 크기가 커지고 한 위치로 지나치게 집중할 수 있다. $\sqrt{d_h}$로 나누면 이 가정 아래 분산은 다시 1이 된다. 실제 학습된 Q·K가 이 가정을 정확히 만족하는 것은 아니지만, 차원 증가에 따른 점수 크기의 변화를 줄이는 출발점이다. [Attention Is All You Need, 3.2.1절](https://arxiv.org/abs/1706.03762)

softmax를 직접 구현할 때는 가장 큰 값을 먼저 빼야 지수 함수 overflow를 줄일 수 있다. 모든 점수에서 같은 상수를 빼면 확률은 바뀌지 않는다. 실제 모델에서는 안정적인 구현인 `torch.softmax`를 쓴다.

```python
attn_large_scores = torch.tensor([1000., 1001., 1002.])
attn_stable_exp = torch.exp(attn_large_scores - attn_large_scores.max())
attn_manual_softmax = attn_stable_exp / attn_stable_exp.sum()
assert torch.allclose(attn_manual_softmax,
                      torch.softmax(attn_large_scores, dim=-1))
print("큰 점수에서도 유한한 확률:", attn_manual_softmax.tolist())
```

### 2.4 padding mask는 key 축을 가린다

배치에서 길이를 맞추려고 붙인 PAD는 읽을 내용이 아니다. 유효한 key의 점수는 그대로 두고 PAD key의 점수만 $-\infty$로 바꾸면 softmax 뒤 확률이 0이 된다.

마스크에서 `True`는 **읽어도 되는 토큰**으로 통일한다. 일부 라이브러리는 반대 뜻을 쓰므로 다른 구현에 연결할 때 boolean의 의미를 확인해야 한다.

```python
attn_small_valid = torch.tensor([True, True, False])
attn_masked_scores = attn_small_scores.masked_fill(
    ~attn_small_valid[None, :], float("-inf")
)
attn_masked_weights = torch.softmax(attn_masked_scores, dim=-1)
assert torch.equal(attn_masked_weights[:, 2], torch.zeros(3))
assert torch.allclose(attn_masked_weights.sum(dim=-1), torch.ones(3))
print("PAD key의 확률:", attn_masked_weights[:, 2].tolist())
print("각 query가 읽는 확률의 합:", attn_masked_weights.sum(-1).tolist())
```

query 위치 자체가 PAD여도 유효한 key를 읽으므로 그 위치의 출력은 0이 아닐 수 있다. 우리는 그 출력을 나중에 버린다. 모든 block에서 PAD key를 계속 가리면 PAD query의 출력이 유효한 위치로 되돌아 들어가지 않는다.

모든 key가 PAD면 한 행 전체가 $-\infty$가 되어 softmax를 정의할 수 없다. 구현에서는 그런 입력을 오류로 처리한다. 일반 입력에는 `[CLS]`와 `[SEP]`가 있지만, 모델 함수 자체도 조건을 검사해야 별도의 호출 실수를 빨리 찾을 수 있다.

생성 모델의 causal mask는 미래 위치 $j>i$를 읽지 못하게 하는 별도의 제한이다. 여기서는 문장 전체가 검색 시점에 이미 주어지므로 양쪽 문맥을 읽는 encoder를 만든다. 아래 행렬은 두 제한의 차이다. 값 1이 읽을 수 있는 위치다.

```python
attn_padding_allowed = attn_small_valid[None, :].expand(3, 3)
attn_causal_allowed = torch.tril(torch.ones(3, 3, dtype=torch.bool))
show_table(
    ["query 위치", "padding만 적용", "causal만 적용", "둘 다 적용"],
    [[i, attn_padding_allowed[i].int().tolist(),
      attn_causal_allowed[i].int().tolist(),
      (attn_padding_allowed & attn_causal_allowed)[i].int().tolist()]
     for i in range(3)],
)
```

### 2.5 여러 head를 배치 차원처럼 계산한다

$X$의 shape은 `[B,T,D]`다. Q·K·V를 각각 `[B,T,D]`로 투영한 다음 마지막 차원을 head 수 $H$와 head 차원 $d_h$로 나눈다.

| 연산 | shape | 의미 |
|---|---|---|
| `projection(x)` | `[B,T,D]` | 각 위치의 D개 좌표 계산 |
| `reshape(B,T,H,d_h)` | `[B,T,H,d_h]` | head별 좌표 묶음으로 해석 |
| `transpose(1,2)` | `[B,H,T,d_h]` | head마다 T×d_h 행렬 배치 |
| `q @ k.transpose(-2,-1)` | `[B,H,T,T]` | query 위치별 key 위치 점수 |
| `weights @ v` | `[B,H,T,d_h]` | head별 문맥 벡터 |
| `transpose` 후 `reshape` | `[B,T,D]` | head 출력들을 이어 붙임 |

head마다 입력을 일부씩만 읽는 것은 아니다. 각 head의 Q·K·V 좌표를 만드는 Linear 가중치는 입력의 모든 D좌표를 읽는다. 투영 **후** 결과 좌표를 head별로 나누는 것이다. 마지막 출력 투영 $W_O$는 이어 붙인 head들의 정보를 다시 섞는다.

```python
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
```

`valid[:, None, None, :]`의 shape은 `[B,1,1,T]`다. 이를 `[B,H,T,T]`에 broadcast하면 같은 문장의 모든 head와 모든 query 위치에서 동일한 PAD key를 가린다. 마지막 축이 key 축이라는 사실이 구현의 기준이다.

코드의 `weights`는 dropout 전의 확률이다. 실제 context 계산에는 dropout 후 값을 쓴다. `dropout>0`이며 학습 모드일 때 dropout 후 한 행의 합이 정확히 1일 필요는 없다. 평가 모드에서는 dropout이 꺼진다.

다음 검산은 reshape가 올바른지 확인한다. 벡터화 구현과 head별 반복문 구현이 같은 결과를 내야 한다. `einsum` 비교는 특히 Q·K의 두 위치 축을 뒤집는 실수를 잡는다.

```python
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
```

### 2.6 residual, LayerNorm, FFN을 붙인다

attention만 거듭 적용하는 대신 입력을 우회해서 더하는 residual 경로를 만든다. 입력 $X$에서 하나의 block은 다음을 계산한다.

$$U=\operatorname{LN}_1(X+\operatorname{Dropout}(\operatorname{Attention}(X))),$$

$$H=\operatorname{LN}_2(U+\operatorname{Dropout}(W_2\operatorname{GELU}(W_1U+b_1)+b_2)).$$

위 수식의 Linear 표기는 벡터 표기 관례에 따른 것이다. 코드에서는 마지막 차원에 `nn.Linear`를 적용한다. PyTorch의 `Linear` 가중치 저장 shape은 `[out_features,in_features]`이고 실제 계산은 `x @ weight.T + bias`다.

residual은 변환이 만든 보정량을 원래 표현에 더한다. gradient가 변환층을 거치지 않고 덧셈의 입력으로 흐르는 경로도 생긴다. 그러나 뒤에 LayerNorm이 있으므로 block 전체의 gradient가 항상 항등행렬이라는 뜻은 아니다.

LayerNorm은 각 토큰의 **D개 좌표**에서 평균과 분산을 구한다. 다른 문장이나 다른 토큰의 통계를 섞지 않는다.

$$\mu_{b,t}=\frac{1}{D}\sum_k x_{b,t,k},\quad
\sigma^2_{b,t}=\frac{1}{D}\sum_k(x_{b,t,k}-\mu_{b,t})^2,$$

$$\operatorname{LN}(x)_{b,t,k}=\gamma_k\frac{x_{b,t,k}-\mu_{b,t}}
{\sqrt{\sigma^2_{b,t}+\epsilon}}+\beta_k.$$

$\gamma,\beta$는 학습하는 좌표별 scale과 bias다. 아래에서는 초기값 $\gamma=1,\beta=0$으로 수식을 확인한다. 분산 계산에서 `unbiased=False`를 쓰는 이유는 분모가 $D-1$이 아닌 $D$이기 때문이다.

```python
ln_demo_input = torch.tensor([[[1., 2., 5.], [3., 3., 6.]]])
ln_demo_layer = nn.LayerNorm(3, eps=1e-5)
ln_demo_mean = ln_demo_input.mean(dim=-1, keepdim=True)
ln_demo_var = ln_demo_input.var(dim=-1, keepdim=True, unbiased=False)
ln_demo_manual = (ln_demo_input - ln_demo_mean) / torch.sqrt(ln_demo_var + 1e-5)
assert torch.allclose(ln_demo_layer(ln_demo_input), ln_demo_manual, atol=1e-6)
print("토큰별 평균:", ln_demo_mean.flatten().tolist())
print("정규화된 토큰별 벡터:", ln_demo_manual.squeeze(0).tolist())
```

FFN은 각 위치에 **동일한** 두 Linear 층을 독립적으로 적용한다. attention이 위치 사이의 정보를 섞고, FFN은 각 위치에서 좌표들을 비선형 변환한다. 중간 차원은 $D\rightarrow D_{ff}\rightarrow D$다. GELU를 빼고 Linear 두 개만 이어 붙이면 하나의 affine 변환으로 합칠 수 있으므로 중간층이 만드는 비선형 표현력이 사라진다.

Post-LN은 residual 덧셈 뒤에 LayerNorm을 두는 지금의 형태다. Pre-LN은 각 변환의 입력에 LayerNorm을 둔다. 두 방식은 계산식과 gradient 경로가 다르다. 이 수업은 BERT에 가까운 block을 추적하기 위해 Post-LN을 선택한다. 깊은 모델의 학습 안정성까지 이 작은 실험의 결과로 판단하지 않는다.

```python
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
```

### 2.7 작은 encoder를 조립한다

`nn.ModuleList`는 block을 저장하면서 내부 파라미터가 optimizer와 `state_dict()`에 등록되게 한다. 보통의 Python 리스트에만 넣으면 등록되지 않는다. 같은 block 객체 하나를 반복해 넣으면 층 사이에 가중치를 공유하게 되므로, 여기서는 매 반복마다 새 `EncoderBlock`을 만든다.

```python
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
```

위 함수의 `pool_mask` 인자가 없는 점을 확인하자. encoder는 `[CLS]`·`[SEP]`를 포함한 유효한 토큰을 모두 읽는다. 문장 벡터를 만드는 쪽에서 어떤 토큰을 평균에 포함할지 결정하므로 pooling mask는 그때 사용한다.

```python
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
```

학습하지 않은 모델에서도 서로 다른 문맥의 출력은 서로 다를 수 있다. 이는 구조가 입력 차이를 반영한다는 뜻이다. 그 차이가 검색에 필요한 관련성을 표현하는지는 아직 시험하지 않았다. 특히 `[CLS]`를 첫 토큰에 두었다는 이유만으로 그 출력이 문장 의미를 대표하지는 않는다. 그 위치가 어떤 학습 신호를 받았는지까지 보아야 한다.

### 2.8 모델이 반드시 지켜야 하는 두 성질

학습 loss가 내려가더라도 mask가 틀릴 수 있다. 우선 정답 레이블 없이 확인할 수 있는 성질을 검산한다. 첫째, 문장 뒤에 PAD를 더 붙여도 원래의 유효한 토큰 출력은 같아야 한다. 위치 ID도 그대로이고 PAD key는 읽지 않기 때문이다. Dropout의 무작위 효과를 없애기 위해 `eval()` 상태에서 비교한다.

```python
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
```

이 검사는 오른쪽 padding을 가정한다. 왼쪽에 PAD를 넣고 위치 ID를 0부터 새로 부여하면 원래 토큰의 위치 자체가 바뀐다. 그 경우 두 출력이 같아야 한다고 주장할 수 없다.

둘째, 위치 정보를 빼면 self-attention encoder는 토큰 순열에 대해 **equivariant**하다. 입력 순서를 바꾸면 출력도 같은 순서로 바뀐다. 다음 장의 mean pooling처럼 순서와 관계없이 합하는 연산까지 붙이면 두 문장의 최종 벡터가 같아진다.

이 성질은 단어 순서 문제와 곧바로 연결된다. 주체와 객체를 바꾸어도 같은 토큰 집합이면, 위치가 없는 encoder의 평균만으로는 두 관계를 구분할 수 없다. segment ID나 mask 같은 다른 입력 특징이 순서에 대한 추가 정보를 주지 않는 조건에서의 주장이다.

아래는 같은 토큰 ID들을 순열로 바꾼다. 텍스트를 다시 토큰화하지 않는 이유는 재토큰화 과정의 분할 차이를 없애고 encoder의 성질만 보기 위해서다.

```python
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
```

위치 정보를 넣으면 구별할 **가능성**이 생긴다. 관계를 실제로 구별하도록 학습됐다는 결론은 아니다. 뒤에서 순서가 뒤집힌 문서를 hard negative로 사용해 이 능력이 학습 신호와 어떻게 연결되는지 본다.

### 2.9 attention 그림에서 무엇을 읽을 수 있는가

첫 문장의 첫 block, 첫 head를 그린다. 행은 읽는 query 위치, 열은 읽히는 key 위치다. 행의 합은 1이다. 그림의 숫자는 토큰 위치이며, 바로 위 표에서 실제 조각을 확인한다. 한글 폰트를 별도로 설치하지 않은 환경에서도 그림을 읽을 수 있도록 축에는 숫자를 사용한다. 아직 무작위 초기화 상태이므로 특정 단어 관계를 찾아내려 하지 말고 축과 확률 범위를 확인한다. attention 값은 정보를 섞는 가중치이며, 이것만으로 최종 검색 판단의 원인을 모두 설명할 수는 없다.

```python
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
```

### 2.10 손으로 고쳐 볼 문제: softmax 축 하나가 틀리면

`[B,H,T,T]`에서 마지막 두 축의 크기가 같다는 점이 위험하다. `dim=-1` 대신 `dim=-2`를 써도 에러가 나지 않고 출력 shape도 같다. 다음 셀을 실행하기 전에 생각해 보자. 어떤 합이 1이 되어야 각 query가 key들을 섞는 가중치가 되는가?

```python
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
```

<details><summary>풀이와 추가 실험</summary>

각 query는 모든 key를 후보로 삼는다. 따라서 query 위치를 고정한 행 안에서, key 축인 마지막 축의 합이 1이어야 한다. 잘못된 구현은 key 하나를 여러 query가 나눠 갖도록 열을 정규화한다. shape 검사만으로는 이 차이를 잡을 수 없다.

1. `MultiHeadSelfAttention`의 `dim=-1`을 일부러 `dim=-2`로 바꾼 복사본을 만들고 위의 행 합 검사를 붙여 보자. 원본 클래스는 뒤의 실습에 쓰므로 그대로 둔다.
2. key mask를 지운 복사본으로 PAD 추가 검사를 실행해 보자. PAD가 유효한 토큰의 출력을 바꾸는 경로를 설명할 수 있어야 한다.
3. `d_model=48, n_heads=5`를 사용하면 어느 지점에서 왜 실패해야 하는가? 48개 좌표를 같은 크기의 head 5개로 나눌 수 없으므로 설정 검사에서 실패해야 한다.
4. 위치 정보 없는 encoder의 출력에서 첫 위치만 골랐을 때와 모든 위치를 평균 냈을 때를 비교해 보자. 첫 위치 선택은 임의의 전체 순열에 불변이지 않다. `[CLS]` 위치를 고정하고 내용 토큰만 순열하면, 위치 정보가 없을 때 그 고정된 `[CLS]` 출력은 그대로다.

</details>

이제 클래스 이름을 가리고도 `ID → 세 테이블의 합 → QKV → key mask → softmax → V 가중합 → head 합치기 → residual/LN → FFN → residual/LN` 순서로 forward를 다시 적을 수 있어야 한다. 다음 장에서는 이 함수의 출력에 실제 학습 목적을 붙인다. 먼저 토큰 복원으로 문맥 학습을 살펴보고, 이어 문장 벡터와 검색 관련성 학습으로 넘어간다.
