# AudSeg

모델 없이 오디오의 **활동 시작·끝**을 찾아 편집 가능한 빈 자막 cue를 만드는
Python 라이브러리와 CLI입니다.

AudSeg는 음성을 글자로 바꾸지 않습니다. 학습 가중치, 추론 서버, 네트워크
호출, GPU도 사용하지 않습니다. PCM 파형의 에너지만 분석하므로 자막 내용을
사람이 입력하든 STT/LLM이 입력하든 그 다음 단계는 자유롭게 선택할 수 있습니다.

```text
audio
  └─ pure DSP activity detector
       ├─ acoustic regions
       └─ cue planner
            ├─ JSON
            ├─ SRT
            └─ WebVTT
```

## 무엇을 해결하나

일반적인 STT는 한 번에 두 문제를 풉니다.

1. **언제** 소리가 시작하고 끝났는가
2. **무엇을** 말했는가

AudSeg는 첫 번째 문제만 풉니다. 결과는 **분석에 사용한 PCM의 표본 인덱스**를
기준으로 보존되며, 긴 연속 발화는 음량이 가장 낮은 지점을 찾아 임시 자막 단위로
나눕니다. 이 분할은 의미 경계가 아니므로 결과에 `forced_split`과
`split_method`가 명시됩니다. WAV·PCM API에서는 입력 표본과 같고, FFmpeg
입력에서는 기본 16 kHz로 변환된 분석 PCM의 표본입니다.

## 특징

- Python 런타임 의존성 0개
- 학습 모델·네트워크·GPU 호출 없음
- 8/16/24/32-bit PCM WAV를 표준 라이브러리로 스트리밍 처리
- MP3, M4A, FLAC 등은 선택적으로 외부 FFmpeg를 CPU 디코더로 사용
- 20 ms RMS 프레임, 적응형 잡음 바닥, Schmitt hysteresis
- onset/release debounce, 짧은 구간 제거, 공백 병합, 앞뒤 padding
- DC 오프셋 제거
- 역상 스테레오가 평균 과정에서 사라지지 않도록 가장 강한 채널을 보존
- JSON, SubRip(SRT), WebVTT 출력
- 바이트 chunk 경계와 무관한 PCM16 API
- 샘플 인덱스를 canonical timebase로 사용해 긴 파일에서도 누적 오차 방지

## 설치

저장소 안에서:

```bash
python -m pip install ./AudSeg
```

개발 모드:

```bash
python -m pip install -e './AudSeg[dev]'
```

일반 RIFF PCM WAV만 사용할 때는 추가 프로그램이 필요 없습니다. 압축 오디오를
입력하려면 시스템에 `ffmpeg` 실행 파일이 있어야 합니다. Python 3.11의 표준
`wave`가 읽지 못하는 `WAVE_FORMAT_EXTENSIBLE` PCM도 자동 모드에서는 FFmpeg로
fallback합니다. Python 3.12 이상은 해당 PCM 형식을 표준 라이브러리에서
지원합니다.

## CLI

JSON을 표준 출력으로:

```bash
audseg recording.wav
```

확장자에 따라 SRT 출력:

```bash
audseg recording.wav -o blank-captions.srt
```

압축 오디오를 FFmpeg로 디코딩:

```bash
audseg recording.m4a -o blank-captions.vtt
```

고정 임계값이 더 적합한 녹음:

```bash
audseg noisy-room.wav \
  --fixed-threshold-dbfs -34 \
  --release-ms 320 \
  --max-cue-ms 7000 \
  -o cues.json
```

탐지 region을 강제로 자막 길이에 맞춰 나누지 않으려면:

```bash
audseg recording.wav --no-cue-split -o regions.json
```

SRT/VTT의 기본 cue 본문은 `[…]`입니다. 많은 편집기가 본문이 완전히 빈 cue를
삭제하기 때문입니다. 정말 빈 본문이 필요하면 `--placeholder ''`를 사용하세요.
`--placeholder 'cue {index}'`처럼 번호를 넣을 수도 있습니다.

기존 출력 파일은 실수로 덮어쓰지 않습니다. 교체하려면 `--force`를 명시해야
하며, 파일 교체는 같은 디렉터리의 임시 파일을 거쳐 원자적으로 수행됩니다.

## Python API

### 파일

```python
from audseg import Segmenter

result = Segmenter().file("recording.wav")

for cue in result.segments:
    print(
        cue.start_seconds(result.sample_rate_hz),
        cue.end_seconds(result.sample_rate_hz),
        cue.forced_split,
    )
```

### 임의의 정규화 PCM

```python
from audseg import segment_samples

result = segment_samples(
    samples=normalized_mono_samples,  # Iterable[float], -1.0 .. 1.0
    sample_rate_hz=48_000,
)
```

전체 파형은 메모리에 보관하지 않습니다. 입력 iterator를 한 번 소비하고 10 ms
간격의 frame level만 결과에 남깁니다.

### chunked PCM16

```python
from audseg import segment_pcm16

result = segment_pcm16(
    chunks=network_or_file_chunks,
    sample_rate_hz=16_000,
    channels=2,
)
```

chunk가 샘플 중간이나 스테레오 frame 중간에서 잘려도 결과는 동일합니다. 현재
적응형 잡음 바닥은 파일 전체 통계를 사용하므로 입력은 스트리밍으로 소비하지만
최종 구간은 EOF 뒤에 반환됩니다.

### 설정

음향 검출과 자막 cue 정책은 별도 객체입니다.

```python
from audseg import CuePolicy, DetectorConfig, SegmentationConfig, Segmenter

config = SegmentationConfig(
    detector=DetectorConfig(
        fixed_threshold_dbfs=None,
        onset_ms=40,
        release_ms=250,
        min_region_ms=120,
        merge_gap_ms=100,
        pad_start_ms=40,
        pad_end_ms=80,
    ),
    cues=CuePolicy(
        max_duration_ms=8_000,
        min_split_duration_ms=500,
        split_search_ms=2_000,
    ),
)

segmenter = Segmenter(config)
result = segmenter.file("recording.wav")
```

`result.activity_regions`는 음향 검출 결과이고 `result.segments`는 자막 편집용
계획입니다. 두 자료를 분리했기 때문에 다른 cue planner를 만들거나 음향 region만
가져다 쓸 수 있습니다.

## 알고리즘

1. PCM을 기본 20 ms frame, 10 ms hop으로 순회합니다.
2. 각 frame의 평균값을 빼 DC 성분을 제거하고 RMS power를 dBFS로 변환합니다.
3. 전체 frame level의 하위 20% 지점으로 잡음 바닥을 추정합니다.
4. 잡음 바닥과 peak guard로 onset/release 임계값을 정합니다.
5. 서로 다른 두 임계값을 갖는 Schmitt trigger로 경계 떨림을 막습니다.
6. 40 ms 연속 활동 뒤 열고, 250 ms 연속 비활동 뒤 닫습니다.
7. 짧은 region 제거·공백 병합·padding 뒤 겹치는 padding을 정리합니다.
8. 긴 region은 제한 시간 직전의 quiet valley에서 나눕니다. 충분히 조용한
   지점이 없으면 정확한 제한 시간에서 `hard_limit` 분할합니다.

적응형 임계값이 맞지 않는 일정한 저음량 녹음이나 보정된 스튜디오 신호에는
`fixed_threshold_dbfs`를 지정할 수 있습니다. JSON의 `analysis`에는 추정 잡음,
실제 적용 임계값, 활동 비율과 진단 경고가 기록됩니다.

## JSON 계약

출력 schema는 현재 `audseg.result/v1`입니다.

```json
{
  "schema": "audseg.result/v1",
  "audio": {
    "sample_rate_hz": 16000,
    "total_samples": 32000,
    "duration_ms": 2000
  },
  "analysis": {
    "algorithm": "dc-removed-rms-adaptive-hysteresis",
    "threshold_mode": "adaptive",
    "start_threshold_dbfs": -65.0,
    "stop_threshold_dbfs": -68.0,
    "warnings": []
  },
  "segments": [
    {
      "index": 1,
      "start_sample": 7200,
      "end_sample": 25440,
      "start_ms": 450,
      "end_ms": 1590,
      "source_region": 1,
      "forced_split": false,
      "split_method": null
    }
  ]
}
```

밀리초는 교환 형식용이고 `start_sample`/`end_sample`이 기준 경계입니다. 그
표본의 timebase는 JSON의 `audio.sample_rate_hz`입니다. FFmpeg 디코딩에서는 원본
컨테이너의 표본 번호가 아니라 변환된 분석 PCM 기준이라는 점에 유의하세요. 입력의
절대 경로는 JSON에 넣지 않고 파일명만 기록합니다.

## 중요한 한계

AudSeg는 **speech VAD가 아니라 audio activity detector**입니다.

- 음악, 효과음, 박수, 키보드 소리도 활동으로 잡힐 수 있습니다.
- 지속되는 에어컨·군중 소리와 지속되는 조용한 발화는 의미 정보 없이 완벽히
  구별할 수 없습니다.
- 말이 끊기지 않으면 음향 경계만으로 문장·절 경계를 알 수 없습니다.
- 화자 분리, 전사, 언어 판별, 의미 기반 줄바꿈은 하지 않습니다.
- 1 ms보다 짧아 SRT/WebVTT 시간축에 표현할 수 없는 사용자 정의 cue는 타임라인을
  몰래 늘리지 않고 오류로 거절합니다. 이 경우 정확한 sample 경계가 있는 JSON을
  사용하세요.
- FFmpeg의 기본 mono 변환을 사용하는 압축 입력은 특수한 역상 채널에서 상쇄될
  수 있습니다. 역상 보존이 중요하면 PCM WAV API를 사용하세요.

따라서 결과는 “최종 자막”이 아니라 사람이 빠르게 합치고 나눌 수 있는
**타이밍 초안**입니다. 자막 텍스트가 채워진 뒤 글자 수·읽기 속도·문장 경계에
따라 한 번 더 조정하는 흐름을 권장합니다.

## 개발과 검증

```bash
uv run --project AudSeg --extra dev pytest AudSeg/tests --cov=audseg --cov-report=term-missing
uv run --project AudSeg --extra dev ruff check AudSeg/src AudSeg/tests
uv run --project AudSeg --extra dev ruff format --check AudSeg/src AudSeg/tests
uv build --project AudSeg
```

테스트는 실제 모델이나 네트워크를 사용하지 않고 합성 PCM으로 다음을 검증합니다.

- 무음, tone burst, 짧은 click, 짧고 긴 pause
- DC offset, EOF와 partial frame
- 8/16/24/32-bit WAV
- 역상 스테레오
- 임의 PCM byte chunk 경계
- quiet-valley/hard-limit cue 분할
- JSON/SRT/WebVTT와 24시간 초과 timestamp
- CLI stdout, 진단 stderr, 안전한 파일 교체

## 라이선스

MIT
