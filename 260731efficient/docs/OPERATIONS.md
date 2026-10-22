# 운영 가이드

## 사전 조건

- Linux 5.3 이상의 64-bit GNU/Linux (`x86_64` native가 주 검증 대상,
  `aarch64`는 compile-check만 수행)
- `/proc`와 `/sys`가 정상 mount된 환경
- action 감시와 daemon stop에 필요한 pidfd syscall 사용 가능 환경
- idle 조건을 쓸 경우 systemd-logind와 `/usr/bin/loginctl` 또는 `/bin/loginctl`
- 빌드할 경우 Rust 1.85 이상
- 실행은 로그인 사용자와 같은 일반 UID; root 실행은 의도적으로 거부됨

Wi-Fi 검사는 NetworkManager에 의존하지 않고 sysfs carrier를 봅니다. headless
세션에서도 logind seat/user idle 정보가 의미 있는지 장비별로 먼저 시험하세요.

## 빌드와 설치

릴리스 전 기본 검증:

```sh
cargo fmt --check
cargo test --locked --all-targets
cargo clippy --locked --all-targets -- -D warnings
cargo doc --locked --no-deps
cargo build --locked --release
```

GitHub CI는 Ubuntu 24.04 x86_64에서 test/clippy/doc/native release archive를
검증합니다. `aarch64-unknown-linux-gnu` job은 library와 binary의 `cargo check`만
수행하며 link, 실행, systemd, archive를 시험하지 않습니다. `build-dist.sh`가 만드는
native ELF는 build host의 glibc와 `readelf`에 나타나는 시스템 라이브러리에 동적으로
연결됩니다. 그래서 최신 host에서 만든 tarball이 더 오래된 glibc 배포판에서도
동작한다는 보장은 없습니다. 지원할 가장 오래된 GNU/Linux에서 빌드하거나 배포판별
패키지를 만들고 해당 환경에서 smoke test하세요. musl target은 현재 검증하지
않습니다.

배포 패키지는 관례상 다음 위치를 사용합니다.

```text
/usr/bin/idlepilot
/usr/share/systemd/user/idlepilot@.service
/usr/share/man/man1/idlepilot.1
```

일반 사용자는 root로 프로그램을 **실행하지** 않지만, 시스템 패키지 설치 자체는
관리자 작업일 수 있습니다. 직접 빌드한 바이너리를 `$HOME/.local/bin`에 둘 수도
있으며, 이 경우 아래의 ExecStart drop-in이 필요합니다.

## 사용자 디렉터리 준비

제공 unit의 기본 write allowlist와 맞는 디렉터리를 service 시작 전에 만듭니다.

```sh
install -d -m 0700 "$HOME/.config/idlepilot"
install -d -m 0700 "$HOME/.local/state/idlepilot"
install -d -m 0700 "$HOME/.local/share/idlepilot/work"
install -d -m 0700 "$HOME/.local/lib/idlepilot/artifacts"
```

기존 부모가 group-writable이면 먼저 쓰기 권한을 제거하세요. `/tmp` 아래는
idlepilot의 경로 보안 검사에 실패합니다. `init`은 없는 config/state 부모 경로를
mode `0700`으로 만들지만, 이미 존재하는 각 최종 부모는 현재 사용자 소유이며
정확히 mode `0700`이어야 합니다.

## action 온보딩

1. action이 고정된 argv로 동작하고, daemonize/setsid/double-fork하지 않으며,
   SIGTERM에 정상 반응하는지 직접 시험합니다.
2. 파일을 검토하고 본인 또는 root 소유, group/world non-writable로 만듭니다.
3. content-addressed 저장소로 import합니다.
4. `init`으로 SHA pin과 literal argv/env/정책이 포함된 설정을 만듭니다.
5. validate/check/doctor/plan을 수행합니다.

```sh
chmod 0700 "$HOME/src/my-night-job"
idlepilot import \
  --source "$HOME/src/my-night-job" \
  --artifact-dir "$HOME/.local/lib/idlepilot/artifacts"

idlepilot init \
  --config "$HOME/.config/idlepilot/nightly-task.conf" \
  --name nightly-task \
  --executable "$HOME/.local/lib/idlepilot/artifacts/<sha256>" \
  --working-directory "$HOME/.local/share/idlepilot/work" \
  --state-file "$HOME/.local/state/idlepilot/nightly-task.state" \
  --arg --mode \
  --arg incremental \
  --env OUTPUT_LABEL=household \
  --window 01:00-06:00 \
  --wifi any \
  --power auto \
  --idle logind-seat:seat0

chmod 0600 "$HOME/.config/idlepilot/nightly-task.conf"
idlepilot validate --config "$HOME/.config/idlepilot/nightly-task.conf"
idlepilot check --config "$HOME/.config/idlepilot/nightly-task.conf"
idlepilot doctor --config "$HOME/.config/idlepilot/nightly-task.conf" \
  --watch-seconds 60
idlepilot plan --config "$HOME/.config/idlepilot/nightly-task.conf"
```

`doctor`는 실행하지 않고 조건만 관찰합니다. `run --once`는 현재 window 안에서
조건을 실제로 만족시킬 수 있고, action을 한 번 실행해도 안전할 때만 사용하세요.
`init`은 `--arg`/`--env`를 반복해서 받고 모든 timing/policy/retry option을 생성
시점에 설정할 수 있습니다. 전체 목록은 [설정 레퍼런스](CONFIGURATION.md)를
참고하세요.

## systemd user service 설치

패키지 설치가 아니라 소스 트리에서 사용자 단위로 unit만 설치할 때:

```sh
install -Dm 0644 packaging/systemd/user/idlepilot@.service \
  "$HOME/.config/systemd/user/idlepilot@.service"
systemd-analyze --user verify \
  "$HOME/.config/systemd/user/idlepilot@.service"
systemctl --user daemon-reload
```

instance 이름 `%i`가 config basename과 일치합니다.

```text
idlepilot@nightly-task.service
%h/.config/idlepilot/nightly-task.conf
```

시작 및 부팅 후 활성화:

```sh
systemctl --user enable --now idlepilot@nightly-task.service
systemctl --user status idlepilot@nightly-task.service
```

새벽에 로그아웃 상태에서도 user manager를 실행해야 한다면 관리자가 해당 UID의
linger를 활성화해야 합니다.

```sh
loginctl enable-linger "$USER"
```

배포 정책에 따라 이 명령은 관리자 권한이 필요합니다. linger를 쓰지 않으면
사용자 manager가 내려간 동안에는 어떤 action도 시작되지 않습니다.

### 바이너리가 `/usr/bin`이 아닐 때

```sh
systemctl --user edit idlepilot@nightly-task.service
```

drop-in:

```ini
[Service]
ExecStart=
ExecStart=%h/.local/bin/idlepilot run --config %h/.config/idlepilot/%i.conf
```

그 뒤 `systemctl --user daemon-reload`와 service restart를 수행합니다.

### 추가 write path

기본 unit은 격리된 private `/tmp`/`/var/tmp`, `%h/.local/state/idlepilot`,
`%h/.local/share/idlepilot`, user runtime directory만 쓰기 가능하게 하고 나머지
filesystem view를 read-only로 둡니다.
예를 들어 백업 대상이 `/mnt/user-backup`이면 경로를 미리 만들고 drop-in에
최소 범위로 추가합니다.

```ini
[Service]
ReadWritePaths=/mnt/user-backup
```

action이 GPU나 특별한 device를 써야 한다면 기본 `PrivateDevices=yes`와 충돌할 수
있습니다. 신뢰성과 공격면을 검토한 뒤 해당 instance에만 다음처럼 완화합니다.

```ini
[Service]
PrivateDevices=no
```

container 도구처럼 namespace를 만들거나 netlink/특수 socket family가 필요한
action은 기본 `RestrictNamespaces=yes` 또는 `RestrictAddressFamilies=`와 충돌할
수 있습니다. 그러한 action이 process-group 계약까지 지키는지 먼저 확인하고,
해당 directive만 instance drop-in에서 최소한으로 완화하세요.

환경 변수는 systemd manager에서 상속해도 action 시작 시 비워집니다. action에
필요한 비민감 환경은 config의 `env`로 명시하세요.

## 일상 운영

### 상태

```sh
idlepilot status --config "$HOME/.config/idlepilot/nightly-task.conf"
idlepilot check --config "$HOME/.config/idlepilot/nightly-task.conf"
idlepilot plan --config "$HOME/.config/idlepilot/nightly-task.conf"
```

`status`는 영속 상태와 daemon PID start ticks를 함께 확인합니다. `check` exit 3은
현재 실행하지 않는다는 정상적인 정책 결과일 수 있습니다. JSON의 `*_reason`으로
구분하세요. `plan`은 조건뿐 아니라 digest, daemon/action identity, 완료와 시도
state를 합쳐 `ready`, 정상적인 `blocked`(exit 3), 운영자 확인이 필요한
`attention`(exit 5)을 구분합니다. 조회일 뿐 launch 예약은 아닙니다.

`status`의 `action_status`, `action_alive`, `attention_required`, `action_pgid`,
`attempt_window`, `max_attempts`, `last_exit_code`/`last_exit_signal`,
`updated_unix_seconds`를 장애 분류에 함께 사용하세요. 유효한 state라면
`attention_required:true`여도 status 자체는 exit 0이므로 field를 반드시 읽어야
합니다.

`validate`, `check`, `plan`, `doctor`, `status`, `digest`는 조회 과정에서 없는
디렉터리나 state를 만들지 않습니다. `stop`도 디렉터리를 만들지는 않지만 daemon에
signal을 보낼 수 있습니다. 조회 시에는 config가 가리키는 state 부모가 사전에 mode
`0700`으로 존재해야 합니다. `init`은 config/state 부모를 만들고, 명시적인 `run`은
없는 경우 설정된 사설 state 부모 chain만 만든 뒤 state/lock을 갱신합니다.

### 로그

```sh
journalctl --user-unit idlepilot@nightly-task.service --since today
journalctl --user-unit idlepilot@nightly-task.service -f -o cat
```

daemon stdout의 각 줄은 JSON event입니다. `fault`, `action_stopping`,
`action_stopped`, `action_failed`, `process_group_not_empty` 관련 reason을
모니터링하세요. `supervisor_error`가 running-state 저장 직후 발생했다면 state
파일과 저장장치 지연/권한을 함께 조사하세요. action stdout/stderr는 버려지므로
action 자체 감사 로그가 필요하면 허용된 사설 경로에 직접 기록하게 해야 합니다.

단일 JSON command와 `doctor`는 stdout reader가 먼저 닫혀 `BrokenPipe`가 나도
panic하지 않고 본래 작업/exit 판단을 계속합니다. `run` JSONL sink의 write 실패는
감독 오류이므로 `run` stdout은 항상 끝까지 drain하세요. 이벤트를 `head` 같은 조기
종료 consumer에 직접 연결하지 마세요.

`running` state 비동기 저장은 action 감시와 병행되며 deadline은
`max(15초, guard interval)`입니다. launch-intent는 이미 영속되어 있으므로 느린
home-storage writeback을 허용하면서도 유한한 deadline을 유지합니다. 이 deadline을
넘기거나 SIGKILL 뒤 빈 process
group을 확인하지 못하면 idlepilot은 후속 event/final-state I/O를 생략하고 instance
lock을 process 종료까지 유지합니다. 이 terminal 경로는 full output pipe가 종료를
막지 않도록 JSON/human 오류도 출력하지 않으므로 journal에는 최종 오류 문구가 없고
unit의 non-zero exit만 보일 수 있습니다. 제공 unit에서는 main process 종료와
systemd cgroup cleanup을 기다린 뒤에만 재시작하세요. 라이브러리를 직접 embedding한
host도 `Error::requires_process_exit()`를 확인해 blocking log/flush/cleanup 없이
즉시 process를 종료해야 합니다.

정상 exit/stop을 관찰한 뒤에는 action identity를 지우고 완료/재시도 결정을 먼저
영속한 다음 보류된 lifecycle event를 출력합니다. 이 flush가 실패하면
`phase=fault` restart fence가 남으므로 output 장애를 고친 뒤에도 자동 재실행하지
말고 `last_exit_*`, `completed_window`와 실제 작업 결과를 확인하세요.

### 정상 정지

systemd로 운영 중이면 unit stop을 우선합니다.

```sh
systemctl --user stop idlepilot@nightly-task.service
```

unit은 `KillMode=mixed`입니다. 먼저 main daemon에 SIGTERM을 보내 idlepilot이
설정된 TERM-to-KILL과 state 정리를 하도록 두고, `TimeoutStopSec`가 지나면 cgroup
전체에 SIGKILL을 보내는 백스톱을 제공합니다.

live guard 상실은 별도 흐름입니다. idlepilot이 action PGID에 TERM 직후 KILL을
보내고 exit 7로 끝나면 systemd가 같은 cgroup의 잔존자를 정리하고 15초 뒤 새
supervisor를 시작합니다. runtime limit도 완료 상태를 기록하고 exit 8로 끝난 뒤
같은 정리/재기동을 거칩니다. 새 인스턴스는 영속 상태를 읽어 조건 대기 또는
현재 window 완료 상태를 이어갑니다.

unit은 restart storm을 막기 위해 30분에 10회로 시작을 제한합니다. guard가 매우
빠르게 반복 상실되어 한도에 닿으면 service는 failed로 남아 action을 더 시작하지
않습니다. 원인을 고친 뒤 journal/state를 확인하고 필요할 때만
`systemctl --user reset-failed idlepilot@NAME.service` 후 다시 시작하세요.

직접 실행 daemon은 다음으로 멈춥니다.

```sh
idlepilot stop \
  --config "$HOME/.config/idlepilot/nightly-task.conf" \
  --wait-seconds 15
```

`wait-seconds`보다 `stop_grace_seconds`가 길면 stop command가 timeout해도 daemon이
종료 중일 수 있습니다. PID를 직접 kill하기 전에 `status`와 journal을 다시
확인하세요.

이 command는 pidfd를 먼저 열고 start ticks를 확인한 뒤 그 같은 kernel process
handle에만 signal하며 pidfd poll로 종료를 봅니다. action 감시도 spawn 전 pidfd
지원을 preflight하고 child pidfd를 즉시 엽니다. Linux 5.3 pidfd syscall 또는 지원
architecture(x86_64/aarch64)가 없으면 어느 경로도 numeric PID로 fallback하지
않습니다. 이미 떠 있는 unit의 비상 정리는 `systemctl --user stop`을 사용하세요.

`status`와 `stop`은 안전한 config/state 경로와 정책은 검증하지만
executable/working-directory가 시작 뒤 사라져도 control plane을 유지합니다.
config나 state 경로 자체가 손상된 경우에는 PID를 우회해 직접 signal하지 말고
`systemctl --user stop idlepilot@NAME.service`로 cgroup을 정리한 뒤 조사하세요.

## 설정 변경과 업그레이드

실행 중인 daemon은 config를 hot reload하지 않습니다. state schema v2는 canonical
config의 comment 제외 의미 행 fingerprint를 저장하므로 의미가 바뀐 config를 기존 state에
적용하는 것도 security exit 5로 거부합니다. 다음 순서를 사용합니다.

1. service를 stop하고 `status`가 stopped인지 확인합니다.
2. cgroup과 persisted action이 모두 정리됐고 unresolved intent, unknown terminal
   result, persisted fault가 아님을 확인합니다.
3. config/artifact를 사본으로 준비하고 권한과 digest를 검증합니다.
4. 기존 state를 삭제하지 말고 timestamp/변경-ticket이 포함된 이름으로 회전합니다.
5. config를 교체한 뒤 `validate`, `check`, `plan`을 실행합니다.
6. 새 바이너리에서 `version`/`schema`와 release test를 확인합니다.
7. service를 start하고 initialized/conditions 이벤트를 확인합니다.

artifact는 SHA-256 이름으로 새 파일이 생기므로 기존 artifact를 덮어쓰지 않고
rollback할 수 있습니다. 이전 config, state와 바이너리를 보존 기간 동안 유지하세요.
state 회전은 완료/시도 high-water mark를 초기화하므로 새 정책의 중복 부작용 가능성을
명시적으로 승인해야 합니다. 이전 state schema v1도 자동 변환하지 않고 같은
보존·회전 절차를 사용합니다.

## once-per-window 상태 초기화

정상 성공 후 같은 window를 의도적으로 다시 실행하는 CLI reset은 없습니다.
정책상 정말 필요하다면 service를 먼저 완전히 멈추고 state를 삭제하는 대신
복구 가능한 이름으로 이동합니다.

```sh
systemctl --user stop idlepilot@nightly-task.service
mv "$HOME/.local/state/idlepilot/nightly-task.state" \
   "$HOME/.local/state/idlepilot/nightly-task.state.backup"
systemctl --user start idlepilot@nightly-task.service
```

이는 완료 기록과 시도 횟수를 모두 초기화하여 중복 action을 유발할 수 있습니다.
운영 승인과 감사 기록을 남기세요. `.lock` 파일은 존재 자체가 lock이 아니므로
정상 종료 뒤 지울 필요가 없습니다.

시도 횟수는 실제 exec 수가 아니라 spawn 전에 state에 저장한 durable
launch-intent 수입니다. intent 뒤 마지막 guard가 바뀌거나 종료 signal/crash가
발생하면 action 실행 기록 없이 attempt가 하나 늘어 있을 수 있으며, 이는 정상적인
fail-closed accounting입니다.

반면 state에 daemon identity가 남고 `phase=qualifying`,
`last_reason=launch_intent_persisted`이며 action identity가 없는 상태는 단순히
초기화해서는 안 됩니다. 이전 daemon이 intent와 action identity 저장 사이에서
죽었다면 실제 exec 여부가 불명확하기 때문입니다. 아래 ambiguous state 복구
절차를 따르세요.

## 장애 진단

### `unknown`

- `network_sysfs_unavailable`: `/sys/class/net` mount/권한 확인
- `wifi_state_incomplete`: interface의 `carrier`, `dormant`, `operstate` 확인
- `power_sysfs_unavailable`: `/sys/class/power_supply` mount와 kernel driver 확인
- `power_supply_inventory_incomplete`: supply 목록 중 `type` 등 inventory 속성을
  읽지 못해 desktop/laptop을 안전하게 구분할 수 없음
- `chassis_mobility_unknown`: battery가 없을 때
  `/sys/class/dmi/id/chassis_type`으로 stationary/portable 여부를 증명할 수 없음
- `external_power_state_incomplete`: supply의 `type`, `present`, `online` 확인
- `logind_unavailable`: `loginctl` 설치 경로 확인
- `logind_query_failed`: systemd-logind, seat/user 존재 여부, 250ms timeout 확인
- `idle_since_unavailable`: logind monotonic property가 0/누락인지 확인
- `monotonic_uptime_unavailable`: `/proc/uptime` 접근 확인
- `local_time_unavailable`: 시스템 시계/libc localtime 문제 확인

조건을 disable해서 오류를 숨기기 전에 `doctor`로 원인을 재현하고 위험 승인을
받으세요.

### service가 hardening 단계에서 시작되지 않음

```sh
systemctl --user status idlepilot@nightly-task.service
journalctl --user-unit idlepilot@nightly-task.service -b
systemd-analyze --user security idlepilot@nightly-task.service
```

오래된 systemd나 unprivileged user namespace가 비활성화된 환경에서는 일부 mount
namespace hardening이 지원되지 않을 수 있습니다. 해당 directive만 instance
drop-in으로 완화하고 이유를 기록하세요. unit 전체 hardening을 복사해 제거하지
마세요.

### stale action 오류

이전 state가 같은 PID와 start ticks의 살아 있는 action을 가리키면 idlepilot은
자동으로 죽이거나 인수하지 않습니다. 먼저 해당 user unit을 stop하여 cgroup을
정리하고, 실제 프로세스가 사라졌는지 확인한 뒤 restart하세요. PID가 재사용된
것으로 보이면 state를 임의 수정하지 말고 프로세스와 상태 파일을 보존하여
조사하세요.

leader가 이미 죽었지만 PGID에 자손이 남은 경우도 restart를 거부합니다. 더
중요하게는 leader와 group이 모두 사라져도 이전 action의 성공/실패와 외부 부작용,
그 결과가 state에 durable하게 반영됐는지는 알 수 없습니다. `status`의
`action_status:"terminal_result_unknown"`, `action_alive:false`,
`attention_required:true`가 이 경우입니다. process가 없다는 이유로 identity를
지우거나 자동 재실행하지 말고 아래와 같은 증거 보존·회전 절차를 적용하세요.

persisted `phase=fault`도 `action_status:"none"`일 수 있지만
`attention_required:true`이며, `plan`은 `recovery_required`(exit 5), `run` startup은
security 오류로 거부합니다. fault reason, journal, cgroup/process와 작업 부작용을
검토한 뒤에만 state를 회전하세요.

### ambiguous state 복구

unresolved launch-intent는 direct daemon 또는 embedded host가 durable intent 뒤
정상 action identity/final-state 저장 전에 죽었을 때 중복 action 실행을 막는 startup
fence입니다. `terminal_result_unknown`은 action identity 뒤 durable terminal-state
저장 전에 죽었을 수 있는 fence이고, persisted fault도 자동 복구하지 않습니다. 새
supervisor는 어느 경우도 “실행되지 않음” 또는 “정상 종료”로 추측하지 않습니다.
systemd restart loop가 진행 중이면 먼저 unit을 stop하고 다음 순서로 복구합니다.

1. user unit/cgroup이 완전히 내려갔고 이전 daemon/action/자손 process가 남지
   않았음을 확인합니다. direct/embedded 실행이었다면 해당 process tree와 작업의
   외부 부작용도 별도로 확인합니다.
2. state 파일과 관련 journal을 복구 증거로 보존합니다. state를 편집하거나 바로
   삭제하지 마세요.
3. state 파일을 같은 사설 디렉터리의 timestamp/incident 이름으로 이동해
   회전합니다.
4. 새 supervisor를 시작하고 새 state가 만들어지는지 확인합니다.

이 startup security 오류들의 `requires_process_exit()`는 `false`라 일반 JSON/human
오류가 출력됩니다. terminal cleanup uncertainty에서 오류 출력이 생략되는 경로와
혼동하지 마세요. 이전 action이 이미 외부 부작용을 냈을 수 있으므로 state 회전은
중복 실행 위험을 검토하고 승인한 뒤에만 수행합니다.

### action이 guard 상실 뒤 남음

이는 action 또는 자손이 새 session/PGID로 탈출했을 가능성이 높습니다. 즉시 user
unit을 stop하면 systemd cgroup 백스톱이 남은 프로세스를 정리합니다. 해당
artifact는 다시 활성화하지 말고 daemonize/`setsid` 사용을 제거한 새 digest로
교체하세요.

## 장비 인수 시험

운영 전 최소한 다음을 실제 장비에서 확인합니다.

- 허용 시간 밖, Wi-Fi 단절, laptop battery 상태, 사용자 active 상태 각각에서
  `check`가 exit 3이고 action을 시작하지 않음
- 각 조건을 만족했을 때만 `run --once`가 시작됨
- 긴 test action 실행 중 Wi-Fi를 끄거나 AC를 분리하거나 입력을 주었을 때 guard
  interval과 probe 지연 범위 안에서 TERM 직후 KILL되고 supervisor가 exit 7임
- shutdown/runtime 시험에서는 TERM을 무시하는 협력 test child가 configured
  grace 뒤 KILL되고 process group이 비어 있음
- service stop/로그아웃/재부팅에서 자손이 남지 않음
- 성공 후 같은 window에 restart해도 다시 실행되지 않음
- 다음 window에서는 attempt counter가 새로 시작됨

실제 데이터 작업 대신 종료와 heartbeat만 기록하는 전용 non-production fixture로
시험하고, production state 파일과 분리하세요.

repository 통합 시험에는 직접 subprocess를 사용하는 가정용 mock workflow도
포함됩니다. 작은 디렉터리 백업은 SHA-256 manifest와 원자 publication, 같은 window
재실행 방지를 확인합니다. flaky 인덱서는 첫 실패에 결과를 publish하지 않고 두 번째
허용 시도만 성공하며 세 번째 launch가 없음을 확인합니다. 장시간 인덱서는
leader/child/grandchild 세 단계가 같은 process group에 있고 runtime limit 뒤 모두
사라지며 heartbeat가 더 진행되지 않음을 확인합니다. 이 시험은 협력 fixture와 test
filesystem에 대한 회귀 보증이므로 실제 action, mount, 전원/네트워크 드라이버에 대한
위 장비 인수 시험을 대체하지 않습니다.
