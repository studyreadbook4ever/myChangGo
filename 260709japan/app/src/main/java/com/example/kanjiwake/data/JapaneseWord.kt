package com.example.kanjiwake.data

data class JapaneseWord(
    val id: Long = 0L,
    val term: String,
    val reading: String,
    val meaning: String,
    val detail: String,
    val example: String,
    val exampleMeaning: String,
    val partOfSpeech: String
)
