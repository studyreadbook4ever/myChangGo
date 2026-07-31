#!/bin/sh
set -eu
export LC_ALL=C

if [ "$#" -ne 2 ]; then
    echo "usage: $0 ABSOLUTE_BINARY OUTPUT_JSON" >&2
    exit 2
fi

binary=$1
output=$2

case "$binary" in
    /*) ;;
    *)
        echo "binary path must be absolute" >&2
        exit 2
        ;;
esac

if [ ! -f "$binary" ] || [ -L "$binary" ]; then
    echo "binary does not exist: $binary" >&2
    exit 2
fi
for command in date dirname mktemp readelf rustc sha256sum sort timeout uniq; do
    if ! command -v "$command" >/dev/null 2>&1; then
        echo "$command is required to generate the SPDX SBOM" >&2
        exit 1
    fi
done

output_dir=$(dirname -- "$output")
if [ ! -d "$output_dir" ]; then
    echo "SBOM output directory does not exist: $output_dir" >&2
    exit 2
fi
umask 077
dynamic_section=
needed_list=
sorted_needed=
duplicate_needed=
temporary=
cleanup() {
    for temporary_file in \
        "$dynamic_section" \
        "$needed_list" \
        "$sorted_needed" \
        "$duplicate_needed" \
        "$temporary"; do
        if [ -n "$temporary_file" ]; then
            rm -f -- "$temporary_file"
        fi
    done
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
dynamic_section=$(mktemp "$output_dir/.idlepilot-readelf.XXXXXX")
needed_list=$(mktemp "$output_dir/.idlepilot-needed.XXXXXX")
sorted_needed=$(mktemp "$output_dir/.idlepilot-needed-sorted.XXXXXX")
duplicate_needed=$(mktemp "$output_dir/.idlepilot-needed-duplicates.XXXXXX")
temporary=$(mktemp "$output_dir/.idlepilot-sbom.XXXXXX")

if ! readelf -h "$binary" >/dev/null; then
    echo "cannot read ELF header: $binary" >&2
    exit 1
fi
if ! readelf -d "$binary" >"$dynamic_section"; then
    echo "cannot read ELF dynamic section: $binary" >&2
    exit 1
fi
needed=$(sed -n 's/.*Shared library: \[\([^]]*\)\].*/\1/p' "$dynamic_section")
if [ -z "$needed" ]; then
    echo "ELF contains no DT_NEEDED runtime dependencies" >&2
    exit 1
fi
printf '%s\n' "$needed" >"$needed_list"
while IFS= read -r library; do
    case "$library" in
        *[!A-Za-z0-9._+-]* | "")
            echo "unsafe ELF dependency name: $library" >&2
            exit 1
            ;;
    esac
done <"$needed_list"
sort "$needed_list" >"$sorted_needed"
uniq -d "$sorted_needed" >"$duplicate_needed"
duplicate_library=$(sed -n '1,$p' "$duplicate_needed")
if [ -n "$duplicate_library" ]; then
    echo "duplicate ELF runtime dependency: $duplicate_library" >&2
    exit 1
fi

if ! version_output=$(timeout --kill-after=2s 10s "$binary" version); then
    echo "cannot execute idlepilot version command" >&2
    exit 1
fi
version=$(printf '%s\n' "$version_output" |
    sed -n 's/.*"version":"\([^"]*\)".*/\1/p')
if [ -z "$version" ]; then
    echo "cannot determine idlepilot version" >&2
    exit 1
fi
case "$version" in
    *[!A-Za-z0-9.+-]*)
        echo "idlepilot reported an unsafe version" >&2
        exit 1
        ;;
esac

if ! checksum_output=$(sha256sum "$binary"); then
    echo "cannot hash idlepilot binary" >&2
    exit 1
fi
checksum=${checksum_output%% *}
if ! rust_version_output=$(rustc +stable --version); then
    echo "cannot determine Rust standard-library version" >&2
    exit 1
fi
case "$rust_version_output" in
    'rustc '*) rust_version=${rust_version_output#rustc } ;;
    *)
        echo "unexpected rustc version output" >&2
        exit 1
        ;;
esac
if [ "${SOURCE_DATE_EPOCH+x}" = x ]; then
    case "$SOURCE_DATE_EPOCH" in
        *[!0-9]* | "")
            echo "SOURCE_DATE_EPOCH must be a non-negative integer" >&2
            exit 2
            ;;
    esac
    if ! created=$(date -u -d "@$SOURCE_DATE_EPOCH" '+%Y-%m-%dT%H:%M:%SZ'); then
        echo "SOURCE_DATE_EPOCH is outside the supported date range" >&2
        exit 2
    fi
else
    if ! created=$(date -u '+%Y-%m-%dT%H:%M:%SZ'); then
        echo "cannot determine the SBOM creation time" >&2
        exit 1
    fi
fi
namespace="https://spdx.org/spdxdocs/idlepilot-${version}-${checksum}"
{
    printf '%s\n' '{'
    printf '%s\n' '  "spdxVersion": "SPDX-2.3",'
    printf '%s\n' '  "dataLicense": "CC0-1.0",'
    printf '%s\n' '  "SPDXID": "SPDXRef-DOCUMENT",'
    printf '  "name": "idlepilot-%s-linux-binary",\n' "$version"
    printf '  "documentNamespace": "%s",\n' "$namespace"
    printf '%s\n' '  "creationInfo": {'
    printf '    "created": "%s",\n' "$created"
    printf '%s\n' '    "creators": ["Tool: idlepilot/scripts/generate-sbom.sh"]'
    printf '%s\n' '  },'
    printf '%s\n' '  "packages": ['
    printf '%s\n' '    {'
    printf '%s\n' '      "SPDXID": "SPDXRef-Package-idlepilot",'
    printf '      "name": "idlepilot",\n'
    printf '      "versionInfo": "%s",\n' "$version"
    printf '%s\n' '      "downloadLocation": "NOASSERTION",'
    printf '%s\n' '      "filesAnalyzed": false,'
    printf '%s\n' '      "licenseConcluded": "NONE",'
    printf '%s\n' '      "licenseDeclared": "NONE",'
    printf '%s\n' '      "copyrightText": "NOASSERTION",'
    printf '%s\n' '      "checksums": ['
    printf '        {"algorithm": "SHA256", "checksumValue": "%s"}\n' "$checksum"
    printf '%s\n' '      ],'
    printf '%s\n' '      "externalRefs": ['
    printf '        {"referenceCategory": "PACKAGE-MANAGER", "referenceType": "purl", "referenceLocator": "pkg:cargo/idlepilot@%s"}\n' "$version"
    printf '%s\n' '      ]'
    printf '%s\n' '    },'
    printf '%s\n' '    {'
    printf '%s\n' '      "SPDXID": "SPDXRef-Package-rust-stdlib",'
    printf '%s\n' '      "name": "Rust standard library",'
    printf '      "versionInfo": "%s",\n' "$rust_version"
    printf '%s\n' '      "downloadLocation": "NOASSERTION",'
    printf '%s\n' '      "filesAnalyzed": false,'
    printf '%s\n' '      "licenseConcluded": "NOASSERTION",'
    printf '%s\n' '      "licenseDeclared": "NOASSERTION",'
    printf '%s\n' '      "copyrightText": "NOASSERTION",'
    printf '%s\n' '      "comment": "Statically linked; NOASSERTION is used because the exact toolchain bundle contains multiple component licenses. Notices are shipped under share/doc/idlepilot/rust/."'
    printf '%s' '    }'
    dependency_index=0
    for library in $needed; do
        dependency_index=$((dependency_index + 1))
        printf '%s\n' ','
        printf '%s\n' '    {'
        printf '      "SPDXID": "SPDXRef-Package-system-library-%s",\n' "$dependency_index"
        printf '      "name": "%s",\n' "$library"
        printf '%s\n' '      "downloadLocation": "NOASSERTION",'
        printf '%s\n' '      "filesAnalyzed": false,'
        printf '%s\n' '      "licenseConcluded": "NOASSERTION",'
        printf '%s\n' '      "licenseDeclared": "NOASSERTION",'
        printf '%s\n' '      "copyrightText": "NOASSERTION",'
        printf '%s\n' '      "primaryPackagePurpose": "LIBRARY",'
        printf '%s\n' '      "comment": "System-provided dynamic runtime dependency; not copied into the idlepilot archive."'
        printf '%s' '    }'
    done
    printf '%s\n' ''
    printf '%s\n' '  ],'
    printf '%s\n' '  "relationships": ['
    printf '%s\n' '    {"spdxElementId": "SPDXRef-DOCUMENT", "relationshipType": "DESCRIBES", "relatedSpdxElement": "SPDXRef-Package-idlepilot"},'
    printf '%s' '    {"spdxElementId": "SPDXRef-Package-idlepilot", "relationshipType": "STATIC_LINK", "relatedSpdxElement": "SPDXRef-Package-rust-stdlib"}'
    dependency_index=0
    for library in $needed; do
        dependency_index=$((dependency_index + 1))
        printf '%s\n' ','
        printf '    {"spdxElementId": "SPDXRef-Package-idlepilot", "relationshipType": "DYNAMIC_LINK", "relatedSpdxElement": "SPDXRef-Package-system-library-%s"}' "$dependency_index"
    done
    printf '%s\n' ''
    printf '%s\n' '  ]'
    printf '%s\n' '}'
} >"$temporary"

chmod 0644 "$temporary"
mv -- "$temporary" "$output"
rm -f -- "$dynamic_section" "$needed_list" "$sorted_needed" "$duplicate_needed"
trap - EXIT HUP INT TERM
