package dev.presentation.recording

import android.graphics.Bitmap
import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.EGLContext
import android.opengl.EGLDisplay
import android.opengl.EGLExt
import android.opengl.EGLSurface
import android.opengl.GLES20
import android.opengl.GLUtils
import android.view.Surface
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer

/** Owns an EGL context on the recording worker. The caller owns [inputSurface]. */
internal class EglFrameRenderer(
    private val inputSurface: Surface,
    private val width: Int,
    private val height: Int,
) : AutoCloseable {
    private var display: EGLDisplay = EGL14.EGL_NO_DISPLAY
    private var context: EGLContext = EGL14.EGL_NO_CONTEXT
    private var window: EGLSurface = EGL14.EGL_NO_SURFACE
    private var program = 0
    private var texture = 0
    private var positionLocation = -1
    private var textureLocation = -1
    private var samplerLocation = -1
    private var hasFrame = false

    // Bitmap row zero is its top edge. Flip the V coordinate to match GL's bottom-left origin.
    private val vertices = floatBuffer(floatArrayOf(
        -1f, -1f, 0f, 1f,
         1f, -1f, 1f, 1f,
        -1f,  1f, 0f, 0f,
         1f,  1f, 1f, 0f,
    ))

    init {
        try {
            initialize()
        } catch (failure: Throwable) {
            close()
            throw failure
        }
    }

    private fun initialize() {
        display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
        check(display != EGL14.EGL_NO_DISPLAY) { "No EGL display is available" }
        val version = IntArray(2)
        eglCheck(EGL14.eglInitialize(display, version, 0, version, 1), "initialize")
        val attributes = intArrayOf(
            EGL14.EGL_RED_SIZE, 8,
            EGL14.EGL_GREEN_SIZE, 8,
            EGL14.EGL_BLUE_SIZE, 8,
            EGL14.EGL_ALPHA_SIZE, 8,
            EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
            EGL14.EGL_SURFACE_TYPE, EGL14.EGL_WINDOW_BIT,
            EGL_RECORDABLE_ANDROID, 1,
            EGL14.EGL_NONE,
        )
        val configs = arrayOfNulls<EGLConfig>(1)
        val count = IntArray(1)
        eglCheck(EGL14.eglChooseConfig(display, attributes, 0, configs, 0, 1, count, 0), "choose config")
        check(count[0] > 0) { "This device has no recordable EGL configuration" }
        val config = checkNotNull(configs[0])
        context = EGL14.eglCreateContext(
            display, config, EGL14.EGL_NO_CONTEXT,
            intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE), 0,
        )
        check(context != EGL14.EGL_NO_CONTEXT) { "Unable to create recording EGL context" }
        window = EGL14.eglCreateWindowSurface(display, config, inputSurface, intArrayOf(EGL14.EGL_NONE), 0)
        check(window != EGL14.EGL_NO_SURFACE) { "Unable to create recording EGL surface" }
        eglCheck(EGL14.eglMakeCurrent(display, window, window, context), "make current")

        val vertex = compile(GLES20.GL_VERTEX_SHADER, """
            attribute vec2 aPosition;
            attribute vec2 aTexture;
            varying vec2 vTexture;
            void main() {
                gl_Position = vec4(aPosition, 0.0, 1.0);
                vTexture = aTexture;
            }
        """.trimIndent())
        val fragment = try {
            compile(GLES20.GL_FRAGMENT_SHADER, """
                precision mediump float;
                uniform sampler2D uSlide;
                varying vec2 vTexture;
                void main() { gl_FragColor = texture2D(uSlide, vTexture); }
            """.trimIndent())
        } catch (failure: Throwable) {
            GLES20.glDeleteShader(vertex)
            throw failure
        }
        try {
            program = GLES20.glCreateProgram()
            check(program != 0) { "Unable to create slide shader program" }
            GLES20.glAttachShader(program, vertex)
            GLES20.glAttachShader(program, fragment)
            GLES20.glLinkProgram(program)
            val status = IntArray(1)
            GLES20.glGetProgramiv(program, GLES20.GL_LINK_STATUS, status, 0)
            check(status[0] != 0) { "Slide shader linking failed: ${GLES20.glGetProgramInfoLog(program)}" }
        } finally {
            GLES20.glDeleteShader(vertex)
            GLES20.glDeleteShader(fragment)
        }
        positionLocation = GLES20.glGetAttribLocation(program, "aPosition")
        textureLocation = GLES20.glGetAttribLocation(program, "aTexture")
        samplerLocation = GLES20.glGetUniformLocation(program, "uSlide")
        check(positionLocation >= 0 && textureLocation >= 0 && samplerLocation >= 0) { "Missing slide shader inputs" }
        val textures = IntArray(1)
        GLES20.glGenTextures(1, textures, 0)
        texture = textures[0]
        check(texture != 0) { "Unable to allocate slide texture" }
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, texture)
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)
        glCheck("initialize texture")
    }

    fun upload(bitmap: Bitmap) {
        check(bitmap.width == width && bitmap.height == height) { "Slide frame has incorrect dimensions" }
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, texture)
        if (hasFrame) {
            GLUtils.texSubImage2D(GLES20.GL_TEXTURE_2D, 0, 0, 0, bitmap)
        } else {
            GLUtils.texImage2D(GLES20.GL_TEXTURE_2D, 0, bitmap, 0)
            hasFrame = true
        }
        glCheck("upload slide")
    }

    fun draw(presentationTimeNanos: Long) {
        check(hasFrame) { "No slide frame has been uploaded" }
        GLES20.glViewport(0, 0, width, height)
        GLES20.glClearColor(0f, 0f, 0f, 1f)
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)
        GLES20.glUseProgram(program)
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, texture)
        GLES20.glUniform1i(samplerLocation, 0)
        vertices.position(0)
        GLES20.glVertexAttribPointer(positionLocation, 2, GLES20.GL_FLOAT, false, 16, vertices)
        GLES20.glEnableVertexAttribArray(positionLocation)
        vertices.position(2)
        GLES20.glVertexAttribPointer(textureLocation, 2, GLES20.GL_FLOAT, false, 16, vertices)
        GLES20.glEnableVertexAttribArray(textureLocation)
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
        GLES20.glDisableVertexAttribArray(positionLocation)
        GLES20.glDisableVertexAttribArray(textureLocation)
        glCheck("draw slide")
        // Use the real monotonic timestamp. MediaRecorder removes pause gaps from both tracks.
        eglCheck(EGLExt.eglPresentationTimeANDROID(display, window, presentationTimeNanos), "set frame timestamp")
        eglCheck(EGL14.eglSwapBuffers(display, window), "submit frame")
    }

    override fun close() {
        if (display != EGL14.EGL_NO_DISPLAY) {
            if (context != EGL14.EGL_NO_CONTEXT && window != EGL14.EGL_NO_SURFACE) {
                EGL14.eglMakeCurrent(display, window, window, context)
                if (texture != 0) GLES20.glDeleteTextures(1, intArrayOf(texture), 0)
                if (program != 0) GLES20.glDeleteProgram(program)
            }
            EGL14.eglMakeCurrent(display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT)
            if (window != EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(display, window)
            if (context != EGL14.EGL_NO_CONTEXT) EGL14.eglDestroyContext(display, context)
            EGL14.eglReleaseThread()
            EGL14.eglTerminate(display)
        }
        display = EGL14.EGL_NO_DISPLAY
        context = EGL14.EGL_NO_CONTEXT
        window = EGL14.EGL_NO_SURFACE
        program = 0
        texture = 0
        hasFrame = false
    }

    private fun compile(type: Int, source: String): Int {
        val shader = GLES20.glCreateShader(type)
        check(shader != 0) { "Unable to create slide shader" }
        GLES20.glShaderSource(shader, source)
        GLES20.glCompileShader(shader)
        val status = IntArray(1)
        GLES20.glGetShaderiv(shader, GLES20.GL_COMPILE_STATUS, status, 0)
        if (status[0] == 0) {
            val log = GLES20.glGetShaderInfoLog(shader)
            GLES20.glDeleteShader(shader)
            error("Slide shader compilation failed: $log")
        }
        return shader
    }

    private fun eglCheck(success: Boolean, operation: String) {
        check(success) { "EGL could not $operation (0x${EGL14.eglGetError().toString(16)})" }
    }

    private fun glCheck(operation: String) {
        val error = GLES20.glGetError()
        check(error == GLES20.GL_NO_ERROR) { "OpenGL could not $operation (0x${error.toString(16)})" }
    }

    private fun floatBuffer(values: FloatArray): FloatBuffer =
        ByteBuffer.allocateDirect(values.size * 4).order(ByteOrder.nativeOrder()).asFloatBuffer().apply {
            put(values)
            position(0)
        }

    private companion object { const val EGL_RECORDABLE_ANDROID = 0x3142 }
}
