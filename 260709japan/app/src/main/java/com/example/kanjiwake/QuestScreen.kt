package com.example.kanjiwake

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.CountDownTimer
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import java.util.concurrent.Future

@SuppressLint("ViewConstructor")
class QuestScreen(
    context: Context,
    private val lockMode: Boolean,
    private val onExit: () -> Unit
) : LinearLayout(context) {
    private val settingsStore = QuestSettingsStore(context)
    private val choiceButtons = mutableListOf<Button>()

    private var currentQuest: GeneratedQuest? = null
    private var previousQuestion: String? = null
    private var solved = false
    private var canDismissLock = false
    private var started = false
    private var disposed = false
    private var generationId = 0L
    private var generationTask: Future<*>? = null
    private var bypassTimer: CountDownTimer? = null
    private var choiceRevealTimer: CountDownTimer? = null

    private lateinit var topActionButton: Button
    private lateinit var questionText: TextView
    private lateinit var generationStatus: TextView
    private lateinit var progressBar: ProgressBar
    private lateinit var choicesContainer: LinearLayout
    private lateinit var feedbackPanel: LinearLayout
    private lateinit var feedbackTitle: TextView
    private lateinit var copyAnswerButton: Button
    private lateinit var feedbackBody: TextView
    private lateinit var feedbackAction: Button

    init {
        buildContent()
    }

    fun start() {
        if (started || disposed) return
        started = true
        previousQuestion = settingsStore.lastQuestion()
        if (lockMode) startBypassCountdown()
        nextQuest()
    }

    fun dispose() {
        if (disposed) return
        disposed = true
        generationId += 1L
        generationTask?.cancel(true)
        bypassTimer?.cancel()
        choiceRevealTimer?.cancel()
        choiceButtons.clear()
    }

    fun handleBack(): Boolean {
        if (!lockMode || canDismissLock) return false
        Toast.makeText(
            context,
            "퀘스트를 풀거나 우회 버튼이 열릴 때까지 기다려 주세요.",
            Toast.LENGTH_SHORT
        ).show()
        return true
    }

    private fun buildContent() {
        orientation = VERTICAL
        setBackgroundColor(KwColor.Paper)
        setPadding(context.dp(16), context.dp(14), context.dp(16), context.dp(14))
        layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        )

        val topBar = LinearLayout(context).apply {
            orientation = HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        topBar.addView(
            TextView(context).apply {
                text = if (lockMode) "Per-Open Quest" else "Endless Mode"
                kwText(sizeSp = 18f, bold = true)
            },
            LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        )
        topActionButton = Button(context).apply {
            text = if (lockMode) "10" else "모드 종료"
            kwButton(
                fill = if (lockMode) KwColor.Surface else KwColor.Plum,
                textColor = if (lockMode) KwColor.Plum else KwColor.Surface,
                strokeColor = if (lockMode) KwColor.Plum else null,
                compact = true
            )
            setOnClickListener { onExit() }
        }
        topBar.addView(topActionButton)
        addView(topBar)

        val scrollView = ScrollView(context).apply {
            overScrollMode = View.OVER_SCROLL_IF_CONTENT_SCROLLS
        }
        val content = LinearLayout(context).apply {
            orientation = VERTICAL
            setPadding(0, context.dp(16), 0, context.dp(24))
        }
        scrollView.addView(content)
        addView(scrollView, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))

        val questionPanel = LinearLayout(context).apply {
            orientation = VERTICAL
            background = context.rounded(KwColor.Surface, radiusDp = 8, strokeColor = KwColor.Line)
            setPadding(context.dp(18), context.dp(18), context.dp(18), context.dp(18))
        }
        content.addView(questionPanel, matchWidth())

        progressBar = ProgressBar(context).apply { isIndeterminate = true }
        questionPanel.addView(
            progressBar,
            LayoutParams(context.dp(34), context.dp(34)).apply { gravity = Gravity.CENTER_HORIZONTAL }
        )

        questionText = TextView(context).apply {
            text = "새 퀘스트를 만드는 중"
            kwText(sizeSp = 26f, bold = true, lineSpacingExtraDp = 4)
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(0, context.dp(14), 0, 0)
        }
        questionPanel.addView(questionText)

        generationStatus = TextView(context).apply {
            kwText(sizeSp = 14f, color = KwColor.Muted, lineSpacingExtraDp = 3)
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(0, context.dp(8), 0, 0)
        }
        questionPanel.addView(generationStatus)

        choicesContainer = LinearLayout(context).apply { orientation = VERTICAL }
        questionPanel.addView(choicesContainer, matchWidth(top = 12))

        feedbackPanel = LinearLayout(context).apply {
            orientation = VERTICAL
            visibility = View.GONE
            background = context.rounded(KwColor.Surface, radiusDp = 8, strokeColor = KwColor.Line)
            setPadding(context.dp(18), context.dp(18), context.dp(18), context.dp(18))
        }
        content.addView(feedbackPanel, matchWidth(top = 14))

        val feedbackTitleRow = LinearLayout(context).apply {
            orientation = HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        feedbackPanel.addView(feedbackTitleRow)
        feedbackTitle = TextView(context).apply { kwText(sizeSp = 18f, bold = true) }
        feedbackTitleRow.addView(
            feedbackTitle,
            LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        )
        copyAnswerButton = Button(context).apply {
            text = "정답 복사"
            visibility = View.GONE
            kwButton(
                fill = KwColor.Surface,
                textColor = KwColor.Teal,
                strokeColor = KwColor.Teal,
                compact = true
            )
        }
        feedbackTitleRow.addView(
            copyAnswerButton,
            LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { leftMargin = context.dp(8) }
        )

        feedbackBody = TextView(context).apply {
            kwText(sizeSp = 15f, color = KwColor.Ink, lineSpacingExtraDp = 4)
        }
        feedbackPanel.addView(feedbackBody, matchWidth(top = 10))
        feedbackAction = Button(context).apply {
            kwButton(fill = KwColor.Teal, textColor = KwColor.Surface)
        }
        feedbackPanel.addView(feedbackAction, matchWidth(top = 14))
    }

    private fun nextQuest() {
        val settings = settingsStore.loadActive()
        settings.validationError()?.let {
            showGenerationError(it)
            return
        }

        generationId += 1L
        val requestId = generationId
        generationTask?.cancel(true)
        choiceRevealTimer?.cancel()
        solved = false
        currentQuest = null
        choiceButtons.clear()
        choicesContainer.removeAllViews()
        feedbackPanel.visibility = View.GONE
        copyAnswerButton.visibility = View.GONE
        progressBar.visibility = View.VISIBLE
        questionText.text = "새 퀘스트를 만드는 중"
        questionText.gravity = Gravity.CENTER_HORIZONTAL
        generationStatus.visibility = View.VISIBLE
        generationStatus.text = "${settings.provider.displayName} · ${settings.model}"

        generationTask = QuestRuntime.submit(
            block = { QuestAiClient.generate(settings, previousQuestion) },
            callback = { result ->
                if (disposed || requestId != generationId) return@submit
                result.onSuccess(::showQuest).onFailure {
                    showGenerationError(it.message ?: "AI가 문제를 만들지 못했습니다.")
                }
            }
        )
    }

    private fun showQuest(quest: GeneratedQuest) {
        currentQuest = quest
        previousQuestion = quest.question
        settingsStore.rememberQuestion(quest.question)
        progressBar.visibility = View.GONE
        questionText.text = quest.question
        questionText.gravity = Gravity.START
        generationStatus.visibility = View.GONE
        startChoiceCountdown(quest)
    }

    private fun startChoiceCountdown(quest: GeneratedQuest) {
        choicesContainer.removeAllViews()
        val countdownText = TextView(context).apply {
            text = CHOICE_COUNTDOWN_SECONDS.toString()
            contentDescription = "선택지 공개까지 ${CHOICE_COUNTDOWN_SECONDS}초"
            gravity = Gravity.CENTER
            kwText(sizeSp = 42f, color = KwColor.Plum, bold = true)
        }
        choicesContainer.addView(
            countdownText,
            LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                context.dp(CHOICE_AREA_HEIGHT_DP)
            )
        )

        choiceRevealTimer?.cancel()
        choiceRevealTimer = object : CountDownTimer(CHOICE_REVEAL_DELAY_MS, 1_000L) {
            override fun onTick(millisUntilFinished: Long) {
                val seconds = ((millisUntilFinished + 999L) / 1_000L)
                    .toInt()
                    .coerceIn(1, CHOICE_COUNTDOWN_SECONDS)
                countdownText.text = seconds.toString()
                countdownText.contentDescription = "선택지 공개까지 ${seconds}초"
            }

            override fun onFinish() {
                choiceRevealTimer = null
                if (disposed || solved || currentQuest !== quest) return
                showChoices(quest)
            }
        }.start()
    }

    private fun showChoices(quest: GeneratedQuest) {
        choicesContainer.removeAllViews()
        choiceButtons.clear()
        quest.choices.forEach { choice ->
            val button = Button(context).apply {
                text = choice
                gravity = Gravity.CENTER
                kwButton(fill = KwColor.Surface, textColor = KwColor.Ink, strokeColor = KwColor.Line)
                setOnClickListener { handleChoice(this, choice) }
            }
            choiceButtons += button
            choicesContainer.addView(button, matchWidth(top = 10))
        }
    }

    private fun handleChoice(button: Button, choice: String) {
        val quest = currentQuest ?: return
        if (solved) return

        if (choice == quest.answer) {
            solved = true
            choiceButtons.forEach {
                it.isClickable = false
                if (it.text == quest.answer) {
                    it.kwButton(fill = KwColor.Good, textColor = KwColor.Surface)
                }
            }
            showCorrectAnswer(quest)
        } else {
            button.isClickable = false
            button.kwButton(fill = KwColor.Surface, textColor = KwColor.Bad, strokeColor = KwColor.Bad)
            showWrongHint()
        }
    }

    private fun showWrongHint() {
        feedbackPanel.visibility = View.VISIBLE
        feedbackTitle.text = "다시 생각해보세요"
        feedbackTitle.setTextColor(KwColor.Bad)
        copyAnswerButton.visibility = View.GONE
        feedbackBody.text = "선택한 답은 정답이 아닙니다."
        feedbackAction.visibility = View.GONE
    }

    private fun showCorrectAnswer(quest: GeneratedQuest) {
        feedbackPanel.visibility = View.VISIBLE
        feedbackTitle.text = "정답 · ${quest.answer}"
        feedbackTitle.setTextColor(KwColor.Good)
        feedbackBody.text = quest.explanation
        copyAnswerButton.visibility = View.VISIBLE
        copyAnswerButton.setOnClickListener { copyAnswer(quest.answer) }
        feedbackAction.visibility = View.VISIBLE
        feedbackAction.text = if (lockMode) "잠금 해제" else "다음 문제"
        feedbackAction.setOnClickListener {
            if (lockMode) onExit() else nextQuest()
        }

        if (lockMode) {
            canDismissLock = true
            bypassTimer?.cancel()
            topActionButton.text = "잠금 해제"
            topActionButton.isClickable = true
            topActionButton.kwButton(fill = KwColor.Good, textColor = KwColor.Surface, compact = true)
        }
    }

    private fun showGenerationError(message: String) {
        progressBar.visibility = View.GONE
        choicesContainer.removeAllViews()
        questionText.text = "퀘스트를 만들지 못했습니다"
        questionText.gravity = Gravity.CENTER_HORIZONTAL
        generationStatus.visibility = View.VISIBLE
        generationStatus.text = message
        feedbackPanel.visibility = View.VISIBLE
        feedbackTitle.text = "AI 연결 확인"
        feedbackTitle.setTextColor(KwColor.Bad)
        feedbackBody.text = message
        copyAnswerButton.visibility = View.GONE
        feedbackAction.visibility = View.VISIBLE
        feedbackAction.text = if (lockMode) "잠금 해제" else "다시 시도"
        feedbackAction.setOnClickListener {
            if (lockMode) onExit() else nextQuest()
        }

        if (lockMode) {
            canDismissLock = true
            bypassTimer?.cancel()
            topActionButton.text = "잠금 해제"
            topActionButton.isClickable = true
            topActionButton.kwButton(fill = KwColor.Bad, textColor = KwColor.Surface, compact = true)
        }
    }

    private fun startBypassCountdown() {
        canDismissLock = false
        topActionButton.isClickable = false
        topActionButton.kwButton(
            fill = KwColor.Surface,
            textColor = KwColor.Plum,
            strokeColor = KwColor.Plum,
            compact = true
        )
        bypassTimer?.cancel()
        bypassTimer = object : CountDownTimer(11_000L, 1_000L) {
            override fun onTick(millisUntilFinished: Long) {
                topActionButton.text = (millisUntilFinished / 1_000L)
                    .toInt()
                    .coerceIn(0, 10)
                    .toString()
            }

            override fun onFinish() {
                if (solved || disposed) return
                canDismissLock = true
                topActionButton.text = "광고 보고 잠금해제"
                topActionButton.isClickable = true
                topActionButton.kwButton(
                    fill = KwColor.Surface,
                    textColor = KwColor.Plum,
                    strokeColor = KwColor.Plum,
                    compact = true
                )
            }
        }.start()
    }

    private fun copyAnswer(answer: String) {
        val clipboard = context.getSystemService(ClipboardManager::class.java)
        clipboard.setPrimaryClip(ClipData.newPlainText("Per-Open Quest answer", answer))
        Toast.makeText(context, "정답을 복사했습니다.", Toast.LENGTH_SHORT).show()
    }

    private fun matchWidth(top: Int = 0): LayoutParams = LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT
    ).apply { topMargin = context.dp(top) }

    companion object {
        private const val CHOICE_COUNTDOWN_SECONDS = 3
        private const val CHOICE_REVEAL_DELAY_MS = 3_000L
        private const val CHOICE_AREA_HEIGHT_DP = 256
    }
}
