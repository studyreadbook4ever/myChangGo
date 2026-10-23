"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Check, CircleHelp, Globe2, Mic, RefreshCw, Square, Volume2, VolumeX } from "lucide-react";
import type { RobotCapabilities, RobotJob, RobotLanguage, RobotMessage, RobotStage } from "../../lib/robot-types";
import { PcmWavRecorder } from "./recorder";
import RobotPortrait from "./RobotPortrait";

const stages: RobotStage[] = ["queued", "ready", "en_route", "arrived", "completed"];
const stageNames: Record<RobotStage, string> = { queued: "수신 대기열", ready: "안내 준비", en_route: "이동 중", arrived: "테이블 도착", completed: "안내 완료", needs_staff: "직원 확인" };
const languageNames: Record<RobotLanguage, string> = { ko: "한국어", en: "English", ja: "日本語", zh: "中文" };
const readyText: Record<RobotLanguage, string> = { ko: "요청을 확인했어요. 도움이 필요하면 말씀해주세요.", en: "Your request is ready. Let me know if you need help.", ja: "ご要望を確認しました。お困りの際はお話しください。", zh: "已收到您的请求。如需帮助，请告诉我。" };
const locales: Record<RobotLanguage, string> = { ko: "ko-KR", en: "en-US", ja: "ja-JP", zh: "zh-CN" };
const guest = {
  ko: { waiting: "안내를 준비하고 있어요.", failed: "직원이 요청을 확인하고 있어요.", talk: "로봇에게 말씀해주세요", note: "버튼을 누른 후 말씀해주세요. 저절로 듣지 않아요.", start: "말하기", stop: "말하기 완료", cancel: "취소", preparing: "말씀을 확인하고 있어요.", completed: "안내를 마쳤어요. 도움이 필요하면 직원을 불러주세요." },
  en: { waiting: "I'm preparing your message.", failed: "Our team is checking your request.", talk: "Speak to your guide", note: "Tap before speaking. The microphone stays off until you tap.", start: "Tap to speak", stop: "Finish speaking", cancel: "Cancel", preparing: "I'm checking your message.", completed: "All done. Please ask our team if you need more help." },
  ja: { waiting: "ご案内を準備しています。", failed: "スタッフがご要望を確認しています。", talk: "ロボットにお話しください", note: "ボタンを押してからお話しください。自動では録音しません。", start: "話す", stop: "話し終わる", cancel: "キャンセル", preparing: "お話を確認しています。", completed: "ご案内は以上です。お困りの際はスタッフをお呼びください。" },
  zh: { waiting: "正在为您准备提示。", failed: "工作人员正在查看您的请求。", talk: "请对机器人说话", note: "点击按钮后再说话。麦克风不会自动开启。", start: "开始说话", stop: "说完了", cancel: "取消", preparing: "正在查看您的话。", completed: "服务已结束。如需帮助，请联系工作人员。" },
};
class RequestError extends Error { constructor(public code: string, public status = 0) { super(code); } }
function errorText(error: unknown) {
  const code = error instanceof RequestError ? error.code : error instanceof DOMException ? error.name : "";
  if (/AUTH|UNAUTHORIZED|FORBIDDEN/.test(code)) return "직원 계정으로 로그인한 뒤 다시 확인해주세요.";
  if (/VERSION|CHANGED|CONFLICT|STAGE/.test(code)) return "다른 화면에서 내용이 바뀌었어요. 새로 확인한 뒤 다시 눌러주세요.";
  if (/NO_SPEECH|EMPTY|INVALID_AUDIO/.test(code)) return "말씀이 잘 들리지 않았어요. 마이크 가까이에서 다시 말씀해주세요.";
  if (/NotAllowed|PERMISSION/.test(code)) return "마이크 사용을 허용한 뒤 다시 눌러주세요.";
  if (/MICROPHONE|NotFound|NotReadable/.test(code)) return "마이크를 사용할 수 없어요. 기기 연결과 권한을 확인해주세요.";
  if (/QUOTA|LIMIT|429/.test(code)) return "지금은 안내 요청이 많아요. 잠시 후 다시 확인해주세요.";
  if (/CONFIGURED|UNAVAILABLE|TTS/.test(code)) return "이 안내 기능은 아직 준비되지 않았어요. 직원에게 확인해주세요.";
  return "연결을 확인하지 못했어요. 입력 내용을 보존했으니 다시 확인해주세요.";
}
async function request<T>(path: string, init?: RequestInit, timeout = 100000): Promise<T> {
  const response = await fetch(path, { ...init, credentials: "same-origin", signal: init?.signal || AbortSignal.timeout(timeout), headers: { ...(init?.body instanceof FormData ? {} : { "Content-Type": "application/json" }), ...init?.headers } });
  const result = await response.json().catch(() => ({})) as { code?: string };
  if (!response.ok) throw new RequestError(result.code || "CONNECTION_FAILED", response.status);
  return result as T;
}
const microphoneCopy = {
  ko: { permission: "마이크 사용을 허용한 뒤 다시 눌러주세요.", empty: "말씀이 잘 들리지 않았어요. 마이크 가까이에서 다시 말씀해주세요.", unavailable: "마이크를 사용할 수 없어요. 직원에게 도움을 요청해주세요.", failed: "말씀을 확인하지 못했어요. 연결을 확인한 뒤 다시 눌러주세요.", pending: "마이크 준비 중", limit: "최대 25초 · 완료하면 말씀을 확인해요", disabled: "음성 입력을 아직 사용할 수 없어요.", retry: "같은 말씀 다시 확인" },
  en: { permission: "Please allow microphone access, then try again.", empty: "I couldn't hear you clearly. Please try speaking closer to the microphone.", unavailable: "The microphone is unavailable. Please ask our team for help.", failed: "I couldn't check your message. Please check the connection and try again.", pending: "Preparing microphone", limit: "Up to 25 seconds · tap finish when you are done", disabled: "Voice input is not available yet.", retry: "Check the same message again" },
  ja: { permission: "マイクの使用を許可してから、もう一度押してください。", empty: "うまく聞き取れませんでした。マイクに近づいてもう一度お話しください。", unavailable: "マイクを使用できません。スタッフにお声がけください。", failed: "お話を確認できませんでした。接続を確認してもう一度押してください。", pending: "マイクを準備中", limit: "最大25秒 · 話し終わったら完了を押してください", disabled: "音声入力はまだ利用できません。", retry: "同じお話をもう一度確認" },
  zh: { permission: "请允许使用麦克风，然后重试。", empty: "没有听清。请靠近麦克风再说一次。", unavailable: "麦克风不可用。请联系工作人员。", failed: "暂时无法处理您的话。请检查网络后重试。", pending: "正在准备麦克风", limit: "最多25秒 · 说完后请点击完成", disabled: "语音输入暂不可用。", retry: "重新确认同一段话" },
};
function microphoneError(error: unknown, language: RobotLanguage) {
  const code = error instanceof RequestError ? error.code : error instanceof DOMException ? error.name : "";
  const c = microphoneCopy[language];
  return /NotAllowed|PERMISSION/.test(code) ? c.permission : /NO_SPEECH|EMPTY|INVALID_AUDIO/.test(code) ? c.empty : /MICROPHONE|NotFound|NotReadable/.test(code) ? c.unavailable : c.failed;
}
const post = <T,>(path: string, value: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(value) });
const receivedTime = (date: string) => new Date(date).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });

export default function RobotApp() {
  const [jobs, setJobs] = useState<RobotJob[]>([]), [capabilities, setCapabilities] = useState<RobotCapabilities | null>(null);
  const [selected, setSelected] = useState<string | null>(null), [loaded, setLoaded] = useState(false), [online, setOnline] = useState(true);
  const [loadError, setLoadError] = useState(""), [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(""), [refreshing, setRefreshing] = useState(false), [prepareErrors, setPrepareErrors] = useState<Record<string, string>>({});
  const [recording, setRecording] = useState(false), [micPending, setMicPending] = useState(false), [seconds, setSeconds] = useState(0), [retryTurn, setRetryTurn] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(false), [audioState, setAudioState] = useState<"idle" | "loading" | "playing">("idle"), [audioError, setAudioError] = useState("");
  const [deviceVoiceAvailable, setDeviceVoiceAvailable] = useState(false), [usingDeviceVoice, setUsingDeviceVoice] = useState(false);
  const alive = useRef(true), loading = useRef(false), working = useRef(false), recordingRef = useRef(false), attemptPrepare = useRef(new Set<string>());
  const recorder = useRef<PcmWavRecorder | null>(null), captureGeneration = useRef(0);
  const pendingTurn = useRef<{ jobId: string; requestId: string; audio: Blob } | null>(null);
  const audioGeneration = useRef(0), audio = useRef<HTMLAudioElement | null>(null), audioUrl = useRef<string | null>(null), audioAbort = useRef<AbortController | null>(null), spoken = useRef("");
  const active = jobs.find(job => job.id === selected) || null;
  const activeRef = useRef<RobotJob | null>(null); activeRef.current = active;
  const lang = active?.language || "ko", copy = guest[lang], micCopy = microphoneCopy[lang];
  const latestMessage = active?.messages.filter(message => message.role === "assistant" && message.text.trim()).at(-1);

  const updateJob = useCallback((job: RobotJob) => {
    if (!alive.current) return;
    setJobs(old => {
      const current = old.find(item => item.id === job.id);
      if (current && current.version > job.version) return old;
      return current ? old.map(item => item.id === job.id ? job : item) : [...old, job];
    });
  }, []);
  const load = useCallback(async () => {
    if (loading.current || working.current || recordingRef.current || !navigator.onLine) return;
    loading.current = true; setRefreshing(true);
    try {
      const result = await request<{ jobs: RobotJob[]; capabilities: RobotCapabilities }>("/api/robot", undefined, 18000);
      if (!alive.current) return;
      setJobs(old => result.jobs.map(job => { const current = old.find(item => item.id === job.id); return current && current.version > job.version ? current : job; }));
      setSelected(previous => result.jobs.some(job => job.id === previous) ? previous : result.jobs.find(job => job.stage !== "completed")?.id || result.jobs[0]?.id || null);
      setCapabilities(result.capabilities); setLoadError(""); setLoaded(true);
    } catch (error) { if (alive.current) setLoadError(errorText(error)); }
    finally { loading.current = false; if (alive.current) setRefreshing(false); }
  }, []);
  const stopAudio = useCallback(() => {
    audioGeneration.current++; audioAbort.current?.abort(); audioAbort.current = null;
    if (audio.current) { audio.current.pause(); audio.current.src = ""; audio.current = null; }
    if (audioUrl.current) URL.revokeObjectURL(audioUrl.current); audioUrl.current = null;
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
    if (alive.current) setAudioState("idle");
  }, []);
  const cancelCapture = useCallback(async () => {
    captureGeneration.current++; const current = recorder.current; recorder.current = null;
    recordingRef.current = false; setRecording(false); setMicPending(false); setSeconds(0);
    await current?.cancel();
  }, []);
  useEffect(() => {
    alive.current = true; setOnline(navigator.onLine); void load();
    const timer = setInterval(() => void load(), 4000);
    const connection = () => { setOnline(navigator.onLine); if (navigator.onLine) void load(); else { stopAudio(); void cancelCapture(); } };
    window.addEventListener("online", connection); window.addEventListener("offline", connection);
    return () => { alive.current = false; clearInterval(timer); window.removeEventListener("online", connection); window.removeEventListener("offline", connection); stopAudio(); captureGeneration.current++; void recorder.current?.cancel(); };
  }, [load, stopAudio, cancelCapture]);
  useEffect(() => {
    const check = () => setDeviceVoiceAvailable("speechSynthesis" in window && window.speechSynthesis.getVoices().some(voice => voice.lang.toLowerCase().replace("_", "-") === locales[lang].toLowerCase()));
    check(); window.speechSynthesis?.addEventListener("voiceschanged", check);
    return () => window.speechSynthesis?.removeEventListener("voiceschanged", check);
  }, [lang]);
  useEffect(() => { if (!recording) return; const timer = setInterval(() => setSeconds(Math.floor((recorder.current?.durationMs || 0) / 1000)), 200); return () => clearInterval(timer); }, [recording]);

  async function prepare(job: RobotJob, manual = false) {
    if (working.current || recordingRef.current || !online || (!manual && attemptPrepare.current.has(job.id))) return;
    attemptPrepare.current.add(job.id); working.current = true; setBusy("prepare");
    setPrepareErrors(old => { const next = { ...old }; delete next[job.id]; return next; });
    try { const result = await post<{ job: RobotJob }>("/api/robot", { action: "prepare", jobId: job.id }); updateJob(result.job); }
    catch (error) { if (alive.current) setPrepareErrors(old => ({ ...old, [job.id]: errorText(error) })); }
    finally { working.current = false; if (alive.current) setBusy(""); }
  }
  useEffect(() => {
    if (!loaded || busy || retryTurn || !online) return;
    const next = jobs.find(job => job.preparationStatus === "pending" && !attemptPrepare.current.has(job.id));
    if (next) void prepare(next);
  }, [jobs, loaded, busy, online, retryTurn]);

  async function advance(stage: RobotStage) {
    if (!active || working.current || recordingRef.current || pendingTurn.current || !online) return;
    working.current = true; setBusy("stage"); setActionError("");
    try { const result = await post<{ job: RobotJob }>("/api/robot", { action: "stage", jobId: active.id, stage, version: active.version }); updateJob(result.job); }
    catch (error) { if (alive.current) setActionError(errorText(error)); }
    finally { working.current = false; if (alive.current) { setBusy(""); void load(); } }
  }
  async function speak(job: RobotJob, message: RobotMessage, forceDevice = false) {
    stopAudio(); setAudioError(""); const generation = audioGeneration.current;
    if (!message.text.trim() || message.commentNeeded === false || recordingRef.current) return;
    spoken.current = `${job.id}:${message.id}`;
    if (capabilities?.tts && !forceDevice) {
      setUsingDeviceVoice(false); setAudioState("loading"); const controller = new AbortController(); audioAbort.current = controller;
      const timeout = setTimeout(() => controller.abort(), 25000);
      try {
        const response = await fetch("/api/robot/speak", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId: job.id, messageId: message.id }), signal: controller.signal });
        if (!response.ok) throw new RequestError("TTS_UNAVAILABLE");
        const blob = await response.blob(); if (!blob.size) throw new RequestError("TTS_UNAVAILABLE");
        if (generation !== audioGeneration.current || !alive.current) return;
        const url = URL.createObjectURL(blob), player = new Audio(url); audioUrl.current = url; audio.current = player;
        player.onended = () => { if (generation === audioGeneration.current) stopAudio(); };
        player.onerror = () => { if (generation === audioGeneration.current) { stopAudio(); setAudioError("음성을 재생하지 못했어요. 다시 듣기를 눌러주세요."); } };
        await player.play(); if (generation === audioGeneration.current) setAudioState("playing");
      } catch (error) {
        if (generation === audioGeneration.current && alive.current) { setAudioState("idle"); setAudioError("음성 안내를 불러오지 못했어요. 기기 음성으로 듣거나 자막을 확인해주세요."); }
      } finally { clearTimeout(timeout); }
      return;
    }
    const voice = window.speechSynthesis?.getVoices().find(item => item.lang.toLowerCase().replace("_", "-") === locales[job.language].toLowerCase());
    if (!voice) { setAudioError("이 언어의 기기 음성이 없어요. 화면의 자막으로 안내해주세요."); setAudioState("idle"); return; }
    const utterance = new SpeechSynthesisUtterance(message.text); utterance.lang = locales[job.language]; utterance.voice = voice; utterance.rate = 0.95;
    utterance.onend = () => { if (generation === audioGeneration.current) setAudioState("idle"); };
    utterance.onerror = () => { if (generation === audioGeneration.current) { setAudioState("idle"); setAudioError("기기 음성을 재생하지 못했어요. 자막을 확인해주세요."); } };
    setUsingDeviceVoice(true); setAudioState("playing"); window.speechSynthesis.speak(utterance);
  }
  useEffect(() => {
    if (!audioEnabled || !active || !latestMessage || recording || micPending || retryTurn || busy === "turn") return;
    const key = `${active.id}:${latestMessage.id}`;
    if (spoken.current !== key) void speak(active, latestMessage);
  }, [audioEnabled, active?.id, latestMessage?.id, recording, micPending, retryTurn, busy]);

  async function sendTurn(pending: NonNullable<typeof pendingTurn.current>) {
    if (working.current || !online) return;
    working.current = true; setBusy("turn"); setActionError(""); setRetryTurn(false); pendingTurn.current = pending;
    const form = new FormData(); form.append("jobId", pending.jobId); form.append("requestId", pending.requestId); form.append("audio", pending.audio, "request.wav");
    try { const result = await request<{ job: RobotJob }>("/api/robot/turn", { method: "POST", body: form }); updateJob(result.job); pendingTurn.current = null; }
    catch (error) {
      if (alive.current) {
        setActionError(microphoneError(error, activeRef.current?.language || "ko"));
        const safeRejection = error instanceof RequestError && ([400, 413, 415, 422].includes(error.status) || /^(NO_SPEECH|INVALID_AUDIO|INVALID_AUDIO_SIZE|INVALID_AUDIO_TYPE|INVALID_INPUT|JOB_NOT_READY|JOB_COMPLETED|REQUEST_ID_CONFLICT)$/.test(error.code));
        if (safeRejection) pendingTurn.current = null;
        setRetryTurn(!safeRejection);
      }
    }
    finally { working.current = false; if (alive.current) setBusy(""); }
  }
  async function beginCapture() {
    if (!active || working.current || recordingRef.current || pendingTurn.current || !capabilities?.speech || !online || active.stage === "completed") return;
    const jobId = active.id, generation = ++captureGeneration.current; stopAudio(); setActionError(""); setMicPending(true); recordingRef.current = true;
    const finish = (blob: Blob) => {
      if (generation !== captureGeneration.current || !alive.current) return;
      recordingRef.current = false; recorder.current = null; setRecording(false); setMicPending(false); setSeconds(0);
      void sendTurn({ jobId, requestId: crypto.randomUUID(), audio: blob });
    };
    const current = new PcmWavRecorder({ maxDurationMs: 25000, onLimit: finish, onError(error) { if (generation !== captureGeneration.current || !alive.current) return; recordingRef.current = false; recorder.current = null; setRecording(false); setMicPending(false); setActionError(microphoneError(error, activeRef.current?.language || "ko")); } });
    recorder.current = current;
    try { await current.start(); if (generation !== captureGeneration.current || !alive.current) { await current.cancel(); return; } setMicPending(false); setRecording(true); }
    catch (error) { if (generation !== captureGeneration.current || !alive.current) return; recordingRef.current = false; recorder.current = null; setMicPending(false); if (!(error instanceof DOMException && error.name === "AbortError")) setActionError(microphoneError(error, activeRef.current?.language || "ko")); }
  }
  async function finishCapture() {
    const current = recorder.current, jobId = active?.id, generation = captureGeneration.current;
    if (!current || !jobId || !recording) return;
    setRecording(false); setMicPending(true);
    try { const blob = await current.stop(); if (generation !== captureGeneration.current || !alive.current) return; recordingRef.current = false; recorder.current = null; setMicPending(false); setSeconds(0); await sendTurn({ jobId, requestId: crypto.randomUUID(), audio: blob }); }
    catch (error) { if (generation !== captureGeneration.current || !alive.current) return; if ((error as { code?: string }).code === "RECORDER_NOT_RECORDING") return; recordingRef.current = false; recorder.current = null; setMicPending(false); setActionError(microphoneError(error, activeRef.current?.language || "ko")); }
  }
  function selectJob(job: RobotJob) {
    if (working.current || recordingRef.current || pendingTurn.current) return;
    stopAudio(); setSelected(job.id); setActionError(""); setAudioError("");
  }
  const micLocked = Boolean(busy) || !online || !capabilities?.speech || retryTurn || active?.stage === "completed" || active?.preparationStatus !== "ready";
  const assistantCanSpeak = Boolean(latestMessage && latestMessage.commentNeeded !== false);
  const stageIndex = active ? stages.indexOf(active.stage) : 0;
  const nextStage = active?.stage === "needs_staff" ? "ready" : stages[stageIndex + 1];
  const nextLabel = active?.stage === "ready" ? "이동 단계 시작" : active?.stage === "en_route" ? "도착으로 표시" : active?.stage === "arrived" ? "안내 완료로 표시" : "직원 확인 후 다시 준비";
  return <main className="robot-app">
    <header className="topbar"><div className="brand"><span className="brand-word">담다</span><span className="brand-divider"/><div><strong>곁에서 돕는 안내 로봇</strong><small>DAMDA · ROBOT GUIDE</small></div></div><div className="top-actions"><span className={`pill ${!online || loadError ? "warning" : ""}`}><span className="dot"/>{!online ? "연결 끊김" : loadError ? "연결 확인 필요" : "받은 요청 확인 중"}</span><button className="quiet-button" onClick={() => void load()} disabled={refreshing || Boolean(busy) || !online}><RefreshCw size={16}/>{refreshing ? "확인 중" : "새로 확인"}</button></div></header>
    {busy && <div className="loading-line" role="progressbar" aria-label={busy === "turn" ? "말씀 확인 중" : "안내 준비 중"}/>}
    {(!online || loadError) && <div className="alert page-alert" role="status">{!online ? "연결이 끊겼어요. 마지막으로 받은 내용을 보여드리고 있어요. 연결이 돌아오면 다시 확인합니다." : loadError}</div>}
    <div className="workspace">
      <aside className="queue" aria-label="받은 요청"><div className="section-title"><h2>받은 요청</h2><span className="count">{jobs.length}</span></div><p className="caption queue-caption">확인할 요청을 선택하세요.<br/>새 요청이 와도 선택은 유지돼요.</p><div className="job-list">{jobs.map(job => <button key={job.id} className={`job-card ${job.id === active?.id ? "selected" : ""}`} onClick={() => selectJob(job)} disabled={Boolean(busy) || recording || micPending || retryTurn} aria-pressed={job.id === active?.id} data-testid={`job-${job.id}`}><div className="row"><span className="job-table"><small>TABLE</small>{String(job.table).padStart(2, "0")}</span><span className="badge">{stageNames[job.stage]}</span></div><p className="job-request">{job.koreanText || job.originalText}</p><div className="job-meta"><span>{languageNames[job.language]} · {job.type === "order.created" ? "음식 주문" : "고객 요청"}</span><span>{receivedTime(job.receivedAt)}</span></div></button>)}</div>{!jobs.length && <div className="empty-queue">{!loaded ? "받은 요청을 확인하고 있어요." : "아직 도착한 요청이 없어요. 직원 화면에서 로봇에게 전달한 요청이 여기에 나타납니다."}</div>}<div className="demo-banner"><CircleHelp size={18}/><span>발표용 화면입니다.<br/>이동 단계는 직접 진행하며 실제 로봇은 움직이지 않아요.</span></div></aside>
      {active ? <>
        <section className="robot-stage" aria-label="현재 로봇 안내"><div className="stage-top"><div><div className="eyebrow">지금 안내할 테이블</div><h1>{String(active.table).padStart(2, "0")} <span>번 테이블</span></h1></div><span className={`pill ${active.stage === "needs_staff" ? "warning" : ""}`}>{stageNames[active.stage]} · 모의</span></div>
          <RobotPortrait moving={active.stage === "en_route"} speaking={audioState === "playing"}/>
          <div className="subtitle-box" aria-live="polite"><div className="subtitle-label"><Globe2 size={14}/>{languageNames[lang]}로 안내해요</div><p className="subtitle-text" lang={locales[lang]} data-testid="customer-subtitle">{latestMessage?.text || (active.preparationStatus === "failed" || prepareErrors[active.id] ? copy.failed : active.prepared ? readyText[lang] : copy.waiting)}</p>{lang !== "ko" && latestMessage?.koText && <p className="subtitle-korean" lang="ko">{latestMessage.koText}</p>}</div>
          <div className="button-row audio-controls">{!audioEnabled ? <button className="button" data-testid="enable-audio" disabled={!assistantCanSpeak || recording || micPending || Boolean(busy)} onClick={() => { setAudioEnabled(true); if (latestMessage) void speak(active, latestMessage); }}><Volume2 size={18}/>음성 안내 시작</button> : <><button className="button" data-testid="replay-audio" disabled={!assistantCanSpeak || recording || micPending || Boolean(busy) || audioState === "loading"} onClick={() => latestMessage && void speak(active, latestMessage)}><Volume2 size={18}/>{audioState === "loading" ? "음성 준비 중" : "다시 듣기"}</button><button className="quiet-button" onClick={() => { setAudioEnabled(false); stopAudio(); }}><VolumeX size={18}/>음성 안내 끄기</button></>}{audioState === "playing" && <button className="quiet-button" onClick={stopAudio}><Square size={16}/>재생 중지</button>}</div>
          <p className="audio-note">{!audioEnabled ? "처음에는 무음이에요. 시작을 누른 뒤부터 새 안내를 읽어드려요." : usingDeviceVoice || !capabilities?.tts ? "기기 음성으로 안내 · 네이버 음성은 현재 사용할 수 없어요." : "네이버 음성으로 안내"}{!capabilities?.tts && !deviceVoiceAvailable && " 이 언어의 기기 음성이 없으면 자막을 이용해주세요."}</p>
          {audioError && <div className="inline-error" role="status">{audioError}{capabilities?.tts && deviceVoiceAvailable && latestMessage && <button className="quiet-button" disabled={recording || micPending} onClick={() => void speak(active, latestMessage, true)}>기기 음성으로 듣기</button>}</div>}
          {(active.preparationStatus === "failed" || prepareErrors[active.id]) && <div className="alert" role="status"><span>{prepareErrors[active.id] || "안내 문장을 준비하지 못했어요. 다시 준비하거나 직원이 직접 안내해주세요."}</span><button className="quiet-button" onClick={() => void prepare(active, true)} disabled={Boolean(busy) || !online || recording || micPending || retryTurn}>다시 준비</button></div>}
          {active.needsStaff && <div className="alert"><span>직원의 확인이 필요한 요청이에요. 내용을 확인한 뒤 다음 단계를 진행해주세요.</span>{active.stage !== "needs_staff" && active.stage !== "completed" && <button className="quiet-button" disabled={Boolean(busy) || !online || recording || micPending || retryTurn} onClick={() => void advance("needs_staff")}>직원 확인으로 표시</button>}</div>}
          <div className="steps" aria-label="발표용 진행 단계">{stages.map((stage, index) => <div key={stage} className={`step ${stageIndex === index ? "active" : stageIndex > index ? "complete" : ""}`} aria-current={active.stage === stage ? "step" : undefined}><span className="step-num">{stageIndex > index ? <Check size={13}/> : index + 1}</span>{stageNames[stage]}</div>)}</div>
          <div className="stage-controls">{nextStage && active.stage !== "queued" && <button className="button warm" data-testid="advance-stage" disabled={Boolean(busy) || !online || recording || micPending || retryTurn || active.preparationStatus !== "ready"} onClick={() => void advance(nextStage)}>{nextLabel}<ArrowRight size={17}/></button>}{active.stage === "completed" && <span className="pill"><Check size={16}/>이 요청의 안내를 마쳤어요</span>}</div><p className="movement-note">발표자가 누르면 화면의 단계만 바뀝니다. 실제 이동 명령은 보내지 않습니다.</p>
        </section>
        <aside className="details" aria-label="요청과 대화"><div><h2>손님이 부탁하신 내용</h2><div className="info-block"><div className="info-label">직원 확인 · 한국어</div><p className="info-text" lang="ko">{active.koreanText || "한국어 안내를 준비하고 있어요."}</p></div><div className="info-block"><div className="info-label">원문 · {languageNames[lang]}</div><p className="info-text original-text" lang={locales[lang]} data-testid="original-request">{active.originalText}</p></div><div className="conversation" aria-label="이 요청의 대화">{active.messages.map(message => <div key={message.id} className={`message ${message.role === "user" ? "customer" : ""}`}><div className="message-role">{message.role === "user" ? "손님" : "담다 로봇"}</div><p lang={locales[lang]}>{message.text}</p>{lang !== "ko" && message.koText && <p className="message-korean" lang="ko">{message.koText}</p>}</div>)}</div>{!active.messages.length && <p className="no-conversation">준비된 안내와 손님의 응답이 여기에 남아요.</p>}</div>
          <div><div className={`mic-area ${recording ? "mic-active" : ""}`}><h3 lang={locales[lang]}>{copy.talk}</h3><p lang={locales[lang]}>{copy.note}</p>{recording && <div className="recording-indicator" role="status"><span className="recording-pulse"/>{seconds.toString().padStart(2, "0")} / 25초</div>}{recording ? <button className="button danger full" data-testid="stop-recording" onClick={() => void finishCapture()}><Square size={17}/>{copy.stop}</button> : <button className="button full" data-testid="start-recording" disabled={micLocked || micPending} onClick={() => void beginCapture()}><Mic size={18}/>{micPending ? micCopy.pending : busy === "turn" ? copy.preparing : copy.start}</button>}{(recording || micPending) && <button className="quiet-button full" onClick={() => void cancelCapture()}>{copy.cancel}</button>}<p>{active.stage === "completed" ? copy.completed : capabilities?.speech ? micCopy.limit : micCopy.disabled}</p></div>{actionError && <div className="inline-error" role="alert">{actionError}</div>}{retryTurn && <button className="button secondary full" data-testid="retry-turn" disabled={Boolean(busy) || !online} onClick={() => pendingTurn.current && void sendTurn(pendingTurn.current)}>{micCopy.retry}</button>}</div>
        </aside>
      </> : <section className="robot-stage empty-stage"><RobotPortrait/><h1>손님을 도울 준비가 됐어요.</h1><p>수신한 요청이 있으면 테이블과 안내 문장을 보여드릴게요. 자동으로 녹음하거나 소리를 재생하지 않아요.</p><span className="pill" style={{ marginTop: 20 }}><VolumeX size={15}/>음성 안내 꺼짐</span></section>}
    </div>
  </main>;
}
