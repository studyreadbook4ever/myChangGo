package dev.presentation.recording

import android.Manifest
import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.abs

@RunWith(AndroidJUnit4::class)
class SlideRecorderTest {
    @get:Rule val microphone: GrantPermissionRule = GrantPermissionRule.grant(Manifest.permission.RECORD_AUDIO)
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private lateinit var activity: Activity
    private lateinit var recorder: SlideRecorder
    private val outputs = mutableListOf<File>()

    @Before fun openForegroundActivity() {
        activity = instrumentation.startActivitySync(context.packageManager.getLaunchIntentForPackage(context.packageName))
        instrumentation.waitForIdleSync()
        recorder = SlideRecorder(context)
    }

    @After fun release() {
        recorder.release()
        instrumentation.runOnMainSync { activity.finish() }
        outputs.forEach { it.delete() }
    }

    @Test fun silentVideoHasCorrectDimensionsOrientationAndOnlySuppliedSlidePixels() {
        val bitmap = quadrants()
        val file = output("orientation")
        start(file, bitmap)
        // The recorder must own a snapshot even if the UI immediately recycles its bitmap.
        bitmap.eraseColor(Color.MAGENTA)
        bitmap.recycle()
        SystemClock.sleep(1_300)
        assertEquals(file, recorder.stop())
        assertTracks(file, false)
        val frame = frame(file, 400_000)
        assertNear(Color.RED, frame.getPixel(160, 90))
        assertNear(Color.GREEN, frame.getPixel(1120, 90))
        assertNear(Color.BLUE, frame.getPixel(160, 630))
        assertNear(Color.YELLOW, frame.getPixel(1120, 630))
        frame.recycle()
    }

    @Test fun pauseRemovesTimeAndFrameUpdatedWhilePausedAppearsOnResume() {
        val initial = solid(Color.RED)
        val file = output("pause")
        start(file, initial); initial.recycle()
        SystemClock.sleep(1_250)
        recorder.pause()
        assertTrue(recorder.isPaused)
        SystemClock.sleep(150)
        val pausedTime = recorder.elapsedMillis
        val changed = solid(Color.CYAN)
        recorder.updateFrame(changed); changed.recycle()
        SystemClock.sleep(1_600)
        assertTrue(abs(recorder.elapsedMillis - pausedTime) < 100)
        recorder.resume()
        assertFalse(recorder.isPaused)
        SystemClock.sleep(1_250)
        recorder.stop()
        val duration = duration(file)
        assertTrue("Paused time leaked into $duration ms MP4", duration in 1_900..3_200)
        val first = frame(file, 400_000)
        val last = frame(file, (duration-300)*1_000)
        assertNear(Color.RED, first.getPixel(640,360))
        assertNear(Color.CYAN, last.getPixel(640,360))
        first.recycle(); last.recycle()
    }

    @Test fun microphoneRecordingContainsAacSamplesAndCanStopWhilePaused() {
        val file = output("audio")
        val initial = solid(Color.BLUE)
        start(file, initial, audio = true); initial.recycle()
        SystemClock.sleep(1_600)
        recorder.pause()
        SystemClock.sleep(600)
        recorder.stop()
        assertTracks(file, true)
        assertTrue("Pause inflated the audio MP4 duration", duration(file) in 900..2_200)
    }

    @Test fun shortRecordingFailsWithoutLeavingDamagedFileAndNextTakeSucceeds() {
        val short = output("too-short")
        val initial = solid(Color.GREEN)
        start(short, initial)
        assertThrows(Throwable::class.java) { recorder.stop() }
        assertFalse("Rejected recording left a partial file", short.exists())
        assertFalse(recorder.isRecording)
        val next = output("after-short")
        start(next, initial)
        SystemClock.sleep(1_200)
        recorder.stop()
        assertTracks(next, false)
        initial.recycle()
    }

    @Test fun successiveTakesDoNotRetainOldSlidesAndExistingFileIsPreserved() {
        val protected = output("existing").apply { writeText("keep-existing-file") }
        val errorLatch = CountDownLatch(1)
        val error = AtomicReference<Throwable?>()
        recorder.onError = { error.set(it); errorLatch.countDown() }
        val bitmap = solid(Color.RED)
        recorder.start(protected, bitmap, false)
        assertTrue("Startup error callback missing", errorLatch.await(20, TimeUnit.SECONDS))
        assertNotNull(error.get())
        assertEquals("keep-existing-file", protected.readText())
        for (color in listOf(Color.RED, Color.BLUE)) {
            bitmap.eraseColor(color)
            val file = output("take-$color")
            start(file, bitmap)
            assertThrows(IllegalStateException::class.java) { recorder.start(output("duplicate"), bitmap, false) }
            SystemClock.sleep(1_150)
            recorder.stop()
            assertTracks(file, false)
            val result = frame(file, 400_000)
            assertNear(color, result.getPixel(640,360)); result.recycle()
        }
        bitmap.recycle()
    }

    @Test fun nonWidescreenSourceIsLetterboxedWithoutStretching() {
        val bitmap = Bitmap.createBitmap(400,300,Bitmap.Config.ARGB_8888).apply { eraseColor(Color.YELLOW) }
        val file = output("letterbox")
        start(file, bitmap); bitmap.recycle()
        SystemClock.sleep(1_200); recorder.stop()
        val frame = frame(file, 400_000)
        assertNear(Color.BLACK, frame.getPixel(40,360))
        assertNear(Color.BLACK, frame.getPixel(1240,360))
        assertNear(Color.YELLOW, frame.getPixel(640,360))
        frame.recycle()
    }

    @Test fun releasingImmediatelyAbortsAndRemovesPartialOutput() {
        val file = output("released-start")
        val bitmap = solid(Color.BLUE)
        recorder.start(file,bitmap,false)
        bitmap.recycle()
        recorder.release()
        val deadline = SystemClock.uptimeMillis() + 20_000
        while (recorder.isRecording && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(25)
        assertFalse("Released recorder remains active",recorder.isRecording)
        assertFalse("Aborted recorder left partial output",file.exists())
    }

    @Test fun queuedStopSurvivesImmediateReleaseAndPreservesSuccessfulVideo() {
        val file = output("release-after-stop")
        val bitmap = solid(Color.GREEN)
        start(file,bitmap); bitmap.recycle()
        SystemClock.sleep(1_200)
        val latch = CountDownLatch(1)
        val saved = AtomicReference<File?>()
        val failure = AtomicReference<Throwable?>()
        recorder.stopAsync { result ->
            result.onSuccess { saved.set(it) }.onFailure { failure.set(it) }
            latch.countDown()
        }
        recorder.release()
        assertTrue("Queued stop callback missing",latch.await(20,TimeUnit.SECONDS))
        failure.get()?.let { throw AssertionError("Release interrupted queued stop",it) }
        assertEquals(file,saved.get())
        assertTrue(file.isFile)
        assertTracks(file,false)
    }

    private fun output(name: String): File = File(context.cacheDir,"recorder-test-$name-${System.nanoTime()}.mp4").also { outputs.add(it) }

    private fun start(file: File, bitmap: Bitmap, audio: Boolean = false) {
        val latch = CountDownLatch(1)
        val failure = AtomicReference<Throwable?>()
        recorder.onStarted = { latch.countDown() }
        recorder.onError = { failure.set(it); latch.countDown() }
        recorder.start(file, bitmap, audio)
        assertTrue("Recorder startup timed out", latch.await(20,TimeUnit.SECONDS))
        failure.get()?.let { throw AssertionError("Recorder startup failed", it) }
        assertTrue(recorder.isRecording)
    }

    private fun solid(color: Int) = Bitmap.createBitmap(1280,720,Bitmap.Config.ARGB_8888).apply { eraseColor(color) }

    private fun quadrants(): Bitmap = solid(Color.BLACK).also { bitmap ->
        val canvas = Canvas(bitmap); val paint = Paint()
        for ((index,color) in listOf(Color.RED,Color.GREEN,Color.BLUE,Color.YELLOW).withIndex()) {
            paint.color = color
            val left = (index%2)*640f; val top = (index/2)*360f
            canvas.drawRect(left,top,left+640,top+360,paint)
        }
    }

    private fun frame(file: File, micros: Long): Bitmap {
        val retriever = MediaMetadataRetriever()
        try {
            retriever.setDataSource(file.absolutePath)
            assertEquals("1280",retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH))
            assertEquals("720",retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT))
            return requireNotNull(retriever.getFrameAtTime(micros,MediaMetadataRetriever.OPTION_CLOSEST))
        } finally { retriever.release() }
    }

    private fun duration(file: File): Long {
        val retriever = MediaMetadataRetriever()
        try {
            retriever.setDataSource(file.absolutePath)
            return requireNotNull(retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)).toLong()
        } finally { retriever.release() }
    }

    private fun assertTracks(file: File, audio: Boolean) {
        val extractor = MediaExtractor()
        try {
            extractor.setDataSource(file.absolutePath)
            val tracks = (0 until extractor.trackCount).associateBy { extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME) }
            assertTrue(tracks.containsKey(MediaFormat.MIMETYPE_VIDEO_AVC))
            assertEquals(audio,tracks.containsKey(MediaFormat.MIMETYPE_AUDIO_AAC))
            for (index in tracks.values) {
                extractor.selectTrack(index)
                assertTrue("Empty media track",extractor.sampleSize > 0)
                extractor.unselectTrack(index)
            }
        } finally { extractor.release() }
    }

    private fun assertNear(expected: Int, actual: Int) {
        val distance = maxOf(abs(Color.red(expected)-Color.red(actual)),abs(Color.green(expected)-Color.green(actual)),abs(Color.blue(expected)-Color.blue(actual)))
        assertTrue("Color differs: expected ${Integer.toHexString(expected)}, actual ${Integer.toHexString(actual)}",distance < 45)
    }
}
