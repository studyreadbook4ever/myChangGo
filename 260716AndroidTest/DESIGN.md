# LoopProbe의 논리 계약

LoopProbe는 빌드 시스템이 아니라 하나의 bounded state machine이다.

입력은 다음과 같다.

```text
repository snapshot R
+ known changed paths C
+ strict probe set P
+ resource budget B
→ one observation O
→ one decision D
```

한 호출에서 기능 probe는 정확히 하나만 실행한다. 자동 재시도, 더 비싼 probe로 자동 승격, LoopProbe가 저장한 과거 PASS 재사용은 없다. 단, cache 허용 probe는 현재 Gradle invocation이 `UP-TO-DATE`/`FROM-CACHE`로 검증한 exact task output을 reused evidence로 쓸 수 있다.

## 세 값

```text
PASS  = 유효하고 비어 있지 않은 선택 probe가 관찰 가능한 계약을 만족
FAIL  = 실행이 성립했고 현재 관찰이 계약의 반례
ERROR = 실행 또는 증거가 불완전하여 참/거짓을 결정할 수 없음
```

`PASS`는 `scope`에 적힌 주장만 뜻한다. 앱 전체, 다른 variant, Android 런타임, UI를 암시하지 않는다.

종료 방식과 원인 추정은 서로 다른 축이다.

```text
termination = completed | timeout | output_limit | signal
            | spawn_error | leaked_process_group | cancelled | not_started

check       = pass | fail | unknown
diagnosis   = none | code | toolchain | resource | probe | unknown
confidence  = none | suspected | confirmed
```

따라서 `timeout + check:unknown + diagnosis:resource/suspected`는 모순이 아니다. deadline이 먼저였다는 사실과 그전에 보인 자원 압박 단서는 함께 기록할 수 있다.

## 상태 전이

```text
LOAD → VALIDATE → SELECT → PREFLIGHT → LOCK → SPAWN → OBSERVE → CLASSIFY → DONE
          │          │          │        │         │          │
          └──────────┴──────────┴────────┴─────────┴──────────┴→ ERROR
```

- `VALIDATE`: 중복/알 수 없는 키, 타입, 경로, 빈 argv, 넓거나 모호한 Gradle filter를 거부한다.
- `SELECT`: 명시 `--probe`가 우선이다. 그다음 changed glob 후보를 `(cost, config order, name)`으로 정렬한다. changed path를 모를 때만 fallback을 쓴다.
- `PREFLIGHT`: cwd containment, 실행 파일, 선택적 메모리/디스크 floor를 확인한다.
- `LOCK`: 같은 저장소에서 두 probe가 동시에 자원을 먹지 못하게 OS lock을 잡는다.
- `SPAWN`: argv 배열과 `shell=False`, POSIX 독립 process group을 사용한다. Linux는 child subreaper로 session을 탈출해 고아가 된 자손도 회수한다.
- `OBSERVE`: monotonic deadline, 총 출력 budget, bounded tail을 지키면서 stdout/stderr를 계속 drain한다.
- `CLASSIFY`: 이 문서의 우선순위로 순수 판정한다.

## 불변식

1. terminal verdict와 `check`는 각각 정확히 하나다.
2. `PASS ⇒ termination=completed`다. timeout, signal, missing tool, output limit는 PASS가 아니다.
3. `FAIL`은 관찰된 반례가 있을 때만 가능하다. 환경/증거 실패는 ERROR다.
4. Gradle test에서 `NO-SOURCE`, `SKIPPED`, tests=0, 전부 skipped, target task 미관찰은 PASS가 아니다.
5. current Gradle task는 실행 전후 XML metadata가 달라진 보고서만 current evidence로 쓰고, aggregate count와 실제 testcase/class/name을 대조한다.
6. `UP-TO-DATE`/`FROM-CACHE`는 현재 Gradle invocation이 검증한 reused evidence로 표시하며, fresh probe에서는 거부한다.
7. exit 0과 실패 XML처럼 서로 충돌하는 증거는 FAIL/PASS 어느 쪽도 택하지 않고 ERROR다.
8. signal 9나 exit 137만으로 OOM을 단정하지 않는다. canonical OOM/ENOMEM/ENOSPC 같은 강한 증거가 필요하다.
9. timeout 이후 return code가 0으로 보이더라도 TIMEOUT 사실을 덮어쓰지 않는다.
10. LoopProbe 자체의 과거 결과/PASS cache는 verdict 입력으로 존재하지 않는다. Gradle cache 재사용은 6번의 current invocation 증거가 있을 때만 가능하다.

## Gradle test 판정표

| 현재 관찰 | 판정 |
|---|---|
| target `NO-SOURCE` / `SKIPPED` | ERROR / no evidence |
| target line 없음 | ERROR / probe or toolchain |
| fresh mode에서 `UP-TO-DATE` / `FROM-CACHE` | ERROR / fresh evidence missing |
| test XML 없음, 오래됨, 파싱 불가 | ERROR / no evidence |
| 실행된 test 수가 `min_tests` 미만 | ERROR / empty suite |
| nonzero + current JUnit assertion failure, error 없음 | FAIL / functional counterexample |
| nonzero + JUnit execution error | ERROR / fixture or runner unknown |
| zero + JUnit failure/error | ERROR / contradictory evidence |
| nonzero + 기능 반례 없음 | ERROR / incomplete Gradle probe |
| zero + tests>0 + failure=error=0 | PASS / current 또는 reused |

## 신뢰 경계

`shell=False`와 root containment는 shell injection과 우발적인 cwd 탈출을 줄일 뿐 sandbox가 아니다. 설정에서 선택한 wrapper나 executable은 사용자 권한으로 임의 파일·네트워크·프로세스를 다룰 수 있다. 신뢰하지 않는 저장소의 probe를 실행하면 안 된다.
