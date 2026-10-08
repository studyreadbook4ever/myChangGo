# Validation status

- Offline Dart model verification: **13 checks passed** with Dart 3.9.2.
  Run `dart tools/check_models.dart` to repeat it.
- Dart formatting: completed.
- Android XML files: parsed successfully.
- APK build script: Bash syntax validated.
- Gradle Wrapper JAR: archive structure and entry point validated.
- Flutter analysis, widget/storage tests and Android APK build: **not yet run**.
  The build environment blocked Flutter CLI execution. No APK is included.

`tools/build_apk.sh` runs dependency resolution, Flutter analysis and all Flutter
tests before producing an APK. Passing the offline checks alone does not verify
the Flutter UI or Android build.
