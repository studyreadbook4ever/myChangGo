package com.example.kanjiwake

import android.content.Context
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import java.io.File
import java.io.FileOutputStream
import java.util.Locale

data class DeviceAiProfile(
    val deviceName: String,
    val socName: String,
    val npuTarget: String?,
    val recommendedNpuFile: String?
)

data class ImportedOnDeviceModel(
    val displayName: String,
    val path: String,
    val sizeBytes: Long
)

object OnDeviceCompatibility {
    private val supportedQualcomm = setOf("sm8550", "sm8650", "sm8750", "sm8850")
    private val supportedMediaTek = setOf("mt6989", "mt6991", "mt6993")

    fun currentProfile(): DeviceAiProfile {
        val manufacturer = Build.MANUFACTURER.orEmpty().trim()
        val model = Build.MODEL.orEmpty().trim()
        val soc = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            Build.SOC_MODEL.orEmpty().trim()
        } else {
            ""
        }
        val deviceName = listOf(manufacturer, model)
            .filter { it.isNotBlank() }
            .distinct()
            .joinToString(" ")
            .ifBlank { "Android 휴대폰" }
        val deviceText = listOf(soc, Build.HARDWARE, Build.BOARD, model).joinToString(" ")
        val target = npuTargetFromDeviceText(deviceText)
        return DeviceAiProfile(
            deviceName = deviceName,
            socName = soc.ifBlank { Build.HARDWARE.orEmpty().ifBlank { "확인되지 않음" } },
            npuTarget = target,
            recommendedNpuFile = target?.let(::gemmaOneBFileForTarget)
        )
    }

    fun npuTargetFromDeviceText(raw: String): String? {
        val text = raw.lowercase(Locale.US)
        val chip = Regex("(?:sm|mt)\\d{4}").find(text)?.value
        if (chip in supportedQualcomm || chip in supportedMediaTek) return chip
        return if (("tensor" in text && "g5" in text) || "gs501" in text) {
            "google_tensor_g5"
        } else {
            null
        }
    }

    fun targetFromModelName(fileName: String): String? {
        val text = fileName.lowercase(Locale.US)
        val chip = Regex("(?:sm|mt)\\d{4}").find(text)?.value
        if (chip != null) return chip
        return if ("google_tensor_g5" in text) "google_tensor_g5" else null
    }

    fun compatibilityError(fileName: String, profile: DeviceAiProfile): String? {
        val modelTarget = targetFromModelName(fileName) ?: return null
        return if (profile.npuTarget == modelTarget) {
            null
        } else {
            "이 모델은 $modelTarget 칩 전용입니다. 현재 휴대폰 칩(${profile.socName})에 맞는 파일이나 이름에 칩 코드가 없는 일반 .litertlm 파일을 선택해 주세요."
        }
    }

    fun deviceGuide(profile: DeviceAiProfile): String = if (profile.recommendedNpuFile != null) {
        "${profile.deviceName} · 칩 ${profile.socName}\nNPU용 권장 파일: ${profile.recommendedNpuFile}"
    } else {
        "${profile.deviceName} · 칩 ${profile.socName}\n이 칩의 NPU 호환 정보를 확인할 수 없어 일반 int4 .litertlm 모델과 GPU/CPU 실행을 권장합니다."
    }

    fun recommendedGemma270MFile(profile: DeviceAiProfile): String = when {
        profile.npuTarget?.startsWith("sm") == true ->
            "gemma3-270m-it-q8.qualcomm.${profile.npuTarget}.litertlm"
        profile.npuTarget?.startsWith("mt") == true ->
            "gemma3-270m-it-q8.mediatek.${profile.npuTarget}.litertlm"
        else -> "gemma3-270m-it-q8.litertlm"
    }

    private fun gemmaOneBFileForTarget(target: String): String = when (target) {
        "google_tensor_g5" -> "Gemma3-1B-IT_q8_ekv1280_Google_Tensor_G5.litertlm"
        else -> "Gemma3-1B-IT_q4_ekv1280_${target}.litertlm"
    }
}

object OnDeviceModelStore {
    fun importModel(
        context: Context,
        uri: Uri,
        previousPath: String?,
        validateName: (String) -> String? = { null }
    ): ImportedOnDeviceModel {
        val metadata = readMetadata(context, uri)
        require(metadata.name.endsWith(".litertlm", ignoreCase = true)) {
            ".litertlm 형식의 모델 파일을 선택해 주세요."
        }
        validateName(metadata.name)?.let { error(it) }
        val modelsDir = File(context.filesDir, MODEL_DIRECTORY).apply {
            check(exists() || mkdirs()) { "모델 저장 폴더를 만들지 못했습니다." }
        }
        if (metadata.size > 0L) {
            val required = metadata.size + MIN_FREE_SPACE_BYTES
            require(modelsDir.usableSpace >= required) {
                "저장 공간이 부족합니다. 모델 크기 외에 최소 256MB의 여유 공간을 확보해 주세요."
            }
        }

        val safeName = metadata.name
            .replace(Regex("[^A-Za-z0-9._-]"), "_")
            .takeLast(160)
            .ifBlank { "model.litertlm" }
        val destination = File(modelsDir, "${System.currentTimeMillis()}-$safeName")
        val partial = File(modelsDir, "${destination.name}.part")
        var copied = 0L
        try {
            val source = context.contentResolver.openInputStream(uri)
                ?: error("선택한 모델 파일을 열 수 없습니다.")
            source.use { input ->
                FileOutputStream(partial).use { output ->
                    val buffer = ByteArray(COPY_BUFFER_BYTES)
                    while (true) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        output.write(buffer, 0, count)
                        copied += count
                    }
                    output.fd.sync()
                }
            }
            require(copied >= MIN_MODEL_BYTES) {
                "선택한 파일이 너무 작습니다. 다운로드가 끝난 .litertlm 모델인지 확인해 주세요."
            }
            if (metadata.size > 0L) {
                require(copied == metadata.size) { "모델 파일 복사가 끝나지 않았습니다. 다시 선택해 주세요." }
            }
            check(partial.renameTo(destination)) { "모델 파일 저장을 완료하지 못했습니다." }
            previousPath?.let { deleteManagedModel(context, it, except = destination) }
            return ImportedOnDeviceModel(metadata.name, destination.absolutePath, copied)
        } finally {
            partial.delete()
        }
    }

    fun existingFile(context: Context, path: String): File? {
        val file = File(path)
        if (!file.isFile || file.length() < MIN_MODEL_BYTES) return null
        val root = File(context.filesDir, MODEL_DIRECTORY).canonicalFile
        val canonical = runCatching { file.canonicalFile }.getOrNull() ?: return null
        return canonical.takeIf { it.parentFile == root }
    }

    fun fileLabel(path: String): String = File(path).name.substringAfter('-', File(path).name)

    fun formatSize(bytes: Long): String = when {
        bytes >= 1024L * 1024L * 1024L -> String.format(
            Locale.KOREA,
            "%.1fGB",
            bytes.toDouble() / (1024.0 * 1024.0 * 1024.0)
        )
        else -> String.format(Locale.KOREA, "%.0fMB", bytes.toDouble() / (1024.0 * 1024.0))
    }

    private fun deleteManagedModel(context: Context, path: String, except: File) {
        val old = existingFile(context, path) ?: return
        if (old.absolutePath != except.absolutePath) old.delete()
    }

    private fun readMetadata(context: Context, uri: Uri): SourceMetadata {
        var name = uri.lastPathSegment?.substringAfterLast('/').orEmpty()
        var size = -1L
        val cursor = context.contentResolver.query(
            uri,
            arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE),
            null,
            null,
            null
        )
        cursor?.use { source ->
            if (source.moveToFirst()) {
                val nameIndex = source.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                val sizeIndex = source.getColumnIndex(OpenableColumns.SIZE)
                if (nameIndex >= 0) name = source.getString(nameIndex).orEmpty()
                if (sizeIndex >= 0 && !source.isNull(sizeIndex)) size = source.getLong(sizeIndex)
            }
        }
        return SourceMetadata(name.ifBlank { "model.litertlm" }, size)
    }

    private data class SourceMetadata(val name: String, val size: Long)

    private const val MODEL_DIRECTORY = "on-device-models"
    private const val COPY_BUFFER_BYTES = 1024 * 1024
    private const val MIN_MODEL_BYTES = 1024L * 1024L
    private const val MIN_FREE_SPACE_BYTES = 256L * 1024L * 1024L
}
