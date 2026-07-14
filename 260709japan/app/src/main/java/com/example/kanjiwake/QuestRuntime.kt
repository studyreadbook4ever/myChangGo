package com.example.kanjiwake

import android.os.Handler
import android.os.Looper
import java.util.concurrent.Executors
import java.util.concurrent.Future

object QuestRuntime {
    private val executor = Executors.newCachedThreadPool { task ->
        Thread(task, "per-open-quest-ai").apply { isDaemon = true }
    }
    private val mainHandler = Handler(Looper.getMainLooper())

    fun <T> submit(block: () -> T, callback: (Result<T>) -> Unit): Future<*> {
        return executor.submit {
            val result = runCatching(block)
            mainHandler.post { callback(result) }
        }
    }
}
