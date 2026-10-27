# 초기 구현 검증 기록 — 2026-10-27

이 문서는 최적화 전 구현의 기록입니다. 최신 결과는 [최적화 검증](optimization.md)을 보세요.

초기 빌드 SHA256:

```text
21b41b65f15b6a4a705da0719a90e9622f7db776f35708f6c76e46cab2f9a820
```

호스트는 Linux 7.0.10-arch1-1, x86_64, Intel Celeron N5095, 4 CPU,
약 7.5 GiB RAM입니다. 호스트 HugeTLB 예약량은 테스트 전후 0이었으며 변경하지 않았습니다.
실제 HugeTLB 검증은 KVM 게스트 내부에서 수행했습니다.

## 결과

| 검증 | 결과 | 원본 |
| --- | --- | --- |
| 호스트 plain | 50개 통과 | [로그](../results/baseline/tests-host-plain.log) |
| 호스트 THP | 동일 50개 통과 | [로그](../results/baseline/tests-host-thp.log) |
| ASan + UBSan | 49개 통과, 1개 제외 | [로그](../results/baseline/tests-host-asan.log) |
| 실제 HugeTLB VM | 70개 검증 통과 | [로그](../results/baseline/hugetlb-vm-latest.txt) |
| 동시 대여·회수 | plain 4,000회 + THP 4,000회 통과 | [호스트 종합 JSON](../results/baseline/host-report.json) |
| C 정적 분석 | Clang analyzer 진단 없음 | [분석 결과](../results/baseline/static-analysis/) |
| Python 배포 | wheel 빌드·격리 환경 설치·CLI 실행 성공 | [로그](../results/baseline/package-build.log) |

ASan은 큰 가상 주소 영역을 사용하므로 `RLIMIT_AS`를 20 MiB로 제한하는 고갈 주입 테스트 하나만
제외했습니다. 그 테스트는 일반 plain·THP 실행에서 통과했습니다.

호스트 검증에는 기본 접근 거부, UID 허용·차단, 대여 소유권, 반환·연결 종료·관리자 회수·FREE,
stale mmap의 SIGBUS, 오래된 FD 재확장 차단, seal 변경 거부, 새 슬롯 초기화,
풀 증감과 할당 실패 rollback, 정상 종료, 기존 소켓 보존, 잘못된 패킷과 과도한 FD 전달,
Python memoryview·GC 수명, C 응답 파서·FD 수명이 포함됩니다.

`RLIMIT_NOFILE=64`에서 데이터 연결 80개를 열어도 관리 요청이 처리되고,
연결 처리가 끝난 후 바쁜 반복 루프에 빠지지 않는 것을 검사했습니다.
스트레스 테스트는 FD 한도 256으로 제한해 8개 작업자가 반환·연결 단절·강제 회수를 무작위로
섞었습니다. 두 백엔드 스트레스는 병렬 실행했으므로 실행시간을 성능 비교에 사용하지 않습니다.

## 사용자 인터페이스 검증

- `--pages 2` → 2 MiB 페이지 2개, 한 개의 4 MiB 영역.
- `--pages 4 --slots 2` → 총 8 MiB, 각각 4 MiB인 두 대여 영역.
- 페이지 수를 생략하면 누락 메시지와 `[y/N]` 표시. 확인 전 소켓과 풀을 만들지 않음.
- 실제 PTY에서 Enter·`n`·`no`·다른 응답은 취소, `y`·`yes`는 최대 확보 진행.
- 리디렉션한 stdin의 `yes`는 승인으로 처리하지 않음.
- 호스트 최대 모드 테스트는 `--max-mib 4`로 제한해 호스트 RAM 전체를 채우지 않음.
- cgroup·주소 공간·잠금 메모리 한도 계산은 모의 커널 스냅샷 8개 테스트로 검증.
- `FREE` 후 활성 FD 크기 0, stale 접근 SIGBUS, 상주량·페이지 수 0, 이후 재증설 가능.

## 실제 HugeTLB 검증

384 MiB, 2 vCPU KVM 게스트를 사용했습니다. 디스크·네트워크·호스트 공유 디렉터리는 없습니다.
게스트에서만 2 MiB HugeTLB 페이지 16개를 예약했습니다.

hugetlbfs 파일시스템 식별자, 실제 free-page 수, HugeTLB 매핑 통계로 전용 페이지 사용을 확인했습니다.
private COW 매핑까지 회수 후 접근을 검증했고, 실제 UID/GID 65534·capability 0인 프로세스로
기본 거부 → 허용 후 매핑 → 차단 후 SIGBUS를 검사했습니다. 비특권 프로세스의 관리 소켓 접근도
거부됐습니다.

물리 HugeTLB 고갈 시 증설 rollback을 검증했습니다. 사용 중인 게스트 풀을 축소해 보충 실패를
유도한 뒤 `degraded=1`이 되는지, 페이지 공급 복구 후 `REFILL`이 성공하는지도 확인했습니다.

마지막으로 실제 PTY의 누락 파라미터 확인창에서 `yes`를 입력했습니다. 사용 가능한
**16페이지 / 32 MiB 전부**가 실제로 할당됐고 정상 종료 후 모두 반환됐습니다.
호스트 `HugePages_Total`은 계속 0입니다.

## 오버헤드 측정

2 MiB 슬롯 2개, 준비 반복 10회 뒤 300회 측정입니다. 기존 제어 연결에서의 요청·응답 시간이며
Python과 소켓 통신 비용을 포함합니다. 아래 두 벤치마크는 순차 실행했습니다.

| 항목 | plain | THP |
| --- | ---: | ---: |
| 대여 p50 | 66.826 µs | 64.826 µs |
| 대여 p95 | 191.476 µs | 193.731 µs |
| 반환 + 새 슬롯 선할당 p50 | 1,375.400 µs | 590.680 µs |
| 반환 + 새 슬롯 선할당 p95 | 2,598.542 µs | 1,545.637 µs |
| 2초 유휴 CPU | 0 ticks | 0 ticks |
| 풀 4 MiB 포함 데몬 RSS | 5,892 KiB | 5,888 KiB |
| 관측된 THP 매핑 | 0 MiB | 4 MiB / 4 MiB |

유휴 CPU 계측 해상도는 10 ms입니다. 0 ticks는 이 측정 구간에서 해상도 이상의 증가가 없었다는
뜻이며 CPU 비용이 수학적으로 0이라는 의미는 아닙니다. RSS에는 공유 라이브러리 등도 포함됩니다.

매핑 후 테이블 접근은 직접 포인터·mmap 접근이며 브로커 RPC가 없습니다.
반환 시 새 객체 할당·초기화가 필요하므로 슬롯이 커질수록 반환 비용도 커집니다.
내장 C 스캔은 작은 캐시 친화적 비교 실험으로, DB 성능이나 DRAM 대역폭 측정은 아닙니다.
특정 SQL 엔진에서의 성능 향상은 검증하지 않았습니다.

원본: [plain 벤치마크](../results/baseline/benchmark-host-plain.json),
[THP 벤치마크](../results/baseline/benchmark-host-thp.json).

## 재현

```sh
make test
HUGEKEEPER_TEST_BACKEND=thp make test
make sanitize
make clean all
python3 scripts/benchmark.py --backend plain --iterations 300 --idle-seconds 2
python3 scripts/benchmark.py --backend thp --iterations 300 --idle-seconds 2
python3 scripts/stress.py --backend plain --workers 8 --cycles 500
python3 scripts/stress.py --backend thp --workers 8 --cycles 500
./scripts/vm-test.sh
```

VM에는 읽을 수 있는 호스트 커널과 `/dev/kvm`, QEMU가 필요합니다.
Arch x86_64에서는 `python3 scripts/vm-bootstrap-qemu.py`가 서명 검증한 패키지를 프로젝트의
`build/vm-local` 아래에만 추출합니다. 호스트 패키지를 설치하지 않습니다.
다른 환경에서는 `HUGEKEEPER_VM_QEMU`와 `HUGEKEEPER_VM_KERNEL`로 경로를 지정하세요.

systemd 파일은 설치 예제이며 이 머신의 시스템 서비스로 설치·활성화하지 않았습니다.
SIGKILL 뒤 기존 매핑이 살아 있는 커널 수명 특성도 테스트로 확인했으며, 이 경우 자동 회수를
보장하지 않습니다. 자세한 수명·권한 경계는 [README](../README.md#접근-제어와-수명-경계)에 있습니다.
