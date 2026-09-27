#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
stage=$(mktemp -d "${TMPDIR:-/tmp}/idlepilot-reproducible.XXXXXX")
target_stage=
cleanup() {
    rm -rf -- "$stage"
    if [ -n "$target_stage" ]; then
        rm -rf -- "$target_stage"
    fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$project_dir/target"
target_stage=$(mktemp -d "$project_dir/target/idlepilot-repro-targets.XXXXXX")

epoch=${SOURCE_DATE_EPOCH:-0}
for build in first second; do
    mkdir -p "$stage/$build"
    mkdir -m 0700 "$target_stage/$build"
    SOURCE_DATE_EPOCH="$epoch" \
        IDLEPILOT_DIST_DIR="$stage/$build" \
        CARGO_TARGET_DIR="$target_stage/$build" \
        "$project_dir/scripts/build-dist.sh"
done

first_archive=$(find "$stage/first" -maxdepth 1 -type f -name '*.tar.gz' -print)
second_archive=$(find "$stage/second" -maxdepth 1 -type f -name '*.tar.gz' -print)
if [ -z "$first_archive" ] || [ -z "$second_archive" ]; then
    echo "reproducibility check failed: release archive missing" >&2
    exit 1
fi
if ! cmp -s "$first_archive" "$second_archive"; then
    echo "reproducibility check failed: consecutive archives differ" >&2
    exit 1
fi
if ! cmp -s "$first_archive.sha256" "$second_archive.sha256"; then
    echo "reproducibility check failed: checksum files differ" >&2
    exit 1
fi
if ! reproducible_checksum_output=$(sha256sum "$first_archive"); then
    echo "reproducibility check failed: cannot hash first archive" >&2
    exit 1
fi
reproducible_checksum=${reproducible_checksum_output%% *}
printf 'reproducible %s\n' "$reproducible_checksum"
