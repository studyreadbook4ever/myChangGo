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
    private lateinit var onDeviceGroup: LinearLayout
    private lateinit var deviceProfileText: TextView
    private lateinit var modelFileText: TextView
    private lateinit var accelerationSpinner: Spinner
    private lateinit var importModelButton: Button
    private lateinit var endpointGroup: LinearLayout
    private lateinit var endpointInput: EditText
    private lateinit var apiKeyGroup: LinearLayout
    private lateinit var apiKeyInput: EditText
    private lateinit var apiKeyAction: Button
    private lateinit var networkModelGroup: LinearLayout
    private lateinit var modelInput: EditText
    private lateinit var promptInput: EditText
    private lateinit var connectionStatus: TextView
    private lateinit var checkModelButton: Button
    private lateinit var monitorStatus: TextView
    private lateinit var monitorButton: Button

    private var currentProvider = AiProvider.GEMINI
    private var currentModelPath = ""
    private var currentAcceleration = OnDeviceAcceleration.AUTO
    private var suppressProviderSelection = true
    private var suppressAccelerationSelection = true
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

    @Deprecated("Deprecated in Android")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST_MODEL_FILE || resultCode != RESULT_OK) return
        val uri = data?.data ?: return
        runCatching {
            contentResolver.takePersistableUriPermission(
                uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION
            )
        }
        importOnDeviceModel(uri)
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

        onDeviceGroup = buildOnDeviceGroup()
        aiPanel.addView(onDeviceGroup, matchWidth(top = 14))

        endpointInput = input(
            hint = "예: https://example.com/v1",
            inputTypeValue = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
        )
        endpointGroup = labeledField("OpenAI 호환 서버 주소", endpointInput)
        aiPanel.addView(endpointGroup, matchWidth(top = 14))

        val apiKeyHeader = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(
                fieldLabel("나만의 연결 키"),
                LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            )
        }
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
        networkModelGroup = labeledField("사용할 AI 모델", modelInput)
        aiPanel.addView(networkModelGroup, matchWidth(top = 14))

        checkModelButton = Button(this).apply {
            kwButton(fill = KwColor.Plum, textColor = KwColor.Surface)
            setOnClickListener { checkCurrentAi() }
        }
        aiPanel.addView(checkModelButton, matchWidth(top = 12))

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
            addView(
                sectionTitle("2. 문제 내용"),
                LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            )
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
            if (currentProvider == AiProvider.ON_DEVICE) OnDeviceQuestClient.release()
            currentProvider = selected
            val sharedPrompt = promptInput.text.toString()
            val next = drafts.getValue(selected).copy(questPrompt = sharedPrompt)
            drafts[selected] = next
            populateForm(next)
        }

        accelerationSpinner.onItemSelectedListener = SimpleItemSelectedListener { position ->
            if (suppressAccelerationSelection) return@SimpleItemSelectedListener
            val selected = OnDeviceAcceleration.entries[position]
            if (selected == currentAcceleration) return@SimpleItemSelectedListener
            currentAcceleration = selected
            OnDeviceQuestClient.release()
            markConnectionUnchecked()
        }

        val connectionWatcher = SimpleTextWatcher {
            if (!populatingForm) markConnectionUnchecked()
        }
        endpointInput.addTextChangedListener(connectionWatcher)
        apiKeyInput.addTextChangedListener(connectionWatcher)

        return scrollView
    }

    private fun buildOnDeviceGroup(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL

        deviceProfileText = TextView(this@MainActivity).apply {
            kwText(sizeSp = 13f, color = KwColor.Ink, lineSpacingExtraDp = 3)
            setTextIsSelectable(true)
            setPadding(dp(12), dp(10), dp(12), dp(10))
            background = rounded(KwColor.Input, radiusDp = 6)
        }
        addView(deviceProfileText)

        val sourceButton = Button(this@MainActivity).apply {
            text = "추천 모델 받기"
            kwButton(fill = KwColor.Surface, textColor = KwColor.Teal, strokeColor = KwColor.Teal)
            setOnClickListener { showModelSources() }
        }
        addView(sourceButton, matchWidth(top = 10))

        importModelButton = Button(this@MainActivity).apply {
            text = "다운로드한 .litertlm 가져오기"
            kwButton(fill = KwColor.Teal, textColor = KwColor.Surface)
            setOnClickListener { pickModelFile() }
        }
        addView(importModelButton, matchWidth(top = 8))

        modelFileText = TextView(this@MainActivity).apply {
            kwText(sizeSp = 13f, color = KwColor.Muted, lineSpacingExtraDp = 2)
            setTextIsSelectable(true)
            setPadding(dp(12), dp(10), dp(12), dp(10))
            background = rounded(KwColor.Input, radiusDp = 6, strokeColor = KwColor.Line)
        }
        addView(modelFileText, matchWidth(top = 10))

        accelerationSpinner = Spinner(this@MainActivity).apply {
            adapter = ArrayAdapter(
                this@MainActivity,
                android.R.layout.simple_spinner_dropdown_item,
                OnDeviceAcceleration.entries.map { it.displayName }
            )
        }
        addView(labeledField("가속 방식", accelerationSpinner), matchWidth(top = 12))
    }

    private fun selectProvider(provider: AiProvider) {
        suppressProviderSelection = true
        providerSpinner.setSelection(AiProvider.entries.indexOf(provider))
        suppressProviderSelection = false
        populateForm(drafts.getValue(provider))
    }

    private fun populateForm(settings: QuestSettings) {
        populatingForm = true
        endpointInput.setText(settings.endpoint)
        apiKeyInput.setText(settings.apiKey)
        modelInput.setText(settings.model)
        promptInput.setText(settings.questPrompt)
        currentModelPath = settings.onDeviceModelPath
        currentAcceleration = settings.onDeviceAcceleration
        suppressAccelerationSelection = true
        accelerationSpinner.setSelection(OnDeviceAcceleration.entries.indexOf(currentAcceleration))
        suppressAccelerationSelection = false
        populatingForm = false
        updateProviderPresentation()
        updateOnDeviceModelDisplay()
        markConnectionUnchecked()
    }

    private fun updateProviderPresentation() {
        onDeviceGroup.visibility = if (currentProvider == AiProvider.ON_DEVICE) View.VISIBLE else View.GONE
        endpointGroup.visibility = if (currentProvider == AiProvider.OPENAI_COMPATIBLE) View.VISIBLE else View.GONE
        apiKeyGroup.visibility = if (currentProvider == AiProvider.ON_DEVICE) View.GONE else View.VISIBLE
        apiKeyAction.visibility = if (currentProvider == AiProvider.GEMINI) View.VISIBLE else View.GONE
        networkModelGroup.visibility = if (currentProvider == AiProvider.ON_DEVICE) View.GONE else View.VISIBLE

        when (currentProvider) {
            AiProvider.GEMINI -> {
                connectionGuide.text =
                    "설치 없이 시작하는 방식입니다. 개인 키를 만든 뒤 연결 확인을 누르세요."
                apiKeyInput.hint = "만든 키를 여기에 붙여 넣기"
                modelInput.hint = "연결 확인 후 자동으로 선택됩니다"
                checkModelButton.text = "연결 확인하고 모델 고르기"
            }
            AiProvider.ON_DEVICE -> {
                connectionGuide.text =
                    "모델과 문제 데이터가 휴대폰 밖으로 나가지 않습니다. 모델 파일을 한 번 가져온 뒤 NPU부터 실행을 시험합니다."
                deviceProfileText.text = OnDeviceCompatibility.deviceGuide(
                    OnDeviceCompatibility.currentProfile()
                )
                checkModelButton.text = "모델과 가속기 확인"
            }
            AiProvider.OPENAI_COMPATIBLE -> {
                connectionGuide.text =
                    "서버 운영자에게 받은 주소, 키, 모델을 입력하는 고급 방식입니다."
                apiKeyInput.hint = "API 키가 없으면 비워 두기"
                modelInput.hint = "서버에서 사용할 모델 이름"
                checkModelButton.text = "연결 확인하고 모델 고르기"
            }
        }
    }

    private fun updateOnDeviceModelDisplay() {
        val file = OnDeviceModelStore.existingFile(this, currentModelPath)
        modelFileText.text = if (file == null) {
            "가져온 모델 없음"
        } else {
            val name = OnDeviceModelStore.fileLabel(file.absolutePath)
            "$name\n${OnDeviceModelStore.formatSize(file.length())} · 앱 내부에 저장됨"
        }
    }

    private fun readForm(provider: AiProvider = currentProvider): QuestSettings {
        val modelFile = OnDeviceModelStore.existingFile(this, currentModelPath)
        return QuestSettings(
            provider = provider,
            endpoint = endpointInput.text.toString().trim(),
            model = if (provider == AiProvider.ON_DEVICE) {
                modelFile?.let { OnDeviceModelStore.fileLabel(it.absolutePath) }.orEmpty()
            } else {
                modelInput.text.toString().trim()
            },
            apiKey = if (provider == AiProvider.ON_DEVICE) "" else apiKeyInput.text.toString().trim(),
            questPrompt = promptInput.text.toString().trim(),
            onDeviceModelPath = currentModelPath,
            onDeviceAcceleration = currentAcceleration
        )
    }

    private fun saveCurrentSettings(showConfirmation: Boolean): Boolean {
        if (currentProvider != AiProvider.ON_DEVICE) {
            val inputError = ConnectionGuide.connectionInputError(
                provider = currentProvider,
                rawEndpoint = endpointInput.text.toString(),
                apiKey = apiKeyInput.text.toString()
            )
            if (inputError != null) {
                showConnectionInputError(inputError)
                return false
            }
        }

        val settings = readForm()
        if (currentProvider == AiProvider.ON_DEVICE) {
            val file = OnDeviceModelStore.existingFile(this, settings.onDeviceModelPath)
            if (file == null) {
                showOnDeviceFailure("다운로드한 .litertlm 모델을 먼저 가져와 주세요.")
                return false
            }
            OnDeviceCompatibility.compatibilityError(
                OnDeviceModelStore.fileLabel(file.absolutePath),
                OnDeviceCompatibility.currentProfile()
            )?.let {
                showOnDeviceFailure(it)
                return false
            }
        }
        settings.validationError()?.let {
            Toast.makeText(this, it, Toast.LENGTH_LONG).show()
            return false
        }
        drafts[currentProvider] = settings
        settingsStore.save(settings)
        if (showConfirmation) {
            Toast.makeText(this, "이제 이 설정으로 문제를 만듭니다.", Toast.LENGTH_SHORT).show()
        }
        updateMonitorState()
        return true
    }

    private fun checkCurrentAi() {
        if (currentProvider == AiProvider.ON_DEVICE) {
            prepareOnDeviceModel()
        } else {
            findNetworkModels()
        }
    }

    private fun prepareOnDeviceModel() {
        val settings = readForm()
        val file = OnDeviceModelStore.existingFile(this, settings.onDeviceModelPath)
        if (file == null) {
            showOnDeviceFailure("다운로드한 .litertlm 모델을 먼저 가져와 주세요.")
            return
        }
        OnDeviceCompatibility.compatibilityError(
            OnDeviceModelStore.fileLabel(file.absolutePath),
            OnDeviceCompatibility.currentProfile()
        )?.let {
            showOnDeviceFailure(it)
            return
        }

        backgroundTask?.cancel(true)
        providerSpinner.isEnabled = false
        checkModelButton.isEnabled = false
        importModelButton.isEnabled = false
        checkModelButton.text = "가속기 확인 중..."
        setConnectionStatus(
            ConnectionState.CHECKING,
            "모델을 여는 중입니다. 첫 실행은 10초 이상 걸릴 수 있습니다."
        )
        backgroundTask = QuestRuntime.submit(
            block = { OnDeviceQuestClient.prepare(applicationContext, settings) },
            callback = { result ->
                if (isDestroyed) return@submit
                providerSpinner.isEnabled = true
                checkModelButton.isEnabled = true
                importModelButton.isEnabled = true
                checkModelButton.text = "모델과 가속기 확인"
                result.onSuccess { prepared ->
                    setConnectionStatus(ConnectionState.SUCCESS, prepared.statusText())
                }.onFailure { error ->
                    showOnDeviceFailure(
                        error.message ?: "이 모델을 휴대폰에서 열지 못했습니다."
                    )
                }
            }
        )
    }

    private fun findNetworkModels() {
        val inputError = ConnectionGuide.connectionInputError(
            provider = currentProvider,
            rawEndpoint = endpointInput.text.toString(),
            apiKey = apiKeyInput.text.toString()
        )
        if (inputError != null) {
            showConnectionInputError(inputError)
            return
        }

        val settings = readForm()
        backgroundTask?.cancel(true)
        providerSpinner.isEnabled = false
        checkModelButton.isEnabled = false
        checkModelButton.text = "연결 확인 중..."
        setConnectionStatus(ConnectionState.CHECKING, checkingMessage())
        backgroundTask = QuestRuntime.submit(
            block = { QuestAiClient.listModels(settings) },
            callback = { result ->
                if (isDestroyed) return@submit
                providerSpinner.isEnabled = true
                checkModelButton.isEnabled = true
                checkModelButton.text = "연결 확인하고 모델 고르기"
                result.onSuccess { models ->
                    if (models.isEmpty()) {
                        val message = ConnectionGuide.emptyModelMessage(currentProvider)
                        setConnectionStatus(ConnectionState.WARNING, message)
                        showNoModelsDialog(message)
                        return@onSuccess
                    }
                    chooseModel(models)
                }.onFailure { error ->
                    val message = ConnectionGuide.explainFailure(currentProvider, error)
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
        AiProvider.OPENAI_COMPATIBLE -> "입력한 AI 서버에 연결하는 중입니다."
        AiProvider.ON_DEVICE -> "휴대폰 모델을 준비하는 중입니다."
    }

    private fun markConnectionUnchecked() {
        val message = when (currentProvider) {
            AiProvider.GEMINI -> "키를 입력한 뒤 연결 확인을 눌러 주세요."
            AiProvider.ON_DEVICE -> if (OnDeviceModelStore.existingFile(this, currentModelPath) == null) {
                "추천 모델을 받은 뒤 .litertlm 파일을 가져와 주세요."
            } else {
                "모델 파일 준비됨 · 모델과 가속기 확인을 눌러 주세요."
            }
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

    private fun pickModelFile() {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        }
        @Suppress("DEPRECATION")
        startActivityForResult(intent, REQUEST_MODEL_FILE)
    }

    private fun importOnDeviceModel(uri: Uri) {
        OnDeviceQuestClient.release()
        backgroundTask?.cancel(true)
        providerSpinner.isEnabled = false
        importModelButton.isEnabled = false
        checkModelButton.isEnabled = false
        setConnectionStatus(
            ConnectionState.CHECKING,
            "모델을 앱 안으로 가져오는 중입니다. 큰 파일은 시간이 걸릴 수 있습니다."
        )
        val profile = OnDeviceCompatibility.currentProfile()
        backgroundTask = QuestRuntime.submit(
            block = {
                OnDeviceModelStore.importModel(
                    applicationContext,
                    uri,
                    currentModelPath
                ) { fileName ->
                    OnDeviceCompatibility.compatibilityError(fileName, profile)
                }
            },
            callback = { result ->
                if (isDestroyed) return@submit
                providerSpinner.isEnabled = true
                importModelButton.isEnabled = true
                checkModelButton.isEnabled = true
                result.onSuccess { imported ->
                    currentModelPath = imported.path
                    modelInput.setText(imported.displayName)
                    updateOnDeviceModelDisplay()
                    val settings = readForm(AiProvider.ON_DEVICE)
                    drafts[AiProvider.ON_DEVICE] = settings
                    settingsStore.save(settings)
                    setConnectionStatus(
                        ConnectionState.WARNING,
                        "${imported.displayName} 가져오기 완료 · 가속기를 확인합니다."
                    )
                    prepareOnDeviceModel()
                }.onFailure { error ->
                    showOnDeviceFailure(
                        error.message ?: "모델 파일을 가져오지 못했습니다."
                    )
                }
            }
        )
    }

    private fun showModelSources() {
        val profile = OnDeviceCompatibility.currentProfile()
        val oneBLabel = if (profile.recommendedNpuFile != null) {
            "Gemma 3 1B · NPU용 파일 있음 (권장)"
        } else {
            "Gemma 3 1B · 일반 int4 (권장)"
        }
        val choices = arrayOf(
            oneBLabel,
            "Gemma 3 270M · 가장 가벼움, 정확도 낮음",
            "LiteRT-LM 전체 모델 보기"
        )
        AlertDialog.Builder(this)
            .setTitle("휴대폰용 모델 받기")
            .setItems(choices) { _, which ->
                when (which) {
                    0 -> showModelDownloadGuide(
                        title = "Gemma 3 1B 받기",
                        fileName = profile.recommendedNpuFile
                            ?: "gemma3-1b-it-int4.litertlm",
                        sizeGuide = "약 0.6GB",
                        url = GEMMA_1B_MODEL_URL
                    )
                    1 -> showModelDownloadGuide(
                        title = "Gemma 3 270M 받기",
                        fileName = OnDeviceCompatibility.recommendedGemma270MFile(profile),
                        sizeGuide = "약 0.3GB · 1B보다 문제 품질이 낮을 수 있음",
                        url = GEMMA_270M_MODEL_URL
                    )
                    else -> openUrl(LITERT_MODEL_CATALOG_URL)
                }
            }
            .setNegativeButton("닫기", null)
            .show()
    }

    private fun showModelDownloadGuide(
        title: String,
        fileName: String,
        sizeGuide: String,
        url: String
    ) {
        AlertDialog.Builder(this)
            .setTitle(title)
            .setMessage(
                "권장 파일\n$fileName\n$sizeGuide\n\n" +
                    "1. Hugging Face에 로그인하고 모델 이용 조건에 동의합니다.\n" +
                    "2. Files and versions에서 위 파일 이름을 찾습니다.\n" +
                    "3. 파일 다운로드가 끝나면 앱으로 돌아옵니다.\n" +
                    "4. '다운로드한 .litertlm 가져오기'를 누릅니다."
            )
            .setPositiveButton("모델 페이지 열기") { _, _ -> openUrl(url) }
            .setNegativeButton("닫기", null)
            .show()
    }

    private fun showOnDeviceFailure(message: String) {
        setConnectionStatus(ConnectionState.FAILURE, message)
        AlertDialog.Builder(this)
            .setTitle("휴대폰 모델을 준비하지 못했습니다")
            .setMessage(message)
            .setPositiveButton("다른 모델 가져오기") { _, _ -> pickModelFile() }
            .setNeutralButton("추천 모델 받기") { _, _ -> showModelSources() }
            .setNegativeButton("닫기", null)
            .show()
    }

    private fun showConnectionInputError(message: String) {
        setConnectionStatus(ConnectionState.FAILURE, message)
        val builder = AlertDialog.Builder(this)
            .setTitle("한 가지만 확인해 주세요")
            .setMessage(message)
            .setNegativeButton("닫기", null)
        if (currentProvider == AiProvider.GEMINI) {
            builder.setPositiveButton("개인 키 만들기") { _, _ -> openUrl(AI_STUDIO_KEY_URL) }
        }
        builder.show()
    }

    private fun showConnectionFailure(message: String) {
        val builder = AlertDialog.Builder(this)
            .setTitle("아직 연결되지 않았습니다")
            .setMessage(message)
            .setNegativeButton("닫기", null)
        if (currentProvider == AiProvider.GEMINI) {
            builder.setPositiveButton("키 다시 확인") { _, _ -> openUrl(AI_STUDIO_KEY_URL) }
        }
        builder.show()
    }

    private fun showNoModelsDialog(message: String) {
        AlertDialog.Builder(this)
            .setTitle("연결됐지만 모델이 없습니다")
            .setMessage(message)
            .setNegativeButton("닫기", null)
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

    private fun openUrl(url: String) {
        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
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
        private const val REQUEST_MODEL_FILE = 5002
        private const val AI_STUDIO_KEY_URL = "https://aistudio.google.com/app/apikey"
        private const val GEMMA_1B_MODEL_URL =
            "https://huggingface.co/litert-community/Gemma3-1B-IT/tree/main"
        private const val GEMMA_270M_MODEL_URL =
            "https://huggingface.co/litert-community/gemma-3-270m-it/tree/main"
        private const val LITERT_MODEL_CATALOG_URL =
            "https://huggingface.co/models?library=litert-lm"
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
