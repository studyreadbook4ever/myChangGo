# 260921SearchStudy · 토크나이저에서 검색기까지

**Python으로 BPE 토크나이저를 만들고, 같은 토크나이저로 작은 BERT형 encoder와 Dense Retrieval 검색기를 학습하는 실습 교재입니다.** 수식, 데이터, 구현, 실험, 연습문제와 해설을 하나의 Jupyter 노트북에 담았습니다.

[실습 노트북](Dense_Retrieval_From_Scratch.ipynb) · [읽기용 HTML 파일](Dense_Retrieval_From_Scratch.html) · [실험 결과](artifacts/course/results.json)

행렬곱, 연쇄법칙, 경사하강법을 배운 독자를 대상으로 합니다. PyTorch의 실행 규칙과 텐서의 shape는 본문에서 설명합니다. Transformer·임베딩·RAG를 사용해 보았다면, 각 기능이 내부에서 어떤 계산과 학습 신호로 구현되는지 따라갈 수 있습니다.

## 사용법

### 1. 저장소 내려받기

Git과 Python 3.12가 준비된 **Linux CPU 환경**을 기준으로 합니다. Python의 `venv`와 `pip`를 사용할 수 있어야 합니다.

```bash
git clone https://github.com/studyreadbook4ever/myChangGo.git
cd myChangGo/260921SearchStudy
```

이미 저장소를 내려받았다면 해당 저장소 안의 `260921SearchStudy` 폴더로 이동합니다. GitHub의 **Code → Download ZIP**으로 받은 경우에도 압축을 풀고 같은 폴더에서 아래 명령을 실행하면 됩니다.

### 2. 실행 환경 만들기

```bash
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install 'torch==2.14.0+cpu' --index-url https://download.pytorch.org/whl/cpu
python -m pip install -r requirements.txt
```

검증에 사용한 버전은 **Python 3.12.13 / PyTorch 2.14.0+cpu**입니다. 설치에는 위의 CPU PyTorch 명령과 [requirements.txt](requirements.txt)를 사용합니다. [requirements.lock.txt](requirements.lock.txt)는 검증 환경 전체의 참조 기록으로, 이전 실험용 패키지도 포함합니다. 위 PyTorch 명령은 Linux CPU용입니다. 다른 운영체제의 설치와 결과는 별도로 검증하지 않았습니다.

GPU와 API 키는 필요하지 않습니다. 패키지를 설치한 뒤의 실습은 외부 데이터나 사전학습 모델을 다운로드하지 않습니다.

### 3. 노트북 열고 실행하기

가상환경을 활성화한 상태에서 실행합니다.

```bash
python -m jupyterlab Dense_Retrieval_From_Scratch.ipynb
```

1. 첫 코드 셀을 실행하고 출력된 Python 경로가 이 폴더의 `.venv`를 가리키는지 확인합니다.
2. 처음에는 설정을 바꾸지 않고 **위에서부터 `Shift+Enter`**로 실행합니다. 설명과 코드, 출력 해석을 함께 읽습니다.
3. 전체 동작을 먼저 확인하려면 **Run → Run All Cells**를 사용합니다. 모든 필수 코드는 완성되어 있습니다.
4. 토크나이저나 모델 구조, 학습 조건을 바꾸어 비교할 때는 **Kernel → Restart Kernel and Run All Cells**로 처음부터 실행합니다. 학습 셀만 반복하면 이미 학습된 모델을 추가로 학습할 수 있습니다.

노트북에 저장된 출력은 교재 검증 당시의 결과입니다. 출력이 보이더라도 현재 커널의 변수는 아직 만들어지지 않았으므로, 중간 셀부터 실행하려면 먼저 앞선 셀들을 실행해야 합니다.

다음에 다시 시작할 때는 프로젝트 폴더에서 아래 두 명령만 실행합니다.

```bash
source .venv/bin/activate
python -m jupyterlab Dense_Retrieval_From_Scratch.ipynb
```

### 실행하지 않고 읽기

GitHub에서는 [노트북 미리보기](Dense_Retrieval_From_Scratch.ipynb)로 본문과 저장된 출력을 읽을 수 있습니다. 렌더링이 원활하지 않다면 저장소를 내려받은 뒤 `Dense_Retrieval_From_Scratch.html`을 브라우저로 엽니다. **HTML은 GitHub 파일 페이지에서 실행되는 웹페이지가 아닙니다.** 해당 파일만 받을 때는 파일 페이지의 **Download raw file**을 사용한 뒤 로컬 브라우저에서 엽니다.

HTML은 읽기용이며 코드를 실행하지 않습니다. 수식은 MathJax를 인터넷에서 불러오므로 수식 표시에는 인터넷 연결이 필요합니다.

## 학습 순서

| 장 | 직접 만드는 것 | 확인할 핵심 |
|---|---|---|
| 1. 토크나이저 | 문자 BPE, 정규화, merge 규칙, ID와 배치 입력 | 토큰 경계와 vocabulary가 정해지는 과정 |
| 2. Encoder | 토큰·위치·구간 임베딩, QKV, multi-head attention, residual·LayerNorm·FFN | 텐서의 축, mask의 위치, 임베딩으로 흐르는 gradient |
| 3. MLM | 80/10/10 손상 규칙, weight tying, 손실과 학습 loop | 입력 임베딩과 출력 예측이 함께 학습되는 경로 |
| 4. 문장 벡터 | masked pooling, projection, L2 정규화, 평균 임베딩 모델 | 토큰 벡터를 검색용 문장 벡터로 바꾸는 계산 |
| 5. 검색 학습 | 점수 행렬, temperature, cross-entropy, 미분과 수치 검산 | 정답 문서가 더 높은 점수를 받도록 파라미터가 바뀌는 과정 |
| 6. 검색과 점검 | 문서 벡터 인덱스, 정확 검색, 위치 제거·임베딩 동결 실험, 저장·복원 | 구조의 효과, 실패 입력, 추론 재현에 필요한 상태 |
| 7. 설계 과제 | chunking, 다중 정답 loss, nDCG, 평가 분할 | 조건이 달라졌을 때 구현과 평가를 바꾸는 방법 |

첫 실행에서는 기본 결과를 확인하고, 두 번째 실행에서는 한 조건씩 바꾸어 비교합니다. 연습문제의 해설과 실행 코드도 같은 노트북에 들어 있습니다. 온톨로지에 익숙한 독자는 마지막 장의 관계·개체 분할 과제에서 지식 구조를 정답 구성과 일반화 평가에 연결할 수 있습니다.

### 직접 검색해 보기

6장의 **문서 벡터를 미리 계산해서 검색한다** 절까지 실행한 뒤, 해당 셀의 `my_query`를 바꾸어 다시 실행합니다.

```python
my_query = "쥐 가 고양이 를 뒤쫓다 장면"
```

검색 대상은 교재의 12개 문서입니다. 질의를 바꾸면 그 문서 중 상위 후보와 점수가 표시됩니다. 새로운 주제의 문서를 추가하려면 데이터와 학습 구성을 함께 바꾸어야 합니다. 학습된 범위를 벗어난 입력에도 1위 후보가 나오므로, 높은 순위를 곧바로 정답의 증거로 해석하지 않습니다.

## 파일 안내

| 파일·폴더 | 용도 |
|---|---|
| [Dense_Retrieval_From_Scratch.ipynb](Dense_Retrieval_From_Scratch.ipynb) | 수업을 따라가는 주 교재. 코드와 데이터가 파일 안에 포함됩니다. |
| [Dense_Retrieval_From_Scratch.html](Dense_Retrieval_From_Scratch.html) | 저장된 실행 결과를 포함한 읽기용 교재 |
| [retrieval_course.py](retrieval_course.py) | 노트북의 모든 실행 코드를 모은 생성 파일 |
| [course/](course/) | `00`부터 `07`까지, 교재 본문과 코드의 Markdown 편집 원본 |
| [build_course.py](build_course.py) | 편집 원본으로 노트북과 Python 파일을 다시 생성 |
| [verify_course.py](verify_course.py) | 새 커널에서 전체 실행, 별도 프로세스에서 모델 복원 확인, HTML 내보내기 |
| [requirements.txt](requirements.txt) | 기본 설치 패키지. CPU PyTorch는 위 명령으로 별도 설치 |
| [requirements.lock.txt](requirements.lock.txt) | 검증 환경의 전체 패키지 버전 기록 |
| [artifacts/course/](artifacts/course/) | tokenizer, 지표, 학습 곡선, 실행 검증 기록과 저장된 예제 모델 |
| [archive/v1/](archive/v1/) | 이전 버전 보관 자료. 현재 교재를 학습하는 데 필요하지 않습니다. |

실습은 현재 작업 폴더의 `artifacts/course/`에 결과를 저장합니다. 검증 실행에서 학습한 예제 모델 `retriever.pt`도 함께 제공합니다. 이 파일은 실습을 실행하면 다시 생성되며 tokenizer 설정, 모델 구조·가중치, 문서 목록과 벡터를 함께 담습니다. **추론 복원용 checkpoint**로, optimizer 상태를 포함한 학습 재개용 checkpoint는 아닙니다.

## 검증 범위와 데이터

72개 코드 셀을 교재 원본이 없는 임시 폴더의 새 커널에서 모두 실행하고, 셀 오류가 없음을 확인했습니다. 별도 Python 프로세스에서 저장 모델을 복원해 문서 벡터가 일치하는지, 검색 결과가 재현되는지도 확인했습니다. 기록은 [verification.json](artifacts/course/verification.json), 학습 설정과 지표는 [results.json](artifacts/course/results.json)에 있습니다.

실습 데이터는 **문서 12개, 학습 질의 48개, 검증 질의 24개, 테스트 질의 24개**로 구성한 합성 자료입니다. 같은 단어의 순서가 바뀔 때 의미가 달라지는 사례와 작은 안내 검색 문제를 관찰하도록 만들었습니다. 알려진 문서 집합에 대한 실험이므로 높은 지표를 실제 한국어 검색 성능이나 새로운 개체·관계에 대한 일반화의 증거로 해석하지 않습니다.

PyTorch의 텐서 연산, `Embedding`, `Linear`, `LayerNorm`, 자동 미분과 optimizer를 사용합니다. BPE, attention 계산, mask, pooling, loss 구성과 학습 loop는 본문에서 직접 정의합니다. `transformers`, `tokenizers`, `SentenceTransformer`, `nn.Transformer`는 사용하지 않습니다. 원형 BERT의 WordPiece·NSP·대규모 사전학습을 그대로 재현하는 교재는 아닙니다.

## 코드를 수정하거나 교재를 다시 만들 때

학습 중에는 노트북의 셀을 직접 바꾸어 실험하면 됩니다. 원본을 보존하려면 먼저 노트북 사본을 만듭니다.

교재 자체를 편집하려면 `course/*.md`를 수정하고, 가상환경에서 다음을 실행합니다.

```bash
python build_course.py
python verify_course.py
```

`build_course.py`는 노트북과 `retrieval_course.py`를 **덮어쓰며 저장된 노트북 출력을 초기화**합니다. 노트북에서만 수정한 내용을 유지하려면 빌드 전에 `course/*.md`에 반영해야 합니다. `verify_course.py`는 전체 실습을 다시 실행하고, 실행 출력·결과 파일·검증 기록·HTML을 갱신합니다. 검증에 실패하면 오류를 고친 뒤 다시 실행합니다.

토크나이저를 바꾸면 ID와 vocabulary가 바뀔 수 있으므로 모델과 문서 벡터도 다시 만들어야 합니다. 모델을 바꾼 뒤 기존 문서 벡터를 그대로 쓰면 서로 다른 표현 공간을 비교하게 됩니다. 이러한 변경은 노트북의 전체 재시작과 실행으로 확인합니다.
