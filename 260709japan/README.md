# Per-Open Quest

[APK 바로 다운로드](https://github.com/studyreadbook4ever/myChangGo/releases/download/260709japan-debug-v0.3.0/app-debug.apk)

사용자가 자연어로 적은 출제 요청을 AI에 전달하고, 앱을 열거나 휴대폰 잠금을 해제할 때마다 새로운 4지선다 문제를 생성하는 Kotlin Android 앱입니다.

기존 `Kanji Wake`의 일본어 단어 DB와 조합 생성기는 제거했습니다. 기본값은 일본어 한자 어휘 학습이지만 설정의 `문제 내용`을 바꾸면 영어, 역사, 컴퓨터 기초 등 다른 주제도 사용할 수 있습니다.

## 주요 기능

- 매 질문마다 AI가 문제, 선택지 4개, 정답, 해설을 새로 생성합니다.
- `Google로 간단히 시작`, `내 PC의 AI 사용`, `고급 서버 연결` 세 가지 연결 흐름을 제공합니다.
- 로컬 연결에서는 Ollama와 LM Studio를 선택할 수 있습니다.
- 로컬 사용자는 복잡한 URL 대신 PC의 Wi-Fi 주소만 입력하면 됩니다.
- 연결 확인이 모델을 찾아 자동으로 채우고, 실패 원인을 쉬운 한국어로 안내합니다.
- `localhost`, `0.0.0.0`, 잘못된 포트처럼 자주 생기는 실수를 앱에서 먼저 설명합니다.
- 문제 주제는 자연어로 작성하거나 준비된 예시에서 시작할 수 있습니다.
- 문제를 먼저 보여주고 `3 → 2 → 1` 뒤에 선택지를 표시합니다.
- 정답 뒤에는 AI 해설과 `정답 복사` 버튼을 표시합니다.
- `Endless Mode`와 잠금 해제 뒤 나타나는 Per-Open 모드를 제공합니다.
- AI 연결 실패나 형식 오류가 발생하면 잠금 해제 버튼을 즉시 열어 사용자를 가두지 않습니다.
- API 키는 APK에 포함하지 않고 사용자의 Android Keystore로 암호화해 저장합니다.

## 앱에서 연결하는 순서

설정 화면은 다음 세 단계로 구성됩니다.

1. `AI 연결`에서 AI가 실행될 장소를 고르고 `연결 확인하고 모델 고르기`를 누릅니다.
2. `문제 내용`에 원하는 출제 방식을 평소 말하듯 적습니다.
3. `이 설정 사용하기`를 누른 뒤 퀘스트를 실행합니다.

오류가 나면 영문 네트워크 메시지 대신 다음 행동을 안내합니다. 예를 들어 `localhost`를 입력하면 그것이 PC가 아니라 휴대폰 자신을 뜻한다는 점을 알려주고, 연결 거부가 발생하면 같은 Wi-Fi, PC 프로그램 실행 여부, 외부 연결 허용 순서로 확인하게 합니다.

## 가장 간단한 연결: Google

PC에 모델을 설치하지 않고 먼저 시험하려는 경우입니다.

1. `AI 연결`에서 `Google로 간단히 시작`을 선택합니다.
2. `개인 키 만들기`를 눌러 본인의 Google AI Studio 키를 만듭니다.
3. 키를 앱에 붙여 넣습니다.
4. `연결 확인하고 모델 고르기`를 누릅니다.
5. 앱이 찾은 Gemini 모델을 고릅니다.

기본 모델은 `gemini-2.5-flash`이며 실제 사용 가능 모델은 본인 키로 불러온 목록이 기준입니다.

## 로컬 연결: Ollama

문제와 답을 PC 안의 모델이 생성하게 하려는 경우입니다. 처음에는 약 3.3GB인 `gemma3:4b`를 권장합니다. `gemma3:27b`는 약 17GB이고 실행 메모리도 더 많이 필요하므로 고성능 PC에서 선택하세요.

### PC에서 할 일

1. [Ollama](https://ollama.com/download)를 PC에 설치합니다.
2. PC의 명령창에서 모델을 받습니다.

```bash
ollama pull gemma3:4b
```

27B를 사용할 PC라면 다음 명령으로 바꿉니다.

```bash
ollama pull gemma3:27b
```

3. Ollama가 같은 Wi-Fi의 휴대폰 연결을 받도록 `OLLAMA_HOST`를 `0.0.0.0:11434`로 설정하고 Ollama를 다시 시작합니다. 운영체제별 정확한 설정은 [Ollama 공식 FAQ](https://docs.ollama.com/faq)의 `How can I expose Ollama on my network?` 항목을 따르세요.

### 앱에서 할 일

1. `내 PC의 AI 사용`을 선택합니다.
2. PC 프로그램으로 `Ollama`를 선택합니다.
3. `주소 찾는 법`을 눌러 PC의 Wi-Fi IPv4 주소를 확인합니다.
4. `192.168.0.10`처럼 주소만 입력합니다. `http://`, `11434`, `/v1`은 앱이 자동으로 붙입니다.
5. `연결 확인하고 모델 고르기`를 누릅니다.

## 로컬 연결: LM Studio

명령창보다 화면으로 설정하는 편이 편한 경우입니다.

1. [LM Studio](https://lmstudio.ai/download)를 설치하고 모델을 내려받습니다.
2. LM Studio의 `Developer` 화면에서 서버를 시작합니다.
3. `Server Settings`에서 `Serve on Local Network`를 켭니다.
4. 앱에서 `내 PC의 AI 사용`과 `LM Studio`를 선택합니다.
5. PC의 Wi-Fi 주소만 입력하고 연결을 확인합니다.

LM Studio는 로컬 네트워크 허용을 켜야 다른 기기에서 접근할 수 있습니다. 자세한 내용은 [LM Studio 공식 네트워크 안내](https://lmstudio.ai/docs/developer/core/server/serve-on-network)를 참고하세요.

## 자주 막히는 지점

- `localhost` 또는 `127.0.0.1`: 휴대폰 자신을 가리킵니다. PC의 Wi-Fi IPv4 주소를 입력해야 합니다.
- `0.0.0.0`: PC 서버가 연결을 받게 하는 설정값입니다. 앱의 PC 주소 칸에는 입력하지 않습니다.
- 연결 거부: PC의 Ollama/LM Studio가 실행 중인지 확인합니다.
- 시간 초과: 모델 로딩이 끝났는지, 두 기기가 같은 Wi-Fi인지 확인합니다.
- 모델 없음: Ollama에서는 모델을 `pull`하고, LM Studio에서는 모델을 내려받아 로드합니다.
- 계속 연결되지 않음: PC 방화벽에서 Ollama의 `11434` 또는 LM Studio의 설정 포트를 허용합니다.

## 고급 서버 연결

OpenAI 호환 API 주소를 이미 알고 있는 사용자를 위한 모드입니다. 서버 주소, 필요한 경우 API 키, 모델 이름을 입력합니다. 주소 끝에 `/v1`이 없다면 앱이 자동으로 붙입니다.

## AI 응답 계약

모델에는 사용자의 출제 요청과 함께 다음 JSON 구조를 요구합니다.

```json
{
  "question": "문제",
  "choices": ["선택지 1", "선택지 2", "선택지 3", "선택지 4"],
  "answer": "선택지 중 정확히 하나",
  "explanation": "정답 해설"
}
```

앱은 선택지 개수, 중복, 정답 포함 여부를 검사하고 정답 위치를 다시 무작위로 섞습니다. 형식이 잘못되면 한 번 재생성한 뒤 안전하게 오류를 표시합니다.

## 보안과 한계

- Google은 공개 모바일 앱에 공용 Gemini API 키를 내장하지 말고 서버 프록시를 사용하도록 권장합니다. 이 앱은 각 사용자가 자신의 키를 넣는 BYOK 테스트 구조입니다.
- Ollama와 LM Studio의 로컬 네트워크 허용은 같은 네트워크의 다른 기기에서도 서버에 접근할 수 있게 합니다. 신뢰하는 개인 네트워크에서만 사용하고 가능하면 방화벽과 인증을 설정하세요.
- 로컬 PC 연결에서 `http://`를 허용하기 위해 앱의 cleartext 통신이 켜져 있습니다. 외부 서버에는 `https://`를 사용하세요.
- AI가 생성한 문제는 사실과 다를 수 있습니다. JSON 형식은 검사하지만 내용의 진실성을 별도 DB로 검증하지는 않습니다.
- 현재 APK에는 휴대폰 내장 LLM 엔진이나 모델 파일이 포함되지 않습니다. `내 PC의 AI 사용`은 PC에서 모델을 실행하고 휴대폰이 같은 네트워크로 접속하는 구조입니다.

## 빌드

```bash
./gradlew clean testDebugUnitTest assembleDebug lintDebug
```

빌드된 APK:

```text
app/build/outputs/apk/debug/app-debug.apk
```

## 참고 자료

- [Google Gemini 구조화 출력](https://ai.google.dev/gemini-api/docs/structured-output)
- [Google Gemini API 키 보안](https://ai.google.dev/gemini-api/docs/api-key)
- [Ollama 네트워크 설정 FAQ](https://docs.ollama.com/faq)
- [Ollama Gemma 3 모델](https://ollama.com/library/gemma3)
- [Ollama OpenAI 호환 API](https://docs.ollama.com/api/openai-compatibility)
- [LM Studio 로컬 네트워크 연결](https://lmstudio.ai/docs/developer/core/server/serve-on-network)
- [Google LiteRT-LM](https://github.com/google-ai-edge/LiteRT-LM)
