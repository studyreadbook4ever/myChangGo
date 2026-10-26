#!/bin/sh
set -eu
umask 022
export LC_ALL=C

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir"

if ! version=$(sed -n 's/^version = "\([^"]*\)"$/\1/p' Cargo.toml); then
    echo "cannot read package version from Cargo.toml" >&2
    exit 1
fi
if ! rustc_verbose=$(rustc +stable -vV); then
    echo "cannot query the stable Rust toolchain" >&2
    exit 1
fi
host=$(printf '%s\n' "$rustc_verbose" | sed -n 's/^host: //p')
if [ -z "$version" ] || [ -z "$host" ]; then
    echo "cannot determine release identity" >&2
    exit 1
fi
case "$version" in
    *[!A-Za-z0-9.+-]*)
        echo "unsafe package version in Cargo.toml" >&2
        exit 1
        ;;
esac
case "$host" in
    *[!A-Za-z0-9._-]*)
        echo "unsafe Rust host triple" >&2
        exit 1
        ;;
esac

dist_dir=${IDLEPILOT_DIST_DIR:-"$project_dir/dist"}
case "$dist_dir" in
    /*) ;;
    *)
        echo "IDLEPILOT_DIST_DIR must be absolute" >&2
        exit 2
        ;;
esac
mkdir -p "$dist_dir"
stage=$(mktemp -d "$dist_dir/.idlepilot-stage.XXXXXX")
package_root="$stage/idlepilot-$version-$host"
archive_name="idlepilot-$version-$host.tar.gz"
archive="$dist_dir/$archive_name"
checksum_file="$archive.sha256"
temporary_archive="$stage/$archive_name"
temporary_checksum="$temporary_archive.sha256"
published_archive=
published_checksum=

cleanup() {
    saved_status=$?
    trap - EXIT HUP INT TERM
    if [ -n "$published_archive" ] && [ -z "$published_checksum" ] &&
        [ "$archive" -ef "$temporary_archive" ]; then
        rm -f -- "$archive"
    fi
    if [ -n "$published_checksum" ] && [ -z "$published_archive" ] &&
        [ "$checksum_file" -ef "$temporary_checksum" ]; then
        rm -f -- "$checksum_file"
    fi
    rm -rf -- "$stage"
    exit "$saved_status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [ -e "$archive" ] || [ -L "$archive" ] ||
    [ -e "$checksum_file" ] || [ -L "$checksum_file" ]; then
    echo "release artifact already exists; refusing to overwrite it" >&2
    exit 1
fi

./scripts/check-release.sh

cargo_target_dir=${CARGO_TARGET_DIR:-"$project_dir/target"}
case "$cargo_target_dir" in
    /*) ;;
    *) cargo_target_dir="$project_dir/$cargo_target_dir" ;;
esac
cargo +stable build --release --locked --bin idlepilot \
    --target-dir "$cargo_target_dir" --target "$host"

release_binary="$cargo_target_dir/$host/release/idlepilot"
if [ ! -f "$release_binary" ] || [ -L "$release_binary" ] ||
    [ ! -x "$release_binary" ]; then
    echo "release binary was not created under CARGO_TARGET_DIR" >&2
    exit 1
fi

install -d -m 0755 "$package_root/bin" "$package_root/share/man/man1"
install -d -m 0755 "$package_root/share/systemd/user" "$package_root/share/doc/idlepilot"
install -d -m 0755 "$package_root/share/doc/idlepilot/examples"
install -m 0755 "$release_binary" "$package_root/bin/idlepilot"
install -m 0644 packaging/idlepilot.1 "$package_root/share/man/man1/idlepilot.1"
install -m 0644 packaging/systemd/user/idlepilot@.service \
    "$package_root/share/systemd/user/idlepilot@.service"
install -m 0644 README.md CHANGELOG.md NOTICE THIRD_PARTY.md \
    "$package_root/share/doc/idlepilot/"
install -m 0644 docs/*.md "$package_root/share/doc/idlepilot/"
install -m 0644 SECURITY.md "$package_root/share/doc/idlepilot/SECURITY_REPORTING.md"
install -m 0644 examples/*.rs "$package_root/share/doc/idlepilot/examples/"

rust_sysroot=$(rustc +stable --print sysroot)
rust_notice_root="$rust_sysroot/share/doc/rust"
if [ ! -f "$rust_notice_root/COPYRIGHT-library.html" ] ||
    [ ! -d "$rust_notice_root/licenses" ]; then
    echo "release blocked: Rust standard-library notice bundle is unavailable" >&2
    exit 1
fi

install -d -m 0755 "$package_root/share/doc/idlepilot/rust/licenses"
install -m 0644 "$rust_notice_root/COPYRIGHT-library.html" \
    "$package_root/share/doc/idlepilot/rust/COPYRIGHT-library.html"
for license_file in "$rust_notice_root"/licenses/*; do
    if [ ! -f "$license_file" ]; then
        echo "release blocked: unexpected entry in Rust license bundle" >&2
        exit 1
    fi
    install -m 0644 "$license_file" \
        "$package_root/share/doc/idlepilot/rust/licenses/"
done
rustc +stable -vV >"$package_root/share/doc/idlepilot/rust/RUST-TOOLCHAIN.txt"
chmod 0644 "$package_root/share/doc/idlepilot/rust/RUST-TOOLCHAIN.txt"

runtime_requirements="$package_root/share/doc/idlepilot/RUNTIME-REQUIREMENTS.txt"
program_headers="$stage/readelf-program-headers.txt"
dynamic_section="$stage/readelf-dynamic-section.txt"
version_info="$stage/readelf-version-info.txt"
if ! readelf -l "$package_root/bin/idlepilot" >"$program_headers"; then
    echo "release blocked: cannot read ELF program headers" >&2
    exit 1
fi
if ! readelf -d "$package_root/bin/idlepilot" >"$dynamic_section"; then
    echo "release blocked: cannot read ELF dynamic section" >&2
    exit 1
fi
if ! readelf --version-info "$package_root/bin/idlepilot" >"$version_info"; then
    echo "release blocked: cannot read ELF symbol versions" >&2
    exit 1
fi
interpreter=$(sed -n 's/.*Requesting program interpreter: \([^]]*\).*/\1/p' \
    "$program_headers")
needed=$(sed -n 's/.*Shared library: \[\([^]]*\)\].*/\1/p' "$dynamic_section")
raw_required_versions="$stage/required-symbol-versions.txt"
sorted_required_versions="$stage/required-symbol-versions-sorted.txt"
sed -n 's/.*Name: \([^ ]*\).*/\1/p' "$version_info" >"$raw_required_versions"
sort -u "$raw_required_versions" >"$sorted_required_versions"
required_versions=$(sed -n '1,$p' "$sorted_required_versions")
if [ -z "$interpreter" ] || [ -z "$needed" ] || [ -z "$required_versions" ]; then
    echo "release blocked: ELF runtime inventory is incomplete" >&2
    exit 1
fi
{
    printf '%s\n' 'This binary was built for the native Rust host shown below.'
    printf '%s\n' 'It is dynamically linked and may require a libc at least as new as the build host.'
    printf '%s\n' '' 'Kernel/process-control requirements:'
    printf '%s\n' 'Linux 5.3 or newer with pidfd_open, pidfd_send_signal, and pidfd polling'
    printf '%s\n' '/proc mounted with readable per-process stat entries'
    printf '%s\n' ''
    rustc +stable -vV
    printf '%s\n' '' 'ELF interpreter:'
    printf '%s\n' "$interpreter"
    printf '%s\n' '' 'Dynamic libraries (DT_NEEDED):'
    printf '%s\n' "$needed"
    printf '%s\n' '' 'Required ELF symbol versions:'
    printf '%s\n' "$required_versions"
} >"$runtime_requirements"
chmod 0644 "$runtime_requirements"

archive_epoch=${SOURCE_DATE_EPOCH:-0}
export SOURCE_DATE_EPOCH="$archive_epoch"
./scripts/generate-sbom.sh \
    "$package_root/bin/idlepilot" \
    "$package_root/share/doc/idlepilot/idlepilot.spdx.json"

tar --sort=name --mtime="@$archive_epoch" --owner=0 --group=0 --numeric-owner \
    -C "$stage" -czf "$temporary_archive" "idlepilot-$version-$host"
chmod 0644 "$temporary_archive"
(cd "$stage" && sha256sum "$archive_name") >"$temporary_checksum"
chmod 0644 "$temporary_checksum"

./scripts/verify-dist.sh "$temporary_archive"

if ! ln -- "$temporary_checksum" "$checksum_file"; then
    echo "release publication failed: checksum destination already exists" >&2
    exit 1
fi
published_checksum=1
if ! ln -- "$temporary_archive" "$archive"; then
    echo "release publication failed: archive destination already exists" >&2
    exit 1
fi
published_archive=1

printf 'created %s\n' "$archive"
printf 'created %s\n' "$checksum_file"
