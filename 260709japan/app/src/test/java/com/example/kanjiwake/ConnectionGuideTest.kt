package com.example.kanjiwake

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException

class ConnectionGuideTest {
    @Test
    fun fillsOllamaPortAndApiPathFromPcAddress() {
        assertEquals(
            "http://192.168.0.10:11434/v1",
            ConnectionGuide.normalizeLocalEndpoint("192.168.0.10", LocalRunner.OLLAMA)
        )
    }

    @Test
    fun fillsLmStudioPortAndKeepsCustomPort() {
        assertEquals(
            "http://my-pc.local:1234/v1",
            ConnectionGuide.normalizeLocalEndpoint("my-pc.local", LocalRunner.LM_STUDIO)
        )
        assertEquals(
            "https://192.168.0.10:7777/v1",
            ConnectionGuide.normalizeLocalEndpoint("https://192.168.0.10:7777/v1", LocalRunner.OLLAMA)
        )
    }

    @Test
    fun turnsSavedEndpointBackIntoFriendlyPcAddress() {
        assertEquals(
            "192.168.0.10",
            ConnectionGuide.friendlyLocalAddress(
                "http://192.168.0.10:11434/v1",
                LocalRunner.OLLAMA
            )
        )
    }

    @Test
    fun explainsWhyLocalhostAndBindAddressDoNotWorkOnPhone() {
        val localhost = ConnectionGuide.connectionInputError(
            AiProvider.LOCAL_SERVER,
            "localhost",
            "",
            LocalRunner.OLLAMA
        )
        val bindAddress = ConnectionGuide.connectionInputError(
            AiProvider.LOCAL_SERVER,
            "0.0.0.0",
            "",
            LocalRunner.OLLAMA
        )

        assertTrue(localhost.orEmpty().contains("휴대폰"))
        assertTrue(bindAddress.orEmpty().contains("PC의 Wi-Fi"))
        assertNull(
            ConnectionGuide.connectionInputError(
                AiProvider.LOCAL_SERVER,
                "192.168.0.10",
                "",
                LocalRunner.OLLAMA
            )
        )
    }

    @Test
    fun translatesCommonNetworkFailuresIntoActions() {
        val refused = ConnectionGuide.explainFailure(
            AiProvider.LOCAL_SERVER,
            LocalRunner.OLLAMA,
            ConnectException("Connection refused")
        )
        val unknown = ConnectionGuide.explainFailure(
            AiProvider.LOCAL_SERVER,
            LocalRunner.OLLAMA,
            UnknownHostException("bad-host")
        )
        val timeout = ConnectionGuide.explainFailure(
            AiProvider.LOCAL_SERVER,
            LocalRunner.LM_STUDIO,
            SocketTimeoutException("Read timed out")
        )

        assertTrue(refused.contains("같은 Wi-Fi"))
        assertTrue(unknown.contains("Wi-Fi IPv4"))
        assertTrue(timeout.contains("모델 로딩"))
    }

    @Test
    fun translatesAuthenticationAndMissingPathFailures() {
        val badKey = ConnectionGuide.explainFailure(
            AiProvider.GEMINI,
            LocalRunner.OLLAMA,
            QuestHttpFailure(401, "Unauthorized")
        )
        val missingLocalApi = ConnectionGuide.explainFailure(
            AiProvider.LOCAL_SERVER,
            LocalRunner.LM_STUDIO,
            QuestHttpFailure(404, "Not found")
        )

        assertTrue(badKey.contains("키"))
        assertTrue(missingLocalApi.contains("LM Studio"))
    }
}
