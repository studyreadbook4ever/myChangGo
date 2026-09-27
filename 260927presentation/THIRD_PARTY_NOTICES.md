# Third-party notices

The application uses Kotlin application code and Android drawing, PDF rendering,
audio, video codec, and media-library APIs. It does not bundle Microsoft Office,
PowerPoint, an Office viewer SDK, Apache POI, LibreOffice, FFmpeg, downloaded templates,
commercial fonts, or third-party stock images. The sample PDF presentations and their
vector artwork were created for this repository by `tools/generate_fixtures.py`.

## Code distributed in the application

| Component | Version | License / attribution |
| --- | --- | --- |
| Kotlin JVM standard library | 1.9.24 | Apache License 2.0; Copyright JetBrains s.r.o. and respective authors and developers |
| GWT-derived Kotlin collection code | Included in Kotlin 1.9.24 | Apache License 2.0; Copyright 2007–2008 Google Inc. |
| Guava-derived unsigned-number code | Included in Kotlin 1.9.24 | Apache License 2.0; Copyright 2011 The Guava Authors |
| Boost-derived Kotlin math code | Included in Kotlin 1.9.24 | Boost Software License 1.0; Copyright Eric Ford & Hubert Holin 2001 |
| JetBrains Java annotations | Kotlin transitive dependency | Apache License 2.0; JetBrains s.r.o. |

Full upstream license and notice files are retained in [docs/licenses](docs/licenses/).
The relevant source inventory is the
[Kotlin 1.9.24 license inventory](https://github.com/JetBrains/kotlin/blob/v1.9.24/license/README.md).
These permissive licenses allow redistribution subject to their terms, including
retaining applicable notices. The Android operating system and its fonts/codecs are
provided by the device and are not copied into this APK.

## Development and tests

Gradle and the Android Gradle plugin are build tools, and the Kotlin compiler is a
build-time dependency. JUnit and AndroidX Test/Espresso dependencies belong to test
configurations; they are not included in the release APK. Their own distributions
retain their upstream licenses. The checked-in Gradle wrapper is covered by the
Apache License 2.0 notice in its scripts and the license packaged in its JAR.

## Fonts, presentation content, and platform codecs

The application does not distribute fonts or codec libraries. The demo PDFs refer
only to PDF standard fonts and embed no font files. Android supplies the PDF renderer,
font substitution, H.264 encoder, and AAC encoder available on the device.

Users retain responsibility for the content they import and share. Importing a PDF
does not grant redistribution rights to its artwork, embedded fonts, photographs,
or trademarks. The original sample assets may be redistributed under this project's
license. No Office format implementation or PowerPoint playback SDK is included.

Dependency and source-license review was performed on 2026-09-27. This inventory
describes the code and assets actually selected for this project, not a promise that
every possible presentation or use has identical licensing terms.
