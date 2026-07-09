package com.example.kanjiwake.data

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

class VocabularyDbHelper(context: Context) :
    SQLiteOpenHelper(context, DB_NAME, null, DB_VERSION) {

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE $TABLE_WORDS (
                $COL_ID INTEGER PRIMARY KEY AUTOINCREMENT,
                $COL_TERM TEXT NOT NULL UNIQUE,
                $COL_READING TEXT NOT NULL,
                $COL_MEANING TEXT NOT NULL,
                $COL_DETAIL TEXT NOT NULL,
                $COL_EXAMPLE TEXT NOT NULL,
                $COL_EXAMPLE_MEANING TEXT NOT NULL,
                $COL_PART_OF_SPEECH TEXT NOT NULL
            )
            """.trimIndent()
        )
        seed(db)
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        db.execSQL("DROP TABLE IF EXISTS $TABLE_WORDS")
        onCreate(db)
    }

    fun countWords(): Int {
        readableDatabase.rawQuery("SELECT COUNT(*) FROM $TABLE_WORDS", emptyArray()).use { cursor ->
            return if (cursor.moveToFirst()) cursor.getInt(0) else 0
        }
    }

    fun randomWord(excludingId: Long? = null): JapaneseWord {
        val where = if (excludingId == null) "" else "WHERE $COL_ID <> ?"
        val args = excludingId?.let { arrayOf(it.toString()) } ?: emptyArray()
        val sql = "SELECT * FROM $TABLE_WORDS $where ORDER BY RANDOM() LIMIT 1"
        readableDatabase.rawQuery(sql, args).use { cursor ->
            check(cursor.moveToFirst()) { "Vocabulary database is empty." }
            return cursor.toWord()
        }
    }

    fun randomMeanings(answerId: Long, answerMeaning: String, limit: Int): List<String> {
        val sql = """
            SELECT DISTINCT $COL_MEANING
            FROM $TABLE_WORDS
            WHERE $COL_ID <> ? AND $COL_MEANING <> ?
            ORDER BY RANDOM()
            LIMIT $limit
        """.trimIndent()

        readableDatabase.rawQuery(sql, arrayOf(answerId.toString(), answerMeaning)).use { cursor ->
            val meanings = mutableListOf<String>()
            while (cursor.moveToNext()) {
                meanings += cursor.getString(0)
            }
            return meanings
        }
    }

    private fun seed(db: SQLiteDatabase) {
        db.beginTransaction()
        try {
            SeedWords.entries.forEach { word ->
                val values = ContentValues().apply {
                    put(COL_TERM, word.term)
                    put(COL_READING, word.reading)
                    put(COL_MEANING, word.meaning)
                    put(COL_DETAIL, word.detail)
                    put(COL_EXAMPLE, word.example)
                    put(COL_EXAMPLE_MEANING, word.exampleMeaning)
                    put(COL_PART_OF_SPEECH, word.partOfSpeech)
                }
                db.insertWithOnConflict(TABLE_WORDS, null, values, SQLiteDatabase.CONFLICT_IGNORE)
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    private fun Cursor.toWord(): JapaneseWord {
        return JapaneseWord(
            id = getLong(getColumnIndexOrThrow(COL_ID)),
            term = getString(getColumnIndexOrThrow(COL_TERM)),
            reading = getString(getColumnIndexOrThrow(COL_READING)),
            meaning = getString(getColumnIndexOrThrow(COL_MEANING)),
            detail = getString(getColumnIndexOrThrow(COL_DETAIL)),
            example = getString(getColumnIndexOrThrow(COL_EXAMPLE)),
            exampleMeaning = getString(getColumnIndexOrThrow(COL_EXAMPLE_MEANING)),
            partOfSpeech = getString(getColumnIndexOrThrow(COL_PART_OF_SPEECH))
        )
    }

    companion object {
        private const val DB_NAME = "kanji_wake_words.db"
        private const val DB_VERSION = 1
        private const val TABLE_WORDS = "words"
        private const val COL_ID = "_id"
        private const val COL_TERM = "term"
        private const val COL_READING = "reading"
        private const val COL_MEANING = "meaning"
        private const val COL_DETAIL = "detail"
        private const val COL_EXAMPLE = "example"
        private const val COL_EXAMPLE_MEANING = "example_meaning"
        private const val COL_PART_OF_SPEECH = "part_of_speech"
    }
}
