package com.example.kanjiwake

import kotlin.random.Random

object QuestPromptContract {
    const val SYSTEM_INSTRUCTION =
        "당신은 Per-Open Quest의 4지선다 문제 생성기입니다. 사용자의 출제 의도와 언어를 따르되 " +
            "매 요청마다 새롭고 사실적으로 정확한 문제 한 개만 만드세요. 선택지는 서로 달라야 하며 " +
            "answer는 choices 안의 문자열 하나와 글자까지 정확히 같아야 합니다. explanation에는 정답의 " +
            "근거를 이해하기 쉽게 설명하세요. 출력은 question, choices, answer, explanation 필드만 가진 JSON 객체여야 합니다."

    fun generationPrompt(
        userPrompt: String,
        previousQuestion: String?,
        strictRetry: Boolean
    ): String = buildString {
        appendLine("[사용자의 출제 프롬프트]")
        appendLine(userPrompt.trim())
        appendLine()
        appendLine("위 지시에 맞는 새로운 문제를 정확히 한 개 생성하세요.")
        appendLine("다른 설명이나 마크다운 없이 JSON 객체 하나만 출력하세요.")
        appendLine("생성 식별자: ${System.currentTimeMillis()}-${Random.nextLong()}")
        previousQuestion?.takeIf { it.isNotBlank() }?.let {
            appendLine("직전 문제와 겹치지 마세요: $it")
        }
        if (strictRetry) {
            appendLine("이전 응답의 형식이 잘못되었습니다. 이번에는 네 선택지와 정확히 일치하는 정답을 포함하세요.")
        }
    }
}
