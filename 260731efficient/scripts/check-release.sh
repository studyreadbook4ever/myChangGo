#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir"

./scripts/verify-licensing.sh
cargo +stable fmt --check
cargo +stable test --locked --all-targets -- --test-threads=1
cargo +stable clippy --locked --all-targets --all-features -- -D warnings
RUSTDOCFLAGS="-D warnings" cargo +stable doc --locked --no-deps

dependency_lines=$(cargo +stable tree --locked --edges all --target all --prefix none | wc -l)
if [ "$dependency_lines" -ne 1 ]; then
    echo "release blocked: unexpected Cargo dependency detected" >&2
    exit 1
fi

./scripts/verify-systemd.sh

cargo +stable package --locked
