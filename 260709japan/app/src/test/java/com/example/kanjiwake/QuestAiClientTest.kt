package com.example.kanjiwake

import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.atomic.AtomicReference

class QuestAiClientTest {
    private lateinit var server: FakeOpenAiServer

    @Before
    fun setUp() {
        server = FakeOpenAiServer()
    }

    @After
    fun tearDown() {
        server.close()
    }

    @Test
    fun listsModelsFromOpenAiCompatibleServer() {
        assertEquals(listOf("gemma3:27b", "small-model"), QuestAiClient.listModels(settings()))
    }

    @Test
    fun generatesAndValidatesQuestFromOpenAiCompatibleServer() {
        val quest = QuestAiClient.generate(settings(), previousQuestion = null)

        assertEquals("任務を担う의 뜻은?", quest.question)
        assertEquals("임무를 맡다", quest.answer)
        assertTrue(quest.answer in quest.choices)
        assertEquals(4, quest.choices.size)
        assertTrue(JSONObject(server.lastChatRequest.get()).has("response_format"))
    }

    private fun settings() = QuestSettings(
        provider = AiProvider.LOCAL_SERVER,
        endpoint = "http://127.0.0.1:${server.port}",
        model = "gemma3:27b",
        apiKey = "",
        questPrompt = "일본어 한자 어휘 문제"
    )
}

private class FakeOpenAiServer : AutoCloseable {
    private val socket = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
    private val thread = Thread(::serve, "fake-openai-server").apply {
        isDaemon = true
        start()
    }
    val lastChatRequest = AtomicReference("")
    val port: Int = socket.localPort

    override fun close() {
        socket.close()
        thread.join(1_000L)
    }

    private fun serve() {
        while (!socket.isClosed) {
            val client = runCatching { socket.accept() }.getOrNull() ?: return
            client.use(::handle)
        }
    }

    private fun handle(client: Socket) {
        val input = client.getInputStream()
        val headerBytes = ByteArrayOutputStream()
        var matched = 0
        while (matched < HEADER_END.size) {
            val next = input.read()
            if (next < 0) break
            headerBytes.write(next)
            matched = if (next.toByte() == HEADER_END[matched]) matched + 1 else 0
        }
        val headers = headerBytes.toString(Charsets.ISO_8859_1.name())
        val path = headers.lineSequence().first().split(' ').getOrElse(1) { "/" }
        val contentLength = headers.lineSequence()
            .firstOrNull { it.startsWith("Content-Length:", ignoreCase = true) }
            ?.substringAfter(':')
            ?.trim()
            ?.toIntOrNull()
            ?: 0
        val bodyBytes = ByteArray(contentLength)
        var offset = 0
        while (offset < bodyBytes.size) {
            val read = input.read(bodyBytes, offset, bodyBytes.size - offset)
            if (read < 0) break
            offset += read
        }
        val requestBody = String(bodyBytes, 0, offset, Charsets.UTF_8)

        val response = if (path == "/v1/models") {
            JSONObject().put(
                "data",
                JSONArray()
                    .put(JSONObject().put("id", "gemma3:27b"))
                    .put(JSONObject().put("id", "small-model"))
            ).toString()
        } else {
            lastChatRequest.set(requestBody)
            val questJson = JSONObject()
                .put("question", "任務を担う의 뜻은?")
                .put("choices", JSONArray(listOf("임무를 맡다", "책임을 피하다", "계획을 버리다", "기억을 잊다")))
                .put("answer", "임무를 맡다")
                .put("explanation", "任務を担う는 책임 있는 임무를 맡는다는 표현입니다.")
                .toString()
            JSONObject().put(
                "choices",
                JSONArray().put(
                    JSONObject().put(
                        "message",
                        JSONObject().put("role", "assistant").put("content", questJson)
                    )
                )
            ).toString()
        }
        writeResponse(client, response)
    }

    private fun writeResponse(client: Socket, body: String) {
        val bytes = body.toByteArray(Charsets.UTF_8)
        val header = buildString {
            append("HTTP/1.1 200 OK\r\n")
            append("Content-Type: application/json; charset=utf-8\r\n")
            append("Content-Length: ${bytes.size}\r\n")
            append("Connection: close\r\n\r\n")
        }.toByteArray(Charsets.ISO_8859_1)
        client.getOutputStream().use {
            it.write(header)
            it.write(bytes)
            it.flush()
        }
    }

    companion object {
        private val HEADER_END = byteArrayOf('\r'.code.toByte(), '\n'.code.toByte(), '\r'.code.toByte(), '\n'.code.toByte())
    }
}
