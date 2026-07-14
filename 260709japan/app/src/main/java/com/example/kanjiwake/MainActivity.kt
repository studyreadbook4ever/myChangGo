package com.example.kanjiwake

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import java.util.concurrent.Future

class MainActivity : Activity() {
    private val settingsStore by lazy { QuestSettingsStore(this) }
    private val prefs by lazy {
        getSharedPreferences(PerOpenQuestPrefs.NAME, MODE_PRIVATE)
    }
    private val drafts = mutableMapOf<AiProvider, QuestSettings>()

    private lateinit var providerSpinner: Spinner
    private lateinit var endpointGroup: LinearLayout
    private lateinit var endpointInput: EditText
    private lateinit var apiKeyInput: EditText
    private lateinit var apiKeyAction: Button
    private lateinit var modelInput: EditText
    private lateinit var promptInput: EditText
    private lateinit var connectionStatus: TextView
    private lateinit var findModelsButton: Button
    private lateinit var monitorStatus: TextView
    private lateinit var monitorButton: Button

    private var currentProvider = AiProvider.GEMINI
    private var suppressProviderSelection = true
    private var backgroundTask: Future<*>? = null
    private var pendingMonitorEnable = false
    private var pendingMonitorAfterOverlayPermission = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = KwColor.Paper
        window.navigationBarColor = KwColor.Paper
        @Suppress("DEPRECATION")
        run { window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR }

        currentProvider = settingsStore.activeProvider()
        removeLegacyVocabularyDatabase()
        AiProvider.entries.forEach { drafts[it] = settingsStore.load(it) }
        setContentView(buildContent())
        selectProvider(currentProvider)
    }

    override fun onResume() {
        super.onResume()
        if (pendingMonitorAfterOverlayPermission && Settings.canDrawOverlays(this)) {
            pendingMonitorAfterOverlayPermission = false
            setMonitorEnabled(true)
        }
        updateMonitorState()
    }

    override fun onDestroy() {
        backgroundTask?.cancel(true)
        super.onDestroy()
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_NOTIFICATIONS || !pendingMonitorEnable) return

        pendingMonitorEnable = false
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
            if (ensureOverlayPermission(enableMonitorAfterGrant = true)) {
                setMonitorEnabled(true)
            }
        } else {
            Toast.makeText(
                this,
                "알림 권한이 없으면 잠금 후 퀘스트를 안정적으로 유지할 수 없습니다.",
                Toast.LENGTH_LONG
            ).show()
            updateMonitorState()
        }
    }

    private fun buildContent(): View {
        val scrollView = ScrollView(this).apply {
            isFillViewport = true
            setBackgroundColor(KwColor.Paper)
        }
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(24), dp(20), dp(30))
        }
        scrollView.addView(
            root,
            ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        )

        root.addView(TextView(this).apply {
            text = "Per-Open Quest"
            kwText(sizeSp = 30f, bold = true)
        })
        root.addView(TextView(this).apply {
            text = "열 때마다 새로 생성되는 나만의 퀘스트"
            kwText(sizeSp = 15f, color = KwColor.Muted)
            setPadding(0, dp(4), 0, 0)
        })

        val aiPanel = panel()
        root.addView(aiPanel, matchWidth(top = 20))
        aiPanel.addView(sectionTitle("AI 연결"))

        providerSpinner = Spinner(this).apply {
            adapter = ArrayAdapter(
                this@MainActivity,
                android.R.layout.simple_spinner_dropdown_item,
                AiProvider.entries.map { it.displayName }
            )
        }
        aiPanel.addView(labeledField("연결 방식", providerSpinner))

        endpointInput = input(
            hint = "http://PC-IP:11434/v1",
            inputTypeValue = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
        )
        endpointGroup = labeledField("서버 주소", endpointInput)
        aiPanel.addView(endpointGroup, matchWidth(top = 12))

        val apiKeyHeader = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        apiKeyHeader.addView(fieldLabel("API 키"), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        apiKeyAction = Button(this).apply {
            text = "키 만들기"
            kwButton(fill = KwColor.Surface, textColor = KwColor.Teal, strokeColor = KwColor.Teal, compact = true)
            setOnClickListener {
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(AI_STUDIO_KEY_URL)))
            }
        }
        apiKeyHeader.addView(apiKeyAction)
        apiKeyInput = input(
            hint = "Google AI Studio API 키",
            inputTypeValue = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        )
        val apiKeyGroup = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(apiKeyHeader)
            addView(apiKeyInput, matchWidth(top = 6))
        }
        aiPanel.addView(apiKeyGroup, matchWidth(top = 12))

        modelInput = input("모델 이름", InputType.TYPE_CLASS_TEXT)
        val modelRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(modelInput, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        }
        findModelsButton = Button(this).apply {
            text = "모델 찾기"
            kwButton(fill = KwColor.Plum, textColor = KwColor.Surface, compact = true)
            setOnClickListener { findModels() }
        }
        modelRow.addView(
            findModelsButton,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { leftMargin = dp(8) }
        )
        aiPanel.addView(labeledField("모델", modelRow), matchWidth(top = 12))

        connectionStatus = TextView(this).apply {
            text = "설정을 확인한 뒤 모델을 불러오세요."
            kwText(sizeSp = 13f, color = KwColor.Muted)
            setPadding(0, dp(10), 0, 0)
        }
        aiPanel.addView(connectionStatus)

        val promptPanel = panel()
        root.addView(promptPanel, matchWidth(top = 14))
        promptPanel.addView(sectionTitle("출제 프롬프트"))
        promptInput = input(
            hint = "어떤 문제를 낼지 자연어로 입력",
            inputTypeValue = InputType.TYPE_CLASS_TEXT or
                InputType.TYPE_TEXT_FLAG_MULTI_LINE or
                InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
        ).apply {
            minLines = 5
            maxLines = 10
            gravity = Gravity.TOP or Gravity.START
        }
        promptPanel.addView(promptInput)

        val saveButton = Button(this).apply {
            text = "설정 저장"
            kwButton(fill = KwColor.Teal, textColor = KwColor.Surface)
            setOnClickListener { saveCurrentSettings(showConfirmation = true) }
        }
        promptPanel.addView(saveButton, matchWidth(top = 12))

        val playPanel = panel()
        root.addView(playPanel, matchWidth(top = 14))
        playPanel.addView(sectionTitle("퀘스트"))
        playPanel.addView(primaryButton("Endless Mode") {
            launchQuiz(QuizActivity.MODE_ENDLESS)
        })
        playPanel.addView(secondaryButton("잠금 퀘스트 테스트") {
            launchQuiz(QuizActivity.MODE_LOCK)
        }, matchWidth(top = 10))
        playPanel.addView(secondaryButton("오버레이 테스트") {
            if (!saveCurrentSettings(showConfirmation = false)) return@secondaryButton
            if (ensureOverlayPermission(enableMonitorAfterGrant = false)) {
                SoftLockService.showLockNow(this@MainActivity)
            }
        }, matchWidth(top = 10))

        val monitorPanel = panel()
        root.addView(monitorPanel, matchWidth(top = 14))
        monitorPanel.addView(sectionTitle("Per-Open"))
        monitorStatus = TextView(this).apply {
            kwText(sizeSp = 14f, color = KwColor.Muted, lineSpacingExtraDp = 2)
        }
        monitorPanel.addView(monitorStatus)
        monitorButton = primaryButton("") {
            if (isMonitorEnabled()) {
                setMonitorEnabled(false)
            } else if (saveCurrentSettings(showConfirmation = false)) {
                enableMonitorWithPermissionCheck()
            }
        }
        monitorPanel.addView(monitorButton, matchWidth(top = 12))

        providerSpinner.onItemSelectedListener = SimpleItemSelectedListener { position ->
            if (suppressProviderSelection) return@SimpleItemSelectedListener
            val selected = AiProvider.entries[position]
            if (selected == currentProvider) return@SimpleItemSelectedListener
            drafts[currentProvider] = readForm(currentProvider)
            currentProvider = selected
            val sharedPrompt = promptInput.text.toString()
            val next = drafts.getValue(selected).copy(questPrompt = sharedPrompt)
            drafts[selected] = next
            populateForm(next)
        }

        return scrollView
    }

    private fun selectProvider(provider: AiProvider) {
        suppressProviderSelection = true
        providerSpinner.setSelection(AiProvider.entries.indexOf(provider))
        suppressProviderSelection = false
        populateForm(drafts.getValue(provider))
    }

    private fun populateForm(settings: QuestSettings) {
        endpointInput.setText(settings.endpoint)
        apiKeyInput.setText(settings.apiKey)
        modelInput.setText(settings.model)
        promptInput.setText(settings.questPrompt)
        endpointGroup.visibility = if (settings.provider == AiProvider.GEMINI) View.GONE else View.VISIBLE
        apiKeyAction.visibility = if (settings.provider == AiProvider.GEMINI) View.VISIBLE else View.GONE
        apiKeyInput.hint = if (settings.provider == AiProvider.GEMINI) {
            "Google AI Studio API 키"
        } else {
            "API 키 (없으면 비워 두기)"
        }
        connectionStatus.text = when (settings.provider) {
            AiProvider.GEMINI -> "Google AI Studio의 Gemini 모델을 사용합니다."
            AiProvider.LOCAL_SERVER -> "같은 네트워크의 Ollama 또는 LM Studio를 사용합니다."
            AiProvider.OPENAI_COMPATIBLE -> "OpenAI 호환 API 서버를 사용합니다."
        }
    }

    private fun readForm(provider: AiProvider = currentProvider): QuestSettings = QuestSettings(
        provider = provider,
        endpoint = endpointInput.text.toString().trim(),
        model = modelInput.text.toString().trim(),
        apiKey = apiKeyInput.text.toString().trim(),
        questPrompt = promptInput.text.toString().trim()
    )

    private fun saveCurrentSettings(showConfirmation: Boolean): Boolean {
        val settings = readForm()
        settings.validationError()?.let {
            Toast.makeText(this, it, Toast.LENGTH_LONG).show()
            return false
        }
        drafts[currentProvider] = settings
        settingsStore.save(settings)
        if (showConfirmation) {
            Toast.makeText(this, "AI 퀘스트 설정을 저장했습니다.", Toast.LENGTH_SHORT).show()
        }
        updateMonitorState()
        return true
    }

    private fun findModels() {
        val settings = readForm()
        val connectionError = when {
            settings.provider == AiProvider.GEMINI && settings.apiKey.isBlank() ->
                "Google AI Studio API 키를 입력해 주세요."
            settings.provider != AiProvider.GEMINI && settings.endpoint.isBlank() ->
                "AI 서버 주소를 입력해 주세요."
            else -> null
        }
        if (connectionError != null) {
            Toast.makeText(this, connectionError, Toast.LENGTH_LONG).show()
            return
        }

        backgroundTask?.cancel(true)
        findModelsButton.isEnabled = false
        connectionStatus.text = "모델 목록을 불러오는 중..."
        backgroundTask = QuestRuntime.submit(
            block = { QuestAiClient.listModels(settings) },
            callback = { result ->
                if (isDestroyed) return@submit
                findModelsButton.isEnabled = true
                result.onSuccess { models ->
                    if (models.isEmpty()) {
                        connectionStatus.text = "사용 가능한 모델을 찾지 못했습니다."
                        return@onSuccess
                    }
                    connectionStatus.text = "연결됨 · 모델 ${models.size}개"
                    AlertDialog.Builder(this)
                        .setTitle("모델 선택")
                        .setItems(models.toTypedArray()) { _, which ->
                            modelInput.setText(models[which])
                        }
                        .setNegativeButton("닫기", null)
                        .show()
                }.onFailure { error ->
                    connectionStatus.text = error.message ?: "AI 서버 연결에 실패했습니다."
                }
            }
        )
    }

    private fun launchQuiz(mode: String) {
        if (!saveCurrentSettings(showConfirmation = false)) return
        startActivity(QuizActivity.createIntent(this, mode))
    }

    private fun enableMonitorWithPermissionCheck() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            pendingMonitorEnable = true
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFICATIONS)
            return
        }
        if (!ensureOverlayPermission(enableMonitorAfterGrant = true)) return
        setMonitorEnabled(true)
    }

    private fun ensureOverlayPermission(enableMonitorAfterGrant: Boolean): Boolean {
        if (Settings.canDrawOverlays(this)) return true
        pendingMonitorAfterOverlayPermission = enableMonitorAfterGrant
        Toast.makeText(
            this,
            "잠금 해제 뒤 퀘스트를 띄우려면 '다른 앱 위에 표시'를 허용해 주세요.",
            Toast.LENGTH_LONG
        ).show()
        startActivity(
            Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:$packageName")
            )
        )
        return false
    }

    private fun setMonitorEnabled(enabled: Boolean) {
        prefs.edit().putBoolean(PerOpenQuestPrefs.KEY_MONITOR_ENABLED, enabled).apply()
        if (enabled) {
            SoftLockService.start(this)
            Toast.makeText(this, "Per-Open 퀘스트를 켰습니다.", Toast.LENGTH_SHORT).show()
        } else {
            SoftLockService.stop(this)
            Toast.makeText(this, "Per-Open 퀘스트를 껐습니다.", Toast.LENGTH_SHORT).show()
        }
        updateMonitorState()
    }

    private fun isMonitorEnabled(): Boolean =
        prefs.getBoolean(PerOpenQuestPrefs.KEY_MONITOR_ENABLED, false)

    private fun updateMonitorState() {
        if (!::monitorStatus.isInitialized || !::monitorButton.isInitialized) return
        val enabled = isMonitorEnabled()
        monitorStatus.text = when {
            !enabled -> "상태: 꺼짐"
            !Settings.canDrawOverlays(this) -> "상태: 오버레이 권한 필요"
            settingsStore.loadActive().validationError() != null -> "상태: AI 설정 필요"
            else -> "상태: 켜짐 · 잠금 해제 후 새 퀘스트 생성"
        }
        monitorButton.text = if (enabled) "Per-Open 끄기" else "Per-Open 켜기"
        monitorButton.kwButton(
            fill = if (enabled) KwColor.Plum else KwColor.Teal,
            textColor = KwColor.Surface
        )
    }

    private fun removeLegacyVocabularyDatabase() {
        if (prefs.getBoolean(KEY_LEGACY_DB_REMOVED, false)) return
        deleteDatabase(LEGACY_DB_NAME)
        prefs.edit().putBoolean(KEY_LEGACY_DB_REMOVED, true).apply()
    }

    private fun panel(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        background = rounded(KwColor.Surface, radiusDp = 8, strokeColor = KwColor.Line)
        setPadding(dp(16), dp(16), dp(16), dp(16))
    }

    private fun sectionTitle(value: String): TextView = TextView(this).apply {
        text = value
        kwText(sizeSp = 16f, bold = true)
        setPadding(0, 0, 0, dp(10))
    }

    private fun fieldLabel(value: String): TextView = TextView(this).apply {
        text = value
        kwText(sizeSp = 13f, color = KwColor.Muted, bold = true)
    }

    private fun labeledField(label: String, field: View): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        addView(fieldLabel(label))
        addView(field, matchWidth(top = 6))
    }

    private fun input(hint: String, inputTypeValue: Int): EditText = EditText(this).apply {
        this.hint = hint
        inputType = inputTypeValue
        setTextColor(KwColor.Ink)
        setHintTextColor(KwColor.Muted)
        setTextSize(15f)
        background = rounded(KwColor.Input, radiusDp = 6, strokeColor = KwColor.Line)
        setPadding(dp(12), dp(11), dp(12), dp(11))
        minHeight = dp(48)
        typeface = Typeface.DEFAULT
    }

    private fun primaryButton(textValue: String, action: () -> Unit): Button = Button(this).apply {
        text = textValue
        gravity = Gravity.CENTER
        kwButton(fill = KwColor.Teal, textColor = KwColor.Surface)
        setOnClickListener { action() }
    }

    private fun secondaryButton(textValue: String, action: () -> Unit): Button = Button(this).apply {
        text = textValue
        gravity = Gravity.CENTER
        kwButton(fill = KwColor.Surface, textColor = KwColor.Ink, strokeColor = KwColor.Line)
        setOnClickListener { action() }
    }

    private fun matchWidth(top: Int = 0): LinearLayout.LayoutParams =
        LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(top) }

    companion object {
        private const val REQUEST_NOTIFICATIONS = 5001
        private const val AI_STUDIO_KEY_URL = "https://aistudio.google.com/app/apikey"
        private const val LEGACY_DB_NAME = "kanji_wake_words.db"
        private const val KEY_LEGACY_DB_REMOVED = "legacy_vocabulary_db_removed"
    }
}

private class SimpleItemSelectedListener(
    private val onSelected: (position: Int) -> Unit
) : android.widget.AdapterView.OnItemSelectedListener {
    override fun onItemSelected(
        parent: android.widget.AdapterView<*>?,
        view: View?,
        position: Int,
        id: Long
    ) = onSelected(position)

    override fun onNothingSelected(parent: android.widget.AdapterView<*>?) = Unit
}
