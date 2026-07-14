package com.example.kanjiwake

enum class AiProvider(val storageValue: String, val displayName: String) {
    GEMINI("gemini", "Google로 간단히 시작"),
    LOCAL_SERVER("local_server", "내 PC의 AI 사용"),
    OPENAI_COMPATIBLE("openai_compatible", "고급 서버 연결");

    companion object {
        fun fromStorage(value: String?): AiProvider =
            entries.firstOrNull { it.storageValue == value } ?: GEMINI
    }
}

data class QuestSettings(
    val provider: AiProvider,
    val endpoint: String,
    val model: String,
    val apiKey: String,
    val questPrompt: String
) {
    fun validationError(): String? = when {
        questPrompt.isBlank() -> "출제 프롬프트를 입력해 주세요."
        model.isBlank() -> "사용할 모델을 선택하거나 입력해 주세요."
        provider == AiProvider.GEMINI && apiKey.isBlank() -> "Google AI Studio API 키를 입력해 주세요."
        provider != AiProvider.GEMINI && endpoint.isBlank() -> "AI 서버 주소를 입력해 주세요."
        else -> null
    }
}

data class GeneratedQuest(
    val question: String,
    val choices: List<String>,
    val answer: String,
    val explanation: String
)

object PerOpenQuestPrefs {
    // Keep the original file name so an app update preserves the soft-lock toggle.
    const val NAME = "kanji_wake_prefs"
    const val KEY_MONITOR_ENABLED = "monitor_enabled"

    const val DEFAULT_QUEST_PROMPT =
        "일본어 중상급 학습자를 위한 한자 어휘 문제를 한국어 4지선다로 출제해 주세요. " +
            "명사와 자연스러운 동사구를 골고루 사용하고, 실제 일본어에서 널리 쓰이는 표현만 다뤄 주세요."
}
