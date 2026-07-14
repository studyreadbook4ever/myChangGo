package com.example.kanjiwake

import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import kotlin.random.Random

object QuestAiClient {
    fun listModels(settings: QuestSettings): List<String> = when (settings.provider) {
        AiProvider.GEMINI -> listGeminiModels(settings)
        AiProvider.OPENAI_COMPATIBLE -> listOpenAiModels(settings)
        AiProvider.ON_DEVICE -> error("온디바이스 모델은 파일 선택 화면에서 준비해 주세요.")
    }

    fun generate(settings: QuestSettings, previousQuestion: String?): GeneratedQuest {
        settings.validationError()?.let { error(it) }
        var parseFailure: Throwable? = null

        repeat(2) { attempt ->
            val raw = when (settings.provider) {
                AiProvider.GEMINI -> generateWithGemini(settings, previousQuestion, attempt > 0)
                AiProvider.OPENAI_COMPATIBLE ->
                    generateWithOpenAi(settings, previousQuestion, attempt > 0)
                AiProvider.ON_DEVICE -> error("온디바이스 생성에는 Android 컨텍스트가 필요합니다.")
            }
            try {
                return QuestJsonParser.parse(raw)
            } catch (error: RuntimeException) {
                parseFailure = error
            }
        }

        throw IllegalStateException(
            "모델이 올바른 4지선다 형식으로 응답하지 않았습니다. 모델이나 프롬프트를 바꿔 주세요.",
            parseFailure
        )
    }

    private fun listGeminiModels(settings: QuestSettings): List<String> {
        check(settings.apiKey.isNotBlank()) { "Google AI Studio API 키를 입력해 주세요." }
        val root = request(
            url = "${geminiBase(settings)}/models?pageSize=1000",
            method = "GET",
            headers = mapOf("x-goog-api-key" to settings.apiKey)
        )
        val models = JSONObject(root).optJSONArray("models") ?: JSONArray()
        return buildList {
            for (index in 0 until models.length()) {
                val model = models.optJSONObject(index) ?: continue
                val methods = model.optJSONArray("supportedGenerationMethods")
                val canGenerate = methods == null || (0 until methods.length())
                    .any { methods.optString(it) == "generateContent" }
                if (!canGenerate) continue
                model.optString("name")
                    .removePrefix("models/")
                    .takeIf { it.isNotBlank() }
                    ?.let(::add)
            }
        }.distinct().sorted()
    }

    private fun listOpenAiModels(settings: QuestSettings): List<String> {
        val headers = authorizationHeaders(settings.apiKey)
        val root = request(
            url = "${openAiBase(settings.endpoint)}/models",
            method = "GET",
            headers = headers
        )
        val data = JSONObject(root).optJSONArray("data") ?: JSONArray()
        return buildList {
            for (index in 0 until data.length()) {
                data.optJSONObject(index)?.optString("id")
                    ?.takeIf { it.isNotBlank() }
                    ?.let(::add)
            }
        }.distinct().sorted()
    }

    private fun generateWithGemini(
        settings: QuestSettings,
        previousQuestion: String?,
        strictRetry: Boolean
    ): String {
        val body = JSONObject()
            .put(
                "systemInstruction",
                JSONObject().put(
                    "parts",
                    JSONArray().put(
                        JSONObject().put("text", QuestPromptContract.SYSTEM_INSTRUCTION)
                    )
                )
            )
            .put(
                "contents",
                JSONArray().put(
                    JSONObject()
                        .put("role", "user")
                        .put(
                            "parts",
                            JSONArray().put(
                                JSONObject().put(
                                    "text",
                                    QuestPromptContract.generationPrompt(
                                        settings.questPrompt,
                                        previousQuestion,
                                        strictRetry
                                    )
                                )
                            )
                        )
                )
            )
            .put(
                "generationConfig",
                JSONObject()
                    .put("temperature", 0.9)
                    .put("maxOutputTokens", 900)
                    .put(
                        "responseFormat",
                        JSONObject().put(
                            "text",
                            JSONObject()
                                .put("mimeType", "application/json")
                                .put("schema", questSchema())
                        )
                    )
            )

        val model = settings.model.removePrefix("models/")
        val root = request(
            url = "${geminiBase(settings)}/models/$model:generateContent",
            method = "POST",
            headers = mapOf("x-goog-api-key" to settings.apiKey),
            body = body.toString()
        )
        val parts = JSONObject(root)
            .optJSONArray("candidates")
            ?.optJSONObject(0)
            ?.optJSONObject("content")
            ?.optJSONArray("parts")
            ?: error("모델 응답에 문제 내용이 없습니다.")
        return buildString {
            for (index in 0 until parts.length()) {
                append(parts.optJSONObject(index)?.optString("text").orEmpty())
            }
        }.ifBlank { error("모델이 빈 응답을 반환했습니다.") }
    }

    private fun generateWithOpenAi(
        settings: QuestSettings,
        previousQuestion: String?,
        strictRetry: Boolean
    ): String {
        val baseBody = JSONObject()
            .put("model", settings.model)
            .put("temperature", 0.9)
            .put("max_tokens", 900)
            .put(
                "messages",
                JSONArray()
                    .put(
                        JSONObject()
                            .put("role", "system")
                            .put("content", QuestPromptContract.SYSTEM_INSTRUCTION)
                    )
                    .put(
                        JSONObject()
                            .put("role", "user")
                            .put(
                                "content",
                                QuestPromptContract.generationPrompt(
                                    settings.questPrompt,
                                    previousQuestion,
                                    strictRetry
                                )
                            )
                    )
            )

        val url = "${openAiBase(settings.endpoint)}/chat/completions"
        val headers = authorizationHeaders(settings.apiKey)
        val root = try {
            request(
                url = url,
                method = "POST",
                headers = headers,
                body = JSONObject(baseBody.toString())
                    .put("response_format", JSONObject().put("type", "json_object"))
                    .toString()
            )
        } catch (error: QuestHttpFailure) {
            if (error.status !in setOf(400, 404, 422)) throw error
            request(url, "POST", headers, baseBody.toString())
        }

        val message = JSONObject(root)
            .optJSONArray("choices")
            ?.optJSONObject(0)
            ?.optJSONObject("message")
            ?: error("모델 응답에 문제 내용이 없습니다.")
        val content = message.opt("content")
        return when (content) {
            is String -> content
            is JSONArray -> buildString {
                for (index in 0 until content.length()) {
                    val part = content.optJSONObject(index)
                    append(part?.optString("text").orEmpty())
                }
            }
            else -> ""
        }.ifBlank { error("모델이 빈 응답을 반환했습니다.") }
    }

    private fun questSchema(): JSONObject = JSONObject()
        .put("type", "object")
        .put(
            "properties",
            JSONObject()
                .put(
                    "question",
                    JSONObject().put("type", "string").put("description", "사용자에게 보여 줄 문제")
                )
                .put(
                    "choices",
                    JSONObject()
                        .put("type", "array")
                        .put("items", JSONObject().put("type", "string"))
                        .put("minItems", 4)
                        .put("maxItems", 4)
                )
                .put(
                    "answer",
                    JSONObject().put("type", "string").put("description", "choices 중 하나와 정확히 같은 정답")
                )
                .put(
                    "explanation",
                    JSONObject().put("type", "string").put("description", "정답의 자세한 해설")
                )
        )
        .put("required", JSONArray(listOf("question", "choices", "answer", "explanation")))
        .put("additionalProperties", false)

    private fun request(
        url: String,
        method: String,
        headers: Map<String, String> = emptyMap(),
        body: String? = null
    ): String {
        val connection = URL(url).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = method
            connection.connectTimeout = 12_000
            connection.readTimeout = 90_000
            connection.setRequestProperty("Accept", "application/json")
            headers.forEach(connection::setRequestProperty)
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            }

            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val response = stream?.let {
                BufferedReader(InputStreamReader(it, Charsets.UTF_8)).use(BufferedReader::readText)
            }.orEmpty()
            if (status !in 200..299) {
                throw QuestHttpFailure(status, readableError(response, status))
            }
            return response
        } finally {
            connection.disconnect()
        }
    }

    private fun readableError(response: String, status: Int): String = runCatching {
        val root = JSONObject(response)
        val error = root.opt("error")
        when (error) {
            is JSONObject -> error.optString("message")
            is String -> error
            else -> ""
        }.ifBlank { "AI 서버 요청에 실패했습니다. (HTTP $status)" }
    }.getOrDefault("AI 서버 요청에 실패했습니다. (HTTP $status)")

    private fun geminiBase(settings: QuestSettings): String =
        settings.endpoint.ifBlank { QuestSettingsStore.defaultEndpoint(AiProvider.GEMINI) }
            .trimEnd('/')

    private fun openAiBase(raw: String): String {
        val withScheme = if (raw.startsWith("http://") || raw.startsWith("https://")) {
            raw
        } else {
            "http://$raw"
        }
        val trimmed = withScheme.trimEnd('/')
        return if (trimmed.endsWith("/v1")) trimmed else "$trimmed/v1"
    }

    private fun authorizationHeaders(apiKey: String): Map<String, String> =
        apiKey.takeIf { it.isNotBlank() }
            ?.let { mapOf("Authorization" to "Bearer $it") }
            ?: emptyMap()

}

internal class QuestHttpFailure(val status: Int, message: String) : RuntimeException(message)

internal object QuestJsonParser {
    fun parse(raw: String): GeneratedQuest {
        val root = JSONObject(extractJson(raw))
        val question = root.getString("question").trim()
        val answerFromModel = root.getString("answer").trim()
        val explanation = root.getString("explanation").trim()
        val choicesJson = root.getJSONArray("choices")
        check(question.isNotBlank() && question.length <= 600) { "Invalid question" }
        check(explanation.isNotBlank() && explanation.length <= 4_000) { "Invalid explanation" }
        check(choicesJson.length() == 4) { "Exactly four choices are required" }

        val choices = (0 until choicesJson.length()).map { choicesJson.getString(it).trim() }
        check(choices.all { it.isNotBlank() && it.length <= 220 }) { "Invalid choice" }
        check(choices.map(::normalize).distinct().size == 4) { "Choices must be distinct" }
        val answer = choices.firstOrNull { normalize(it) == normalize(answerFromModel) }
            ?: error("Answer must match one choice")
        return GeneratedQuest(
            question = question,
            choices = choices.shuffled(Random(System.nanoTime())),
            answer = answer,
            explanation = explanation
        )
    }

    private fun extractJson(raw: String): String {
        val trimmed = raw.trim()
            .removePrefix("```json")
            .removePrefix("```")
            .removeSuffix("```")
            .trim()
        val start = trimmed.indexOf('{')
        val end = trimmed.lastIndexOf('}')
        check(start >= 0 && end > start) { "JSON object not found" }
        return trimmed.substring(start, end + 1)
    }

    private fun normalize(value: String): String = value.trim().replace(Regex("\\s+"), " ")
}
