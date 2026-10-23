# 제3자 구성요소 고지

이 디렉터리의 자체 작성 코드에는 [Unlicense](LICENSE)를 적용합니다. 제3자 코드와 의존성에는 각 원저작자의 라이선스·저작권 고지가 그대로 적용되며, 자체 코드의 Unlicense가 이를 대체하지 않습니다. 상위 저장소의 다른 프로젝트 라이선스도 변경하지 않습니다.

- Sites Vite 플러그인: Copyright (c) 2026 OpenAI, MIT License. 원문은 [scripts/vite/sites-vite-plugin.LICENSE](scripts/vite/sites-vite-plugin.LICENSE)에 보존합니다.
- shadcn Tailwind 구성요소: Copyright (c) 2023 shadcn, MIT License. 원문은 [vendor/shadcn-tailwind-4.13.0.LICENSE.md](vendor/shadcn-tailwind-4.13.0.LICENSE.md)에 보존합니다.
- React, React Native Web(클라이언트), Vinext, Cloudflare 도구, Zod 등 npm 의존성은 각 패키지의 LICENSE·NOTICE 및 배포 조건을 따릅니다. 정확한 버전은 `package-lock.json`에 기록되어 있으며, 재배포할 때 해당 패키지의 고지도 함께 보존해야 합니다.
- 가져온 소스에 별도 라이선스·저작권 주석이 있으면 해당 고지가 우선합니다. 이 파일은 제3자 구성요소의 원래 이용 조건을 재지정하지 않습니다.

패키지 루트의 `license: "Unlicense"`는 자체 프로젝트 코드에 대한 메타데이터입니다. 잠금 파일의 개별 의존성 라이선스 메타데이터는 변경하지 않았습니다.
