package com.example.kanjiwake

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val shouldStart = intent.action == Intent.ACTION_BOOT_COMPLETED ||
            intent.action == Intent.ACTION_MY_PACKAGE_REPLACED
        if (!shouldStart) return

        val prefs = context.getSharedPreferences(PerOpenQuestPrefs.NAME, Context.MODE_PRIVATE)
        val enabled = prefs.getBoolean(PerOpenQuestPrefs.KEY_MONITOR_ENABLED, false)
        if (enabled) {
            SoftLockService.start(context)
        }
    }
}
