/** Browser-only PCM capture. Importing/constructing never requests microphone access. */
export type RecorderOptions = {
  maxDurationMs?: number;
  onLimit?: (audio: Blob) => void;
  onError?: (error: Error) => void;
};
type Capture = {
  state: 'starting' | 'recording' | 'finishing'; cancelled: boolean;
  context: AudioContext; stream?: MediaStream; source?: MediaStreamAudioSourceNode;
  processor?: ScriptProcessorNode | AudioWorkletNode; mute?: GainNode;
  chunks: Float32Array[]; sampleCount: number; startedAt: number; timer?: ReturnType<typeof setTimeout>;
  cancelPending: () => void;
};
const OUTPUT_RATE = 16000;
const abortError = () => new DOMException('Recording was cancelled.', 'AbortError');
function recorderError(code: string) { return Object.assign(new Error(code), { code }); }

/** Pure encoding helper: average downsampling, no AudioContext, speaker, or microphone. */
export function encodePcmWav(chunks: Float32Array[], sampleRate: number): Blob {
  if (!Number.isFinite(sampleRate) || sampleRate < 16000 || sampleRate > 192000) throw recorderError('UNSUPPORTED_SAMPLE_RATE');
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (!length || length > sampleRate * 65) throw recorderError('EMPTY_OR_LONG_RECORDING');
  const samples = new Float32Array(length); let offset = 0;
  for (const chunk of chunks) { samples.set(chunk, offset); offset += chunk.length; }
  const count = Math.floor(length * OUTPUT_RATE / sampleRate);
  if (!count) throw recorderError('EMPTY_OR_LONG_RECORDING');
  const buffer = new ArrayBuffer(44 + count * 2), view = new DataView(buffer);
  const ascii = (at: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)); };
  ascii(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, OUTPUT_RATE, true); view.setUint32(28, OUTPUT_RATE * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, count * 2, true);
  const ratio = sampleRate / OUTPUT_RATE;
  for (let i = 0; i < count; i++) {
    const from = i * ratio, to = Math.min((i + 1) * ratio, length); let sum = 0;
    for (let j = Math.floor(from); j < Math.ceil(to); j++) sum += (Number.isFinite(samples[j]) ? samples[j] : 0) * Math.max(0, Math.min(j + 1, to) - Math.max(j, from));
    const value = Math.max(-1, Math.min(1, sum / (to - from)));
    view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

// The processor copies input to its message port only. Every output sample stays zero.
const WORKLET_SOURCE = `
class DamdaPcmCapture extends AudioWorkletProcessor {
  process(inputs, outputs) {
    for (const output of outputs) for (const channel of output) channel.fill(0);
    const input = inputs[0] && inputs[0][0];
    if (input && input.length) { const copy = new Float32Array(input); this.port.postMessage(copy, [copy.buffer]); }
    return true;
  }
}
registerProcessor('damda-pcm-capture', DamdaPcmCapture);
`;

export class PcmWavRecorder {
  private active: Capture | null = null;
  private readonly options: RecorderOptions;
  private readonly maximum: number;
  constructor(options: RecorderOptions = {}) {
    this.options = options;
    const limit = options.maxDurationMs ?? 25000;
    this.maximum = Number.isFinite(limit) ? Math.max(1000, Math.min(60000, limit)) : 25000;
  }
  get durationMs() {
    const run = this.active;
    return run?.startedAt ? Math.min(this.maximum, Math.max(0, Date.now() - run.startedAt)) : 0;
  }
  async start(): Promise<void> {
    if (this.active) throw recorderError('RECORDER_BUSY');
    if (typeof window === 'undefined' || !navigator.mediaDevices?.getUserMedia) throw recorderError('MICROPHONE_UNAVAILABLE');
    const AudioContextClass = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) throw recorderError('MICROPHONE_UNAVAILABLE');
    // Resume inside the explicit start gesture. Nothing is connected to speakers here.
    const context = new AudioContextClass();
    let rejectPending: (reason: DOMException) => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => { rejectPending = reject; });
    // A catch is attached immediately; cancellation after start completes is harmless.
    void cancelled.catch(() => {});
    const run: Capture = { state: 'starting', cancelled: false, context, chunks: [], sampleCount: 0, startedAt: 0, cancelPending: () => rejectPending(abortError()) };
    this.active = run;
    const resumed = context.resume();
    void resumed.catch(() => {});
    try {
      const pendingStream = navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      // getUserMedia cannot be aborted. Dispose a late grant after cancellation.
      void pendingStream.then((stream) => { if (run.cancelled || this.active !== run) stream.getTracks().forEach((track) => track.stop()); }, () => {});
      run.stream = await Promise.race([pendingStream, cancelled]);
      if (run.cancelled || this.active !== run) throw abortError();
      await Promise.race([resumed, cancelled]);
      if (run.cancelled || this.active !== run) throw abortError();
      if (context.sampleRate < 16000 || context.sampleRate > 192000) throw recorderError('UNSUPPORTED_SAMPLE_RATE');
      run.source = context.createMediaStreamSource(run.stream);
      run.mute = context.createGain(); run.mute.gain.value = 0;
      const accept = (input: Float32Array) => {
        if (run.cancelled || run.state !== 'recording' || this.active !== run) return;
        const remaining = Math.floor(context.sampleRate * this.maximum / 1000) - run.sampleCount;
        if (remaining > 0) { const chunk = input.slice(0, remaining); run.chunks.push(chunk); run.sampleCount += chunk.length; }
        if (run.sampleCount >= Math.floor(context.sampleRate * this.maximum / 1000)) this.finishAtLimit(run);
      };
      if (context.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
        const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
        try {
          await Promise.race([context.audioWorklet.addModule(url), cancelled]);
          if (run.cancelled || this.active !== run) throw abortError();
          const processor = new AudioWorkletNode(context, 'damda-pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit' });
          processor.port.onmessage = (event: MessageEvent<Float32Array>) => { if (event.data instanceof Float32Array) accept(event.data); };
          run.processor = processor;
        } catch (error) {
          if (run.cancelled || this.active !== run) throw error;
          // Older browsers or a CSP that blocks blob worklets use silent legacy capture.
        } finally { URL.revokeObjectURL(url); }
      }
      if (!run.processor) {
        const processor = context.createScriptProcessor(4096, 1, 1);
        processor.onaudioprocess = (event) => {
          for (let channel = 0; channel < event.outputBuffer.numberOfChannels; channel++) event.outputBuffer.getChannelData(channel).fill(0);
          accept(event.inputBuffer.getChannelData(0));
        };
        run.processor = processor;
      }
      run.state = 'recording'; run.startedAt = Date.now();
      run.source.connect(run.processor); run.processor.connect(run.mute); run.mute.connect(context.destination);
      run.timer = setTimeout(() => this.finishAtLimit(run), this.maximum);
    } catch (error) {
      if (this.active === run) this.active = null;
      run.cancelled = true; await this.dispose(run);
      throw error;
    }
  }
  async stop(): Promise<Blob> {
    const run = this.active;
    if (!run || run.state !== 'recording') throw recorderError('RECORDER_NOT_RECORDING');
    return this.finish(run);
  }
  async cancel(): Promise<void> {
    const run = this.active; if (!run) return;
    this.active = null; run.cancelled = true; run.cancelPending(); run.chunks = [];
    await this.dispose(run);
  }
  private finishAtLimit(run: Capture) {
    if (run.cancelled || this.active !== run || run.state !== 'recording') return;
    void this.finish(run).then((blob) => this.options.onLimit?.(blob), (error: unknown) => {
      if (!run.cancelled) this.options.onError?.(error instanceof Error ? error : recorderError('RECORDING_FAILED'));
    });
  }
  private async finish(run: Capture): Promise<Blob> {
    run.state = 'finishing';
    await this.dispose(run);
    if (run.cancelled || this.active !== run) throw abortError();
    this.active = null;
    try { return encodePcmWav(run.chunks, run.context.sampleRate); }
    finally { run.chunks = []; }
  }
  private async dispose(run: Capture) {
    if (run.timer) clearTimeout(run.timer);
    if (run.processor) {
      if ('port' in run.processor) { run.processor.port.onmessage = null; run.processor.port.close(); }
      else run.processor.onaudioprocess = null;
    }
    // Stop tracks synchronously before any awaited cleanup; no recording survives cancel/stop.
    run.stream?.getTracks().forEach((track) => track.stop());
    for (const node of [run.source, run.processor, run.mute]) { try { node?.disconnect(); } catch { /* Already disconnected. */ } }
    if (run.context.state !== 'closed') { try { await run.context.close(); } catch { /* Already closing. */ } }
  }
}
