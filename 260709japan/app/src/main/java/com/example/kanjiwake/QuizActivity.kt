package com.example.kanjiwake

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.CountDownTimer
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import com.example.kanjiwake.data.QuizQuestion
import com.example.kanjiwake.data.VocabularyRepository

class QuizActivity : Activity() {
    private val repository by lazy { VocabularyRepository(this) }
    private val choiceButtons = mutableListOf<Button>()
    private var currentQuestion: QuizQuestion? = null
    private var lastWordId: Long? = null
    private var mode: String = MODE_ENDLESS
    private var solved = false
    private var countdownTimer: CountDownTimer? = null
    private var choiceRevealTimer: CountDownTimer? = null

    private lateinit var modeText: TextView
    private lateinit var topActionButton: Button
    private lateinit var termText: TextView
    private lateinit var promptText: TextView
    private lateinit var choicesContainer: LinearLayout
    private lateinit var feedbackPanel: LinearLayout
    private lateinit var feedbackTitle: TextView
    private lateinit var copyKanjiButton: Button
    private lateinit var feedbackBody: TextView
    private lateinit var feedbackExample: TextView
    private lateinit var feedbackAction: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        mode = intent.getStringExtra(EXTRA_MODE) ?: MODE_ENDLESS
        configureWindow()
        setContentView(buildContent())
        nextQuestion()
        if (isLockMode()) {
            startBypassCountdown()
        }
    }

    override fun onDestroy() {
        countdownTimer?.cancel()
        choiceRevealTimer?.cancel()
        super.onDestroy()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (isLockMode() && !solved) {
            Toast.makeText(this, "단어 문제를 맞히거나 우회 버튼이 열릴 때까지 기다려 주세요.", Toast.LENGTH_SHORT).show()
            return
        }
        super.onBackPressed()
    }

    private fun configureWindow() {
        window.statusBarColor = KwColor.Paper
        window.navigationBarColor = KwColor.Paper
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
        if (isLockMode()) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                setShowWhenLocked(true)
                setTurnScreenOn(true)
            }
        }
    }

    private fun buildContent(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(KwColor.Paper)
            setPadding(dp(16), dp(14), dp(16), dp(14))
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        }

        val topBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }

        modeText = TextView(this).apply {
            text = if (isLockMode()) "잠금 해제 퀴즈" else "Endless Mode"
            kwText(sizeSp = 18f, bold = true)
        }
        topBar.addView(
            modeText,
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        )

        topActionButton = Button(this).apply {
            text = if (isLockMode()) "10" else "모드 종료"
            kwButton(
                fill = if (isLockMode()) KwColor.Surface else KwColor.Plum,
                textColor = if (isLockMode()) KwColor.Plum else KwColor.Surface,
                strokeColor = if (isLockMode()) KwColor.Plum else null,
                compact = true
            )
            setOnClickListener {
                if (isLockMode()) {
                    finish()
                } else {
                    finish()
                }
            }
        }
        topBar.addView(
            topActionButton,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        )
        root.addView(topBar)

        val scrollView = ScrollView(this).apply {
            isFillViewport = false
            overScrollMode = View.OVER_SCROLL_IF_CONTENT_SCROLLS
        }
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(16), 0, dp(24))
        }
        scrollView.addView(content)
        root.addView(
            scrollView,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
        )

        val questionPanel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = rounded(KwColor.Surface, radiusDp = 8, strokeColor = KwColor.Line)
            setPadding(dp(18), dp(18), dp(18), dp(18))
        }
        content.addView(
            questionPanel,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        )

        termText = TextView(this).apply {
            kwText(sizeSp = 38f, bold = true)
            gravity = Gravity.CENTER_HORIZONTAL
        }
        questionPanel.addView(termText)

        promptText = TextView(this).apply {
            text = "이 한자 단어의 뜻은?"
            kwText(sizeSp = 16f, color = KwColor.Ink, bold = true)
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(0, dp(20), 0, 0)
        }
        questionPanel.addView(promptText)

        choicesContainer = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        questionPanel.addView(
            choicesContainer,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(12) }
        )

        feedbackPanel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
            background = rounded(KwColor.Surface, radiusDp = 8, strokeColor = KwColor.Line)
            setPadding(dp(18), dp(18), dp(18), dp(18))
        }
        content.addView(
            feedbackPanel,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(14) }
        )

        val feedbackTitleRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        feedbackPanel.addView(feedbackTitleRow)

        feedbackTitle = TextView(this).apply {
            kwText(sizeSp = 18f, bold = true)
        }
        feedbackTitleRow.addView(
            feedbackTitle,
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        )

        copyKanjiButton = Button(this).apply {
            text = "한자 복사하기"
            visibility = View.GONE
            kwButton(fill = KwColor.Surface, textColor = KwColor.Teal, strokeColor = KwColor.Teal, compact = true)
        }
        feedbackTitleRow.addView(
            copyKanjiButton,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { leftMargin = dp(10) }
        )

        feedbackBody = TextView(this).apply {
            kwText(sizeSp = 15f, color = KwColor.Muted, lineSpacingExtraDp = 4)
        }
        feedbackPanel.addView(
            feedbackBody,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(8) }
        )

        feedbackExample = TextView(this).apply {
            kwText(sizeSp = 15f, color = KwColor.Ink, lineSpacingExtraDp = 4)
            background = rounded(KwColor.Paper, radiusDp = 8, strokeColor = KwColor.Line)
            setPadding(dp(14), dp(12), dp(14), dp(12))
        }
        feedbackPanel.addView(
            feedbackExample,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(12) }
        )

        feedbackAction = Button(this).apply {
            kwButton(fill = KwColor.Teal, textColor = KwColor.Surface)
        }
        feedbackPanel.addView(
            feedbackAction,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(14) }
        )

        return root
    }

    private fun nextQuestion() {
        solved = false
        val question = repository.nextQuestion(excludingId = lastWordId)
        currentQuestion = question
        lastWordId = question.answer.id

        termText.text = question.answer.term
        promptText.text = "이 한자 단어의 뜻은?"
        feedbackPanel.visibility = View.GONE
        copyKanjiButton.visibility = View.GONE

        choicesContainer.removeAllViews()
        choiceButtons.clear()
        startChoiceCountdown(question)
    }

    private fun startChoiceCountdown(question: QuizQuestion) {
        val countdownText = TextView(this).apply {
            text = CHOICE_COUNTDOWN_SECONDS.toString()
            contentDescription = "선택지 공개까지 ${CHOICE_COUNTDOWN_SECONDS}초"
            gravity = Gravity.CENTER
            kwText(sizeSp = 42f, color = KwColor.Plum, bold = true)
        }
        choicesContainer.addView(
            countdownText,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(CHOICE_AREA_HEIGHT_DP)
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
                if (solved || currentQuestion?.answer?.id != question.answer.id) return
                showChoices(question)
            }
        }.start()
    }

    private fun showChoices(question: QuizQuestion) {
        choicesContainer.removeAllViews()
        choiceButtons.clear()
        question.choices.forEach { choice ->
            val button = Button(this).apply {
                text = choice
                gravity = Gravity.CENTER
                kwButton(fill = KwColor.Surface, textColor = KwColor.Ink, strokeColor = KwColor.Line)
                setOnClickListener { handleChoice(this, choice) }
            }
            choiceButtons += button
            choicesContainer.addView(
                button,
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { topMargin = dp(10) }
            )
        }
    }

    private fun handleChoice(button: Button, choice: String) {
        val question = currentQuestion ?: return
        if (solved) return

        if (choice == question.answer.meaning) {
            solved = true
            choiceButtons.forEach {
                it.isClickable = false
                if (it.text == question.answer.meaning) {
                    it.kwButton(fill = KwColor.Good, textColor = KwColor.Surface)
                }
            }
            showCorrectAnswer(question)
        } else {
            button.isClickable = false
            button.kwButton(fill = KwColor.Surface, textColor = KwColor.Bad, strokeColor = KwColor.Bad)
            showWrongHint()
        }
    }

    private fun showWrongHint() {
        feedbackPanel.visibility = View.VISIBLE
        feedbackTitle.text = "아직 아니에요"
        feedbackTitle.setTextColor(KwColor.Bad)
        copyKanjiButton.visibility = View.GONE
        feedbackBody.text = "다른 선택지를 골라보세요. 틀린 답은 비활성화됩니다."
        feedbackExample.visibility = View.GONE
        feedbackAction.visibility = View.GONE
    }

    private fun showCorrectAnswer(question: QuizQuestion) {
        val answer = question.answer
        feedbackPanel.visibility = View.VISIBLE
        feedbackExample.visibility = View.VISIBLE
        feedbackAction.visibility = View.VISIBLE
        feedbackTitle.text = "정답 · ${answer.meaning}"
        feedbackTitle.setTextColor(KwColor.Good)
        copyKanjiButton.visibility = View.VISIBLE
        copyKanjiButton.setOnClickListener {
            copyKanji(answer.term)
        }
        feedbackBody.text = "${answer.term} (${answer.reading})\n${answer.detail}"
        feedbackExample.text = "例文: ${answer.example}\n뜻: ${answer.exampleMeaning}"
        feedbackAction.text = if (isLockMode()) "잠금 해제" else "다음 문제"
        feedbackAction.setOnClickListener {
            if (isLockMode()) {
                finish()
            } else {
                nextQuestion()
            }
        }

        if (isLockMode()) {
            countdownTimer?.cancel()
            topActionButton.text = "잠금 해제"
            topActionButton.isClickable = true
            topActionButton.kwButton(fill = KwColor.Good, textColor = KwColor.Surface, compact = true)
        }
    }

    private fun startBypassCountdown() {
        topActionButton.isClickable = false
        topActionButton.kwButton(
            fill = KwColor.Surface,
            textColor = KwColor.Plum,
            strokeColor = KwColor.Plum,
            compact = true
        )
        countdownTimer?.cancel()
        countdownTimer = object : CountDownTimer(11_000L, 1_000L) {
            override fun onTick(millisUntilFinished: Long) {
                val seconds = (millisUntilFinished / 1_000L).toInt().coerceIn(0, 10)
                topActionButton.text = seconds.toString()
            }

            override fun onFinish() {
                if (solved) return
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

    private fun copyKanji(term: String) {
        val clipboard = getSystemService(ClipboardManager::class.java)
        clipboard.setPrimaryClip(ClipData.newPlainText("Kanji Wake word", term))
        Toast.makeText(this, "한자를 복사했습니다.", Toast.LENGTH_SHORT).show()
    }

    private fun isLockMode(): Boolean = mode == MODE_LOCK

    companion object {
        private const val EXTRA_MODE = "mode"
        private const val CHOICE_COUNTDOWN_SECONDS = 3
        private const val CHOICE_REVEAL_DELAY_MS = 3_000L
        private const val CHOICE_AREA_HEIGHT_DP = 256
        const val MODE_ENDLESS = "endless"
        const val MODE_LOCK = "lock"

        fun createIntent(context: Context, mode: String): Intent {
            return Intent(context, QuizActivity::class.java).putExtra(EXTRA_MODE, mode)
        }
    }
}
