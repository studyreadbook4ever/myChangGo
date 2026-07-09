package com.example.kanjiwake

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return

        val prefs = context.getSharedPreferences(KanjiWakePrefs.NAME, Context.MODE_PRIVATE)
        val enabled = prefs.getBoolean(KanjiWakePrefs.KEY_MONITOR_ENABLED, false)
        if (enabled) {
            SoftLockService.start(context)
        }
    }
}
