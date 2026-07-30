#!/usr/bin/env bash

set -Eeuo pipefail

KIRINUKI_SCRIPT_DIR="$(
  cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
  pwd -P
)"

if [[ "$(uname -s 2>/dev/null || true)" != "Linux" ]]; then
  printf '%s\n' "Kirinuki Linux 도우미는 현재 Linux만 지원합니다." >&2
  exit 1
fi

KIRINUKI_NODE_COMMAND="${KIRINUKI_NODE_BINARY:-node}"
if ! KIRINUKI_RESOLVED_NODE="$(command -v -- "$KIRINUKI_NODE_COMMAND" 2>/dev/null)"; then
  printf '%s\n' \
    "Node.js 20.9 이상을 찾지 못했습니다." \
    "배포판 패키지 관리자나 https://nodejs.org/ 에서 Node.js와 npm을 설치한 뒤 다시 실행하세요." \
    "이 도우미는 관리자 권한을 자동으로 얻거나 시스템 패키지를 임의로 설치하지 않습니다." >&2
  exit 1
fi

if ! "$KIRINUKI_RESOLVED_NODE" -e '
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  process.exit(major > 20 || (major === 20 && minor >= 9) ? 0 : 1);
'; then
  printf '%s\n' \
    "현재 Node.js는 $("$KIRINUKI_RESOLVED_NODE" --version 2>/dev/null || printf '알 수 없음')입니다." \
    "Kirinuki에는 Node.js 20.9 이상이 필요합니다." >&2
  exit 1
fi

exec "$KIRINUKI_RESOLVED_NODE" "$KIRINUKI_SCRIPT_DIR/scripts/linux-helper.mjs" "$@"
