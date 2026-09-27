package dev.presentation

import android.graphics.Bitmap
import android.graphics.Color
import android.media.MediaMetadataRetriever
import android.provider.MediaStore
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.action.ViewActions.*
import androidx.test.espresso.matcher.ViewMatchers.*
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.hamcrest.Matchers.`is`
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class StudioUiTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    @Before fun reset() {
        if (android.os.Build.VERSION.SDK_INT >= 33) android.graphics.HardwareRenderer.setDrawingEnabled(true)
        context.getSharedPreferences("studio", 0).edit().clear().putBoolean("microphone", false).commit()
        java.io.File(context.filesDir, "current.document").delete()
        java.io.File(context.filesDir, "recordings").listFiles()?.forEach { it.delete() }
    }
    private fun clickTag(tag: String) { onView(withTagValue(`is`(tag as Any))).perform(click()) }
    private fun waitFor(scenario: ActivityScenario<MainActivity>, condition: (MainActivity) -> Boolean) {
        val deadline = System.currentTimeMillis() + 20000
        while (System.currentTimeMillis() < deadline) {
            var result = false
            scenario.onActivity { result = condition(it) }
            if (result) return
            Thread.sleep(80)
        }
        fail("Timed out waiting for UI condition")
    }
    private fun view(activity: MainActivity, tag: String): View = activity.window.decorView.findViewWithTag(tag)
    private fun ready(scenario: ActivityScenario<MainActivity>) = waitFor(scenario) { view(it, "record").isEnabled }

    @Test fun navigationAndScriptPersistAcrossActivityRecreation() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            ready(scenario)
            scenario.onActivity { activity ->
                val root = activity.window.decorView
                val capture = Bitmap.createBitmap(root.width, root.height, Bitmap.Config.ARGB_8888)
                root.draw(android.graphics.Canvas(capture))
                java.io.File(context.filesDir, "ui-screenshot.png").outputStream().use { capture.compress(Bitmap.CompressFormat.PNG, 100, it) }
                capture.recycle()
            }
            scenario.onActivity { assertFalse(view(it, "previous_slide").isEnabled); assertTrue(view(it, "next_slide").isEnabled) }
            clickTag("edit_script")
            onView(isAssignableFrom(EditText::class.java)).perform(replaceText("PRIVATE_SCRIPT_DO_NOT_CAPTURE_729"), closeSoftKeyboard())
            onView(withText("저장")).perform(click())
            scenario.onActivity { assertEquals("PRIVATE_SCRIPT_DO_NOT_CAPTURE_729", (view(it, "script_text") as TextView).text.toString()) }
            clickTag("next_slide")
            ready(scenario)
            scenario.onActivity { assertFalse((view(it, "script_text") as TextView).text.contains("PRIVATE_SCRIPT")) }
            clickTag("previous_slide")
            ready(scenario)
            scenario.recreate()
            ready(scenario)
            scenario.onActivity { assertEquals("PRIVATE_SCRIPT_DO_NOT_CAPTURE_729", (view(it, "script_text") as TextView).text.toString()) }
        }
    }

    @Test fun importedDocumentRestoresAndFailedImportKeepsItsPlace() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            ready(scenario)
            scenario.onActivity { it.importUri(FixtureProvider.DEMO_URI) }
            ready(scenario)
            assertTrue(java.io.File(context.filesDir, "current.document").isFile)
            clickTag("next_slide")
            ready(scenario)
            scenario.recreate()
            ready(scenario)
            scenario.onActivity { assertTrue(view(it, "previous_slide").isEnabled) }
            scenario.onActivity { it.importUri(FixtureProvider.MALFORMED_URI) }
            ready(scenario)
            onView(withText("확인")).perform(click())
            scenario.onActivity {
                assertTrue(view(it, "previous_slide").isEnabled)
                assertTrue(view(it, "record").isEnabled)
            }
        }
    }

    @Test fun recordingControlsExportOnlyTheSlideAndSupportPause() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            ready(scenario)
            clickTag("record")
            waitFor(scenario) { view(it, "pause_recording").isEnabled }
            scenario.onActivity {
                assertFalse(view(it, "open_document").isEnabled)
                assertFalse(view(it, "edit_script").isEnabled)
                assertFalse(view(it, "microphone").isEnabled)
            }
            Thread.sleep(1200)
            clickTag("pause_recording")
            scenario.onActivity { assertTrue((view(it, "pause_recording") as Button).text.contains("재개")) }
            Thread.sleep(700)
            clickTag("next_slide")
            waitFor(scenario) { view(it, "previous_slide").isEnabled }
            clickTag("pause_recording")
            Thread.sleep(1000)
            clickTag("record")
            waitFor(scenario) { view(it, "share_video").isEnabled }
            scenario.onActivity { assertTrue(view(it, "open_document").isEnabled) }
            val uri = latestVideo()
            MediaMetadataRetriever().use { reader ->
                reader.setDataSource(context, uri)
                assertEquals("1280", reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH))
                assertEquals("720", reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT))
                assertTrue(reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)!!.toLong() > 1500)
                val videoFrame = reader.getFrameAtTime(100_000, MediaMetadataRetriever.OPTION_CLOSEST)!!
                val pdf = java.io.File(context.cacheDir, "expected-ui.pdf")
                context.assets.open("welcome.pdf").use { input -> pdf.outputStream().use { input.copyTo(it) } }
                PdfDocument(pdf, "expected").use { doc ->
                    val expected = doc.render(0, 1280, 720)
                    assertSlideMatches(expected, videoFrame)
                    expected.recycle()
                }
                videoFrame.recycle()
            }
            context.contentResolver.delete(uri, null, null)
        }
    }

    @Test fun leavingTheAppFinalizesRecording() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            ready(scenario); clickTag("record")
            waitFor(scenario) { view(it, "pause_recording").isEnabled }
            Thread.sleep(1200)
            // ATD images omit a user launcher; drive the same onStop lifecycle directly.
            scenario.moveToState(androidx.lifecycle.Lifecycle.State.CREATED)
            Thread.sleep(1800)
            scenario.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED)
            waitFor(scenario) { view(it, "share_video").isEnabled }
            val uri = latestVideo()
            MediaMetadataRetriever().use { reader ->
                reader.setDataSource(context, uri)
                assertTrue(reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)!!.toLong() >= 600)
            }
            context.contentResolver.delete(uri, null, null)
        }
    }

    private fun latestVideo(): android.net.Uri {
        context.contentResolver.query(MediaStore.Video.Media.EXTERNAL_CONTENT_URI,
            arrayOf(MediaStore.Video.Media._ID), "${MediaStore.Video.Media.RELATIVE_PATH} = ?",
            arrayOf("Movies/PresentationStudio/"), "${MediaStore.Video.Media.DATE_ADDED} DESC, ${MediaStore.Video.Media._ID} DESC")!!.use { cursor ->
            assertTrue("Expected saved video", cursor.moveToFirst())
            return android.content.ContentUris.withAppendedId(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, cursor.getLong(0))
        }
    }
    private fun assertSlideMatches(expected: Bitmap, actual: Bitmap) {
        var error = 0L
        var samples = 0
        for (y in 12 until 708 step 16) for (x in 12 until 1268 step 16) {
            val a = expected.getPixel(x, y); val b = actual.getPixel(x, y)
            error += kotlin.math.abs(Color.red(a) - Color.red(b)) + kotlin.math.abs(Color.green(a) - Color.green(b)) + kotlin.math.abs(Color.blue(a) - Color.blue(b))
            samples += 3
        }
        assertTrue("Only the PDF page must appear in video (mean channel error ${error.toDouble() / samples})", error.toDouble() / samples < 15)
    }
}
