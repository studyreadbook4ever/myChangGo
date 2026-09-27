package dev.presentation

import android.graphics.Color
import android.net.Uri
import android.provider.OpenableColumns
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Exercises ContentResolver and a separately installed provider, not file:// shortcuts. */
@RunWith(AndroidJUnit4::class)
class DocumentsImportTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    @Test fun contentUriImportUsesProviderMetadataAndRendersPdf() {
        val before = pendingFiles()
        var expectedSize = 0L
        context.contentResolver.query(FixtureProvider.DEMO_URI, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)!!.use { cursor ->
            assertTrue(cursor.moveToFirst())
            assertEquals(FixtureProvider.DEMO_NAME, cursor.getString(0))
            expectedSize = cursor.getLong(1)
            assertTrue(expectedSize > 0)
        }
        val imported = Documents.import(context, FixtureProvider.DEMO_URI)
        try {
            assertEquals(FixtureProvider.DEMO_NAME, imported.document.title)
            assertEquals(3, imported.document.slideCount)
            assertEquals(expectedSize, imported.file.length())
            assertEquals(context.cacheDir, imported.file.parentFile)
            assertEquals(64, imported.key.length)
            val bitmap = imported.document.render(0, 1280, 720)
            try {
                assertEquals(1280, bitmap.width)
                assertEquals(720, bitmap.height)
                assertEquals(255, Color.alpha(bitmap.getPixel(640, 360)))
                assertTrue(bitmap.getPixel(80, 80) != Color.BLACK)
            } finally { bitmap.recycle() }
        } finally { imported.document.close(); imported.file.delete() }
        assertEquals(before, pendingFiles())
    }

    @Test fun malformedContentUriCleansTemporaryCopiesAndDescriptors() {
        // Warm up provider initialization before measuring descriptor ownership.
        context.contentResolver.getType(FixtureProvider.MALFORMED_URI)
        val before = pendingFiles()
        val descriptorsBefore = descriptorCount()
        repeat(10) { rejected(FixtureProvider.MALFORMED_URI) }
        assertEquals(before, pendingFiles())
        assertTrue("Failed PDF imports leaked file descriptors", descriptorCount() <= descriptorsBefore + 4)
    }

    @Test fun unsupportedContentDespitePdfMimeAndNameIsRejectedAndCleaned() {
        assertEquals("application/pdf", context.contentResolver.getType(FixtureProvider.UNSUPPORTED_URI))
        val before = pendingFiles()
        val failure = rejected(FixtureProvider.UNSUPPORTED_URI)
        assertTrue(failure.message.orEmpty().contains("PDF 파일을 선택"))
        assertEquals(before, pendingFiles())
    }

    private fun rejected(uri: Uri): IllegalArgumentException {
        try {
            val unexpected = Documents.import(context, uri)
            unexpected.document.close()
            unexpected.file.delete()
        } catch (failure: IllegalArgumentException) { return failure }
        fail("Invalid provider content must be rejected")
        throw AssertionError("Unreachable")
    }
    private fun pendingFiles(): Set<String> = context.cacheDir.listFiles().orEmpty()
        .filter { it.name.startsWith("import-") && it.extension == "document" }.map { it.name }.toSet()
    private fun descriptorCount() = File("/proc/self/fd").list()?.size ?: 0
}
