#!/usr/bin/env python3
"""Verify the release R8 artifact still exposes the Kotlin JNI bridge.

Debug tests cannot detect R8 renaming a descriptor used literally by Dart.
This checks the generated mapping and actual APK DEX definitions, not the text
of the ProGuard rules. No Android SDK utilities or Python packages are needed.
The required symbols come from jni 1.1.0 lib/src/kotlin.dart and the
shared_preferences_android 2.5.1 generated JNI API.
"""

import argparse
from pathlib import Path
import re
import struct
import sys
import zipfile


DEFAULT_MAPPING = Path(__file__).resolve().parents[1] / (
    "build/app/outputs/mapping/release/mapping.txt"
)
DEFAULT_APK = Path(__file__).resolve().parents[1] / (
    "build/app/outputs/flutter-apk/app-release.apk"
)
API = "io.flutter.plugins.sharedpreferences.SharedPreferencesApiRegistrar"
REQUIRED_CLASSES = (
    "kotlin.Unit",
    "kotlin.Result",
    "kotlin.Result$Failure",
    "kotlin.coroutines.Continuation",
    "kotlin.coroutines.intrinsics.CoroutineSingletons",
    "kotlin.coroutines.intrinsics.IntrinsicsKt",
    "kotlin.coroutines.intrinsics.IntrinsicsKt__IntrinsicsKt",
    "io.flutter.plugins.sharedpreferences.SharedPreferencesApi",
    API,
)

# Class, original declaration, retained JNI member name. Methods include the
# complete parameter list so an unrelated overload cannot make the check pass.
REQUIRED_MEMBERS = (
    ("kotlin.Unit", "kotlin.Unit INSTANCE", "INSTANCE"),
    ("kotlin.Result", "java.lang.Object value", "value"),
    ("kotlin.Result$Failure", "java.lang.Throwable exception", "exception"),
    ("kotlin.Result$Failure", "void <init>(java.lang.Throwable)", "<init>"),
    (
        "kotlin.coroutines.Continuation",
        "void resumeWith(java.lang.Object)",
        "resumeWith",
    ),
    (
        "kotlin.coroutines.intrinsics.IntrinsicsKt__IntrinsicsKt",
        "java.lang.Object getCOROUTINE_SUSPENDED()",
        "getCOROUTINE_SUSPENDED",
    ),
    (API, "void <init>()", "<init>"),
    (API, f"{API} getInstance(java.lang.String)", "getInstance"),
    (
        API,
        "java.lang.Object getAll(java.lang.String,java.util.List,"
        "kotlin.coroutines.Continuation)",
        "getAll",
    ),
    (
        API,
        "java.lang.Object setString(java.lang.String,java.lang.String,"
        "kotlin.coroutines.Continuation)",
        "setString",
    ),
)


def verify(mapping_text):
    """Return actionable failures; an empty list means required names survived."""
    classes = {}
    members = {}
    current = None
    for line in mapping_text.splitlines():
        match = re.fullmatch(r"(\S+) -> (\S+):", line)
        if match:
            current, renamed = match.groups()
            classes[current] = renamed
            members[current] = []
        elif current is not None and line.startswith(" ") and " -> " in line:
            declaration, renamed = line.strip().rsplit(" -> ", 1)
            declaration = re.sub(r"^\d+:\d+:", "", declaration)
            declaration = re.sub(r":\d+(?::\d+)?$", "", declaration)
            members[current].append((declaration, renamed))

    failures = []
    for name in REQUIRED_CLASSES:
        renamed = classes.get(name)
        if renamed != name:
            failures.append(f"JNI class {name}: {renamed or 'missing'}")
    for owner, declaration, expected_name in REQUIRED_MEMBERS:
        # R8 omits unchanged identity fields and abstract methods. Their actual
        # existence is checked from APK DEX definitions below, not inferred from
        # an absent mapping row.
        for original, renamed in members.get(owner, ()):
            if original == declaration and renamed != expected_name:
                failures.append(f"JNI member renamed: {owner}.{declaration}")

    # A retained Java method name is insufficient: Kotlin descriptor types must
    # retain their names too. The class checks above enforce Continuation's
    # literal Lkotlin/coroutines/Continuation; descriptor used by getAll/setString.
    return failures


def dex_definitions(data):
    """Read declared fields/methods from a standard Android DEX, without SDK tools."""
    if not data.startswith(b"dex\n"):
        raise ValueError("APK contains an unsupported DEX format")

    def uint(offset):
        return struct.unpack_from("<I", data, offset)[0]

    def uleb(offset):
        value = 0
        for shift in range(0, 35, 7):
            byte = data[offset]
            offset += 1
            value |= (byte & 127) << shift
            if byte < 128:
                return value, offset
        raise ValueError("Invalid DEX variable-length integer")

    strings = []
    for index in range(uint(56)):
        offset = uint(uint(60) + index * 4)
        _, start = uleb(offset)
        end = data.index(b"\0", start)
        # Java names/descriptors being checked are ASCII. Non-ASCII strings in
        # other app resources are irrelevant to this symbol-only inspection.
        strings.append(data[start:end].decode("utf-8", errors="replace"))

    def java_type(descriptor):
        primitive = {"V": "void", "Z": "boolean", "B": "byte", "C": "char",
                     "S": "short", "I": "int", "J": "long", "F": "float",
                     "D": "double"}
        if descriptor.startswith("["):
            return java_type(descriptor[1:]) + "[]"
        if descriptor.startswith("L"):
            return descriptor[1:-1].replace("/", ".")
        return primitive[descriptor]

    types = [java_type(strings[uint(uint(68) + i * 4)]) for i in range(uint(64))]
    protos = []
    for index in range(uint(72)):
        _, return_type, params_offset = struct.unpack_from(
            "<III", data, uint(76) + index * 12
        )
        params = []
        if params_offset:
            for i in range(uint(params_offset)):
                type_index = struct.unpack_from("<H", data, params_offset + 4 + i * 2)[0]
                params.append(types[type_index])
        protos.append((types[return_type], ",".join(params)))

    field_ids = []
    for index in range(uint(80)):
        owner, field_type, name = struct.unpack_from("<HHI", data, uint(84) + index * 8)
        field_ids.append((types[owner], f"{types[field_type]} {strings[name]}"))
    method_ids = []
    for index in range(uint(88)):
        owner, proto, name = struct.unpack_from("<HHI", data, uint(92) + index * 8)
        return_type, params = protos[proto]
        method_ids.append((types[owner], f"{return_type} {strings[name]}({params})"))

    defined = set()
    for index in range(uint(96)):
        offset = uint(uint(100) + index * 32 + 24)
        if not offset:
            continue
        sizes = []
        for _ in range(4):
            size, offset = uleb(offset)
            sizes.append(size)
        # Only declared entries count; a reference in method_ids/field_ids alone
        # does not prove the target member survived shrinking.
        for group, size in enumerate(sizes):
            member_index = 0
            for _ in range(size):
                delta, offset = uleb(offset)
                member_index += delta
                _, offset = uleb(offset)  # access flags
                if group >= 2:
                    _, offset = uleb(offset)  # code offset (zero for abstract)
                    defined.add(method_ids[member_index])
                else:
                    defined.add(field_ids[member_index])
    return defined


def verify_apk(apk):
    definitions = set()
    with zipfile.ZipFile(apk) as archive:
        dex_files = [name for name in archive.namelist()
                     if re.fullmatch(r"classes(?:\d+)?\.dex", name)]
        if not dex_files:
            raise ValueError("APK does not contain classes.dex")
        for name in dex_files:
            definitions.update(dex_definitions(archive.read(name)))
    return [f"JNI definition missing from APK: {owner}.{declaration}"
            for owner, declaration, _ in REQUIRED_MEMBERS
            if (owner, declaration) not in definitions]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "mapping", nargs="?", type=Path, default=DEFAULT_MAPPING,
        help="release R8 mapping.txt (defaults to this project's release output)",
    )
    parser.add_argument("--apk", type=Path, default=DEFAULT_APK,
                        help="release APK whose actual JNI declarations are checked")
    args = parser.parse_args()
    try:
        failures = verify(args.mapping.read_text(encoding="utf-8"))
        failures.extend(verify_apk(args.apk))
    except (OSError, ValueError, IndexError, KeyError, struct.error,
            zipfile.BadZipFile) as error:
        print(f"Cannot inspect release artifacts: {error}", file=sys.stderr)
        return 2
    if failures:
        print("Release Kotlin/JNI bridge is not preserved:", file=sys.stderr)
        for failure in failures:
            print(f"- {failure}", file=sys.stderr)
        return 1
    print(
        f"Release Kotlin/JNI artifacts passed: {len(REQUIRED_CLASSES)} mapped classes, "
        f"{len(REQUIRED_MEMBERS)} APK definitions and suspend descriptors retained."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
