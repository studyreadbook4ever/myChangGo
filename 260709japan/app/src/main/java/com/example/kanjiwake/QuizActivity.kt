package com.example.kanjiwake

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowManager

class QuizActivity : Activity() {
    private lateinit var questScreen: QuestScreen

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val mode = intent.getStringExtra(EXTRA_MODE) ?: MODE_ENDLESS
        val lockMode = mode == MODE_LOCK
        configureWindow(lockMode)
        questScreen = QuestScreen(this, lockMode, onExit = ::finish)
        setContentView(questScreen)
        questScreen.start()
    }

    override fun onDestroy() {
        if (::questScreen.isInitialized) questScreen.dispose()
        super.onDestroy()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (::questScreen.isInitialized && questScreen.handleBack()) return
        super.onBackPressed()
    }

    private fun configureWindow(lockMode: Boolean) {
        window.statusBarColor = KwColor.Paper
        window.navigationBarColor = KwColor.Paper
        @Suppress("DEPRECATION")
        run { window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR }
        if (lockMode) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                setShowWhenLocked(true)
                setTurnScreenOn(true)
            }
        }
    }

    companion object {
        private const val EXTRA_MODE = "mode"
        const val MODE_ENDLESS = "endless"
        const val MODE_LOCK = "lock"

        fun createIntent(context: Context, mode: String): Intent =
            Intent(context, QuizActivity::class.java).putExtra(EXTRA_MODE, mode)
    }
}
