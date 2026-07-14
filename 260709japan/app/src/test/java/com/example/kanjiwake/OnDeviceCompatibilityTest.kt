package com.example.kanjiwake

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.ConnectException

class OnDeviceCompatibilityTest {
    @Test
    fun recognizesSupportedPhoneChipFamilies() {
        assertEquals(
            "sm8750",
            OnDeviceCompatibility.npuTargetFromDeviceText("Qualcomm SM8750 for arm64")
        )
        assertEquals(
            "mt6993",
            OnDeviceCompatibility.npuTargetFromDeviceText("MediaTek MT6993")
        )
        assertEquals(
            "google_tensor_g5",
            OnDeviceCompatibility.npuTargetFromDeviceText("Google Tensor G5")
        )
        assertNull(OnDeviceCompatibility.npuTargetFromDeviceText("unknown-chip"))
    }

    @Test
    fun recognizesChipTargetEncodedInModelFileName() {
        assertEquals(
            "sm8650",
            OnDeviceCompatibility.targetFromModelName(
                "Gemma3-1B-IT_q4_ekv1280_sm8650.litertlm"
            )
        )
        assertEquals(
            "mt6991",
            OnDeviceCompatibility.targetFromModelName(
                "gemma3-270m-it-q8.mediatek.mt6991.litertlm"
            )
        )
        assertEquals(
            "google_tensor_g5",
            OnDeviceCompatibility.targetFromModelName(
                "Gemma3-1B-IT_q8_ekv1280_Google_Tensor_G5.litertlm"
            )
        )
    }

    @Test
    fun rejectsNpuModelCompiledForDifferentChip() {
        val profile = DeviceAiProfile(
            deviceName = "Test phone",
            socName = "SM8750",
            npuTarget = "sm8750",
            recommendedNpuFile = "Gemma3-1B-IT_q4_ekv1280_sm8750.litertlm"
        )

        assertNull(
            OnDeviceCompatibility.compatibilityError(
                "Gemma3-1B-IT_q4_ekv1280_sm8750.litertlm",
                profile
            )
        )
        assertNull(
            OnDeviceCompatibility.compatibilityError(
                "gemma3-1b-it-int4.litertlm",
                profile
            )
        )
        assertTrue(
            OnDeviceCompatibility.compatibilityError(
                "Gemma3-1B-IT_q4_ekv1280_sm8650.litertlm",
                profile
            ).orEmpty().contains("sm8650")
        )
    }

    @Test
    fun migratesFormerPcProviderToOnDeviceProvider() {
        assertEquals(AiProvider.ON_DEVICE, AiProvider.fromStorage("local_server"))
    }

    @Test
    fun onDeviceSettingsRequireImportedModel() {
        val settings = QuestSettings(
            provider = AiProvider.ON_DEVICE,
            endpoint = "",
            model = "",
            apiKey = "",
            questPrompt = "일본어 문제",
            onDeviceModelPath = ""
        )

        assertTrue(settings.validationError().orEmpty().contains(".litertlm"))
    }

    @Test
    fun keepsHumanReadableErrorsForAdvancedServers() {
        val message = ConnectionGuide.explainFailure(
            AiProvider.OPENAI_COMPATIBLE,
            ConnectException("Connection refused")
        )

        assertTrue(message.contains("서버에 연결되지 않았습니다"))
    }

    @Test
    fun plansNpuFirstOnlyForRecognizedCompatibleDevices() {
        assertEquals(
            listOf(
                ActiveOnDeviceBackend.NPU,
                ActiveOnDeviceBackend.GPU,
                ActiveOnDeviceBackend.CPU
            ),
            OnDeviceBackendPlanner.candidates(OnDeviceAcceleration.AUTO, npuAvailable = true)
        )
        assertEquals(
            listOf(ActiveOnDeviceBackend.GPU, ActiveOnDeviceBackend.CPU),
            OnDeviceBackendPlanner.candidates(OnDeviceAcceleration.AUTO, npuAvailable = false)
        )
    }
}
