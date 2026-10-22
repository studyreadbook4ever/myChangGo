# idlepilot

`idlepilot`은 Linux PC가 **허용된 로컬 시간대에 있고, 사용자가 유휴 상태이며,
필요한 Wi-Fi/외부 전원 조건이 확인된 동안에만** 검토된 작업을 실행하는
fail-closed 프로세스 감독기입니다. 조건을 확인할 수 없는 `unknown`도 실패로
취급합니다.

대기 중에는 기본 600초마다 늦게 확인하고, 실행 중에는 기본 250ms마다 모든
조건을 다시 확인합니다. 조건 하나라도 깨지면 작업 전용 프로세스 그룹에
`SIGTERM` 직후 `SIGKILL`까지 보내고 supervisor도 종료합니다. 제공 systemd
unit은 cgroup 잔존자를 정리한 뒤 supervisor를 다시 시작해 안전한 대기를
이어갑니다.

이 프로젝트는 다음을 의도적으로 하지 않습니다.

- 셸 명령 문자열을 해석하거나 `sh -c`를 호출하지 않습니다.
- 상태/제어 명령으로 임의 실행 파일을 주입하지 않습니다.
- root로 실행하지 않습니다.
- GUI, 웹 서버, 상주 RPC 소켓을 제공하지 않습니다.

Linux 전용이며, 런타임 Cargo 의존성이 없습니다. idlepilot이 직접 작성한
자료에는 별도의 이용 허락을 부여하지 않습니다. 공개 저장소에서 코드를 볼 수
있다는 사실만으로 복제, 수정, 재배포 권한이 생기지는 않습니다. 바이너리에
정적으로 링크되는 Rust 표준 라이브러리와 동적으로 연결되는 glibc/libgcc 같은
제3자 시스템 런타임에는 각자의 조건이 유지되며 자세한 고지는
[THIRD_PARTY.md](THIRD_PARTY.md)에 있습니다.

## 빠른 시작

Rust 1.85 이상으로 빌드합니다.

```sh
cargo build --locked --release
cargo test --locked --all-targets
```

현재 CI가 실제로 빌드·실행 시험하는 기준은 Ubuntu x86_64 GNU/Linux입니다.
`aarch64-unknown-linux-gnu`는 compile-check만 하며 실행·패키지 호환성을 보증하지
않습니다. native release archive는 빌드 host의 glibc와 시스템 라이브러리에
동적으로 연결되므로 더 오래된 배포판에서 동작한다고 가정하지 말고, 지원할 가장
오래된 배포 환경에서 빌드하거나 배포판별 패키지를 만드세요. musl은 검증 범위가
아닙니다.

action 실행 감시와 `idlepilot stop`은 PID 재사용 check/use 경쟁 없이 정확한
process만 제어하기 위해 Linux pidfd(`pidfd_open`, `pidfd_send_signal`, poll)를
요구합니다(Linux 5.3 이상, x86_64/aarch64). `plan`과 `run`은 pidfd 지원을
preflight합니다. syscall이나 지원 architecture가 없으면 숫자 PID `kill`로
fallback하지 않고 security 오류로 거부합니다.

작업과 상태를 둘 사설 디렉터리를 먼저 만듭니다. 보안 검증 때문에 `/tmp`처럼
경로 구성요소가 누구에게나 쓰기 가능한 위치는 사용할 수 없습니다.

```sh
install -d -m 0700 "$HOME/.config/idlepilot"
install -d -m 0700 "$HOME/.local/state/idlepilot"
install -d -m 0700 "$HOME/.local/share/idlepilot/work"
install -d -m 0700 "$HOME/.local/lib/idlepilot/artifacts"
```

실행할 파일은 절대 경로의 일반 파일이어야 하고, 본인 또는 root 소유이며,
그룹/다른 사용자에게 쓰기 가능하면 안 됩니다. 여러 단계가 필요한 경우 셸
문자열을 설정에 쓰는 대신, 고정된 인자를 받는 작은 실행 파일이나 검토된
shebang 스크립트 하나로 묶으세요. 그 파일은 daemonize, `setsid`, double-fork를
하지 않아야 합니다.

검토한 파일을 내용 주소 방식의 사설 저장소로 가져옵니다.

```sh
chmod 0700 "$HOME/src/my-night-job"
target/release/idlepilot import \
  --source "$HOME/src/my-night-job" \
  --artifact-dir "$HOME/.local/lib/idlepilot/artifacts"
```

기본 JSON 결과의 `path`를 아래 `--executable`에 사용합니다. `init`은 실행 파일의
SHA-256을 계산해 설정에 고정합니다. 없는 config/state 부모는 mode `0700`으로
만들며, 기존 최종 부모는 현재 사용자 소유 mode `0700`이어야 합니다.

```sh
target/release/idlepilot init \
  --config "$HOME/.config/idlepilot/nightly-task.conf" \
  --name nightly-task \
  --executable "$HOME/.local/lib/idlepilot/artifacts/<출력된-SHA-256>" \
  --working-directory "$HOME/.local/share/idlepilot/work" \
  --state-file "$HOME/.local/state/idlepilot/nightly-task.state"
```

설정 파일을 손으로 고치지 않고도 `init`에 `--arg`와 `--env KEY=value`를 여러 번
줄 수 있습니다. `--window`, `--poll-seconds`, `--guard-milliseconds`,
`--start-stability-seconds`, `--idle-seconds`, `--wifi`, `--power`, `--idle`,
`--stop-grace-seconds`, `--max-runtime-seconds`(또는 `--no-runtime-limit`),
`--max-attempts-per-window`, `--retry-on-failure`,
`--no-retry-after-guard-loss`도 생성 시점에 지정할 수 있습니다. 모든 값은
결정적인 canonical 형식으로 기록되며 `--arg`는 입력 순서를 보존하고 `--env`는
중복 키를 거부합니다.

생성된 파일의 반복 가능한 `arg`와 `env`, 시간대와 조건을 필요한 만큼 편집한
다음 권한과 실제 감지 결과를 확인합니다.

```sh
chmod 0600 "$HOME/.config/idlepilot/nightly-task.conf"
target/release/idlepilot validate \
  --config "$HOME/.config/idlepilot/nightly-task.conf"
target/release/idlepilot check \
  --config "$HOME/.config/idlepilot/nightly-task.conf"
target/release/idlepilot plan \
  --config "$HOME/.config/idlepilot/nightly-task.conf"
```

`check`는 모든 조건이 충족되면 0, 막혔거나 알 수 없으면 3을 반환합니다. 실제
launch 후보인지 artifact, 조건, daemon, 시도/완료 state까지 함께 설명하는 `plan`은
`ready`면 0, 정상적인 비실행 결정이면 3, 운영자 확인이 필요한 결정이면 5를
반환합니다. `plan`은 lock, state 또는 디렉터리를 만들지 않고 실제 launch 직전에는
모든 검사를 다시 수행합니다. 실제 작업을 최대 한 번 시험하려면 다음을 실행합니다.

```sh
target/release/idlepilot run \
  --config "$HOME/.config/idlepilot/nightly-task.conf" \
  --once
```

기본 출력은 단일 JSON 또는 `run`의 JSON Lines입니다. 사람이 빠르게 볼 때만
`--human`을 추가하세요.

시도 횟수는 실제 exec가 아니라 spawn 전에 영속 저장하는 launch-intent 기준입니다.
intent 뒤 마지막 조건 변화, 종료 signal 또는 crash 때문에 실행되지 않아도 해당
window의 attempt 하나가 소비될 수 있습니다.

영속 state schema는 v2이며 canonical config 출력에서 `#`로 시작하는 comment 행을
제거하고 나머지 각 행을 `\n`으로 끝낸 UTF-8 바이트의 SHA-256 fingerprint를
저장합니다. supervisor가 state를 한 번 초기화한 뒤 정책, argv, 환경, 실행 파일,
state 경로 등 config 의미를 바꾸면 같은 state를 읽거나 signal하지 않고 exit 5로
거부합니다. config 변경은 service와 action/cgroup이 완전히 멈춘 것을 확인한 뒤
기존 state를 증거/rollback용 이름으로 이동하고 새 state로 시작하는 migration으로
취급하세요. v1 state도 자동 변환하지 않습니다.

이전 daemon의 action identity가 state에 남아 있으면 PID leader가 이미 죽고 process
group도 비어 있더라도 자동으로 성공/실패를 추측하거나 identity를 지우지 않습니다.
프로세스가 사라졌다는 사실은 외부 부작용과 terminal 결과가 durable state에
반영됐음을 증명하지 않기 때문입니다. `status`는 이를
`action_status:"terminal_result_unknown"`, `attention_required:true`로 표시하고,
`plan`은 `recovery_required`(exit 5), 새 `run`은 startup security 오류로 거부합니다.
persisted `phase=fault`도 action identity 유무와 관계없이 같은 review/rotation
대상입니다.

이전 daemon이 intent 저장과 action identity 저장 사이에서 죽어
`qualifying`/`launch_intent_persisted`, daemon identity 있음, action identity 없음인
state가 남으면 다음 시작은 중복 실행 방지 fence로 거부됩니다. 이전 cgroup/process
정리를 검증하고 state 원본을 보존 이름으로 회전한 뒤에만 재시작하세요.

## 상주 실행

배포 패키지가 바이너리를 `/usr/bin/idlepilot`에 설치했다면 포함된 user unit을
설치하고 실행할 수 있습니다.

```sh
install -Dm 0644 packaging/systemd/user/idlepilot@.service \
  "$HOME/.config/systemd/user/idlepilot@.service"
systemctl --user daemon-reload
systemctl --user enable --now idlepilot@nightly-task.service
```

로그아웃한 뒤에도 새벽에 user manager가 살아 있어야 한다면 시스템 관리자가
해당 사용자에 대해 linger를 켜야 합니다. 직접 빌드한 바이너리가 다른 위치에
있다면 unit의 `ExecStart`를 drop-in으로 교체하세요. 기본 unit은 사설 임시
디렉터리와 state/전용 work 디렉터리만 쓰기 가능하게 하므로 다른 출력 경로도 drop-in의
`ReadWritePaths=`로 명시해야 합니다.

```sh
systemctl --user status idlepilot@nightly-task.service
journalctl --user-unit idlepilot@nightly-task.service -f
idlepilot status --config "$HOME/.config/idlepilot/nightly-task.conf"
idlepilot stop --config "$HOME/.config/idlepilot/nightly-task.conf"
```

`validate`, `check`, `plan`, `doctor`, `status`, `digest` 같은 조회 명령은 없는
디렉터리나 state를 암묵적으로 만들지 않습니다. `init`은 config/state 부모와
config를 만들고, 명시적인 `run`은 필요한 경우 설정된 사설 state 부모만 만든 뒤
state/lock을 갱신합니다. `stop`은 파일을 만들지 않지만 검증된 daemon에 signal을
보낼 수 있습니다.

상세 내용은 다음 문서를 참고하세요.

- [설정 레퍼런스](docs/CONFIGURATION.md)
- [운영 가이드](docs/OPERATIONS.md)
- [에이전트용 JSON 인터페이스](docs/AGENT_INTERFACE.md)
- [아키텍처](docs/ARCHITECTURE.md)
- [보안 모델과 한계](docs/SECURITY.md)

## 라이브러리와 회귀 시험

라이브러리는 `Config::new`와 public field 수정, 정책 타입의 `parse`/`canonical`,
`Config::to_canonical_text`, `Config::state_fingerprint`,
`Config::store_new_secure`를 제공합니다. 사전 판단에는 `LaunchPlan::inspect`와
`PlanDecision`, 실제 실행에는 `Supervisor`, `RunMode`, `EventSink`를 사용할 수
있습니다. `LaunchPlan`은 예약이 아니라 읽기 전용 snapshot이므로 실행 시에는
`Supervisor`의 lock과 guard 검사를 그대로 거쳐야 합니다.

통합 시험은 단순 unit mock 외에 직접 subprocess를 띄워 세 가지 가정용 workflow를
검증합니다. 작은 디렉터리 백업은 manifest 검증 뒤 원자적으로 공개되고 같은
window에 한 번만 실행되는지, 일시 실패한 인덱서는 허용된 두 번째 시도에만
성공하고 세 번째 실행이 없는지, 장시간 인덱서의 leader/child/grandchild가 runtime
limit 뒤 모두 사라지고 heartbeat가 멈추는지를 확인합니다. 이는 포함된 협력
fixture에 대한 회귀 보증이며 임의 action이나 실제 저장장치의 원자성을 대신
보증하지 않습니다.

## 중요한 신뢰 경계

`idlepilot`은 우발적인 조건 변화와 검증되지 않은 설정 입력에 대해 보수적으로
동작하지만, 같은 Unix UID를 탈취한 공격자를 격리하는 샌드박스는 아닙니다.
또한 자체 종료 범위는 POSIX 프로세스 그룹입니다. 작업이 의도적으로 새 세션이나
새 프로세스 그룹으로 빠져나가면 직접 실행한 idlepilot만으로는 정리되지 않을 수
있습니다. 제공된 systemd unit은 guard 상실로 supervisor가 종료될 때 cgroup
전체를 정리한 뒤 재기동하는 추가 안전망이지만, 신뢰할 수 없는 코드를 실행하는
컨테이너 경계는 아닙니다.

`running` 상태 저장 deadline 초과나 process-group cleanup 불확실 오류에서는 후속
event/final-state I/O를 건너뛰고 instance lock을 process 종료까지 유지합니다.
이때 `Error::requires_process_exit()`가 true이며 CLI는 full pipe가 종료를 막지
않도록 JSON/human 오류 출력 없이 exit code만 반환합니다. 라이브러리를 embedding한
host도 blocking log/flush/cleanup 없이 즉시 process를 종료해야 하며, systemd
unit의 cgroup cleanup이 잔존 프로세스 정리의 백스톱입니다.

## English summary

idlepilot is a dependency-free, Linux-only library and CLI that launches one
reviewed executable without a shell only while local time, logind idle state,
Wi-Fi carrier, and external-power policies are proven true. Unknown observations
fail closed. The daemon emits versioned JSONL, persists once-per-window state,
binds state to a canonical configuration fingerprint, and supervises a
dedicated process group with bounded TERM-to-KILL shutdown. The read-only
`plan` command explains readiness without reserving a launch.
Action supervision and daemon control require pidfds on Linux 5.3 or newer
(x86_64 or aarch64); numeric-PID fallback is intentionally unavailable.
Read `docs/SECURITY.md` before using it with unattended workloads.
