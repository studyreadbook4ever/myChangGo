# Third-party notices

CHZZK Kirinuki Studio bundles the following third-party browser libraries. No
third-party Node.js native module is shipped in the extension archive.

## Mediabunny 1.51.0

- Copyright © 2026-present Vanilagy and contributors
- License: Mozilla Public License 2.0
- Upstream source: https://github.com/Vanilagy/mediabunny
- Corresponding version: `mediabunny@1.51.0`, locked in `package-lock.json`

The extension uses Mediabunny to read, encode, and mux local media. The
corresponding source can be obtained from the upstream repository or the exact
npm package resolved by this repository's lockfile. The full MPL 2.0 text is
included as `licenses/MEDIABUNNY-MPL-2.0.txt`.

## Transformers.js 3.8.1

- Copyright © Hugging Face
- License: Apache License 2.0
- Upstream source: https://github.com/huggingface/transformers.js
- Corresponding version: `@huggingface/transformers@3.8.1`, locked in
  `package-lock.json`

The full Apache License 2.0 text is included as
`licenses/TRANSFORMERS-APACHE-2.0.txt`.

## ONNX Runtime Web

- Copyright © Microsoft Corporation
- License: MIT
- Upstream source: https://github.com/microsoft/onnxruntime
- Bundled versions: `onnxruntime-web@1.22.0-dev.20250409-89f8206ba4` and
  `onnxruntime-common@1.21.0`

The MIT license notice is included as `licenses/ONNXRUNTIME-MIT.txt`.

## Downloaded model data

Whisper Tiny and Whisper Small model data are not part of the extension
archive. They are downloaded on demand from their pinned Hugging Face model
revisions. Their model cards and repositories contain the applicable model
license and attribution information.

## This extension's corresponding source

The extension source, build scripts, exact dependency lockfile, and local
patch-free bundling procedure are in the `260711vtuber` directory of:

https://github.com/studyreadbook4ever/myChangGo
