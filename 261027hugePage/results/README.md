# 검증 결과 안내

- `host-report.json`: 최종 최적화 빌드 검증의 요약과 원자료 위치.
- `tests-host-*`: 최종 plain·THP·ASan/UBSan 회귀 테스트.
- `stress-host-*`: 최종 빌드의 백엔드별 4,000회 동시 대여·반환·연결 종료·회수 검증.
- `hugetlb-vm-latest.txt`: 최종 빌드로 실행한 실제 HugeTLB VM 검증 70개.
- `optimization-native-ab.json`: 최종 변경 전후의 네이티브 교차 측정.
- `optimization-deny-*.json`: 128 MiB 풀에서 마지막 대여 FD가 0바이트가 되는 시점의 비교.
- `optimization-experiment-unmap.json`: 채택하지 않은 중간 실험. 최종 빌드의 결과가 아닙니다.
- `optimization-initial-failure-*.log`, `optimization-pressure-repeat.log`: 마지막 검증에서 발견한 테스트의 backlog 처리 오류와 수정 후 반복 검증.
- `static-analysis/`: 정적 분석 원본과 경고의 호출 경로 검토. 경고가 없었다는 보고가 아닙니다.
- `package-build.log`, `install-staging.log`: 최종 Python 패키지 빌드·설치 및 C 구성요소 설치 경로 검증.
- `artifact-sha256.txt`: 테스트에 사용한 소스와 로컬 빌드 산출물 해시. 빌드 바이너리는 저장소에 포함하지 않습니다.
- `baseline/`: 최적화 전 초기 구현의 기록을 보존한 디렉터리. 그 안의 경로 표기는 당시 프로젝트 루트 기준입니다.

측정 방법과 해석의 한계는 [최적화 기록](../docs/optimization.md), 사용법은 [README](../README.md)에 있습니다.
