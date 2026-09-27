# 직접 만든 PDF 테스트 자료

이 폴더의 정상 발표 자료, 문구, 도형, 벡터 풍경 이미지는 이 저장소를 위해
직접 만들었습니다. 외부 발표 템플릿·사진·폰트 파일은 포함하지 않습니다.
PDF의 표준 글꼴 이름만 참조하며 글꼴 바이너리를 삽입하지 않았습니다.
저장소의 소스 라이선스와 같은 조건으로 샘플을 사용하고 배포할 수 있습니다.

| 파일 | 확인할 항목 |
| --- | --- |
| `demo.pdf` | 3장, 16:9, 텍스트·색상 도형·벡터 풍경·표 형태 |
| `demo-4x3.pdf` | 4:3 원본을 16:9 영상 안에 비율 유지해서 배치 |
| `demo-portrait.pdf` | 세로 원본을 16:9 영상 안에 비율 유지해서 배치 |
| `demo-rotated.pdf` | PDF 페이지 `/Rotate 90` 처리 |
| `demo-prefixed.pdf` | PDF 서명 앞의 무해한 짧은 접두사 처리 |
| `malformed.pdf` | PDF 서명은 있지만 페이지 구조가 손상된 파일 |
| `not-a-pdf.pdf` | 확장자만 PDF인 일반 텍스트 입력 거부 |

비정상 입력은 오류 검증용이며 정상 발표 자료로 사용하지 마세요.

```sh
python3 tools/generate_fixtures.py
python3 tools/generate_fixtures.py --check
python3 -m unittest discover -s tools -p 'test_*.py' -v
```

Python 표준 라이브러리만 필요합니다. 매번 같은 파일이 생성되며
`manifest.json`에 SHA-256과 바이트 크기를 기록합니다. PDF에는 발표자 대본이나
노트를 넣지 않았습니다. 대본은 앱에서 페이지별로 별도 입력합니다.
