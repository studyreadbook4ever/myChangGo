package dev.presentation.slides

import android.graphics.Bitmap
import java.io.Closeable

/** A document owns its resources; call render from a worker thread, and close after recording. */
interface PresentationDocument : Closeable {
    val title: String
    val slideCount: Int
    val warnings: List<String>
    fun notes(index: Int): String
    fun render(index: Int, width: Int = 1280, height: Int = 720): Bitmap
}
