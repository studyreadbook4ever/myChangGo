import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createKioskProviders, validatePcmWav } from '../lib/kiosk-providers.ts';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const env = { CLOVA_SPEECH_INVOKE_URL: 'https://clovaspeech-gw.ncloud.com/external/v1/1/test', CLOVA_SPEECH_SECRET: 'unit-speech-secret', PAPAGO_CLIENT_ID: 'unit-papago-id', PAPAGO_CLIENT_SECRET: 'unit-papago-secret', CLOVA_STUDIO_API_KEY: 'unit-studio-secret' };
const menu = [{ id: 'udon', name: { ko: '온기 가득 우동', en: 'Comfort udon', zh: '暖心乌冬面' } }, { id: 'yuzu-ade', name: { ko: '유자 에이드', en: 'Sparkling yuzu', zh: '柚子气泡水' } }];
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const modelResult = (output) => json({ status: { code: '20000' }, result: { finishReason: 'stop', message: { content: JSON.stringify(output) } } });
function wav(seconds = 1) {
  const buffer = new ArrayBuffer(44 + 32000 * seconds), v = new DataView(buffer), bytes = new Uint8Array(buffer);
  const write = (at, value) => bytes.set(new TextEncoder().encode(value), at);
  write(0, 'RIFF'); v.setUint32(4, buffer.byteLength - 8, true); write(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); write(36, 'data'); v.setUint32(40, buffer.byteLength - 44, true);
  return bytes;
}

test('strict WAV parser accepts PCM mono16k and rejects malformed, compressed, long and stereo data', () => {
  assert.equal(validatePcmWav(wav()).length, 32044);
  assert.equal(validatePcmWav(wav(65).buffer).length, 2080044);
  for (const modify of [
    (v) => v.setUint16(20, 3, true), (v) => v.setUint16(22, 2, true),
    (v) => v.setUint32(24, 48000, true), (v) => v.setUint32(28, 96000, true),
    (v) => v.setUint16(32, 4, true), (v) => v.setUint16(34, 32, true),
    (v) => v.setUint32(4, 0xffffffff, true), (v) => v.setUint32(40, 0xffffffff, true),
  ]) {
    const bytes = wav(); modify(new DataView(bytes.buffer));
    assert.throws(() => validatePcmWav(bytes), (error) => error.code === 'INVALID_AUDIO');
  }
  assert.throws(() => validatePcmWav(wav(66)), (error) => error.code === 'INVALID_AUDIO_SIZE');
  assert.throws(() => validatePcmWav(wav().subarray(0, 200)), (error) => error.code === 'INVALID_AUDIO');
});

test('Speech directly sends WAV, exact selected language and raw text, with no menu bias on service', async () => {
  const provider = createKioskProviders({ ...env, CLOVA_SPEECH_MENU_BOOSTING: 'true' });
  globalThis.fetch = async (url, options) => {
    assert.equal(url, env.CLOVA_SPEECH_INVOKE_URL + '/recognizer/upload');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers['X-CLOVASPEECH-API-KEY'], env.CLOVA_SPEECH_SECRET);
    const params = JSON.parse(options.body.get('params'));
    assert.equal(params.language, 'en-US'); assert.equal(params.completion, 'sync');
    assert.equal(params.boostings, undefined); assert.equal(params.useDomainBoostings, undefined);
    assert.deepEqual(new Uint8Array(await options.body.get('media').arrayBuffer()), wav());
    return json({ result: 'COMPLETED', text: '  Water, please.\nNo ice. ' });
  };
  assert.equal(await provider.transcribe({ buffer: wav(), mimeType: 'audio/wav', language: 'en', kind: 'service', menu }), '  Water, please.\nNo ice. ');
});

test('menu boosting is default off, ko/en-order only, and uses modest exact catalog hints', async () => {
  const requests = [];
  globalThis.fetch = async (_url, options) => { requests.push(JSON.parse(options.body.get('params'))); return json({ result: 'COMPLETED', text: 'UDON' }); };
  await createKioskProviders(env).transcribe({ buffer: wav(), mimeType: 'audio/wav', language: 'en', kind: 'order', menu });
  const provider = createKioskProviders({ ...env, CLOVA_SPEECH_MENU_BOOSTING: 'true' });
  for (const language of ['en', 'ko', 'ja', 'zh']) await provider.transcribe({ buffer: wav(), mimeType: 'audio/wav', language, kind: 'order', menu });
  assert.equal(requests[0].boostings, undefined);
  assert.ok(requests[1].boostings.some((entry) => entry.words === 'udon' && entry.weight === '1'));
  assert.ok(requests[2].boostings.some((entry) => entry.words === '우동' && entry.weight === '1'));
  assert.equal(requests[3].boostings, undefined); assert.equal(requests[4].boostings, undefined);
});

test('invalid audio, missing credentials and nonofficial Speech URL fail without network calls', async () => {
  globalThis.fetch = async () => { throw new Error('Unexpected network'); };
  await assert.rejects(createKioskProviders({}).transcribe({ buffer: wav(), mimeType: 'audio/wav', language: 'ko' }), (error) => error.code === 'PROVIDER_NOT_CONFIGURED');
  await assert.rejects(createKioskProviders(env).transcribe({ buffer: wav(), mimeType: 'audio/webm', language: 'ko' }), (error) => error.code === 'INVALID_AUDIO_TYPE');
  await assert.rejects(createKioskProviders({ ...env, CLOVA_SPEECH_INVOKE_URL: 'https://example.com/secret' }).transcribe({ buffer: wav(), mimeType: 'audio/wav', language: 'ko' }), (error) => error.code === 'INVALID_SPEECH_URL');
});

test('Papago maps Chinese, preserves same-language input and caches bounded translations', async () => {
  let calls = 0; const provider = createKioskProviders(env);
  globalThis.fetch = async (url, options) => {
    calls++; assert.equal(url, 'https://papago.apigw.ntruss.com/nmt/v1/translation');
    assert.deepEqual(JSON.parse(options.body), { source: 'zh-CN', target: 'ko', text: '请给我柚子气泡水-Workers-test' });
    assert.equal(options.headers['X-NCP-APIGW-API-KEY'], env.PAPAGO_CLIENT_SECRET);
    return json({ message: { result: { translatedText: '유자 에이드 주세요.' } } });
  };
  const input = { text: '请给我柚子气泡水-Workers-test', source: 'zh', target: 'ko' };
  assert.equal(await provider.translate(input), '유자 에이드 주세요.'); await provider.translate(input);
  assert.equal(await provider.translate({ text: '  그대로 ', source: 'ko', target: 'ko' }), '  그대로 ');
  assert.equal(calls, 1);
});

test('Studio receives original Chinese alongside unchanged Korean translation and exact catalog anchors', async () => {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://clovastudio.stream.ntruss.com/v3/chat-completions/HCX-007');
    assert.equal(options.headers.Authorization, `Bearer ${env.CLOVA_STUDIO_API_KEY}`);
    const body = JSON.parse(options.body), user = JSON.parse(body.messages.at(-1).content);
    assert.equal(body.responseFormat.type, 'json');
    const branches = body.responseFormat.schema.properties.operations.items.anyOf;
    assert.deepEqual(branches.map((branch) => ({ actions: branch.properties.action.enum, minimum: branch.properties.quantity.minimum })), [{ actions: ['add', 'remove'], minimum: 1 }, { actions: ['set'], minimum: 0 }]);
    assert.equal(user.originalTranscript, '请给我柚子气泡水。');
    assert.equal(user.translatedKorean, '자몽 탄산수 주세요.');
    assert.deepEqual(user.exactCatalogMentions, [{ itemId: 'yuzu-ade', localizedName: '柚子气泡水', koreanName: '유자 에이드' }]);
    assert.match(body.messages[0].content, /승인 전 조리/);
    assert.match(body.messages[0].content, /추가하지 말라는 말은 현재 장바구니에서 삭제하라는 뜻이 아닙니다/);
    return modelResult({ replyKo: '장바구니에 담았어요. 확인해 주세요.', operations: [{ itemId: 'yuzu-ade', quantity: 1, action: 'add' }], serviceRequest: false });
  };
  const output = await createKioskProviders(env).chat({ text: '자몽 탄산수 주세요.', originalText: '请给我柚子气泡水。', originalLanguage: 'zh', language: 'ko', menu });
  assert.equal(output.operations[0].itemId, 'yuzu-ade');
});

test('Studio rejects extra authorization fields, unknown menus, duplicate operations and invalid quantities', async () => {
  for (const output of [
    { replyKo: '확정', operations: [], approved: true },
    { replyKo: '추가', operations: [{ itemId: 'unknown', quantity: 1, action: 'add' }] },
    { replyKo: '추가', operations: [{ itemId: 'udon', quantity: 1, action: 'add' }, { itemId: 'udon', quantity: 1, action: 'remove' }] },
    { replyKo: '추가', operations: [{ itemId: 'udon', quantity: 0, action: 'add' }] },
    { replyKo: '추가', operations: [{ itemId: 'udon', quantity: 2, action: 'add' }, { itemId: 'yuzu-ade', quantity: 0, action: 'remove' }] },
  ]) {
    globalThis.fetch = async () => modelResult(output);
    await assert.rejects(createKioskProviders(env).chat({ text: '요청', language: 'ko', menu }), (error) => ['INVALID_CHAT_RESPONSE', 'INVALID_MENU_OPERATION'].includes(error.code));
  }
});

test('transient statuses retry at most twice; credentials and network errors remain sanitized', async () => {
  let calls = 0; const provider = createKioskProviders(env);
  globalThis.fetch = async () => { calls++; return json({ message: env.PAPAGO_CLIENT_SECRET }, 503); };
  await assert.rejects(provider.translate({ text: 'retry workers unit', source: 'en', target: 'ko' }), (error) => error.code === 'PROVIDER_HTTP_503');
  assert.equal(calls, 3); calls = 0;
  globalThis.fetch = async () => { calls++; return json({ message: env.PAPAGO_CLIENT_SECRET }, 401); };
  await assert.rejects(provider.translate({ text: 'auth workers unit', source: 'en', target: 'ko' }), (error) => error.code === 'PROVIDER_HTTP_401' && !JSON.stringify(error).includes(env.PAPAGO_CLIENT_SECRET));
  assert.equal(calls, 1);
  globalThis.fetch = async () => { throw new Error(env.PAPAGO_CLIENT_SECRET); };
  await assert.rejects(provider.translate({ text: 'network workers unit', source: 'en', target: 'ko' }), (error) => error.code === 'PROVIDER_NETWORK_ERROR' && !error.message.includes(env.PAPAGO_CLIENT_SECRET));
});

test('Workers manual mode blocks every redirect class without retries or forwarding provider credentials', async () => {
  const provider = createKioskProviders(env);
  for (const status of [300, 301, 302, 303, 304, 307, 308, 399]) {
    for (const stage of ['speech', 'translation', 'chat']) {
      const requested = [];
      globalThis.fetch = async (url, options) => {
        assert.equal(options.redirect, 'manual', 'Workers must not receive unsupported redirect:error or credential-forwarding follow');
        requested.push(url);
        return new Response(null, { status, headers: { location: `https://redirect.invalid/collect?secret=${env.PAPAGO_CLIENT_SECRET}` } });
      };
      const call = stage === 'speech' ? provider.transcribe({ buffer: wav(), mimeType: 'audio/wav', language: 'en', kind: 'service' })
        : stage === 'translation' ? provider.translate({ text: `redirect contract ${status}`, source: 'en', target: 'ko' })
        : provider.chat({ text: '메뉴 질문', language: 'ko', menu });
      await assert.rejects(call, (error) => error.code === 'PROVIDER_REDIRECT_BLOCKED' && error.stage === stage && error.status === 502 && error.upstreamStatus === status && error.retryable === false && !JSON.stringify(error).includes('redirect.invalid') && !JSON.stringify(error).includes(env.PAPAGO_CLIENT_SECRET));
      assert.equal(requested.length, 1, 'Redirects must not be retried or followed');
      assert.ok(requested.every((url) => !url.includes('redirect.invalid')));
    }
  }
});

test('Voice output is always disabled and health never exposes credentials', async () => {
  globalThis.fetch = async () => { throw new Error('Voice must never call a provider'); };
  const provider = createKioskProviders(env), status = provider.providerStatus();
  assert.equal(status.voice.available, false); assert.equal(status.audioOutputEnabled, false);
  assert.equal(status.ready, true); assert.ok(!JSON.stringify(status).includes('unit-'));
  await assert.rejects(provider.synthesize(), (error) => error.code === 'AUDIO_OUTPUT_DISABLED' && error.status === 409);
});
