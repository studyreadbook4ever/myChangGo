package com.example.kanjiwake

import android.content.Context
import android.content.ClipData
import android.content.ClipboardManager
import android.graphics.PixelFormat
import android.os.Build
import android.os.CountDownTimer
import android.view.Gravity
import android.view.KeyEvent
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

class LockQuizOverlay(context: Context) {
    private val appContext = context.applicationContext
    private val repository = VocabularyRepository(appContext)
    private val windowManager = appContext.getSystemService(WindowManager::class.java)
    private val choiceButtons = mutableListOf<Button>()

    private var rootView: View? = null
    private var currentQuestion: QuizQuestion? = null
    private var lastWordId: Long? = null
    private var solved = false
    private var countdownTimer: CountDownTimer? = null
    private var choiceRevealTimer: CountDownTimer? = null

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

    val isShowing: Boolean
        get() = rootView != null

    fun show() {
        if (rootView != null) return
        val root = buildContent()
        rootView = root
        windowManager.addView(root, overlayParams())
        root.requestFocus()
        nextQuestion()
        startBypassCountdown()
    }

    fun dismiss() {
        countdownTimer?.cancel()
        countdownTimer = null
        choiceRevealTimer?.cancel()
        choiceRevealTimer = null
        val view = rootView ?: return
        rootView = null
        choiceButtons.clear()
        currentQuestion = null
        runCatching { windowManager.removeView(view) }
    }

    private fun overlayParams(): WindowManager.LayoutParams {
        return WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
        }
    }

    private fun buildContent(): View {
        val root = LinearLayout(appContext).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(KwColor.Paper)
            setPadding(appContext.dp(16), appContext.dp(14), appContext.dp(16), appContext.dp(14))
            isFocusable = true
            isFocusableInTouchMode = true
            setOnKeyListener { _, keyCode, event ->
                if (keyCode == KeyEvent.KEYCODE_BACK && event.action == KeyEvent.ACTION_UP) {
                    if (solved) dismiss() else Toast.makeText(
                        appContext,
                        "단어 문제를 맞히거나 우회 버튼이 열릴 때까지 기다려 주세요.",
                        Toast.LENGTH_SHORT
                    ).show()
                    true
                } else {
                    false
                }
            }
        }

        val topBar = LinearLayout(appContext).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        root.addView(topBar)

        topBar.addView(
            TextView(appContext).apply {
                text = "잠금 해제 퀴즈"
                kwText(sizeSp = 18f, bold = true)
            },
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        )

        topActionButton = Button(appContext).apply {
            text = "10"
            kwButton(fill = KwColor.Surface, textColor = KwColor.Plum, strokeColor = KwColor.Plum, compact = true)
            setOnClickListener { dismiss() }
        }
        topBar.addView(
            topActionButton,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        )

        val scrollView = ScrollView(appContext).apply {
            overScrollMode = View.OVER_SCROLL_IF_CONTENT_SCROLLS
        }
        val content = LinearLayout(appContext).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, appContext.dp(16), 0, appContext.dp(24))
        }
        scrollView.addView(content)
        root.addView(
            scrollView,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
        )

        val questionPanel = LinearLayout(appContext).apply {
            orientation = LinearLayout.VERTICAL
            background = appContext.rounded(KwColor.Surface, radiusDp = 8, strokeColor = KwColor.Line)
            setPadding(appContext.dp(18), appContext.dp(18), appContext.dp(18), appContext.dp(18))
        }
        content.addView(questionPanel)

        termText = TextView(appContext).apply {
            kwText(sizeSp = 38f, bold = true)
            gravity = Gravity.CENTER_HORIZONTAL
        }
        questionPanel.addView(termText)

        promptText = TextView(appContext).apply {
            text = "이 한자 단어의 뜻은?"
            kwText(sizeSp = 16f, color = KwColor.Ink, bold = true)
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(0, appContext.dp(20), 0, 0)
        }
        questionPanel.addView(promptText)

        choicesContainer = LinearLayout(appContext).apply {
            orientation = LinearLayout.VERTICAL
        }
        questionPanel.addView(
            choicesContainer,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = appContext.dp(12) }
        )

        feedbackPanel = LinearLayout(appContext).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
            background = appContext.rounded(KwColor.Surface, radiusDp = 8, strokeColor = KwColor.Line)
            setPadding(appContext.dp(18), appContext.dp(18), appContext.dp(18), appContext.dp(18))
        }
        content.addView(
            feedbackPanel,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = appContext.dp(14) }
        )

        val feedbackTitleRow = LinearLayout(appContext).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        feedbackPanel.addView(feedbackTitleRow)

        feedbackTitle = TextView(appContext).apply {
            kwText(sizeSp = 18f, bold = true)
        }
        feedbackTitleRow.addView(
            feedbackTitle,
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        )

        copyKanjiButton = Button(appContext).apply {
            text = "한자 복사하기"
            visibility = View.GONE
            kwButton(fill = KwColor.Surface, textColor = KwColor.Teal, strokeColor = KwColor.Teal, compact = true)
        }
        feedbackTitleRow.addView(
            copyKanjiButton,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { leftMargin = appContext.dp(10) }
        )

        feedbackBody = TextView(appContext).apply {
            kwText(sizeSp = 15f, color = KwColor.Muted, lineSpacingExtraDp = 4)
        }
        feedbackPanel.addView(
            feedbackBody,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = appContext.dp(8) }
        )

        feedbackExample = TextView(appContext).apply {
            kwText(sizeSp = 15f, color = KwColor.Ink, lineSpacingExtraDp = 4)
            background = appContext.rounded(KwColor.Paper, radiusDp = 8, strokeColor = KwColor.Line)
            setPadding(appContext.dp(14), appContext.dp(12), appContext.dp(14), appContext.dp(12))
        }
        feedbackPanel.addView(
            feedbackExample,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = appContext.dp(12) }
        )

        feedbackAction = Button(appContext).apply {
            kwButton(fill = KwColor.Teal, textColor = KwColor.Surface)
        }
        feedbackPanel.addView(
            feedbackAction,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = appContext.dp(14) }
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
        val countdownText = TextView(appContext).apply {
            text = CHOICE_COUNTDOWN_SECONDS.toString()
            contentDescription = "선택지 공개까지 ${CHOICE_COUNTDOWN_SECONDS}초"
            gravity = Gravity.CENTER
            kwText(sizeSp = 42f, color = KwColor.Plum, bold = true)
        }
        choicesContainer.addView(
            countdownText,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                appContext.dp(CHOICE_AREA_HEIGHT_DP)
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
                if (solved || currentQuestion?.answer?.id != question.answer.id || rootView == null) return
                showChoices(question)
            }
        }.start()
    }

    private fun showChoices(question: QuizQuestion) {
        choicesContainer.removeAllViews()
        choiceButtons.clear()
        question.choices.forEach { choice ->
            val button = Button(appContext).apply {
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
                ).apply { topMargin = appContext.dp(10) }
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
        feedbackAction.text = "잠금 해제"
        feedbackAction.setOnClickListener { dismiss() }

        countdownTimer?.cancel()
        topActionButton.text = "잠금 해제"
        topActionButton.isClickable = true
        topActionButton.kwButton(fill = KwColor.Good, textColor = KwColor.Surface, compact = true)
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
        val clipboard = appContext.getSystemService(ClipboardManager::class.java)
        clipboard.setPrimaryClip(ClipData.newPlainText("Kanji Wake word", term))
        Toast.makeText(appContext, "한자를 복사했습니다.", Toast.LENGTH_SHORT).show()
    }

    companion object {
        private const val CHOICE_COUNTDOWN_SECONDS = 3
        private const val CHOICE_REVEAL_DELAY_MS = 3_000L
        private const val CHOICE_AREA_HEIGHT_DP = 256
    }
}
