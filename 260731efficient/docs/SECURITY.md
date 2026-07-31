# 보안 모델

## 보안 목표

idlepilot은 다음 성질을 목표로 합니다.

- 네 조건이 모두 명확히 `met`일 때만 action을 시작합니다.
- 관찰 실패와 모호함은 `unknown`으로 두고 실행을 허용하지 않습니다.
- 실행 중 조건을 반복 확인하고, 상실 시 bounded TERM-to-KILL 절차를 시작합니다.
- 설정 값은 셸 문법, 변수 치환, glob, command substitution으로 평가하지 않습니다.
- 실행 대상은 미리 검토된 설정 파일에서만 오며 status/stop 인터페이스로 바꿀
  수 없습니다.
- root, setuid/seteuid 실행과 위험한 파일 유형/권한을 거부합니다.
- state와 PID identity를 확인하고 action 감시와 daemon stop 모두 pidfd를 사용하여
  중복 daemon과 PID 재사용 오신호를 막습니다.
- 구조화 이벤트에는 argv, 환경, SSID, IP 주소, action 출력이 들어가지 않습니다.

fail-closed는 “관찰 실패 시 실행하지 않는다”는 뜻이지, 이 프로그램이 범용
샌드박스 또는 악성코드 분석기가 된다는 뜻은 아닙니다.

## 신뢰하는 것

다음을 신뢰 경계 안에 둡니다.

- 커널, `/proc`, `/sys`, 로컬 시계와 systemd-logind
- 설치된 idlepilot 바이너리와 Rust/OS 런타임
- 현재 Unix UID 및 그 UID가 검토해 배치한 설정과 action
- root가 소유한 실행 파일과 설정

현재 UID가 탈취되었거나 action 자체가 적대적이면 동일 UID로 읽고 쓸 수 있는
파일, 신호, IPC를 idlepilot만으로 격리할 수 없습니다. 다중 사용자 환경에서는
설정, artifact, work, state 디렉터리를 모두 해당 UID 소유 mode `0700`으로
유지하세요. 구현은 기존 경로 구성 디렉터리가 group 또는 world writable이면
거부합니다.

## 위협과 방어

| 위협 | 현재 방어 | 남는 한계 |
|---|---|---|
| 설정에 `;`, `$()`, redirection 삽입 | 실행 파일과 각 `arg`를 그대로 `exec` 계열 API에 전달, 셸 미호출 | 설정한 실행 파일이 shebang 셸 스크립트이면 그 스크립트 내부 문법은 당연히 셸이 해석함 |
| loader/interpreter 환경 주입 | 상속 환경 전체 삭제, 위험한 `LD_*`, `DYLD_*`, `PYTHONPATH` 등 키 거부 | action이 자체 설정 파일이나 같은 UID 파일을 읽는 행위는 제한하지 않음 |
| config/import 입력 symlink 교체 | 절대 경로 구성요소 검사, 최종 파일 `O_NOFOLLOW` open 후 같은 descriptor에서 읽기, import 전후 metadata 비교 | 부모 디렉터리 경쟁과 같은 UID의 파일 조작은 별도 격리 경계가 아님 |
| 실행 파일 변조/교체 | non-symlink/권한 확인, 선택적 SHA-256 pin을 final condition query 전에 준비, spawn 직전/직후 device/inode/size/mtime/ctime 확인, content-addressed import | exec가 열린 fd에 완전히 binding되지는 않음; 같은 UID는 설정과 파일을 함께 바꿀 수 있음 |
| spawn 후 identity 검증 실패의 자손 누수 | executable identity, 전용 PGID 또는 start ticks 재검증 실패 시 kill 후 최대 2초 안에 leader reap과 소유가 확인된 process group의 emptiness를 모두 증명 | group 소유/emptiness 또는 reap을 증명하지 못하면 `requires_process_exit()` terminal 무출력 경로와 systemd cgroup cleanup이 필요함 |
| pin되지 않은 실행 의존성 | 빈 환경과 제한된 PATH, read-only system view(systemd unit) | SHA pin은 선택한 파일만 포함하며 shebang interpreter, ELF loader/shared library, action이 여는 데이터와 후속 subprocess는 포함하지 않음 |
| root 권한 획득 | root/setuid 거부, child `no_new_privs`, 빈 capability bounding set(systemd unit) | action은 여전히 실행 UID의 모든 일반 권한을 가짐 |
| PID/PGID 재사용에 잘못 signal | action은 spawn 전 pidfd 지원을 preflight하고 child pidfd를 즉시 소유; leader exit는 reap하지 않고 pidfd로 관찰하여 zombie가 PGID를 예약한 동안 `/proc` field 5로 다른 group member를 확인·정리한 뒤 마지막에만 reap; daemon stop도 pidfd와 start ticks 사용 | `/proc` 또는 pidfd syscall이 없으면 안전하게 진행하지 않고 거부; 지원 pidfd architecture는 x86_64/aarch64 |
| 자손 프로세스 누수 | 전용 POSIX process group 전체에 TERM/KILL, leader 외 member가 없음을 확인한 뒤 reap, 서비스 종료 시 systemd cgroup 정리 | 의도적인 `setsid`/새 PGID 탈출은 live guard의 PGID kill을 피할 수 있음 |
| 중복 daemon | state 인접 lock 파일에 비차단 exclusive `flock` | 서로 다른 `state_file`을 쓰는 두 설정은 별도 인스턴스로 간주함 |
| 상태 파일 대체/연결 | UID, mode `0600`, 일반 파일, non-symlink, link count 1, 크기 제한, 원자 rename | 같은 UID는 상태를 삭제하거나 바꿀 수 있음 |
| 다른/변경된 config가 기존 state 재사용 | state schema v2에 canonical config의 comment 행을 제외한 의미 행 바이트 SHA-256을 binding하고 run/plan/status/stop 전에 비교 | 승인된 config 변경도 자동 호환하지 않으므로 안전한 stop, state 보존·회전과 중복 부작용 검토 필요 |
| fork/exec 경계 crash 뒤 중복 실행 | spawn 전 launch-intent를 영속화하고, daemon identity만 남은 unresolved intent는 다음 startup에서 거부 | 이전 action이 실제 exec했는지 자동 판정하지 않으므로 cleanup 검증과 state 보존·회전에 운영자 개입 필요 |
| action 종료와 final-state 저장 사이 crash | daemon 없는 persisted action identity는 leader와 group이 모두 사라져도 `terminal_result_unknown`으로 유지하고 plan/startup을 거부 | process 부재만으로 성공/실패나 외부 부작용을 복원할 수 없어 작업별 검토와 state 보존·회전 필요 |
| persisted fault의 자동 정상화 | plan은 `recovery_required`, supervisor startup은 security 오류로 거부 | fault 원인과 부작용 검토 뒤 운영자가 state를 보존·회전해야 함 |
| running 상태 저장 실패/지연 | spawn 전 durable launch-intent 저장, fallible thread start와 action hard-stop, action 감시와 병행한 background `running` 저장, `max(15초, guard interval)` deadline | deadline이면 후속 event/final-state I/O를 생략하고 instance lock을 process 종료까지 유지하므로 embedded caller도 즉시 종료해야 함 |
| process-group 정리 불확실 | SIGKILL 뒤 빈 group을 확인하고 불확실하면 live identity를 보존한 채 후속 event/final-state I/O를 생략 | PGID를 탈출한 자손은 직접 정리할 수 없으며 process 종료와 systemd cgroup 백스톱이 필요함 |
| D-state leader로 destructor 정지 | `ActionProcess::Drop`은 bounded stop 뒤 uncertainty에서 final kill과 nonblocking `try_wait`만 수행하고 blocking wait를 하지 않음 | Drop은 cleanup 완료를 보고할 수 없는 best-effort 안전망이므로 저수준 caller가 `stop()` 결과를 확인하고 불확실하면 process를 종료해야 함 |
| condition provider 장애 | tri-state `unknown`, `loginctl` 250ms timeout/출력 제한, 고정 executable/argv | 오래 멈춘 커널 filesystem I/O까지 자체 timeout으로 끊지는 못함 |
| audit 출력 정체 | live action 중 eligible 이벤트 생략, 중요 이벤트 최대 128개 메모리 보류, stop/reap 뒤 sink flush | 막힌 sink는 kill은 지연시키지 않지만 이후 supervisor 진행을 막을 수 있고 비정상 burst는 일부 이벤트가 생략될 수 있음; run의 BrokenPipe도 OS 오류로 종료됨 |

## 파일 및 경로 규칙

보안 관련 모든 경로는 절대 경로여야 하며 `.`/`..` 구성요소를 허용하지
않습니다. 기존 경로 구성요소가 symlink이거나 group/world-writable 디렉터리이면
거부됩니다. 따라서 `/tmp/...`는 의도적으로 사용할 수 없습니다.

- config/input: 일반 non-symlink 파일, 호출 UID 또는 root 소유, group/world
  write 없음. config 최대 256 KiB.
- executable: 같은 소유권/쓰기 규칙, execute bit가 있는 일반 non-symlink 파일.
- working directory: non-symlink 디렉터리, group/world-write 없음.
- config/state final parent: `init`은 없으면 경로를 mode `0700`으로 만들고, 이미
  있으면 호출 UID 소유이면서 mode `0700`인 non-symlink 디렉터리만 허용합니다.
- state/lock: mode `0600`.
- imported artifact: 사설 mode `0700` 디렉터리 아래 SHA-256 이름, mode `0500`,
  최대 512 MiB.

설정과 `env`는 평문입니다. 비밀번호, 토큰, private key를 넣지 마세요. 꼭 필요한
비밀은 action이 권한이 제한된 별도 파일이나 OS credential facility에서 직접
읽도록 설계하고, systemd hardening과의 접근 범위를 검토하세요.

경로 생성은 onboarding과 runtime mutation에만 있습니다. CLI의 `validate`, `check`,
`plan`, `doctor`, `status`, `digest`와 library validation/planning API는 없는 부모나
state를 만들지 않습니다. `init`은 config/state 부모와 config를 만들고 explicit
`run`은 필요한 경우 설정된 private state 부모 chain을 만든 뒤 state/lock을
갱신합니다. `stop`은 파일을 만들지 않지만 검증된 daemon identity에 signal을 보낼
수 있습니다.

## 프로세스 실행과 종료

action 시작 시 부모 환경을 지우고 다음만 구성합니다.

- `PATH=/usr/bin:/bin`
- `LANG=C.UTF-8`
- 설정의 검증된 `env = "KEY=value"` 항목

stdin, stdout, stderr는 `/dev/null`에 해당합니다. action 로그가 필요하면 action이
UID 전용 파일에 직접 안전하게 써야 하며, 그 경로를 systemd unit의
`ReadWritePaths=`에도 허용해야 합니다.

idlepilot은 child PID와 같은 새 process group을 요구합니다. live guard 상실에는
음수 PGID에 SIGTERM 직후 SIGKILL을 보내고 supervisor도 exit 7로 종료합니다.
runtime limit과 SIGINT/SIGTERM shutdown에는 `stop_grace_seconds`의 TERM 유예 뒤
SIGKILL을 보냅니다. SIGKILL 뒤 2초 동안 빈 그룹을 증명하지 못하면 fault입니다.

action 준비는 현재 process에 pidfd를 열어 kernel/architecture 지원을 먼저
확인하므로 unsupported 환경에서 action을 실행한 뒤 실패하지 않습니다. spawn한
child에도 즉시 pidfd를 열고, 종료는 그 handle로 reap 없이 관찰합니다. leader가
zombie인 동안에는 PID/PGID 숫자가 재사용되지 않으므로 `/proc/<pid>/stat` field 5를
스캔해 같은 group의 다른 member가 없다는 결과를 5ms 간격으로 두 번 확인하고 필요한
TERM/KILL을 모두 보낸 뒤에만 `try_wait`로 leader status를 수집합니다. leader
exit가 첫 stop signal 전에
이미 관찰된 경우에만 자연 exit가 stop reason보다 우선합니다. signal 뒤 처음 보인
code 0은 graceful handler일 수 있으므로 원래 guard/runtime/shutdown 정책을
유지합니다.

child spawn 뒤 executable identity, 실제 PGID 또는 `/proc` start ticks 재검증이
실패해도 단순히 원래 검증 오류만 반환하지 않습니다. child/group을 kill한 뒤 최대
2초 동안 leader가 reap되었고 그 child가 소유한 것으로 확인된 전용 process group이
비었음을 함께 증명합니다. 둘 중 하나라도 증명할 수 없으면 cleanup uncertainty를
`requires_process_exit()` terminal 오류로 승격하며 아래의 무출력 process-exit
경로를 적용합니다.

재검증을 포함한 최종 cleanup에서도 빈 group을 증명하지 못하거나 cleanup 호출
자체가 실패하면 안전한 최종 상태를 단정할 수 없습니다. idlepilot은 남은 process
identity를 지우거나 후속 event/final state를 쓰지 않고 instance lock을 process
수명 동안 유지하고 `requires_process_exit()`가 `true`인 error를 반환합니다. CLI는
full pipe나 journal write가 종료를 막지 않도록 JSON/human 오류를 의도적으로
출력하지 않고 error kind에 대응하는 exit code만 반환합니다. 라이브러리를
embedding한 호출자도 blocking log/flush/cleanup 없이 process를 즉시 종료해야 하며
같은 process에서 재사용해서는 안 됩니다. 제공 systemd unit의 cgroup cleanup은 이
process-exit 경로에서 PGID 잔존자와 탈출 자손을 정리하는 백스톱입니다. 직접
실행에는 이 cgroup 안전망이 없습니다.

별도의 startup fence도 있습니다. 이전 state가 `phase=qualifying`,
`last_reason=launch_intent_persisted`, daemon identity 있음, action identity 없음이면
이전 daemon이 intent 영속화와 live action identity 저장 사이에서 죽었을 수
있습니다. 새 supervisor는 action이 실행되지 않았다고 추측하지 않고 security
오류로 멈춥니다. 이 오류의 `requires_process_exit()`는 `false`이므로 일반 오류
출력은 가능하지만 자동 retry해서는 안 됩니다. 이전 service/cgroup과 관련 process
정리를 검증하고 state 원본을 증거로 보존·회전한 뒤에만 재시작하세요.

action identity가 durable state에 남은 경우에는 leader와 process group이 모두
사라졌더라도 자동으로 identity를 지우지 않습니다. 이는 cleanup 완료는 보여도
action의 terminal 결과와 외부 부작용, final-state 저장 완료를 보여주지 않기
때문입니다. status는 `terminal_result_unknown`, plan은 `recovery_required`로
분류하고 startup은 가능한 중복 launch를 막기 위해 거부합니다. persisted
`phase=fault`도 action identity 유무와 관계없이 같은 review/rotation fence입니다.

공개 저수준 `ActionProcess`의 destructor는 cleanup 완료를 보증하는 API가 아닙니다.
Drop 시 먼저 bounded `stop()`을 시도하지만 여전히 불확실하면 final group/leader
kill 뒤 nonblocking `try_wait()`만 하고 반환하여 D-state child 때문에 host 전체가
멈추는 것을 피합니다. 저수준 caller는 Drop에 의존하지 말고 `stop()`의 오류와
`StopOutcome::group_empty`를 검사해야 하며, 정리를 증명하지 못하면 즉시 process를
종료해 cgroup 백스톱이 작동하게 해야 합니다.

### 반드시 지켜야 하는 action 계약

action과 모든 협력 자손은 같은 process group에 머물러야 합니다. 다음 패턴은
지원하지 않습니다.

- `setsid(2)` 또는 새 process group 생성
- daemonize/double-fork 후 부모 종료
- 작업을 별도 systemd unit, container daemon, batch scheduler에 위임하고 즉시
  성공 종료
- 같은 UID의 독립 프로세스에 일을 요청한 뒤 감독 대상인 것처럼 가정

이런 코드는 idlepilot의 PGID signal을 피할 수 있습니다. guard 상실 시 supervisor
자체도 종료하므로 제공 user unit의 `KillMode=mixed`가 main 종료 뒤 cgroup
잔존자에게 SIGKILL을 보내고, `Restart=on-failure`가 새 supervisor를 시작합니다.
직접 실행한 경우에는 이 cgroup 안전망이 없습니다. 일반적인 unit stop에서 main이
끝나지 않을 때는 configured systemd stop timeout이 최종 상한입니다. 신뢰할 수
없는 action에는 별도의 container/VM 또는 action별 transient scope 설계가
필요합니다.

## 조건 감지의 의미

- Wi-Fi는 sysfs에서 wireless interface의 carrier/dormant/operstate만 확인합니다.
  인터넷 접속, DNS, captive portal, 특정 SSID를 증명하지 않습니다.
- `power=auto`는 system battery가 발견되거나 DMI가 portable chassis임을
  나타내면 외부 전원을 요구합니다. battery와 stationary chassis 어느 쪽도
  증명할 수 없거나 power sysfs를 읽을 수 없으면 desktop이라고 추측하지 않고
  `unknown`입니다.
- idle은 logind의 seat 또는 user `IdleHint`와 monotonic idle-since 값을
  사용합니다. 입력 장치를 직접 훔쳐보지 않습니다.
- window는 시스템 로컬 시각을 신뢰합니다. 시간 설정이 바뀌면 다음 snapshot부터
  결과가 달라집니다. completed key를 high-water mark로 사용해 과거 날짜 rollback
  재실행은 막습니다. window를 포함한 canonical config가 바뀌면 state fingerprint
  mismatch로 거부하므로 별도 state 보존·회전 migration이 필요합니다.

실행 중 재검사 주기는 100~250ms로 제한되며 기본값은 250ms입니다. “즉시
중지”의 구현상 의미는 다음 guard 검사에서 grace 0 종료를 시작한다는 뜻입니다.
`loginctl` timeout도 250ms이므로 한 watchdog 회차의 명목 예산은 최대 250ms 대기
+ 최대 250ms logind 질의입니다. PID/PGID를 담은 `running` state는 action 감시와
병행해 background 저장하고 `max(15초, guard interval)` deadline을 적용하며,
event는 deferred 처리합니다. 조건들은 순차 표본화되고 sysfs/custom probe I/O와
OS scheduler 지연은 이 예산 밖입니다. 정상 Linux adapter의 watchdog 목표는
조건 변화부터 중단 요청까지 1초 이내지만 hard real-time 보장은 아닙니다. 커널
suspend 동안에는 daemon과 action이 함께 멈춥니다. resume 후 다음 검사에서
조건을 다시 평가합니다.

## systemd hardening

제공된 user unit은 root가 아닌 user manager에서 다음 방어를 더합니다.

- `NoNewPrivileges`, 빈 capability/ambient capability 집합
- strict read-only filesystem view와 명시한 state/work/runtime write path
- private `/tmp`와 `/dev`, kernel tunable/module/log/control-group 보호
- 다른 UID의 `/proc` 가림, namespace 생성 제한, 일반 Unix/IPv4/IPv6 외 socket
  family 제한
- SUID/SGID 제한, personality/clock/hostname/realtime 보호
- `KillMode=mixed`, bounded stop timeout, 최종 cgroup SIGKILL과 guard/runtime
  종료 후 제한적 restart
- 낮은 CPU/I/O 우선순위

action도 같은 unit/cgroup과 filesystem 정책을 상속합니다. 필요한 write path만
drop-in으로 추가하세요. 이 hardening은 syscall filter나 network namespace가
아니며, action의 일반 네트워크 접근을 막지 않습니다.

## 보안 배포 체크리스트

- 바이너리와 제3자 고지/SBOM을 검증된 배포 경로에서 설치합니다.
- config/artifact/work/state 부모를 UID 소유 `0700`으로 만듭니다.
- `idlepilot import` 결과 경로와 `executable_sha256` pin을 사용합니다.
- action이 daemonize/setsid하지 않는지 코드와 직접 종료 시험으로 확인합니다.
- `wifi`, `power`, `idle`을 disable/ignore한 설정의 경고를 승인 절차에 남깁니다.
- `check`와 `doctor`로 실제 장비에서 `unknown` reason을 해소합니다.
- systemd drop-in은 최소 write path만 허용합니다.
- journal의 `fault`, `process_group_not_empty`, `supervisor_error`를 감시합니다.
- unresolved launch-intent startup 오류에서는 자동 재시작을 멈추고 cgroup/process
  cleanup을 확인한 뒤 state를 보존·회전합니다.
- `terminal_result_unknown` 또는 persisted fault에서도 자동 재시작하지 않고 작업의
  terminal 결과/외부 부작용과 fault reason을 확인한 뒤 state를 보존·회전합니다.
- config를 의미 있게 바꾸거나 state schema v1에서 업그레이드할 때도 service와
  cgroup을 완전히 멈추고 기존 v2/v1 state를 증거로 보존·회전한 뒤 중복 실행
  가능성을 승인합니다.
- 업그레이드 전 service를 정상 중지하고 status가 stopped인지 확인합니다.

보안 문제를 공개하기 전 프로젝트 관리자가 지정한 private 신고 채널이 있다면
그 채널을 사용하세요. 이 소스 트리 자체에는 원격 수집 또는 자동 신고 기능이
없습니다.
