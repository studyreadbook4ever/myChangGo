package com.example.kanjiwake

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class QuestSettingsStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(
        PerOpenQuestPrefs.NAME,
        Context.MODE_PRIVATE
    )
    private val secrets = SecretStore(context.applicationContext)

    fun activeProvider(): AiProvider =
        AiProvider.fromStorage(prefs.getString(KEY_PROVIDER, null))

    fun lastQuestion(): String? = prefs.getString(KEY_LAST_QUESTION, null)

    fun rememberQuestion(question: String) {
        prefs.edit().putString(KEY_LAST_QUESTION, question).apply()
    }

    fun loadActive(): QuestSettings = load(activeProvider())

    fun localRunner(): LocalRunner {
        val stored = prefs.getString(KEY_LOCAL_RUNNER, null)
        if (stored != null) return LocalRunner.fromStorage(stored)
        val endpoint = prefs.getString(
            "${AiProvider.LOCAL_SERVER.storageValue}_endpoint",
            ""
        ).orEmpty()
        return LocalRunner.fromEndpoint(endpoint)
    }

    fun load(provider: AiProvider): QuestSettings {
        val prefix = provider.storageValue
        return QuestSettings(
            provider = provider,
            endpoint = prefs.getString("${prefix}_endpoint", defaultEndpoint(provider)).orEmpty(),
            model = prefs.getString("${prefix}_model", defaultModel(provider)).orEmpty(),
            apiKey = secrets.read("${prefix}_api_key"),
            questPrompt = prefs.getString(
                KEY_QUEST_PROMPT,
                PerOpenQuestPrefs.DEFAULT_QUEST_PROMPT
            ).orEmpty()
        )
    }

    fun save(settings: QuestSettings) {
        val prefix = settings.provider.storageValue
        prefs.edit()
            .putString(KEY_PROVIDER, settings.provider.storageValue)
            .putString("${prefix}_endpoint", settings.endpoint.trim())
            .putString("${prefix}_model", settings.model.trim())
            .putString(KEY_QUEST_PROMPT, settings.questPrompt.trim())
            .apply()
        secrets.write("${prefix}_api_key", settings.apiKey.trim())
    }

    fun saveLocalRunner(runner: LocalRunner) {
        prefs.edit().putString(KEY_LOCAL_RUNNER, runner.storageValue).apply()
    }

    companion object {
        private const val KEY_PROVIDER = "ai_provider"
        private const val KEY_QUEST_PROMPT = "quest_prompt"
        private const val KEY_LAST_QUESTION = "last_generated_question"
        private const val KEY_LOCAL_RUNNER = "local_runner"

        fun defaultEndpoint(provider: AiProvider): String = when (provider) {
            AiProvider.GEMINI -> "https://generativelanguage.googleapis.com/v1beta"
            AiProvider.LOCAL_SERVER -> ""
            AiProvider.OPENAI_COMPATIBLE -> ""
        }

        fun defaultModel(provider: AiProvider): String = when (provider) {
            AiProvider.GEMINI -> "gemini-2.5-flash"
            AiProvider.LOCAL_SERVER -> LocalRunner.OLLAMA.defaultModel
            AiProvider.OPENAI_COMPATIBLE -> ""
        }
    }
}

private class SecretStore(context: Context) {
    private val prefs = context.getSharedPreferences(PerOpenQuestPrefs.NAME, Context.MODE_PRIVATE)

    fun write(name: String, value: String) {
        if (value.isBlank()) {
            prefs.edit().remove(cipherKey(name)).remove(ivKey(name)).apply()
            return
        }

        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        val encrypted = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        prefs.edit()
            .putString(cipherKey(name), Base64.encodeToString(encrypted, Base64.NO_WRAP))
            .putString(ivKey(name), Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .apply()
    }

    fun read(name: String): String {
        val encryptedText = prefs.getString(cipherKey(name), null) ?: return ""
        val ivText = prefs.getString(ivKey(name), null) ?: return ""
        return runCatching {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            val iv = Base64.decode(ivText, Base64.NO_WRAP)
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(128, iv))
            val encrypted = Base64.decode(encryptedText, Base64.NO_WRAP)
            String(cipher.doFinal(encrypted), Charsets.UTF_8)
        }.getOrElse {
            prefs.edit().remove(cipherKey(name)).remove(ivKey(name)).apply()
            ""
        }
    }

    private fun getOrCreateKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build()
        )
        return generator.generateKey()
    }

    private fun cipherKey(name: String) = "${name}_cipher"
    private fun ivKey(name: String) = "${name}_iv"

    companion object {
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val KEY_ALIAS = "per_open_quest_api_key"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
}
