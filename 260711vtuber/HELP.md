# 로컬 자막 모델·OpenReel 연동 도움말

이 문서는 치지직 키리누키 파이프라인에서 음성 전사 모델을 로컬에 설치하고, 한국어 SRT를 만든 뒤 OpenReel과 Codex에 전달하는 방법을 설명한다.

## 먼저 알아둘 점

- Whisper 모델은 자막을 영상 화면에 직접 입히지 않는다.
- 모델의 역할은 `음성 → 텍스트 + 단어별 시작·끝 시각` 변환이다.
- SRT 생성은 로컬 스크립트가 담당한다.
- 자막 스타일링과 최종 렌더링은 OpenReel 또는 FFmpeg가 담당한다.
- Codex는 말의 세션 선택, 오인식 교정, 정책 검수처럼 판단이 필요한 부분에만 사용한다.

모델 파일은 Git 저장소에 포함하지 않는다. 최초 한 번 내려받아 `.beta-tools/models/`에 캐시하며, 이후에는 오프라인으로 재사용한다.

## 권장 컨베이어

```text
Chrome Extension
  ↓ 타임스탬프 앵커·자연어 메모·정책 링크
Codex 작업폴더
  ↓ 적법하게 준비한 풀영상 추가
로컬 faster-whisper
  ↓
raw-transcript.json + raw-transcript.srt
  ↓ 앵커 주변 전사만 선택
Codex 또는 로컬 세션 정리기
  ↓
edit-plan.json + subtitles.ko.srt
  ↓
OpenReel에서 영상·SRT 불러오기
  ↓
사람 검수 → 최종 렌더링
```

Codex에 풀영상이나 전체 방송 전사문을 통째로 전달하지 않는다. 각 앵커 앞뒤 60~120초의 전사만 전달하면 토큰을 크게 줄일 수 있다.

## 1. 기본 준비

필요 항목:

- Python 3.9 이상
- 로컬 영상 편집용 FFmpeg/ffprobe
- 인터넷 연결: 최초 패키지·모델 다운로드 때만 필요
- 선택 사항: NVIDIA GPU와 CUDA 환경

저장소의 `260711vtuber` 폴더 또는 이 문서가 있는 프로젝트 최상위에서 실행한다.

```bash
python -m venv .beta-tools/venv
source .beta-tools/venv/bin/activate
python -m pip install --upgrade pip
python -m pip install "faster-whisper==1.2.1"
```

설치 확인:

```bash
.beta-tools/venv/bin/python -c 'import faster_whisper, ctranslate2; print("faster-whisper", faster_whisper.__version__); print("ctranslate2", ctranslate2.__version__); print("CUDA devices", ctranslate2.get_cuda_device_count())'
```

`CUDA devices 0`이어도 CPU 전사는 가능하다.

## 2. 모델 내려받기

### 빠른 시작용: base

`base`는 크기가 작고 CPU에서 확인하기 좋다. 다만 방송 고유명사, 게임 용어, 빠른 말은 사람이 더 많이 교정해야 할 수 있다.

```bash
mkdir -p .beta-tools/models
.beta-tools/venv/bin/python - <<'PY'
from faster_whisper import WhisperModel

WhisperModel(
    "base",
    device="cpu",
    compute_type="int8",
    download_root=".beta-tools/models",
)
print("base model is ready")
PY
```

### GPU 품질 후보: large-v3-turbo

OpenReel의 전사 서비스가 기본으로 사용하는 모델이다. GPU 메모리와 처리 속도를 확인한 뒤 실사용 기본값으로 선택한다.

```bash
mkdir -p .beta-tools/models
.beta-tools/venv/bin/python - <<'PY'
from faster_whisper import WhisperModel

WhisperModel(
    "large-v3-turbo",
    device="cuda",
    compute_type="int8_float16",
    download_root=".beta-tools/models",
)
print("large-v3-turbo model is ready")
PY
```

GPU 메모리 부족이나 CUDA 오류가 나면 `base + cpu + int8` 조합으로 먼저 동작을 확인한다. 최종 모델은 실제 치지직 영상 10분 정도를 `base`, 중간급 모델, `large-v3-turbo`로 비교한 뒤 정하는 것이 좋다.

faster-whisper는 모델 이름을 지정하면 Hugging Face Hub에서 해당 CTranslate2 모델을 자동으로 내려받는다.

- faster-whisper: https://github.com/SYSTRAN/faster-whisper
- base 모델: https://huggingface.co/Systran/faster-whisper-base

## 3. 현재 스크립트로 영상 전사하기

현재 `scripts/transcribe-beta.py`는 CPU `int8`, 한국어, 단어별 타임코드, VAD를 사용한다.

```bash
HF_HUB_OFFLINE=1 \
  .beta-tools/venv/bin/python scripts/transcribe-beta.py \
  "/절대경로/full-video.mp4" \
  --model base \
  --model-dir .beta-tools/models \
  --json raw-transcript.json \
  --srt raw-transcript.srt
```

결과:

- `raw-transcript.json`: 세그먼트와 단어별 원본 타임코드
- `raw-transcript.srt`: 전체 원본 타임라인 기준 초벌 자막

`HF_HUB_OFFLINE=1`은 이미 받은 모델만 사용하게 한다. 모델이 아직 없다면 2단계의 다운로드를 먼저 실행한다.

## 4. 앵커 주변만 Codex에 전달하기

Extension이 만든 앵커는 최종 컷이 아니라 관심 사건의 위치다.

예를 들어 앵커가 `05:26:58–05:27:14`라면 다음만 준비한다.

1. 원본 기준 `05:25:58–05:28:14` 전사를 추출한다.
2. 질문 시작, 답변 종료, 즉각적인 반응 종료를 찾는다.
3. 선택한 실제 경계를 `edit-plan.json`에 기록한다.
4. 선택된 부분만 최종 영상 타임라인에 맞춰 `subtitles.ko.srt`로 재계산한다.

Codex에는 다음만 제공하면 된다.

- 사용자 앵커와 자연어 메모
- 앵커 주변 전사
- 필요한 소수의 확인용 프레임
- 방송인·제3자 정책 URL
- 원하는 결과 파일 규격

## 5. OpenReel에 전달하기

OpenReel Video는 SRT 가져오기, 자막 스타일 조정, 프로젝트 내보내기·가져오기를 지원한다.

- OpenReel: https://github.com/Augani/openreel-video

초기 연동은 OpenReel 내부 프로젝트 포맷을 직접 수정하지 않고 다음 세 파일을 전달하는 방식이 안전하다.

```text
edited-source.mp4 또는 원본 영상
subtitles.ko.srt
edit-plan.json
```

OpenReel에서:

1. 편집할 영상을 불러온다.
2. `subtitles.ko.srt`를 가져온다.
3. 자막 폰트·위치·외곽선·한 줄 길이를 조정한다.
4. `edit-plan.json`의 원본 시작·끝 시각을 보며 컷을 확인한다.
5. 사람 검수 후 비공개 결과물을 렌더링한다.

OpenReel 프로젝트 포맷 자동 생성은 SRT 기반 흐름이 안정화된 뒤 별도 어댑터로 추가하는 편이 좋다.

## 6. OpenReel 전사 서버 사용하기 (선택)

OpenReel 저장소에는 `infra/transcribe-gpu`에 faster-whisper 기반 FastAPI 서버가 이미 포함되어 있다.

주요 인터페이스:

- `POST /transcribe`: 오디오 전사 작업 시작
- `GET /jobs/{job_id}`: 진행 상태와 단어별 결과 확인
- `GET /health`: 모델·장치 상태 확인

기본 GPU 설정은 `large-v3-turbo + cuda + float16`, CPU Compose 설정은 `large-v3-turbo + cpu + int8`이다.

```bash
git clone https://github.com/Augani/openreel-video.git
cd openreel-video/infra/transcribe-gpu
docker compose up -d --build
curl http://localhost:8000/health
```

CPU Compose를 사용할 경우:

```bash
docker compose -f docker-compose.cpu.yml up -d --build
curl http://localhost:8000/health
```

OpenReel의 `setup.sh`는 Debian/Ubuntu 계열 명령을 사용하므로 Arch Linux에서는 그대로 실행하지 말고 Docker와 NVIDIA Container Toolkit을 배포판 방식으로 먼저 설치한다.

초기 버전에서는 현재 저장소의 로컬 전사 스크립트를 사용해도 충분하다. 컨베이어 통합 단계에서 OpenReel API와 같은 응답 구조로 맞추면 브라우저 편집기와 자연스럽게 연결할 수 있다.

## 7. 자막 검수 원칙

- 고유명사, 방송인 이름, 게임 용어는 자동 전사를 그대로 확정하지 않는다.
- 화면에 정확한 표기가 보이면 음성 인식 결과와 교차확인한다.
- 들리지 않는 단어를 창작하지 않는다.
- 노래 가사는 권리 확인 전 장문 전사하지 않는다.
- 문장 중간, 질문만 남는 지점, 반응 직전에서 자르지 않는다.
- 최종 SRT는 컷을 연결한 결과 영상의 타임라인으로 다시 계산한다.
- 수익, 음원, 제3자 정책 상태가 `PENDING`이면 공개용 결과로 간주하지 않는다.

## 8. 문제 해결

### 모델을 찾지 못함

- `HF_HUB_OFFLINE=1`을 제거하고 2단계 다운로드를 다시 실행한다.
- `--model-dir .beta-tools/models`가 실제 캐시 위치와 같은지 확인한다.

### CUDA 또는 cuDNN 오류

- 먼저 CPU `int8`로 파이프라인 자체가 정상인지 확인한다.
- `nvidia-smi`와 `ctranslate2.get_cuda_device_count()` 결과를 확인한다.
- 최신 faster-whisper/CTranslate2 GPU 환경은 CUDA 12와 cuDNN 9 조합을 우선 확인한다.

### GPU 메모리 부족

- `compute_type`을 `int8_float16`으로 낮춘다.
- 더 작은 모델을 사용한다.
- 배치 크기를 줄이거나 CPU `int8`로 폴백한다.

### 한국어 자막 오인식

- 방송인·게임 고유명사 목록을 별도 검수 기준으로 사용한다.
- 앵커 주변 원음과 화면 표기를 사람이 확인한다.
- 모델을 키우기 전에 반복되는 오인식 유형과 처리 시간을 기록한다.

### SRT 싱크가 어긋남

- 원본 영상의 시작 PTS와 실제 재생시간을 ffprobe로 확인한다.
- 라이브 앵커가 방송 시작 기준인지 파일 시작 기준인지 확인한다.
- 컷 연결 후에는 원본 SRT를 그대로 쓰지 말고 최종 영상 기준으로 시각을 재계산한다.

## 9. 저장소에 포함하지 않는 항목

다음 항목은 로컬 캐시이므로 Git에 올리지 않는다.

```text
.beta-tools/venv/
.beta-tools/models/
원본 방송 영상
전사 중간파일
렌더링 결과 영상
```

모델을 완전 오프라인으로 배포해야 할 때만 라이선스·모델 카드·해시를 포함한 별도 GitHub Release 자산을 고려한다. 일반 Git이나 소스 ZIP에는 모델을 넣지 않는다.

## 10. 완료 확인

다음 조건을 만족하면 로컬 자막 단계가 준비된 것이다.

- [ ] faster-whisper와 CTranslate2 버전이 출력됨
- [ ] 선택 모델이 `.beta-tools/models/`에 존재함
- [ ] 테스트 영상에서 `raw-transcript.json` 생성 성공
- [ ] 테스트 영상에서 `raw-transcript.srt` 생성 성공
- [ ] 단어별 시작·끝 시각이 JSON에 존재함
- [ ] 앵커 주변 전사만 별도로 추출 가능함
- [ ] OpenReel에서 SRT를 불러와 한글 자막을 확인함
- [ ] 사람 검수 전 자동 게시·수익화가 차단되어 있음
