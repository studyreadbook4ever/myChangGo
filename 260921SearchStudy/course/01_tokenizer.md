## 1. 토크나이저의 학습 규칙부터 만든다

이 장에서 만들 결과물은 `tokenizer.encode(문장)`이다. 결과는 정수 목록이며, 다음 장에서는 이 정수를 임베딩 행렬의 행 번호로 사용한다. 토크나이저가 정하는 것은 **어떤 문자열 조각에 어느 행 번호를 줄 것인가**이다. 각 행의 실수 값은 아직 존재하지 않는다.

우리는 Unicode 문자에서 출발하는 BPE(Byte Pair Encoding)를 구현한다. 자주 함께 등장하는 인접 조각을 반복해서 합치는 방식이다. 학습 코드는 Python의 문자열·튜플·딕셔너리만 사용한다. BPE를 subword 학습에 사용하는 원전은 [Sennrich et al. (2016)](https://aclanthology.org/P16-1162/)이다. 아래 코드는 단어 앞에 `▁`를 붙이는 경계 규칙을 별도로 채택한 교육용 구현이다.

이후 만드는 신경망은 BERT와 비슷한 encoder지만, **원래 BERT의 WordPiece 토크나이저를 복제하지는 않는다.** BPE는 인접 조각의 빈도로 merge 순서를 정한다. WordPiece의 분할 규칙과 학습 절차는 이 구현과 같지 않다. 토크나이저를 직접 구현하기 쉽고 분할 과정을 모두 추적할 수 있다는 이유로 여기서는 BPE를 선택한다.

### 1.1 원문에서 무엇을 보존할지 먼저 정한다

문자열을 받으면 다음 순서로 처리한다.

1. Unicode NFKC 정규화를 적용한다. 예를 들어 전각 `Ａ`를 `A`로 바꾼다.
2. 연속된 공백·줄바꿈·탭을 공백 하나로 모으고 양끝 공백을 지운다.
3. 공백으로 나눈 각 단어 앞에 경계 표시 `▁`를 붙인다.
4. 각 단어를 Unicode 문자 단위로 나눈 뒤, 학습한 merge를 적용한다.

따라서 `decode(encode(x))`가 돌려주는 것은 정규화한 문자열이다. 원래의 탭이나 전각 문자는 복원하지 않는다. NFKC는 서로 다른 표기를 같게 만들 수 있으므로, 원문 표기를 반드시 보존해야 하는 검색에서는 원문을 따로 저장해야 한다. 한글 음절 `가`는 여기서 한 문자이며, 자모나 UTF-8 바이트로 나누지 않는다.

`▁`와 `[CLS]` 같은 표기는 내부 규칙에 쓰기로 예약한다. 실제 입력에 이 표기가 있으면 오류를 낸다. 조용히 받아들이면 원문의 문자와 제어용 표식을 구분할 수 없기 때문이다. 실제 서비스라면 escape 규칙이나 별도의 special-token 파서를 설계할 수 있다.

```python
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
```

정규화는 앞으로 학습과 추론에서 같은 함수를 사용한다. 학습할 때만 소문자로 바꾸거나 추론할 때만 공백을 남기면, 같은 문장이 다른 ID 열이 된다. 이 차이는 나중에 신경망이 해결해 줄 문제가 아니다.

### 1.2 단어 빈도를 세고, 그 빈도로 인접 쌍을 센다

먼저 `가나 가나 가다` 한 문장만 있다고 하자. 단어 사전에는 `가나: 2`, `가다: 1`이 들어간다. 초기 분할은 아래와 같다.

| 단어 | 현재 조각 | 단어 빈도 |
|---|---|---:|
| 가나 | `▁`, `가`, `나` | 2 |
| 가다 | `▁`, `가`, `다` | 1 |

이 사전을 한 번 순회하면서 인접 쌍에 단어 빈도를 더하면 `(▁, 가): 3`, `(가, 나): 2`, `(가, 다): 1`이 나온다. 서로 다른 단어 종류마다 1씩 더하면 첫 쌍의 빈도가 2가 되므로 잘못된 결과다.

아래 `count_pairs`의 입력은 `{현재 조각 튜플: 단어 빈도}`이다. 출력은 `{인접 조각 쌍: 코퍼스 안의 등장 횟수}`이다. `merge_pair`는 선택된 쌍 하나를 왼쪽부터 겹치지 않게 합친다. `a a a`에서 `(a, a)`를 합치면 `aa a`가 된다. 가운데 `a`를 두 번 사용할 수는 없다.

```python
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
```

같은 함수를 두 번 실행해 실제 merge를 추적한다. 빈도가 같은 쌍은 튜플의 사전순, 즉 Python 문자열의 Unicode 순서로 선택한다. 언어적인 우선순위가 아니라 실행할 때마다 결과가 같게 하기 위한 규칙이다.

```python
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
```

1회에는 `(▁, 가)`가 합쳐져 `▁가`가 된다. 이제 이전 쌍 목록은 유효하지 않으므로 다시 빈도를 센다. 2회에는 `(▁가, 나)`가 합쳐져 `▁가나`가 된다. 이 시점에 `가나`는 한 토큰, `가다`는 `▁가`와 `다` 두 토큰이다. 문장의 의미를 검사한 과정은 한 번도 없다.

한 단어에 같은 쌍이 겹쳐 등장하면 `count_pairs`는 인접 위치를 모두 센다. 예를 들어 `a a a`의 `(a, a)` 빈도는 2지만 한 번의 merge가 줄이는 길이는 1이다. 따라서 이 구현의 선택 기준인 pair 빈도와 실제 압축량은 항상 같지는 않다.

### 1.3 새 단어에는 저장한 merge 순서를 적용한다

학습이 끝나면 merge 목록은 순서가 있는 규칙 사전이다. 순서 번호를 `rank`라 부르자. 추론에서는 현재 인접한 조각 중 학습된 쌍을 찾고, 가장 작은 rank의 쌍을 합친다. 더 적용할 규칙이 없을 때 멈춘다.

어휘에서 가장 긴 문자열부터 찾는 방식으로 바꾸면 같은 결과를 보장할 수 없다. 예를 들어 `b+c`가 먼저, `a+b`가 나중에 학습되었다면 `abc`에서는 `b+c`를 먼저 적용해야 한다. 어휘에 `ab`가 있다고 해서 왼쪽부터 `ab`를 고르는 것은 다른 알고리즘이다.

```python
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
```

학습 중 관찰한 모든 문자와 merge로 만든 모든 조각을 어휘에 남긴다. 최종 코퍼스에 남아 있는 조각만 저장하면, 새 단어를 잘게 분해했을 때 필요한 초기 문자나 중간 조각이 없어질 수 있다.

### 1.4 학습 상태와 인코딩을 한 클래스에 모은다

다음 클래스의 ID 약속은 `[PAD]=0`, `[UNK]=1`, `[CLS]=2`, `[SEP]=3`, `[MASK]=4`이다. 그 뒤에 정렬한 초기 문자와 순서대로 생성한 merge 조각을 붙인다. 일반 토큰 ID의 수치 크기에는 의미가 없다. ID 40이 ID 20보다 더 강하거나 유사하다는 뜻은 아니다.

`fit`은 **TRAIN 질의와 검색 대상 문서**를 받는다. 고정된 문서 컬렉션이 미리 주어진 실험이라 문서 텍스트를 사용한다. VALID·TEST 질의는 토크나이저 학습에도 사용하지 않는다. 이후의 평가는 이 문서 컬렉션에 대한 새 질의를 다루는 실험이다.

클래스는 길지만 네 부분을 나누어 읽으면 된다. `fit`은 방금 만든 빈도 집계와 merge의 반복이다. `encode`는 rank를 적용한 문자열 조각을 ID로 바꾼다. `decode`는 그 역방향이며, `to_dict/from_dict`는 모델과 함께 보관할 상태를 저장하고 복원한다. `ready` 검사는 학습 전 인코딩을 막는다.

```python
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
```

초기화된 `pieces`는 아직 special token 다섯 개뿐이다. `fit`을 실행한 뒤에야 일반 문자와 merge 조각이 들어온다. `num_merges=100`은 최대 반복 횟수다. 빈도가 기준에 못 미치면 먼저 멈추므로 어휘가 정확히 100개라는 뜻은 아니다.

```python
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
```

이 표에서 `[CLS]`와 `[SEP]`는 원문에 없었지만 `encode`가 추가했다. `▁`가 붙은 조각은 단어의 시작이라는 뜻이다. 어휘 학습과정에서 `▁`가 합쳐지지 않은 단어는 `▁` 자체가 독립 토큰으로 남을 수 있다.

### 1.5 모르는 단어와 모르는 문자는 다르게 처리된다

`고양이쥐`처럼 학습에서 한 단어로 본 적 없는 문자열도 구성 문자가 어휘에 있으면 분해할 수 있다. 그러나 학습 코퍼스에 한 번도 없던 문자는 `[UNK]`로 바뀐다. 이 구현은 문자 기반이므로 모든 Unicode 입력을 손실 없이 처리하지는 못한다. byte 기반 분할이나 byte fallback을 추가하는 일은 별도 설계다.

`decode`는 `[UNK]`를 지우지 않는다. 어디서 정보가 사라졌는지 드러내기 위해서다. 이는 이 수업의 명시적인 출력 규칙이다. `[UNK]`로 치환한 원래 문자가 무엇인지는 ID 목록만으로 복원할 수 없다.

```python
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
```

merge가 많아지면 보통 입력 토큰 수는 줄지만 임베딩 행렬의 행 수는 늘어난다. 다음 셀은 똑같은 코퍼스에서 이 교환관계를 측정한다. 비교용 토크나이저들은 이후 모델에 쓰지 않는다. 이후의 모든 모델은 위의 `tokenizer` 하나를 공유한다.

```python
tokenizer_tradeoffs = []
for merge_budget in [0, 20, 100]:
    candidate = ScratchBPE().fit(tokenizer_corpus, num_merges=merge_budget)
    lengths = [len(candidate.encode(text, add_special_tokens=False)) for text in tokenizer_corpus]
    tokenizer_tradeoffs.append((merge_budget, len(candidate.merges), candidate.vocab_size,
                               round(sum(lengths) / len(lengths), 2), max(lengths)))
show_table(["최대 merge", "실제 merge", "어휘 크기", "평균 내용 토큰 수", "최대 내용 토큰 수"],
           tokenizer_tradeoffs)
```

큰 어휘는 `E ∈ ℝ^(V×D)`의 파라미터 수 `VD`를 늘린다. 짧은 토큰열은 뒤에서 구현할 attention의 `T×T` 점수 행렬을 줄인다. 희귀한 단어 전체를 하나의 토큰으로 만들면 그 행에 충분한 학습 신호가 오지 않을 수도 있다. 따라서 토큰 수를 가장 작게 만드는 설정이 검색 품질도 가장 높다고 결론내릴 수 없다.

### 1.6 문장 길이를 맞추고 두 종류의 mask를 만든다

배치 안에서 가장 긴 문장의 길이를 `T`, 문장 수를 `B`라 하자. `input_ids`는 `[B, T]` 정수 텐서이며, 짧은 행의 끝에는 `[PAD]`를 채운다. 뒤의 모델이 서로 다른 목적에 쓸 두 mask를 같이 만든다.

| 이름 | True인 위치 | 사용 목적 |
|---|---|---|
| `attention_mask` | `[CLS]`, 내용, `[SEP]` | attention에서 읽어도 되는 key 위치 |
| `pool_mask` | 내용만 | 문장 벡터의 평균에 포함할 위치 |
| `token_type_ids` | 모든 값이 0 | 지금은 문장 하나만 입력함을 표시 |

여기서 내용에는 독립된 `▁`와 `[UNK]`도 포함된다. 아래 함수는 너무 긴 문장을 조용히 자르지 않는다. `max_len`을 넘으면 실제 길이를 포함한 오류를 낸다. 검색 시스템에서 긴 문서를 다룰 때는 잘라 버릴지, 겹치는 chunk로 나눌지, 각 chunk에 어떤 문서 ID를 붙일지부터 정해야 한다.

```python
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
```

두 번째 행의 `attention_mask`와 `pool_mask`를 비교하자. `[CLS]`·`[SEP]` 위치에서는 둘의 값이 다르고, `[PAD]` 위치에서는 둘 다 False이다. 텐서의 `True`가 무엇을 뜻하는지는 라이브러리마다 다를 수 있으므로, 뒤의 attention 코드는 이 표의 의미에 맞춰 직접 작성한다.

```python
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
```

### 1.7 ID 약속은 모델 가중치와 함께 저장한다

한 번 임베딩 행렬을 학습한 뒤 토크나이저를 다시 학습하면, 같은 ID가 다른 조각을 가리킬 수 있다. 모델 파일만 저장해서는 검색기를 복원할 수 없는 이유다. 아래 파일에는 정규화 버전, 경계 표식, ID 순서대로 나열한 어휘, 순서가 있는 merge 규칙을 저장한다. 문자열이 깨지지 않도록 UTF-8과 `ensure_ascii=False`를 쓴다.

```python
ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
tokenizer_path = ARTIFACT_DIR / "tokenizer.json"
tokenizer_path.write_text(json.dumps(tokenizer.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
restored_tokenizer = ScratchBPE.from_dict(json.loads(tokenizer_path.read_text(encoding="utf-8")))
for text in tokenizer_corpus + [unseen_word, "고양이 " + unknown_character]:
    assert restored_tokenizer.encode(text) == tokenizer.encode(text)
assert restored_tokenizer.to_dict() == tokenizer.to_dict()
print("저장/복원 후 ID 일치:", tokenizer_path.name)
```

### 직접 고쳐 볼 문제

셀을 수정하기 전에 예상부터 적어 보자. 답은 아래에 있지만, 먼저 숫자나 토큰열을 적어야 구현을 읽은 것과 직접 예측한 것을 구분할 수 있다.

1. `가나`가 2번, `가다`가 1번인 예에서 `min_pair_frequency=3`이면 몇 번 합쳐지는가? 위의 작은 예를 `ScratchBPE().fit(["가나 가나 가다"], num_merges=10, min_pair_frequency=3)`으로 확인하라.
2. `merge_pair(("a", "a", "a", "a", "a"), ("a", "a"))`의 결과와 이 문자열에서 집계한 `(a, a)`의 빈도는 각각 무엇인가?
3. merge 예산을 0으로 설정해도 `[UNK]` 없이 인코딩할 수 있는 문자열의 조건은 무엇인가? 어휘에 없는 단어와 문자를 구분해서 답하라.
4. `pool_mask = attention_mask`로 바꾸면 문장 벡터의 평균에 어느 토큰이 더 들어가는가? `[PAD]`도 들어가는지 구분하라.

<details>
<summary>풀이와 확인 방법</summary>

1. 한 번이다. 첫 `(▁, 가)`는 빈도 3이므로 합친다. 다시 센 최댓값은 `(▁가, 나)`의 2이므로 멈춘다. `len(실험용_토크나이저.merges)`가 1이어야 한다.
2. 결과는 `("aa", "aa", "a")`, 인접 쌍 빈도는 4이다. 집계는 네 인접 위치를 세지만 치환은 겹치지 않게 두 곳에서만 일어난다.
3. 정규화한 문자열의 모든 비공백 문자가 학습 코퍼스에 등장했으면 된다. 단어 전체를 본 적이 없어도 된다. 예약한 리터럴 표식은 입력 규칙상 거부하며, 새 문자는 `[UNK]`로 치환한다.
4. `[CLS]`와 `[SEP]`가 더 들어간다. `[PAD]`는 `attention_mask`도 False이므로 여전히 빠진다. 이 수업의 내용 평균과는 다른 pooling 정의가 된다.

</details>

이제 `tokenizer`에는 분할 규칙이 있고 `pack_batch`에는 신경망에 넣을 정수와 mask가 있다. 이 단계는 문자열 처리이므로 미분하지 않는다. 다음 장에서 처음 만드는 실수 행렬 `E`부터 loss의 미분이 연결된다. 토큰 분할을 바꾸는 일과 이미 정해진 토큰의 벡터 값을 바꾸는 일은 학습되는 대상부터 다르다.
