# 에이전트 인터페이스

## 원칙

에이전트는 idlepilot을 로컬 subprocess로 호출하고 stdout의 JSON/JSON Lines와
exit status를 읽습니다. 기본 출력이 machine format이며 `--json`을 명시해도 같은
결과입니다. Unix socket, HTTP server, D-Bus control API는 제공하지 않습니다.

실행 대상은 config에만 존재합니다. `run`, `status`, `stop`에는 executable 또는
command 문자열을 전달할 수 없고, 모든 `--config`, `--file`, `--source`,
`--artifact-dir` 값은 절대 경로여야 합니다. 에이전트가 config를 작성/변경할 수
있는 권한 자체는 실행 UID 권한과 동일하므로 별도의 승인 경계가 필요합니다.

machine schema version은 최상위 `api_version: 1`입니다.

```sh
idlepilot schema --json
```

현재 응답은 지원 command, run mode, condition state, plan decision,
`config_schema_version:1`, `state_schema_version:2`와 함께
`shell_execution:false`, `arbitrary_exec_over_control_interface:false`를 선언합니다.

## 출력 규칙

- `run`은 이벤트 하나당 JSON object 한 줄인 JSONL입니다.
- 그 밖의 command는 성공 시 JSON object 한 줄입니다. `doctor`만 관찰 주기마다
  snapshot 한 줄을 출력합니다.
- 일반 오류는 기본 mode에서 stdout에 JSON object 한 줄로 출력되고 non-zero로
  끝납니다. 단, `Error::requires_process_exit()`인 terminal uncertainty는 full
  pipe/journal이 process 종료와 cgroup cleanup을 막지 않도록 JSON과 human 오류를
  모두 출력하지 않고 exit code만 반환합니다.
- `--human`은 사람이 읽는 간단한 텍스트로 바꾸므로 자동화에서는 쓰지 마세요.
- stdout/stderr가 action과 섞이지 않습니다. action의 표준 입출력은 null입니다.
- 단일-object command와 `doctor` snapshot writer는 stdout consumer가 먼저 닫아
  `BrokenPipe`가 나도 panic/error JSON을 만들지 않습니다. 원래 command의
  의사결정/side effect와 exit status는 그대로 진행됩니다. 반면 `run`의 JSONL
  `EventSink` write 실패는 OS 오류로 감독기를 끝내므로 `run` stdout은 끝까지
  drain하고 `head`처럼 조기 종료하는 pipe에 연결하지 마세요.

JSON parser는 object key 순서에 의존하지 말고 모르는 field를 무시해야 합니다.
의미를 바꾸는 schema upgrade는 `api_version`을 올리는 방식으로 다뤄야 합니다.

## command

### 식별과 schema

```sh
idlepilot version
idlepilot schema
idlepilot help
```

`version` 예:

```json
{"api_version":1,"name":"idlepilot","version":"0.1.0"}
```

### 설정 생성

```sh
idlepilot init \
  --config /absolute/task.conf \
  --executable /absolute/artifact \
  --state-file /absolute/task.state \
  [--name SAFE_ID] \
  [--working-directory /absolute/work] \
  [--arg VALUE ...] [--env KEY=value ...] \
  [--window HH:MM-HH:MM] \
  [--poll-seconds N] [--guard-milliseconds N] \
  [--start-stability-seconds N] [--idle-seconds N] \
  [--wifi POLICY] [--power POLICY] [--idle POLICY] \
  [--stop-grace-seconds N] \
  [--max-runtime-seconds N | --no-runtime-limit] \
  [--max-attempts-per-window N] [--retry-on-failure] \
  [--no-retry-after-guard-loss]
```

config를 mode `0600`으로 create-new합니다. 기존 파일은 덮어쓰지 않습니다. 기본
name은 `nightly-task`, 기본 working directory는 executable의 부모입니다. 성공
응답에는 `status:"created"`, config 경로와 계산한 `executable_sha256`가 있습니다.
없는 config/state 부모 경로는 mode `0700`으로 생성합니다. 이미 존재하는 각 최종
부모는 현재 호출 UID 소유, mode `0700`, non-symlink 디렉터리여야 합니다.
`--arg` 순서는 유지되고 `--env` 중복 키는 거부됩니다. 나머지 범위와 기본값은
[설정 레퍼런스](CONFIGURATION.md)와 같으며 결과는 결정적인 canonical config입니다.

### 정적/동적 검증

```sh
idlepilot validate --config /absolute/task.conf
idlepilot check --config /absolute/task.conf
idlepilot doctor --config /absolute/task.conf [--watch-seconds 30]
```

`validate` 성공 응답:

```json
{"api_version":1,"status":"valid","name":"nightly-task","warnings":[]}
```

`validate`는 SHA pin의 형식과 파일 경로/권한을 검사하지만 executable 내용을
다시 hash해 pin과 비교하지 않습니다. 실제 launch는 항상 pin을 비교합니다.
배포 승인 단계에서 즉시 비교하려면 `digest --file`을 별도로 호출하세요.

`check`와 `doctor` snapshot은 다음 shape입니다.

```json
{
  "api_version": 1,
  "status": "blocked",
  "eligible": false,
  "wifi": "met",
  "wifi_reason": "wifi_carrier_online",
  "power": "met",
  "power_reason": "external_power_online",
  "idle": "not_met",
  "idle_reason": "user_active",
  "window": "met",
  "window_reason": "inside_window"
}
```

condition state는 `met`, `not_met`, `unknown` 중 하나입니다. `eligible`은 네 값이
모두 `met`일 때만 true입니다. `doctor`의 watch 범위는 1..3600초, 기본 30초이며
대략 1초마다 snapshot을 내고 한 번이라도 eligible이면 0으로 끝납니다.

### launch plan

```sh
idlepilot plan --config /absolute/task.conf
```

`plan`은 config, 현재 네 조건, executable digest, 영속 state, daemon/action PID
identity를 한 번에 읽되 lock을 잡거나 state/디렉터리를 만들거나 launch-intent를
예약하지 않습니다. 예:

```json
{
  "api_version": 1,
  "status": "ready",
  "name": "nightly-task",
  "decision": "ready",
  "reason": "ready",
  "would_launch": true,
  "attention_required": false,
  "artifact": "verified",
  "state_phase": "stopped",
  "daemon_alive": false,
  "attempts": 0,
  "max_attempts": 3,
  "window_key": "2026-212@01:00-06:00",
  "wifi": "met",
  "wifi_reason": "wifi_carrier_online",
  "power": "met",
  "power_reason": "external_power_online",
  "idle": "met",
  "idle_reason": "idle_minimum_met",
  "window": "met",
  "window_reason": "inside_window",
  "warnings": []
}
```

안정된 `decision`과 exit는 다음과 같습니다.

| decision | 의미 | exit |
|---|---|---:|
| `ready` | 현재 snapshot에서 launch 후보 | 0 |
| `conditions_blocked` | 조건 하나 이상 false/unknown | 3 |
| `daemon_running` | 기록된 daemon identity가 살아 있음 | 3 |
| `already_completed` | 현재/더 오래된 window가 terminal 완료됨 | 3 |
| `attempts_exhausted` | 현재 window 시도 한도 소진 | 3 |
| `artifact_mismatch` | executable digest pin 불일치 | 5 |
| `recovery_required` | unresolved intent, persisted fault 또는 daemon 없는 action identity 검토 필요 | 5 |
| `invalid_snapshot` | eligible snapshot에 유효 window key가 없음 | 5 |

exit 5인 세 결정은 `status:"attention"`, `attention_required:true`입니다. 나머지
비실행 결정은 `status:"blocked"`입니다. `artifact`는 `verified`, `unpinned`,
`mismatch` 중 하나이며 unpinned는 warning이지만 자체로 launch를 막지는 않습니다.
`ready`는 예약이나 TOCTOU 보증이 아닙니다. `run`은 instance lock, digest와 최종
guard를 다시 확인합니다.

daemon identity가 살아 있으면 `daemon_running`이 우선합니다. 그렇지 않은
`phase=fault` 또는 action identity가 하나라도 남은 state는
`recovery_required`입니다. action leader가 죽고 PGID가 비었어도 terminal 결과나
외부 부작용이 durable하게 확정됐다는 뜻은 아니므로 자동으로 ready로 바꾸지
않습니다.

### 실행

```sh
idlepilot run --config /absolute/task.conf
idlepilot run --config /absolute/task.conf --once
```

daemon mode는 SIGINT/SIGTERM, 오류, live guard 상실 또는 runtime limit까지
기다립니다. guard/runtime 중지는 각각 exit 7/8로 supervisor도 끝납니다. 제공
systemd unit은 이 두 결과에서 cgroup 정리를 거친 뒤 새 supervisor를 시작합니다.
`--once`는 현재 eligibility를 결정하고 durable launch-intent를 최대 한 번 예약한
뒤, 실제 spawn이 이루어지면 action의 종료 또는 중지까지 동기적으로 감독합니다.
intent 저장 뒤 마지막 guard 변화, 종료 signal 또는 crash가 발생하면 exec 없이도
attempt 하나가 소비될 수 있습니다.

이전 daemon이 intent 저장 뒤 정상 final-state 없이 죽어서 state가
`phase=qualifying`, `last_reason=launch_intent_persisted`, daemon identity 있음,
action identity 없음으로 남으면 다음 `run`은 security 오류로 시작을 거부합니다.
이는 이전 action이 실제 exec했을 가능성을 배제할 수 없는 direct/embedded crash
중복 실행 방지 fence입니다. 같은 config를 자동 retry하지 말고 cgroup/process
cleanup을 검증하고 state를 보존 이름으로 회전한 뒤에만 재시작해야 합니다.

JSONL 이벤트의 공통 field:

```json
{
  "api_version": 1,
  "sequence": 4,
  "event": "conditions",
  "phase": "qualifying",
  "reason": "all_conditions_met",
  "name": "nightly-task",
  "window_key": "2026-212@01:00-06:00",
  "action_pid": null,
  "action_pgid": null,
  "exit_code": null,
  "exit_signal": null,
  "eligible": true,
  "wifi": "met",
  "wifi_reason": "wifi_carrier_online",
  "power": "met",
  "power_reason": "external_power_online",
  "idle": "met",
  "idle_reason": "idle_minimum_met",
  "window": "met",
  "window_reason": "inside_window",
  "observed_monotonic_ms": 15321
}
```

`name`은 모든 이벤트에 있습니다. `conditions` 이벤트의 `window_key`는 그
snapshot에서 관측한 로컬 window를 나타내며, 허용 시간 밖이거나 로컬 시각을 읽지
못했으면 null입니다. lifecycle 이벤트에는 supervisor가 추적 중인 scheduling
window key가 들어갑니다.
`wifi`~`observed_monotonic_ms`는 condition snapshot이 붙는 `conditions` 이벤트에만
나옵니다. 그 밖의 이벤트에는 `eligible:null`이 있고 condition field는 없습니다.

안정된 `event` 값:

- `initialized`
- `conditions`
- `phase`
- `action_started`
- `action_exited`
- `action_stopping`
- `action_stopped`
- `shutdown`
- `fault`

안정된 `phase` 값은 `stopped`, `waiting`, `qualifying`, `running`, `stopping`,
`completed`, `fault`입니다. `reason`은 의사결정과 probe의 bounded snake-case
reason code입니다. 자유 형식 로그 메시지처럼 parse하지 말고 분류값으로
취급하세요.

이벤트의 `sequence`는 daemon process 안에서 1부터 단조 증가하며 재시작하면
초기화됩니다. `action_pid`/`action_pgid`는 관찰용 값이지 에이전트가 직접 signal할
권한을 부여하는 capability가 아닙니다.

안전을 위해 action이 살아 있는 동안 반복 eligible condition 이벤트는 출력하지
않고 중요한 이벤트는 메모리에 보류했다가 action stop/reap 뒤 flush합니다. 따라서
`action_started`를 포함한 이벤트가 실시간으로 도착한다고 가정하지 마세요. 128개
보류 한도를 넘는 비정상 burst에는 sequence gap이 생길 수 있습니다. consumer는
여전히 pipe를 계속 drain해야 다음 scheduling 진행을 막지 않습니다. 여러
instance를 합칠 때는 JSON의 `name`/`window_key`와 user-unit 이름을 함께 label로
사용하세요.

### 상태와 정지

```sh
idlepilot status --config /absolute/task.conf
idlepilot stop --config /absolute/task.conf [--wait-seconds 15]
```

`status` 응답은 `status`(`running`/`stopped`), `phase`, `daemon_alive`,
`name`, `action_status`, `action_alive`, `attention_required`, `attempts`,
`max_attempts`, nullable `window_key`, `completed_window`, `attempt_window`,
`last_reason`, `daemon_pid`, `action_pid`, `action_pgid`, `last_exit_code`,
`last_exit_signal`, 그리고 `updated_unix_seconds`를 제공합니다. daemon PID와 저장된
`/proc` start ticks가 일치할 때만 alive로 봅니다. `attempts`는 실제 exec 횟수가
아니라 spawn 전에 영속 예약된 launch-intent 횟수입니다. 이 command는 유효한
상태를 읽었다면 stopped거나 `attention_required:true`여도 exit 0입니다.

`action_status`는 `none`, `recorded_process_running`, `terminal_result_unknown`,
`descendant_group_running`, `pid_reused`, `identity_incomplete`,
`launch_intent_unresolved` 중 하나입니다. `terminal_result_unknown`은 기록된 leader와
group이 모두 사라졌지만 durable terminal 결과가 없다는 뜻입니다. 프로세스 부재만
보고 성공/실패나 외부 부작용 부재를 추론하면 안 됩니다.

`terminal_result_unknown`, `descendant_group_running`, `pid_reused`,
`identity_incomplete`, `launch_intent_unresolved`는 항상 attention 대상입니다.
`recorded_process_running`도 owning daemon이 살아 있지 않으면 attention 대상이며,
persisted `phase=fault`는 `action_status:"none"`이어도 attention 대상입니다. PID/PGID
field는 signal capability가 아닙니다.

`stop`은 numeric PID에 대한 pidfd를 먼저 열고 저장된 `/proc` start ticks를
재확인한 뒤 그 동일한 pidfd에만 SIGTERM을 보내며, pidfd poll로 unreaped zombie를
포함한 종료를 기다립니다. daemon이 없으면 성공한 no-op입니다. pidfd syscall이
없는 Linux/architecture에서는 race-prone `kill(pid)`로 fallback하지 않고 security
오류입니다. `plan`과 `run`도 pidfd 지원을 preflight하고 spawn 직후 child pidfd를
열어, unreaped leader로 PGID를 예약한 상태에서 자손 정리를 끝냅니다.
지원 범위는 Linux 5.3 이상의 x86_64/aarch64입니다. `--wait-seconds`는 1..60,
기본 15입니다. action의 `stop_grace_seconds`가 길면 CLI timeout이 먼저 날 수
있지만 daemon은 이미 정지 절차를 수행 중일 수 있으므로 다시 `status`를
확인하세요.

두 command는 config의 정책과 안전한 state 경로를 검증하되 runtime
executable/work-directory의 존재에는 의존하지 않으므로 action artifact가 시작
뒤 사라져도 control plane을 유지합니다. config/state 자체가 손상된 systemd
instance는 PID를 직접 사용하지 말고 user unit을 stop하세요.

`validate`, `check`, `plan`, `doctor`, `status`, `digest`는 없는 부모나 state를
암묵적으로 만들지 않습니다. config가 가리키는 state 부모는 조회 전에 이미 UID
소유 mode `0700`이어야 합니다. `stop`도 디렉터리를 만들지는 않지만 검증된 daemon에
signal을 보낼 수 있습니다. explicit `run`은 필요한 경우 설정된 private state 부모
chain을 만든 뒤 state/lock을 갱신합니다.

영속 state schema v2의 fingerprint preimage는 canonical config UTF-8 출력에서
`#`로 시작하는 행을 제거하고 나머지 각 행을 `\n`으로 끝낸 바이트열입니다.
초기화 뒤 config 의미가 바뀌었거나 다른 config가 같은 state를 가리키면 `plan`,
`status`, `stop`, `run`은 security exit 5로 거부합니다. 자동 migration은 없으므로
service/cgroup/process가 완전히 정리된 것을 확인하고 기존 state를 보존 이름으로
회전한 뒤 새 state를 시작해야 합니다. schema v1 state도 같은 절차가 필요합니다.
persisted fault, unresolved intent, `terminal_result_unknown`도 새 `run` startup에서
거부되므로 process/cgroup과 작업 부작용을 검토하고 원본 state를 보존·회전해야
합니다.

### digest와 artifact import

```sh
idlepilot digest --file /absolute/reviewed-file
idlepilot import --source /absolute/reviewed-file \
  --artifact-dir /absolute/private-artifact-dir
```

`digest`는 최대 512 MiB의 안전한 regular input을 검사한 뒤 `sha256`를
반환합니다. `import`는 private directory에 SHA-256 이름의 mode `0500` artifact를
원자적으로 배치하고 다음 field를 반환합니다.

```json
{
  "api_version": 1,
  "status": "imported",
  "sha256": "...",
  "path": "/absolute/private-artifact-dir/...",
  "size": 1234,
  "already_present": false
}
```

## exit status

| 코드 | 의미 |
|---:|---|
| 0 | 성공, action 완료 또는 이미 완료된 window |
| 2 | CLI 사용법 또는 config 오류 |
| 3 | 조건 미충족/unknown, `doctor`에서 eligible 관찰 없음, plan 비실행 결정, 시도 소진 |
| 4 | condition probe 오류 분류 |
| 5 | 보안 불변식 위반, plan attention 결정, unresolved intent, unknown terminal result 또는 persisted fault startup fence |
| 6 | process 시작/감독 오류 또는 action 실패 |
| 7 | live guard 상실로 action 즉시 중지 및 supervisor 종료 |
| 8 | runtime limit으로 action 중지 및 supervisor 종료 |
| 70 | state/OS/internal 오류 |
| 130 | SIGINT에 의한 supervisor 종료 |
| 143 | SIGTERM에 의한 supervisor 종료 |

`run` daemon mode에서 조건이 현재 false인 것은 오류가 아니며 계속 대기합니다.
`check`/`doctor`/`run --once`에서는 자동화가 명확히 분기하도록 3을 사용합니다.

일반 오류 JSON shape:

```json
{
  "api_version": 1,
  "status": "error",
  "error": {
    "kind": "security",
    "message": "human-readable bounded context"
  }
}
```

`kind`는 `usage`, `config`, `probe`, `process`, `state`, `security`, `os`,
`internal` 중 하나입니다. message 문자열 비교 대신 kind와 exit status를 우선
사용하세요. 라이브러리의 `Error::requires_process_exit()`가 `true`인 오류에는 이
JSON이 없습니다. CLI consumer는 action 실행 뒤 JSONL EOF와 non-zero exit가
오더라도 마지막 오류 object가 반드시 존재한다고 가정하면 안 됩니다.

## 에이전트 통합 권장사항

- 시작 전에 `schema`의 `api_version`을 확인합니다.
- config 생성/변경은 별도 승인 단계로 두고, 반복 운용에는 `validate`, `check`,
  `plan`, `status`, `run`, `stop`만 허용합니다. 변경 승인에는 state fingerprint
  migration과 중복 부작용 검토를 포함합니다.
- command마다 절대 config 경로 allowlist를 적용합니다.
- `run` stdout은 line-buffered JSONL로 읽어 pipe backpressure를 만들지 않습니다.
- action exit/stop 뒤 terminal 또는 retry state는 deferred event보다 먼저 영속됩니다.
  그 뒤 sink가 실패하면 state는 `fault` fence로 남으므로 자동 재실행하지 말고
  status/state와 작업 부작용을 함께 검토합니다.
- condition `unknown`을 `not_met`보다 약하게 취급하지 않습니다.
- PID/PGID를 직접 kill하지 말고 `stop` 또는 systemd unit stop을 사용합니다.
- 동일 `state_file`을 사용하는 daemon은 하나만 실행합니다. lock 오류 때 새
  인스턴스를 반복 생성하지 않습니다.
- `running` state 저장 deadline 또는 process-group cleanup 불확실 오류가 나면
  `requires_process_exit()`가 `true`이고 후속 event/final-state와 CLI 오류 JSON이
  의도적으로 없습니다. embedded agent host도 blocking log/flush/cleanup 없이
  해당 process를 즉시 종료해야 하며, 새 supervisor는 systemd cgroup cleanup과
  이전 process 종료 뒤에만 시작합니다.
- unresolved launch-intent, `terminal_result_unknown`, persisted fault security
  오류는 `requires_process_exit()`가 `false`인 startup fence라 일반 오류 JSON이
  나옵니다. 자동 restart하지 말고 이전 cgroup/process cleanup, 작업 결과와
  부작용을 검토하고 state 원본을 보존·회전합니다.
- journal이나 이벤트에 action argv/env/output이 없다는 점을 전제로 별도 action
  로그 정책을 설계합니다.
