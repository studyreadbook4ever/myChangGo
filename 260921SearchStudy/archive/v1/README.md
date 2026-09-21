# 토큰 임베딩을 직접 학습시키는 Dense Retrieval 실습

> 이 폴더는 첫 번째 실습의 보관본이다. 현재 수업은 [상위 폴더의 README](../../README.md)와 `Dense_Retrieval_From_Scratch.ipynb`에서 시작한다. 아래의 절대경로와 설치 안내는 작성 당시 환경의 기록이다. 이 버전의 보조 BPE 예제는 별도로 `tokenizers` 패키지를 사용한다.

토큰 임베딩의 정의를 아는 학습자가 **vocabulary·초기화·encoder·검색 loss·역전파를 직접 연결**하는 실습이다.
학습용 한국어 데이터를 사용하며 CPU로 실행한다. 기존 모델 가중치는 다운로드하지 않는다.

현재 작업 환경에는 `.venv`와 실행에 필요한 패키지를 설치했다. Python 3.12.13, PyTorch 2.14.0+cpu로 확인했다.

## 지금 따라 하기

터미널에서:

```bash
cd /home/baemo_pc/260821/dense-retrieval-lab
source .venv/bin/activate
python tokenizer_lab.py
jupyter lab 01_build_embeddings.ipynb
```

1. `tokenizer_lab.py`에서 실제 BPE merge와 임베딩 테이블이 별개로 만들어지는 것을 본다.
2. 노트북을 열고 `.venv`의 Python 커널을 선택한다. 첫 셀의 `sys.executable`이 `.venv/bin/python`인지 확인한다.
3. 셀을 위에서부터 `Shift+Enter`로 실행한다. 각 설명의 **예상** 질문에 답한 뒤 결과를 확인한다.
4. 5~6단계에서 gradient 수식과 수치 미분이 같은지 확인한다.
5. 8~10단계에서 평균 모델과 Transformer의 역할 역전 문서 구별 능력을 비교한다.
6. 11단계의 `my_query`를 바꿔 검색하고, 12단계에서 임베딩 동결 효과를 본다.

계산보다 해석에 시간을 쓰도록 만든 60~90분 분량의 첫 실습이다. 읽는 속도에 따라 더 걸릴 수 있다.
수식 유도는 [THEORY.ko.md](THEORY.ko.md), 직접 수정할 모델 코드는 [lab.py](lab.py)에 있다.
미리 실행된 결과를 읽기만 하려면 [01_build_embeddings.html](01_build_embeddings.html)을 연다.

Jupyter가 없는 터미널 방식도 가능하다:

```bash
python lab.py --model both
python lab.py --query '쥐 가 고양이 를 뒤쫓다 장면'
```

## 구현을 바꾸면서 볼 지점

| 구현 | 학습할 설계 |
|---|---|
| `tokenizer_lab.py: train_tokenizer` | BPE의 vocabulary와 merge 규칙 학습 |
| `lab.py: Vocabulary` | 고정 vocabulary, PAD·UNK, train/validation 분리 |
| `lab.py: TokenTable` | 학습 가능한 행렬 초기화와 lookup |
| `lab.py: AttentionBlock` | QKV, key padding mask, multi-head, Post-LN, FFN |
| `lab.py: Retriever` | 위치 표현, 문맥화, masked mean, projection, L2 정규화 |
| `lab.py: gradient_probe` | CE gradient, 수치 미분, 특정 토큰 행 갱신 |
| `lab.py: train_experiment` | full-corpus negatives와 양쪽 encoder 역전파 |
| `data.py` | 온톨로지의 관계 방향을 relevance label로 표현 |

평균 모델과 Transformer는 모두 E를 무작위로 초기화한다. Transformer는 48차원, 4 heads, 2 blocks다.
입력 LayerNorm 및 block의 Post-LayerNorm을 쓰고, 32차원 검색 벡터로 projection한다. dropout은 없다.
BERT의 핵심 양방향 encoder 연산을 다루지만 WordPiece·MLM·NSP 사전학습을 재현하는 것은 아니다.

## 실험 해석

문서 12개, 훈련 질의 48개, 검증 질의 24개다. vocabulary 101개 중 3개는 내부 특수 토큰이다.
검증 질의의 전체 문자열은 훈련과 다르지만 모든 토큰과 정답 문서는 이미 알려져 있다.
이 자료는 구조와 gradient를 관찰하는 합성 교육셋이며 실제 검색 벤치마크가 아니다.

주체·객체를 뒤집은 같은 token multiset 문서가 3쌍 있다. 평균 모델은 이 쌍들을 구별할 수 없다.
균형 질의 구성에서 결정적 동점 처리의 Recall@1 상한은 75%, 평균 train loss 하한은 적어도 `0.5*log(2)`다.
코드에서는 mean의 합산 순서를 고정해 부동소수점 미세 차이가 임의의 순위를 만들지 않도록 한다.
위치를 제거한 Transformer 실험은 순서 불변성 확인이며 위치 없이 별도 학습한 모델과의 성능 비교는 아니다.

질의마다 의도한 정답은 하나다. 따라서 Recall@1은 정답이 1위인 비율, Recall@3은 상위 3개에 들어간 비율이다.
MRR은 각 질의에서 정답 문서 순위의 역수 평균이다. cosine 점수는 정답 확률이 아니다.
상위 타입 질의에 여러 하위 개념 문서가 정답인 문제로 바꾸면 label과 loss·평가부터 다중 정답으로 변경해야 한다.

주 실습의 공백 tokenizer에서는 `고양이가`와 `고양이 가`가 다르다. 데이터처럼 조사를 띄어 쓴다.
`패스워드 리커버리`는 의도적으로 미등록어이며 `[UNK]` 경고와 함께 검색한다.
여러 미등록 단어가 같은 ID가 되면 그 구별은 모델 깊이를 늘려도 복원되지 않는다.

## 추가 실험

```bash
python tokenizer_lab.py --vocab-size 160
python tokenizer_lab.py --vocab-size 256
python lab.py --model transformer --freeze-tokens
python lab.py --model transformer --temperature 0.5
```

각 실행은 해당 이름의 checkpoint와 JSON을 갱신한다. `results.json`과 `learning.png/svg`는 가장 최근 CLI 실행 결과다.
기존 기준 결과를 비교하려면 먼저 다른 이름으로 복사하거나 노트북의 `*_result` 변수를 사용한다.
다시 기준 실행을 하려면 `python lab.py --model both`를 실행한다.

동결 실험에서 `gradient_probe`는 진단용 복사본의 동결을 해제한다.
실제 동결 학습에서는 `token_table_change_norm == 0`을 확인한다. 나머지 encoder는 계속 학습 가능하다.
한 번에 한 가지 설정을 바꾸고 여러 seed에서도 같은 현상인지 확인한다. 그 결과는 검증 점수이며 독립 test 점수가 아니다.

## 생성되는 결과물

- `artifacts/mean.pt`, `transformer.pt`: vocabulary·모델 설정·가중치·문서를 함께 저장한 checkpoint.
- `artifacts/mean.json`, `transformer.json`: 전후 지표, 모든 검증 순위, gradient 진단.
- `artifacts/results.json`: CLI 실행 설정, PyTorch 버전, 데이터 해시, 결과.
- `artifacts/learning.png`, `learning.svg`: loss와 검증 Recall@1.
- `artifacts/tokenizer.json`: 보조 BPE 실습의 tokenizer. 주 실습의 공백 vocabulary와 호환되지 않는다.

모델 가중치를 바꾸면 문서 벡터도 다시 만들어야 한다. 이 실습은 12문서의 벡터를 매번 정확히 계산한다.
실서비스의 사전 계산·캐시·ANN은 이 표현 학습을 이해한 뒤 추가하는 별도 단계다.

## 다른 환경에 설치하기

아래 명령은 `uv`가 있는 Linux CPU 환경 기준이다. 현재 폴더에서는 재설치할 필요가 없다.

```bash
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python 'torch==2.14.0+cpu' --index-url https://download.pytorch.org/whl/cpu
uv pip install --python .venv/bin/python -r requirements.txt
source .venv/bin/activate
```

`requirements.lock.txt`는 검증 환경의 전체 패키지 목록이다. OS·CPU·PyTorch 버전에 따라 수치가 조금 달라질 수 있다.

## 원리의 출처

- [BERT: 양방향 encoder와 사전학습](https://aclanthology.org/N19-1423/)
- [DPR: 질의·문서 encoder와 검색 학습](https://aclanthology.org/2020.emnlp-main.550/)
- [PyTorch Embedding: lookup과 padding gradient](https://docs.pytorch.org/docs/stable/generated/torch.nn.Embedding.html)
- [Hugging Face Tokenizers: tokenizer 학습](https://huggingface.co/docs/tokenizers/main/en/quicktour)
