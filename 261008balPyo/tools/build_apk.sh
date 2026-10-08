#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v flutter >/dev/null 2>&1; then
    printf 'Flutter SDK를 설치하고 flutter를 PATH에 추가해주세요.\n' >&2
    exit 1
fi

flutter --suppress-analytics pub get
flutter --suppress-analytics analyze
flutter --suppress-analytics test
flutter --suppress-analytics build apk --release
mkdir -p dist
cp build/app/outputs/flutter-apk/app-release.apk dist/261008balPyo.apk
printf '\n완료: %s/dist/261008balPyo.apk\n' "$PWD"
