# 아키텍처

## 목표와 범위

idlepilot의 핵심 책임은 “조건이 확인된 동안에만 한 개의 검토된 실행 파일과 그
자손을 감독한다”입니다. 스케줄러, 조건 어댑터, 프로세스 실행기, 영속 상태를
작게 분리했고, CLI는 이 라이브러리 위에 얇게 놓입니다. 네트워크 서비스나 GUI는
없습니다.

지원 범위는 pidfd가 있는 Linux 5.3 이상의 64-bit
GNU/Linux(x86_64/aarch64)입니다. 시스템 조건 구현은 `/sys`의 network,
power-supply, DMI chassis 정보, `/proc`, `systemd-logind`의 `loginctl`에
의존합니다. Rust 표준 라이브러리 외의 Cargo 런타임 의존성은 없습니다. CI의
실행 검증은 x86_64 GNU/Linux이고 aarch64 GNU는 compile-check만 합니다. native
release의 glibc ABI 하한은 build host에 의해 결정되며 musl은 검증하지 않습니다.

## 구성요소

```text
config file (0600)          /sys + /proc + loginctl
        |                              |
        v                              v
  Config::load_secure            LinuxProbe
        |                              |
        +----------> Supervisor <------+----> JSONL EventSink
        |                    ^
        +--> LaunchPlan -----+ (read-only preview; no reservation)
                           |
                           +----> PersistentState + flock
                           |
                           +----> ActionProcess
                                      |
                                      +--> executable + literal argv
                                           (dedicated process group)
```

- `config`: 엄격한 v1 키/값 파서입니다. 알 수 없는 키와 단일 키의 중복을
  거부하고, `arg`와 `env`만 반복을 허용합니다. `Config::new`와 canonical writer는
  CLI `init`과 library-created config에 같은 결정적 형식을 사용합니다.
- `security`: UID, 소유권/권한, 비심볼릭 링크 경로, PID 시작 시각, 안전한
  프로세스 그룹을 확인합니다. root와 setuid 실행을 거부합니다.
- `conditions`: 네 가지 조건을 `met`, `not_met`, `unknown`으로 평가합니다.
  `Probe` trait을 통해 테스트나 다른 라이브러리 사용자가 완전한 snapshot 공급자를
  주입할 수 있습니다.
- `clock`: 로컬 민간시와 단조 시간을 분리하고, 자정을 넘는 시간대에도 하나의
  안정된 window key를 계산합니다.
- `process`: 셸 없이 실행 파일과 리터럴 argv를 시작합니다. 환경을 비운 뒤 제한된
  기본값과 명시한 `env`만 전달하고, 전용 프로세스 그룹을 감독합니다.
- `state`: 상태 파일을 같은 디렉터리의 임시 파일에 동기화한 뒤 원자적으로
  rename합니다. v2 state를 canonical config fingerprint에 binding하고 인접한
  `.lock` 파일의 비차단 `flock`으로 중복 daemon을 막습니다.
- `planning`: config, 조건 snapshot, artifact digest, state와 process identity를
  합쳐 안정된 `PlanDecision`을 만들지만 lock이나 launch-intent를 만들지 않습니다.
- `supervisor`: 조건 관찰, 안정화, 실행, live guard, 재시도와 once-per-window
  정책을 결합합니다.
- `artifact`: 검토한 실행 파일을 SHA-256 이름의 mode `0500` 파일로 사설
  디렉터리에 가져옵니다.
- `json`: CLI와 이벤트를 위한 결정적 JSON 인코더입니다.

공개 라이브러리 진입점은 `Config`, 정책 타입, `LaunchPlan`, `PlanDecision`,
`Probe`, `Supervisor`, `RunMode`, `EventSink`, `ActionProcess` 및
조건/이벤트/결과 타입입니다. 기본 Linux 감지 대신 별도의
`Probe`를 구현할 수 있지만, snapshot의 네 조건이 모두 `met`이어야 한다는
fail-closed 결합 규칙은 `Supervisor`가 유지합니다.

`Config::new`는 보수적인 household 기본값을 주고 public field를 조정할 수 있게
합니다. 정책 타입의 `parse`/`canonical`과 `Config::to_canonical_text`는 CLI와 같은
텍스트를 만들며 argv 순서를 보존하고 environment를 key 순으로 정렬합니다.
`state_fingerprint`는 canonical UTF-8 출력의 `#` 행을 제거하고 남은 각 행에
`\n`을 붙인 정확한 바이트열의 SHA-256이고 `store_new_secure`는 검증 뒤
config/state 부모와 config 파일을 생성합니다. explicit supervisor 경로인
`load_for_run`은 설정된 state 부모만 생성할 수 있습니다. `validate`,
`load_secure`, `load_for_control`, `LaunchPlan::inspect`는 디렉터리나 state를
암묵적으로 만들지 않습니다.

저수준 `ActionProcess` 사용자는 명시적으로 `stop()`을 호출하고 반환된
`StopOutcome::group_empty`를 확인해야 합니다. `Drop`은 누락된 cleanup을 위한
best-effort 안전망일 뿐 성공 증명이 아닙니다. destructor는 bounded `stop()` 뒤에도
정리가 불확실하면 마지막 group/leader kill과 nonblocking `try_wait()`만 수행하며,
D-state leader 때문에 host를 무기한 기다리지 않습니다. `stop()` 오류 또는
`group_empty=false`이면 호출 process 종료와 외부 cgroup cleanup이 필요한 terminal
uncertainty로 취급하세요.

CLI와 같은 기본 조합을 embedding할 때의 최소 형태는 다음과 같습니다.

```rust
use idlepilot::conditions::LinuxProbe;
use idlepilot::supervisor::{JsonLineSink, RunMode, Supervisor};
use idlepilot::{security, Config, Result};
use std::path::Path;

fn run() -> Result<()> {
    let config = Config::load_secure(Path::new("/absolute/task.conf"))?;
    security::install_termination_handlers()?;
    let probe = LinuxProbe::system(config.clone());
    let sink = JsonLineSink::new(std::io::stdout().lock());
    let mut supervisor = Supervisor::new(config, probe, sink);
    match supervisor.run(RunMode::Daemon) {
        // Use a host-selected terminal code. Do not log or run cleanup here.
        Err(error) if error.requires_process_exit() => std::process::exit(70),
        result => {
            let _outcome = result?;
        }
    }
    Ok(())
}
```

`Supervisor::run`은 직접 구성한 `Config`도 다시 검증하지만 SIGINT/SIGTERM handler를
자동 설치하지는 않습니다. graceful signal 종료가 필요하면 위처럼 프로세스당
한 번 설치하세요. handler 상태는 프로세스 전역이므로 독립 supervisor 여러 개를
한 process에 넣기보다 각각 user service/process로 운영하는 편이 명확합니다.
사용자 정의 `Probe`가 eligible snapshot을 반환할 때는 설정 window와 일치하는
`local_time`도 반드시 제공해야 once-per-window key를 계산할 수 있습니다.

`running` 상태 저장 deadline 초과 또는 SIGKILL 뒤 process group이 비었다는 것을
증명하지 못한 오류는 `Error::requires_process_exit()`가 `true`인 terminal
fail-closed 결과입니다. 이 경우 구현은 후속 event/final state I/O를 생략하고
instance lock을 process가 끝날 때까지 유지합니다. embedding한 호출자는 blocking
log, flush, cleanup 또는 destructor 대기를 추가하지 말고 process를 즉시 종료해야
하며, 같은 process에서 supervisor를 다시 사용하거나 같은 state의 새 supervisor를
만들면 안 됩니다. CLI도 JSON/human 오류를 출력하지 않고 해당 `ErrorKind`의 exit
code만 반환합니다.

action이 살아 있는 동안에는 안전 경로에서 filesystem/event sink I/O를 기다리지
않습니다. spawn 전에 먼저 durable launch-intent를 동기 저장해 attempt를
예약합니다. spawn 뒤 PID/PGID가 포함된 `running` 상태 저장은 background writer로
넘기고, 감시는 저장과 병행합니다. writer의 유한 deadline은
`max(15초, guard interval)`입니다. 실패하면 action을 hard-stop하고, deadline을
넘기면 writer를 기다리지 않은 채 위의 terminal process-exit 경로로 들어갑니다.
반복되는 eligible condition 이벤트는 생략하며, 중요한 이벤트는 최대 128개까지
메모리에 보류했다가 action을 stop/reap한 뒤 순서대로 sink에 flush합니다. 따라서
terminal/retry state와 identity clear를 보류 event보다 먼저 durable store합니다.
그 뒤 sink가 실패하면 outer supervisor가 `fault`를 저장해 재시작을 fence합니다.
따라서 막힌 JSONL consumer가 live guard/kill을 지연시키지는 않지만, flush 이후 supervisor
진행은 막을 수 있고 한도를 넘는 비정상적인 event burst는 감사 이벤트 일부가
생략될 수 있습니다. custom `EventSink`는 여전히 빠르게 반환해야 합니다.
CLI의 단일-result/snapshot writer는 stdout `BrokenPipe`를 정상적인 consumer 종료로
처리해 panic하지 않지만, `run`의 `JsonLineSink` write 실패는 OS 오류로 supervisor를
끝냅니다. 따라서 run consumer는 stream을 끝까지 drain해야 합니다.

## 상태 전이

```text
stopped -> waiting -> qualifying -> running -> completed
              ^          |             |
              |          +-------------+  시작 전 안정성 상실
              +------------------------+  action 실패 후 재시도 허용

running -- guard 상실/runtime limit --> stopping --> stopped(exit 7/8)
                                                     |
                                  systemd cgroup cleanup + restart
                                                     |
                                               waiting/completed

어느 단계든 내부 불변식 위반 -> fault
SIGINT/SIGTERM -> stopped
```

실제 흐름은 다음과 같습니다.

1. 일반 사용자 여부와 pidfd 지원을 먼저 확인한 뒤 설정 경로, 단일 인스턴스 lock,
   이전 action 상태를 확인합니다. read-only `plan`도 같은 pidfd preflight를 합니다.
2. 전체 조건 snapshot을 얻습니다. 하나라도 `not_met` 또는 `unknown`이면
   `waiting`으로 남습니다.
3. `start_stability_seconds` 동안 `guard_milliseconds` 이하 간격으로 계속 참인지
   확인합니다.
4. action 준비가 pidfd kernel/architecture 지원을 다시 확인하고, 비용이 클 수
   있는 SHA-256과 inode identity를 먼저 준비한 뒤 snapshot을 다시
   확인한 뒤 `attempts`를 늘린 launch-intent를 영속 저장합니다. 마지막 snapshot과
   signal을 한 번 더 확인하고, 그 뒤 동기 event/state I/O 없이 action을
   시작합니다. 마지막 guard 변화, 종료 signal 또는 crash 때문에 exec까지 가지
   못하더라도 이미 예약한 attempt는 소비될 수 있습니다.
5. spawn 직후 child pidfd를 먼저 열고 executable identity, 전용 PGID와 start
   ticks를 다시 확인합니다.
   검증 실패 시 child를 kill하고 최대 2초 안에 leader reap과 소유가 확인된 process
   group의 emptiness를 모두 증명해야 일반 오류로 돌아갑니다. 증명하지 못하면
   `requires_process_exit()` terminal 무출력 경로로 들어갑니다. 이어 조건도 다시
   확인하여 fork/exec 사이의 변화 범위를 줄입니다.
6. 실행 중에는 `guard_milliseconds`마다 action 종료, runtime cap, 종료 신호,
   모든 조건과 background `running` state 저장 결과를 확인합니다. 저장 감시는
   action 감시를 멈추지 않으며 deadline은 `max(15초, guard interval)`입니다.
   sleep이나 조건 snapshot 동안 action이 끝났다면 pidfd로 reap 없이 관찰합니다.
   첫 stop signal 전에 이미 관찰된 exit만 `ActionExit`로 우선 기록합니다. stop을
   시작한 뒤 처음 보인 code 0은 TERM handler일 수 있어 원래 stop reason을
   유지합니다.
7. 조건이 깨지면 프로세스 그룹에 TERM을 보낸 직후 KILL하고 supervisor도
   종료합니다. runtime limit이나 supervisor 종료 신호에는
   `stop_grace_seconds`의 TERM 유예를 적용합니다. signal 전 자연 성공 종료 시 해당
   local window를 완료로 기록합니다. leader는 pidfd로 exit를 관찰한 뒤에도
   reap하지 않아 PGID 숫자를 예약하고, 5ms 간격의 연속 두 번 `/proc`
   group-member empty scan과 모든 group signal이 끝난 마지막에만 status를
   reap합니다.
8. 제공 systemd unit에서는 exit 7/8을 실패로 받아 cgroup 잔존자를 정리한 뒤 새
   supervisor를 시작합니다. 직접 실행한 daemon은 이 시점에 호출자에게
   돌아옵니다.
9. `running` state writer가 deadline을 넘기거나 process group 정리를 확정하지
   못하면 후속 event/final-state I/O를 건너뛰고 instance lock을 process 종료까지
   유지합니다. 반환된 error의 `requires_process_exit()`는 `true`입니다. CLI는
   막힌 pipe/journal이 종료를 지연시키지 않도록 오류 출력 없이 exit code만
   반환하고, systemd cgroup 정리가 잔존자 cleanup의 백스톱이 됩니다. embedded
   caller도 blocking log/cleanup 없이 즉시 process를 종료해야 합니다.

대기 중 재확인은 `poll_seconds` 간격(10~600초)이어서 설정으로 10분보다 늦출 수
없습니다. SIGINT/SIGTERM 응답성을 위해 내부 sleep은 최대 1초 단위로 나뉩니다.
실행 중 sleep은 최대 100ms 단위로 나뉘지만,
조건 snapshot 자체의 주기는 `guard_milliseconds`입니다. `loginctl` 질의 하나의
timeout도 250ms입니다. 기본 watchdog 한 회의 명목 예산은 최대 250ms 대기 +
최대 250ms logind 질의입니다. 다만 snapshot은 여러 조건을 순차 표본화하므로
이미 표본화한 조건이 그 직후 바뀌면 다음 회차에서 보일 수 있습니다. event sink,
state fsync는 live action 경로에서 기다리지 않지만, sysfs I/O, custom probe와 OS
scheduler 지연에는 별도 hard timeout이 없어 조건 변화부터 kill까지의 hard
real-time 보장은 아닙니다. 정상 Linux adapter에서의 watchdog 목표는 조건 변화부터
중단 요청까지 1초 이내입니다.

## 시간대와 once-per-window

`window`는 로컬 시간의 반개구간 `[start, end)`입니다. `23:00-03:00`처럼
자정을 넘으면 다음 날 00:00~02:59도 전날 시작한 같은 window key에 속합니다.
정상 성공, terminal 실패, runtime limit, 재시도 불가 guard 상실 또는 최대 시도
소진은 그 key를 완료 처리합니다. guard 상실 후 재시도를 허용한 경우에도 현재
supervisor는 종료하며, systemd가 시작한 다음 인스턴스가 남은 시도 횟수 안에서
조건을 다시 기다립니다. 재시작해도 상태 파일을 통해 terminal 완료된 window의
중복 실행을 피합니다.

시도 횟수의 단위는 실제 exec가 아니라 spawn 전에 영속 저장한 launch-intent입니다.
따라서 intent 저장 뒤 마지막 guard가 바뀌거나 종료 signal/crash가 발생하면 action이
실행되지 않았어도 해당 window의 attempt 하나가 소비될 수 있습니다. 이는 crash가
fork/exec 경계의 시도 기록을 지우지 못하게 하는 보수적인 at-most 정책입니다.

이전 daemon의 state가 `phase=qualifying`,
`last_reason=launch_intent_persisted`, daemon identity 있음, action identity 없음으로
남으면 다음 startup은 이를 unresolved launch intent로 거부합니다. intent 뒤 이전
process가 실제 exec했는지 증명할 수 없기 때문에 direct/embedded crash 뒤 action을
자동 재실행하지 않는 중복 실행 방지 fence입니다. 이 startup 오류 자체는 현재
process의 terminal uncertainty가 아니므로 `requires_process_exit()`는 `false`이고
일반 오류 출력이 가능합니다. 운영자는 이전 cgroup/process가 모두 정리됐음을
검증하고 원본 state를 보존 이름으로 회전한 뒤에만 새 state로 재시작해야 합니다.

DST가 시간을 건너뛰면 짧은 window가 전혀 열리지 않을 수 있고, 시간이 반복되면
같은 key로 처리되어 성공한 작업이 두 번 실행되지 않습니다. terminal
`completed_window`는 high-water mark로 비교하므로 더 새로운 날짜를 완료한 뒤
시각이 과거 key로 rollback되어도 다시 실행하지 않습니다. state v2의 config
fingerprint 때문에 같은 state 파일에서 `window`나 다른 canonical 정책을 바꾸면
아예 security 오류로 거부됩니다. 정책 migration은 supervisor/cgroup을 멈춘 뒤
기존 state를 보존·회전하고 중복 실행 가능성을 검토하는 명시적 절차입니다.

## 실행 경계

action은 다음 속성으로 시작됩니다.

- `Command::new(executable)`과 리터럴 `.args(...)`; 셸 평가 없음
- 빈 상속 환경 뒤 `PATH=/usr/bin:/bin`, `LANG=C.UTF-8`, 검증된 명시 환경
- stdin/stdout/stderr 모두 null
- 새 POSIX 프로세스 그룹
- `no_new_privs`, core dump limit 0, umask `0077`
- 실행 전 SHA-256 pin 확인(설정한 경우)과 실행 전후 inode metadata 비교

이 경계는 컨테이너가 아닙니다. 같은 UID와 의도적으로 프로세스 그룹을 탈출하는
코드에 관한 제약은 [보안 문서](SECURITY.md)를 참고하세요.

## 영속성과 충돌 처리

상태와 lock은 action별 `state_file` 주변에 위치합니다. state 파일은 mode `0600`,
소유 UID 일치, link count 1, 일반 비심볼릭 링크 파일이어야 합니다. daemon PID와
`/proc/<pid>/stat`의 start ticks를 함께 저장합니다. `stop`은 numeric PID의 pidfd를
먼저 열고 ticks를 대조한 다음 그 동일한 kernel handle에 `pidfd_send_signal`하며,
pidfd poll로 exit/zombie를 확인합니다. action도 spawn 전 pidfd 지원을 preflight하고
child pidfd를 수명 내내 소유합니다. 종료된 leader는 다른 group member가 없음을
`/proc`에서 연속 두 번 확인할 때까지 reap하지 않으므로 negative-PGID signal 뒤
숫자 재사용 대상이 바뀌지 않습니다. pidfd가 없으면 숫자 PID signal로 fallback하지
않습니다.

영속 schema v2는 16개 키를 빠짐없이 canonical 순서로 저장하며
`config_fingerprint`로 config schema v1 canonical 출력의 comment 제외 의미 행에
결합됩니다. 각 유지 행은 UTF-8 `\n`으로 끝나는 것이 fingerprint preimage의
일부입니다.
semantic validation은 nonzero `attempts`에 `attempt_window`가 반드시 존재하고,
exit code와 signal이 동시에 기록되지 않는 것도 강제합니다. 손상된 canonical
state로 시도 횟수를 0처럼 재해석하지 않고 plan/run 전에 거부합니다.
pristine state만 binding이 없을 수 있고 첫 정상 supervisor write에서 binding됩니다.
`run`, `plan`, `status`, `stop`은 mismatch를 signal/launch 전에 거부합니다. v1
state나 변경된 config를 자동 해석하지 않는 이유는 과거의 완료 high-water mark와
live identity가 어떤 새 정책에 속하는지 추측하지 않기 위해서입니다.

시작할 때 영속 상태가 여전히 살아 있는 이전 action leader를 가리키면 자동으로
인수하거나 죽이지 않고 오류로 멈춥니다. PID가 재사용되었거나 leader 없이 PGID
자손만 남은 흔적도 오류입니다. leader와 process group이 모두 사라진 경우에도 live
action 필드를 지우고 진행하지 않습니다. process 부재는 action의 terminal 결과나
외부 부작용이 durable state에 반영됐음을 증명하지 않으므로
`terminal_result_unknown` recovery로 거부합니다. systemd unit의 cgroup 정리는
비정상 종료 뒤 남은 자손에 대한 별도 운영 안전망일 뿐 결과 증명이 아닙니다.

action identity가 없더라도 위의 unresolved launch-intent 모양이면 자동 복구하지
않습니다. 이는 “실행 전 상태”로 추측해 다시 시작할 수 없는 의도적인 crash
fence입니다. cgroup/process cleanup 확인과 state 증거 보존·회전은 운영자의 명시적
복구 절차입니다.

`phase=fault`도 action identity 유무와 관계없이 terminal 의미를 추측하지 않습니다.
daemon이 살아 있지 않을 때 plan은 persisted fault 또는 action identity 하나라도
남은 state를 `recovery_required`로 분류하며, supervisor startup도 security 오류로
거부합니다.

## 확장 원칙

새 조건은 CLI에서 임의 명령을 받아 평가하지 말고, 제한된 입력과 reason code를
가진 `Probe` 구현으로 추가하는 것이 권장됩니다. 새 출력은 `EventSink`로 연결할
수 있습니다. 이벤트는 argv, 환경, SSID, IP, action 출력을 포함하지 않도록 기존
감사 경계를 유지해야 합니다.

## 현실 workflow 회귀 시험

통합 시험은 fixture 함수를 메모리 안에서만 호출하지 않고 별도 OS subprocess와
실제 임시 파일을 사용합니다. household backup scenario는 여러 파일의 digest
manifest, staging 뒤 원자 publish, once-per-window를 확인합니다. flaky index
scenario는 실패 결과 미공개, 정확히 한 번의 허용 retry와 성공 뒤 추가 launch
차단을 확인합니다. long-running index scenario는 3단 process tree가 같은 PGID에
있다가 runtime limit 뒤 모두 없어지고 heartbeat가 정지하는지 확인합니다.

이것은 포함된 협력 fixture와 로컬 test filesystem에서 state/프로세스 계약을
회귀 검증하는 범위입니다. 임의의 사용자 action, network filesystem의 rename
semantics, 실제 Wi-Fi/power/logind driver는 별도의 장비 인수 시험 대상입니다.
