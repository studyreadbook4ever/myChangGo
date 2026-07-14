# Per-Open Quest

[APK 바로 다운로드](https://github.com/studyreadbook4ever/myChangGo/releases/download/260709japan-debug-v0.2.0/app-debug.apk)

사용자가 자연어로 적은 출제 프롬프트를 AI 모델에 전달하고, 앱을 열거나 휴대폰 잠금을 해제할 때마다 새로운 4지선다 문제를 생성하는 Kotlin Android 앱입니다.

기존 `Kanji Wake`의 9,453개 일본어 DB와 조합 생성기는 제거했습니다. 기본 프롬프트는 일본어 한자 어휘 학습용이지만, 사용자가 프롬프트를 바꾸면 역사, 수학, 코딩, 암기 카드 등 다른 주제의 문제도 만들 수 있습니다.

## 주요 기능

- 매 질문마다 AI가 문제, 선택지 4개, 정답, 해설을 새로 생성합니다.
- `Google AI Studio`, `로컬 PC`, `기타 AI 서버` 연결 방식을 지원합니다.
- 연결된 서버에서 모델 목록을 불러오거나 모델 이름을 직접 입력할 수 있습니다.
- 자연어 출제 프롬프트를 설정 화면에서 자유롭게 편집할 수 있습니다.
- 생성된 문제를 먼저 보여주고 `3 → 2 → 1` 뒤에 선택지를 표시합니다.
- 정답 뒤에는 AI 해설과 `정답 복사` 버튼을 표시합니다.
- `Endless Mode`에서는 문제를 계속 생성합니다.
- Per-Open 모드를 켜면 잠금 해제 뒤 AI 퀘스트 오버레이가 나타납니다.
- AI 연결 실패나 형식 오류가 발생하면 잠금 해제 버튼을 즉시 열어 사용자를 가두지 않습니다.
- API 키는 APK에 포함하지 않고 사용자의 Android Keystore로 암호화해 저장합니다.

## Google AI Studio 연결

Google AI Studio는 Gemma를 휴대폰에 설치하는 도구가 아니라 Gemini API를 설정하고 시험하는 클라우드 서비스입니다.

1. 앱의 `AI 연결`에서 `Google AI Studio`를 선택합니다.
2. `키 만들기`를 눌러 개인 API 키를 생성하고 입력합니다.
3. `모델 찾기`에서 사용할 Gemini 모델을 선택합니다.
4. 원하는 `출제 프롬프트`를 적고 `설정 저장`을 누릅니다.

앱에 기본값으로 적힌 모델은 `gemini-2.5-flash`이며, 계정에서 사용 가능한 모델은 `모델 찾기` 결과가 기준입니다.

## Gemma 3 27B 로컬 연결

Gemma 3 27B는 Ollama의 4비트 배포본도 약 17GB이므로 일반 휴대폰 내부에서 실행하기 어렵습니다. 이 앱에서는 PC에서 모델을 실행하고 같은 Wi-Fi의 휴대폰이 PC에 연결하는 방식으로 사용합니다.

PC에 [Ollama](https://ollama.com/)를 설치한 뒤 다음 명령을 실행합니다.

```bash
ollama pull gemma3:27b
OLLAMA_HOST=0.0.0.0:11434 ollama serve
```

앱 설정값:

```text
연결 방식: 로컬 PC
서버 주소: http://PC의_내부_IP:11434/v1
모델: gemma3:27b
API 키: 비워 두기
```

휴대폰과 PC가 같은 네트워크에 있어야 하며 PC 방화벽에서 TCP 11434 포트 접근을 허용해야 합니다. LM Studio 등 OpenAI 호환 API를 제공하는 다른 로컬 실행기도 같은 방식으로 연결할 수 있습니다.

## AI 응답 계약

모델에는 사용자의 프롬프트와 함께 다음 JSON 구조를 요구합니다.

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

- Google은 공개 배포되는 모바일 앱에 공용 Gemini API 키를 내장하지 말고 서버 프록시를 사용하도록 권장합니다. 이 앱은 공용 키를 넣지 않고 각 사용자가 자신의 키를 입력하는 BYOK 테스트 구조입니다.
- 로컬 PC 연결에서 `http://`를 허용하기 위해 앱의 cleartext 통신이 켜져 있습니다. 신뢰하는 내부 네트워크에서만 사용하고 외부 서버에는 `https://`를 사용하세요.
- AI가 생성한 문제는 사실과 다를 수 있습니다. JSON 형식 검사는 하지만 내용의 진실성을 별도 데이터베이스로 검증하지는 않습니다.
- 현재 APK에는 휴대폰 내장 LLM 실행 엔진이나 모델 파일이 포함되지 않습니다. 모바일 완전 오프라인 모드는 Gemma 1B급 LiteRT-LM 모델을 별도로 다운로드하는 후속 구조가 필요합니다.

## 빌드

```bash
./gradlew assembleDebug lintDebug testDebugUnitTest
```

빌드된 APK:

```text
app/build/outputs/apk/debug/app-debug.apk
```

## 참고 자료

- [Google Gemini 구조화 출력](https://ai.google.dev/gemini-api/docs/structured-output)
- [Google Gemini API 키 보안](https://ai.google.dev/gemini-api/docs/api-key)
- [Google Gemma 실행 프레임워크 안내](https://ai.google.dev/gemma/docs/run)
- [Ollama OpenAI 호환 API](https://docs.ollama.com/api/openai-compatibility)
- [Google LiteRT-LM](https://github.com/google-ai-edge/LiteRT-LM)
