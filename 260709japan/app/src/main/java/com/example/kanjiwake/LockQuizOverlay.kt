package com.example.kanjiwake

import android.content.Context
import android.graphics.PixelFormat
import android.os.Build
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager

class LockQuizOverlay(context: Context) {
    private val appContext = context.applicationContext
    private val windowManager = appContext.getSystemService(WindowManager::class.java)
    private var questScreen: QuestScreen? = null

    val isShowing: Boolean
        get() = questScreen != null

    fun show() {
        if (questScreen != null) return
        val screen = QuestScreen(appContext, lockMode = true, onExit = ::dismiss).apply {
            isFocusable = true
            isFocusableInTouchMode = true
            setOnKeyListener { _, keyCode, event ->
                if (keyCode != KeyEvent.KEYCODE_BACK || event.action != KeyEvent.ACTION_UP) {
                    return@setOnKeyListener false
                }
                if (!handleBack()) dismiss()
                true
            }
        }
        questScreen = screen
        windowManager.addView(screen, overlayParams())
        screen.requestFocus()
        screen.start()
    }

    fun dismiss() {
        val screen = questScreen ?: return
        questScreen = null
        screen.dispose()
        runCatching { windowManager.removeView(screen) }
    }

    private fun overlayParams(): WindowManager.LayoutParams = WindowManager.LayoutParams(
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
