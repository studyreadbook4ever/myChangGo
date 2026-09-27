package dev.presentation

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Paint
import android.graphics.pdf.PdfDocument as AndroidPdfDocument
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.RandomAccessFile
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Tests the real device PDF engine; these do not mock Bitmap, Canvas or PdfRenderer. */
@RunWith(AndroidJUnit4::class)
class PdfDocumentTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val files = mutableListOf<File>()

    @After fun cleanup() { files.forEach { it.delete() } }

    @Test fun bundledDemoRendersFirstAndLastPagesAtVideoDimensions() {
        val file = asset("demo.pdf")
        PdfDocument(file, "발표 자료").use { document ->
            assertEquals("발표 자료", document.title)
            assertTrue(document.slideCount >= 2)
            val first = document.render(0, 1280, 720)
            val last = document.render(document.slideCount - 1, 1280, 720)
            try {
                assertEquals(1280, first.width)
                assertEquals(720, first.height)
                assertEquals(Bitmap.Config.ARGB_8888, first.config)
                assertEquals(255, Color.alpha(first.getPixel(5, 5)))
                assertFalse("Different pages must produce different video frames", first.sameAs(last))
                assertTrue("Text and graphics should appear on the page", distinctSampleColors(first).size > 1)
            } finally { first.recycle(); last.recycle() }
            assertEquals("", document.notes(0))
            assertEquals("", document.notes(1))
        }
    }

    @Test fun widescreenPageFillsFrameAndPreservesMarkerLocation() {
        renderGenerated(960, 540) { bitmap ->
            assertColor(Color.WHITE, bitmap, 5, 5)
            assertColor(Color.WHITE, bitmap, 1275, 715)
            assertColor(Color.RED, bitmap, 80, 80)
            assertColor(Color.BLUE, bitmap, 640, 360)
        }
    }

    @Test fun fourByThreePageHasSymmetricBlackSideBars() {
        renderGenerated(720, 540) { bitmap ->
            assertColor(Color.BLACK, bitmap, 80, 360)
            assertColor(Color.BLACK, bitmap, 1200, 360)
            assertColor(Color.WHITE, bitmap, 165, 5)
            assertColor(Color.WHITE, bitmap, 1115, 715)
            assertColor(Color.RED, bitmap, 240, 80)
            assertColor(Color.BLUE, bitmap, 640, 360)
        }
    }

    @Test fun portraitPdfIsCenteredWithoutStretching() {
        renderGenerated(540, 720) { bitmap ->
            assertColor(Color.BLACK, bitmap, 100, 360)
            assertColor(Color.BLACK, bitmap, 1180, 360)
            assertColor(Color.WHITE, bitmap, 375, 5)
            assertColor(Color.WHITE, bitmap, 905, 715)
            assertColor(Color.RED, bitmap, 430, 60)
            assertColor(Color.BLUE, bitmap, 640, 360)
        }
    }

    @Test fun ultrawidePageHasSymmetricBlackTopAndBottomBars() {
        renderGenerated(1440, 540) { bitmap ->
            assertColor(Color.BLACK, bitmap, 640, 20)
            assertColor(Color.BLACK, bitmap, 640, 700)
            assertColor(Color.WHITE, bitmap, 5, 125)
            assertColor(Color.WHITE, bitmap, 1275, 595)
            assertColor(Color.RED, bitmap, 54, 174)
            assertColor(Color.BLUE, bitmap, 640, 360)
        }
    }

    @Test fun mixedPageSizesAreCalculatedForEachPage() {
        val file = generated(listOf(960 to 540, 540 to 720, 720 to 540))
        PdfDocument(file, "mixed").use { document ->
            assertEquals(3, document.slideCount)
            for ((index, expectedLeftEdge) in listOf(Color.WHITE, Color.BLACK, Color.BLACK).withIndex()) {
                val bitmap = document.render(index, 1280, 720)
                try { assertColor(expectedLeftEdge, bitmap, 5, 5); assertColor(Color.BLUE, bitmap, 640, 360) }
                finally { bitmap.recycle() }
            }
        }
    }

    @Test fun arbitraryOutputSizeMaintainsAspectRatio() {
        PdfDocument(generated(listOf(960 to 540)), "small").use { document ->
            val bitmap = document.render(0, 640, 640)
            try {
                assertEquals(640, bitmap.width)
                assertEquals(640, bitmap.height)
                assertColor(Color.BLACK, bitmap, 320, 10)
                assertColor(Color.WHITE, bitmap, 5, 145)
                assertColor(Color.BLUE, bitmap, 320, 320)
                assertColor(Color.BLACK, bitmap, 320, 630)
            } finally { bitmap.recycle() }
        }
    }

    @Test fun pdfContentOpensRegardlessOfFilenameExtension() {
        val file = asset("demo.pdf", ".binary")
        val imported = Documents.open(file, "사용자가 바꾼 이름.txt")
        imported.document.use {
            assertEquals("사용자가 바꾼 이름.txt", it.title)
            assertTrue(it.slideCount >= 2)
            assertEquals(64, imported.key.length)
            assertTrue(imported.key.matches(Regex("[0-9a-f]{64}")))
        }
    }

    @Test fun rotatedPdfUsesDisplayedPageOrientation() {
        PdfDocument(asset("demo-rotated.pdf"), "rotated").use { document ->
            val bitmap = document.render(0, 1280, 720)
            try {
                // The stored MediaBox is portrait (540 × 960) with /Rotate 90; the
                // visible page is 16:9, so both horizontal corners must contain paper.
                assertTrue(Color.red(bitmap.getPixel(5, 360)) > 0)
                assertTrue(Color.red(bitmap.getPixel(1275, 360)) > 0)
                assertTrue(distinctSampleColors(bitmap).size > 2)
            } finally { bitmap.recycle() }
        }
    }

    @Test fun headerAfterShortPrefixIsAcceptedByNativePdfEngine() {
        val imported = Documents.open(asset("demo-prefixed.pdf", ".data"), "prefix.data")
        imported.document.use { document ->
            assertEquals(3, document.slideCount)
            val bitmap = document.render(0, 1280, 720)
            try { assertTrue(distinctSampleColors(bitmap).size > 2) } finally { bitmap.recycle() }
        }
    }

    @Test fun sameContentRetainsNotesKeyAfterRename() {
        val file = asset("demo.pdf")
        val first = Documents.open(file, "첫 이름.pdf")
        val key = first.key
        first.document.close()
        val second = Documents.open(file, "두번째 이름.pdf")
        second.document.use { assertEquals(key, second.key) }
    }

    @Test fun invalidPageIndicesAreRejectedWithoutBreakingNextRender() {
        PdfDocument(asset("demo.pdf"), "bounds").use { document ->
            expectFailure<IllegalArgumentException> { document.render(-1, 1280, 720) }
            expectFailure<IllegalArgumentException> { document.render(document.slideCount, 1280, 720) }
            expectFailure<IllegalArgumentException> { document.notes(-1) }
            expectFailure<IllegalArgumentException> { document.notes(document.slideCount) }
            val bitmap = document.render(0, 1280, 720)
            assertFalse(bitmap.isRecycled)
            bitmap.recycle()
        }
    }

    @Test fun invalidRenderDimensionsAreRejectedBeforeAllocating() {
        PdfDocument(asset("demo.pdf"), "bounds").use { document ->
            for ((width, height) in listOf(0 to 720, 1280 to 0, -1 to 720, 100000 to 100000)) {
                expectFailure<IllegalArgumentException> { document.render(0, width, height) }
            }
        }
    }

    @Test fun closeIsIdempotentAndClosedDocumentCannotRender() {
        val document = PdfDocument(asset("demo.pdf"), "closed")
        document.close()
        document.close()
        expectFailure<IllegalStateException> { document.render(0, 1280, 720) }
        expectFailure<IllegalStateException> { document.notes(0) }
    }

    @Test fun repeatedOpenRenderCloseDoesNotLeakDescriptors() {
        val file = asset("demo.pdf")
        val baseline = descriptorCount()
        repeat(20) {
            PdfDocument(file, "repeat").use { document -> document.render(it % 2, 320, 180).recycle() }
        }
        assertTrue("PDF descriptors should be closed", descriptorCount() <= baseline + 4)
    }

    @Test fun concurrentPageRequestsAreSerializedSafely() {
        val executor = Executors.newFixedThreadPool(3)
        try {
            PdfDocument(asset("demo.pdf"), "concurrent").use { document ->
                val results = executor.invokeAll((0 until 12).map { index -> Callable {
                    val bitmap = document.render(index % 2, 320, 180)
                    try { bitmap.width == 320 && bitmap.height == 180 } finally { bitmap.recycle() }
                } }, 45, TimeUnit.SECONDS)
                results.forEach { assertTrue(it.get(30, TimeUnit.SECONDS)) }
            }
        } finally { executor.shutdownNow() }
    }

    @Test fun emptyMalformedAndRenamedNonPdfFilesAreRejected() {
        for (bytes in listOf(byteArrayOf(), "this is not a PDF".toByteArray(), "%PDF-1.7\nnot a valid PDF object graph".toByteArray(), byteArrayOf(0x50, 0x4b, 3, 4))) {
            val file = temp(".pdf").apply { writeBytes(bytes) }
            expectFailure<Exception> { Documents.open(file, "misleading.pdf").document.close() }
        }
    }

    @Test fun invalidPdfsDoNotLeakDescriptors() {
        val file = temp(".pdf").apply { writeText("%PDF-1.7\ninvalid") }
        val baseline = descriptorCount()
        repeat(20) { expectFailure<Exception> { PdfDocument(file, "broken").close() } }
        assertTrue("Failed imports must close the ParcelFileDescriptor", descriptorCount() <= baseline + 4)
    }

    @Test fun oversizedPdfIsRejectedBeforeReadingItsContents() {
        val file = temp(".pdf")
        RandomAccessFile(file, "rw").use { it.write("%PDF-1.7\n".toByteArray()); it.setLength(100L * 1024 * 1024 + 1) }
        expectFailure<IllegalArgumentException> { Documents.open(file, "too-large.pdf").document.close() }
    }

    private fun generated(dimensions: List<Pair<Int, Int>>): File {
        val file = temp(".pdf")
        val pdf = AndroidPdfDocument()
        try {
            dimensions.forEachIndexed { index, (width, height) ->
                val page = pdf.startPage(AndroidPdfDocument.PageInfo.Builder(width, height, index + 1).create())
                // Leave most of the PDF transparent; the renderer must composite on white.
                page.canvas.drawRect(40f, 40f, 80f, 80f, Paint().apply { color = Color.RED })
                page.canvas.drawRect(width / 2f - 20, height / 2f - 20, width / 2f + 20, height / 2f + 20, Paint().apply { color = Color.BLUE })
                pdf.finishPage(page)
            }
            file.outputStream().use(pdf::writeTo)
        } finally { pdf.close() }
        return file
    }

    private inline fun renderGenerated(width: Int, height: Int, check: (Bitmap) -> Unit) {
        PdfDocument(generated(listOf(width to height)), "geometry").use { document ->
            val bitmap = document.render(0, 1280, 720)
            try { check(bitmap) } finally { bitmap.recycle() }
        }
    }

    private fun temp(suffix: String) = File.createTempFile("pdf-test-", suffix, context.cacheDir).also(files::add)
    private fun asset(name: String, suffix: String = ".pdf"): File = temp(suffix).also { file ->
        instrumentation.context.assets.open(name).use { input -> file.outputStream().use { output -> input.copyTo(output) } }
    }
    private fun descriptorCount() = File("/proc/self/fd").list()?.size ?: 0
    private fun distinctSampleColors(bitmap: Bitmap): Set<Int> = buildSet {
        for (y in 30 until bitmap.height step 17) for (x in 30 until bitmap.width step 19) add(bitmap.getPixel(x, y))
    }
    private fun assertColor(expected: Int, bitmap: Bitmap, x: Int, y: Int) {
        val actual = bitmap.getPixel(x, y)
        val tolerance = 3
        assertTrue("Pixel ($x,$y): expected ${Integer.toHexString(expected)}, got ${Integer.toHexString(actual)}",
            kotlin.math.abs(Color.red(expected) - Color.red(actual)) <= tolerance &&
                kotlin.math.abs(Color.green(expected) - Color.green(actual)) <= tolerance &&
                kotlin.math.abs(Color.blue(expected) - Color.blue(actual)) <= tolerance && Color.alpha(actual) == 255)
    }
    private inline fun <reified T : Throwable> expectFailure(block: () -> Unit) {
        try { block() } catch (failure: Throwable) {
            if (failure is T) return
            throw AssertionError("Expected ${T::class.java.simpleName}, got ${failure.javaClass.simpleName}", failure)
        }
        fail("Expected ${T::class.java.simpleName}")
    }
}
