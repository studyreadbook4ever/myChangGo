package dev.presentation.recording

/** A monotonic recording clock. Paused time never contributes to elapsed time. */
class RecordingTimeline(private val clockNanos: () -> Long = System::nanoTime) {
    private var started = false
    private var running = false
    private var segmentStart = 0L
    private var accumulatedNanos = 0L

    @Synchronized
    fun reset() {
        started = false
        running = false
        segmentStart = 0L
        accumulatedNanos = 0L
    }

    @Synchronized
    fun start() {
        check(!started) { "Recording timeline is already started" }
        started = true
        running = true
        segmentStart = clockNanos()
        accumulatedNanos = 0L
    }

    @Synchronized
    fun pause() {
        if (!running) return
        accumulatedNanos += (clockNanos() - segmentStart).coerceAtLeast(0L)
        running = false
    }

    @Synchronized
    fun resume() {
        if (!started || running) return
        segmentStart = clockNanos()
        running = true
    }

    @Synchronized
    fun stop() {
        pause()
        started = false
    }

    val elapsedMillis: Long
        @Synchronized get() = (accumulatedNanos + if (running) {
            (clockNanos() - segmentStart).coerceAtLeast(0L)
        } else 0L) / 1_000_000L
}
