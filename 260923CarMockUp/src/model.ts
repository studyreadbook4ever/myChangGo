import type { ScheduleEvent } from "./components/Calendar";

export type Destination = ScheduleEvent["destination"];
export type Stage = "ready" | "driving" | "traffic" | "rerouted" | "arrived";
export const DEMO_DATE = "2026-09-23";
export const DEMO_TIME = 18 * 60;
export const PLACES = {
  office: {
    name: "메이트 스튜디오",
    area: "테크노밸리",
    baseline: 12,
    parking: 5,
    walk: 3,
  },
  cafe: {
    name: "리버사이드 카페",
    area: "수변공원",
    baseline: 8,
    parking: 3,
    walk: 2,
  },
  service: {
    name: "그린 오토케어",
    area: "메이트로",
    baseline: 10,
    parking: 3,
    walk: 2,
  },
  home: {
    name: "우리 집",
    area: "메이트 주거단지",
    baseline: 9,
    parking: 3,
    walk: 1,
  },
} as const;
export const INITIAL_EVENTS: ScheduleEvent[] = [
  {
    id: "morning",
    title: "팀 주간 회의",
    date: DEMO_DATE,
    time: "09:30",
    duration: 60,
    destination: "office",
    category: "work",
    buffer: 10,
  },
  {
    id: "coffee",
    title: "지민과 커피",
    date: DEMO_DATE,
    time: "14:00",
    duration: 60,
    destination: "cafe",
    category: "personal",
    buffer: 5,
  },
  {
    id: "meeting",
    title: "브랜드 프로젝트 미팅",
    date: DEMO_DATE,
    time: "18:30",
    duration: 60,
    destination: "office",
    category: "work",
    buffer: 7,
  },
  {
    id: "tomorrow",
    title: "워크숍 자료 준비",
    date: "2026-09-24",
    time: "10:00",
    duration: 90,
    destination: "office",
    category: "work",
    buffer: 10,
  },
  {
    id: "weekend",
    title: "주말 브런치",
    date: "2026-09-26",
    time: "12:00",
    duration: 60,
    destination: "cafe",
    category: "personal",
    buffer: 5,
  },
];
export interface TripRecord {
  id: string;
  date: string;
  title: string;
  distance: number;
  baseline: number;
  actual: number;
  destination: Destination;
  rerouted?: boolean;
}
export const INITIAL_TRIPS: TripRecord[] = [
  {
    id: "t1",
    date: "2026-09-22",
    title: "퇴근 후 스튜디오",
    distance: 3.2,
    baseline: 12,
    actual: 15,
    destination: "office",
  },
  {
    id: "t2",
    date: "2026-09-21",
    title: "프로젝트 회의",
    distance: 3.2,
    baseline: 13,
    actual: 16,
    destination: "office",
  },
  {
    id: "t3",
    date: "2026-09-18",
    title: "스튜디오 방문",
    distance: 3.2,
    baseline: 11,
    actual: 13,
    destination: "office",
  },
  {
    id: "t4",
    date: "2026-09-17",
    title: "브랜드 미팅",
    distance: 3.2,
    baseline: 13,
    actual: 17,
    destination: "office",
  },
  {
    id: "t5",
    date: "2026-09-16",
    title: "팀 미팅",
    distance: 3.2,
    baseline: 12,
    actual: 15,
    destination: "office",
  },
];
export function median(values: number[]) {
  if (!values.length) return 0;
  const a = [...values].sort((a, b) => a - b),
    m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
export function personalResidual(
  trips: TripRecord[],
  destination: Destination,
) {
  // Only same-destination, non-disrupted trips calibrate habitual driving pace.
  return median(
    trips
      .filter((t) => t.destination === destination && !t.rerouted)
      .slice(0, 10)
      .map((t) => t.actual - t.baseline),
  );
}
export function timeToMinutes(time: string) {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}
export function clockTime(minutes: number) {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
export function dayOffset(minutes: number) {
  return minutes < 0 ? "전날 " : minutes >= 1440 ? "다음 날 " : "";
}
export function planTrip(event: ScheduleEvent, trips: TripRecord[]) {
  const place = PLACES[event.destination];
  const residual = personalResidual(trips, event.destination);
  const drive = Math.max(1, place.baseline + residual);
  const duration = drive + place.parking + place.walk;
  return {
    ...place,
    residual,
    drive,
    duration,
    departure: timeToMinutes(event.time) - duration - event.buffer,
  };
}
export function arrivalFor(departure: number, duration: number, stage: Stage) {
  return (
    departure +
    duration +
    (stage === "traffic"
      ? 12
      : stage === "rerouted" || stage === "arrived"
        ? 3
        : 0)
  );
}
export function elapsedDrive(drive: number, delay: number, progress: number) {
  // Congestion is discovered at the shared junction. Updating the remaining ETA
  // must not move the current clock forward or backward at that same location.
  const p = Math.max(0, Math.min(1, progress));
  return (
    drive * Math.min(p, 0.3) +
    ((drive * 0.7 + delay) * Math.max(0, p - 0.3)) / 0.7
  );
}
export function stageIndex(stage: Stage) {
  return ["ready", "driving", "traffic", "rerouted", "arrived"].indexOf(stage);
}
export function maintenanceSlot(events: ScheduleEvent[]) {
  // One-hour appointment candidates, checked against the built-in calendar.
  const candidates = [
    { date: "2026-09-26", time: "10:00", label: "토요일 오전 10시" },
    { date: "2026-09-26", time: "11:00", label: "토요일 오전 11시" },
    { date: "2026-09-24", time: "18:30", label: "목요일 오후 6시 30분" },
    { date: "2026-09-27", time: "10:00", label: "일요일 오전 10시" },
  ];
  return candidates.find(
    (c) =>
      !events.some(
        (e) =>
          e.date === c.date &&
          timeToMinutes(e.time) < timeToMinutes(c.time) + 60 &&
          timeToMinutes(e.time) + e.duration > timeToMinutes(c.time),
      ),
  );
}
export interface SavedState {
  events: ScheduleEvent[];
  trips: TripRecord[];
  mileage: number;
  parking: Destination | null;
}
export const STORAGE_KEY = "drivemate-demo-v1";
export function freshState(): SavedState {
  return {
    events: structuredClone(INITIAL_EVENTS),
    trips: structuredClone(INITIAL_TRIPS),
    mileage: 9840,
    parking: null,
  };
}
function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const d = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
function validDestination(value: unknown): value is Destination {
  return typeof value === "string" && Object.hasOwn(PLACES, value);
}
function validEvent(x: unknown): x is ScheduleEvent {
  if (!x || typeof x !== "object") return false;
  const e = x as ScheduleEvent;
  return (
    typeof e.id === "string" &&
    typeof e.title === "string" &&
    e.title.trim().length > 0 &&
    validDate(e.date) &&
    /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(e.time) &&
    validDestination(e.destination) &&
    ["work", "personal", "care"].includes(e.category) &&
    Number.isInteger(e.duration) &&
    e.duration >= 5 &&
    e.duration <= 480 &&
    Number.isInteger(e.buffer) &&
    e.buffer >= 0 &&
    e.buffer <= 60
  );
}
export function parseSavedState(raw: string | null): SavedState {
  try {
    if (!raw) return freshState();
    const s = JSON.parse(raw) as SavedState;
    if (
      !s ||
      !Array.isArray(s.events) ||
      !s.events.every(validEvent) ||
      !Array.isArray(s.trips) ||
      !s.trips.every(
        (t) =>
          t &&
          typeof t.id === "string" &&
          typeof t.title === "string" &&
          validDate(t.date) &&
          validDestination(t.destination) &&
          Number.isFinite(t.distance) &&
          t.distance >= 0 &&
          Number.isFinite(t.actual) &&
          t.actual > 0 &&
          Number.isFinite(t.baseline) &&
          t.baseline > 0 &&
          (t.rerouted === undefined || typeof t.rerouted === "boolean"),
      ) ||
      !Number.isFinite(s.mileage) ||
      s.mileage < 0 ||
      s.mileage > 999999 ||
      (s.parking !== null && !validDestination(s.parking))
    )
      return freshState();
    return s;
  } catch {
    return freshState();
  }
}
