package com.example.kanjiwake

import java.net.ConnectException
import java.net.MalformedURLException
import java.net.SocketTimeoutException
import java.net.URI
import java.net.UnknownHostException
import javax.net.ssl.SSLException

enum class LocalRunner(
    val storageValue: String,
    val displayName: String,
    val defaultPort: Int,
    val defaultModel: String,
    val setupUrl: String
) {
    OLLAMA(
        storageValue = "ollama",
        displayName = "Ollama (처음 사용 권장)",
        defaultPort = 11434,
        defaultModel = "gemma3:4b",
        setupUrl = "https://ollama.com/download"
    ),
    LM_STUDIO(
        storageValue = "lm_studio",
        displayName = "LM Studio (화면으로 설정)",
        defaultPort = 1234,
        defaultModel = "",
        setupUrl = "https://lmstudio.ai/download"
    );

    companion object {
        fun fromStorage(value: String?): LocalRunner =
            entries.firstOrNull { it.storageValue == value } ?: OLLAMA

        fun fromEndpoint(endpoint: String): LocalRunner =
            if (endpoint.contains(":1234")) LM_STUDIO else OLLAMA
    }
}

object ConnectionGuide {
    fun normalizeLocalEndpoint(rawAddress: String, runner: LocalRunner): String {
        val raw = rawAddress.trim().trimEnd('/')
        if (raw.isBlank()) return ""

        val withScheme = if (raw.startsWith("http://") || raw.startsWith("https://")) {
            raw
        } else {
            "http://$raw"
        }
        val uri = URI(withScheme)
        val host = uri.host ?: throw IllegalArgumentException("PC 주소 형식을 확인해 주세요.")
        val port = uri.port.takeIf { it > 0 } ?: runner.defaultPort
        val printableHost = if (host.contains(':')) "[$host]" else host
        return "${uri.scheme}://$printableHost:$port/v1"
    }

    fun friendlyLocalAddress(endpoint: String, runner: LocalRunner): String {
        if (endpoint.isBlank()) return ""
        return runCatching {
            val normalized = normalizeLocalEndpoint(endpoint, runner)
            val uri = URI(normalized)
            val host = uri.host ?: return@runCatching endpoint
            val printableHost = if (host.contains(':')) "[$host]" else host
            if (uri.port == runner.defaultPort) printableHost else "$printableHost:${uri.port}"
        }.getOrDefault(endpoint)
    }

    fun connectionInputError(
        provider: AiProvider,
        rawEndpoint: String,
        apiKey: String,
        runner: LocalRunner
    ): String? {
        if (provider == AiProvider.GEMINI) {
            return if (apiKey.isBlank()) {
                "먼저 '개인 키 만들기'에서 키를 만든 뒤 이 칸에 붙여 넣어 주세요."
            } else {
                null
            }
        }
        if (rawEndpoint.isBlank()) {
            return if (provider == AiProvider.LOCAL_SERVER) {
                "PC 주소를 입력해 주세요. 예: 192.168.0.10"
            } else {
                "서버 운영자에게 받은 서버 주소를 입력해 주세요."
            }
        }
        if (provider != AiProvider.LOCAL_SERVER) return null

        val endpoint = runCatching { normalizeLocalEndpoint(rawEndpoint, runner) }
            .getOrElse { return "PC 주소는 192.168.0.10처럼 입력해 주세요." }
        val host = URI(endpoint).host.orEmpty().lowercase()
        return when (host) {
            "localhost", "127.0.0.1", "::1" ->
                "localhost는 이 휴대폰을 뜻합니다. PC의 Wi-Fi IPv4 주소를 입력해 주세요."
            "0.0.0.0", "::" ->
                "0.0.0.0은 PC 프로그램의 허용 설정에만 쓰는 값입니다. 여기에는 PC의 Wi-Fi IPv4 주소를 입력해 주세요."
            else -> null
        }
    }

    fun explainFailure(
        provider: AiProvider,
        runner: LocalRunner,
        error: Throwable
    ): String {
        val causes = generateSequence(error as Throwable?) { it.cause }.toList()
        val http = causes.filterIsInstance<QuestHttpFailure>().firstOrNull()
        if (http != null) {
            return when (http.status) {
                401, 403 -> if (provider == AiProvider.GEMINI) {
                    "Google이 키를 받아들이지 않았습니다. 키가 온전히 붙여넣어졌는지 확인하거나 새 키를 만들어 주세요."
                } else {
                    "서버에는 도착했지만 인증에 실패했습니다. 서버에서 받은 API 키를 확인해 주세요."
                }
                404 -> if (provider == AiProvider.LOCAL_SERVER) {
                    "PC에는 도착했지만 ${runner.shortName()}의 AI 연결 기능을 찾지 못했습니다. PC 프로그램에서 서버가 켜졌는지 확인해 주세요."
                } else {
                    "서버에는 도착했지만 AI 연결 경로를 찾지 못했습니다. 서버 주소에 OpenAI 호환 API 주소를 입력했는지 확인해 주세요."
                }
                429 -> "요청 한도에 도달했습니다. 잠시 뒤 다시 시도하거나 제공자의 사용량 한도를 확인해 주세요."
                in 500..599 -> "AI 서버가 잠시 응답하지 못했습니다. PC 모델이 완전히 실행됐는지 확인한 뒤 다시 시도해 주세요."
                else -> http.message ?: "AI 서버가 요청을 처리하지 못했습니다."
            }
        }
        return when {
            causes.any { it is UnknownHostException } -> if (provider == AiProvider.LOCAL_SERVER) {
                "PC 주소를 찾지 못했습니다. 숫자 사이의 점을 확인하고 PC의 Wi-Fi IPv4 주소를 입력해 주세요."
            } else {
                "서버 주소를 찾지 못했습니다. 주소의 철자를 확인해 주세요."
            }
            causes.any { it is ConnectException } -> if (provider == AiProvider.LOCAL_SERVER) {
                "PC까지 연결되지 않았습니다. ${runner.shortName()}이 실행 중인지, 휴대폰과 PC가 같은 Wi-Fi인지, PC가 외부 연결을 허용했는지 확인해 주세요."
            } else {
                "서버에 연결되지 않았습니다. 서버가 실행 중인지 주소와 포트를 확인해 주세요."
            }
            causes.any { it is SocketTimeoutException } -> if (provider == AiProvider.LOCAL_SERVER) {
                "PC가 제시간에 응답하지 않았습니다. 모델 로딩이 끝났는지와 Wi-Fi 연결을 확인한 뒤 다시 시도해 주세요."
            } else {
                "서버 응답이 너무 오래 걸렸습니다. 잠시 뒤 다시 시도해 주세요."
            }
            causes.any { it is MalformedURLException || it is IllegalArgumentException } ->
                "주소 형식을 읽을 수 없습니다. 안내된 예시와 같은 형태로 입력해 주세요."
            causes.any { it is SSLException } ->
                "보안 연결 인증서를 확인하지 못했습니다. 신뢰할 수 있는 HTTPS 서버인지 확인해 주세요."
            else -> error.message?.takeIf { it.isNotBlank() }
                ?: "연결하지 못했습니다. 입력값을 확인한 뒤 다시 시도해 주세요."
        }
    }

    fun emptyModelMessage(provider: AiProvider, runner: LocalRunner): String = when (provider) {
        AiProvider.GEMINI -> "Google 연결은 성공했지만 이 키로 사용할 수 있는 생성 모델을 찾지 못했습니다."
        AiProvider.LOCAL_SERVER -> when (runner) {
            LocalRunner.OLLAMA ->
                "PC의 Ollama에는 연결됐지만 설치된 모델이 없습니다. PC에서 'ollama pull gemma3:4b'를 실행해 주세요."
            LocalRunner.LM_STUDIO ->
                "PC의 LM Studio에는 연결됐지만 사용할 모델이 없습니다. 모델을 내려받아 로드한 뒤 서버를 다시 확인해 주세요."
        }
        AiProvider.OPENAI_COMPATIBLE ->
            "서버 연결은 성공했지만 사용할 수 있는 모델을 찾지 못했습니다. 서버 운영자에게 모델 이름을 확인해 주세요."
    }

    private fun LocalRunner.shortName(): String = when (this) {
        LocalRunner.OLLAMA -> "Ollama"
        LocalRunner.LM_STUDIO -> "LM Studio"
    }
}
