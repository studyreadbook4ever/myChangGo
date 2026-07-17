# LoopProbe + Pocket Loop

저사양 노트북의 Android 바이브코딩 루프를 `PASS / FAIL / ERROR` 세 값으로 좁히는 AI-to-AI 보조 도구다.

> 한 번의 변경 → 가장 싼 probe 하나 → 근거가 있는 판정 하나 → 다음 행동 하나

이 디렉터리에는 서로 역할이 다른 두 프로그램이 있다.

| 구성요소 | 역할 | 자동 증거 검증 여부 |
|---|---|---|
| `loopprobe.py` | Gradle task와 exact JUnit XML을 실행·검증하고 JSON 판정을 반환 | 예 |
| Pocket Loop Android 앱 | 사람이 입력한 관찰값을 보수적으로 분류하고 다음 Codex 지시문을 생성 | 아니요 |

Pocket Loop 앱의 “신뢰한 증거” 체크박스는 사용자의 주장이다. 실제 task 실행, 현재 XML 확인, testcase identity 검증은 오직 `loopprobe.py`가 담당한다.

---

## AI_START_HERE

이 절은 새 코딩 에이전트가 가장 먼저 읽어야 하는 실행 계약이다.

### 절대 불변식

1. `PASS`는 선택된 probe의 `scope`만 뜻한다. 앱 전체 성공으로 확대하지 않는다.
2. assertion 반례가 있을 때만 `FAIL`이다.
3. timeout, OOM 의심, signal, 누락된 도구, tests=0, fixture error, 오래된 XML은 `ERROR`다.
4. `ERROR`를 제품 코드 결함으로 추측하지 않는다. 먼저 toolchain·resource·evidence를 복구한다.
5. 한 루프에서 probe는 하나만 실행한다. 자동으로 더 비싼 단계에 올라가지 않는다.
6. 테스트를 통과시키려고 `scope`, assertion, expected testcase identity를 완화하지 않는다.
7. UI 입력이 판정 뒤 하나라도 바뀌면 이전 판정과 복사 가능한 prompt는 무효다.
8. `clean`, 무조건적인 `--rerun-tasks`, 상시 emulator 실행을 기본 행동으로 사용하지 않는다.

### AI 실행 프로토콜

프로젝트 루트에서 시작한다.

```bash
python3 loopprobe.py validate --json
python3 loopprobe.py run \
  --changed app/src/main/java/dev/loopprobe/pocketloop/LoopDecisionEngine.java \
  --json
```

JSON의 `verdict`에 따라 정확히 한 갈래만 선택한다.

```text
PASS  → scope만 기록하고 중지한다.
FAIL  → 같은 scope의 제품 코드 또는 정확한 계약만 수정하고 같은 probe를 재실행한다.
ERROR → reason/evidence가 지목한 실행·설정·자원 문제만 복구한다.
```

인계 직전에는 cache 재사용을 허용하지 않는 fresh probe를 한 번 실행한다.

```bash
python3 loopprobe.py run --probe android-decision-fresh --no-git --json
```

### 변경 파일별 검증 라우팅

| 변경 범위 | 첫 검증 | 필요할 때만 승격 |
|---|---|---|
| `LoopDecisionEngine.java`, 해당 JVM test | `android-decision-fast` | 인계 전 `android-decision-fresh` |
| `loopprobe.py`, `tests/**` | `machine-selftest` | Android 앱 변경이 함께 있을 때만 Gradle 단계 |
| `MainActivity.java`, `res/**`, manifest | `assembleDebug` + `lintDebug` | Android 의미가 바뀌면 `connectedDebugAndroidTest` |
| `src/androidTest/**` | `assembleDebugAndroidTest` | 연결 장치에서 `connectedDebugAndroidTest` |
| Gradle/wrapper 설정 | config validate + JVM test + assemble | 필요하면 lint/connected |
| 문서만 변경 | 명령·경로·판정 계약 대조 | 빌드 불필요 |

core probe가 PASS해도 UI 변경이 검증된 것은 아니다. 반대로 장치가 없어서 connected test를 실행하지 못한 것은 기능 FAIL이 아니라 환경 ERROR다.

### AI가 반환할 최소 인계 형식

```text
VERDICT: PASS | FAIL | ERROR
SCOPE: 이번 증거가 보장하는 한 문장
PROBE: 실행한 정확한 probe/task
EVIDENCE: test 수, failure/error 수, current/reused 여부
BOUNDARY: 확인하지 않은 UI/variant/device 경계
NEXT: 다음 한 행동 또는 STOP
```

---

## 문제 정의

Android 프로젝트의 전체 build, lint, emulator를 매 반복마다 실행하면 저사양 환경에서 다음 문제가 생긴다.

- Gradle/Kotlin daemon과 emulator가 메모리를 동시에 점유한다.
- timeout이나 OOM이 기능 실패처럼 보인다.
- 다른 test XML 또는 오래된 cache가 거짓 PASS를 만든다.
- AI가 한 규칙의 PASS를 앱 전체 성공으로 확대한다.
- 실패 원인이 제품 코드인지 toolchain인지 구분되지 않는다.

LoopProbe는 Android와 분리 가능한 가장 작은 Java/Kotlin 계약을 local JVM test로 먼저 반증한다. Android lifecycle, View, clipboard처럼 플랫폼 의미가 필요한 경우에만 마지막 경계로 승격한다.

## 아키텍처

```text
changed path / explicit probe
            │
            ▼
  strict .loopprobe.json validation
            │
            ▼
   one lowest-cost bounded process
            │
            ├─ process termination / exit
            ├─ exact Gradle task outcome
            ├─ exact JUnit XML file
            ├─ testcase class/name/count
            └─ host resource evidence
            │
            ▼
       PASS / FAIL / ERROR
            │
            ▼
       one next_action in JSON
```

Pocket Loop Android 앱은 이 자동 경로의 대체물이 아니다. 사람이 이미 확보한 관찰을 입력했을 때 같은 보수적 판정 규칙을 눈으로 확인하고 Codex prompt로 복사하는 companion이다.

## 디렉터리 지도

```text
.
├── loopprobe.py                         # Python 3.10+ 표준 라이브러리 CLI
├── .loopprobe.json                      # 이 프로젝트의 strict probe 설정
├── DESIGN.md                            # 상태 전이·판정표·신뢰 경계
├── THIRD_PARTY_NOTICES.md               # 외부 구성요소 라이선스 고지
├── tests/test_loopprobe.py              # LoopProbe 자체 안전성 테스트
├── examples/android.loopprobe.json      # 다른 Android 저장소용 복사 예제
├── app/src/main/java/.../
│   ├── LoopDecisionEngine.java          # Android-free 순수 판정 코어
│   └── MainActivity.java                # dependency-free 한 화면 앱
├── app/src/test/...                     # JVM 계약 테스트
├── app/src/androidTest/...              # 실제 Android UI/clipboard 테스트
├── gradle.properties                    # worker 1, bounded JVM, daemon 억제
└── gradle/wrapper/...                   # 고정 Gradle 8.10.2 + SHA-256
```

## 판정 논리

### PASS 필요충분조건

```text
scope is one valid line (1..240 chars)
AND termination == COMPLETED
AND exitCode == 0
AND trustedEvidence == true
AND executedTests >= 1
AND assertionFailures == 0
AND testErrors == 0
AND counts are internally consistent
```

### FAIL 필요충분조건

```text
valid scope
AND termination == COMPLETED
AND exitCode in 1..255
AND trustedEvidence == true
AND executedTests >= 1
AND assertionFailures >= 1
AND testErrors == 0
AND counts are internally consistent
```

나머지는 모두 `ERROR`다. 특히 다음은 FAIL이 아니다.

| 관찰 | 판정 이유 |
|---|---|
| `TIMEOUT` | 기능 assertion이 끝까지 관찰되지 않음 |
| `SIGNAL`, exit 137 | OOM 또는 코드 결함을 단정할 근거가 부족함 |
| `OUTPUT_LIMIT` | 최종 결과를 읽지 못함 |
| `SPAWN_ERROR`, `NOT_STARTED` | probe 자체가 성립하지 않음 |
| tests=0 | 실행된 계약이 없음 |
| JUnit `<error>` | fixture/runner 문제이며 assertion 반례가 아님 |
| exit 0 + failure XML | 서로 모순된 증거 |
| untrusted evidence | 현재 실행 또는 Gradle 검증임을 확인하지 못함 |

`LoopDecisionEngineTest`는 12,000개 조합을 훑어 허용된 좁은 조건 밖에서 PASS/FAIL이 나오지 않는지 확인한다.

## 요구사항

- Python 3.10 이상
- JDK 17 이상
- Android SDK Platform 35
- Android Build Tools 34.0.0 이상
- 첫 Gradle/Android dependency 준비를 위한 네트워크
- instrumented test를 실행하려면 USB 장치 또는 API 35 emulator

Gradle 설치는 필요하지 않다. 저장소에 포함된 wrapper가 검증된 Gradle 8.10.2 배포본을 사용한다.

`local.properties`는 머신 경로를 포함하므로 커밋하지 않는다. Android Studio가 생성하게 하거나 `ANDROID_HOME`/`ANDROID_SDK_ROOT`가 올바른 SDK를 가리키게 한다.

## 처음 clone한 뒤 bootstrap

상위 `myChangGo` 저장소에서 이 프로젝트로 이동한다.

```bash
cd 260716AndroidTest
python3 loopprobe.py validate --json
./gradlew --no-daemon --max-workers=1 --no-parallel \
  --console=plain :app:testDebugUnitTest
```

첫 실행은 Gradle과 Maven artifact를 내려받을 수 있다. 이후 실행은 local cache를 재사용한다. 필요한 artifact가 모두 준비됐음을 직접 확인한 환경에서만 임시로 Gradle `--offline`을 사용할 수 있다.

## 일상적인 저자원 루프

### 자동 선택

Git 변경 경로를 신뢰할 수 있으면 다음 한 줄로 가장 싼 일치 probe를 선택한다.

```bash
python3 loopprobe.py run --json
```

Git 상태를 사용하지 않거나 변경 경로를 명시하려면 다음과 같이 실행한다.

```bash
python3 loopprobe.py run \
  --changed app/src/test/java/dev/loopprobe/pocketloop/LoopDecisionEngineTest.java \
  --json
```

### 명시적 probe

```bash
python3 loopprobe.py run --probe android-decision-fast --no-git --json
python3 loopprobe.py run --probe android-decision-fresh --no-git --json
python3 loopprobe.py run --probe machine-selftest --no-git --json
```

| probe | 의미 | cache 정책 |
|---|---|---|
| `android-decision-fast` | 정확한 JVM test class 6개 | 현재 Gradle invocation이 검증한 cache 허용 |
| `android-decision-fresh` | 같은 class를 인계용으로 재실행 | `--rerun`과 갱신된 XML 필수 |
| `machine-selftest` | LoopProbe process/evidence state machine | Python unittest 직접 실행 |

## JSON 소비 규약

AI는 자연어 로그보다 다음 필드를 우선한다.

```text
verdict                  PASS | FAIL | ERROR
check                    pass | fail | unknown
termination              completed | timeout | output_limit | signal | ...
reason                   안정적인 machine-readable 원인 코드
scope                    확인된 범위의 유일한 문장
evidence                 exit/task/JUnit/executable/host 근거
diagnosis.category       none | code | toolchain | resource | probe | unknown
diagnosis.confidence     none | suspected | confirmed
next_action              다음 루프의 한 행동
process.leaked_process_group
timing.duration_ms
```

AI 의사코드:

```text
result = run_loopprobe_once()

if result.verdict == "PASS":
    report(result.scope, result.evidence)
    stop()
elif result.verdict == "FAIL":
    modify_only_the_named_behavior_or_exact_contract()
    rerun_same_probe()
else:
    repair_only(result.reason, result.evidence, result.diagnosis)
    rerun_same_probe()
```

process exit code도 안정적인 자동화 계약이다.

```text
0   PASS
1   FAIL
2   ERROR
130 CANCELLED
```

## 수동 검증 사다리

각 단계는 서로 다른 주장을 검증한다. 앞 단계의 성공이 뒷 단계를 대신하지 않는다.

### 1. JVM 계약

```bash
./gradlew --no-daemon --max-workers=1 --no-parallel \
  --console=plain :app:testDebugUnitTest
```

### 2. 앱과 test APK 패키징

```bash
./gradlew --no-daemon --max-workers=1 --no-parallel \
  --console=plain :app:assembleDebug :app:assembleDebugAndroidTest
```

### 3. lint

```bash
./gradlew --no-daemon --max-workers=1 --no-parallel \
  --console=plain :app:lintDebug
```

### 4. 실제 Android 경계

연결 장치가 있을 때만 실행한다.

```bash
adb devices -l
./gradlew --no-daemon --max-workers=1 --no-parallel \
  --console=plain :app:connectedDebugAndroidTest
```

계측 테스트는 다음을 확인한다.

- 초기 상태가 PASS를 주장하지 않음
- PASS/FAIL/TIMEOUT preset의 실제 UI 연결
- 판정 뒤 입력 변경 시 stale PASS와 copy 비활성화
- 잘못된 입력이 앱을 crash시키지 않음
- 복사된 Codex prompt가 판정 시점의 immutable snapshot임
- TIMEOUT이 무관한 빈 numeric field 때문에 다른 오류로 변하지 않음

## Android 앱 사용법

1. 이번 변경이 보장해야 할 범위를 한 문장으로 쓴다.
2. 프로세스 종료 상태를 선택한다.
3. `COMPLETED`일 때 exit code, 실행 test 수, assertion failure 수, runner error 수를 넣는다.
4. 현재 실행 또는 Gradle이 검증한 증거일 때만 신뢰 체크를 켠다.
5. `판정하기`를 누른다.
6. 결과가 나온 뒤 입력을 바꾸면 반드시 다시 판정한다.
7. `Codex 지시문 복사`는 마지막 유효 판정의 snapshot만 복사한다.

debug APK:

```text
app/build/outputs/apk/debug/app-debug.apk
```

설치 예:

```bash
adb install -r -t app/build/outputs/apk/debug/app-debug.apk
```

## 보고서와 산출물

```text
app/build/test-results/testDebugUnitTest/
app/build/reports/tests/testDebugUnitTest/
app/build/reports/lint-results-debug.html
app/build/outputs/apk/debug/app-debug.apk
app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
app/build/outputs/androidTest-results/connected/debug/
app/build/reports/androidTests/connected/debug/index.html
```

connected XML 파일명은 장치 모델/serial에 따라 달라질 수 있다. 특정 emulator 이름을 코드나 자동화에 하드코딩하지 않는다.

## 저사양 설계 선택

`gradle.properties`의 기본값:

```properties
org.gradle.jvmargs=-Xmx768m -XX:MaxMetaspaceSize=384m
org.gradle.workers.max=1
org.gradle.parallel=false
org.gradle.daemon=false
org.gradle.vfs.watch=false
org.gradle.configuration-cache=false
```

명령에도 `--no-daemon --max-workers=1 --no-parallel --console=plain`을 명시한다.

- `clean`은 incremental output을 버리므로 기본 금지다.
- `--rerun-tasks`는 dependency task 전체를 다시 실행하므로 기본 금지다.
- fresh probe는 Gradle Test task 전용 `--rerun`만 사용한다.
- lint는 JVM probe보다 무거우므로 매 loop가 아닌 수동 승격 단계다.
- emulator는 host 메모리를 크게 점유하므로 작은 domain contract에는 사용하지 않는다.
- 이 Java-only 프로젝트에 Kotlin compiler daemon option을 추가하지 않는다.
- `android.nonFinalResIds=true`이므로 `switch (R.id...)` 코드를 새로 만들지 않는다.
- `buildConfig=false`이므로 `BuildConfig` 참조를 추가하지 않는다.

Gradle이 JVM 설정을 적용하려고 single-use daemon을 만들 수는 있다. 정상 종료 뒤 그 프로세스가 남지 않는 것이 계약이다.

## Android test 구현 주의

의존성 절감을 위해 AndroidX test runner 대신 플랫폼의 legacy runner를 test APK에서만 사용한다.

```groovy
useLibrary "android.test.base"
useLibrary "android.test.runner"

defaultConfig {
    testInstrumentationRunner "android.test.InstrumentationTestRunner"
}
```

SDK 35 compile classpath에서는 `android.test.base`와 `android.test.runner`가 모두 필요하다. 하나만 제거하면 `InstrumentationTestCase` 계열 compile이 깨질 수 있다. 이 선택을 AndroidX로 바꾸려면 dependency·메모리·runner·test report 경계를 함께 재검증한다.

## `.loopprobe.json` 설정 계약

JSON은 의도적으로 엄격하다.

- duplicate/unknown key 거부
- 빈 argv 또는 shell command string 거부
- config root 밖 cwd/path 거부
- exact Gradle task와 exact `--tests` filter 요구
- cache 허용 mode에서는 wildcard JUnit path 거부
- fresh mode에서는 `--rerun`과 갱신된 XML 요구
- `NO-SOURCE`, `SKIPPED`, tests=0, 전부 skipped를 PASS로 인정하지 않음

공통 probe 필드:

| 필드 | 의미 |
|---|---|
| `name` | 유일한 probe ID |
| `kind` | `command` 또는 `gradle-test` |
| `scope` | PASS가 뜻하는 정확한 한 문장 |
| `argv` | `shell=False`로 실행할 literal 인자 배열 |
| `cwd` | config root 내부 상대 경로 |
| `changes` | probe가 담당하는 좁은 변경 glob |
| `fallback` | changed path를 모를 때 후보인지 여부 |
| `cost` | 작은 값 우선 |
| `timeout_seconds` | 전체 limit 이내의 deadline |

`gradle-test`에는 `gradle_task`, `junit_xml`, `min_tests`, `evidence_mode`, `expected_test_class`와 선택적 `expected_test_name`이 추가된다.

## 다른 Android 저장소에 이식

```bash
cp loopprobe.py /path/to/android-repo/
cp examples/android.loopprobe.json /path/to/android-repo/.loopprobe.json
cd /path/to/android-repo
python3 loopprobe.py validate --json
```

반드시 실제 프로젝트에 맞게 다음을 바꾼다.

1. 정확한 module/variant `Test` task
2. 정확한 `--tests` class 또는 method filter
3. exact JUnit XML 경로
4. XML에 기록되는 testcase classname/name
5. 테스트가 보장하는 한 문장 `scope`
6. 그 계약이 실제로 의존하는 좁은 `changes` glob
7. 프로젝트 규모에 맞는 timeout/memory/disk floor

Android `Context`, View, lifecycle이 계약의 본질이면 local JVM test로 흉내 내지 말고 별도 instrumented test로 승격한다.

## 보안과 신뢰 경계

- LoopProbe는 sandbox가 아니다. 신뢰한 config의 executable은 사용자 권한으로 실행된다.
- argv는 배열이며 `shell=False`다. `&&`, pipe, `$VAR`, `~`, shell glob을 해석하지 않는다.
- POSIX에서는 독립 process group을 TERM→KILL한다.
- Linux에서는 child subreaper로 session을 탈출한 고아 자손도 회수한다.
- 저장소별 lock은 LoopProbe끼리만 직렬화한다. Android Studio나 별도 Gradle과 동시 실행하지 않는다.
- 출력은 byte budget을 넘으면 중단하고 bounded tail만 JSON에 남긴다.
- signal 9나 exit 137만으로 OOM을 단정하지 않는다.
- persistent PASS cache를 만들지 않는다. Gradle cache는 현재 invocation이 exact output을 검증했을 때만 `reused` evidence다.
- 앱의 clipboard에는 사용자가 입력한 scope가 들어간다. 민감한 정보를 scope에 넣지 않는다.

## 기준 검증 기록

2026-07-17 기준으로 다음 검증을 통과했다. 이 기록은 이후 변경의 현재 증거를 대신하지 않으므로 인계 시 다시 실행한다.

- LoopProbe 자체 unittest: 68개 통과
- JVM decision test: 6개 통과, 내부 12,000조합 포함
- API 35 AOSP ATD instrumentation: 8개 통과
- Android lint: issue 0
- 앱 APK 직접 설치 및 cold launch 성공
- 앱/test APK v1·v2 서명 및 zip alignment 확인
- 앱 선언 permission 0개

## 라이선스

외부 구성요소와 test dependency의 라이선스는 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)에 정리돼 있다. Gradle Wrapper JAR에는 Apache-2.0 전문이 포함되어 있고, wrapper script에도 SPDX 고지가 있다.

이 디렉터리의 자체 소스에 대한 재사용 권한은 상위 저장소의 `LICENSE`가 있으면 그 조건을 따른다. 상위 저장소에 별도 라이선스가 없다면 공개 열람만으로 복제·수정·재배포 권한이 자동 부여되지는 않는다.

## 추가 문서

- [DESIGN.md](DESIGN.md): 상태 전이, 판정표, 불변식, 신뢰 경계
- [examples/android.loopprobe.json](examples/android.loopprobe.json): 다른 Android 프로젝트용 예제
- [Android local tests](https://developer.android.com/training/testing/local-tests)
- [Android instrumented tests](https://developer.android.com/training/testing/instrumented-tests)
- [Gradle test filtering and `--rerun`](https://docs.gradle.org/current/userguide/java_testing.html)
- [Gradle Wrapper](https://docs.gradle.org/current/userguide/gradle_wrapper.html)
