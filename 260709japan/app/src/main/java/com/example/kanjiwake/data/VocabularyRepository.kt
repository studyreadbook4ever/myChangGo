package com.example.kanjiwake.data

import android.content.Context
import kotlin.random.Random

class VocabularyRepository(context: Context) {
    private val helper = VocabularyDbHelper(context.applicationContext)

    fun wordCount(): Int = helper.countWords()

    fun nextQuestion(excludingId: Long? = null): QuizQuestion {
        val answer = helper.randomWord(excludingId)
        val choices = (helper.randomMeanings(answer.id, answer.meaning, limit = 3) + answer.meaning)
            .shuffled(Random(System.nanoTime()))

        check(choices.size == 4) { "At least four vocabulary meanings are required." }
        return QuizQuestion(answer = answer, choices = choices)
    }
}
