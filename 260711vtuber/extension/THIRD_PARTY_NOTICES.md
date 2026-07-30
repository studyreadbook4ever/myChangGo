# Third-party notices

The first-party code in `260711vtuber` is marked `UNLICENSED`. No project-wide
license is offered, and public visibility of the repository grants no
permission to use, copy, modify, or redistribute that first-party code.

The components listed below retain their own licenses and copyright notices.
Those terms apply only to the respective third-party components; they do not
license the surrounding first-party project.

## Mediabunny 1.51.0

- Copyright © 2026-present Vanilagy and contributors
- License: Mozilla Public License 2.0
- Upstream source: https://github.com/Vanilagy/mediabunny
- Corresponding version: `mediabunny@1.51.0`, locked in `package-lock.json`
- Exact source package:
  https://registry.npmjs.org/mediabunny/-/mediabunny-1.51.0.tgz
- npm integrity:
  `sha512-u327374xU8Ho0gCaMII7fUK8t0PnqkabCox1k8uUwvgvGb9o6YQGZEG2Qr4DTe7nTMpzfL7ukgnHDvDROySZ+Q==`

The Extension uses Mediabunny to read, encode, and mux local media. The
upstream files are bundled without a local patch. Corresponding TypeScript
source is included in the exact npm source package above and is also available
from the upstream repository. The full MPL 2.0 text is distributed as
`extension/licenses/MEDIABUNNY-MPL-2.0.txt`.

## AudSeg 0.1.0

- Copyright © 2026 AudSeg contributors
- License: MIT
- Source in this repository: `AudSeg/`
- Browser port: `260711vtuber/src/editor/audseg.js`

The editor includes a JavaScript port of AudSeg's model-free audio-activity
segmentation algorithm. It runs in the browser and creates timing regions
without transcribing speech. The complete AudSeg MIT text is distributed as
`extension/licenses/AUDSEG-MIT.txt`.

## Pretendard 1.3.9 (ExtraBold)

- Copyright © 2021 Kil Hyung-jin
- License: SIL Open Font License 1.1
- Reserved Font Name: Pretendard
- Font source:
  https://github.com/orioncactus/pretendard/blob/v1.3.9/packages/pretendard/dist/web/static/woff2/Pretendard-ExtraBold.woff2
- License source:
  https://github.com/orioncactus/pretendard/blob/v1.3.9/LICENSE
- Bundled file: `Pretendard-ExtraBold.woff2`
- Font SHA-256:
  `dd7c1e156f508eb962acc7a33a7a1896d1e0b71e11156fad96e731689ceb6dc3`
- License SHA-256:
  `d31ddd9f2bed32fd7e302a205cf2380ba0de6529152d239ef99cfb6f261bfc04`

The Extension bundles the official, unmodified ExtraBold WOFF2 from upstream
release `v1.3.9`. Its copyright notice and full SIL Open Font License 1.1 text
are distributed as `extension/licenses/PRETENDARD-OFL-1.1.txt`.

## Paperlogy 1.001 (8 ExtraBold)

- Copyright © 2024 The PAPERLOGY Authors
- License: SIL Open Font License 1.1
- Official project: https://freesentation.blog/paperlogyfont
- Upstream source: https://github.com/Freesentation/paperlogy
- Pinned commit: `8ef35f53b318c7ca914c52b1b382b9a8bad07a61`
- Font source:
  https://github.com/Freesentation/paperlogy/blob/8ef35f53b318c7ca914c52b1b382b9a8bad07a61/woff2/Paperlogy-8ExtraBold.woff2
- License source:
  https://github.com/Freesentation/paperlogy/blob/8ef35f53b318c7ca914c52b1b382b9a8bad07a61/OFL%20license.txt
- Bundled file: `Paperlogy-8ExtraBold.woff2`
- Font SHA-256:
  `5047db061c39ec5ed5c9d0b71c7aaad4b9547ed15ce48d1cd74090169f132bc0`
- License SHA-256:
  `603b2e7ef9effb9037b0b67f0530cacdc05e71a4e569032d7e4d98c2e6763135`

The Extension bundles the official 8 ExtraBold WOFF2 from the pinned upstream
commit. The full SIL Open Font License 1.1 text is distributed as
`extension/licenses/PAPERLOGY-OFL-1.1.txt`.

## Source locations

The first-party project source, build scripts, and dependency lockfile are in
the `260711vtuber` directory:

https://github.com/studyreadbook4ever/myChangGo

The license texts named above travel with the Extension distribution. Upstream
source links and exact dependency coordinates are retained here so recipients
can identify the independently licensed components.
