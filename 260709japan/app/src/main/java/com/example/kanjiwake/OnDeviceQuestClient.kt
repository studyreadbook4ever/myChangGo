package com.example.kanjiwake

import android.content.Context
import com.google.ai.edge.litertlm.Backend
import com.google.ai.edge.litertlm.Content
import com.google.ai.edge.litertlm.Contents
import com.google.ai.edge.litertlm.ConversationConfig
import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.EngineConfig
import com.google.ai.edge.litertlm.SamplerConfig
import java.io.File
import kotlin.random.Random

enum class ActiveOnDeviceBackend(val displayName: String) {
    NPU("NPU"),
    GPU("GPU"),
    CPU("CPU")
}

data class OnDevicePreparation(
    val backend: ActiveOnDeviceBackend,
    val usedFallback: Boolean
) {
    fun statusText(): String = if (usedFallback) {
        "모델 준비 완료 · ${backend.displayName} 사용 · 앞선 가속기는 지원되지 않아 자동 전환됨"
    } else {
        "모델 준비 완료 · ${backend.displayName} 사용"
    }
}

object OnDeviceQuestClient {
    fun prepare(context: Context, settings: QuestSettings): OnDevicePreparation =
        OnDeviceEnginePool.prepare(context.applicationContext, settings)

    fun release() {
        OnDeviceEnginePool.release()
    }

    fun generate(
        context: Context,
        settings: QuestSettings,
        previousQuestion: String?
    ): GeneratedQuest {
        settings.validationError()?.let { error(it) }
        var parseFailure: Throwable? = null
        repeat(2) { attempt ->
            val raw = OnDeviceEnginePool.generateRaw(
                context.applicationContext,
                settings,
                QuestPromptContract.generationPrompt(
                    settings.questPrompt,
                    previousQuestion,
                    strictRetry = attempt > 0
                )
            )
            try {
                return QuestJsonParser.parse(raw)
            } catch (error: RuntimeException) {
                parseFailure = error
            }
        }
        throw IllegalStateException(
            "휴대폰 모델이 올바른 4지선다 형식으로 답하지 못했습니다. 더 큰 지시형 모델을 선택하거나 프롬프트를 단순하게 바꿔 주세요.",
            parseFailure
        )
    }
}

private object OnDeviceEnginePool {
    private var engine: Engine? = null
    private var requestKey: EngineRequestKey? = null
    private var preparation: OnDevicePreparation? = null

    @Synchronized
    fun prepare(context: Context, settings: QuestSettings): OnDevicePreparation {
        val file = OnDeviceModelStore.existingFile(context, settings.onDeviceModelPath)
            ?: error("가져온 모델 파일을 찾을 수 없습니다. 설정에서 .litertlm 파일을 다시 선택해 주세요.")
        OnDeviceCompatibility.compatibilityError(
            OnDeviceModelStore.fileLabel(file.absolutePath),
            OnDeviceCompatibility.currentProfile()
        )?.let { error(it) }

        val key = EngineRequestKey(
            file.absolutePath,
            file.lastModified(),
            settings.onDeviceAcceleration
        )
        if (requestKey == key && engine?.isInitialized() == true) {
            return checkNotNull(preparation)
        }

        closeLocked()
        val failures = mutableListOf<String>()
        val profile = OnDeviceCompatibility.currentProfile()
        val modelTarget = OnDeviceCompatibility.targetFromModelName(
            OnDeviceModelStore.fileLabel(file.absolutePath)
        )
        val npuAvailable = profile.npuTarget != null && modelTarget == profile.npuTarget
        val candidates = OnDeviceBackendPlanner.candidates(
            settings.onDeviceAcceleration,
            npuAvailable
        )
        val skippedNpu = settings.onDeviceAcceleration == OnDeviceAcceleration.AUTO && !npuAvailable
        candidates.forEachIndexed { index, activeBackend ->
            var candidate: Engine? = null
            try {
                candidate = Engine(
                    EngineConfig(
                        modelPath = file.absolutePath,
                        backend = activeBackend.toLiteRtBackend(context),
                        maxNumTokens = MAX_CONTEXT_TOKENS,
                        cacheDir = File(context.cacheDir, "litertlm").apply { mkdirs() }.absolutePath
                    )
                )
                candidate.initialize()
                engine = candidate
                requestKey = key
                return OnDevicePreparation(
                    backend = activeBackend,
                    usedFallback = index > 0 || skippedNpu
                ).also { preparation = it }
            } catch (error: Throwable) {
                if (error is VirtualMachineError || error is ThreadDeath) throw error
                runCatching { candidate?.close() }
                failures += "${activeBackend.displayName}: ${readableFailure(error)}"
            }
        }
        throw IllegalStateException(
            "이 모델을 휴대폰에서 열지 못했습니다. 기기와 맞는 .litertlm 파일인지와 저장 공간을 확인해 주세요.",
            IllegalStateException(failures.joinToString(" / "))
        )
    }

    @Synchronized
    fun generateRaw(context: Context, settings: QuestSettings, userPrompt: String): String {
        prepare(context, settings)
        val activeEngine = engine ?: error("온디바이스 모델이 준비되지 않았습니다.")
        val config = ConversationConfig(
            systemInstruction = Contents.of(QuestPromptContract.SYSTEM_INSTRUCTION),
            samplerConfig = SamplerConfig(
                topK = 40,
                topP = 0.95,
                temperature = 0.7,
                seed = Random.nextInt()
            )
        )
        return activeEngine.createConversation(config).use { conversation ->
            val message = conversation.sendMessage(userPrompt)
            message.contents.contents
                .filterIsInstance<Content.Text>()
                .joinToString(separator = "") { it.text }
                .ifBlank { error("휴대폰 모델이 빈 응답을 반환했습니다.") }
        }
    }

    @Synchronized
    fun release() {
        closeLocked()
    }

    private fun ActiveOnDeviceBackend.toLiteRtBackend(context: Context): Backend = when (this) {
        ActiveOnDeviceBackend.NPU -> Backend.NPU(
            nativeLibraryDir = context.applicationInfo.nativeLibraryDir
        )
        ActiveOnDeviceBackend.GPU -> Backend.GPU()
        ActiveOnDeviceBackend.CPU -> Backend.CPU()
    }

    private fun readableFailure(error: Throwable): String {
        val message = generateSequence(error as Throwable?) { it.cause }
            .mapNotNull { it.message?.takeIf(String::isNotBlank) }
            .firstOrNull()
        return message?.take(180) ?: error::class.java.simpleName
    }

    private fun closeLocked() {
        runCatching { engine?.close() }
        engine = null
        requestKey = null
        preparation = null
    }

    private data class EngineRequestKey(
        val modelPath: String,
        val lastModified: Long,
        val acceleration: OnDeviceAcceleration
    )

    private const val MAX_CONTEXT_TOKENS = 1280
}

internal object OnDeviceBackendPlanner {
    fun candidates(
        acceleration: OnDeviceAcceleration,
        npuAvailable: Boolean
    ): List<ActiveOnDeviceBackend> = when (acceleration) {
        OnDeviceAcceleration.AUTO -> buildList {
            if (npuAvailable) add(ActiveOnDeviceBackend.NPU)
            add(ActiveOnDeviceBackend.GPU)
            add(ActiveOnDeviceBackend.CPU)
        }
        OnDeviceAcceleration.GPU -> listOf(
            ActiveOnDeviceBackend.GPU,
            ActiveOnDeviceBackend.CPU
        )
        OnDeviceAcceleration.CPU -> listOf(ActiveOnDeviceBackend.CPU)
    }
}
