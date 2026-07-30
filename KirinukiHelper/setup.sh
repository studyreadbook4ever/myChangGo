#!/usr/bin/env bash

set -Eeuo pipefail

KIRINUKI_SCRIPT_DIR="$(
  cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
  pwd -P
)"

exec bash "$KIRINUKI_SCRIPT_DIR/kirinuki.sh" setup "$@"
