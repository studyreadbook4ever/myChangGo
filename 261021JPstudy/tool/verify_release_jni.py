#!/usr/bin/env python3
"""Verify the release R8 artifact still exposes the Kotlin JNI bridge.

Debug tests cannot detect R8 renaming a descriptor used literally by Dart.
This checks the generated mapping, not the text of the ProGuard rules.
The required symbols come from jni 1.1.0 lib/src/kotlin.dart and the
shared_preferences_android 2.5.1 generated JNI API.
"""

import argparse
from pathlib import Path
import re
import sys


DEFAULT_MAPPING = Path(__file__).resolve().parents[1] / (
    "build/app/outputs/mapping/release/mapping.txt"
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
        retained = members.get(owner, ())
        if (declaration, expected_name) not in retained:
            failures.append(f"JNI member missing/renamed: {owner}.{declaration}")

    # A retained Java method name is insufficient: Kotlin descriptor types must
    # retain their names too. The class checks above enforce Continuation's
    # literal Lkotlin/coroutines/Continuation; descriptor used by getAll/setString.
    return failures


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "mapping", nargs="?", type=Path, default=DEFAULT_MAPPING,
        help="release R8 mapping.txt (defaults to this project's release output)",
    )
    args = parser.parse_args()
    try:
        failures = verify(args.mapping.read_text(encoding="utf-8"))
    except OSError as error:
        print(f"Cannot inspect release mapping: {error}", file=sys.stderr)
        return 2
    if failures:
        print("Release Kotlin/JNI bridge is not preserved:", file=sys.stderr)
        for failure in failures:
            print(f"- {failure}", file=sys.stderr)
        return 1
    print(
        f"Release Kotlin/JNI mapping passed: {len(REQUIRED_CLASSES)} classes, "
        f"{len(REQUIRED_MEMBERS)} members and suspend descriptors retained."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
