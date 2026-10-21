# Pigeon native interop setup (Step 5):
# https://flutter.googlesource.com/mirrors/packages/+/refs/heads/main/packages/pigeon/native_interop_guide.md
# jni 1.1.0 invokes Kotlin suspend APIs through literal JNI class, field and
# method descriptors (jni/lib/src/kotlin.dart). R8 cannot infer these Dart
# lookups. Keep this runtime bridge and descriptor types stable while allowing
# the rest of the app and plugin implementations to be optimized.
-keep,includedescriptorclasses class kotlin.Unit { *; }
-keep,includedescriptorclasses class kotlin.Result { *; }
-keep,includedescriptorclasses class kotlin.Result$Failure { *; }
-keep,includedescriptorclasses interface kotlin.coroutines.Continuation { *; }
-keep,includedescriptorclasses class kotlin.coroutines.intrinsics.** { *; }

# Additional Kotlin descriptors in shared_preferences_android JNI bindings.
-keep,includedescriptorclasses class kotlin.jvm.internal.DefaultConstructorMarker { *; }
-keep,includedescriptorclasses interface kotlin.enums.EnumEntries { *; }
