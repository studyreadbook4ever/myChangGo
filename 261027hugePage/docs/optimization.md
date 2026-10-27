# 최적화와 측정 기록 — 2026-10-27

이번 변경은 **상태 조회 비용**과 **UID 차단 시 마지막 대여 영역까지 회수하는 지연**을 줄입니다.
대여·반환 전체가 빨라졌다는 결론이나 SQL 처리량 향상은 주장하지 않습니다.

최종 측정 대상 바이너리의 SHA256은 다음과 같습니다.

```text
이전: 21b41b65f15b6a4a705da0719a90e9622f7db776f35708f6c76e46cab2f9a820
최종: c9d944affcdafa3b1ebcceb8db38ad7bebb4a0b5f1888fcc77997a6bb533e795
```

원본 JSON에는 바이너리 해시, 측정 환경과 개별 반복 결과가 있습니다.
네이티브 비교에는 데몬 소스 파일별 해시, 측정 프로그램·응답 파서·헤더 해시와 컴파일 명령도 있습니다.

## 무엇을 바꿨는가

`STATUS`는 실제 메모리 상태를 확인하기 위해 `/proc/self/smaps`를 읽습니다.
기존에는 각 줄에 여러 번 `sscanf`를 적용했습니다. 변경 후에는 매핑 헤더와 필요한 항목을
접두사로 구분하고, 해당 항목의 숫자만 변환합니다. 실제 메모리 통계를 읽는 방식과 응답 필드는 유지합니다.

`DENY UID`는 기존에 해당 UID의 슬롯 하나를 회수하고 새 슬롯을 선할당한 다음,
다음 슬롯을 회수했습니다. 이제 해당 UID의 **모든 기존 객체를 먼저 무효화한 뒤** 새 슬롯들을
선할당합니다. 뒤쪽 슬롯이 앞쪽 슬롯의 재할당을 기다리며 유효하게 남는 시간을 줄입니다.
성공 응답은 이전과 같이 재할당 시도가 끝난 뒤 반환하며, 재할당 실패 슬롯은 `degraded`로 남습니다.

## STATUS와 대여·반환 측정

호스트는 Linux 7.0.10-arch1-1, Intel Celeron N5095, 4 CPU입니다.
plain·THP 각각에 대해 2 MiB와 16 MiB 슬롯 두 개를 사용했습니다.
각 조건에서 새 데몬으로 이전·최종 버전을 **6회 교대로 비교**했고, 매번 준비 반복 20회를
제외한 250회를 계측했습니다. 데몬은 CPU 2, 네이티브 측정 클라이언트는 CPU 3에 고정했습니다.
다른 테스트 작업과는 순차 실행했습니다.

요청 시간은 C 프로그램의 `CLOCK_MONOTONIC`으로 측정합니다. Python은 실행과 결과 수집을
담당하며 개별 요청을 계측하지 않습니다. 기존 `SOCK_SEQPACKET` 연결에서 대여, 매핑 후 양 끝
바이트 접근과 해제, 반환과 새 슬롯 선할당을 구분합니다. 별도의 네이티브 반복에서 전체 `STATUS`
응답 시간을 측정합니다. 클라이언트가 테이블 전체를 순회하는 실험은 아닙니다.

아래 감소율은 각 반복의 `최종 / 이전` 비율을 구한 뒤 그 중앙값으로 계산했습니다.
전체 샘플을 합친 백분위수나, 두 버전의 집계 중앙값을 단순히 나눈 수치와는 다릅니다.

| 백엔드 | 슬롯 크기 | STATUS p50 감소율 | STATUS 데몬 CPU 시간 감소율 |
| --- | ---: | ---: | ---: |
| plain | 2 MiB | 22.6% | 30.0% |
| plain | 16 MiB | 7.5% — 변동 큼 | 7.8% |
| THP | 2 MiB | 27.0% | 23.8% |
| THP | 16 MiB | 27.4% | 19.1% |

plain 16 MiB의 STATUS p50 비율은 반복별로 0.44–1.44였으므로 이 조건에서 일관된 개선이
입증됐다고 보기는 어렵습니다. 나머지 세 조건은 여섯 반복 모두 STATUS p50이 줄었습니다.
데몬 CPU 시간은 측정 반복 전후 `/proc/PID/stat`의 차이이며 해상도는 10 ms입니다.
따라서 짧은 구간의 작은 CPU 차이는 정밀하게 해석하지 않아야 합니다.

대여·반환의 일반적인 속도 향상은 입증하지 못했습니다. 반환과 새 슬롯 선할당의 짝지은 p50은
plain 2 MiB에서 3.7% 증가, plain 16 MiB에서 0.2% 증가, THP 2 MiB에서 4.6% 감소,
THP 16 MiB에서 6.0% 증가했습니다. 해당 경로를 변경하지 않은 최종 빌드에서도
실행 환경의 변동이 남으므로, 일부 조건만 골라 전체 대여 성능이 좋아졌다고 해석하지 않습니다.

별도 `strace` 실행으로 수집한 대여·반환·STATUS 시나리오의 syscall별 호출 횟수는
네 조건 모두 이전과 최종이 같았습니다. 추적 실행의 지연은 위 성능 통계에서 제외했습니다.
관측된 THP 매핑은 두 슬롯의 전체 용량인 4 MiB 또는 32 MiB였고, 호스트 HugeTLB 예약량은
변경하지 않았습니다.

원본: [최종 네이티브 A/B 결과](../results/optimization-native-ab.json).

## DENY의 마지막 FD 무효화 지연

16 MiB 슬롯 8개, 총 128 MiB를 모두 대여한 뒤 같은 UID를 차단했습니다.
각 버전의 준비 실행 한 번을 제외하고 이전·최종 순서를 바꾸며 각각 8회 측정했습니다.
마지막 슬롯의 오래된 FD에 `fstat`를 반복해 파일 크기가 0이 되는 시점과,
새 슬롯 선할당을 마친 `DENY` 응답 시점을 따로 기록했습니다.

| 백엔드 | 마지막 FD 크기가 0이 되는 시간 p50 | 감소율 | 재할당 후 DENY 응답 p50 |
| --- | ---: | ---: | ---: |
| plain | 73.39 → 14.79 ms | 79.8% | 84.03 → 85.05 ms |
| THP | 36.71 → 0.452 ms | 98.8% | 42.61 → 42.07 ms |

개선된 것은 **뒤쪽 대여 객체의 무효화 시점**입니다. 새 슬롯을 다시 만드는 작업량은 그대로이며,
재할당까지 끝내는 전체 응답 시간이 빨라졌다는 근거는 없습니다.

이 실험의 클라이언트는 FD만 보유하며 `mmap`을 만들지 않습니다. 따라서 위 수치는 임의의
클라이언트 매핑에 대한 TLB 무효화 완료 시간이 아닙니다. Python의 `fstat` 관측 반복이 CPU 하나를
사용하며, 관측·스케줄링·IPC 비용도 포함합니다. 네이티브 STATUS 계측과 다른 실험입니다.
실제 매핑의 회수와 SIGBUS 동작은 별도의 회귀 테스트 및 HugeTLB VM에서 검증합니다.

원본: [plain DENY](../results/optimization-deny-plain.json),
[THP DENY](../results/optimization-deny-thp.json),
[재할당 시작 전 전체 FD 무효화 회귀 검사](../results/optimization-deny-batch-test.log).

## 채택하지 않은 변경

데몬의 매핑을 먼저 `munmap`한 뒤 파일을 축소하는 순서도 시험했습니다.
반환 비용의 일관된 개선을 확인하지 못해 최종 코드에서 되돌렸습니다.
[실험 원본](../results/optimization-experiment-unmap.json)은 최종 결과와 분리해 보존했습니다.
이 파일의 최종 측정 대상은 중간 실험 빌드이며 위의 `c9d944…` 빌드가 아닙니다.

## 재현

다음 명령은 프로젝트 루트에서 실행합니다. 비교용 이전 소스는 현재 소스의 복사본에
[이전 버전 복원 패치](optimization-baseline.patch)를 적용해 만듭니다.
현재 `src/`에는 패치를 적용하지 않습니다.

```sh
make all
mkdir -p build/optimization-baseline/src
cp src/daemon.c src/capacity.c src/capacity.h build/optimization-baseline/src/
cp Makefile build/optimization-baseline/
patch --directory=build/optimization-baseline/src --strip=0 < docs/optimization-baseline.patch
make -C build/optimization-baseline build/hugekeeperd

python3 scripts/compare_performance.py \
  --before build/optimization-baseline/build/hugekeeperd \
  --before-source build/optimization-baseline \
  --after build/hugekeeperd \
  --daemon-cpu 2 --client-cpu 3 --strace \
  --output build/optimization-native-rerun.json

python3 scripts/benchmark_revoke.py \
  --baseline build/optimization-baseline/build/hugekeeperd \
  --daemon build/hugekeeperd --backend plain --slots 8 --slot-mib 16 --rounds 8 \
  --output build/optimization-deny-plain-rerun.json

python3 scripts/benchmark_revoke.py \
  --baseline build/optimization-baseline/build/hugekeeperd \
  --daemon build/hugekeeperd --backend thp --slots 8 --slot-mib 16 --rounds 8 \
  --output build/optimization-deny-thp-rerun.json
```

CPU 2·3을 사용할 수 없는 환경에서는 사용 가능한 CPU 번호로 바꾸거나 두 고정 옵션을 생략합니다.
`--strace`에는 `strace` 설치가 필요하며, 생략해도 네이티브 시간 측정은 실행됩니다.
기본 네이티브 측정 풀은 최대 32 MiB, DENY 측정 풀은 128 MiB이며,
스크립트는 256 MiB보다 큰 풀 설정을 허용하지 않습니다.
THP 확보 여부와 측정값은 호스트 환경에 따라 달라집니다.

복원된 `daemon.c`의 SHA256은 다음과 같아야 합니다. 컴파일러 버전이나 디버그 정보의 빌드 경로가
달라지면 같은 소스라도 실행 파일 SHA256은 달라질 수 있습니다.

```text
ea0ff494826bb2cf39e5afdea0e3a783a28316bb90ffcd60e7340c3d4ab1c408
```

## 회귀 검증 기록과 범위

초기 구현의 [실행 검증 기록](validation.md)은 이전 빌드에 대한 기록입니다.
최종 최적화 빌드의 결과는 다음과 같습니다.

| 검증 | 결과 | 원본 |
| --- | --- | --- |
| 호스트 plain | 53개 통과 | [로그](../results/tests-host-plain.log) |
| 호스트 THP | 53개 통과 | [로그](../results/tests-host-thp.log) |
| ASan·UBSan | `Ran 52 tests`, `OK (skipped=2)` | [로그](../results/tests-host-asan.log) |
| 실제 HugeTLB VM | 70개 통과 | [로그](../results/hugetlb-vm-latest.txt) |
| 동시 대여·회수 스트레스 | plain 4,000회 + THP 4,000회 통과 | [plain](../results/stress-host-plain.json), [THP](../results/stress-host-thp.json) |
| Python 패키지·설치 | 빌드와 설치 검증 통과 | [패키지](../results/package-build.log), [설치](../results/install-staging.log) |

테스트 실행 명령과 바이너리 해시는 [최종 집계](../results/tests-host-summary.json)에 있습니다.
ASan에서는 큰 가상 주소 공간과 충돌하는 `RLIMIT_AS` 고갈 주입 하나와,
ASan 라이브러리 로딩 순서와 충돌하는 `LD_PRELOAD` 회수 순서 검사 클래스를 제외했습니다.
해당 검사는 일반 빌드에서 실행했습니다.

초기 재검증 중 연결 폭주 테스트가 Unix 소켓 backlog가 꽉 찼을 때의 `EAGAIN`을 처리하지 못했습니다.
테스트가 그 정상적인 혼잡 응답을 허용하고 관리 요청과 유휴 CPU를 계속 검증하도록 수정했습니다.
이후 동일 CPU에 고정한 plain·ASan 반복 검사 총 20회와 전체 회귀 검사를 통과했습니다.
[반복 결과](../results/optimization-pressure-repeat.log)와
[초기 plain 실패](../results/optimization-initial-failure-plain.log),
[초기 ASan 실패](../results/optimization-initial-failure-asan.log)를 함께 보존했습니다.

Clang 정적 분석은 `memory_stats`의 `hugetlb` 인자가 NULL이라고 가정한 경고 하나를 냈습니다.
이 함수는 `static`이고 유일한 호출이 유효한 지역 변수의 주소를 전달하므로 현재 프로그램에서는
그 경로에 도달할 수 없다고 소스 검토와 독립 검토에서 판단했습니다.
경고를 숨기거나 경고가 없었다고 집계하지 않았으며, 근거는
[정적 분석 기록](../results/static-analysis/summary.json)에 남겼습니다.

이 결과는 하나의 호스트에서 작은 풀과 제어 경로를 측정한 것입니다.
큰 DB의 실제 쿼리 처리량, 랜덤 접근 지연 또는 DRAM 대역폭의 개선을 입증하지 않습니다.
