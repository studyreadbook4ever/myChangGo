package dev.presentation.recording

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class RecordingTimelineTest {
    private var now = 0L
    private fun advance(milliseconds: Long) { now += milliseconds * 1_000_000 }
    private fun clock() = RecordingTimeline { now }

    @Test fun elapsedIncludesOnlyRunningIntervals() {
        val timeline = clock()
        assertEquals(0L, timeline.elapsedMillis)
        timeline.start()
        advance(325)
        assertEquals(325L, timeline.elapsedMillis)
        timeline.pause()
        advance(8_000)
        assertEquals(325L, timeline.elapsedMillis)
        timeline.resume()
        advance(675)
        timeline.pause()
        advance(50_000)
        timeline.resume()
        advance(250)
        timeline.stop()
        assertEquals(1_250L, timeline.elapsedMillis)
        advance(99_000)
        assertEquals(1_250L, timeline.elapsedMillis)
    }

    @Test fun duplicateControlsDoNotAddPausedTimeOrLoseRunningTime() {
        val timeline = clock()
        timeline.pause(); timeline.resume(); advance(2_000)
        assertEquals(0L, timeline.elapsedMillis)
        timeline.start(); advance(150); timeline.resume(); advance(150)
        timeline.pause(); advance(500); timeline.pause(); advance(500)
        timeline.resume(); advance(300); timeline.resume(); advance(300)
        timeline.stop(); timeline.stop(); timeline.resume(); advance(1_000)
        assertEquals(900L, timeline.elapsedMillis)
    }

    @Test fun stopWhilePausedFreezesAndAnotherTakeStartsAtZero() {
        val timeline = clock()
        timeline.start(); advance(440); timeline.pause(); advance(2_000)
        timeline.stop()
        assertEquals(440L, timeline.elapsedMillis)
        timeline.start()
        assertEquals(0L, timeline.elapsedMillis)
        advance(800); timeline.stop()
        assertEquals(800L, timeline.elapsedMillis)
    }

    @Test fun resetClearsRunningOrPausedSession() {
        val timeline = clock()
        timeline.start(); advance(5_000); timeline.reset(); advance(200)
        assertEquals(0L, timeline.elapsedMillis)
        timeline.start(); advance(700); timeline.pause(); timeline.reset()
        assertEquals(0L, timeline.elapsedMillis)
        timeline.start(); advance(20)
        assertEquals(20L, timeline.elapsedMillis)
    }

    @Test fun duplicateStartRejectsAndClockCannotProduceNegativeDuration() {
        val timeline = clock()
        timeline.start()
        assertThrows(IllegalStateException::class.java) { timeline.start() }
        now = -50_000_000
        assertEquals(0L, timeline.elapsedMillis)
        timeline.pause()
        assertEquals(0L, timeline.elapsedMillis)
    }
}
