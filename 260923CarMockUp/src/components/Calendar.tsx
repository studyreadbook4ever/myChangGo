import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  ArrowUpRight,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock3,
  MapPin,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import "./Calendar.css";

export type ScheduleEvent = {
  id: string;
  title: string;
  date: string;
  time: string;
  duration: number;
  destination: "office" | "cafe" | "service" | "home";
  category: "work" | "personal" | "care";
  buffer: number;
};

export type CalendarProps = {
  events: ScheduleEvent[];
  onChange: (events: ScheduleEvent[]) => void;
  onSelectEvent: (event: ScheduleEvent) => void;
  onClose?: () => void;
};

const DEMO_TODAY = "2026-09-23";
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
const DESTINATIONS: Record<ScheduleEvent["destination"], string> = {
  home: "우리 집",
  office: "메이트 스튜디오",
  cafe: "리버사이드 카페",
  service: "그린 오토케어",
};
const CATEGORIES: Record<ScheduleEvent["category"], string> = {
  work: "업무",
  personal: "개인",
  care: "차량 관리",
};

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function localDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day, 12);
}

function fullDate(value: string): string {
  const date = localDate(value);
  return `${date.getMonth() + 1}월 ${date.getDate()}일 ${WEEKDAYS[date.getDay()]}요일`;
}

function endTime(time: string, duration: number): string {
  const [hours, minutes] = time.split(":").map(Number);
  const total = hours * 60 + minutes + duration;
  return `${total >= 1440 ? "다음 날 " : ""}${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

type EditorProps = {
  event?: ScheduleEvent;
  date: string;
  onSave: (event: ScheduleEvent) => void;
  onCancel: () => void;
  onDelete?: () => void;
};

function EventEditor({ event, date, onSave, onCancel, onDelete }: EditorProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef(
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const titleId = useId();
  const errorId = useId();
  const [title, setTitle] = useState(event?.title ?? "");
  const [eventDate, setEventDate] = useState(event?.date ?? date);
  const [time, setTime] = useState(event?.time ?? "14:00");
  const [duration, setDuration] = useState(String(event?.duration ?? 60));
  const [buffer, setBuffer] = useState(String(event?.buffer ?? 10));
  const [destination, setDestination] = useState<ScheduleEvent["destination"]>(
    event?.destination ?? "office",
  );
  const [category, setCategory] = useState<ScheduleEvent["category"]>(
    event?.category ?? "work",
  );
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    titleInputRef.current?.focus();
    return () => {
      if (dialog?.open) dialog.close();
      if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
    };
  }, []);

  function handleSubmit(submitEvent: FormEvent<HTMLFormElement>) {
    submitEvent.preventDefault();
    const durationValue = Number(duration);
    const bufferValue = Number(buffer);
    if (!title.trim()) {
      setError("일정 이름을 입력해 주세요.");
      return;
    }
    if (
      !eventDate ||
      !/^\d{4}-\d{2}-\d{2}$/.test(eventDate) ||
      dateKey(localDate(eventDate)) !== eventDate ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)
    ) {
      setError("일정의 날짜와 시간을 확인해 주세요.");
      return;
    }
    if (
      !Number.isInteger(durationValue) ||
      durationValue < 5 ||
      durationValue > 480
    ) {
      setError("일정 길이는 5분부터 480분까지 입력할 수 있어요.");
      return;
    }
    if (
      buffer.trim() === "" ||
      !Number.isInteger(bufferValue) ||
      bufferValue < 0 ||
      bufferValue > 60
    ) {
      setError("도착 여유 시간은 0분부터 60분까지 입력할 수 있어요.");
      return;
    }
    onSave({
      id: event?.id ?? `schedule-${crypto.randomUUID()}`,
      title: title.trim(),
      date: eventDate,
      time,
      duration: durationValue,
      destination,
      category,
      buffer: bufferValue,
    });
  }

  return (
    <dialog
      className="calendar-dialog"
      ref={dialogRef}
      aria-labelledby={titleId}
      onCancel={(cancelEvent) => {
        cancelEvent.preventDefault();
        onCancel();
      }}
      onClick={(clickEvent) => {
        if (clickEvent.target !== clickEvent.currentTarget) return;
        const rect = clickEvent.currentTarget.getBoundingClientRect();
        if (
          clickEvent.clientX < rect.left ||
          clickEvent.clientX > rect.right ||
          clickEvent.clientY < rect.top ||
          clickEvent.clientY > rect.bottom
        )
          onCancel();
      }}
    >
      <form
        onSubmit={handleSubmit}
        className="calendar-editor"
        aria-describedby={error ? errorId : undefined}
      >
        <div className="calendar-editor-heading">
          <div>
            <span className="calendar-eyebrow">YOUR NEXT PLAN</span>
            <h2 id={titleId}>{event ? "일정 수정하기" : "새로운 일정"}</h2>
          </div>
          <button
            type="button"
            className="calendar-icon-button"
            aria-label="일정 편집 닫기"
            onClick={onCancel}
          >
            <X size={20} />
          </button>
        </div>
        <label className="calendar-field">
          일정 이름
          <input
            ref={titleInputRef}
            required
            maxLength={60}
            placeholder="어떤 하루를 계획하고 있나요?"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              setError("");
            }}
          />
        </label>
        <div className="calendar-field-row">
          <label className="calendar-field">
            날짜
            <input
              type="date"
              required
              min="1900-01-01"
              max="9999-12-31"
              value={eventDate}
              onChange={(e) => setEventDate(e.target.value)}
            />
          </label>
          <label className="calendar-field">
            시작 시간
            <input
              type="time"
              required
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </label>
        </div>
        <div className="calendar-field-row">
          <label className="calendar-field">
            장소
            <select
              aria-label="장소"
              value={destination}
              onChange={(e) =>
                setDestination(e.target.value as ScheduleEvent["destination"])
              }
            >
              {Object.entries(DESTINATIONS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="calendar-field">
            분류
            <select
              aria-label="분류"
              value={category}
              onChange={(e) =>
                setCategory(e.target.value as ScheduleEvent["category"])
              }
            >
              {Object.entries(CATEGORIES).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="calendar-field-row">
          <label className="calendar-field">
            일정 길이{" "}
            <span className="calendar-number-field">
              <input
                type="number"
                inputMode="numeric"
                required
                min={5}
                max={480}
                step={1}
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
              />
              <span>분</span>
            </span>
          </label>
          <label className="calendar-field">
            도착 여유 시간{" "}
            <span className="calendar-number-field">
              <input
                type="number"
                inputMode="numeric"
                required
                min={0}
                max={60}
                step={1}
                value={buffer}
                onChange={(e) => setBuffer(e.target.value)}
              />
              <span>분</span>
            </span>
          </label>
        </div>
        <div className="calendar-editor-note">
          <Sparkles size={16} />
          <p>
            주차하고 잠깐 숨을 고를 시간까지.
            <br />
            설정한 여유 시간에 맞춰 출발을 도와드려요.
          </p>
        </div>
        {error && (
          <p id={errorId} className="calendar-error" role="alert">
            {error}
          </p>
        )}
        {confirmDelete ? (
          <div className="calendar-delete-confirm" role="alert">
            <p>이 일정을 삭제할까요?</p>
            <div>
              <button
                type="button"
                className="calendar-secondary-button"
                onClick={() => setConfirmDelete(false)}
              >
                유지하기
              </button>
              <button
                type="button"
                className="calendar-delete-button"
                onClick={onDelete}
              >
                삭제하기
              </button>
            </div>
          </div>
        ) : (
          <div className="calendar-editor-actions">
            {event && (
              <button
                type="button"
                className="calendar-remove-button"
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 size={16} />
                삭제
              </button>
            )}
            <button
              type="button"
              className="calendar-secondary-button"
              onClick={onCancel}
            >
              취소
            </button>
            <button type="submit" className="calendar-primary-button">
              {event ? "변경 저장" : "일정 추가"}
              <ArrowUpRight size={16} />
            </button>
          </div>
        )}
      </form>
    </dialog>
  );
}

export function Calendar({
  events,
  onChange,
  onSelectEvent,
  onClose,
}: CalendarProps) {
  const [month, setMonth] = useState(() => new Date(2026, 8, 1, 12));
  const [selectedDate, setSelectedDate] = useState(DEMO_TODAY);
  const [editing, setEditing] = useState<ScheduleEvent | "new" | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const monthKey = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}`;
  const monthEvents = events.filter((event) =>
    event.date.startsWith(`${monthKey}-`),
  );
  const dayEvents = events
    .filter((event) => event.date === selectedDate)
    .sort(
      (a, b) => a.time.localeCompare(b.time) || a.title.localeCompare(b.title),
    );
  const gridStart = new Date(
    month.getFullYear(),
    month.getMonth(),
    1 - month.getDay(),
    12,
  );
  const days = Array.from(
    { length: 42 },
    (_, index) =>
      new Date(
        gridStart.getFullYear(),
        gridStart.getMonth(),
        gridStart.getDate() + index,
        12,
      ),
  );

  function selectDay(date: Date) {
    setSelectedDate(dateKey(date));
    if (
      date.getMonth() !== month.getMonth() ||
      date.getFullYear() !== month.getFullYear()
    )
      setMonth(new Date(date.getFullYear(), date.getMonth(), 1, 12));
  }

  function moveMonth(offset: number) {
    const nextMonth = new Date(
      month.getFullYear(),
      month.getMonth() + offset,
      1,
      12,
    );
    const day = Math.min(
      localDate(selectedDate).getDate(),
      new Date(nextMonth.getFullYear(), nextMonth.getMonth() + 1, 0).getDate(),
    );
    setMonth(nextMonth);
    setSelectedDate(
      dateKey(new Date(nextMonth.getFullYear(), nextMonth.getMonth(), day, 12)),
    );
  }

  function saveEvent(event: ScheduleEvent) {
    const exists = events.some((item) => item.id === event.id);
    onChange(
      exists
        ? events.map((item) => (item.id === event.id ? event : item))
        : [...events, event],
    );
    selectDay(localDate(event.date));
    setEditing(null);
    setAnnouncement(
      `${event.title} 일정이 ${exists ? "수정" : "추가"}되었습니다.`,
    );
  }

  function deleteEvent(event: ScheduleEvent) {
    onChange(events.filter((item) => item.id !== event.id));
    setEditing(null);
    setAnnouncement(`${event.title} 일정이 삭제되었습니다.`);
  }

  return (
    <section className="calendar-page" aria-label="나의 일정">
      <div className="calendar-page-heading">
        <div>
          <span className="calendar-eyebrow">
            A LITTLE MORE ROOM IN YOUR DAY
          </span>
          <h1>
            하루를 계획하면,
            <br className="calendar-mobile-break" /> 이동은 제가 챙길게요.
          </h1>
          <p>일정과 목적지를 한곳에. 다음 약속까지 여유롭게 도착하세요.</p>
        </div>
        <div className="calendar-heading-actions">
          <button
            className="calendar-primary-button"
            onClick={() => setEditing("new")}
          >
            <Plus size={18} />
            일정 추가
          </button>
          {onClose && (
            <button
              className="calendar-icon-button"
              aria-label="일정 닫기"
              onClick={onClose}
            >
              <X size={20} />
            </button>
          )}
        </div>
      </div>
      <div className="calendar-layout">
        <div className="calendar-month-panel">
          <div className="calendar-month-heading">
            <div className="calendar-month-title">
              <h2>
                {month.getFullYear()}년{" "}
                <strong>{month.getMonth() + 1}월</strong>
              </h2>
              <span>{monthEvents.length}개의 일정</span>
            </div>
            <div className="calendar-month-navigation">
              <button
                className="calendar-today-button"
                onClick={() => {
                  setMonth(new Date(2026, 8, 1, 12));
                  setSelectedDate(DEMO_TODAY);
                }}
              >
                데모 오늘
              </button>
              <button
                className="calendar-icon-button"
                aria-label="이전 달"
                onClick={() => moveMonth(-1)}
              >
                <ChevronLeft size={19} />
              </button>
              <button
                className="calendar-icon-button"
                aria-label="다음 달"
                onClick={() => moveMonth(1)}
              >
                <ChevronRight size={19} />
              </button>
            </div>
          </div>
          <div className="calendar-weekdays" aria-hidden="true">
            {WEEKDAYS.map((day) => (
              <span key={day}>{day}</span>
            ))}
          </div>
          <div
            className="calendar-month-grid"
            aria-label={`${month.getFullYear()}년 ${month.getMonth() + 1}월 날짜 선택`}
          >
            {days.map((day) => {
              const key = dateKey(day);
              const dateEvents = events
                .filter((event) => event.date === key)
                .sort((a, b) => a.time.localeCompare(b.time));
              const isSelected = key === selectedDate;
              const isToday = key === DEMO_TODAY;
              const outside = day.getMonth() !== month.getMonth();
              return (
                <button
                  key={key}
                  className={`calendar-day${outside ? " calendar-day-outside" : ""}${isSelected ? " calendar-day-selected" : ""}${isToday ? " calendar-day-today" : ""}`}
                  onClick={() => selectDay(day)}
                  aria-pressed={isSelected}
                  aria-current={isToday ? "date" : undefined}
                  aria-label={`${day.getFullYear()}년 ${fullDate(key)}${isToday ? ", 데모 오늘" : ""}, 일정 ${dateEvents.length}개`}
                >
                  <span className="calendar-day-number">{day.getDate()}</span>
                  <span className="calendar-day-events" aria-hidden="true">
                    {dateEvents.slice(0, 2).map((event) => (
                      <span
                        className={`calendar-grid-event calendar-category-${event.category}`}
                        key={event.id}
                      >
                        <i />
                        {event.title}
                      </span>
                    ))}
                    {dateEvents.length > 2 && (
                      <span className="calendar-grid-more">
                        +{dateEvents.length - 2}개
                      </span>
                    )}
                  </span>
                  <span className="calendar-day-dots" aria-hidden="true">
                    {dateEvents.slice(0, 3).map((event) => (
                      <i
                        className={`calendar-dot-${event.category}`}
                        key={event.id}
                      />
                    ))}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="calendar-legend">
            {Object.entries(CATEGORIES).map(([key, label]) => (
              <span key={key}>
                <i className={`calendar-dot-${key}`} />
                {label}
              </span>
            ))}
            <span className="calendar-demo-caption">
              데모 기준일 · 2026.09.23
            </span>
          </div>
        </div>
        <aside className="calendar-agenda" aria-label="선택한 날짜의 일정">
          <div className="calendar-agenda-heading">
            <div>
              <span className="calendar-eyebrow">YOUR DAY, AT A GLANCE</span>
              <h2>{fullDate(selectedDate)}</h2>
            </div>
            <span className="calendar-count">{dayEvents.length}</span>
          </div>
          {selectedDate === DEMO_TODAY && (
            <span className="calendar-selected-today">오늘의 데모 일정</span>
          )}
          <div className="calendar-agenda-list">
            {dayEvents.length === 0 ? (
              <div className="calendar-empty">
                <span>
                  <CalendarDays size={29} strokeWidth={1.4} />
                </span>
                <h3>아직 비어 있는 하루</h3>
                <p>
                  가고 싶은 곳, 만나고 싶은 사람.
                  <br />첫 번째 일정을 더해보세요.
                </p>
                <button
                  className="calendar-secondary-button"
                  onClick={() => setEditing("new")}
                >
                  <Plus size={16} />
                  일정 추가하기
                </button>
              </div>
            ) : (
              dayEvents.map((event) => (
                <article
                  key={event.id}
                  className={`calendar-agenda-card calendar-card-${event.category}`}
                >
                  <div className="calendar-event-topline">
                    <span className="calendar-event-time">
                      {event.time}
                      <span> — {endTime(event.time, event.duration)}</span>
                    </span>
                    <button
                      className="calendar-edit-button"
                      aria-label={`${event.title} 일정 수정`}
                      onClick={() => setEditing(event)}
                    >
                      <Pencil size={15} />
                    </button>
                  </div>
                  <span
                    className={`calendar-event-category calendar-category-${event.category}`}
                  >
                    {CATEGORIES[event.category]}
                  </span>
                  <h3>{event.title}</h3>
                  <p className="calendar-event-place">
                    <MapPin size={14} />
                    {DESTINATIONS[event.destination]}
                  </p>
                  <div className="calendar-event-bottom">
                    <span>
                      <Clock3 size={13} />
                      {event.buffer > 0
                        ? `${event.buffer}분 일찍 도착`
                        : "일정 시작에 맞춰 도착"}
                    </span>
                    <button
                      onClick={() => onSelectEvent(event)}
                      aria-label={`${event.title} ${DESTINATIONS[event.destination]} 경로 보기`}
                    >
                      경로 보기
                      <ArrowUpRight size={15} />
                    </button>
                  </div>
                </article>
              ))
            )}
          </div>
          <div className="calendar-insight">
            <span className="calendar-insight-icon">
              <Sparkles size={19} />
            </span>
            <div>
              <h3>일정을 알면, 이동이 편해져요.</h3>
              <p>
                약속 장소와 도착 여유 시간을 함께 살펴보고, 하루에 맞는 출발을
                도와드려요.
              </p>
            </div>
          </div>
        </aside>
      </div>
      <div className="calendar-sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
      {editing !== null && (
        <EventEditor
          event={editing === "new" ? undefined : editing}
          date={selectedDate}
          onSave={saveEvent}
          onCancel={() => setEditing(null)}
          onDelete={editing === "new" ? undefined : () => deleteEvent(editing)}
        />
      )}
    </section>
  );
}

export default Calendar;
