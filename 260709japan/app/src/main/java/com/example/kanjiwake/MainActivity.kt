package com.example.kanjiwake

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
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
    private lateinit var connectionGuide: TextView
    private lateinit var runnerGroup: LinearLayout
    private lateinit var runnerSpinner: Spinner
    private lateinit var endpointGroup: LinearLayout
    private lateinit var endpointLabel: TextView
    private lateinit var endpointInput: EditText
    private lateinit var endpointHelpButton: Button
    private lateinit var endpointHint: TextView
    private lateinit var apiKeyGroup: LinearLayout
    private lateinit var apiKeyInput: EditText
    private lateinit var apiKeyAction: Button
    private lateinit var modelInput: EditText
    private lateinit var promptInput: EditText
    private lateinit var connectionStatus: TextView
    private lateinit var findModelsButton: Button
    private lateinit var monitorStatus: TextView
    private lateinit var monitorButton: Button

    private var currentProvider = AiProvider.GEMINI
    private var currentRunner = LocalRunner.OLLAMA
    private var suppressProviderSelection = true
    private var suppressRunnerSelection = true
    private var populatingForm = false
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
        currentRunner = settingsStore.localRunner()
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
        aiPanel.addView(sectionTitle("1. AI 연결"))

        providerSpinner = Spinner(this).apply {
            adapter = ArrayAdapter(
                this@MainActivity,
                android.R.layout.simple_spinner_dropdown_item,
                AiProvider.entries.map { it.displayName }
            )
        }
        aiPanel.addView(labeledField("AI가 어디에서 실행되나요?", providerSpinner))

        connectionGuide = TextView(this).apply {
            kwText(sizeSp = 14f, color = KwColor.Muted, lineSpacingExtraDp = 2)
            setPadding(0, dp(10), 0, 0)
        }
        aiPanel.addView(connectionGuide)

        runnerSpinner = Spinner(this).apply {
            adapter = ArrayAdapter(
                this@MainActivity,
                android.R.layout.simple_spinner_dropdown_item,
                LocalRunner.entries.map { it.displayName }
            )
        }
        val runnerSetupButton = Button(this).apply {
            text = "PC 준비 방법"
            kwButton(
                fill = KwColor.Surface,
                textColor = KwColor.Teal,
                strokeColor = KwColor.Teal,
                compact = true
            )
            setOnClickListener { showLocalSetupGuide() }
        }
        val runnerRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(runnerSpinner, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(
                runnerSetupButton,
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { leftMargin = dp(8) }
            )
        }
        runnerGroup = labeledField("PC에서 사용할 프로그램", runnerRow)
        aiPanel.addView(runnerGroup, matchWidth(top = 14))

        endpointLabel = fieldLabel("PC 주소")
        endpointHelpButton = Button(this).apply {
            text = "주소 찾는 법"
            kwButton(
                fill = KwColor.Surface,
                textColor = KwColor.Teal,
                strokeColor = KwColor.Teal,
                compact = true
            )
            setOnClickListener { showPcAddressGuide() }
        }
        val endpointHeader = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(endpointLabel, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(endpointHelpButton)
        }
        endpointInput = input(
            hint = "예: 192.168.0.10",
            inputTypeValue = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
        )
        endpointHint = TextView(this).apply {
            text = "포트와 API 경로는 앱이 자동으로 채웁니다."
            kwText(sizeSp = 12f, color = KwColor.Muted)
            setPadding(0, dp(5), 0, 0)
        }
        endpointGroup = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(endpointHeader)
            addView(endpointInput, matchWidth(top = 6))
            addView(endpointHint)
        }
        aiPanel.addView(endpointGroup, matchWidth(top = 14))

        val apiKeyHeader = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        apiKeyHeader.addView(
            fieldLabel("나만의 연결 키"),
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        )
        apiKeyAction = Button(this).apply {
            text = "개인 키 만들기"
            kwButton(
                fill = KwColor.Surface,
                textColor = KwColor.Teal,
                strokeColor = KwColor.Teal,
                compact = true
            )
            setOnClickListener { openUrl(AI_STUDIO_KEY_URL) }
        }
        apiKeyHeader.addView(apiKeyAction)
        apiKeyInput = input(
            hint = "만든 키를 여기에 붙여 넣기",
            inputTypeValue = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        )
        apiKeyGroup = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(apiKeyHeader)
            addView(apiKeyInput, matchWidth(top = 6))
        }
        aiPanel.addView(apiKeyGroup, matchWidth(top = 14))

        modelInput = input("연결 확인 후 자동으로 선택됩니다", InputType.TYPE_CLASS_TEXT)
        aiPanel.addView(labeledField("사용할 AI 모델", modelInput), matchWidth(top = 14))

        findModelsButton = Button(this).apply {
            text = "연결 확인하고 모델 고르기"
            kwButton(fill = KwColor.Plum, textColor = KwColor.Surface)
            setOnClickListener { findModels() }
        }
        aiPanel.addView(findModelsButton, matchWidth(top = 12))

        connectionStatus = TextView(this).apply {
            kwText(sizeSp = 13f, color = KwColor.Muted, bold = true, lineSpacingExtraDp = 2)
            setPadding(dp(12), dp(10), dp(12), dp(10))
        }
        aiPanel.addView(connectionStatus, matchWidth(top = 10))

        val promptPanel = panel()
        root.addView(promptPanel, matchWidth(top = 14))
        val promptHeader = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(sectionTitle("2. 문제 내용"), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(Button(this@MainActivity).apply {
                text = "예시에서 고르기"
                kwButton(
                    fill = KwColor.Surface,
                    textColor = KwColor.Teal,
                    strokeColor = KwColor.Teal,
                    compact = true
                )
                setOnClickListener { showPromptExamples() }
            })
        }
        promptPanel.addView(promptHeader)
        promptInput = input(
            hint = "예: 일본어 중상급 한자 어휘를 한국어 4지선다로 내줘",
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
            text = "이 설정 사용하기"
            kwButton(fill = KwColor.Teal, textColor = KwColor.Surface)
            setOnClickListener { saveCurrentSettings(showConfirmation = true) }
        }
        promptPanel.addView(saveButton, matchWidth(top = 12))

        val playPanel = panel()
        root.addView(playPanel, matchWidth(top = 14))
        playPanel.addView(sectionTitle("3. 퀘스트 실행"))
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

        runnerSpinner.onItemSelectedListener = SimpleItemSelectedListener { position ->
            if (suppressRunnerSelection) return@SimpleItemSelectedListener
            val selected = LocalRunner.entries[position]
            if (selected == currentRunner) return@SimpleItemSelectedListener
            val oldRunner = currentRunner
            currentRunner = selected
            if (currentProvider == AiProvider.LOCAL_SERVER) {
                val currentModel = modelInput.text.toString().trim()
                if (currentModel.isBlank() || currentModel == oldRunner.defaultModel) {
                    modelInput.setText(selected.defaultModel)
                }
                markConnectionUnchecked()
                updateProviderPresentation()
            }
        }

        val connectionWatcher = SimpleTextWatcher {
            if (!populatingForm) markConnectionUnchecked()
        }
        endpointInput.addTextChangedListener(connectionWatcher)
        apiKeyInput.addTextChangedListener(connectionWatcher)

        return scrollView
    }

    private fun selectProvider(provider: AiProvider) {
        suppressProviderSelection = true
        providerSpinner.setSelection(AiProvider.entries.indexOf(provider))
        suppressProviderSelection = false
        populateForm(drafts.getValue(provider))
    }

    private fun populateForm(settings: QuestSettings) {
        populatingForm = true
        if (settings.provider == AiProvider.LOCAL_SERVER) {
            suppressRunnerSelection = true
            runnerSpinner.setSelection(LocalRunner.entries.indexOf(currentRunner))
            suppressRunnerSelection = false
            endpointInput.setText(ConnectionGuide.friendlyLocalAddress(settings.endpoint, currentRunner))
        } else {
            endpointInput.setText(settings.endpoint)
        }
        apiKeyInput.setText(settings.apiKey)
        modelInput.setText(settings.model)
        promptInput.setText(settings.questPrompt)
        populatingForm = false
        updateProviderPresentation()
        markConnectionUnchecked()
    }

    private fun updateProviderPresentation() {
        runnerGroup.visibility = if (currentProvider == AiProvider.LOCAL_SERVER) View.VISIBLE else View.GONE
        endpointGroup.visibility = if (currentProvider == AiProvider.GEMINI) View.GONE else View.VISIBLE
        apiKeyGroup.visibility = if (currentProvider == AiProvider.LOCAL_SERVER) View.GONE else View.VISIBLE
        apiKeyAction.visibility = if (currentProvider == AiProvider.GEMINI) View.VISIBLE else View.GONE
        endpointHelpButton.visibility = if (currentProvider == AiProvider.LOCAL_SERVER) View.VISIBLE else View.GONE

        when (currentProvider) {
            AiProvider.GEMINI -> {
                connectionGuide.text =
                    "설치 없이 시작하는 방식입니다. 개인 키를 만든 뒤 연결 확인을 누르세요."
                apiKeyInput.hint = "만든 키를 여기에 붙여 넣기"
                modelInput.hint = "연결 확인 후 자동으로 선택됩니다"
            }
            AiProvider.LOCAL_SERVER -> {
                connectionGuide.text =
                    "문제는 PC 안에서 생성됩니다. 휴대폰과 PC를 같은 Wi-Fi에 연결하세요."
                endpointLabel.text = "PC의 Wi-Fi 주소"
                endpointInput.hint = "예: 192.168.0.10"
                endpointHint.text = when (currentRunner) {
                    LocalRunner.OLLAMA -> "Ollama의 11434 포트와 /v1은 앱이 자동으로 채웁니다."
                    LocalRunner.LM_STUDIO -> "LM Studio의 1234 포트와 /v1은 앱이 자동으로 채웁니다."
                }
                modelInput.hint = if (currentRunner == LocalRunner.OLLAMA) {
                    "예: gemma3:4b"
                } else {
                    "연결 확인 후 설치된 모델을 고르세요"
                }
            }
            AiProvider.OPENAI_COMPATIBLE -> {
                connectionGuide.text =
                    "서버 운영자에게 받은 주소, 키, 모델을 입력하는 고급 방식입니다."
                endpointLabel.text = "OpenAI 호환 서버 주소"
                endpointInput.hint = "예: https://example.com/v1"
                endpointHint.text = "서버 주소에 /v1이 없어도 앱이 자동으로 붙입니다."
                apiKeyInput.hint = "API 키가 없으면 비워 두기"
                modelInput.hint = "서버에서 사용할 모델 이름"
            }
        }
    }

    private fun readForm(provider: AiProvider = currentProvider): QuestSettings {
        val rawEndpoint = endpointInput.text.toString().trim()
        val endpoint = if (provider == AiProvider.LOCAL_SERVER) {
            runCatching { ConnectionGuide.normalizeLocalEndpoint(rawEndpoint, currentRunner) }
                .getOrDefault(rawEndpoint)
        } else {
            rawEndpoint
        }
        return QuestSettings(
            provider = provider,
            endpoint = endpoint,
            model = modelInput.text.toString().trim(),
            apiKey = apiKeyInput.text.toString().trim(),
            questPrompt = promptInput.text.toString().trim()
        )
    }

    private fun saveCurrentSettings(showConfirmation: Boolean): Boolean {
        val inputError = ConnectionGuide.connectionInputError(
            provider = currentProvider,
            rawEndpoint = endpointInput.text.toString(),
            apiKey = apiKeyInput.text.toString(),
            runner = currentRunner
        )
        if (inputError != null) {
            showConnectionInputError(inputError)
            return false
        }

        val settings = readForm()
        settings.validationError()?.let {
            Toast.makeText(this, it, Toast.LENGTH_LONG).show()
            return false
        }
        drafts[currentProvider] = settings
        settingsStore.save(settings)
        if (currentProvider == AiProvider.LOCAL_SERVER) {
            settingsStore.saveLocalRunner(currentRunner)
        }
        if (showConfirmation) {
            Toast.makeText(this, "이제 이 설정으로 문제를 만듭니다.", Toast.LENGTH_SHORT).show()
        }
        updateMonitorState()
        return true
    }

    private fun findModels() {
        val inputError = ConnectionGuide.connectionInputError(
            provider = currentProvider,
            rawEndpoint = endpointInput.text.toString(),
            apiKey = apiKeyInput.text.toString(),
            runner = currentRunner
        )
        if (inputError != null) {
            showConnectionInputError(inputError)
            return
        }

        val settings = readForm()
        backgroundTask?.cancel(true)
        findModelsButton.isEnabled = false
        findModelsButton.text = "연결 확인 중..."
        setConnectionStatus(ConnectionState.CHECKING, checkingMessage())
        backgroundTask = QuestRuntime.submit(
            block = { QuestAiClient.listModels(settings) },
            callback = { result ->
                if (isDestroyed) return@submit
                findModelsButton.isEnabled = true
                findModelsButton.text = "연결 확인하고 모델 고르기"
                result.onSuccess { models ->
                    if (models.isEmpty()) {
                        val message = ConnectionGuide.emptyModelMessage(currentProvider, currentRunner)
                        setConnectionStatus(ConnectionState.WARNING, message)
                        showNoModelsDialog(message)
                        return@onSuccess
                    }
                    chooseModel(models)
                }.onFailure { error ->
                    val message = ConnectionGuide.explainFailure(currentProvider, currentRunner, error)
                    setConnectionStatus(ConnectionState.FAILURE, message)
                    showConnectionFailure(message)
                }
            }
        )
    }

    private fun chooseModel(models: List<String>) {
        val current = modelInput.text.toString().trim()
        val suggested = when {
            current in models -> current
            currentRunner.defaultModel in models -> currentRunner.defaultModel
            currentProvider == AiProvider.GEMINI ->
                models.firstOrNull { it == "gemini-2.5-flash" }
                    ?: models.firstOrNull { "flash" in it }
                    ?: models.first()
            else -> models.first()
        }
        modelInput.setText(suggested)
        setConnectionStatus(ConnectionState.SUCCESS, "연결 성공 · $suggested")
        if (models.size == 1) return

        val labels = models.map { model ->
            if (model == suggested) "$model · 권장" else model
        }
        AlertDialog.Builder(this)
            .setTitle("사용할 AI 모델 고르기")
            .setItems(labels.toTypedArray()) { _, which ->
                val selected = models[which]
                modelInput.setText(selected)
                setConnectionStatus(ConnectionState.SUCCESS, "연결 성공 · $selected")
            }
            .setNegativeButton("권장 모델 사용", null)
            .show()
    }

    private fun checkingMessage(): String = when (currentProvider) {
        AiProvider.GEMINI -> "Google에서 사용할 수 있는 AI를 찾는 중입니다."
        AiProvider.LOCAL_SERVER -> "PC의 ${runnerShortName()}를 찾는 중입니다."
        AiProvider.OPENAI_COMPATIBLE -> "입력한 AI 서버에 연결하는 중입니다."
    }

    private fun markConnectionUnchecked() {
        val message = when (currentProvider) {
            AiProvider.GEMINI -> "키를 입력한 뒤 연결 확인을 눌러 주세요."
            AiProvider.LOCAL_SERVER -> "PC 준비가 끝났다면 연결 확인을 눌러 주세요."
            AiProvider.OPENAI_COMPATIBLE -> "서버 정보를 입력한 뒤 연결 확인을 눌러 주세요."
        }
        setConnectionStatus(ConnectionState.UNCHECKED, message)
    }

    private fun setConnectionStatus(state: ConnectionState, message: String) {
        val (fill, textColor) = when (state) {
            ConnectionState.UNCHECKED -> KwColor.Input to KwColor.Muted
            ConnectionState.CHECKING -> KwColor.WarningSurface to KwColor.Ink
            ConnectionState.SUCCESS -> KwColor.GoodSurface to KwColor.Good
            ConnectionState.WARNING -> KwColor.WarningSurface to KwColor.Ink
            ConnectionState.FAILURE -> KwColor.BadSurface to KwColor.Bad
        }
        connectionStatus.text = message
        connectionStatus.setTextColor(textColor)
        connectionStatus.background = rounded(fill, radiusDp = 6)
    }

    private fun showConnectionInputError(message: String) {
        setConnectionStatus(ConnectionState.FAILURE, message)
        val builder = AlertDialog.Builder(this)
            .setTitle("한 가지만 확인해 주세요")
            .setMessage(message)
            .setNegativeButton("닫기", null)
        when (currentProvider) {
            AiProvider.GEMINI -> builder.setPositiveButton("개인 키 만들기") { _, _ ->
                openUrl(AI_STUDIO_KEY_URL)
            }
            AiProvider.LOCAL_SERVER -> builder.setPositiveButton("PC 준비 방법") { _, _ ->
                showLocalSetupGuide()
            }
            AiProvider.OPENAI_COMPATIBLE -> Unit
        }
        builder.show()
    }

    private fun showConnectionFailure(message: String) {
        val builder = AlertDialog.Builder(this)
            .setTitle("아직 연결되지 않았습니다")
            .setMessage(message)
            .setNegativeButton("닫기", null)
        when (currentProvider) {
            AiProvider.GEMINI -> builder.setPositiveButton("키 다시 확인") { _, _ ->
                openUrl(AI_STUDIO_KEY_URL)
            }
            AiProvider.LOCAL_SERVER -> builder.setPositiveButton("PC 준비 방법") { _, _ ->
                showLocalSetupGuide()
            }
            AiProvider.OPENAI_COMPATIBLE -> Unit
        }
        builder.show()
    }

    private fun showNoModelsDialog(message: String) {
        val builder = AlertDialog.Builder(this)
            .setTitle("연결됐지만 모델이 없습니다")
            .setMessage(message)
            .setNegativeButton("닫기", null)
        if (currentProvider == AiProvider.LOCAL_SERVER) {
            builder.setPositiveButton("PC 준비 방법") { _, _ -> showLocalSetupGuide() }
        }
        builder.show()
    }

    private fun showLocalSetupGuide() {
        when (currentRunner) {
            LocalRunner.OLLAMA -> AlertDialog.Builder(this)
                .setTitle("PC에서 Ollama 준비하기")
                .setMessage(
                    "1. PC에 Ollama를 설치합니다.\n\n" +
                        "2. PC의 명령창에서 모델을 받습니다.\n" +
                        "가볍게 시작: ollama pull gemma3:4b\n" +
                        "고성능 PC: ollama pull gemma3:27b\n\n" +
                        "3. 다른 기기의 연결을 허용합니다.\n" +
                        "Windows: Windows 검색에서 '환경 변수' > '계정의 환경 변수 편집' > '새로 만들기'를 누르고, 이름은 OLLAMA_HOST, 값은 0.0.0.0:11434로 입력\n" +
                        "macOS: launchctl setenv OLLAMA_HOST \"0.0.0.0:11434\" 실행\n" +
                        "Linux: Ollama 서비스에 OLLAMA_HOST=0.0.0.0:11434 설정\n\n" +
                        "4. Ollama를 다시 시작하고 휴대폰과 PC를 같은 Wi-Fi에 연결합니다."
                )
                .setNeutralButton("모델 명령 복사") { _, _ ->
                    copyText("Ollama 모델 설치 명령", "ollama pull gemma3:4b")
                }
                .setPositiveButton("Ollama 설치") { _, _ -> openUrl(currentRunner.setupUrl) }
                .setNegativeButton("닫기", null)
                .show()

            LocalRunner.LM_STUDIO -> AlertDialog.Builder(this)
                .setTitle("PC에서 LM Studio 준비하기")
                .setMessage(
                    "1. PC에 LM Studio를 설치하고 원하는 모델을 내려받습니다.\n\n" +
                        "2. 왼쪽 Developer 화면에서 Start Server를 켭니다.\n\n" +
                        "3. Server Settings에서 Serve on Local Network를 켭니다.\n\n" +
                        "4. 휴대폰과 PC를 같은 Wi-Fi에 연결합니다."
                )
                .setNeutralButton("공식 연결 안내") { _, _ -> openUrl(LM_STUDIO_NETWORK_URL) }
                .setPositiveButton("LM Studio 설치") { _, _ -> openUrl(currentRunner.setupUrl) }
                .setNegativeButton("닫기", null)
                .show()
        }
    }

    private fun showPcAddressGuide() {
        AlertDialog.Builder(this)
            .setTitle("PC의 Wi-Fi 주소 찾기")
            .setMessage(
                "Windows\n설정 > 네트워크 및 인터넷 > Wi-Fi > 연결된 네트워크 > IPv4 주소\n\n" +
                    "macOS\n시스템 설정 > 네트워크 > Wi-Fi > 세부사항 > TCP/IP > IP 주소\n\n" +
                    "Linux\n네트워크 설정의 연결 정보에서 IPv4 주소 확인\n\n" +
                    "192.168 또는 10으로 시작하는 숫자를 앱에 입력하세요. localhost와 0.0.0.0은 입력하지 않습니다."
            )
            .setPositiveButton("확인", null)
            .show()
    }

    private fun showPromptExamples() {
        val examples = listOf(
            "일본어 한자 어휘" to PerOpenQuestPrefs.DEFAULT_QUEST_PROMPT,
            "영어 단어" to
                "영어 중급 학습자를 위한 어휘 뜻 문제를 한국어 4지선다로 출제해 주세요. 정답 해설에 짧은 영어 예문을 포함해 주세요.",
            "한국사" to
                "한국사 주요 사건과 인물을 묻는 4지선다 문제를 출제해 주세요. 시대가 골고루 나오게 하고 해설에는 연도를 포함해 주세요.",
            "컴퓨터 기초" to
                "컴퓨터와 인터넷의 기본 원리를 비전공자 수준의 한국어 4지선다 문제로 출제해 주세요. 전문 용어는 해설에서 쉽게 풀어 주세요."
        )
        AlertDialog.Builder(this)
            .setTitle("문제 예시 고르기")
            .setItems(examples.map { it.first }.toTypedArray()) { _, which ->
                promptInput.setText(examples[which].second)
            }
            .setNegativeButton("닫기", null)
            .show()
    }

    private fun copyText(label: String, value: String) {
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText(label, value))
        Toast.makeText(this, "명령을 복사했습니다.", Toast.LENGTH_SHORT).show()
    }

    private fun openUrl(url: String) {
        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
    }

    private fun runnerShortName(): String = when (currentRunner) {
        LocalRunner.OLLAMA -> "Ollama"
        LocalRunner.LM_STUDIO -> "LM Studio"
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
        private const val LM_STUDIO_NETWORK_URL =
            "https://lmstudio.ai/docs/developer/core/server/serve-on-network"
        private const val LEGACY_DB_NAME = "kanji_wake_words.db"
        private const val KEY_LEGACY_DB_REMOVED = "legacy_vocabulary_db_removed"
    }
}

private enum class ConnectionState {
    UNCHECKED,
    CHECKING,
    SUCCESS,
    WARNING,
    FAILURE
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

private class SimpleTextWatcher(
    private val onChanged: () -> Unit
) : TextWatcher {
    override fun beforeTextChanged(value: CharSequence?, start: Int, count: Int, after: Int) = Unit
    override fun onTextChanged(value: CharSequence?, start: Int, before: Int, count: Int) = onChanged()
    override fun afterTextChanged(value: Editable?) = Unit
}
