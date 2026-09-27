package dev.presentation.recording

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.SystemClock
import android.view.Surface
import java.io.File
import java.io.IOException
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.min

/**
 * Records only a slide bitmap into a 1280×720 H.264 MP4, with optional AAC microphone audio.
 * No screen capture, overlay, script, navigation control, or notification can enter the video.
 *
 * start/updateFrame/pause/resume/release are safe to call from the main thread. Frames are copied
 * on submission, so callers retain ownership of their bitmaps and may recycle them afterwards.
 * All encoder, EGL, file validation, and finalization work runs on a dedicated worker.
 *
 * [onError], [onStarted], and [stopAsync] callbacks run on the main thread. Blocking [stop] must
 * be called from a background thread. A successfully stopped file belongs to the caller;
 * [release] does not delete it, even if a later MediaStore export fails.
 */
class SlideRecorder(context: Context) {
    private val appContext = context.applicationContext
    private val lock = Any()
    private val mainHandler = Handler(Looper.getMainLooper())
    private val workerThread = HandlerThread("SlideVideoEncoder").apply { start() }
    private val worker = Handler(workerThread.looper)
    private val timeline = RecordingTimeline()
    private val pendingFrame = AtomicReference<Bitmap?>(null)

    @Volatile private var active = false
    @Volatile private var paused = false
    @Volatile private var stopping = false
    @Volatile private var released = false
    @Volatile private var generation = 0L
    @Volatile private var lastFailure: Throwable? = null

    /** Startup and recording failures. Stop failures are returned through stop/stopAsync instead. */
    @Volatile var onError: ((Throwable) -> Unit)? = null
    @Volatile var onStarted: (() -> Unit)? = null

    /** True while starting or paused as well as while actively encoding. */
    val isRecording: Boolean get() = active
    /** Reflects the requested pause state immediately. */
    val isPaused: Boolean get() = paused && active
    val elapsedMillis: Long get() = timeline.elapsedMillis

    // Everything below is worker-owned, except stopFuture (guarded by lock).
    private var recorder: MediaRecorder? = null
    private var renderer: EglFrameRenderer? = null
    private var surface: Surface? = null
    private var outputFile: File? = null
    private var engineStarted = false
    private var enginePaused = false
    private var audioEnabled = false
    private var framesSent = 0L
    private var frameIntervalMillis = 1000L / DEFAULT_FRAME_RATE
    private var nextFrameUptime = 0L
    private var stopFuture: CompletableFuture<File>? = null

    private val drawFrame = object : Runnable {
        override fun run() {
            if (!engineStarted || enginePaused || !active) return
            try {
                consumePendingFrame()
                checkNotNull(renderer).draw(System.nanoTime())
                framesSent++
                nextFrameUptime = maxOf(nextFrameUptime + frameIntervalMillis, SystemClock.uptimeMillis() + 1L)
                worker.postAtTime(this, nextFrameUptime)
            } catch (failure: Throwable) {
                fail(failure, generation)
            }
        }
    }

    fun start(output: File, initialFrame: Bitmap, withAudio: Boolean) {
        synchronized(lock) {
            check(!released) { "The recorder has been released" }
            check(!active && !stopping) { "A recording is already in progress" }
            require(!initialFrame.isRecycled) { "The slide bitmap has been recycled" }
            val copy = snapshot(initialFrame)
            val session = ++generation
            active = true
            paused = false
            lastFailure = null
            stopFuture = null
            timeline.reset()
            pendingFrame.getAndSet(copy)?.recycle()
            if (!worker.post { initialize(output, withAudio, session) }) {
                active = false
                pendingFrame.getAndSet(null)?.recycle()
                throw IllegalStateException("The recording worker is unavailable")
            }
        }
    }

    fun updateFrame(frame: Bitmap) {
        synchronized(lock) {
            if (!active || stopping || released) return
            require(!frame.isRecycled) { "The slide bitmap has been recycled" }
            // Conflate updates: fast navigation cannot create an unbounded bitmap queue.
            pendingFrame.getAndSet(snapshot(frame))?.recycle()
        }
    }

    fun pause() {
        synchronized(lock) {
            if (!active || stopping || released || paused) return
            paused = true
            val session = generation
            worker.post {
                if (!active || session != generation || !engineStarted || enginePaused) return@post
                try {
                    worker.removeCallbacks(drawFrame)
                    checkNotNull(recorder).pause()
                    timeline.pause()
                    enginePaused = true
                } catch (failure: Throwable) {
                    fail(failure, session)
                }
            }
        }
    }

    fun resume() {
        synchronized(lock) {
            if (!active || stopping || released || !paused) return
            paused = false
            val session = generation
            worker.post {
                if (!active || session != generation || !engineStarted || !enginePaused) return@post
                try {
                    checkNotNull(recorder).resume()
                    timeline.resume()
                    enginePaused = false
                    nextFrameUptime = SystemClock.uptimeMillis()
                    drawFrame.run()
                } catch (failure: Throwable) {
                    fail(failure, session)
                }
            }
        }
    }

    /** Finalizes the MP4 without blocking the UI; callback always runs on the main thread. */
    fun stopAsync(callback: (Result<File>) -> Unit) {
        requestStop().whenComplete { file, failure ->
            val result = if (failure == null) Result.success(file) else Result.failure(unwrap(failure))
            mainHandler.post { callback(result) }
        }
    }

    /** Blocking alternative for an executor/IO coroutine. Use stopAsync from UI code. */
    fun stop(): File {
        check(Looper.myLooper() != Looper.getMainLooper()) { "Use stopAsync on the main thread" }
        check(Looper.myLooper() != worker.looper) { "Cannot block the encoding worker" }
        try {
            return requestStop().get(30, TimeUnit.SECONDS)
        } catch (failure: ExecutionException) {
            throw unwrap(failure)
        }
    }

    /** Aborts any unfinished recording and releases resources asynchronously. Idempotent. */
    fun release() {
        synchronized(lock) {
            if (released) return
            released = true
            // Keep a queued stop valid. Its worker action precedes this cleanup action.
            worker.post {
                val unfinished = engineStarted || recorder != null
                timeline.stop()
                cleanUp(deleteOutput = unfinished)
                synchronized(lock) {
                    active = false
                    paused = false
                    stopping = false
                }
                workerThread.quitSafely()
            }
        }
    }

    private fun initialize(output: File, withAudio: Boolean, session: Long) {
        try {
            if (withAudio && appContext.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                throw SecurityException("마이크 권한을 허용하거나 마이크를 끄고 다시 시작해 주세요.")
            }
            require(!output.exists() || output.length() == 0L) { "기존 녹화 파일을 덮어쓸 수 없습니다." }
            val directory = output.absoluteFile.parentFile
            check(directory != null && (directory.isDirectory || directory.mkdirs())) { "녹화 임시 폴더를 만들 수 없습니다." }
            outputFile = output
            audioEnabled = withAudio
            framesSent = 0L
            val frameRate = supportedFrameRate()
            frameIntervalMillis = 1000L / frameRate
            val media = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(appContext) else {
                @Suppress("DEPRECATION")
                MediaRecorder()
            }
            recorder = media
            media.setOnErrorListener { _, what, extra ->
                if (session == generation && engineStarted) {
                    fail(IOException("녹화 장치 오류가 발생했습니다 ($what/$extra)."), session)
                }
            }
            media.setOnInfoListener { _, what, _ ->
                if (what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_FILESIZE_REACHED || what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED) {
                    fail(IOException("녹화 파일이 기기의 최대 크기 또는 시간 제한에 도달했습니다."), session)
                }
            }
            if (withAudio) {
                media.setAudioSource(MediaRecorder.AudioSource.MIC)
                if (Build.VERSION.SDK_INT >= 30) media.setPrivacySensitive(true)
            }
            media.setVideoSource(MediaRecorder.VideoSource.SURFACE)
            media.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            media.setVideoEncoder(MediaRecorder.VideoEncoder.H264)
            media.setVideoSize(WIDTH, HEIGHT)
            media.setVideoFrameRate(frameRate)
            media.setVideoEncodingBitRate(4_000_000)
            if (withAudio) {
                media.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                media.setAudioChannels(1)
                media.setAudioSamplingRate(44_100)
                media.setAudioEncodingBitRate(128_000)
            }
            media.setOutputFile(output.absolutePath)
            media.prepare()
            val input = media.surface
            surface = input
            renderer = EglFrameRenderer(input, WIDTH, HEIGHT)
            consumePendingFrame()
            media.start()
            engineStarted = true
            enginePaused = false
            timeline.start()
            nextFrameUptime = SystemClock.uptimeMillis()
            drawFrame.run()
            mainHandler.post {
                if (session == generation && active && !stopping && !released) onStarted?.invoke()
            }
        } catch (failure: Throwable) {
            fail(failure, session)
        }
    }

    private fun consumePendingFrame() {
        val bitmap = pendingFrame.getAndSet(null) ?: return
        try {
            checkNotNull(renderer).upload(bitmap)
        } finally {
            bitmap.recycle()
        }
    }

    private fun requestStop(): CompletableFuture<File> = synchronized(lock) {
        stopFuture?.let { return@synchronized it }
        val completion = CompletableFuture<File>()
        if (released || !active) {
            completion.completeExceptionally(lastFailure ?: IllegalStateException("진행 중인 녹화가 없습니다."))
            return@synchronized completion
        }
        stopping = true
        stopFuture = completion
        worker.post { finish(completion) }
        completion
    }

    private fun finish(completion: CompletableFuture<File>) {
        worker.removeCallbacks(drawFrame)
        var resultFile: File? = null
        var failure: Throwable? = null
        try {
            lastFailure?.let { throw it }
            check(engineStarted) { "녹화 장치를 시작하지 못했습니다." }
            if (timeline.elapsedMillis < MIN_RECORDING_MILLIS || framesSent < 2L) {
                throw IOException("녹화 시간이 너무 짧습니다. 1초 이상 녹화한 뒤 종료해 주세요.")
            }
            checkNotNull(recorder).stop()
            engineStarted = false
            timeline.stop()
            val file = checkNotNull(outputFile)
            validateOutput(file, audioEnabled)
            resultFile = file
        } catch (problem: Throwable) {
            failure = problem
            lastFailure = problem
        } finally {
            timeline.stop()
            cleanUp(deleteOutput = resultFile == null)
            synchronized(lock) {
                active = false
                paused = false
                stopping = false
            }
        }
        if (resultFile != null) completion.complete(resultFile)
        else completion.completeExceptionally(failure ?: IOException("영상을 저장하지 못했습니다."))
    }

    private fun fail(failure: Throwable, session: Long) {
        if (session != generation || !active) return
        lastFailure = failure
        val notify: Boolean
        val stopWasPending: Boolean
        synchronized(lock) {
            stopWasPending = stopping
            notify = !stopping && !released
            active = false
            paused = false
            // Keep a new start from racing resource and pending-frame cleanup.
            stopping = true
        }
        timeline.stop()
        cleanUp(deleteOutput = true)
        synchronized(lock) { stopping = stopWasPending }
        if (notify) mainHandler.post {
            if (session == generation && !released) onError?.invoke(failure)
        }
    }

    private fun cleanUp(deleteOutput: Boolean) {
        worker.removeCallbacks(drawFrame)
        pendingFrame.getAndSet(null)?.recycle()
        runCatching { renderer?.close() }
        renderer = null
        runCatching { recorder?.reset() }
        runCatching { recorder?.release() }
        recorder = null
        runCatching { surface?.release() }
        surface = null
        engineStarted = false
        enginePaused = false
        if (deleteOutput) outputFile?.delete()
        outputFile = null
    }

    private fun supportedFrameRate(): Int {
        val capabilities = MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos
            .filter { it.isEncoder && it.supportedTypes.any { mime -> mime.equals(MediaFormat.MIMETYPE_VIDEO_AVC, true) } }
            .mapNotNull { codec -> runCatching { codec.getCapabilitiesForType(MediaFormat.MIMETYPE_VIDEO_AVC) }.getOrNull() }
            .filter { MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface in it.colorFormats }
        return listOf(DEFAULT_FRAME_RATE, 15).firstOrNull { rate ->
            capabilities.any { caps ->
                runCatching { caps.videoCapabilities.areSizeAndRateSupported(WIDTH, HEIGHT, rate.toDouble()) }.getOrDefault(false)
            }
        } ?: throw IOException("이 기기는 1280×720 H.264 영상 녹화를 지원하지 않습니다.")
    }

    private fun validateOutput(file: File, withAudio: Boolean) {
        check(file.isFile && file.length() > 0L) { "녹화된 영상 파일이 비어 있습니다." }
        val extractor = MediaExtractor()
        try {
            extractor.setDataSource(file.absolutePath)
            var videoPresent = false
            var audioPresent = false
            for (index in 0 until extractor.trackCount) {
                val format = extractor.getTrackFormat(index)
                when (format.getString(MediaFormat.KEY_MIME)) {
                    MediaFormat.MIMETYPE_VIDEO_AVC -> {
                        check(format.getInteger(MediaFormat.KEY_WIDTH) == WIDTH && format.getInteger(MediaFormat.KEY_HEIGHT) == HEIGHT) {
                            "녹화된 영상 크기가 올바르지 않습니다."
                        }
                        videoPresent = true
                    }
                    MediaFormat.MIMETYPE_AUDIO_AAC -> audioPresent = true
                }
            }
            check(videoPresent && (!withAudio || audioPresent)) { "녹화된 영상 또는 오디오 트랙이 없습니다." }
        } finally {
            extractor.release()
        }
    }

    private fun snapshot(source: Bitmap): Bitmap {
        val frame = Bitmap.createBitmap(WIDTH, HEIGHT, Bitmap.Config.ARGB_8888)
        try {
            val canvas = Canvas(frame)
            canvas.drawColor(Color.BLACK)
            val scale = min(WIDTH.toFloat() / source.width, HEIGHT.toFloat() / source.height)
            val left = (WIDTH - source.width * scale) / 2f
            val top = (HEIGHT - source.height * scale) / 2f
            canvas.drawBitmap(source, null, RectF(left, top, WIDTH - left, HEIGHT - top), Paint(Paint.FILTER_BITMAP_FLAG))
            return frame
        } catch (failure: Throwable) {
            frame.recycle()
            throw failure
        }
    }

    private fun unwrap(failure: Throwable): Throwable =
        if (failure is java.util.concurrent.CompletionException || failure is ExecutionException) failure.cause ?: failure else failure

    companion object {
        const val WIDTH = 1280
        const val HEIGHT = 720
        const val DEFAULT_FRAME_RATE = 24
        const val MIN_RECORDING_MILLIS = 400L
    }
}
