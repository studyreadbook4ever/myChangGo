#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir"

if ! command -v systemd-analyze >/dev/null 2>&1; then
    echo "systemd-analyze is required to verify the packaged user unit" >&2
    exit 1
fi

# `systemd-analyze verify` treats an uninstalled ExecStart and man page as
# errors. Verify the exact unit text except for substituting a known local
# executable; `--man=no` keeps this source-tree check independent of install
# state. The release archive still contains the original paths.
verify_dir=$(mktemp -d "${TMPDIR:-/tmp}/idlepilot-systemd-verify.XXXXXX")
cleanup() {
    rm -rf -- "$verify_dir"
}
trap cleanup EXIT HUP INT TERM

sed 's|^ExecStart=/usr/bin/idlepilot |ExecStart=/usr/bin/true |' \
    packaging/systemd/user/idlepilot@.service \
    >"$verify_dir/idlepilot@.service"

if cmp -s packaging/systemd/user/idlepilot@.service \
    "$verify_dir/idlepilot@.service"; then
    echo "systemd verification substitution did not match ExecStart" >&2
    exit 1
fi

systemd-analyze --user --man=no verify "$verify_dir/idlepilot@.service"
