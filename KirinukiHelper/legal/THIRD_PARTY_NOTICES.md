# Third-party notices

KirinukiHelper의 프로젝트 작성 코드는 배포물의 `LICENSE`에 적힌 MIT
라이선스로 제공됩니다. 아래 구성요소는 그 MIT 라이선스로 재허가되는 것이
아니며, 각각 표시된 MPL-2.0, OFL-1.1 또는 MIT 조건과 저작권 고지를 그대로
유지합니다.

CHZZK Kirinuki Studio bundles the following third-party browser libraries. No
third-party Node.js native module is shipped in the extension archive.

## Mediabunny 1.51.0

- Copyright © 2026-present Vanilagy and contributors
- License: Mozilla Public License 2.0
- Upstream source: https://github.com/Vanilagy/mediabunny
- Corresponding version: `mediabunny@1.51.0`, locked in `package-lock.json`
- Exact source package: https://registry.npmjs.org/mediabunny/-/mediabunny-1.51.0.tgz
- npm integrity: `sha512-u327374xU8Ho0gCaMII7fUK8t0PnqkabCox1k8uUwvgvGb9o6YQGZEG2Qr4DTe7nTMpzfL7ukgnHDvDROySZ+Q==`

The extension uses Mediabunny to read, encode, and mux local media. The
upstream files are bundled without a local patch. Corresponding TypeScript
source is included in the exact npm source package above and can also be
obtained from the upstream repository. The full MPL 2.0 text is included as
`licenses/MEDIABUNNY-MPL-2.0.txt`.

## AudSeg 0.1.0

- Copyright © 2026 AudSeg contributors
- License: MIT
- Source in this repository: `AudSeg/`
- Browser port: `src/editor/audseg.js`

The editor includes a JavaScript port of AudSeg's model-free audio-activity
segmentation algorithm. It runs entirely in the browser and creates timing
regions without transcribing speech. The full MIT text is included in the
Extension package as `licenses/AUDSEG-MIT.txt`.

## Pretendard 1.3.9 (ExtraBold)

- Copyright © 2021 Kil Hyung-jin
- License: SIL Open Font License 1.1
- Reserved Font Name: Pretendard
- Font source: https://github.com/orioncactus/pretendard/blob/v1.3.9/packages/pretendard/dist/web/static/woff2/Pretendard-ExtraBold.woff2
- License source: https://github.com/orioncactus/pretendard/blob/v1.3.9/LICENSE
- Bundled file: `Pretendard-ExtraBold.woff2`
- Font SHA-256: `dd7c1e156f508eb962acc7a33a7a1896d1e0b71e11156fad96e731689ceb6dc3`
- License SHA-256: `d31ddd9f2bed32fd7e302a205cf2380ba0de6529152d239ef99cfb6f261bfc04`

The extension bundles the official, unmodified ExtraBold WOFF2 from the
upstream `v1.3.9` release. The copyright notice and full SIL Open Font License
1.1 text are included as `licenses/PRETENDARD-OFL-1.1.txt`.

## Paperlogy 1.001 (8 ExtraBold)

- Copyright © 2024 The PAPERLOGY Authors
- License: SIL Open Font License 1.1
- Official project: https://freesentation.blog/paperlogyfont
- Upstream source: https://github.com/Freesentation/paperlogy
- Pinned commit: `8ef35f53b318c7ca914c52b1b382b9a8bad07a61`
- Font source: https://github.com/Freesentation/paperlogy/blob/8ef35f53b318c7ca914c52b1b382b9a8bad07a61/woff2/Paperlogy-8ExtraBold.woff2
- License source: https://github.com/Freesentation/paperlogy/blob/8ef35f53b318c7ca914c52b1b382b9a8bad07a61/OFL%20license.txt
- Bundled file: `Paperlogy-8ExtraBold.woff2`
- Font SHA-256: `5047db061c39ec5ed5c9d0b71c7aaad4b9547ed15ce48d1cd74090169f132bc0`
- License SHA-256: `603b2e7ef9effb9037b0b67f0530cacdc05e71a4e569032d7e4d98c2e6763135`

The extension bundles the official 8 ExtraBold WOFF2 from the pinned upstream
commit. The official OFL text is included byte-for-byte as
`licenses/PAPERLOGY-OFL-1.1.txt`.

## Runtime-downloaded local caption components

The following components are **not bundled in the extension archive**. On
Linux, `npm run caption-stack:setup` downloads them into the current user's
XDG data directory, verifies the exact byte size and SHA-256, and copies this
notice beside the installation.

### whisper.cpp v1.8.6

- Copyright © 2023-2026 The ggml authors
- License: MIT
- Upstream source: https://github.com/ggml-org/whisper.cpp
- Commit: `23ee03506a91ac3d3f0071b40e66a430eebdfa1d`
- Source archive SHA-256: `c8b0de473e9ec47a74bdf6104425c709261beeada8d6d7c1fec7432be701d032`
- License source: https://github.com/ggml-org/whisper.cpp/blob/23ee03506a91ac3d3f0071b40e66a430eebdfa1d/LICENSE

The setup command builds `whisper-server` locally without a repository patch.

### Quantized OpenAI Whisper models for whisper.cpp

- Copyright © 2022 OpenAI
- License: MIT
- Model repository: https://huggingface.co/ggerganov/whisper.cpp
- Repository revision: `5359861c739e955e79d9a303bcbc70fb988958b1`
- Original model source: https://github.com/openai/whisper
- Original license: https://github.com/openai/whisper/blob/main/LICENSE

The semantic profiles download exactly one of these converted multilingual
model files:

- `ggml-tiny-q5_1.bin` — SHA-256 `818710568da3ca15689e31a743197b520007872ff9576237bda97bd1b469c3d7`
- `ggml-base-q5_1.bin` — SHA-256 `422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898`
- `ggml-small-q5_1.bin` — SHA-256 `ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb`
- `ggml-medium-q5_0.bin` — SHA-256 `19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f`

### Silero VAD 6.2 converted for whisper.cpp

- Copyright © 2020-present Silero Team
- License: MIT
- Converted model repository: https://huggingface.co/ggml-org/whisper-vad
- Repository revision: `9ffd54a1e1ee413ddf265af9913beaf518d1639b`
- Installed file: `ggml-silero-v6.2.0.bin`
- File SHA-256: `2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987`
- Original project and license: https://github.com/snakers4/silero-vad

### MIT license for the runtime components above

- Copyright (c) 2023-2026 The ggml authors
- Copyright (c) 2022 OpenAI
- Copyright (c) 2020-present Silero Team

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## This extension's corresponding source

The extension source, build scripts, exact dependency lockfile, and local
patch-free bundling procedure are in the `KirinukiHelper` directory of:

https://github.com/studyreadbook4ever/myChangGo
