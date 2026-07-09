package com.example.kanjiwake

import android.app.Notification
import android.app.NotificationChannel
import android.app.KeyguardManager
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import android.widget.Toast
import com.example.kanjiwake.data.VocabularyRepository

class SoftLockService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private var receiverRegistered = false
    private var prewarmStarted = false
    private var waitingForUnlock = false
    private var unlockCycle = 0L
    private var shownCycle = -1L
    private var overlay: LockQuizOverlay? = null

    private val unlockReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                Intent.ACTION_SCREEN_OFF -> {
                    unlockCycle += 1L
                    waitingForUnlock = true
                    handler.removeCallbacks(unlockPollRunnable)
                }

                Intent.ACTION_SCREEN_ON -> {
                    if (waitingForUnlock || isKeyguardLocked()) {
                        scheduleUnlockPoll()
                    }
                }

                Intent.ACTION_USER_PRESENT -> {
                    if (!waitingForUnlock) {
                        unlockCycle += 1L
                    }
                    showLockQuiz("user-present")
                }
            }
        }
    }

    private val unlockPollRunnable = object : Runnable {
        override fun run() {
            if (!waitingForUnlock) return

            if (isDeviceInteractive() && !isKeyguardLocked()) {
                showLockQuiz("keyguard-poll")
                return
            }

            handler.postDelayed(this, UNLOCK_POLL_INTERVAL_MS)
        }
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        registerUnlockReceiver()
        prewarmVocabulary()
        if (isKeyguardLocked()) {
            waitingForUnlock = true
            scheduleUnlockPoll()
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIFICATION_ID, buildNotification())
        prewarmVocabulary()
        if (intent?.action == ACTION_SHOW_LOCK_NOW) {
            unlockCycle += 1L
            waitingForUnlock = true
            showLockQuiz("manual-test")
        }
        return START_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacks(unlockPollRunnable)
        overlay?.dismiss()
        overlay = null
        if (receiverRegistered) {
            unregisterReceiver(unlockReceiver)
            receiverRegistered = false
        }
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun registerUnlockReceiver() {
        if (receiverRegistered) return
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_USER_PRESENT)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(unlockReceiver, filter, RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(unlockReceiver, filter)
        }
        receiverRegistered = true
    }

    private fun scheduleUnlockPoll() {
        handler.removeCallbacks(unlockPollRunnable)
        handler.postDelayed(unlockPollRunnable, UNLOCK_POLL_INITIAL_DELAY_MS)
    }

    private fun showLockQuiz(reason: String) {
        if (shownCycle == unlockCycle && overlay?.isShowing == true) return
        waitingForUnlock = false
        shownCycle = unlockCycle
        handler.removeCallbacks(unlockPollRunnable)

        if (Settings.canDrawOverlays(this)) {
            runCatching {
                val currentOverlay = overlay ?: LockQuizOverlay(this).also { overlay = it }
                currentOverlay.show()
                Log.i(TAG, "Lock quiz overlay shown after $reason.")
            }.onFailure { error ->
                Log.w(TAG, "Overlay lock quiz failed; falling back to activity.", error)
                launchLockQuizActivity()
            }
        } else {
            Toast.makeText(this, "Kanji Wake에 다른 앱 위에 표시 권한을 허용해 주세요.", Toast.LENGTH_LONG).show()
            launchLockQuizActivity()
        }
    }

    private fun launchLockQuizActivity() {
        val intent = QuizActivity.createIntent(this, QuizActivity.MODE_LOCK).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }
        try {
            startActivity(intent)
        } catch (error: RuntimeException) {
            Log.w(TAG, "Fallback activity launch failed.", error)
            Toast.makeText(this, "알림을 눌러 잠금 퀴즈를 열어 주세요.", Toast.LENGTH_SHORT).show()
        }
    }

    private fun isKeyguardLocked(): Boolean {
        val keyguardManager = getSystemService(KeyguardManager::class.java)
        return keyguardManager.isKeyguardLocked
    }

    private fun isDeviceInteractive(): Boolean {
        val powerManager = getSystemService(PowerManager::class.java)
        return powerManager.isInteractive
    }

    private fun prewarmVocabulary() {
        if (prewarmStarted) return
        prewarmStarted = true
        Thread {
            runCatching {
                VocabularyRepository(this).wordCount()
            }.onFailure { error ->
                Log.w(TAG, "Vocabulary prewarm failed.", error)
            }
        }.start()
    }

    private fun buildNotification(): Notification {
        val openQuizIntent = QuizActivity.createIntent(this, QuizActivity.MODE_LOCK).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }
        val pendingIntent = PendingIntent.getActivity(
            this,
            41,
            openQuizIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
            .setContentTitle("Kanji Wake 소프트 잠금")
            .setContentText("잠금 해제 뒤 일본어 한자 단어 퀴즈를 띄웁니다.")
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .build()
    }

    private fun createNotificationChannel() {
        val manager = getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.soft_lock_channel_name),
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = getString(R.string.soft_lock_channel_description)
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    companion object {
        private const val TAG = "SoftLockService"
        private const val CHANNEL_ID = "kanji_wake_soft_lock"
        private const val NOTIFICATION_ID = 913
        private const val ACTION_SHOW_LOCK_NOW = "com.example.kanjiwake.SHOW_LOCK_NOW"
        private const val UNLOCK_POLL_INITIAL_DELAY_MS = 250L
        private const val UNLOCK_POLL_INTERVAL_MS = 350L

        fun start(context: Context) {
            val intent = Intent(context, SoftLockService::class.java)
            context.startForegroundService(intent)
        }

        fun showLockNow(context: Context) {
            val intent = Intent(context, SoftLockService::class.java).apply {
                action = ACTION_SHOW_LOCK_NOW
            }
            context.startForegroundService(intent)
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, SoftLockService::class.java))
        }
    }
}
