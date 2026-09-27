package dev.presentation

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.StatFs
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.*
import dev.presentation.recording.SlideRecorder
import java.io.File
import java.util.Locale
import java.util.concurrent.Executors

class MainActivity : Activity() {
    private val background = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private val prefs by lazy { getSharedPreferences("studio", MODE_PRIVATE) }
    private lateinit var recorder: SlideRecorder
    private var document: ImportedDocument? = null
    private var frame: Bitmap? = null
    private var slide = 0
    private var busy = false
    private var state = State.IDLE
    private var visible = false
    private var destroyed = false
    private var autoScroll = false
    private var fontSize = 20f
    private var savedVideo: Uri? = null
    private var microphone = true
    private enum class State { IDLE, STARTING, RECORDING, PAUSED, STOPPING }

    private lateinit var preview: ImageView
    private lateinit var title: TextView
    private lateinit var counter: TextView
    private lateinit var status: TextView
    private lateinit var timer: TextView
    private lateinit var script: TextView
    private lateinit var scriptScroll: ScrollView
    private lateinit var open: Button
    private lateinit var previous: Button
    private lateinit var next: Button
    private lateinit var record: Button
    private lateinit var pause: Button
    private lateinit var mic: Button
    private lateinit var edit: Button
    private lateinit var auto: Button
    private lateinit var share: Button
    private val ink = Color.rgb(235, 240, 248)
    private val muted = Color.rgb(151, 164, 184)
    private val accent = Color.rgb(163, 230, 53)
    private val panel = Color.rgb(23, 30, 41)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        recorder = SlideRecorder(this)
        recorder.onStarted = {
            if (!destroyed && state == State.STARTING) {
                state = State.RECORDING
                status.text = "녹화 중 · 대본과 버튼은 영상에 포함되지 않습니다"
                refresh()
                if (!visible) finishRecording()
            }
        }
        recorder.onError = { failure ->
            if (!destroyed) {
                state = State.IDLE
                refresh()
                showError("녹화 오류", failure)
            }
        }
        microphone = prefs.getBoolean("microphone", true)
        fontSize = prefs.getFloat("fontSize", 20f).coerceIn(14f, 36f)
        buildUi()
        loadInitial()
        main.post(ticker)
    }

    private fun buildUi() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.rgb(13, 16, 23))
            setPadding(dp(16), dp(4), dp(16), dp(8))
        }
        root.setOnApplyWindowInsetsListener { view, insets ->
            view.setPadding(dp(16) + insets.systemWindowInsetLeft, dp(4) + insets.systemWindowInsetTop,
                dp(16) + insets.systemWindowInsetRight, dp(8) + insets.systemWindowInsetBottom)
            insets
        }
        setContentView(root)
        val header = row()
        val brand = label("발표 스튜디오", 19f, ink, true)
        header.addView(brand, LinearLayout.LayoutParams(-2, -1).apply { rightMargin = dp(16) })
        title = label("불러오는 중…", 12f, muted).apply { maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END }
        header.addView(title, LinearLayout.LayoutParams(0, -1, 1f))
        open = button("파일 열기", "open_document") { pickDocument() }
        header.addView(open)
        header.addView(button("도움말", "help") { help() })
        root.addView(header, LinearLayout.LayoutParams(-1, dp(48)))

        val content = row().apply { gravity = Gravity.TOP }
        val left = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val previewHost = FrameLayout(this).apply {
            background = rounded(Color.BLACK)
            clipToOutline = true
        }
        preview = ImageView(this).apply {
            scaleType = ImageView.ScaleType.FIT_CENTER
            contentDescription = "영상에 담기는 16대9 슬라이드"
            tag = "slide_preview"
        }
        previewHost.addView(preview, FrameLayout.LayoutParams(-1, -1))
        left.addView(previewHost, LinearLayout.LayoutParams(-1, 0, 1f))
        val navigation = row()
        previous = button("‹  이전", "previous_slide") { showSlide(slide - 1) }
        next = button("다음  ›", "next_slide") { showSlide(slide + 1) }
        counter = label("— / —", 13f, ink, true).apply { gravity = Gravity.CENTER }
        navigation.addView(previous, LinearLayout.LayoutParams(dp(92), dp(46)))
        navigation.addView(counter, LinearLayout.LayoutParams(0, -1, 1f))
        navigation.addView(next, LinearLayout.LayoutParams(dp(92), dp(46)))
        left.addView(navigation, LinearLayout.LayoutParams(-1, dp(48)))
        content.addView(left, LinearLayout.LayoutParams(0, -1, 0.63f).apply { rightMargin = dp(12) })

        val right = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = rounded(panel)
            setPadding(dp(12), dp(4), dp(12), dp(8))
        }
        val scriptHeader = row()
        scriptHeader.addView(label("나의 대본", 14f, ink, true), LinearLayout.LayoutParams(0, -1, 1f))
        edit = button("편집", "edit_script") { editScript() }
        scriptHeader.addView(edit, LinearLayout.LayoutParams(dp(62), dp(42)))
        right.addView(scriptHeader, LinearLayout.LayoutParams(-1, dp(42)))
        scriptScroll = ScrollView(this).apply { isFillViewport = true; tag = "script_scroll" }
        script = TextView(this).apply {
            setTextColor(ink); textSize = fontSize; setLineSpacing(dp(5).toFloat(), 1.15f)
            setPadding(0, dp(6), 0, dp(20)); tag = "script_text"
        }
        scriptScroll.addView(script, FrameLayout.LayoutParams(-1, -2))
        right.addView(scriptScroll, LinearLayout.LayoutParams(-1, 0, 1f))
        val scriptControls = row()
        auto = button("자동 스크롤", "auto_scroll") {
            autoScroll = !autoScroll
            auto.text = if (autoScroll) "스크롤 멈춤" else "자동 스크롤"
        }
        scriptControls.addView(auto, LinearLayout.LayoutParams(0, dp(42), 1f))
        scriptControls.addView(button("A−", "smaller_script") { resizeScript(-2) }, LinearLayout.LayoutParams(dp(45), dp(42)))
        scriptControls.addView(button("A+", "larger_script") { resizeScript(2) }, LinearLayout.LayoutParams(dp(45), dp(42)))
        right.addView(scriptControls)
        content.addView(right, LinearLayout.LayoutParams(0, -1, 0.37f))
        root.addView(content, LinearLayout.LayoutParams(-1, 0, 1f))

        val footer = row()
        timer = label("00:00", 24f, ink, true).apply { typeface = Typeface.MONOSPACE; tag = "recording_time" }
        footer.addView(timer, LinearLayout.LayoutParams(dp(92), -1))
        mic = button("마이크 켜짐", "microphone") {
            microphone = !microphone
            prefs.edit().putBoolean("microphone", microphone).apply()
            refresh()
        }
        footer.addView(mic, LinearLayout.LayoutParams(dp(113), dp(48)))
        share = button("영상 공유", "share_video") { shareVideo() }
        footer.addView(share, LinearLayout.LayoutParams(dp(100), dp(48)))
        footer.addView(View(this), LinearLayout.LayoutParams(0, 1, 1f))
        pause = button("일시정지", "pause_recording") { togglePause() }
        footer.addView(pause, LinearLayout.LayoutParams(dp(104), dp(48)).apply { rightMargin = dp(8) })
        record = button("●  녹화 시작", "record") {
            if (state == State.IDLE) requestStart() else if (state == State.RECORDING || state == State.PAUSED) finishRecording()
        }.apply { setTextColor(Color.rgb(18, 25, 10)); background = rounded(accent, 12f) }
        footer.addView(record, LinearLayout.LayoutParams(dp(140), dp(46)))
        root.addView(footer, LinearLayout.LayoutParams(-1, dp(60)))
        status = label("PDF를 열고 발표를 시작하세요", 11f, muted).apply { maxLines = 1 }
        root.addView(status, LinearLayout.LayoutParams(-1, dp(20)))
        refresh()
    }

    private fun row() = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    private fun label(value: String, size: Float, color: Int, bold: Boolean = false) = TextView(this).apply {
        text = value; textSize = size; setTextColor(color); gravity = Gravity.CENTER_VERTICAL
        if (bold) setTypeface(typeface, Typeface.BOLD)
    }
    private fun button(value: String, key: String, action: () -> Unit) = Button(this).apply {
        text = value; tag = key; contentDescription = value; isAllCaps = false; textSize = 12f
        minWidth = 0; minimumWidth = 0; minHeight = 0; minimumHeight = 0
        setPadding(dp(8), 0, dp(8), 0); setTextColor(ink)
        background = android.graphics.drawable.StateListDrawable().apply {
            addState(intArrayOf(android.R.attr.state_pressed), rounded(Color.rgb(48, 60, 76)))
            addState(intArrayOf(), rounded(Color.TRANSPARENT))
        }
        setOnClickListener { action() }
    }
    private fun rounded(color: Int, radius: Float = 10f) = GradientDrawable().apply {
        setColor(color); cornerRadius = dp(radius.toInt()).toFloat()
    }
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

    private fun loadInitial() {
        busy = true; refresh()
        background.execute {
            var opening: ImportedDocument? = null
            try {
                val saved = File(filesDir, "current.document")
                val imported = if (saved.exists()) {
                    try { Documents.open(saved, prefs.getString("documentTitle", "프레젠테이션")!!) }
                    catch (_: Exception) { openSample() }
                } else openSample()
                opening = imported
                val index = prefs.getInt("slide_${imported.key}", 0).coerceIn(0, imported.document.slideCount - 1)
                val bitmap = imported.document.render(index, 1280, 720)
                main.post { if (destroyed) { imported.document.close(); bitmap.recycle() } else acceptDocument(imported, index, bitmap) }
            } catch (e: Exception) { opening?.document?.close(); main.post { busy = false; refresh(); showError("초기 화면을 열지 못했습니다", e) } }
        }
    }

    private fun openSample(): ImportedDocument {
        val file = File(cacheDir, "welcome.pdf")
        assets.open("welcome.pdf").use { input -> file.outputStream().use { input.copyTo(it) } }
        return Documents.open(file, "시작하기 · 예제 프레젠테이션")
    }

    private fun pickDocument() {
        if (state != State.IDLE || busy) return
        try {
            startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "application/pdf"
            }, OPEN_FILE)
        } catch (e: android.content.ActivityNotFoundException) {
            showError("파일 선택기를 열 수 없습니다", IllegalStateException("기기에 Android 파일 선택기가 필요합니다.", e))
        }
    }

    @Deprecated("Platform result API is sufficient for a dependency-light app")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == OPEN_FILE && resultCode == RESULT_OK) data?.data?.let { importUri(it) }
    }

    internal fun importUri(uri: Uri) {
        if (state != State.IDLE || busy) return
        busy = true; status.text = "파일을 읽고 슬라이드를 준비하고 있습니다…"; refresh()
        background.execute {
            var imported: ImportedDocument? = null
            var bitmap: Bitmap? = null
            try {
                imported = Documents.import(this, uri)
                bitmap = imported.document.render(0, 1280, 720)
                val saved = File(filesDir, "current.document")
                val pending = File(filesDir, "current.pending")
                imported.file.copyTo(pending, overwrite = true)
                check(pending.renameTo(saved)) { "문서를 보관할 수 없습니다." }
                prefs.edit().putString("documentTitle", imported.document.title).apply()
                val ready = imported; val image = bitmap
                main.post { if (destroyed) { ready.document.close(); image.recycle() } else acceptDocument(ready, 0, image) }
            } catch (e: Exception) {
                imported?.document?.close(); imported?.file?.delete(); bitmap?.recycle()
                main.post { busy = false; refresh(); showError("파일을 열지 못했습니다", e) }
            }
        }
    }

    private fun acceptDocument(imported: ImportedDocument, index: Int, bitmap: Bitmap) {
        val old = document
        document = imported
        if (old != null) background.execute { old.document.close(); if (old.file.parentFile == cacheDir && old.file != imported.file) old.file.delete() }
        title.text = imported.document.title
        slide = index
        setFrame(bitmap)
        busy = false
        showNotes()
        val warnings = imported.document.warnings
        status.text = if (warnings.isEmpty()) "준비 완료 · 슬라이드만 녹화됩니다 · 16:9 MP4" else "호환성 안내 ${warnings.size}건 · 도움말에서 확인 · 녹화 전 슬라이드를 확인하세요"
        refresh()
        if (warnings.isNotEmpty()) AlertDialog.Builder(this).setTitle("PDF 표시 안내")
            .setMessage(warnings.distinct().joinToString("\n\n") + "\n\n원본 모양이 중요하면 PowerPoint에서 PDF로 저장한 파일을 열어 주세요.")
            .setPositiveButton("확인", null).show()
        recoverVideos()
    }

    private fun showSlide(index: Int) {
        val deck = document ?: return
        if (busy || index !in 0 until deck.document.slideCount || state == State.STARTING || state == State.STOPPING) return
        busy = true; refresh()
        background.execute {
            try {
                val bitmap = deck.document.render(index, 1280, 720)
                main.post {
                    if (destroyed) bitmap.recycle() else {
                        slide = index; setFrame(bitmap); showNotes(); busy = false
                        prefs.edit().putInt("slide_${deck.key}", index).apply(); refresh()
                    }
                }
            } catch (e: Exception) { main.post { busy = false; refresh(); showError("슬라이드를 표시할 수 없습니다", e) } }
        }
    }

    private fun setFrame(bitmap: Bitmap) {
        frame = bitmap
        preview.setImageBitmap(bitmap)
        if (state == State.RECORDING || state == State.PAUSED) recorder.updateFrame(bitmap)
        // ImageView/HWUI may still retain the preceding bitmap for this frame; allow GC to reclaim it.
    }
    private fun noteKey() = "note_${document?.key}_$slide"
    private fun notes(): String = prefs.getString(noteKey(), null) ?: document?.document?.notes(slide).orEmpty()
    private fun showNotes() {
        val text = notes()
        script.text = text.ifBlank { "이 슬라이드에서 할 말을 적어 보세요.\n\n위의 ‘편집’을 누르면 대본을 입력할 수 있습니다.\n\n이 영역은 영상에 담기지 않습니다." }
        scriptScroll.scrollTo(0, 0)
    }
    private fun editScript() {
        val input = EditText(this).apply {
            setText(notes()); textSize = 18f; setTextColor(ink)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            gravity = Gravity.TOP; minLines = 4; maxLines = 8
            setPadding(dp(20), dp(12), dp(20), dp(12))
            filters = arrayOf(android.text.InputFilter.LengthFilter(50000))
        }
        val key = noteKey()
        AlertDialog.Builder(this).setTitle("${slide + 1}번 슬라이드 대본").setView(input)
            .setNegativeButton("취소", null).setPositiveButton("저장") { _, _ ->
                prefs.edit().putString(key, input.text.toString()).apply(); showNotes()
            }.show()
    }
    private fun resizeScript(delta: Int) {
        fontSize = (fontSize + delta).coerceIn(14f, 36f)
        script.textSize = fontSize; prefs.edit().putFloat("fontSize", fontSize).apply()
    }

    private fun requestStart() {
        if (frame == null || busy || state != State.IDLE) return
        if (microphone && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), MICROPHONE)
            return
        }
        if (StatFs(filesDir.path).availableBytes < 150L * 1024 * 1024) {
            showError("저장 공간 부족", IllegalStateException("150 MB 이상의 여유 공간을 확보해 주세요.")); return
        }
        state = State.STARTING; status.text = "녹화를 준비하고 있습니다…"; refresh()
        val folder = File(filesDir, "recordings").apply { mkdirs() }
        try { recorder.start(File(folder, "take-${System.currentTimeMillis()}.mp4"), frame!!, microphone) }
        catch (e: Exception) { state = State.IDLE; refresh(); showError("녹화를 시작하지 못했습니다", e) }
    }
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == MICROPHONE) {
            if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) requestStart()
            else AlertDialog.Builder(this).setTitle("마이크 권한이 필요합니다")
                .setMessage("음성 없이 녹화하거나, 앱 설정에서 마이크를 허용해 주세요.")
                .setPositiveButton("음성 없이 녹화") { _, _ -> microphone = false; prefs.edit().putBoolean("microphone", false).apply(); refresh(); requestStart() }
                .setNeutralButton("앱 설정") { _, _ -> startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))) }
                .setNegativeButton("취소", null).show()
        }
    }
    private fun togglePause() {
        if (state == State.RECORDING) { recorder.pause(); state = State.PAUSED; status.text = "일시정지 · 재개하면 같은 영상에 이어서 녹화됩니다" }
        else if (state == State.PAUSED) { recorder.resume(); state = State.RECORDING; status.text = "녹화 중 · 대본과 버튼은 영상에 포함되지 않습니다" }
        refresh()
    }
    private fun finishRecording() {
        if (state != State.RECORDING && state != State.PAUSED) return
        state = State.STOPPING; status.text = "영상을 마무리하고 갤러리에 저장하고 있습니다…"; refresh()
        recorder.stopAsync { /* Trigger finalization immediately, even during page rendering. */ }
        background.execute {
            try {
                val file = recorder.stop()
                exportRecording(file)
            } catch (e: Exception) { main.post { if (!destroyed) { state = State.IDLE; refresh(); showError("영상 저장을 완료하지 못했습니다", e) } } }
        }
    }

    private fun exportRecording(file: File) {
        try {
            val uri = VideoStore.save(this, file)
            main.post { if (!destroyed) { savedVideo = uri; state = State.IDLE; status.text = "저장 완료 · 갤러리 › Movies/PresentationStudio"; refresh() } }
        } catch (e: Exception) {
            main.post { if (!destroyed) {
                state = State.IDLE; status.text = "갤러리 저장 실패 · 원본 영상은 앱에 보관되어 있습니다"; refresh()
                AlertDialog.Builder(this).setTitle("영상 저장 재시도")
                    .setMessage("${e.message}\n\n저장 공간을 확인해 주세요. 원본 영상은 보관 중입니다.")
                    .setPositiveButton("다시 저장") { _, _ ->
                        state = State.STOPPING; refresh(); background.execute { exportRecording(file) }
                    }.setNegativeButton("나중에", null).show()
            } }
        }
    }
    private var recoveryChecked = false
    private fun recoverVideos() {
        if (recoveryChecked) return
        recoveryChecked = true
        val files = File(filesDir, "recordings").listFiles()?.filter { it.extension == "mp4" && it.length() > 0 }.orEmpty()
        if (files.isEmpty()) return
        AlertDialog.Builder(this).setTitle("이전 영상 저장 재시도")
            .setMessage("이전에 갤러리로 옮기지 못한 영상 ${files.size}개가 있습니다. 저장을 다시 시도할 수 있습니다.")
            .setPositiveButton("저장 재시도") { _, _ ->
                background.execute {
                    var failures = 0
                    var uri: Uri? = null
                    files.forEach { file -> try {
                        android.media.MediaMetadataRetriever().use { reader -> reader.setDataSource(file.path); require(reader.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_DURATION) != null) }
                        uri = VideoStore.save(this, file)
                    } catch (_: Exception) { failures++ } }
                    val latest = uri; val count = failures
                    main.post { if (!destroyed) { savedVideo = latest; status.text = "이전 영상 ${files.size - count}개 저장 · 미완료 ${count}개"; refresh() } }
                }
            }.setNegativeButton("나중에", null).show()
    }
    private fun shareVideo() {
        val uri = savedVideo ?: return
        val send = Intent(Intent.ACTION_SEND).apply { type = "video/mp4"; putExtra(Intent.EXTRA_STREAM, uri); addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION) }
        startActivity(Intent.createChooser(send, "발표 영상 공유"))
    }
    private fun refresh() {
        if (!::record.isInitialized) return
        val idle = state == State.IDLE
        open.isEnabled = idle && !busy
        mic.isEnabled = idle && !busy
        mic.text = if (microphone) "마이크 켜짐" else "마이크 꺼짐"
        mic.setTextColor(if (microphone) accent else muted)
        share.isEnabled = idle && savedVideo != null
        edit.isEnabled = document != null && !busy && idle
        previous.isEnabled = !busy && slide > 0 && state != State.STARTING && state != State.STOPPING
        next.isEnabled = !busy && slide + 1 < (document?.document?.slideCount ?: 0) && state != State.STARTING && state != State.STOPPING
        counter.text = document?.let { "${slide + 1} / ${it.document.slideCount}" } ?: "— / —"
        record.isEnabled = frame != null && (!busy || !idle) && state != State.STARTING && state != State.STOPPING
        record.text = when (state) { State.IDLE -> "●  녹화 시작"; State.STARTING -> "준비 중…"; State.STOPPING -> "저장 중…"; else -> "■  녹화 종료" }
        record.background = rounded(if (idle) accent else Color.rgb(251, 113, 133), 12f)
        pause.isEnabled = state == State.RECORDING || state == State.PAUSED
        pause.text = if (state == State.PAUSED) "▶  재개" else "Ⅱ  일시정지"
        listOf(open, mic, share, edit, previous, next, record, pause).forEach { it.alpha = if (it.isEnabled) 1f else 0.35f }
    }
    private val ticker = object : Runnable {
        override fun run() {
            if (destroyed) return
            val seconds = recorder.elapsedMillis / 1000
            val formattedTime = if (seconds >= 3600) String.format(Locale.US, "%d:%02d:%02d", seconds / 3600, seconds / 60 % 60, seconds % 60)
                else String.format(Locale.US, "%02d:%02d", seconds / 60, seconds % 60)
            if (timer.text.toString() != formattedTime) timer.text = formattedTime
            val timerColor = if (state == State.RECORDING) Color.rgb(251, 113, 133) else ink
            if (timer.currentTextColor != timerColor) timer.setTextColor(timerColor)
            if (autoScroll && visible && state != State.PAUSED) scriptScroll.scrollBy(0, dp(1).coerceAtLeast(1))
            main.postDelayed(this, 80)
        }
    }
    private fun help() {
        val limitations = document?.document?.warnings.orEmpty().distinct().joinToString("\n")
        AlertDialog.Builder(this).setTitle("발표 스튜디오 사용 안내")
            .setMessage("1. PDF를 엽니다.\n2. ‘편집’에서 슬라이드별 대본을 작성합니다.\n3. 마이크를 선택하고 녹화를 시작합니다.\n4. 슬라이드를 넘기며 발표하고, 종료하면 갤러리에 MP4로 저장됩니다.\n\n출력: 1280×720 · H.264 · 마이크 사용 시 AAC\n대본은 기기에 자동 저장됩니다. 인터넷 연결은 사용하지 않습니다.\n앱을 벗어나거나 화면을 잠그면 녹화를 종료하고 저장합니다.\n\nPowerPoint에서는 ‘다른 이름으로 저장 → PDF’로 내보내세요. 일반 PDF도 열 수 있습니다. 가로·세로 페이지는 비율을 유지하고 빈 공간은 검게 채웁니다. PDF의 정적 페이지가 녹화되며 링크·동영상은 재생되지 않습니다. 암호로 보호된 PDF는 암호를 해제한 사본이 필요합니다. 최대 파일 크기는 100 MB입니다.\n\n$limitations\n\n오픈소스 라이선스: 앱 MIT, Kotlin Apache-2.0 및 포함된 제3자 고지. 자세한 고지는 저장소 THIRD_PARTY_NOTICES.md 및 앱에 포함된 NOTICE.txt를 참조하세요.")
            .setNeutralButton("라이선스") { _, _ ->
                val text = assets.open("NOTICE.txt").bufferedReader().use { it.readText() }
                AlertDialog.Builder(this).setTitle("오픈소스 고지").setMessage(text).setPositiveButton("닫기", null).show()
            }.setPositiveButton("닫기", null).show()
    }
    private fun showError(title: String, error: Throwable) {
        if (destroyed || isFinishing) return
        status.text = error.message ?: "다시 시도해 주세요."
        AlertDialog.Builder(this).setTitle(title).setMessage(error.message ?: error.javaClass.simpleName).setPositiveButton("확인", null).show()
    }
    override fun onStart() { super.onStart(); visible = true }
    override fun onStop() { visible = false; if (state == State.RECORDING || state == State.PAUSED) finishRecording(); super.onStop() }
    @Deprecated("Platform back API")
    override fun onBackPressed() {
        if (state != State.IDLE) {
            if (state == State.RECORDING || state == State.PAUSED) AlertDialog.Builder(this).setTitle("녹화를 종료할까요?")
                .setMessage("현재까지의 발표 영상을 저장합니다.").setPositiveButton("녹화 종료") { _, _ -> finishRecording() }.setNegativeButton("계속 발표", null).show()
        } else super.onBackPressed()
    }
    override fun onDestroy() {
        destroyed = true; main.removeCallbacks(ticker)
        val closing = document
        background.execute { recorder.release(); closing?.document?.close() }
        background.shutdown()
        super.onDestroy()
    }
    companion object { private const val OPEN_FILE = 10; private const val MICROPHONE = 11 }
}
