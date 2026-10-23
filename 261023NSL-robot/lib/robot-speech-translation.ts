import { z } from 'zod';

/** Server-only configuration; never serialize credential values. */
export type RobotProviderEnv = {
  CLOVA_SPEECH_INVOKE_URL?: string; CLOVA_SPEECH_SECRET?: string;
  PAPAGO_CLIENT_ID?: string; PAPAGO_CLIENT_SECRET?: string;
  CLOVA_STUDIO_API_KEY?: string; CLOVA_STUDIO_MODEL?: string;
  CLOVA_VOICE_CLIENT_ID?: string; CLOVA_VOICE_CLIENT_SECRET?: string;
};
export type ProviderStage = 'speech' | 'translation' | 'chat' | 'tts';
export class RobotProviderError extends Error {
  stage: ProviderStage; code: string; status: number; retryable: boolean; upstreamStatus?: number;
  constructor(stage: ProviderStage, code: string, message: string, status = 502, retryable = false) {
    super(message); this.name = 'RobotProviderError'; this.stage = stage; this.code = code; this.status = status; this.retryable = retryable;
  }
}
export function providerProblem(stage: ProviderStage, code: string, message: string, status = 502, retryable = false) {
  return new RobotProviderError(stage, code, message, status, retryable);
}
export const providerLanguages = {
  ko: { speech: 'ko-KR', translation: 'ko', speaker: 'nara' },
  en: { speech: 'en-US', translation: 'en', speaker: 'clara' },
  ja: { speech: 'ja', translation: 'ja', speaker: 'nsayuri' },
  zh: { speech: 'zh-cn', translation: 'zh-CN', speaker: 'meimei' },
} as const;
export function languageConfig(language: string, stage: ProviderStage) {
  if (!Object.hasOwn(providerLanguages, language)) throw providerProblem(stage, 'UNSUPPORTED_LANGUAGE', '지원하지 않는 언어입니다.', 400);
  return providerLanguages[language as keyof typeof providerLanguages];
}
export function boundedText(text: string, stage: ProviderStage, maximum = 5000) {
  if (typeof text !== 'string' || !text.trim() || text.length > maximum) throw providerProblem(stage, 'INVALID_TEXT', `텍스트는 1~${maximum}자로 입력해 주세요.`, 400);
}

/** Reject compressed audio, oversized/truncated RIFF, and ambiguous chunks before contacting Speech. */
export function validatePcmWav(input: ArrayBuffer | Uint8Array): Uint8Array<ArrayBuffer> {
  const bytes = input instanceof Uint8Array ? input : input instanceof ArrayBuffer ? new Uint8Array(input) : null;
  const invalid = () => providerProblem('speech', 'INVALID_AUDIO', '16kHz 모노 PCM WAV 녹음이 필요합니다.', 400);
  if (!bytes || bytes.byteLength < 46 || bytes.byteLength > 16000 * 2 * 65 + 4096) throw providerProblem('speech', 'INVALID_AUDIO_SIZE', '녹음은 65초 이내의 WAV 파일이어야 합니다.', 413);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (ascii(0) !== 'RIFF' || ascii(8) !== 'WAVE' || view.getUint32(4, true) !== bytes.length - 8) throw invalid();
  let offset = 12, format = false, dataBytes = 0, chunks = 0;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length || ++chunks > 32) throw invalid();
    const name = ascii(offset), length = view.getUint32(offset + 4, true), begin = offset + 8;
    if (length > bytes.length - begin || begin + length + (length % 2) > bytes.length) throw invalid();
    if (name === 'fmt ') {
      if (format || length !== 16 || view.getUint16(begin, true) !== 1 || view.getUint16(begin + 2, true) !== 1 || view.getUint32(begin + 4, true) !== 16000 || view.getUint32(begin + 8, true) !== 32000 || view.getUint16(begin + 12, true) !== 2 || view.getUint16(begin + 14, true) !== 16) throw invalid();
      format = true;
    } else if (name === 'data') {
      if (!format || dataBytes || !length || length % 2 || length > 16000 * 2 * 65) throw invalid();
      dataBytes = length;
    }
    offset = begin + length + (length % 2);
  }
  if (!format || !dataBytes || offset !== bytes.length) throw invalid();
  const copy = new Uint8Array(bytes.length); copy.set(bytes); return copy;
}


async function responseBytes(response: Response, stage: ProviderStage, maximum: number) {
  if (Number(response.headers.get('content-length')) > maximum) { await response.body?.cancel(); throw providerProblem(stage, 'PROVIDER_RESPONSE_TOO_LARGE', 'API 응답 크기가 너무 큽니다.'); }
  const reader = response.body?.getReader();
  if (!reader) throw providerProblem(stage, 'INVALID_PROVIDER_RESPONSE', 'API 응답을 받지 못했습니다.');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const result = await reader.read(); if (result.done) break;
      size += result.value.byteLength;
      if (size > maximum) { await reader.cancel(); throw providerProblem(stage, 'PROVIDER_RESPONSE_TOO_LARGE', 'API 응답 크기가 너무 큽니다.'); }
      chunks.push(result.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

/** Entire stage deadline includes retries and body reading. Never follow a credential-bearing redirect. */
export async function providerRequest(stage: ProviderStage, url: string, init: RequestInit, options: { timeout?: number; audio?: boolean } = {}): Promise<unknown> {
  const deadline = Date.now() + (options.timeout ?? 20000);
  for (let attempt = 0; attempt < 3; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw providerProblem(stage, 'PROVIDER_TIMEOUT', 'API 응답이 지연되고 있습니다.', 504, true);
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), Math.min(12000, remaining));
    let retryDelay: number | undefined;
    try {
      // https://developers.cloudflare.com/workers/runtime-apis/request/
      const response = await fetch(url, { ...init, redirect: 'manual', signal: abort.signal });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        const error = providerProblem(stage, 'PROVIDER_REDIRECT_BLOCKED', '외부 API 주소가 변경되어 요청을 중단했습니다.');
        error.upstreamStatus = response.status; throw error;
      }
      if (response.ok) {
        const bytes = await responseBytes(response, stage, options.audio ? 4 * 1024 * 1024 : 2 * 1024 * 1024);
        if (options.audio) {
          const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
          const mp3 = bytes.length >= 4 && ((bytes[0] === 73 && bytes[1] === 68 && bytes[2] === 51) || (bytes[0] === 255 && (bytes[1] & 224) === 224));
          if (!['audio/mpeg', 'audio/mp3', 'audio/x-mpeg'].includes(contentType || '') || !mp3) throw providerProblem(stage, 'INVALID_TTS_AUDIO', '음성 응답 형식이 올바르지 않습니다.');
          return bytes;
        }
        try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw providerProblem(stage, 'INVALID_PROVIDER_JSON', 'API 응답을 해석할 수 없습니다.'); }
      }
      await response.body?.cancel();
      const status = response.status, retryable = status === 429 || (status >= 500 && status <= 599);
      const error = providerProblem(stage, `PROVIDER_HTTP_${status}`, status === 429 ? 'API 사용 한도에 도달했습니다.' : '외부 API 요청에 실패했습니다. 연결 설정을 확인해 주세요.', status === 429 ? 429 : 502, retryable);
      error.upstreamStatus = status;
      if (!retryable || attempt === 2) throw error;
      const seconds = Number(response.headers.get('retry-after'));
      retryDelay = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 2000) : 250 * 2 ** attempt;
    } catch (error) {
      if (error instanceof RobotProviderError) throw error;
      if (abort.signal.aborted) throw providerProblem(stage, 'PROVIDER_TIMEOUT', 'API 응답이 지연되고 있습니다.', 504, true);
      throw providerProblem(stage, 'PROVIDER_NETWORK_ERROR', '외부 API 연결을 확인해 주세요.', 503, true);
    } finally { clearTimeout(timer); }
    if (retryDelay !== undefined) {
      if (Date.now() + retryDelay >= deadline) throw providerProblem(stage, 'PROVIDER_TIMEOUT', 'API 응답이 지연되고 있습니다.', 504, true);
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    }
  }
  throw providerProblem(stage, 'PROVIDER_UNAVAILABLE', 'API에 연결할 수 없습니다.', 503);
}

const speechResponse = z.object({ result: z.string().optional(), text: z.string().optional() });
const translatedResponse = z.object({ message: z.object({ result: z.object({ translatedText: z.string().min(1).max(10000) }) }) });
export function createSpeechTranslation(bindings: RobotProviderEnv) {
  const env = { ...bindings };
  const value = (name: keyof RobotProviderEnv) => String(env[name] || '').trim();
  const cache = new Map<string, { text: string; expires: number }>();
  async function transcribe(input: { buffer: ArrayBuffer | Uint8Array; mimeType: string; language: string }) {
    if (!value('CLOVA_SPEECH_INVOKE_URL') || !value('CLOVA_SPEECH_SECRET')) throw providerProblem('speech', 'PROVIDER_NOT_CONFIGURED', 'Speech 연결 설정이 없습니다.', 503);
    const language = languageConfig(input.language, 'speech');
    if (!/^audio\/(wav|wave|x-wav)(;|$)/i.test(input.mimeType)) throw providerProblem('speech', 'INVALID_AUDIO_TYPE', 'PCM WAV 형식으로 다시 녹음해 주세요.', 415);
    const audio = validatePcmWav(input.buffer); let url: URL;
    try { url = new URL(value('CLOVA_SPEECH_INVOKE_URL')); } catch { throw providerProblem('speech', 'INVALID_SPEECH_URL', 'Speech Invoke URL 설정을 확인해 주세요.', 503); }
    if (url.protocol !== 'https:' || url.hostname !== 'clovaspeech-gw.ncloud.com' || url.port || url.username || url.password || url.search || url.hash) throw providerProblem('speech', 'INVALID_SPEECH_URL', '공식 Speech HTTPS 주소가 필요합니다.', 503);
    url.pathname = `${url.pathname.replace(/\/+$/, '').replace(/\/recognizer\/upload$/, '')}/recognizer/upload`;
    const form = new FormData();
    form.append('media', new Blob([audio], { type: 'audio/wav' }), 'robot-request.wav');
    // Staff/robot conversation always preserves raw speech, with no menu vocabulary bias.
    form.append('params', JSON.stringify({ language: language.speech, completion: 'sync', fullText: true, wordAlignment: false, diarization: { enable: false }, sed: { enable: false } }));
    const result = speechResponse.safeParse(await providerRequest('speech', url.href, { method: 'POST', headers: { 'X-CLOVASPEECH-API-KEY': value('CLOVA_SPEECH_SECRET') }, body: form }, { timeout: 25000 }));
    if (!result.success || (result.data.result && !['COMPLETED', 'SUCCEEDED'].includes(result.data.result))) throw providerProblem('speech', 'SPEECH_RECOGNITION_FAILED', '음성 인식을 완료하지 못했습니다.');
    const text = result.data.text;
    if (!text?.trim()) throw providerProblem('speech', 'NO_SPEECH', '음성을 인식하지 못했습니다. 다시 말씀해 주세요.', 422);
    if (text.length > 5000) throw providerProblem('speech', 'TRANSCRIPT_TOO_LONG', '음성을 더 짧게 녹음해 주세요.', 413);
    return text;
  }
  async function translate({ text, source, target }: { text: string; source: string; target: string }) {
    boundedText(text, 'translation');
    const from = languageConfig(source, 'translation').translation, to = languageConfig(target, 'translation').translation;
    if (from === to) return text;
    if (!value('PAPAGO_CLIENT_ID') || !value('PAPAGO_CLIENT_SECRET')) throw providerProblem('translation', 'PROVIDER_NOT_CONFIGURED', '번역 연결 설정이 없습니다.', 503);
    const key = JSON.stringify([from, to, text]), cached = cache.get(key);
    if (cached && cached.expires > Date.now()) { cache.delete(key); cache.set(key, cached); return cached.text; }
    cache.delete(key);
    const result = translatedResponse.safeParse(await providerRequest('translation', 'https://papago.apigw.ntruss.com/nmt/v1/translation', {
      method: 'POST', headers: { 'X-NCP-APIGW-API-KEY-ID': value('PAPAGO_CLIENT_ID'), 'X-NCP-APIGW-API-KEY': value('PAPAGO_CLIENT_SECRET'), 'Content-Type': 'application/json' }, body: JSON.stringify({ source: from, target: to, text }),
    }));
    if (!result.success || !result.data.message.result.translatedText.trim()) throw providerProblem('translation', 'INVALID_TRANSLATION', '번역 결과를 받지 못했습니다.');
    const translated = result.data.message.result.translatedText;
    cache.set(key, { text: translated, expires: Date.now() + 30 * 60 * 1000 });
    while (cache.size > 256) cache.delete(cache.keys().next().value!);
    return translated;
  }
  return { transcribe, translate };
}
