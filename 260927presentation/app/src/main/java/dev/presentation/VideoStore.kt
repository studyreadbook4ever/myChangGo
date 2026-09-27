package dev.presentation

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.provider.MediaStore
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

object VideoStore {
    fun save(context: Context, file: File): Uri {
        require(file.isFile && file.length() > 0) { "저장할 영상이 없습니다." }
        val name = "Presentation_${SimpleDateFormat("yyyyMMdd_HHmmss_SSS", Locale.US).format(Date())}.mp4"
        val values = ContentValues().apply {
            put(MediaStore.Video.Media.DISPLAY_NAME, name)
            put(MediaStore.Video.Media.MIME_TYPE, "video/mp4")
            put(MediaStore.Video.Media.RELATIVE_PATH, "Movies/PresentationStudio")
            put(MediaStore.Video.Media.IS_PENDING, 1)
        }
        val resolver = context.contentResolver
        val uri = resolver.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, values) ?: error("영상 저장 공간을 열 수 없습니다.")
        try {
            resolver.openOutputStream(uri)?.use { output -> file.inputStream().use { it.copyTo(output) } }
                ?: error("영상 파일에 쓸 수 없습니다.")
            check(resolver.update(uri, ContentValues().apply { put(MediaStore.Video.Media.IS_PENDING, 0) }, null, null) > 0) { "갤러리에 영상을 공개하지 못했습니다. 앱에서 저장을 다시 시도해 주세요." }
            file.delete()
            return uri
        } catch (e: Exception) { resolver.delete(uri, null, null); throw e }
    }
}
