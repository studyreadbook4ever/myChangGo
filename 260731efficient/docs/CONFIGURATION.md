# 설정 레퍼런스

## 형식

설정 schema는 현재 `1`입니다. UTF-8 텍스트에서 한 줄에 `key = value`를 쓰며,
빈 줄과 첫 non-space 문자가 `#`인 줄은 무시합니다. inline comment는 없으므로
값 뒤의 `#`도 값의 일부입니다.

값은 따옴표 없이 쓰거나 큰따옴표로 감쌀 수 있습니다. 큰따옴표 안에서는
`\\`, `\"`, `\n`, `\r`, `\t`만 escape할 수 있습니다. 설정을 셸에 source하지
마세요. idlepilot도 셸 확장, 환경 변수 확장, `~` 확장을 하지 않습니다.

알 수 없는 키는 오류입니다. `arg`와 `env`만 반복할 수 있고, 나머지는 정확히
한 번 또는 아래에 “선택”으로 표시된 경우 최대 한 번만 나옵니다. 설정 파일의
최대 크기는 256 KiB입니다.

## 전체 예시

```text
schema_version = 1
name = nightly-task
executable = "/home/alice/.local/lib/idlepilot/artifacts/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
arg = "--mode"
arg = "incremental"
arg = "literal ; $(not-executed)"
working_directory = "/home/alice/.local/share/idlepilot/work"
env = "TZ=Asia/Seoul"
env = "MY_JOB_MODE=night"
executable_sha256 = 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
window = 01:00-06:00
poll_seconds = 600
guard_milliseconds = 250
start_stability_seconds = 15
idle_seconds = 900
wifi = any
power = auto
idle = logind-seat:seat0
stop_grace_seconds = 5
max_runtime_seconds = 14400
max_attempts_per_window = 3
retry_on_failure = false
retry_after_guard_loss = true
state_file = "/home/alice/.local/state/idlepilot/nightly-task.state"
```

`/home/alice`는 실제 사용자의 절대 경로로 바꾸세요. `${HOME}` 같은 문자열은
확장되지 않습니다.

## 키

| 키 | 필수 | 값/범위 | 의미 |
|---|---:|---|---|
| `schema_version` | 예 | 정수 `1` | 설정 schema 버전 |
| `name` | 예 | `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` | 이벤트/상태를 구분하는 안전한 이름 |
| `executable` | 예 | 절대 경로 | 직접 exec할 일반 파일 또는 검토된 shebang 스크립트 |
| `arg` | 반복 | 문자열 | argv 항목 하나. 순서대로 전달하며 셸 parsing 없음 |
| `working_directory` | 예 | 절대 경로 | action의 현재 디렉터리 |
| `env` | 반복 | `KEY=value` | 상속 환경을 비운 뒤 추가할 명시 환경 |
| `executable_sha256` | 선택 | 소문자 hex 64자 | launch 직전 실행 파일 내용 pin |
| `window` | 예 | `HH:MM-HH:MM` | 허용 로컬 시간 반개구간 |
| `poll_seconds` | 예 | 10..600 | 대기/완료 후 재확인 간격; 어떤 설정에서도 10분을 넘지 않음 |
| `guard_milliseconds` | 예 | 100..250 | 안정화/실행 중 최대 재검사 간격 |
| `start_stability_seconds` | 예 | 0..300 | 실행 전 조건이 연속으로 참이어야 하는 시간 |
| `idle_seconds` | 예 | 0..86400 | logind가 보고해야 할 최소 유휴 시간 |
| `wifi` | 예 | 아래 참조 | Wi-Fi carrier 정책 |
| `power` | 예 | 아래 참조 | 외부 전원 정책 |
| `idle` | 예 | 아래 참조 | 사용자 유휴 공급자 |
| `stop_grace_seconds` | 예 | 1..300 | process group TERM 후 KILL까지의 유예 |
| `max_runtime_seconds` | 선택 | 1..604800 | action 한 번의 최대 실행 시간; 생략하면 제한 없음 |
| `max_attempts_per_window` | 예 | 1..100 | local window 하나의 최대 durable launch-intent 수 |
| `retry_on_failure` | 예 | `true`/`false` | non-zero/signal/descendant 누수 실패 후 같은 window 재시도 |
| `retry_after_guard_loss` | 예 | `true`/`false` | 조건이 다시 참일 때 같은 window 재시도 |
| `state_file` | 예 | 절대 경로 | durable once/attempt/live-state 파일 |

`arg`는 최대 256개, 항목당 최대 64 KiB, 합계 최대 1 MiB입니다. 빈 argument가
필요하면 `arg = ""`로 씁니다.

환경 키는 영문자 또는 `_`로 시작하고 이후 영문/숫자/`_`만 사용할 수 있습니다.
중복 키는 오류입니다. loader와 interpreter 주입 위험 때문에 `LD_*`, `DYLD_*`,
`PYTHON*`, `PERL*`, `RUBY*`, `GIT_*`, `LC_*` 및 `PATH`, `LANG`, `BASH_ENV`,
`ENV`, `IFS`, `SHELLOPTS`, `GCONV_PATH`, `NODE_OPTIONS`, `JAVA_TOOL_OPTIONS`,
`_JAVA_OPTIONS`, `SSH_AUTH_SOCK`, `DBUS_SESSION_BUS_ADDRESS`는 거부됩니다.
비밀은 평문 `env`에 저장하지 마세요. 이 `env`는 action에만 적용되며 supervisor의
window timezone이나 condition probe 환경을 바꾸지 않습니다.

## 조건 정책

### `wifi`

- `any`: sysfs에서 wireless interface를 찾고 하나 이상의 carrier가 online이어야
  합니다.
- `interface:NAME`: 지정 interface만 확인합니다. 이름은 최대 15자의
  영문/숫자/`_-.`입니다.
- `disabled`: 조건을 항상 충족 처리하며 `validate` warning을 냅니다.

`met`은 링크 carrier를 뜻할 뿐 인터넷이나 특정 SSID 접속 보장이 아닙니다.

### `power`

- `auto`: system battery가 있거나 DMI chassis가 portable이면 online 외부 전원을
  요구합니다. battery가 없고 DMI가 명시적으로 stationary인 system만
  외부 전원 없이 통과합니다.
- `required`: 장비 종류와 무관하게 online 외부 전원을 요구합니다.
- `ignore`: 조건을 항상 충족 처리하며 warning을 냅니다.

power sysfs를 읽지 못하거나 supply/DMI chassis 속성이 모호하면 추측하지 않고
`unknown`입니다.
충전이 끝난 battery의 `Full` 상태만으로 AC 연결을 추론하지 않습니다.

### `idle`

- `logind-seat:NAME`: 해당 physical seat의 `IdleHint`와
  `IdleSinceHintMonotonic`을 확인합니다. 일반 PC의 기본값은 보통 `seat0`입니다.
- `logind-user`: 현재 effective UID에 대한 logind aggregate idle hint를
  확인합니다.
- `disabled`: 조건을 항상 충족 처리하며 warning을 냅니다.

`idle_seconds = 0`이면 참인 idle hint만 요구합니다. 1 이상이면 `/proc/uptime`의
monotonic 값과 idle-since를 비교합니다. `loginctl`이 없거나 질의가 실패/timeout한
경우 `unknown`입니다.

### `window`

`01:00-06:00`은 01:00을 포함하고 06:00을 제외합니다. 시작과 끝이 같은 값은
항상 열린 window로 해석하지 않고 오류로 거부합니다. `23:00-03:00`은 자정을
넘는 하나의 window입니다.

## 재시도와 완료

각 열린 local window에는 영속 key가 하나 있습니다.

- supervisor는 spawn 전에 `attempts`를 늘린 launch-intent를 state에 동기
  저장합니다. 이 저장 뒤 마지막 guard가 바뀌거나 종료 signal/crash가 발생하면
  exec하지 않았어도 attempt 하나가 소비될 수 있습니다.
- 이전 daemon identity가 남은 `phase=qualifying`/`launch_intent_persisted` state에
  action identity가 없으면 다음 startup은 unresolved intent로 거부됩니다. 이전
  cgroup/process cleanup을 검증하고 state를 보존·회전하기 전에는 재시작하지
  마세요.
- action identity가 남았는데 owning daemon이 사라졌다면 leader와 process group이
  모두 종료된 경우에도 terminal 성공/실패와 외부 부작용을 추측하지 않습니다.
  `status`는 `terminal_result_unknown`으로 표시하고 `plan`/startup은 recovery를
  요구합니다. cleanup과 작업 결과를 검토하고 state를 보존·회전해야 합니다.
- persisted `phase=fault`는 action identity가 없어도 자동 정상화하지 않습니다.
  `plan`은 `recovery_required`, `run`은 startup security 오류로 거부합니다.
- 성공하면 해당 key가 완료되어 daemon 재시작 뒤에도 다시 실행하지 않습니다.
- completed key는 high-water mark라서 이후 시스템 시각이 더 오래된 window key로
  rollback되어도 실행하지 않습니다. `window` 정책을 바꾸면 config fingerprint가
  달라져 기존 state를 거부하므로 안전한 stop과 state 보존·회전 migration을
  수행하세요.
- action 실패 시 `retry_on_failure=false`이면 terminal 완료입니다. `true`이면
  남은 시도 횟수 안에서 재시도할 수 있습니다.
- live guard 상실 시 현재 supervisor는 direct daemon mode에서도 exit 7로
  종료합니다. `retry_after_guard_loss=false`이면 terminal 완료입니다. `true`이면
  완료 표시를 남기지 않으므로 systemd가 재기동한 다음 인스턴스가 조건과 남은
  시도 횟수를 다시 확인할 수 있습니다.
- runtime limit은 해당 window를 terminal 완료하고 supervisor는 exit 8로
  종료합니다. 제공 unit은 cgroup 정리 뒤 재기동되지만 완료 상태 때문에 같은
  window의 action은 다시 시작하지 않습니다.
- 운영자가 `stop`/SIGINT/SIGTERM으로 정상 종료한 경우는 guard 상실 정책으로
  간주하지 않으며 `retry_after_guard_loss=false`만으로 완료 처리하지 않습니다.
  launch-intent 시도 횟수는 남고, 다음 평가에서 한도 도달 여부를 다시 적용합니다.
- action exit가 첫 stop signal 전에 pidfd로 이미 관찰된 경우에만 자연 exit 결과가
  guard/runtime/shutdown reason보다 우선합니다. signal 뒤 처음 관찰된 code 0은
  graceful TERM handler일 수 있으므로 원래 stop 정책을 유지합니다.
- 시도 횟수가 `max_attempts_per_window`에 도달하면 완료 처리합니다.
- `run --once`는 재시도 설정과 관계없이 호출 하나에서 launch-intent를 최대 한 번
  예약하고 그 결과를 반환합니다. 마지막 guard 상실 등으로 실제 exec는 없을 수
  있습니다.

완료 기록을 의도적으로 초기화하려면 daemon을 먼저 멈추고 state 파일을 안전한
백업 이름으로 이동해야 합니다. 실행 중 state를 편집하거나 삭제하지 마세요.

## state schema와 config binding

config schema v1과 별개로 영속 state schema는 v2입니다. v2 state는 모든 키가
결정적 순서로 있는 canonical 파일이며 `config_fingerprint`에
`Config::to_canonical_text()`의 UTF-8 출력에서 `#`로 시작하는 행을 모두 제거하고,
남은 각 행을 `\n`으로 끝낸 바이트열의 SHA-256을 저장합니다. 아직 supervisor가
초기화하지 않은 pristine state만 fingerprint가 없을 수 있습니다. 외부 도구도
fingerprint를 계산할 때 이 정확한 preimage 규칙을 사용해야 합니다.

이 binding은 서로 다른 설정이 실수로 같은 `state_file`을 공유하거나, 이전
완료/실행 identity를 새 정책으로 해석하는 것을 막습니다. whitespace, comment,
키 표기 순서처럼 parse 뒤 사라지는 차이는 fingerprint를 바꾸지 않지만 argv 순서,
환경, window, artifact pin, 재시도 정책 등 canonical config field의 의미가 바뀌면
fingerprint가 달라집니다. `plan`, `status`, `stop`, `run`은 mismatch를 security
오류(exit 5)로 거부합니다.

config를 변경하거나 v1 state가 남은 버전에서 업그레이드할 때 자동 state migration은
없습니다. 먼저 service를 정상 중지하고 `status`와 cgroup/process 정리를 확인한 뒤,
기존 state를 삭제하지 말고 보존 이름으로 이동하고 새 state로 시작하세요. 이는
완료/시도 기록을 초기화할 수 있으므로 중복 부작용 가능성을 별도로 승인해야 합니다.
같은 절차는 unresolved intent, durable terminal result가 없는 persisted action,
persisted fault의 복구에도 적용됩니다.

## 경로와 권한

`Config::load_secure`는 parse 뒤 다음 runtime 경로까지 검증합니다.

- config와 executable은 일반 non-symlink 파일이어야 합니다.
- 두 파일은 호출자 또는 root 소유이고 group/world write bit가 없어야 합니다.
- executable에는 execute bit가 하나 이상 있어야 합니다.
- working directory는 non-symlink 디렉터리이며 group/world-writable이면 안 됩니다.
- 기존 경로 구성요소에는 symlink, `.`, `..`, group/world-writable 디렉터리가
  없어야 합니다.
- runtime state 부모는 이미 존재하는 호출 UID 소유 mode `0700` 디렉터리여야
  합니다.

`/tmp`, `/var/tmp` 아래 경로는 이 규칙상 부적합합니다. `$HOME/.config/idlepilot`,
`$HOME/.local/lib/idlepilot`, `$HOME/.local/share/idlepilot`,
`$HOME/.local/state/idlepilot`처럼 본인만 접근 가능한 경로를 권장합니다.

CLI `status`/`stop`은 같은 안전한 config parsing과 정책/state 검증을 사용하되,
이미 실행 중인 daemon을 제어할 수 있도록 executable과 working directory의 현재
존재 여부는 요구하지 않습니다.

`Config::load_secure`, `Config::load_for_control`과 CLI `validate`, `check`, `plan`,
`doctor`, `status`는 없는 state 부모나 state 파일을 만들지 않습니다. 조회만 했는데
filesystem이 바뀌지 않도록 생성 경로를 분리한 것입니다. 부모가 없으면 먼저
`init`을 사용하거나 명시적으로 mode `0700`으로 만드세요. 명시적 supervisor
실행용 `Config::load_for_run`/CLI `run`만 설정된 사설 state 부모 chain을 만들 수
있습니다. `stop`은 디렉터리를 만들지는 않지만 살아 있는 daemon에 signal을 보낼
수 있으므로 순수 조회 명령은 아닙니다.

제공 systemd unit은 private `/tmp`/`/var/tmp`, state와 전용 work/runtime 경로
외의 filesystem을 읽기 전용으로 만듭니다. action이 다른 곳에 써야 한다면
정확한 절대 경로를 drop-in의 `ReadWritePaths=`로 추가해야 합니다.

## 생성과 검증

`init`은 필요한 기본 키를 모두 만들고 현재 실행 파일 SHA-256을 pin합니다. config와
state의 없는 부모 경로는 각각 mode `0700`으로 생성합니다. 이미 존재하는 각각의
최종 부모는 호출 UID 소유, mode `0700`, non-symlink 디렉터리여야 합니다.

```sh
idlepilot init \
  --config /absolute/config.conf \
  --name nightly-task \
  --executable /absolute/reviewed-artifact \
  --working-directory /absolute/work \
  --state-file /absolute/state/nightly-task.state \
  --arg --mode \
  --arg incremental \
  --env OUTPUT_LABEL=household \
  --window 23:00-05:00 \
  --wifi any \
  --power auto \
  --idle logind-seat:seat0
idlepilot validate --config /absolute/config.conf
idlepilot check --config /absolute/config.conf
idlepilot plan --config /absolute/config.conf
```

`init`의 `--name` 기본값은 `nightly-task`이고 `--working-directory`를 생략하면
executable의 부모 디렉터리를 사용합니다. 다음 option을 생성 시점에 받을 수 있습니다.

- 반복: `--arg VALUE`, `--env KEY=value`
- 정책: `--window`, `--wifi`, `--power`, `--idle`
- 시간: `--poll-seconds`, `--guard-milliseconds`,
  `--start-stability-seconds`, `--idle-seconds`, `--stop-grace-seconds`
- 제한: `--max-runtime-seconds` 또는 `--no-runtime-limit`,
  `--max-attempts-per-window`
- 재시도: `--retry-on-failure`, `--no-retry-after-guard-loss`

별도 flag를 주지 않으면 `Config::new`의 보수적인 기본값을 사용합니다.
`--retry-on-failure` 기본은 false이고 `--no-retry-after-guard-loss`를 주지 않으면
guard 상실 뒤 재시도 정책은 true입니다. runtime 기본은 14400초이며
`--no-runtime-limit`과 `--max-runtime-seconds`는 함께 쓸 수 없습니다. 생성기는 모든
문자열을 quote/escape하고 argv 순서를 유지하며 환경 키를 정렬한 canonical config를
mode `0600`으로 create-new합니다.

라이브러리도 같은 writer를 제공합니다. `Config::new`로 기본값을 만들고 public
field를 조정한 뒤 `to_canonical_text()`로 결정적 텍스트를 얻거나,
`store_new_secure()`로 경로와 정책을 검증하고 부모를 만든 뒤 create-new할 수
있습니다. `WifiPolicy`, `PowerPolicy`, `IdleMode`, `TimeWindow`에는
`parse`/`canonical` API가 있고 `state_fingerprint()`는 state binding과 같은 digest를
계산합니다. `load_for_run()`은 explicit supervisor run을 위해 state 부모만 생성할
수 있습니다. `Config::validate()`와 `to_canonical_text()`는 파일을 저장하지 않습니다.

`validate` warning은 명시적으로 약화한
조건과 SHA pin 누락을 알려줍니다. `validate`는 digest의 형식은 검사하지만 현재
파일 내용을 다시 hash해 pin과 비교하지는 않습니다. launch 때는 반드시
비교하며, 배포 시 미리 확인하려면 `digest --file` 결과를 대조하거나 artifact와
state까지 함께 검사하는 `plan`을 사용하세요. `check` JSON의 각 `*_reason`이 실제
장비의 차단 원인을 설명합니다.
