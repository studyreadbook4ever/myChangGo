package com.example.kanjiwake

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class QuestJsonParserTest {
    @Test
    fun parsesFencedJsonAndKeepsAnswerAmongFourChoices() {
        val quest = QuestJsonParser.parse(
            """
            ```json
            {
              "question": "悪夢의 뜻은?",
              "choices": ["악몽", "약속", "해석", "습관"],
              "answer": "악몽",
              "explanation": "悪夢는 무서운 꿈을 뜻합니다."
            }
            ```
            """.trimIndent()
        )

        assertEquals("悪夢의 뜻은?", quest.question)
        assertEquals(4, quest.choices.size)
        assertEquals(4, quest.choices.distinct().size)
        assertEquals("악몽", quest.answer)
        assertTrue(quest.answer in quest.choices)
    }

    @Test(expected = IllegalStateException::class)
    fun rejectsDuplicateChoices() {
        QuestJsonParser.parse(
            """
            {
              "question": "중복 선택지",
              "choices": ["A", "A", "B", "C"],
              "answer": "A",
              "explanation": "설명"
            }
            """.trimIndent()
        )
    }

    @Test(expected = IllegalStateException::class)
    fun rejectsAnswerOutsideChoices() {
        QuestJsonParser.parse(
            """
            {
              "question": "정답 불일치",
              "choices": ["A", "B", "C", "D"],
              "answer": "E",
              "explanation": "설명"
            }
            """.trimIndent()
        )
    }
}
