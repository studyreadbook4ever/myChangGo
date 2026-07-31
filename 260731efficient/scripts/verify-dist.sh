#!/bin/sh
set -eu
umask 077
export LC_ALL=C

if [ "$#" -ne 1 ]; then
    echo "usage: $0 RELEASE_ARCHIVE.tar.gz" >&2
    exit 2
fi

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
archive=$1
case "$archive" in
    /*) ;;
    *) archive="$project_dir/$archive" ;;
esac
if [ ! -f "$archive" ]; then
    echo "release archive does not exist: $archive" >&2
    exit 2
fi
for command in install mktemp python3 readelf sha256sum stat tar timeout; do
    if ! command -v "$command" >/dev/null 2>&1; then
        echo "release verification requires $command" >&2
        exit 1
    fi
done

archive_size=$(stat -c %s "$archive")
case "$archive_size" in
    *[!0-9]* | "")
        echo "release verification failed: cannot determine archive size" >&2
        exit 1
        ;;
esac
if [ "$archive_size" -gt 67108864 ]; then
    echo "release verification failed: compressed archive exceeds 64 MiB" >&2
    exit 1
fi

stage=$(mktemp -d "${TMPDIR:-/tmp}/idlepilot-dist-verify.XXXXXX")
cleanup() {
    rm -rf -- "$stage"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

snapshot="$stage/release.tar.gz"
extract_root="$stage/extracted"
package_name_file="$stage/package-name"
archive_mtime_file="$stage/archive-mtime"
install -m 0600 "$archive" "$snapshot"
snapshot_size=$(stat -c %s "$snapshot")
if [ "$snapshot_size" != "$archive_size" ] || [ "$snapshot_size" -gt 67108864 ]; then
    echo "release verification failed: archive changed size while being copied" >&2
    exit 1
fi
mkdir -m 0700 "$extract_root"

python3 - "$snapshot" "$package_name_file" "$archive_mtime_file" <<'PY'
import pathlib
import re
import sys
import tarfile

archive, package_file, mtime_file = sys.argv[1:]
max_members = 4096
max_member_size = 32 * 1024 * 1024
max_total_size = 128 * 1024 * 1024


def fail(message: str) -> None:
    raise SystemExit(f"release verification failed: {message}")


def path_label(name: str) -> str:
    shortened = name if len(name) <= 160 else name[:157] + "..."
    return repr(shortened)


members = []
names = set()
roots = set()
common_mtime = None
total_size = 0
root_directory_present = False
binary_member_count = 0

try:
    with tarfile.open(archive, mode="r:gz") as bundle:
        for member in bundle:
            if len(members) >= max_members:
                fail(f"archive has more than {max_members} members")
            members.append(member)
            name = member.name
            if not name or name.startswith("/") or "\\" in name:
                fail(f"unsafe archive member path: {path_label(name)}")
            if any(ord(character) < 32 or ord(character) == 127 for character in name):
                fail(f"control character in archive member path: {path_label(name)}")
            try:
                encoded_name = name.encode("utf-8")
            except UnicodeEncodeError:
                fail(f"archive member path is not valid UTF-8: {path_label(name)}")
            if len(encoded_name) > 4096:
                fail("archive member path exceeds 4096 UTF-8 bytes")
            parts = name.split("/")
            if any(part in {"", ".", ".."} for part in parts):
                fail(f"non-canonical archive member path: {path_label(name)}")
            if name in names:
                fail(f"duplicate archive member path: {path_label(name)}")
            names.add(name)
            roots.add(parts[0])

            is_regular_type = member.type in {tarfile.REGTYPE, tarfile.AREGTYPE}
            is_directory_type = member.type == tarfile.DIRTYPE
            if not (is_directory_type or is_regular_type):
                fail(
                    f"archive member is not a regular file or directory: {path_label(name)}"
                )
            is_binary = len(parts) == 3 and parts[1:] == ["bin", "idlepilot"]
            if is_binary:
                if not is_regular_type:
                    fail("archive binary member is not a regular file")
                binary_member_count += 1
            expected_mode = 0o755 if is_directory_type or is_binary else 0o644
            if member.mode != expected_mode:
                fail(
                    f"archive member mode is {member.mode:04o}, expected "
                    f"{expected_mode:04o}: {path_label(name)}"
                )
            if member.uid != 0 or member.gid != 0:
                fail(f"archive member owner is not numeric 0:0: {path_label(name)}")
            if not isinstance(member.mtime, (int, float)) or int(member.mtime) != member.mtime:
                fail(f"archive member mtime is not an integer: {path_label(name)}")
            mtime = int(member.mtime)
            if mtime < 0:
                fail(f"archive member mtime is negative: {path_label(name)}")
            if common_mtime is None:
                common_mtime = mtime
            elif mtime != common_mtime:
                fail(f"archive members do not share one mtime: {path_label(name)}")

            if is_directory_type:
                if member.size != 0:
                    fail(f"archive directory has nonzero size: {path_label(name)}")
            else:
                if member.size > max_member_size:
                    fail(f"archive member exceeds 32 MiB: {path_label(name)}")
                total_size += member.size
                if total_size > max_total_size:
                    fail("archive regular-file total exceeds 128 MiB")
except (OSError, tarfile.TarError) as error:
    fail(f"cannot read gzip tar archive: {error}")

if not members:
    fail("archive is empty")

if len(roots) != 1:
    fail("archive does not have exactly one package root")
root = next(iter(roots))
if not re.fullmatch(r"idlepilot-[A-Za-z0-9._+-]+", root):
    fail(f"unsafe package root name: {path_label(root)}")
for member in members:
    if member.name == root and member.isdir():
        root_directory_present = True
        break
if not root_directory_present:
    fail("archive omits its package-root directory entry")
if binary_member_count != 1:
    fail("archive does not contain exactly one regular ROOT/bin/idlepilot member")

license_directory = f"{root}/share/doc/idlepilot/rust/licenses"
license_files = [
    member
    for member in members
    if member.isreg() and pathlib.PurePosixPath(member.name).parent.as_posix() == license_directory
]
if not license_files:
    fail("Rust standard-library license bundle is empty")

pathlib.Path(package_file).write_text(root + "\n", encoding="utf-8")
pathlib.Path(mtime_file).write_text(str(common_mtime) + "\n", encoding="ascii")
PY

package_name=$(sed -n '1p' "$package_name_file")
if [ -z "$package_name" ]; then
    echo "release verification failed: package root was not recorded" >&2
    exit 1
fi
tar --no-same-owner -xzf "$snapshot" -C "$extract_root"
root="$extract_root/$package_name"
binary="$root/bin/idlepilot"
documents="$root/share/doc/idlepilot"
sbom="$documents/idlepilot.spdx.json"

for required in \
    "$binary" \
    "$documents/README.md" \
    "$documents/CHANGELOG.md" \
    "$documents/NOTICE" \
    "$documents/RUNTIME-REQUIREMENTS.txt" \
    "$documents/SECURITY_REPORTING.md" \
    "$documents/examples/readiness.rs" \
    "$documents/THIRD_PARTY.md" \
    "$documents/rust/COPYRIGHT-library.html" \
    "$documents/rust/RUST-TOOLCHAIN.txt" \
    "$sbom" \
    "$root/share/man/man1/idlepilot.1" \
    "$root/share/systemd/user/idlepilot@.service"; do
    if [ ! -f "$required" ] || [ -L "$required" ]; then
        echo "release verification failed: missing regular ${required#"$root"/}" >&2
        exit 1
    fi
done

project_license_name='unlic''ense|licen[cs]e([._-].*)?|copying([._-].*)?'
if find "$documents" -maxdepth 1 \( -type f -o -type l \) -printf '%f\n' |
    grep -Eiq "$project_license_name"; then
    echo "release verification failed: archive contains a project license file" >&2
    exit 1
else
    grep_status=$?
    if [ "$grep_status" -ne 1 ]; then
        echo "release verification failed: cannot inspect packaged documentation" >&2
        exit 1
    fi
fi

version_json="$stage/version.json"
schema_json="$stage/schema.json"
if ! timeout --kill-after=2s 10s "$binary" version >"$version_json"; then
    echo "release verification failed: idlepilot version smoke test failed" >&2
    exit 1
fi
if ! timeout --kill-after=2s 10s "$binary" schema >"$schema_json"; then
    echo "release verification failed: idlepilot schema smoke test failed" >&2
    exit 1
fi

elf_header="$stage/readelf-header.txt"
program_headers="$stage/readelf-program-headers.txt"
dynamic_section="$stage/readelf-dynamic-section.txt"
needed_file="$stage/dt-needed.txt"
interpreter_file="$stage/elf-interpreter.txt"
if ! readelf -h "$binary" >"$elf_header"; then
    echo "release verification failed: cannot read ELF header" >&2
    exit 1
fi
if ! readelf -l "$binary" >"$program_headers"; then
    echo "release verification failed: cannot read ELF program headers" >&2
    exit 1
fi
if ! readelf -d "$binary" >"$dynamic_section"; then
    echo "release verification failed: cannot read ELF dynamic section" >&2
    exit 1
fi
sed -n 's/.*Shared library: \[\([^]]*\)\].*/\1/p' \
    "$dynamic_section" >"$needed_file"
sed -n 's/.*Requesting program interpreter: \([^]]*\).*/\1/p' \
    "$program_headers" >"$interpreter_file"
if [ ! -s "$needed_file" ] || [ ! -s "$interpreter_file" ]; then
    echo "release verification failed: ELF runtime inventory is incomplete" >&2
    exit 1
fi

python3 - \
    "$package_name_file" \
    "$archive_mtime_file" \
    "$binary" \
    "$version_json" \
    "$schema_json" \
    "$sbom" \
    "$documents/rust/RUST-TOOLCHAIN.txt" \
    "$needed_file" \
    "$interpreter_file" \
    "$documents/RUNTIME-REQUIREMENTS.txt" <<'PY'
import datetime
import hashlib
import json
import pathlib
import re
import sys

(
    package_file,
    mtime_file,
    binary_file,
    version_file,
    schema_file,
    sbom_file,
    toolchain_file,
    needed_file,
    interpreter_file,
    runtime_file,
) = sys.argv[1:]


def fail(message: str) -> None:
    raise SystemExit(f"release verification failed: {message}")


def load_json(path: str, label: str) -> object:
    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                fail(f"duplicate key {key!r} in {label} JSON")
            result[key] = value
        return result

    def invalid_constant(value):
        fail(f"non-finite number {value!r} in {label} JSON")

    try:
        with open(path, encoding="utf-8") as source:
            return json.load(
                source,
                object_pairs_hook=unique_object,
                parse_constant=invalid_constant,
            )
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        fail(f"invalid {label} JSON: {error}")


package_name = pathlib.Path(package_file).read_text(encoding="utf-8").strip()
archive_mtime = int(pathlib.Path(mtime_file).read_text(encoding="ascii").strip())
version_document = load_json(version_file, "version response")
schema_document = load_json(schema_file, "schema response")
sbom = load_json(sbom_file, "SPDX SBOM")

if not isinstance(version_document, dict):
    fail("version response is not an object")
version = version_document.get("version")
if version_document.get("api_version") != 1 or version_document.get("name") != "idlepilot":
    fail("version response identity is wrong")
semver = re.compile(
    r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
    r"(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
)
if not isinstance(version, str) or semver.fullmatch(version) is None:
    fail("version response does not contain a canonical semantic version")
if not isinstance(schema_document, dict):
    fail("schema response is not an object")
if schema_document.get("api_version") != 1 or schema_document.get("status") != "ok":
    fail("schema response identity is wrong")
commands = schema_document.get("commands")
if not isinstance(commands, list) or "version" not in commands or "schema" not in commands:
    fail("schema response omits required commands")

toolchain_lines = pathlib.Path(toolchain_file).read_text(encoding="utf-8").splitlines()
if not toolchain_lines or not toolchain_lines[0].startswith("rustc "):
    fail("Rust toolchain record has no rustc version")
rust_version = toolchain_lines[0][len("rustc ") :]
host_lines = [line[len("host: ") :] for line in toolchain_lines if line.startswith("host: ")]
if len(host_lines) != 1 or not re.fullmatch(r"[A-Za-z0-9._-]+", host_lines[0]):
    fail("Rust toolchain record has no unique safe host triple")
expected_package_name = f"idlepilot-{version}-{host_lines[0]}"
if package_name != expected_package_name:
    fail(
        f"archive root {package_name!r} does not match binary/toolchain {expected_package_name!r}"
    )

needed = pathlib.Path(needed_file).read_text(encoding="utf-8").splitlines()
if not needed or len(needed) != len(set(needed)):
    fail("DT_NEEDED list is empty or contains duplicates")
if any(re.fullmatch(r"[A-Za-z0-9._+-]+", name) is None for name in needed):
    fail("DT_NEEDED list contains an unsafe library name")
interpreters = pathlib.Path(interpreter_file).read_text(encoding="utf-8").splitlines()
if len(interpreters) != 1 or not interpreters[0].startswith("/"):
    fail("ELF interpreter is missing or not absolute")
interpreter = interpreters[0]

runtime_lines = pathlib.Path(runtime_file).read_text(encoding="utf-8").splitlines()
try:
    kernel_heading = runtime_lines.index("Kernel/process-control requirements:")
    interpreter_heading = runtime_lines.index("ELF interpreter:")
    dynamic_heading = runtime_lines.index("Dynamic libraries (DT_NEEDED):")
    versions_heading = runtime_lines.index("Required ELF symbol versions:")
except ValueError:
    fail("runtime requirements omit a required section")
expected_kernel = [
    "Linux 5.3 or newer with pidfd_open, pidfd_send_signal, and pidfd polling",
    "/proc mounted with readable per-process stat entries",
]
if runtime_lines[kernel_heading + 1 : kernel_heading + 3] != expected_kernel:
    fail("runtime requirements omit mandatory pidfd or /proc support")
if interpreter_heading + 1 >= len(runtime_lines) or runtime_lines[interpreter_heading + 1] != interpreter:
    fail("runtime requirements do not match the ELF interpreter")
runtime_needed = [line for line in runtime_lines[dynamic_heading + 1 : versions_heading] if line]
if runtime_needed != needed:
    fail("runtime requirements do not exactly match DT_NEEDED")

binary_hash = hashlib.sha256(pathlib.Path(binary_file).read_bytes()).hexdigest()
if not isinstance(sbom, dict):
    fail("SPDX SBOM is not an object")
try:
    expected_created = datetime.datetime.fromtimestamp(
        archive_mtime, datetime.timezone.utc
    ).strftime("%Y-%m-%dT%H:%M:%SZ")
except (OverflowError, OSError, ValueError):
    fail("common archive mtime is outside the supported date range")
if sbom.get("spdxVersion") != "SPDX-2.3":
    fail("SBOM spdxVersion is not SPDX-2.3")
if sbom.get("dataLicense") != "CC0-1.0" or sbom.get("SPDXID") != "SPDXRef-DOCUMENT":
    fail("SBOM document identity is wrong")
if sbom.get("name") != f"idlepilot-{version}-linux-binary":
    fail("SBOM name does not match the binary version")
if sbom.get("documentNamespace") != f"https://spdx.org/spdxdocs/idlepilot-{version}-{binary_hash}":
    fail("SBOM namespace does not bind the binary hash and version")
creation = sbom.get("creationInfo")
if not isinstance(creation, dict) or creation.get("created") != expected_created:
    fail("SBOM creation time does not match the common archive mtime")
if creation.get("creators") != ["Tool: idlepilot/scripts/generate-sbom.sh"]:
    fail("SBOM creator is wrong")

packages = sbom.get("packages")
if not isinstance(packages, list) or not all(isinstance(package, dict) for package in packages):
    fail("SBOM packages is not an object array")
package_ids = [package.get("SPDXID") for package in packages]
expected_ids = ["SPDXRef-Package-idlepilot", "SPDXRef-Package-rust-stdlib"] + [
    f"SPDXRef-Package-system-library-{index}" for index in range(1, len(needed) + 1)
]
if len(package_ids) != len(set(package_ids)) or set(package_ids) != set(expected_ids):
    fail("SBOM package IDs are not the exact expected set")
by_id = {package["SPDXID"]: package for package in packages}

idlepilot = by_id["SPDXRef-Package-idlepilot"]
if idlepilot.get("name") != "idlepilot" or idlepilot.get("versionInfo") != version:
    fail("SBOM idlepilot package identity is wrong")
if idlepilot.get("filesAnalyzed") is not False:
    fail("SBOM idlepilot filesAnalyzed must be false")
if idlepilot.get("licenseDeclared") != "NONE" or idlepilot.get("licenseConcluded") != "NONE":
    fail("SBOM idlepilot package must declare no available project license")
if idlepilot.get("checksums") != [{"algorithm": "SHA256", "checksumValue": binary_hash}]:
    fail("SBOM idlepilot checksum does not match the binary")
expected_ref = {
    "referenceCategory": "PACKAGE-MANAGER",
    "referenceType": "purl",
    "referenceLocator": f"pkg:cargo/idlepilot@{version}",
}
if idlepilot.get("externalRefs") != [expected_ref]:
    fail("SBOM idlepilot purl is wrong")

rust = by_id["SPDXRef-Package-rust-stdlib"]
if rust.get("name") != "Rust standard library" or rust.get("versionInfo") != rust_version:
    fail("SBOM Rust standard-library identity is wrong")
if rust.get("filesAnalyzed") is not False:
    fail("SBOM Rust standard-library filesAnalyzed must be false")
if rust.get("licenseDeclared") != "NOASSERTION" or rust.get("licenseConcluded") != "NOASSERTION":
    fail("SBOM Rust standard-library license boundary is wrong")

for index, library in enumerate(needed, start=1):
    package = by_id[f"SPDXRef-Package-system-library-{index}"]
    if package.get("name") != library or package.get("primaryPackagePurpose") != "LIBRARY":
        fail(f"SBOM system library {index} does not match DT_NEEDED")
    if package.get("filesAnalyzed") is not False:
        fail(f"SBOM system library {index} filesAnalyzed must be false")
    if package.get("licenseDeclared") != "NOASSERTION" or package.get("licenseConcluded") != "NOASSERTION":
        fail(f"SBOM system library {index} license boundary is wrong")

relationships = sbom.get("relationships")
if not isinstance(relationships, list) or not all(isinstance(item, dict) for item in relationships):
    fail("SBOM relationships is not an object array")
actual_relationships = [
    (item.get("spdxElementId"), item.get("relationshipType"), item.get("relatedSpdxElement"))
    for item in relationships
]
expected_relationships = [
    ("SPDXRef-DOCUMENT", "DESCRIBES", "SPDXRef-Package-idlepilot"),
    ("SPDXRef-Package-idlepilot", "STATIC_LINK", "SPDXRef-Package-rust-stdlib"),
] + [
    (
        "SPDXRef-Package-idlepilot",
        "DYNAMIC_LINK",
        f"SPDXRef-Package-system-library-{index}",
    )
    for index in range(1, len(needed) + 1)
]
if len(actual_relationships) != len(set(actual_relationships)) or set(actual_relationships) != set(expected_relationships):
    fail("SBOM relationships are not the exact expected set")
PY

printf 'verified %s\n' "$archive"
