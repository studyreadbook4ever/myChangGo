# Kanji Wake

Kotlin Android prototype for a Japanese kanji vocabulary quiz lock app.

## What is included

- Four-choice quiz for Japanese kanji words and kanji-based verb phrases.
- Correct-answer detail view with Korean meaning, explanation, Japanese example, and Korean translation.
- `Endless Mode`, with a top-right `모드 종료` button.
- Soft-lock quiz mode, with a top-right countdown from `10` to `0`, then `광고 보고 잠금해제`.
- Foreground service that can show the soft-lock quiz after `ACTION_USER_PRESENT` when enabled.
- Local SQLite vocabulary database seeded from app code.

## Build

```bash
./gradlew assembleDebug
```

Debug APK:

```text
app/build/outputs/apk/debug/app-debug.apk
```

## Notes

Android does not allow ordinary apps to truly replace or block the system lock screen. This prototype uses a policy-friendly soft-lock flow: a foreground service monitors unlock events and opens a quiz activity after the user unlocks the phone.
