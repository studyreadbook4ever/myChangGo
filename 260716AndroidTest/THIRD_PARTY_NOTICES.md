# Third-Party Notices

이 문서는 `260716AndroidTest` 디렉터리가 직접 포함하거나 test/build 시 참조하는 주요 외부 구성요소를 기록한다.

## Gradle Wrapper 8.10.2

- Project: Gradle
- License: Apache License 2.0 (`Apache-2.0`)
- Source: <https://github.com/gradle/gradle>
- Distribution: <https://services.gradle.org/distributions/gradle-8.10.2-bin.zip>
- Included files: `gradlew`, `gradlew.bat`, `gradle/wrapper/gradle-wrapper.jar`

Wrapper script에는 Apache-2.0 및 SPDX 고지가 있으며, wrapper JAR의 `META-INF/LICENSE`에 라이선스 전문이 포함되어 있다. 공식 Gradle 문서는 wrapper script, properties, JAR를 version control에 함께 커밋하는 방식을 권장한다.

## JUnit 4.13.2

- Project: JUnit 4
- License: Eclipse Public License 1.0 (`EPL-1.0`)
- Source: <https://github.com/junit-team/junit4>
- Scope: local JVM test dependency only

JUnit은 Maven/Gradle dependency로 내려받으며 이 저장소에 JAR를 vendoring하지 않는다. 앱 APK에도 포함되지 않는다.

## Hamcrest Core 1.3

- Project: Hamcrest
- License: BSD 3-Clause style license
- Source: <https://github.com/hamcrest/JavaHamcrest>
- Scope: JUnit의 transitive local test dependency only

Hamcrest는 Maven/Gradle dependency로 내려받으며 이 저장소에 JAR를 vendoring하지 않는다. 앱 APK에도 포함되지 않는다.

## Android SDK and Android Gradle Plugin

Android SDK platform/build tools와 Android Gradle Plugin은 사용자의 SDK 또는 configured repository에서 제공되는 build-time 도구다. 이 디렉터리는 Android SDK, emulator system image, Android Gradle Plugin binary를 포함하지 않는다. 각 도구에는 공급자의 별도 라이선스가 적용된다.

## Project Source

이 문서는 외부 구성요소 고지이며 프로젝트 자체 소스의 라이선스를 부여하지 않는다. 프로젝트 자체의 재사용 조건은 상위 저장소의 `LICENSE`를 따른다. 별도 `LICENSE`가 없으면 기본 저작권이 유지된다.
