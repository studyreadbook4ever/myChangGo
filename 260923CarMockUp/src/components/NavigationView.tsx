import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  ArrowUpRight,
  Check,
  CornerUpLeft,
  CornerUpRight,
  Flag,
  LocateFixed,
  MapPin,
  Navigation,
  Route,
  Sparkles,
  TriangleAlert,
  X,
} from "lucide-react";
import CityMap, { getNavigationInstruction, ROUTE_DISTANCES } from "./CityMap";
import type { ScheduleEvent } from "./Calendar";
import { clockTime, PLACES } from "../model";
import type { Destination, Stage } from "../model";
import "./NavigationView.css";

interface NavigationViewProps {
  stage: Stage;
  progress: number;
  destination: Destination;
  alternate: boolean;
  totalDistance: number;
  driveTime: number;
  elapsed: number;
  vehicleArrival: number;
  venueArrival: number;
  schedule: ScheduleEvent | null;
  parkingMinutes: number;
  walkMinutes: number;
  needsRouteChoice: boolean;
  confirmExit: boolean;
  onChooseRoute: (alternate: boolean) => void;
  onRequestEnd: () => void;
  onCancelEnd: () => void;
  onFinish: () => void;
}

export default function NavigationView(props: NavigationViewProps) {
  const {
    stage,
    progress,
    destination,
    alternate,
    totalDistance,
    driveTime,
    elapsed,
    vehicleArrival,
    venueArrival,
    schedule,
    parkingMinutes,
    walkMinutes,
    needsRouteChoice,
    confirmExit,
    onChooseRoute,
    onRequestEnd,
    onCancelEnd,
    onFinish,
  } = props;
  const [following, setFollowing] = useState(true);
  const [routeNotice, setRouteNotice] = useState(false);
  const arrived = stage === "arrived";
  const instruction = getNavigationInstruction(
    destination,
    progress,
    alternate,
  );
  const TurnIcon =
    instruction.direction === "left"
      ? CornerUpLeft
      : instruction.direction === "right"
        ? CornerUpRight
        : instruction.direction === "arrive"
          ? Flag
          : ArrowUp;
  const turnLabel =
    instruction.direction === "left"
      ? "좌회전"
      : instruction.direction === "right"
        ? "우회전"
        : instruction.direction === "arrive"
          ? "목적지 도착"
          : "직진";
  const traversed =
    ROUTE_DISTANCES[destination].normal * Math.min(progress, 0.3) +
    ((totalDistance - ROUTE_DISTANCES[destination].normal * 0.3) *
      Math.max(0, progress - 0.3)) /
      0.7;
  const remainingDistance = Math.max(0, totalDistance - traversed);
  const remainingMinutes = Math.max(0, Math.ceil(driveTime - elapsed));
  const speed =
    arrived || needsRouteChoice || confirmExit
      ? 0
      : Math.round((totalDistance / driveTime) * 60);
  const distanceLabel =
    instruction.distanceMeters >= 1000
      ? `${(instruction.distanceMeters / 1000).toFixed(1)}`
      : String(Math.max(0, Math.round(instruction.distanceMeters / 10) * 10));
  const distanceUnit = instruction.distanceMeters >= 1000 ? "km" : "m";
  const scheduleTime = schedule
    ? Number(schedule.time.split(":")[0]) * 60 +
      Number(schedule.time.split(":")[1])
    : 0;
  const margin = scheduleTime - venueArrival;

  useEffect(() => {
    if (!alternate) return;
    setRouteNotice(true);
    const timer = setTimeout(() => setRouteNotice(false), 4500);
    return () => clearTimeout(timer);
  }, [alternate]);

  return (
    <section
      className={`navigation-screen ${arrived ? "navigation-arrived" : ""} ${needsRouteChoice ? "navigation-traffic" : ""}`}
      role="region"
      aria-label="주행 내비게이션"
    >
      <div className="navigation-map">
        <CityMap
          stage={stage}
          progress={progress}
          destination={destination}
          alternate={alternate}
          parking={arrived}
          navigationMode
          followVehicle={following}
          cameraAnchorY={needsRouteChoice || arrived ? 0.31 : 0.62}
          showControls
        />
      </div>

      {!arrived && (
        <div className="navigation-guidance" aria-label="다음 길 안내">
          <div className="navigation-maneuver">
            <TurnIcon size={58} strokeWidth={2.3} />
            <div>
              <div className="navigation-turn-distance">
                <strong>{distanceLabel}</strong>
                <span>{distanceUnit}</span>
              </div>
              <p>
                {turnLabel}
                {instruction.nextRoad ? (
                  <span> · {instruction.nextRoad}</span>
                ) : null}
              </p>
            </div>
          </div>
          <div className="navigation-road">
            <Navigation size={14} fill="currentColor" />
            <span>{instruction.road}</span>
            <span className="navigation-mock-label">가상 주행</span>
          </div>
        </div>
      )}

      <button
        className="navigation-close"
        onClick={arrived ? onFinish : onRequestEnd}
        aria-label={arrived ? "주행 화면 닫기" : "안내 종료"}
      >
        <X size={22} />
      </button>

      {routeNotice && !arrived && (
        <div className="navigation-route-notice" role="status">
          <Check size={17} />
          <span>9분 빠른 경로로 변경했어요</span>
        </div>
      )}

      {!arrived && (
        <>
          <div
            className="navigation-speed"
            aria-label={`현재 속도 ${speed}킬로미터 매시`}
          >
            <strong>{speed}</strong>
            <span>km/h</span>
          </div>
          <button
            className={`navigation-follow ${following ? "following" : ""}`}
            onClick={() => setFollowing((value) => !value)}
            aria-label={following ? "전체 경로 보기" : "현재 위치 따라가기"}
          >
            {following ? <Route size={22} /> : <LocateFixed size={23} />}
            <span>{following ? "전체 경로" : "현재 위치"}</span>
          </button>
        </>
      )}

      <div className="navigation-bottom-stack">
        {needsRouteChoice && (
          <section
            className="navigation-route-choice"
            aria-label="교통 상황과 우회 경로"
            aria-live="polite"
          >
            <div className="navigation-incident-title">
              <span>
                <TriangleAlert size={17} /> 전방 정체
              </span>
              <b>더 빠른 경로를 찾았어요</b>
            </div>
            <p>
              현재 경로는 12분 지연돼요.
              {schedule
                ? ` 약속 장소에 ${clockTime(venueArrival)} 도착${margin < 0 ? `, ${Math.abs(margin)}분 늦을 수 있어요.` : `, ${margin}분의 여유가 있어요.`}`
                : ""}
            </p>
            <div className="navigation-alternative">
              <div>
                <Sparkles size={18} />
                <strong>우회하면 9분 단축</strong>
              </div>
              <span>{clockTime(vehicleArrival - 9)} 차량 도착</span>
            </div>
            <div className="navigation-choice-actions">
              <button onClick={() => onChooseRoute(false)}>
                현재 경로 유지
              </button>
              <button
                onClick={() => {
                  setFollowing(true);
                  onChooseRoute(true);
                }}
              >
                우회 경로로 변경
                <ArrowUpRight size={17} />
              </button>
            </div>
          </section>
        )}

        {arrived ? (
          <section className="navigation-arrival-card" aria-label="도착 요약">
            <span className="navigation-arrival-icon">
              <Flag size={23} />
            </span>
            <p className="navigation-arrival-eyebrow">목적지에 도착했어요</p>
            <h1>{PLACES[destination].name}</h1>
            <div className="navigation-arrival-stats">
              <div>
                <strong>
                  {totalDistance.toFixed(1)}
                  <small> km</small>
                </strong>
                <span>이동 거리</span>
              </div>
              <div>
                <strong>
                  {driveTime}
                  <small> 분</small>
                </strong>
                <span>주행 시간</span>
              </div>
              <div>
                <strong>{clockTime(vehicleArrival)}</strong>
                <span>차량 도착</span>
              </div>
            </div>
            <p className="navigation-parking-saved">
              <MapPin size={15} /> 주차 위치와 주행 기록을 저장했어요
            </p>
            {schedule && (
              <p className="navigation-arrival-schedule">
                주차 {parkingMinutes}분 · 도보 {walkMinutes}분 후{" "}
                {clockTime(venueArrival)} 약속 장소 도착
              </p>
            )}
            <button className="navigation-finish" onClick={onFinish}>
              주행 마치기
              <Check size={18} />
            </button>
          </section>
        ) : (
          <section className="navigation-eta" aria-label="남은 주행 정보">
            <div className="navigation-destination">
              <span className="navigation-destination-dot" />
              <strong>{PLACES[destination].name}</strong>
              <span>도착 예정</span>
              <b>{clockTime(vehicleArrival)}</b>
            </div>
            <div className="navigation-eta-main">
              <strong>
                {remainingMinutes}
                <small>분</small>
              </strong>
              <span className="navigation-stat-divider" />
              <strong>
                {remainingDistance < 1
                  ? Math.round((remainingDistance * 1000) / 10) * 10
                  : remainingDistance.toFixed(1)}
                <small>{remainingDistance < 1 ? "m" : "km"}</small>
              </strong>
              <div className="navigation-arrival-status">
                <span
                  className={`navigation-status-dot ${needsRouteChoice ? "slow" : ""}`}
                />
                <span>
                  {needsRouteChoice
                    ? "정체 구간 확인"
                    : alternate
                      ? "우회 경로 안내 중"
                      : "경로 안내 중"}
                </span>
              </div>
            </div>
            {schedule && (
              <div
                className={`navigation-schedule-line ${margin < 0 ? "late" : ""}`}
              >
                <span>
                  {schedule.time} {schedule.title}
                </span>
                <span>도보 포함 {clockTime(venueArrival)}</span>
              </div>
            )}
            <div
              className="navigation-trip-progress"
              role="progressbar"
              aria-label="목적지까지 주행 진행률"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progress * 100)}
            >
              <span style={{ width: `${progress * 100}%` }} />
            </div>
          </section>
        )}
      </div>
      {confirmExit && (
        <EndNavigationDialog onCancel={onCancelEnd} onConfirm={onFinish} />
      )}
    </section>
  );
}

function EndNavigationDialog({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="navigation-end-dialog"
      aria-labelledby="navigation-end-title"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <span className="navigation-end-icon">
        <Navigation size={25} />
      </span>
      <h2 id="navigation-end-title">안내를 종료할까요?</h2>
      <p>
        목적지에 도착하기 전이에요.
        <br />
        현재 이동은 주행 기록에 저장되지 않아요.
      </p>
      <div>
        <button onClick={onCancel} autoFocus>
          계속 안내
        </button>
        <button onClick={onConfirm}>안내 종료하기</button>
      </div>
    </dialog>
  );
}
