import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  CarFront,
  Check,
  CheckCheck,
  ChevronRight,
  CircleHelp,
  Clock3,
  Flag,
  Gauge,
  History,
  LayoutDashboard,
  MapPin,
  Navigation,
  Plus,
  RotateCcw,
  Route,
  Settings2,
  ShieldCheck,
  Sparkles,
  Sun,
  TriangleAlert,
  Wrench,
  X,
} from "lucide-react";
import Calendar from "./components/Calendar";
import type { ScheduleEvent } from "./components/Calendar";
import CityMap, { ROUTE_DISTANCES } from "./components/CityMap";
import NavigationView from "./components/NavigationView";
import {
  clockTime,
  dayOffset,
  DEMO_DATE,
  DEMO_TIME,
  elapsedDrive,
  freshState,
  maintenanceSlot,
  parseSavedState,
  planTrip,
  PLACES,
  STORAGE_KEY,
  timeToMinutes,
} from "./model";
import type { Destination, SavedState, Stage } from "./model";

type View = "cockpit" | "calendar" | "vehicle" | "trips";
const NAV_ITEMS = [
  { id: "cockpit", label: "드라이브", icon: LayoutDashboard },
  { id: "calendar", label: "캘린더", icon: CalendarDays },
  { id: "vehicle", label: "내 차량", icon: CarFront },
  { id: "trips", label: "주행 기록", icon: History },
] as const;
function loadState() {
  try {
    return parseSavedState(localStorage.getItem(STORAGE_KEY));
  } catch {
    return freshState();
  }
}

export default function App() {
  const [data, setData] = useState<SavedState>(loadState);
  const [view, setView] = useState<View>("cockpit");
  const [selectedId, setSelectedId] = useState("meeting");
  const [preview, setPreview] = useState<Destination | null>(null);
  const [stage, setStage] = useState<Stage>("ready");
  const [progress, setProgress] = useState(0);
  const [navigating, setNavigating] = useState(false);
  const [confirmExit, setConfirmExit] = useState(false);
  const [routeChoice, setRouteChoice] = useState<
    "none" | "pending" | "accepted" | "kept"
  >("none");
  const [question, setQuestion] = useState("");
  const [toast, setToast] = useState("");
  const [showHelp, setShowHelp] = useState(false);
  const [showReset, setShowReset] = useState(false);
  const [storageFailed, setStorageFailed] = useState(false);
  const [selectedParking, setSelectedParking] = useState(false);
  const tripSaved = useRef(false);
  const availableEvents = [...data.events]
    .filter(
      (e) =>
        e.date >= DEMO_DATE &&
        (e.date !== DEMO_DATE || timeToMinutes(e.time) >= DEMO_TIME),
    )
    .sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
  const selected =
    data.events.find((e) => e.id === selectedId) ?? availableEvents[0];
  const hasSchedule = Boolean(selected) && !preview;
  const event: ScheduleEvent =
    preview || !selected
      ? {
          id: "preview",
          title: "목적지 둘러보기",
          date: DEMO_DATE,
          time: "18:30",
          duration: 60,
          destination: preview ?? "office",
          category: "personal",
          buffer: 7,
        }
      : selected;
  const plan = planTrip(event, data.trips);
  const destination = event.destination;
  const startTime = event.date === DEMO_DATE ? DEMO_TIME : plan.departure;
  const disrupted = routeChoice === "accepted";
  const delay =
    routeChoice === "pending" || routeChoice === "kept"
      ? 12
      : disrupted
        ? 3
        : 0;
  const driveTime = plan.drive + delay;
  const arrival = startTime + plan.duration + delay;
  const margin = timeToMinutes(event.time) - arrival;
  const now = startTime + elapsedDrive(plan.drive, delay, progress);
  const dateLabel = new Intl.DateTimeFormat("ko-KR", {
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(new Date(`${event.date}T12:00:00`));
  const distance = disrupted
    ? ROUTE_DISTANCES[destination].rerouted
    : ROUTE_DISTANCES[destination].normal;
  const remaining = Math.max(0, 10000 - data.mileage);
  const slot = maintenanceSlot(data.events);
  const normalSamples = data.trips
    .filter(
      (t) => t.destination === destination && !t.rerouted && !t.trafficDelay,
    )
    .slice(0, 10).length;
  const todayEvents = data.events
    .filter((e) => e.date === DEMO_DATE)
    .sort((a, b) => a.time.localeCompare(b.time));

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      setStorageFailed(false);
    } catch {
      setStorageFailed(true);
    }
  }, [data]);
  useEffect(() => {
    if (toast) {
      const id = setTimeout(() => setToast(""), 3600);
      return () => clearTimeout(id);
    }
  }, [toast]);
  function restart() {
    setStage("ready");
    setProgress(0);
    setRouteChoice("none");
    setConfirmExit(false);
    tripSaved.current = false;
    setQuestion("");
    setSelectedParking(false);
  }
  function selectEvent(e: ScheduleEvent) {
    restart();
    setSelectedId(e.id);
    setPreview(null);
    setView("cockpit");
  }
  function selectPlace(id: Destination) {
    restart();
    const existing = availableEvents.find((e) => e.destination === id);
    if (existing) {
      setSelectedId(existing.id);
      setPreview(null);
    } else setPreview(id);
  }
  function navigate(next: View) {
    setView(next);
    setQuestion("");
  }
  function startDrive() {
    restart();
    setToast("");
    setView("cockpit");
    setStage("driving");
    setNavigating(true);
  }
  function finishDrive() {
    setNavigating(false);
    restart();
  }
  function chooseRoute(alternate: boolean) {
    setRouteChoice(alternate ? "accepted" : "kept");
    setStage(alternate ? "rerouted" : "driving");
  }
  useEffect(() => {
    if (!navigating) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const native = (
      window as Window & {
        DriveMateNative?: { setNavigationActive: (active: boolean) => void };
      }
    ).DriveMateNative;
    native?.setNavigationActive(true);
    return () => {
      document.body.style.overflow = previousOverflow;
      native?.setNavigationActive(false);
    };
  }, [navigating]);
  useEffect(() => {
    if (
      !navigating ||
      confirmExit ||
      (stage !== "driving" && stage !== "rerouted")
    )
      return;
    const interval = setInterval(() => {
      const approachingJunction = routeChoice === "none";
      setProgress((p) =>
        Math.min(
          approachingJunction ? 0.3 : 1,
          p + (approachingJunction ? 0.00375 : 0.0035),
        ),
      );
    }, 100);
    return () => clearInterval(interval);
  }, [navigating, confirmExit, stage, routeChoice]);
  useEffect(() => {
    if (!navigating) return;
    if (routeChoice === "none" && progress >= 0.3) {
      setRouteChoice("pending");
      setStage("traffic");
    } else if (progress >= 1) setStage("arrived");
  }, [navigating, progress, routeChoice]);
  useEffect(() => {
    if (stage !== "arrived" || tripSaved.current) return;
    tripSaved.current = true;
    const id = `demo-${Date.now()}`;
    setData((d) => ({
      ...d,
      mileage: Math.round((d.mileage + distance) * 10) / 10,
      parking: destination,
      trips: [
        {
          id,
          date: event.date,
          title: hasSchedule ? event.title : `${PLACES[destination].name} 방문`,
          distance,
          baseline: plan.baseline,
          actual: driveTime,
          destination,
          rerouted: disrupted,
          trafficDelay: delay,
        },
        ...d.trips,
      ],
    }));
    setToast("주행 기록과 주차 위치를 저장했어요.");
  }, [
    stage,
    distance,
    destination,
    event.date,
    event.title,
    hasSchedule,
    plan.baseline,
    plan.drive,
    driveTime,
    disrupted,
    delay,
  ]);
  useEffect(() => {
    const handleBack = () => {
      const dialog = document.querySelector<HTMLDialogElement>("dialog[open]");
      if (dialog) {
        dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
        return true;
      }
      if (showHelp || showReset) {
        setShowHelp(false);
        setShowReset(false);
        return true;
      }
      if (navigating) {
        if (stage === "arrived") finishDrive();
        else setConfirmExit((value) => !value);
        return true;
      }
      if (view !== "cockpit") {
        navigate("cockpit");
        return true;
      }
      return false;
    };
    (window as Window & { driveMateBack?: () => boolean }).driveMateBack =
      handleBack;
    return () => {
      delete (window as Window & { driveMateBack?: () => boolean })
        .driveMateBack;
    };
  }, [showHelp, showReset, navigating, stage, view]);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (document.querySelector("dialog[open]")) return;
        setShowHelp(false);
        setShowReset(false);
        if (navigating) {
          if (stage === "arrived") finishDrive();
          else setConfirmExit((value) => !value);
        }
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [navigating, stage]);

  function addMaintenance() {
    if (!slot) return;
    if (data.events.some((e) => e.id === "maintenance-demo")) {
      setToast("이미 정비 일정을 추가했어요. 캘린더에서 확인해보세요.");
      navigate("calendar");
      return;
    }
    const e: ScheduleEvent = {
      id: "maintenance-demo",
      title: "엔진오일 점검",
      date: slot.date,
      time: slot.time,
      duration: 60,
      destination: "service",
      category: "care",
      buffer: 10,
    };
    setData((d) => ({ ...d, events: [...d.events, e] }));
    setToast(`${slot.label}에 정비 일정을 추가했어요.`);
  }

  const agentTitle =
    stage === "traffic"
      ? hasSchedule && margin < 0
        ? "일정에 늦기 전에,\n다른 길을 찾았어요."
        : "정체를 만났어요.\n우회할 수 있어요."
      : stage === "rerouted"
        ? "조금 돌아가도,\n더 여유롭게."
        : stage === "arrived"
          ? "잘 도착했어요.\n나머지는 기억할게요."
          : hasSchedule
            ? plan.departure < startTime
              ? "곧 출발하는 게\n좋겠어요."
              : "오늘의 약속도,\n여유 있게 도착해요."
            : "가고 싶은 곳으로,\n함께 떠나볼까요?";
  const agentBody =
    stage === "traffic"
      ? `중앙대로 정체로 12분이 늘어났어요. ${hasSchedule ? (margin < 0 ? `약속에 ${Math.abs(margin)}분 늦을 수 있어요.` : `도착 여유가 ${margin}분으로 줄었어요.`) : ""} 강변로로 이동하면 9분을 아낄 수 있어요.`
      : stage === "rerouted"
        ? `혼잡한 중앙대로를 피해 강변로로 안내해요. ${clockTime(arrival)}에 ${hasSchedule ? "약속 장소" : "목적지"}까지 도착할 예정이에요.`
        : stage === "arrived"
          ? `${PLACES[destination].name} 주차장에 차량 위치를 저장했어요. 이번 이동 ${distance.toFixed(1)}km도 차량 주행거리에 반영했어요.`
          : hasSchedule
            ? `${event.time} ${event.title}. ${normalSamples ? `최근 같은 목적지의 운전 기록 ${normalSamples}회` : "이 목적지의 기본 이동시간"}와 주차·도보시간까지 함께 계산했어요.`
            : "지도에서 장소를 고르거나 내장 캘린더에 약속을 추가해보세요. 일정에 맞는 출발시간을 계산해드릴게요.";

  if (navigating)
    return (
      <NavigationView
        stage={stage}
        progress={progress}
        destination={destination}
        alternate={disrupted}
        totalDistance={distance}
        driveTime={driveTime}
        elapsed={elapsedDrive(plan.drive, delay, progress)}
        vehicleArrival={startTime + driveTime}
        venueArrival={arrival}
        schedule={hasSchedule ? event : null}
        parkingMinutes={plan.parking}
        walkMinutes={plan.walk}
        needsRouteChoice={routeChoice === "pending"}
        confirmExit={confirmExit}
        onChooseRoute={chooseRoute}
        onRequestEnd={() => setConfirmExit(true)}
        onCancelEnd={() => setConfirmExit(false)}
        onFinish={finishDrive}
      />
    );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button
          className="brand-symbol"
          onClick={() => navigate("cockpit")}
          aria-label="DriveMate 홈"
        >
          <img src="./icon.svg" alt="" />
        </button>
        <nav aria-label="메인 메뉴">
          {NAV_ITEMS.map((n) => (
            <button
              key={n.id}
              className={`nav-item ${view === n.id ? "active" : ""}`}
              onClick={() => navigate(n.id)}
              aria-current={view === n.id ? "page" : undefined}
            >
              <n.icon size={22} strokeWidth={1.7} />
              <span>{n.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button
            className="icon-button"
            onClick={() => setShowHelp(true)}
            aria-label="사용 안내"
          >
            <CircleHelp size={21} />
          </button>
          <div className="profile-avatar" title="데모 사용자">
            서
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <button className="wordmark" onClick={() => navigate("cockpit")}>
            DriveMate
            <span className="brand-dot" />
          </button>
          <span className="topbar-tagline">나의 하루를 잇는 이동</span>
          <div className="topbar-actions">
            <span className="demo-badge">
              <span /> INTERACTIVE DEMO
            </span>
            <button
              className="icon-button help-top"
              onClick={() => setShowHelp(true)}
              aria-label="사용 안내"
            >
              <CircleHelp size={19} />
            </button>
          </div>
        </header>
        {storageFailed && (
          <div className="storage-warning" role="status">
            기기 저장공간에 접근할 수 없어 이번 세션에서만 변경사항을 유지해요.
          </div>
        )}
        <main className={view === "cockpit" ? "cockpit-main" : undefined}>
          {view === "cockpit" && (
            <>
              <section className="page-heading">
                <div>
                  <p className="eyebrow">YOUR DAY, WELL CONNECTED</p>
                  <h1>서연님, 오늘도 좋은 이동을.</h1>
                  <p className="heading-subtitle">
                    일정부터 도착까지, 당신의 하루를 함께 살펴볼게요.
                  </p>
                </div>
                <div className="day-weather">
                  <div>
                    <Sun size={22} className="sun-icon" />
                    <strong>23°</strong>
                    <span>맑음</span>
                  </div>
                  <p>
                    {dateLabel} <span>·</span> <b>{clockTime(now)}</b>
                  </p>
                </div>
              </section>
              <div className="cockpit-grid">
                <section className="map-section" aria-label="개인화 내비게이션">
                  <div className="map-heading">
                    <div className="map-heading-label">
                      <span className="live-dot" />
                      <strong>
                        {stage === "arrived" ? "목적지 도착" : "나의 드라이브"}
                      </strong>
                      <span className="muted">메이트 시티</span>
                    </div>
                    <span className="map-world-label">가상 도시 · 약 5km</span>
                  </div>
                  <div className="map-canvas">
                    <CityMap
                      stage={stage}
                      progress={progress}
                      destination={
                        selectedParking && data.parking
                          ? data.parking
                          : destination
                      }
                      parking={selectedParking || stage === "arrived"}
                      onPlaceSelect={selectPlace}
                    />
                    <div className="map-top-label">
                      <Navigation size={15} fill="currentColor" />
                      <span>
                        {stage === "traffic"
                          ? "정체 구간을 확인하고 있어요"
                          : stage === "rerouted"
                            ? "강변로 · 새로운 경로"
                            : stage === "arrived"
                              ? "마지막 주차 위치를 기억했어요"
                              : "나에게 맞춘 오늘의 경로"}
                      </span>
                    </div>
                    {stage === "traffic" && (
                      <div className="traffic-callout">
                        <TriangleAlert size={16} />
                        <div>
                          <b>중앙대로 돌발 정체</b>
                          <span>예상 소요시간 +12분</span>
                        </div>
                      </div>
                    )}
                    <div className="map-location-card">
                      <div
                        className={`location-icon ${stage === "arrived" ? "is-parked" : ""}`}
                      >
                        {stage === "arrived" || selectedParking ? (
                          <span>P</span>
                        ) : (
                          <Flag size={18} />
                        )}
                      </div>
                      <div>
                        <span>
                          {selectedParking
                            ? "마지막 주차 위치"
                            : hasSchedule
                              ? `${event.date.slice(5).replace("-", ".")} · ${event.time} 일정`
                              : "선택한 목적지"}
                        </span>
                        <strong>
                          {
                            PLACES[
                              selectedParking && data.parking
                                ? data.parking
                                : destination
                            ].name
                          }
                        </strong>
                      </div>
                      <button
                        className="icon-button"
                        aria-label="목적지 일정 보기"
                        onClick={() => navigate("calendar")}
                      >
                        <ArrowUpRight size={19} />
                      </button>
                    </div>
                  </div>
                  <div className="route-stats">
                    <div>
                      <span>
                        <Route size={14} />{" "}
                        {stage === "arrived" ? "이동 거리" : "전체 경로"}
                      </span>
                      <strong>
                        {distance.toFixed(1)}
                        <small> km</small>
                      </strong>
                    </div>
                    <div>
                      <span>
                        <Clock3 size={14} />{" "}
                        {stage === "arrived" ? "주행 시간" : "예상 주행"}
                      </span>
                      <strong>
                        {driveTime}
                        <small> 분</small>
                      </strong>
                    </div>
                    <div>
                      <span>
                        <Flag size={14} />{" "}
                        {hasSchedule ? "약속 장소 도착" : "예상 도착"}
                      </span>
                      <strong
                        className={
                          hasSchedule && margin < 0 ? "text-orange" : ""
                        }
                      >
                        {clockTime(arrival)}
                      </strong>
                    </div>
                    <div
                      className={`arrival-margin ${hasSchedule && margin < 0 ? "late" : ""}`}
                    >
                      <span>
                        {hasSchedule
                          ? margin < 0
                            ? "지각 예상"
                            : "일정까지 여유"
                          : "주차 · 도보"}
                      </span>
                      <strong>
                        {hasSchedule ? (margin < 0 ? "−" : "+") : ""}
                        {hasSchedule
                          ? Math.abs(margin)
                          : plan.parking + plan.walk}
                        <small> 분</small>
                      </strong>
                    </div>
                  </div>
                </section>
                <aside
                  className="agent-panel"
                  aria-label="DriveMate 추천과 판단 근거"
                  aria-live="polite"
                >
                  <div className="agent-label">
                    <span className="agent-icon">
                      <Sparkles size={18} />
                    </span>
                    <div>
                      <strong>DriveMate</strong>
                      <span>당신만의 모빌리티 메이트</span>
                    </div>
                    <span className="agent-status" />
                  </div>
                  <div className={`agent-message stage-${stage}`}>
                    <span className="agent-kicker">
                      {stage === "traffic"
                        ? "일정 영향 감지"
                        : stage === "arrived"
                          ? "TRIP COMPLETE"
                          : stage === "rerouted"
                            ? "더 나은 경로"
                            : "오늘의 제안"}
                    </span>
                    <h2>{agentTitle}</h2>
                    <p>{agentBody}</p>
                    <div className="recommendation-time">
                      <span>
                        {stage === "ready"
                          ? hasSchedule
                            ? "권장 출발"
                            : "예상 주행"
                          : stage === "arrived"
                            ? "이동 기록"
                            : hasSchedule
                              ? "약속 장소 도착"
                              : "예상 도착"}
                      </span>
                      <strong>
                        {stage === "ready"
                          ? hasSchedule
                            ? `${dayOffset(plan.departure)}${clockTime(plan.departure)}`
                            : `${plan.drive} 분`
                          : stage === "arrived"
                            ? `${distance.toFixed(1)} km`
                            : clockTime(arrival)}
                      </strong>
                      {stage === "traffic" ? (
                        <span className="time-caption warning">
                          {hasSchedule
                            ? margin < 0
                              ? `${Math.abs(margin)}분 지각 예상`
                              : `${margin}분 여유`
                            : "평소보다 12분 추가"}
                        </span>
                      ) : (
                        <span className="time-caption">
                          {stage === "ready"
                            ? hasSchedule
                              ? "주차·도보 포함"
                              : "주차·도보 별도"
                            : stage === "arrived"
                              ? "주차 위치 저장 완료"
                              : hasSchedule
                                ? `${Math.max(0, margin)}분의 여유`
                                : "주차·도보 포함"}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="reasoning">
                    <div className="section-kicker">
                      <span>이렇게 판단했어요</span>
                      <ShieldCheck size={15} />
                    </div>
                    <div className="reason-row">
                      <span className="reason-icon">
                        <CalendarDays size={16} />
                      </span>
                      <div>
                        <strong>
                          {hasSchedule
                            ? `${event.time} ${event.title}`
                            : "내장 캘린더와 연결"}
                        </strong>
                        <span>
                          {hasSchedule
                            ? `${event.buffer}분 먼저 도착하고 싶어요`
                            : "일정을 추가하면 더 정확하게 추천해요"}
                        </span>
                      </div>
                      <Check size={15} />
                    </div>
                    <div className="reason-row">
                      <span className="reason-icon">
                        <Route size={16} />
                      </span>
                      <div>
                        <strong>
                          기본 주행 {plan.baseline}분{" "}
                          {plan.residual >= 0 ? "+" : "−"} 나의 패턴{" "}
                          {Math.abs(plan.residual)}분
                        </strong>
                        <span>
                          {normalSamples
                            ? `최근 ${normalSamples}회 실제 운전 오차의 중앙값`
                            : "기록이 없어 기본 시간으로 시작해요"}
                        </span>
                      </div>
                      <Check size={15} />
                    </div>
                    <div className="reason-row">
                      <span className="reason-icon">
                        <MapPin size={16} />
                      </span>
                      <div>
                        <strong>
                          주차 {plan.parking}분 + 도보 {plan.walk}분
                        </strong>
                        <span>차에서 내린 이후까지 생각했어요</span>
                      </div>
                      <Check size={15} />
                    </div>
                    {delay > 0 && (
                      <div className="reason-row incident">
                        <span className="reason-icon">
                          <TriangleAlert size={16} />
                        </span>
                        <div>
                          <strong>
                            {stage === "traffic"
                              ? "정체 +12분 → 우회 시 9분 절약"
                              : "우회 반영 · 평소보다 3분 추가"}
                          </strong>
                          <span>
                            {stage === "traffic"
                              ? "약속 시간에 미치는 영향을 비교했어요"
                              : "돌발 정체 기록은 평소 운전 패턴에서 제외해요"}
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="agent-primary">
                    <button className="primary-button" onClick={startDrive}>
                      <Navigation size={17} /> 주행 시작{" "}
                      <ArrowRight size={18} />
                    </button>
                  </div>
                  <div className="quick-questions">
                    <button
                      className={question === "why" ? "selected" : ""}
                      onClick={() =>
                        setQuestion(question === "why" ? "" : "why")
                      }
                    >
                      {hasSchedule ? "왜 이 시간에?" : "어떻게 계산해?"}
                    </button>
                    <button
                      className={question === "parking" ? "selected" : ""}
                      onClick={() => {
                        setQuestion(question === "parking" ? "" : "parking");
                        if (data.parking) setSelectedParking(true);
                      }}
                    >
                      차 어디 세웠지?
                    </button>
                    <button
                      className={question === "care" ? "selected" : ""}
                      onClick={() =>
                        setQuestion(question === "care" ? "" : "care")
                      }
                    >
                      정비는 언제?
                    </button>
                  </div>
                  {question && (
                    <div className="quick-answer" role="status">
                      <Sparkles size={16} />
                      <p>
                        {question === "why"
                          ? hasSchedule
                            ? `${event.time} 약속에서 주행 ${plan.drive}분, 주차 ${plan.parking}분, 도보 ${plan.walk}분, 여유 ${event.buffer}분을 빼면 ${dayOffset(plan.departure)}${clockTime(plan.departure)}예요.${plan.departure < startTime ? " 현재는 권장 출발시각이 지났어요." : ""}`
                            : `이 목적지까지 주행 ${plan.drive}분, 주차 ${plan.parking}분, 도보 ${plan.walk}분을 예상해요. 연결된 일정이 없어 출발시각은 추천하지 않아요. 캘린더에 약속을 추가해보세요.`
                          : question === "parking"
                            ? data.parking
                              ? `마지막 주차 위치는 ${PLACES[data.parking].name} 주차장이에요. 지도에 표시했어요.`
                              : "아직 저장된 주차 위치가 없어요. 도착 장면까지 시연하면 자동으로 기억해둘게요."
                            : slot
                              ? `점검까지 ${remaining.toFixed(1)}km 남았어요. 캘린더를 확인하니 ${slot.label}에 1시간이 비어 있어요.`
                              : "추천 시간대에 빈 시간이 없어요. 캘린더에서 정비 시간을 직접 골라주세요."}
                      </p>
                    </div>
                  )}
                  <div className="agent-footnote">
                    <span /> 일정 · 운전 기록 · 차량 상태 연결됨
                  </div>
                </aside>
                <div className="bottom-cards">
                  <section className="today-card">
                    <div className="card-heading">
                      <h3>
                        <CalendarDays size={17} /> 오늘의 일정{" "}
                        <span>{todayEvents.length}</span>
                      </h3>
                      <button
                        className="text-button"
                        onClick={() => navigate("calendar")}
                      >
                        캘린더 <ArrowUpRight size={15} />
                      </button>
                    </div>
                    <div className="today-events">
                      {todayEvents.length ? (
                        todayEvents.map((e) => (
                          <button
                            key={e.id}
                            className={`today-event ${e.id === selected?.id && !preview ? "selected" : ""} ${timeToMinutes(e.time) < DEMO_TIME ? "past" : ""}`}
                            onClick={() => selectEvent(e)}
                          >
                            <span className="event-time">{e.time}</span>
                            <span className="event-dot" />
                            <span className="event-details">
                              <strong>{e.title}</strong>
                              <small>{PLACES[e.destination].name}</small>
                            </span>
                            {e.id === selected?.id && !preview ? (
                              <span className="next-label">선택</span>
                            ) : (
                              <ChevronRight size={14} />
                            )}
                          </button>
                        ))
                      ) : (
                        <button
                          className="empty-calendar"
                          onClick={() => navigate("calendar")}
                        >
                          <Plus size={18} /> 첫 일정을 추가해보세요
                        </button>
                      )}
                    </div>
                  </section>
                  <section className="vehicle-mini">
                    <div className="card-heading">
                      <h3>
                        <CarFront size={17} /> 나의 아반떼
                      </h3>
                      <span className="tiny-pill">CN7</span>
                    </div>
                    <div className="vehicle-mini-stat">
                      <strong>
                        {data.mileage.toLocaleString("ko-KR", {
                          maximumFractionDigits: 1,
                        })}
                        <small> km</small>
                      </strong>
                      <CarIllustration />
                    </div>
                    <div className="maintenance-line">
                      <span>
                        <span className="amber-dot" /> 엔진오일 점검까지
                      </span>
                      <b>
                        {remaining.toLocaleString("ko-KR", {
                          maximumFractionDigits: 1,
                        })}{" "}
                        km
                      </b>
                    </div>
                    <button
                      className="vehicle-link"
                      onClick={() => navigate("vehicle")}
                    >
                      일정에 맞는 정비 시간 찾기
                      <ArrowRight size={15} />
                    </button>
                  </section>
                </div>
              </div>
            </>
          )}
          {view === "calendar" && (
            <Calendar
              events={data.events}
              onChange={(events) => {
                setData((d) => ({ ...d, events }));
                restart();
              }}
              onSelectEvent={selectEvent}
              onClose={() => navigate("cockpit")}
            />
          )}
          {view === "vehicle" && (
            <>
              <PageHeading
                eyebrow="YOUR CAR, TAKEN CARE OF"
                title="차를 아끼는 일도, 함께."
                subtitle="차량 상태와 빈 일정을 연결해, 정비할 때를 놓치지 않아요."
              />
              <div className="vehicle-grid">
                <section className="vehicle-hero panel">
                  <div className="card-heading">
                    <span className="tiny-pill">MY VEHICLE</span>
                    <span className="status-chip">
                      <span /> 관리 중
                    </span>
                  </div>
                  <h2>
                    현대 아반떼 <span>CN7</span>
                  </h2>
                  <p>서연님의 데일리 메이트 · 2023</p>
                  <CarIllustration />
                  <div className="vehicle-hero-stats">
                    <div>
                      <span>누적 주행거리</span>
                      <strong>
                        {data.mileage.toLocaleString("ko-KR", {
                          maximumFractionDigits: 1,
                        })}
                        <small> km</small>
                      </strong>
                    </div>
                    <div>
                      <span>다음 엔진오일 점검</span>
                      <strong>
                        10,000<small> km</small>
                      </strong>
                    </div>
                  </div>
                  <label className="mileage-input-label">
                    주행거리 직접 수정 <span>데모 차량 정보</span>
                    <input
                      aria-label="차량 주행거리"
                      type="number"
                      min="0"
                      max="999999"
                      step="0.1"
                      value={data.mileage}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (Number.isFinite(v) && v >= 0 && v <= 999999)
                          setData((d) => ({ ...d, mileage: v }));
                      }}
                    />
                  </label>
                </section>
                <section className="maintenance-panel panel">
                  <span className="section-icon">
                    <Wrench size={23} />
                  </span>
                  <h2>이제 점검을 준비해볼까요?</h2>
                  <p>
                    엔진오일 점검까지 <b>{remaining.toFixed(1)}km</b> 남았어요.
                    <br />
                    오늘의 이동도 자동으로 더해뒀어요.
                  </p>
                  <div className="mileage-meter">
                    <div
                      style={{
                        width: `${Math.min(100, (data.mileage / 10000) * 100)}%`,
                      }}
                    />
                  </div>
                  <div className="meter-labels">
                    <span>현재 {data.mileage.toLocaleString("ko-KR")} km</span>
                    <span>10,000 km</span>
                  </div>
                  <div className="maintenance-suggestion">
                    <div>
                      <Sparkles size={18} />
                      <strong>캘린더를 살펴봤어요</strong>
                    </div>
                    <h3>{slot?.label ?? "시간을 직접 선택해주세요"}</h3>
                    <p>
                      {slot
                        ? "한 시간 동안 겹치는 일정이 없어요. 정비 시간을 미리 확보해두면 어떨까요?"
                        : "추천 시간대가 모두 차 있어요. 캘린더에서 새로운 시간을 골라주세요."}
                    </p>
                    <button
                      className="primary-button"
                      disabled={!slot}
                      onClick={addMaintenance}
                    >
                      <Plus size={17} /> 내 캘린더에 정비 추가
                    </button>
                    <small>
                      일정만 추가하며 정비소에 실제 예약하지 않아요.
                    </small>
                  </div>
                </section>
                <section className="parking-panel panel">
                  <div className="card-heading">
                    <h3>
                      <MapPin size={18} /> 마지막 주차 위치
                    </h3>
                    <span className="tiny-pill">PARKING MEMORY</span>
                  </div>
                  <strong>
                    {data.parking
                      ? `${PLACES[data.parking].name} 주차장`
                      : "아직 주차 기록이 없어요"}
                  </strong>
                  <p>
                    {data.parking
                      ? "마지막 주행을 마친 위치를 기억해뒀어요."
                      : "주행 시연을 마치면 위치가 자동으로 기록돼요."}
                  </p>
                  <button
                    className="text-button"
                    onClick={() => {
                      setView("cockpit");
                      setSelectedParking(Boolean(data.parking));
                    }}
                  >
                    지도에서 확인 <ArrowUpRight size={17} />
                  </button>
                </section>
              </div>
            </>
          )}
          {view === "trips" && (
            <>
              <PageHeading
                eyebrow="EVERY TRIP MAKES IT MORE YOU"
                title="이동할수록, 나를 더 잘 알게 돼요."
                subtitle="실제 운전과 예상의 차이가 쌓여, 다음 이동을 더 잘 준비해요."
              />
              <div className="trip-summary-grid">
                <StatCard
                  icon={<Route size={20} />}
                  label="기록된 이동"
                  value={String(data.trips.length)}
                  unit="회"
                />
                <StatCard
                  icon={<Gauge size={20} />}
                  label="기록된 거리"
                  value={data.trips
                    .reduce((sum, t) => sum + t.distance, 0)
                    .toFixed(1)}
                  unit="km"
                />
                <StatCard
                  icon={<Sparkles size={20} />}
                  label="스튜디오 개인화 보정"
                  value={`+${planTrip({ ...event, destination: "office" }, data.trips).residual}`}
                  unit="분"
                />
              </div>
              <section className="history-panel panel">
                <div className="card-heading">
                  <h3>최근 주행 기록</h3>
                  <span className="tiny-pill">기기에 저장됨</span>
                </div>
                <div className="trip-table-header">
                  <span>목적지 / 날짜</span>
                  <span>이동 거리</span>
                  <span>기본 예상</span>
                  <span>주행 시간</span>
                  <span>차이</span>
                </div>
                {data.trips.map((t) => (
                  <div className="trip-row" key={t.id}>
                    <div className="trip-route-icon">
                      <Navigation size={19} />
                    </div>
                    <div className="trip-title">
                      <strong>{t.title}</strong>
                      <span>
                        {t.date.replaceAll("-", ".")} ·{" "}
                        {PLACES[t.destination].name}
                        {t.rerouted
                          ? " · 정체·우회"
                          : t.trafficDelay
                            ? " · 정체 구간 주행"
                            : ""}
                      </span>
                    </div>
                    <b>
                      {t.distance.toFixed(1)}
                      <small> km</small>
                    </b>
                    <span>{t.baseline}분</span>
                    <span>{t.actual}분</span>
                    <span className="residual-pill">
                      {t.actual - t.baseline >= 0 ? "+" : ""}
                      {t.actual - t.baseline}분
                    </span>
                  </div>
                ))}
              </section>
              <div className="history-note">
                <ShieldCheck size={20} />
                <p>
                  <strong>운전 패턴은 평소의 기록으로 계산해요.</strong>
                  <br />
                  같은 목적지의 최근 기록에서 ‘주행 시간 − 기본 예상’의 중앙값을
                  사용해요. 돌발 정체·우회 기록은 평소 패턴에서 제외해요.
                </p>
              </div>
            </>
          )}
        </main>
        <footer className="app-footer">
          <span>
            DriveMate <span>·</span> A little more care in every journey.
          </span>
          <button onClick={() => setShowReset(true)}>
            <Settings2 size={13} /> 데모 데이터 초기화
          </button>
        </footer>
      </div>
      {toast && (
        <div className="toast" role="status">
          <CheckCheck size={18} />
          {toast}
        </div>
      )}
      {(showHelp || showReset) && (
        <div
          className="modal-backdrop"
          onClick={() => {
            setShowHelp(false);
            setShowReset(false);
          }}
        >
          <section
            className="info-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="info-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="modal-close icon-button"
              aria-label="닫기"
              onClick={() => {
                setShowHelp(false);
                setShowReset(false);
              }}
            >
              <X size={20} />
            </button>
            <span className="section-icon">
              {showReset ? <RotateCcw /> : <Sparkles />}
            </span>
            <h2 id="info-modal-title">
              {showReset
                ? "처음의 DriveMate로 돌아갈까요?"
                : "일정에서 길 안내까지."}
            </h2>
            {showReset ? (
              <>
                <p>
                  추가한 일정과 주행 기록, 수정한 차량 정보가 처음의 가상
                  데이터로 돌아가요.
                </p>
                <button
                  className="primary-button"
                  onClick={() => {
                    setData(freshState());
                    setSelectedId("meeting");
                    setPreview(null);
                    restart();
                    setShowReset(false);
                    setToast("처음의 데모 데이터로 돌아왔어요.");
                  }}
                >
                  데모 데이터 초기화
                </button>
              </>
            ) : (
              <>
                <p>
                  가상 도시에서 개인화된 이동을 체험하는 목업이에요. 실제
                  내비게이션이나 실시간 AI 서비스는 연결되어 있지 않아요.
                </p>
                <ol>
                  <li>
                    <b>주행 시작</b>을 누르면 전체 화면 길 안내로 전환돼요.
                  </li>
                  <li>
                    <b>길 안내</b>에서 다음 회전과 남은 거리, 도착시간을
                    확인해요.
                  </li>
                  <li>
                    <b>캘린더</b>에서 시간·목적지·도착 여유를 바꿔보세요.
                  </li>
                  <li>
                    <b>내 차량</b>에서 빈 시간에 정비 일정을 추가해보세요.
                  </li>
                </ol>
                <div className="help-note">
                  시연 날짜는 2026년 9월 23일로 고정되어 있어요. 편집한 일정과
                  기록은 이 기기에 저장돼요.
                </div>
                <button
                  className="primary-button"
                  onClick={() => {
                    setShowHelp(false);
                    startDrive();
                  }}
                >
                  <Navigation size={17} /> 주행 시작
                </button>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function PageHeading({
  eyebrow,
  title,
  subtitle,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
}) {
  return (
    <section className="page-heading secondary-heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="heading-subtitle">{subtitle}</p>
      </div>
    </section>
  );
}
function StatCard({
  icon,
  label,
  value,
  unit,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  unit: string;
}) {
  return (
    <div className="stat-card panel">
      <span className="section-icon">{icon}</span>
      <div>
        <span>{label}</span>
        <strong>
          {value}
          <small> {unit}</small>
        </strong>
      </div>
    </div>
  );
}
function CarIllustration() {
  return (
    <svg
      className="car-illustration"
      viewBox="0 0 300 140"
      role="img"
      aria-label="실버 아반떼 차량 일러스트"
    >
      <defs>
        <linearGradient id="body" x1="0" y1="0" x2="0" y2="1">
          <stop stopColor="#eef1ed" />
          <stop offset="1" stopColor="#a6b7af" />
        </linearGradient>
      </defs>
      <ellipse cx="151" cy="116" rx="120" ry="9" fill="#294235" opacity=".1" />
      <path
        d="M38 72L72 62L111 30Q116 27 125 27H185Q199 27 209 40L229 65L265 77Q278 80 277 95L274 107H25V92Q26 79 38 72Z"
        fill="url(#body)"
        stroke="#879c91"
        strokeWidth="2"
      />
      <path
        d="M87 62L118 35H149V62ZM157 35H183Q191 34 198 43L213 62H157Z"
        fill="#385c54"
      />
      <path d="M86 66H222M154 68V102" stroke="#9db0a5" strokeWidth="1.5" />
      <path d="M29 85L52 80L48 90H27M251 77L272 82V88H252Z" fill="#f9fff1" />
      <path
        d="M127 72H140M198 72H212"
        stroke="#738c7e"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <path d="M91 104H214" stroke="#7f9588" strokeWidth="3" />
      <circle cx="72" cy="104" r="20" fill="#283d35" />
      <circle cx="72" cy="104" r="11" fill="#bac8bf" />
      <circle cx="72" cy="104" r="5" fill="#7c9587" />
      <circle cx="233" cy="104" r="20" fill="#283d35" />
      <circle cx="233" cy="104" r="11" fill="#bac8bf" />
      <circle cx="233" cy="104" r="5" fill="#7c9587" />
    </svg>
  );
}
