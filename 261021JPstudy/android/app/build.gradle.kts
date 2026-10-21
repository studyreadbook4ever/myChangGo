import java.util.Properties

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

val signingPropertiesPath = System.getenv("JPSTUDY_SIGNING_PROPERTIES")
val signingPropertiesFile = signingPropertiesPath?.let { file(it) }
val releaseRequested = gradle.startParameter.taskNames.any {
    it.contains("release", ignoreCase = true)
}
if (releaseRequested) {
    require(signingPropertiesFile?.isFile == true) {
        "Release signing requires JPSTUDY_SIGNING_PROPERTIES pointing to a private properties file. " +
            "See docs/RELEASE_SIGNING.md."
    }
}
val releaseProperties = Properties().apply {
    if (signingPropertiesFile?.isFile == true) {
        signingPropertiesFile.inputStream().use { load(it) }
    }
}

android {
    namespace = "kr.changgo.jpstudy"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = "kr.changgo.jpstudy"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = maxOf(23, flutter.minSdkVersion)
        targetSdk = flutter.targetSdkVersion
        // Uses the version code from pubspec.yaml. When using split APKs, 1000 * ABI_VERSION
        // is added automatically by Flutter. (https://developer.android.com/studio/build/configure-apk-splits#configure-APK-versions)
        // You can force using the value of versionCode by specifying the `-P force-version-code-ignoring-abi=true`
        // flag during build.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    signingConfigs {
        if (signingPropertiesFile?.isFile == true) {
            for (name in listOf("storeFile", "storePassword", "keyAlias", "keyPassword")) {
                require(!releaseProperties.getProperty(name).isNullOrBlank()) {
                    "Missing release signing property: $name"
                }
            }
            create("release") {
                storeFile = file(releaseProperties.getProperty("storeFile"))
                storePassword = releaseProperties.getProperty("storePassword")
                keyAlias = releaseProperties.getProperty("keyAlias")
                keyPassword = releaseProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.findByName("release")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}
