#!/bin/sh
set -eu
umask 077

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir"

if ! cargo_metadata=$(cargo +stable metadata --locked --no-deps --format-version 1); then
    echo "rights verification failed: cannot read Cargo metadata" >&2
    exit 1
fi
case "$cargo_metadata" in
    *'"license":null'*) ;;
    *)
        echo "rights verification failed: Cargo metadata declares a project license" >&2
        exit 1
        ;;
esac
case "$cargo_metadata" in
    *'"license_file":null'*) ;;
    *)
        echo "rights verification failed: Cargo metadata declares a project license file" >&2
        exit 1
        ;;
esac

scan_output=$(mktemp "${TMPDIR:-/tmp}/idlepilot-rights-scan.XXXXXX")
cleanup() {
    rm -f -- "$scan_output"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

project_license_name='unlic''ense|licen[cs]e([._-].*)?|copying([._-].*)?'
if find . -maxdepth 1 \( -type f -o -type l \) -printf '%f\n' |
    grep -Eix "$project_license_name" >"$scan_output"; then
    sed -n '1,200p' "$scan_output" >&2
    echo "rights verification failed: root project license file is present" >&2
    exit 1
else
    grep_status=$?
    if [ "$grep_status" -ne 1 ]; then
        echo "rights verification failed: cannot inspect root files" >&2
        exit 1
    fi
fi

spdx_marker='SPDX-License-Identi''fier:'
old_grant='Unlic''ense'
if grep -r -n -F --exclude-dir=.git --exclude-dir=target --exclude-dir=dist \
    -- "$spdx_marker" . >"$scan_output"; then
    sed -n '1,200p' "$scan_output" >&2
    echo "rights verification failed: project SPDX license header is present" >&2
    exit 1
else
    grep_status=$?
    if [ "$grep_status" -ne 1 ]; then
        echo "rights verification failed: cannot scan SPDX headers" >&2
        exit 1
    fi
fi
if grep -r -n -F --exclude-dir=.git --exclude-dir=target --exclude-dir=dist \
    -- "$old_grant" . >"$scan_output"; then
    sed -n '1,200p' "$scan_output" >&2
    echo "rights verification failed: stale project permission grant is present" >&2
    exit 1
else
    grep_status=$?
    if [ "$grep_status" -ne 1 ]; then
        echo "rights verification failed: cannot scan project permission claims" >&2
        exit 1
    fi
fi

package_list=$(cargo +stable package --locked --allow-dirty --list)
printf '%s\n' "$package_list" >"$scan_output"
if grep -Eix "$project_license_name" "$scan_output" >/dev/null; then
    echo "rights verification failed: Cargo package contains a project license file" >&2
    exit 1
else
    grep_status=$?
    if [ "$grep_status" -ne 1 ]; then
        echo "rights verification failed: cannot inspect Cargo package file list" >&2
        exit 1
    fi
fi

printf '%s\n' 'verified absence of a project license grant'
