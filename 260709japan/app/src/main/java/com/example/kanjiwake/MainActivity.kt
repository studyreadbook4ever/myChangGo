package com.example.kanjiwake

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import com.example.kanjiwake.data.VocabularyRepository

class MainActivity : Activity() {
    private lateinit var statusText: TextView
    private lateinit var monitorButton: Button
    private var pendingMonitorEnable = false
    private val prefs by lazy { getSharedPreferences(KanjiWakePrefs.NAME, MODE_PRIVATE) }
    private val repository by lazy { VocabularyRepository(this) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = KwColor.Paper
        window.navigationBarColor = KwColor.Paper
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
        setContentView(buildContent())
    }

    override fun onResume() {
        super.onResume()
        updateMonitorState()
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_NOTIFICATIONS && pendingMonitorEnable) {
            pendingMonitorEnable = false
            if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
                setMonitorEnabled(true)
            } else {
                Toast.makeText(this, "알림 권한이 없으면 잠금 후 자동 퀴즈가 안정적으로 유지되지 않습니다.", Toast.LENGTH_LONG).show()
                updateMonitorState()
            }
        }
    }

    private fun buildContent(): View {
        val scrollView = ScrollView(this).apply {
            isFillViewport = true
            setBackgroundColor(KwColor.Paper)
        }

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(22), dp(28), dp(22), dp(28))
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        }

        val title = TextView(this).apply {
            text = "Kanji Wake"
            kwText(sizeSp = 32f, bold = true)
        }
        root.addView(title)

        val subtitle = TextView(this).apply {
            text = "한자 단어 뜻을 맞춰야 지나갈 수 있는 일본어 퀴즈 잠금 앱"
            kwText(sizeSp = 16f, color = KwColor.Muted, lineSpacingExtraDp = 3)
        }
        root.addView(subtitle)

        val count = repository.wordCount()
        val countText = TextView(this).apply {
            text = "현재 로컬 DB 단어 $count 개 · 명사와 동사구를 같은 확률로 랜덤 출제"
            kwText(sizeSp = 14f, color = KwColor.Plum, bold = true)
            background = rounded(KwColor.Surface, radiusDp = 8, strokeColor = KwColor.Line)
            setPadding(dp(14), dp(10), dp(14), dp(10))
        }
        root.addView(
            countText,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(18) }
        )

        val primaryPanel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = rounded(KwColor.Surface, radiusDp = 8, strokeColor = KwColor.Line)
            setPadding(dp(16), dp(16), dp(16), dp(16))
        }
        root.addView(
            primaryPanel,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(16) }
        )

        primaryPanel.addView(sectionTitle("학습"))
        primaryPanel.addView(primaryButton("Endless Mode").apply {
            setOnClickListener {
                startActivity(QuizActivity.createIntent(this@MainActivity, QuizActivity.MODE_ENDLESS))
            }
        })

        primaryPanel.addView(secondaryButton("잠금 퀴즈 테스트").apply {
            setOnClickListener {
                startActivity(QuizActivity.createIntent(this@MainActivity, QuizActivity.MODE_LOCK))
            }
        }, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(10) })

        val monitorPanel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = rounded(KwColor.Surface, radiusDp = 8, strokeColor = KwColor.Line)
            setPadding(dp(16), dp(16), dp(16), dp(16))
        }
        root.addView(
            monitorPanel,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(14) }
        )

        monitorPanel.addView(sectionTitle("소프트 잠금"))
        statusText = TextView(this).apply {
            kwText(sizeSp = 15f, color = KwColor.Muted, lineSpacingExtraDp = 3)
        }
        monitorPanel.addView(statusText)

        monitorButton = primaryButton("")
        monitorPanel.addView(
            monitorButton,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(12) }
        )
        monitorButton.setOnClickListener {
            val nextEnabled = !isMonitorEnabled()
            if (nextEnabled) {
                enableMonitorWithPermissionCheck()
            } else {
                setMonitorEnabled(false)
            }
        }

        val note = TextView(this).apply {
            text = "이 버전은 Android 정책 안에서 동작하는 소프트 잠금입니다. 모니터가 켜져 있으면 휴대폰 잠금 해제 이벤트 뒤 퀴즈 화면을 띄우고, 문제를 맞히면 설명과 예문을 보여줍니다."
            kwText(sizeSp = 14f, color = KwColor.Muted, lineSpacingExtraDp = 3)
        }
        root.addView(
            note,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(18) }
        )

        scrollView.addView(root)
        updateMonitorState()
        return scrollView
    }

    private fun sectionTitle(textValue: String): TextView {
        return TextView(this).apply {
            text = textValue
            kwText(sizeSp = 15f, color = KwColor.Muted, bold = true)
            setPadding(0, 0, 0, dp(10))
        }
    }

    private fun primaryButton(textValue: String): Button {
        return Button(this).apply {
            text = textValue
            gravity = Gravity.CENTER
            kwButton(fill = KwColor.Teal, textColor = KwColor.Surface)
        }
    }

    private fun secondaryButton(textValue: String): Button {
        return Button(this).apply {
            text = textValue
            gravity = Gravity.CENTER
            kwButton(fill = KwColor.Surface, textColor = KwColor.Ink, strokeColor = KwColor.Line)
        }
    }

    private fun isMonitorEnabled(): Boolean =
        prefs.getBoolean(KanjiWakePrefs.KEY_MONITOR_ENABLED, false)

    private fun enableMonitorWithPermissionCheck() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            pendingMonitorEnable = true
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFICATIONS)
            return
        }
        setMonitorEnabled(true)
    }

    private fun setMonitorEnabled(enabled: Boolean) {
        prefs.edit().putBoolean(KanjiWakePrefs.KEY_MONITOR_ENABLED, enabled).apply()
        if (enabled) {
            SoftLockService.start(this)
            Toast.makeText(this, "잠금 후 자동 퀴즈를 켰습니다.", Toast.LENGTH_SHORT).show()
        } else {
            SoftLockService.stop(this)
            Toast.makeText(this, "잠금 후 자동 퀴즈를 껐습니다.", Toast.LENGTH_SHORT).show()
        }
        updateMonitorState()
    }

    private fun updateMonitorState() {
        if (!::statusText.isInitialized || !::monitorButton.isInitialized) return
        val enabled = isMonitorEnabled()
        statusText.text = if (enabled) {
            "상태: 켜짐. 잠금 해제 뒤 일본어 한자 단어 퀴즈가 뜹니다."
        } else {
            "상태: 꺼짐. 테스트 버튼으로 퀴즈 잠금 화면을 먼저 확인할 수 있습니다."
        }
        monitorButton.text = if (enabled) "잠금 후 퀴즈 끄기" else "잠금 후 퀴즈 켜기"
        monitorButton.kwButton(
            fill = if (enabled) KwColor.Plum else KwColor.Teal,
            textColor = KwColor.Surface
        )
    }

    companion object {
        private const val REQUEST_NOTIFICATIONS = 2031
    }
}
