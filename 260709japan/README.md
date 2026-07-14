# Per-Open Quest

[APK 바로 다운로드](https://github.com/studyreadbook4ever/myChangGo/releases/download/260709japan-debug-v0.4.0/app-debug.apk)

사용자가 자연어로 적은 출제 요청을 AI에 전달하고, 앱을 열거나 휴대폰 잠금을 해제할 때마다 새로운 4지선다 문제를 생성하는 Kotlin Android 앱입니다.

`v0.4.0`부터 PC의 Ollama/LM Studio에 연결하는 기능을 제거했습니다. 그 자리는 LiteRT-LM으로 `.litertlm` 모델을 휴대폰 안에서 직접 실행하는 `휴대폰 안의 AI` 모드로 교체했습니다.

## 세 가지 AI 방식

- `Google로 간단히 시작`: Google AI Studio 키로 Gemini API를 사용합니다.
- `휴대폰 안의 AI`: 인터넷이나 PC 서버 없이 휴대폰의 NPU, GPU 또는 CPU에서 모델을 실행합니다.
- `고급 서버 연결`: 사용자가 알고 있는 OpenAI 호환 API 서버를 연결합니다.

## 주요 기능

- 매 질문마다 AI가 문제, 선택지 4개, 정답, 해설을 새로 생성합니다.
- 사용자가 받은 `.litertlm` 모델을 앱 내부 저장소로 가져옵니다.
- 알려진 칩과 정확히 일치하는 NPU용 모델을 선택하면 `NPU → GPU → CPU` 순서로 초기화합니다.
- NPU 호환 정보를 확인할 수 없는 기기에서는 `GPU → CPU` 순서로 안전하게 실행합니다.
- 실제 초기화에 성공한 가속기를 설정 화면에 표시합니다.
- Snapdragon, MediaTek, Google Tensor용 모델 파일의 칩 코드를 확인해 잘못된 기기용 파일을 미리 거부합니다.
- 자연어 출제 프롬프트와 일본어, 영어, 한국사, 컴퓨터 기초 예시를 제공합니다.
- 문제를 먼저 보여주고 `3 → 2 → 1` 뒤에 선택지를 표시합니다.
- 정답 뒤에는 AI 해설과 `정답 복사` 버튼을 표시합니다.
- `Endless Mode`와 잠금 해제 뒤 나타나는 Per-Open 모드를 제공합니다.
- 모델 로딩이나 생성이 실패하면 잠금 해제를 즉시 허용해 사용자를 가두지 않습니다.

## 휴대폰 안의 AI 시작하기

### 1. AI 방식 선택

앱의 `AI 연결`에서 `휴대폰 안의 AI`를 선택합니다. 화면에 휴대폰 이름과 칩 이름이 표시됩니다.

앱이 칩을 지원 목록에서 찾으면 NPU용 권장 파일 이름도 함께 표시합니다. 파일 이름은 길기 때문에 길게 눌러 선택할 수 있습니다.

### 2. 모델 받기

`추천 모델 받기`를 누르면 다음 모델을 선택할 수 있습니다.

- `Gemma 3 1B`: 약 0.6GB. 문제 생성 품질을 고려한 기본 권장 모델입니다.
- `Gemma 3 270M`: 약 0.3GB. 더 가볍지만 한국어, 일본어 및 JSON 출력 정확도가 낮을 수 있습니다.
- `LiteRT-LM 전체 모델`: 다른 호환 모델을 직접 고르는 고급 경로입니다.

Gemma 모델은 Hugging Face 로그인과 Gemma 이용 조건 동의가 필요합니다. 모델 페이지의 `Files and versions`에서 앱이 안내한 정확한 `.litertlm` 파일을 받습니다.

일반 실행용 Gemma 3 1B 파일:

```text
gemma3-1b-it-int4.litertlm
```

예를 들어 Snapdragon SM8750용 NPU 파일은 다음과 같습니다.

```text
Gemma3-1B-IT_q4_ekv1280_sm8750.litertlm
```

다른 칩 코드가 붙은 NPU 전용 파일은 서로 호환되지 않습니다. 앱이 현재 기기와 파일 이름을 비교해 잘못된 조합을 안내합니다.

### 3. 모델 가져오기

다운로드가 끝나면 앱으로 돌아와 `다운로드한 .litertlm 가져오기`를 누릅니다.

앱은 다음 작업을 수행합니다.

1. 확장자와 최소 파일 크기를 검사합니다.
2. 모델 크기 외에 256MB 이상의 여유 공간이 있는지 확인합니다.
3. 임시 파일로 복사한 뒤 완료된 경우에만 기존 모델을 교체합니다.
4. 앱 전용 내부 저장소에 보관합니다.

모델은 앱을 업데이트해도 유지되지만 앱을 삭제하면 함께 삭제됩니다.

### 4. 실제 가속기 확인

모델을 가져오면 앱이 자동으로 초기화를 시험합니다. `모델과 가속기 확인`을 다시 눌러 수동으로 확인할 수도 있습니다.

- `NPU 사용`: 현재 칩, NPU 런타임, 모델이 모두 호환됩니다.
- `GPU 사용`: NPU 초기화가 지원되지 않아 GPU로 전환됐거나 GPU 우선 설정입니다.
- `CPU 사용`: NPU와 GPU를 사용할 수 없어 CPU로 실행합니다.

첫 모델 로딩은 최적화와 캐시 생성 때문에 10초 이상 걸릴 수 있습니다. 같은 앱 프로세스에서 다음 문제를 만들 때는 이미 열린 엔진을 재사용합니다.

## NPU에 관한 중요한 사실

휴대폰에 NPU가 있다고 해서 모든 LLM 파일을 곧바로 NPU에서 실행할 수 있는 것은 아닙니다. 다음 조건이 함께 맞아야 합니다.

- LiteRT-LM이 해당 칩의 NPU 런타임을 지원해야 합니다.
- NPU를 쓰려면 현재 칩 대상으로 변환된 `.litertlm` 모델이어야 합니다. 일반 모델은 GPU/CPU로 실행합니다.
- 제조사 런타임과 휴대폰 펌웨어가 모델 연산을 지원해야 합니다.

따라서 앱은 `NPU 사용`을 미리 단정하지 않고 실제 `Engine.initialize()` 성공 결과를 표시합니다. NPU 실패를 감추지는 않되, 퀴즈 기능을 유지할 수 있도록 GPU와 CPU로 자동 전환합니다.

## Google AI Studio 연결

1. `Google로 간단히 시작`을 선택합니다.
2. `개인 키 만들기`에서 본인의 Google AI Studio 키를 만듭니다.
3. 키를 앱에 붙여 넣습니다.
4. `연결 확인하고 모델 고르기`를 누릅니다.
5. 앱이 찾은 Gemini 모델을 선택합니다.

기본 모델은 `gemini-2.5-flash`이며 실제 사용 가능 모델은 본인 키로 불러온 목록이 기준입니다.

## 고급 서버 연결

OpenAI 호환 API 주소를 이미 알고 있는 사용자를 위한 모드입니다. 서버 주소, 필요한 경우 API 키, 모델 이름을 입력합니다. 주소 끝에 `/v1`이 없다면 앱이 자동으로 붙입니다.

## AI 응답 계약

클라우드와 온디바이스 모델 모두 다음 JSON 구조를 출력하도록 지시받습니다.

```json
{
  "question": "문제",
  "choices": ["선택지 1", "선택지 2", "선택지 3", "선택지 4"],
  "answer": "선택지 중 정확히 하나",
  "explanation": "정답 해설"
}
```

앱은 선택지 개수, 중복, 정답 포함 여부를 검사하고 정답 위치를 다시 무작위로 섞습니다. 형식이 잘못되면 한 번 재생성합니다. 작은 270M 모델은 이 형식을 지키지 못할 가능성이 1B 이상 모델보다 큽니다.

## 보안과 한계

- 온디바이스 모드에서는 프롬프트와 생성 결과가 외부 서버로 전송되지 않습니다.
- 가져온 모델은 앱 내부 저장소에 보관되며 백업과 기기 이전 대상에서 제외됩니다.
- Google 모드는 각 사용자가 자신의 키를 넣는 BYOK 테스트 구조입니다. API 키는 Android Keystore로 암호화합니다.
- 고급 서버의 `http://` 연결을 허용하기 위해 cleartext 통신이 켜져 있습니다. 외부 서버에는 `https://`를 사용하세요.
- AI가 생성한 문제는 사실과 다를 수 있습니다. JSON 형식은 검사하지만 내용의 진실성을 별도 DB로 검증하지 않습니다.
- APK에는 모델 가중치가 포함되지 않습니다. 사용자가 모델 이용 조건을 확인하고 별도로 다운로드해야 합니다.
- NPU 호환성은 기기, 펌웨어, 모델 파일에 따라 달라 실제 휴대폰에서 확인해야 합니다.
- `v0.4.0` 테스트 APK는 최근 NPU 탑재 안드로이드폰을 대상으로 한 `arm64-v8a` 전용 빌드입니다.

## 기술 구성

- Kotlin Android
- LiteRT-LM Android `0.14.0`
- `.litertlm` 모델 형식
- LiteRT-LM `Backend.NPU`, `Backend.GPU`, `Backend.CPU`
- 모델 엔진 프로세스 캐시
- Android Storage Access Framework 모델 가져오기

## 빌드

```bash
./gradlew clean testDebugUnitTest assembleDebug lintDebug
```

빌드된 APK:

```text
app/build/outputs/apk/debug/app-debug.apk
```

## 참고 자료

- [LiteRT-LM 공식 저장소](https://github.com/google-ai-edge/LiteRT-LM)
- [LiteRT-LM Kotlin API](https://github.com/google-ai-edge/LiteRT-LM/blob/main/docs/api/kotlin/getting_started.md)
- [Gemma 3 1B LiteRT-LM 모델](https://huggingface.co/litert-community/Gemma3-1B-IT)
- [Gemma 3 270M LiteRT-LM 모델](https://huggingface.co/litert-community/gemma-3-270m-it)
- [Gemma 3n 개요](https://ai.google.dev/gemma/docs/gemma-3n)
- [Google Gemini 구조화 출력](https://ai.google.dev/gemini-api/docs/structured-output)
- [Google Gemini API 키 보안](https://ai.google.dev/gemini-api/docs/api-key)
