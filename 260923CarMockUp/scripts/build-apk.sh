#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

if ! command -v java >/dev/null 2>&1; then
  echo "JDK 17 or 21 is required. Set JAVA_HOME and retry." >&2
  exit 1
fi

ANDROID_SDK_PATH="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [[ -z "$ANDROID_SDK_PATH" && ! -f android/local.properties ]]; then
  echo "Set ANDROID_HOME to an Android SDK with platform 35 and Build Tools 34.0.0." >&2
  exit 1
fi
if [[ -n "$ANDROID_SDK_PATH" ]]; then
  export ANDROID_HOME="$ANDROID_SDK_PATH"
fi

if [[ ! -d node_modules ]]; then npm ci; fi
npm run build

# dist is disposable build output; never package the source or user data.
rm -rf android/app/src/main/assets
mkdir -p android/app/src/main/assets downloads
cp -R dist/. android/app/src/main/assets/

(
  cd android
  ./gradlew --no-daemon assembleDebug lintDebug
)
cp android/app/build/outputs/apk/debug/app-debug.apk downloads/DriveMate-demo.apk
(
  cd downloads
  node --input-type=module -e 'import {readFileSync, writeFileSync} from "node:fs"; import {createHash} from "node:crypto"; const filename="DriveMate-demo.apk"; writeFileSync(filename+".sha256", createHash("sha256").update(readFileSync(filename)).digest("hex")+"  "+filename+"\n");'
)
echo "APK: $PROJECT_ROOT/downloads/DriveMate-demo.apk"
echo "Demo uses the local Android debug certificate. Never commit its signing key."
