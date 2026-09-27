package dev.presentation

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import dev.presentation.slides.PresentationDocument
import java.io.File
import java.security.MessageDigest
import kotlin.math.ceil
import kotlin.math.floor

data class ImportedDocument(val document: PresentationDocument, val key: String, val file: File)

object Documents {
    private const val MAX_BYTES = 100L * 1024 * 1024

    fun import(context: Context, uri: Uri): ImportedDocument {
        val name = context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
            if (it.moveToFirst()) it.getString(0) else null
        } ?: "프레젠테이션"
        val pending = File.createTempFile("import-", ".document", context.cacheDir)
        try {
            context.contentResolver.openInputStream(uri)?.use { input ->
                pending.outputStream().use { output ->
                    val buffer = ByteArray(32 * 1024)
                    var total = 0L
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        total += read
                        require(total <= MAX_BYTES) { "파일은 100 MB 이하로 준비해 주세요." }
                        output.write(buffer, 0, read)
                    }
                }
            } ?: error("파일을 읽을 수 없습니다. 파일을 기기에 저장한 뒤 다시 선택해 주세요.")
            return open(pending, name)
        } catch (e: Exception) { pending.delete(); throw e }
    }

    fun open(file: File, name: String): ImportedDocument {
        require(file.length() in 1..MAX_BYTES) { "비어 있지 않은 100 MB 이하의 PDF 파일을 선택해 주세요." }
        // Inspect content, not an extension or the MIME type supplied by a document provider.
        // PDFium also accepts a PDF header after a short prefix used by some PDF producers.
        val header = file.inputStream().use { input ->
            val bytes = ByteArray(1024)
            val count = input.read(bytes)
            String(bytes, 0, maxOf(count, 0), Charsets.US_ASCII)
        }
        require(header.contains("%PDF-")) { "PDF 파일을 선택해 주세요. PowerPoint에서는 ‘다른 이름으로 저장 → PDF’로 내보낼 수 있습니다." }
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(32768)
            var total = 0L
            while (true) {
                val n = input.read(buffer)
                if (n < 0) break
                total += n
                require(total <= MAX_BYTES) { "파일은 100 MB 이하로 준비해 주세요." }
                digest.update(buffer, 0, n)
            }
        }
        val key = digest.digest().joinToString("") { "%02x".format(it) }
        val document = try { PdfDocument(file, name) } catch (e: SecurityException) {
            throw IllegalArgumentException("암호로 보호된 PDF입니다. 암호를 해제한 사본을 선택해 주세요.", e)
        } catch (e: java.io.IOException) {
            throw IllegalArgumentException("PDF를 읽을 수 없습니다. 파일이 손상되었거나 보호되어 있는지 확인해 주세요.", e)
        }
        if (document.slideCount == 0) { document.close(); error("페이지가 없는 PDF입니다.") }
        return ImportedDocument(document, key, file)
    }
}

class PdfDocument(file: File, override val title: String) : PresentationDocument {
    private val descriptor = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
    private val renderer = try { PdfRenderer(descriptor) } catch (e: Exception) { descriptor.close(); throw e }
    override val slideCount: Int = renderer.pageCount
    override val warnings = emptyList<String>()
    private var closed = false
    @Synchronized override fun notes(index: Int): String {
        check(!closed) { "PDF가 닫혔습니다." }
        require(index in 0 until slideCount) { "페이지 번호가 범위를 벗어났습니다." }
        return ""
    }
    @Synchronized override fun render(index: Int, width: Int, height: Int): Bitmap {
        check(!closed) { "PDF가 닫혔습니다." }
        require(index in 0 until slideCount) { "페이지 번호가 범위를 벗어났습니다." }
        require(width in 1..4096 && height in 1..4096 && width.toLong() * height <= 8_294_400L) { "출력 이미지 크기가 너무 큽니다." }
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        Canvas(bitmap).drawColor(Color.BLACK)
        try {
            renderer.openPage(index).use { page ->
                require(page.width > 0 && page.height > 0) { "PDF 페이지 크기가 올바르지 않습니다." }
                val scale = minOf(width.toFloat() / page.width, height.toFloat() / page.height)
                val left = (width - page.width * scale) / 2f
                val top = (height - page.height * scale) / 2f
                val canvas = Canvas(bitmap)
                canvas.drawRect(left, top, left + page.width * scale, top + page.height * scale,
                    android.graphics.Paint().apply { color = Color.WHITE })
                val transform = Matrix().apply { postScale(scale, scale); postTranslate(left, top) }
                val clip = android.graphics.Rect(floor(left).toInt().coerceAtLeast(0), floor(top).toInt().coerceAtLeast(0),
                    ceil(left + page.width * scale).toInt().coerceAtMost(width), ceil(top + page.height * scale).toInt().coerceAtMost(height))
                page.render(bitmap, clip, transform, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
            }
            return bitmap
        } catch (e: Throwable) { bitmap.recycle(); throw e }
    }
    @Synchronized override fun close() {
        if (closed) return
        closed = true
        try { renderer.close() } finally { descriptor.close() }
    }
}
