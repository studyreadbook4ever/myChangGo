import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { PcmWavRecorder, encodePcmWav } from '../components/order/recorder.ts';

const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const oldWorkletNode = Object.getOwnPropertyDescriptor(globalThis, 'AudioWorkletNode');
afterEach(() => {
  if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else delete globalThis.window;
  if (oldNavigator) Object.defineProperty(globalThis, 'navigator', oldNavigator); else delete globalThis.navigator;
  if (oldWorkletNode) Object.defineProperty(globalThis, 'AudioWorkletNode', oldWorkletNode); else delete globalThis.AudioWorkletNode;
});
function fakeBrowser(getUserMedia, audioWorklet) {
  const contexts = [];
  const node = () => ({ connections: [], connect(target) { this.connections.push(target); }, disconnect() { this.disconnected = true; } });
  class Context {
    constructor() { contexts.push(this); this.sampleRate = 48000; this.state = 'running'; this.destination = {}; this.audioWorklet = audioWorklet; }
    async resume() {}
    async close() { this.state = 'closed'; }
    createMediaStreamSource() { this.source = node(); return this.source; }
    createGain() { this.mute = { ...node(), gain: { value: 1 } }; return this.mute; }
    createScriptProcessor() { this.processor = { ...node(), onaudioprocess: null }; return this.processor; }
  }
  Object.defineProperty(globalThis, 'window', { value: { AudioContext: Context }, configurable: true });
  Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices: { getUserMedia } }, configurable: true });
  return contexts;
}
function stream() { const track = { stops: 0, stop() { this.stops++; } }; return { track, getTracks: () => [track] }; }
function input(context, samples = new Float32Array(4800).fill(0.5)) {
  const output = new Float32Array(samples.length).fill(1);
  context.processor.onaudioprocess({ inputBuffer: { getChannelData: () => samples }, outputBuffer: { numberOfChannels: 1, getChannelData: () => output } });
  return output;
}

test('pure encoding produces bounded exact mono16k PCM WAV and clips out-of-range samples', async () => {
  const blob = encodePcmWav([new Float32Array(48000).fill(0.5)], 48000);
  const bytes = await blob.arrayBuffer(), v = new DataView(bytes);
  assert.equal(blob.type, 'audio/wav'); assert.equal(bytes.byteLength, 32044);
  assert.equal(v.getUint32(4, true), bytes.byteLength - 8); assert.equal(v.getUint16(22, true), 1);
  assert.equal(v.getUint32(24, true), 16000); assert.equal(v.getUint16(34, true), 16);
  assert.equal(v.getInt16(44, true), 16384);
  const clipped = new DataView(await encodePcmWav([Float32Array.of(2, -2, NaN)], 16000).arrayBuffer());
  assert.equal(clipped.getInt16(44, true), 32767); assert.equal(clipped.getInt16(46, true), -32768); assert.equal(clipped.getInt16(48, true), 0);
});

test('only explicit start requests microphone; output stays zero and stop closes tracks/context', async () => {
  let calls = 0; const media = stream(); const contexts = fakeBrowser(async () => { calls++; return media; });
  const recorder = new PcmWavRecorder(); assert.equal(calls, 0);
  await recorder.start(); assert.equal(calls, 1); assert.equal(contexts[0].mute.gain.value, 0);
  assert.deepEqual(contexts[0].source.connections, [contexts[0].processor]);
  assert.ok(input(contexts[0]).every((value) => value === 0));
  const blob = await recorder.stop(); assert.equal(blob.type, 'audio/wav');
  assert.equal(media.track.stops, 1); assert.equal(contexts[0].state, 'closed');
  await assert.rejects(recorder.stop(), (error) => error.code === 'RECORDER_NOT_RECORDING');
});

test('cancel pending permission rejects promptly and stops a late grant without affecting a new recording', async () => {
  let resolveOld; const old = stream(), current = stream(); let calls = 0;
  const contexts = fakeBrowser(() => ++calls === 1 ? new Promise((resolve) => { resolveOld = resolve; }) : Promise.resolve(current));
  const recorder = new PcmWavRecorder(); const pending = recorder.start();
  await recorder.cancel(); await assert.rejects(pending, (error) => error.name === 'AbortError');
  await recorder.start(); resolveOld(old); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(old.track.stops, 1); assert.equal(current.track.stops, 0);
  input(contexts[1]); await recorder.cancel(); assert.equal(current.track.stops, 1);
});

test('double start is rejected, and sample-duration limit completes once without manual duplicate', async () => {
  const media = stream(), contexts = fakeBrowser(async () => media); let limited = 0, resolveLimit;
  const limit = new Promise((resolve) => { resolveLimit = resolve; });
  const recorder = new PcmWavRecorder({ maxDurationMs: 1000, onLimit: (blob) => { limited++; resolveLimit(blob); } });
  await recorder.start(); await assert.rejects(recorder.start(), (error) => error.code === 'RECORDER_BUSY');
  input(contexts[0], new Float32Array(60000).fill(0.2));
  const blob = await limit; assert.equal(blob.size, 32044); assert.equal(limited, 1);
  await assert.rejects(recorder.stop(), (error) => error.code === 'RECORDER_NOT_RECORDING');
  assert.equal(media.track.stops, 1);
});

test('worklet path captures PCM through its port while both processor and final gain stay silent', async () => {
  let workletClass, posted;
  const media = stream();
  const contexts = fakeBrowser(async () => media, { async addModule(url) {
    const source = await (await fetch(url)).text(); // Local blob URL only; no network or audio device.
    vm.runInNewContext(source, {
      Float32Array,
      AudioWorkletProcessor: class { constructor() { this.port = { postMessage(value) { posted = value; } }; } },
      registerProcessor(name, implementation) { assert.equal(name, 'damda-pcm-capture'); workletClass = implementation; },
    });
  } });
  class WorkletNode {
    constructor(context) { context.processor = this; this.connections = []; this.port = { onmessage: null, close() { this.closed = true; } }; }
    connect(target) { this.connections.push(target); }
    disconnect() { this.disconnected = true; }
  }
  Object.defineProperty(globalThis, 'AudioWorkletNode', { value: WorkletNode, configurable: true });
  const recorder = new PcmWavRecorder(); await recorder.start();
  const processor = new workletClass(), samples = new Float32Array(4800).fill(0.4), output = new Float32Array(4800).fill(1);
  assert.equal(processor.process([[samples]], [[output]]), true);
  assert.ok(output.every((sample) => sample === 0)); assert.notEqual(posted, samples); assert.equal(posted[0], samples[0]);
  contexts[0].processor.port.onmessage({ data: posted });
  assert.equal(contexts[0].mute.gain.value, 0);
  assert.equal((await recorder.stop()).size, 3244);
  assert.equal(contexts[0].processor.port.closed, true); assert.equal(media.track.stops, 1);
});
