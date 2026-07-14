package com.example.kanjiwake

import java.net.ConnectException
import java.net.MalformedURLException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLException

object ConnectionGuide {
    fun connectionInputError(
        provider: AiProvider,
        rawEndpoint: String,
        apiKey: String
    ): String? = when {
        provider == AiProvider.GEMINI && apiKey.isBlank() ->
            "먼저 '개인 키 만들기'에서 키를 만든 뒤 이 칸에 붙여 넣어 주세요."
        provider == AiProvider.OPENAI_COMPATIBLE && rawEndpoint.isBlank() ->
            "서버 운영자에게 받은 서버 주소를 입력해 주세요."
        else -> null
    }

    fun explainFailure(provider: AiProvider, error: Throwable): String {
        val causes = generateSequence(error as Throwable?) { it.cause }.toList()
        val http = causes.filterIsInstance<QuestHttpFailure>().firstOrNull()
        if (http != null) {
            return when (http.status) {
                401, 403 -> if (provider == AiProvider.GEMINI) {
                    "Google이 키를 받아들이지 않았습니다. 키가 온전히 붙여넣어졌는지 확인하거나 새 키를 만들어 주세요."
                } else {
                    "서버에는 도착했지만 인증에 실패했습니다. 서버에서 받은 API 키를 확인해 주세요."
                }
                404 -> "서버에는 도착했지만 AI 연결 경로를 찾지 못했습니다. OpenAI 호환 API 주소인지 확인해 주세요."
                429 -> "요청 한도에 도달했습니다. 잠시 뒤 다시 시도하거나 제공자의 사용량 한도를 확인해 주세요."
                in 500..599 -> "AI 서버가 잠시 응답하지 못했습니다. 잠시 뒤 다시 시도해 주세요."
                else -> http.message ?: "AI 서버가 요청을 처리하지 못했습니다."
            }
        }
        return when {
            causes.any { it is UnknownHostException } ->
                "서버 주소를 찾지 못했습니다. 주소의 철자를 확인해 주세요."
            causes.any { it is ConnectException } ->
                "서버에 연결되지 않았습니다. 서버가 실행 중인지 주소와 포트를 확인해 주세요."
            causes.any { it is SocketTimeoutException } ->
                "서버 응답이 너무 오래 걸렸습니다. 잠시 뒤 다시 시도해 주세요."
            causes.any { it is MalformedURLException || it is IllegalArgumentException } ->
                "주소 형식을 읽을 수 없습니다. 안내된 예시와 같은 형태로 입력해 주세요."
            causes.any { it is SSLException } ->
                "보안 연결 인증서를 확인하지 못했습니다. 신뢰할 수 있는 HTTPS 서버인지 확인해 주세요."
            else -> error.message?.takeIf { it.isNotBlank() }
                ?: "연결하지 못했습니다. 입력값을 확인한 뒤 다시 시도해 주세요."
        }
    }

    fun emptyModelMessage(provider: AiProvider): String = when (provider) {
        AiProvider.GEMINI -> "Google 연결은 성공했지만 이 키로 사용할 수 있는 생성 모델을 찾지 못했습니다."
        AiProvider.OPENAI_COMPATIBLE ->
            "서버 연결은 성공했지만 사용할 수 있는 모델을 찾지 못했습니다. 서버 운영자에게 모델 이름을 확인해 주세요."
        AiProvider.ON_DEVICE -> "휴대폰 모델은 파일 선택 화면에서 준비해 주세요."
    }
}
