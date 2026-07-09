package com.example.kanjiwake

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.KeyguardManager
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.widget.Toast
import com.example.kanjiwake.data.VocabularyRepository

class SoftLockService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private var receiverRegistered = false
    private var prewarmStarted = false
    private var waitingForUnlock = false
    private var unlockPollsRemaining = 0
    private var pendingUnlockReason = "screen"
    private var lastLaunchElapsed = 0L

    private val unlockReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                Intent.ACTION_SCREEN_OFF -> {
                    waitingForUnlock = true
                    handler.removeCallbacks(unlockPollRunnable)
                }

                Intent.ACTION_SCREEN_ON -> {
                    if (waitingForUnlock || isKeyguardLocked()) {
                        scheduleUnlockCheck("screen-on")
                    }
                }

                Intent.ACTION_USER_PRESENT -> {
                    launchLockQuiz("user-present")
                }
            }
        }
    }

    private val unlockPollRunnable = object : Runnable {
        override fun run() {
            if (!waitingForUnlock && !isKeyguardLocked()) return

            if (!isKeyguardLocked()) {
                waitingForUnlock = false
                launchLockQuiz(pendingUnlockReason)
                return
            }

            unlockPollsRemaining -= 1
            if (unlockPollsRemaining > 0) {
                handler.postDelayed(this, UNLOCK_POLL_INTERVAL_MS)
            } else {
                waitingForUnlock = false
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        registerUnlockReceiver()
        prewarmVocabulary()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIFICATION_ID, buildNotification())
        prewarmVocabulary()
        return START_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacks(unlockPollRunnable)
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

    private fun scheduleUnlockCheck(reason: String) {
        waitingForUnlock = true
        pendingUnlockReason = reason
        unlockPollsRemaining = UNLOCK_POLL_ATTEMPTS
        handler.removeCallbacks(unlockPollRunnable)
        handler.postDelayed(unlockPollRunnable, UNLOCK_POLL_INITIAL_DELAY_MS)
    }

    private fun isKeyguardLocked(): Boolean {
        val keyguardManager = getSystemService(KeyguardManager::class.java)
        return keyguardManager.isKeyguardLocked
    }

    private fun launchLockQuiz(reason: String) {
        val now = SystemClock.elapsedRealtime()
        if (now - lastLaunchElapsed < LAUNCH_THROTTLE_MS) return
        lastLaunchElapsed = now
        waitingForUnlock = false
        handler.removeCallbacks(unlockPollRunnable)

        val intent = QuizActivity.createIntent(this, QuizActivity.MODE_LOCK).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }
        runCatching {
            showUnlockQuizAlert()
        }.onFailure { error ->
            Log.w(TAG, "Unlock quiz alert failed before direct launch.", error)
        }
        try {
            Log.i(TAG, "Launching lock quiz after $reason.")
            startActivity(intent)
        } catch (error: RuntimeException) {
            Log.w(TAG, "Direct quiz launch failed; full-screen notification is available.", error)
            Toast.makeText(this, "알림을 눌러 잠금 퀴즈를 열어 주세요.", Toast.LENGTH_SHORT).show()
        }
    }

    private fun showUnlockQuizAlert() {
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(UNLOCK_NOTIFICATION_ID, buildUnlockQuizNotification())
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

        return Notification.Builder(this, MONITOR_CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
            .setContentTitle("Kanji Wake 소프트 잠금")
            .setContentText("잠금 해제 뒤 일본어 한자 단어 퀴즈를 띄웁니다.")
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .build()
    }

    private fun buildUnlockQuizNotification(): Notification {
        val openQuizIntent = QuizActivity.createIntent(this, QuizActivity.MODE_LOCK).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }
        val pendingIntent = PendingIntent.getActivity(
            this,
            42,
            openQuizIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return Notification.Builder(this, ALERT_CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
            .setContentTitle("Kanji Wake 잠금 퀴즈")
            .setContentText("한자 단어 뜻을 맞혀 잠금을 해제하세요.")
            .setCategory(Notification.CATEGORY_ALARM)
            .setPriority(Notification.PRIORITY_MAX)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setContentIntent(pendingIntent)
            .setFullScreenIntent(pendingIntent, true)
            .setAutoCancel(true)
            .build()
    }

    private fun createNotificationChannel() {
        val manager = getSystemService(NotificationManager::class.java)
        val monitorChannel = NotificationChannel(
            MONITOR_CHANNEL_ID,
            getString(R.string.soft_lock_channel_name),
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = getString(R.string.soft_lock_channel_description)
            setShowBadge(false)
        }
        val alertChannel = NotificationChannel(
            ALERT_CHANNEL_ID,
            getString(R.string.soft_lock_alert_channel_name),
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = getString(R.string.soft_lock_alert_channel_description)
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            setShowBadge(false)
        }
        manager.createNotificationChannel(monitorChannel)
        manager.createNotificationChannel(alertChannel)
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

    companion object {
        private const val TAG = "SoftLockService"
        private const val MONITOR_CHANNEL_ID = "kanji_wake_soft_lock"
        private const val ALERT_CHANNEL_ID = "kanji_wake_unlock_alerts_v2"
        private const val NOTIFICATION_ID = 913
        private const val UNLOCK_NOTIFICATION_ID = 914
        private const val UNLOCK_POLL_INITIAL_DELAY_MS = 350L
        private const val UNLOCK_POLL_INTERVAL_MS = 500L
        private const val UNLOCK_POLL_ATTEMPTS = 24
        private const val LAUNCH_THROTTLE_MS = 5_000L

        fun start(context: Context) {
            val intent = Intent(context, SoftLockService::class.java)
            context.startForegroundService(intent)
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, SoftLockService::class.java))
        }

        fun dismissUnlockAlert(context: Context) {
            val manager = context.getSystemService(NotificationManager::class.java)
            manager.cancel(UNLOCK_NOTIFICATION_ID)
        }
    }
}
