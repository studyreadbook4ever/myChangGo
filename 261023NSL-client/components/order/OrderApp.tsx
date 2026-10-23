"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import type { ReactNode, ComponentProps } from "react";
import {
  View,
  Text,
  Pressable,
  Image,
  ScrollView,
  TextInput,
  Modal,
  ActivityIndicator,
  StyleSheet,
  useWindowDimensions,
} from "react-native-web";
import {
  Mic,
  Bell,
  ShoppingBag,
  Globe2,
  Plus,
  Minus,
  Check,
  X,
  ArrowRight,
  ChevronRight,
  Leaf,
  Utensils,
  VolumeX,
  Square,
  CircleAlert,
  Clock3,
} from "lucide-react";
import {
  copy,
  languages,
  categoryNames,
  allergenNames,
  localizedError,
} from "./i18n";
import { guestCopy } from "./guest-copy";
import { historyCopy } from "./history-copy";
import { PcmWavRecorder } from "./recorder";
import {
  api,
  json,
  money,
  itemName,
  type Language,
  type MenuItem,
  type Session,
  type Health,
  type Confirmation,
  type Order,
  type Delivery,
  type ServiceRequest,
} from "./types";
import { s, colors as p } from "./styles";
import { readDraft, writeDraft, clearDraft } from "./draft";

type Panel =
  | "cart"
  | "request"
  | "review"
  | "history"
  | "language"
  | "table"
  | "dish"
  | null;
type Kind = "order" | "service";
type CustomerOrder = Order & { stage?: string; deliveries: Delivery[] };
type CustomerRequest = ServiceRequest & {
  stage?: string;
  deliveries: Delivery[];
  translationStatus?: string;
};
type TurnResult = {
  session: Session;
  transcript: string;
  reply: string;
  serviceRequest?: CustomerRequest;
  deliveries?: Delivery[];
};
type Pending = { value: string | Blob; kind: Kind; requestId: string };
type ViewStyle = ComponentProps<typeof View>["style"];
// The public gateway creates the device cookie on health only. Share this
// promise across StrictMode mounts so no request races a second cookie issuer.
let bootstrapPromise: Promise<Health> | null = null;
function bootstrap() {
  if (!bootstrapPromise)
    bootstrapPromise = api<Health>("/api/health").catch((error) => {
      bootstrapPromise = null;
      throw error;
    });
  return bootstrapPromise;
}
function Button({
  children,
  onPress,
  disabled = false,
  secondary = false,
  icon = false,
  label,
  style,
  testID,
}: {
  children: ReactNode;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
  icon?: boolean;
  label?: string;
  style?: ViewStyle;
  testID?: string;
}) {
  return (
    <Pressable
      role="button"
      aria-label={label}
      aria-disabled={disabled}
      disabled={disabled}
      testID={testID}
      onPress={onPress}
      style={({ pressed }: { pressed: boolean }) => [
        s.button,
        secondary && s.secondary,
        icon && s.iconButton,
        disabled && s.disabled,
        pressed && s.pressed,
        style,
      ]}
    >
      {children}
    </Pressable>
  );
}
function BT({
  children,
  secondary = false,
}: {
  children: ReactNode;
  secondary?: boolean;
}) {
  return (
    <Text style={[s.buttonText, secondary && { color: p.ink }]}>
      {children}
    </Text>
  );
}
function Tag({ children }: { children: ReactNode }) {
  return (
    <View style={s.tag}>
      <Text style={s.tagText}>{children}</Text>
    </View>
  );
}

function initialTable() {
  const saved = readDraft();
  // An unresolved approval belongs to its original table, even on another link.
  if (saved?.approval) return saved.table;
  const param = new URLSearchParams(window.location.search).get("table");
  if (param && /^\d{1,2}$/.test(param) && Number(param) > 0)
    return String(Number(param));
  return saved?.table || String(Math.floor(Math.random() * 99) + 1);
}

export default function OrderApp() {
  const { width, height } = useWindowDimensions(),
    mobile = width < 760,
    narrow = width < 1120;
  const [lang, setLang] = useState<Language>("ko"),
    [draftLang, setDraftLang] = useState<Language>("ko");
  const [table, setTable] = useState(initialTable),
    [draftTable, setDraftTable] = useState(table);
  const [stage, setStage] = useState<"welcome" | "menu">("welcome"),
    [panel, setPanel] = useState<Panel>(null),
    [dish, setDish] = useState<MenuItem | null>(null);
  const [menu, setMenu] = useState<MenuItem[]>([]),
    [loaded, setLoaded] = useState(false),
    [loadError, setLoadError] = useState(false),
    [online, setOnline] = useState(true),
    [restoring, setRestoring] = useState(true);
  const restored = useRef(false),
    loadFlight = useRef<Promise<void> | null>(null),
    approvalRecovery = useRef<Confirmation | null>(null);
  const [session, setSession] = useState<Session | null>(null),
    sessionRef = useRef<Session | null>(null),
    generation = useRef(0);
  const [category, setCategory] = useState("all"),
    [busy, setBusy] = useState(""),
    flight = useRef(false),
    [error, setError] = useState("");
  const [kind, setKind] = useState<Kind>("order"),
    returnPanel = useRef<Panel>(null),
    [transcript, setTranscript] = useState(""),
    [reply, setReply] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null),
    [approvalUnknown, setApprovalUnknown] = useState(false);
  const [retryPending, setRetryPending] = useState(false),
    pending = useRef<Pending | null>(null),
    [syncPending, setSyncPending] = useState(false);
  const [recording, setRecording] = useState(false),
    [micPending, setMicPending] = useState(false),
    [elapsed, setElapsed] = useState(0),
    recordGen = useRef(0);
  const recorder = useRef<{
    capture: PcmWavRecorder;
    submit: (blob: Blob) => void;
  } | null>(null);
  const [orders, setOrders] = useState<CustomerOrder[]>([]),
    [requests, setRequests] = useState<CustomerRequest[]>([]),
    [historyError, setHistoryError] = useState(false),
    [historyBusy, setHistoryBusy] = useState(false);
  const [justOrdered, setJustOrdered] = useState<string | null>(null),
    [latestRequest, setLatestRequest] = useState<CustomerRequest | null>(null),
    historyFlight = useRef(false),
    historyEpoch = useRef(0);
  const currentRequest =
    latestRequest?.sessionId === session?.id ? latestRequest : null;
  const c = copy[lang],
    g = guestCopy[lang],
    h = historyCopy[lang];
  const cart = session?.cart || [],
    count = cart.reduce((sum, line) => sum + line.quantity, 0),
    total = cart.reduce(
      (sum, line) =>
        sum +
        (menu.find((m) => m.id === line.itemId)?.price || 0) * line.quantity,
      0,
    );
  const locked =
    restoring ||
    loadError ||
    Boolean(busy) ||
    recording ||
    micPending ||
    retryPending ||
    syncPending ||
    approvalUnknown;
  const store = (value: Session) => {
    sessionRef.current = value;
    setSession(value);
    writeDraft(value, approvalRecovery.current);
  };
  const begin = (name: string) => {
    if (flight.current || restoring || loadError) return false;
    flight.current = true;
    setBusy(name);
    setError("");
    return true;
  };
  const finish = () => {
    flight.current = false;
    setBusy("");
  };
  const message = (caught: unknown) => {
    const code = (caught as { code?: string })?.code;
    return code === "QUANTITY_LIMIT"
      ? c.limit
      : code === "TIMEOUT"
        ? c.timeout
        : !code || code === "NETWORK_ERROR"
          ? c.networkError
          : localizedError(code, lang);
  };
  const load = useCallback(() => {
    if (loadFlight.current) return loadFlight.current;
    const run = async () => {
      if (!restored.current) setRestoring(true);
      setLoadError(false);
      try {
        const health = await bootstrap();
        const data = await api<{ items: MenuItem[] }>("/api/menu");
        setMenu(data.items);
        if (health.mode === "demo" || !data.items.length) {
          setLoadError(true);
          return;
        }
        if (!restored.current) {
          const saved = readDraft();
          const queryTable = new URLSearchParams(window.location.search).get(
            "table",
          );
          const expectedTable =
            queryTable && /^\d{1,2}$/.test(queryTable) && Number(queryTable) > 0
              ? String(Number(queryTable))
              : null;
          if (
            saved &&
            (saved.approval || !expectedTable || saved.table === expectedTable)
          ) {
            try {
              const current = await api<Session>(`/api/sessions/${saved.id}`);
              approvalRecovery.current = saved.approval || null;
              store(current);
              setLang(current.language);
              setDraftLang(current.language);
              setTable(current.table);
              setDraftTable(current.table);
              // A restored draft never skips the language-first welcome.
              setStage("welcome");
              if (saved.approval) {
                setConfirmation(saved.approval);
                setApprovalUnknown(true);
              }
            } catch (error) {
              const status = (error as { status?: number }).status;
              const code = (error as { code?: string }).code || "";
              if (saved.approval) throw error;
              if (
                status === 401 ||
                status === 404 ||
                code === "SESSION_EXPIRED"
              ) {
                clearDraft();
                setError(localizedError("SESSION_EXPIRED", saved.language));
              } else throw error;
            }
          } else if (saved) {
            // An explicit different table starts a separate draft.
            clearDraft();
          }
          restored.current = true;
        }
      } catch (error) {
        if ((error as { code?: string }).code === "DEVICE_REQUIRED")
          bootstrapPromise = null;
        setLoadError(true);
      } finally {
        setLoaded(true);
        setRestoring(false);
      }
    };
    loadFlight.current = run().finally(() => {
      loadFlight.current = null;
    });
    return loadFlight.current;
  }, []);
  const loadHistory = useCallback(async () => {
    if (historyFlight.current || !navigator.onLine) return;
    historyFlight.current = true;
    setHistoryBusy(true);
    const epoch = historyEpoch.current;
    try {
      await bootstrap();
      const data = await api<{
        orders: CustomerOrder[];
        serviceRequests: CustomerRequest[];
      }>("/api/orders");
      if (epoch !== historyEpoch.current) return;
      setOrders(data.orders);
      setRequests(data.serviceRequests || []);
      setHistoryError(false);
      setLatestRequest((current) =>
        current
          ? data.serviceRequests?.find((x) => x.id === current.id) || current
          : null,
      );
    } catch (e) {
      if ((e as { code?: string }).code === "DEVICE_REQUIRED")
        bootstrapPromise = null;
      setHistoryError(true);
    } finally {
      historyFlight.current = false;
      setHistoryBusy(false);
    }
  }, []);
  useEffect(() => {
    // Pin the first choice before loading a draft. Refreshing or placing another
    // order keeps this number; a fresh unnumbered visit gets a new random choice.
    const url = new URL(window.location.href);
    url.searchParams.set("table", table);
    history.replaceState(null, "", url);
    setOnline(navigator.onLine);
    const up = () => {
        setOnline(true);
        void load();
        void loadHistory();
      },
      down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    void load();
    void loadHistory();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadHistory();
    }, 5000);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
      window.clearInterval(timer);
      recordGen.current++;
      void recorder.current?.capture.cancel();
    };
  }, [load, loadHistory]);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(
      () =>
        setElapsed(
          Math.floor((recorder.current?.capture.durationMs || 0) / 1000),
        ),
      200,
    );
    return () => window.clearInterval(timer);
  }, [recording]);
  async function ensureSession() {
    await bootstrap();
    if (sessionRef.current) return sessionRef.current;
    const value = await api<Session>(
      "/api/sessions",
      json({ language: lang, table }),
    );
    store(value);
    return value;
  }
  function recoverExpiredSession(caught: unknown) {
    const code = (caught as { code?: string }).code || "",
      status = (caught as { status?: number }).status;
    if (
      approvalUnknown ||
      !(
        status === 401 ||
        [
          "SESSION_REQUIRED",
          "SESSION_NOT_FOUND",
          "SESSION_EXPIRED",
          "DEVICE_REQUIRED",
        ].includes(code)
      )
    )
      return false;
    generation.current++;
    clearDraft();
    approvalRecovery.current = null;
    sessionRef.current = null;
    setSession(null);
    setConfirmation(null);
    pending.current = null;
    setRetryPending(false);
    setSyncPending(false);
    setPanel(null);
    setStage("welcome");
    if (code === "DEVICE_REQUIRED") {
      bootstrapPromise = null;
      void load();
    }
    setError(localizedError("SESSION_EXPIRED", lang));
    return true;
  }
  async function start() {
    if (!online || loadError || !begin("start")) return;
    try {
      await ensureSession();
      setStage("menu");
      if (approvalUnknown && confirmation) setPanel("review");
    } catch (e) {
      if (!recoverExpiredSession(e)) setError(message(e));
    } finally {
      finish();
    }
  }
  async function quantity(id: string, delta: number) {
    if (locked || !online || !begin(id)) return;
    try {
      const current = await ensureSession();
      store(
        await api<Session>(
          `/api/sessions/${current.id}/cart`,
          json({ itemId: id, delta }),
        ),
      );
      setConfirmation(null);
    } catch (e) {
      if (!recoverExpiredSession(e)) {
        setError(message(e));
        const status = (e as { status?: number }).status;
        if (!status || status >= 500) setSyncPending(true);
      }
    } finally {
      finish();
    }
  }
  async function sync() {
    if (!sessionRef.current || !online || !begin("sync")) return;
    try {
      store(await api<Session>(`/api/sessions/${sessionRef.current.id}`));
      setSyncPending(false);
      setConfirmation(null);
    } catch (e) {
      if (!recoverExpiredSession(e)) setError(message(e));
    } finally {
      finish();
    }
  }
  async function openRequest(nextKind: Kind) {
    if (
      busy ||
      restoring ||
      loadError ||
      recording ||
      micPending ||
      syncPending ||
      !online ||
      (nextKind === "order" && approvalUnknown) ||
      (retryPending && pending.current?.kind !== nextKind)
    )
      return;
    const previous = panel;
    if (!begin("request")) return;
    try {
      await ensureSession();
      setKind(nextKind);
      returnPanel.current = previous === "request" ? null : previous;
      setPanel("request");
      setStage("menu");
      if (!retryPending) {
        setTranscript("");
        setReply("");
        setLatestRequest(null);
      }
    } catch (e) {
      if (!recoverExpiredSession(e)) setError(message(e));
    } finally {
      finish();
    }
  }
  async function turn(
    value: string | Blob,
    requestKind: Kind,
    requestId = crypto.randomUUID(),
  ) {
    if (
      !online ||
      flight.current ||
      (requestKind === "order" && approvalUnknown) ||
      (typeof value === "string" && !value.trim()) ||
      !begin("turn")
    )
      return;
    pending.current = { value, kind: requestKind, requestId };
    setRetryPending(false);
    if (requestKind === "order") {
      setConfirmation(null);
      if (returnPanel.current === "review") returnPanel.current = "cart";
    }
    try {
      const current = await ensureSession();
      let init: RequestInit;
      if (typeof value === "string")
        init = json({ text: value, kind: requestKind, requestId });
      else {
        const form = new FormData();
        form.append("audio", value, "request.wav");
        form.append("kind", requestKind);
        form.append("requestId", requestId);
        init = { method: "POST", body: form };
      }
      const result = await api<TurnResult>(
        `/api/sessions/${current.id}/turn`,
        init,
      );
      store(result.session);
      setTranscript(result.transcript);
      setReply(result.reply);
      if (result.serviceRequest)
        setLatestRequest({
          ...result.serviceRequest,
          deliveries: result.deliveries || [],
        });
      pending.current = null;
      setRetryPending(false);
      void loadHistory();
    } catch (e) {
      if (!recoverExpiredSession(e)) {
        setError(message(e));
        const code = (e as { code?: string }).code || "",
          status = (e as { status?: number }).status;
        if (
          status &&
          status < 500 &&
          ![408, 409, 429].includes(status) &&
          !/SESSION_/.test(code)
        )
          pending.current = null;
        else setRetryPending(true);
      }
    } finally {
      finish();
    }
  }
  const retry = () => {
    if (pending.current)
      void turn(
        pending.current.value,
        pending.current.kind,
        pending.current.requestId,
      );
  };
  async function cancelRecording() {
    recordGen.current++;
    const active = recorder.current;
    recorder.current = null;
    setRecording(false);
    setMicPending(false);
    setElapsed(0);
    await active?.capture.cancel();
  }
  async function startRecording() {
    if (
      busy ||
      recording ||
      micPending ||
      retryPending ||
      syncPending ||
      (approvalUnknown && kind === "order") ||
      !online ||
      !sessionRef.current
    )
      return;
    const id = ++recordGen.current,
      requestKind = kind;
    let submitted = false;
    const submit = (blob: Blob) => {
      if (submitted || id !== recordGen.current) return;
      submitted = true;
      recorder.current = null;
      setRecording(false);
      setMicPending(false);
      void turn(blob, requestKind);
    };
    const capture = new PcmWavRecorder({
      maxDurationMs: 25000,
      onLimit: submit,
      onError: () => {
        if (id === recordGen.current) {
          setError(c.micError);
          void cancelRecording();
        }
      },
    });
    recorder.current = { capture, submit };
    setMicPending(true);
    setError("");
    setElapsed(0);
    try {
      await capture.start();
      if (id !== recordGen.current) {
        await capture.cancel();
        return;
      }
      setRecording(true);
    } catch (e) {
      if (id === recordGen.current && (e as Error).name !== "AbortError")
        setError(c.micError);
      await capture.cancel();
    } finally {
      if (id === recordGen.current) setMicPending(false);
    }
  }
  async function stopRecording() {
    const active = recorder.current;
    if (!active) return;
    try {
      active.submit(await active.capture.stop());
    } catch {
      if (recorder.current === active) {
        setError(c.micError);
        await cancelRecording();
      }
    }
  }
  async function prepare() {
    if (locked || !count || !online || !sessionRef.current || !begin("prepare"))
      return;
    try {
      const data = await api<{ session: Session; confirmation: Confirmation }>(
        `/api/sessions/${sessionRef.current.id}/prepare`,
        json({}),
      );
      store(data.session);
      setConfirmation(data.confirmation);
      setPanel("review");
    } catch (e) {
      if (!recoverExpiredSession(e)) setError(message(e));
    } finally {
      finish();
    }
  }
  async function approve() {
    if (
      !confirmation ||
      !sessionRef.current ||
      !online ||
      busy ||
      recording ||
      micPending ||
      retryPending ||
      !begin("approve")
    )
      return;
    const current = sessionRef.current,
      gen = generation.current;
    if (!approvalUnknown && Date.parse(confirmation.expiresAt) < Date.now()) {
      setConfirmation(null);
      setPanel("cart");
      setError(c.confirmationExpired);
      finish();
      return;
    }
    approvalRecovery.current = confirmation;
    writeDraft(current, confirmation);
    try {
      const data = await api<{
        order: Order;
        stage?: string;
        deliveries: Delivery[];
      }>(
        `/api/sessions/${current.id}/confirm`,
        json({
          token: confirmation.token,
          version: confirmation.version,
          approved: true,
        }),
      );
      if (gen !== generation.current || sessionRef.current?.id !== current.id)
        return;
      approvalRecovery.current = null;
      store({ ...sessionRef.current, cart: [], confirmationToken: null });
      setApprovalUnknown(false);
      setConfirmation(null);
      historyEpoch.current++;
      setOrders((old) => [
        {
          ...data.order,
          stage: data.stage || "new",
          deliveries: data.deliveries,
        },
        ...old.filter((x) => x.id !== data.order.id),
      ]);
      setJustOrdered(data.order.id);
      setPanel("history");
      void loadHistory();
    } catch (e) {
      const code = (e as { code?: string }).code || "";
      if (
        [
          "STALE_CONFIRMATION",
          "CONFIRMATION_EXPIRED",
          "PRICE_CHANGED",
          "INVALID_INPUT",
        ].includes(code)
      ) {
        approvalRecovery.current = null;
        writeDraft(current);
        setApprovalUnknown(false);
        setConfirmation(null);
        setPanel("cart");
        setError(message(e));
      } else {
        setApprovalUnknown(true);
        setError(c.approvalUnknown);
      }
    } finally {
      finish();
    }
  }
  function reset(nextLang = lang, nextTable = table) {
    if (locked) return;
    generation.current++;
    clearDraft();
    approvalRecovery.current = null;
    sessionRef.current = null;
    setSession(null);
    setConfirmation(null);
    setReply("");
    setLatestRequest(null);
    setTranscript("");
    setError("");
    setLang(nextLang);
    setDraftLang(nextLang);
    setTable(nextTable);
    setDraftTable(nextTable);
    setPanel(null);
    setStage("welcome");
    const url = new URL(window.location.href);
    url.searchParams.set("table", nextTable);
    history.replaceState(null, "", url);
  }
  async function close() {
    if (panel === "request") {
      await cancelRecording();
      setPanel(returnPanel.current);
      return;
    }
    if (busy || (approvalUnknown && panel === "review")) return;
    setPanel(null);
  }
  const requestBlocked = (which: Kind) =>
    restoring ||
    loadError ||
    Boolean(busy) ||
    recording ||
    micPending ||
    syncPending ||
    !online ||
    (which === "order" && approvalUnknown) ||
    (retryPending && pending.current?.kind !== which);
  const staff = (iconOnly = false) => (
    <Button
      secondary
      icon={iconOnly}
      onPress={() => void openRequest("service")}
      disabled={requestBlocked("service")}
      label={g.callShort}
    >
      <Bell size={19} color={p.green} />
      {!iconOnly && <BT secondary>{g.callShort}</BT>}
    </Button>
  );
  const voice = (compact = false) => (
    <Button
      onPress={() => void openRequest("order")}
      disabled={requestBlocked("order")}
      label={h.request}
      style={compact ? s.dockVoice : undefined}
    >
      <Mic size={21} color="white" />
      <BT>{h.request}</BT>
    </Button>
  );
  function qty(entry: MenuItem) {
    const n = cart.find((line) => line.itemId === entry.id)?.quantity || 0;
    return n ? (
      <View style={s.quantity}>
        <Button
          secondary
          icon
          onPress={() => void quantity(entry.id, -1)}
          disabled={locked || !online}
          label={`${entry.name[lang]} ${c.removeLabel}`}
        >
          <Minus size={17} />
        </Button>
        <Text style={s.quantityText}>{n}</Text>
        <Button
          secondary
          icon
          onPress={() => void quantity(entry.id, 1)}
          disabled={locked || !online}
          label={`${entry.name[lang]} ${c.addLabel}`}
        >
          <Plus size={17} />
        </Button>
      </View>
    ) : (
      <Button
        secondary
        onPress={() => void quantity(entry.id, 1)}
        disabled={locked || !online}
        label={`${entry.name[lang]} ${c.add}`}
        style={s.add}
      >
        <Plus size={17} />
        <BT secondary>{c.add}</BT>
      </Button>
    );
  }
  function basket(inSheet = false) {
    return (
      <View style={[s.cartBody, inSheet && { padding: 0 }]}>
        {!inSheet && (
          <View style={s.between}>
            <View style={s.row}>
              <ShoppingBag size={20} color={p.green} />
              <Text style={s.sectionTitle}>{c.cart}</Text>
            </View>
            <Tag>{count}</Tag>
          </View>
        )}
        {cart.length ? (
          cart.map((line) => {
            const entry = menu.find((m) => m.id === line.itemId);
            return entry ? (
              <View key={line.itemId} style={s.cartLine}>
                <Image
                  source={{ uri: `/images/${entry.id}.svg` }}
                  style={s.cartImage}
                  resizeMode="cover"
                  aria-label={entry.name[lang]}
                />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={s.cartName}>{entry.name[lang]}</Text>
                  <Text style={s.small}>{money(entry.price)}</Text>
                  <View style={[s.between, { marginTop: 8, flexWrap: "wrap" }]}>
                    {qty(entry)}
                    <Text style={s.cartPrice}>
                      {money(line.quantity * entry.price)}
                    </Text>
                  </View>
                </View>
              </View>
            ) : null;
          })
        ) : (
          <View style={s.empty}>
            <ShoppingBag size={35} color="#a3b195" strokeWidth={1.4} />
            <Text style={s.description}>{c.empty}</Text>
            <Text style={s.small}>{c.emptySub}</Text>
          </View>
        )}
        <View style={s.total}>
          <Text style={s.body}>{c.total}</Text>
          <Text style={s.totalAmount}>{money(total)}</Text>
        </View>
        <Button
          onPress={() => void prepare()}
          disabled={!count || locked || !online}
          testID="review-order"
        >
          <BT>{busy === "prepare" ? c.processing : c.review}</BT>
          {busy === "prepare" ? (
            <ActivityIndicator color="white" />
          ) : (
            <ArrowRight size={19} color="white" />
          )}
        </Button>
        <Text style={s.centerHint}>{g.safety}</Text>
        <Text style={s.payment}>{g.payAtRestaurant}</Text>
        {inSheet && (
          <View style={s.twoButtons}>
            {voice()}
            {staff()}
          </View>
        )}
      </View>
    );
  }
  function deliveries(items: Delivery[]) {
    return (
      <View style={s.deliveryList}>
        {["kitchen", "robot"].map((target) => {
          const delivery = items.find((x) => x.target === target),
            sent =
              delivery?.status === "delivered" || delivery?.status === "sent",
            manual = delivery?.status === "awaiting_staff";
          return (
            <View key={target} style={s.deliveryRow}>
              <View style={s.row}>
                <Utensils size={16} color={p.green} />
                <Text style={s.body}>
                  {target === "kitchen" ? c.kitchen : c.robot}
                </Text>
              </View>
              <Text
                style={[
                  s.deliveryText,
                  { color: sent ? p.green : manual ? p.muted : p.amber },
                ]}
              >
                {sent
                  ? `✓ ${g.received}`
                  : manual
                    ? g.robotOptional
                    : g.checking}
              </Text>
            </View>
          );
        })}
      </View>
    );
  }
  const title =
    panel === "cart"
      ? c.cart
      : panel === "request"
        ? kind === "service"
          ? c.callTitle
          : g.tellUs
        : panel === "review"
          ? c.confirmation
          : panel === "history"
            ? h.title
            : panel === "language"
              ? c.change
              : panel === "table"
                ? g.tableEdit
                : dish?.name[lang] || "";
  const menuItems =
      category === "all" ? menu : menu.filter((m) => m.category === category),
    columns = mobile || narrow ? 2 : 3;

  return (
    <View style={[s.app, { minHeight: height || 800 }]}>
      <View
        style={[s.header, mobile && { paddingHorizontal: 16 }]}
        dataSet={{ area: "header" }}
      >
        <View style={s.brand}>
          <View style={s.bowl} />
          <View>
            <Text style={s.wordmark}>담다</Text>
            <Text style={s.brandSub}>DAMDA · TABLE ORDER</Text>
          </View>
        </View>
        <View style={[s.row, { gap: mobile ? 5 : 12 }]}>
          <Pressable
            role="button"
            aria-label={g.tableEdit}
            disabled={locked}
            onPress={() => {
              setDraftTable(table);
              setPanel("table");
            }}
            style={s.tableButton}
          >
            <Text style={s.small}>{c.table}</Text>
            <Text style={s.tableNumber}>{table.padStart(2, "0")}</Text>
          </Pressable>
          {staff(true)}
          <Button
            secondary
            icon
            onPress={() => {
              setDraftLang(lang);
              setPanel("language");
            }}
            disabled={locked}
            label={c.change}
          >
            <Globe2 size={19} />
          </Button>
        </View>
      </View>
      {(!online ||
        loadError ||
        error ||
        retryPending ||
        syncPending ||
        approvalUnknown) && (
        <View style={s.notice} aria-live="polite">
          <CircleAlert size={18} color={p.red} />
          <View style={{ flex: 1, gap: 9 }}>
            <Text style={s.noticeText}>
              {!online
                ? c.offline
                : approvalUnknown
                  ? c.approvalUnknown
                  : retryPending
                    ? g.requestUnknown
                    : syncPending
                      ? g.cartSync
                      : error || c.networkError}
            </Text>
            {retryPending ? (
              <Button
                secondary
                onPress={retry}
                disabled={Boolean(busy) || !online}
              >
                <BT secondary>{g.requestRetry}</BT>
              </Button>
            ) : syncPending ? (
              <Button
                secondary
                onPress={() => void sync()}
                disabled={Boolean(busy) || !online}
              >
                <BT secondary>{g.sync}</BT>
              </Button>
            ) : loadError ? (
              <Button secondary onPress={() => void load()} disabled={!online}>
                <BT secondary>{c.retry}</BT>
              </Button>
            ) : null}
          </View>
        </View>
      )}
      {stage === "welcome" ? (
        <View style={[s.welcome, mobile && s.welcomeMobile]}>
          <View style={[s.welcomeArt, mobile && s.welcomeArtMobile]}>
            <Text
              style={[s.greeting, mobile && { fontSize: 26, lineHeight: 37 }]}
            >
              {g.greeting}
            </Text>
            {!mobile && (
              <Image
                source={{ uri: "/images/bibimbap.svg" }}
                style={s.welcomeImage}
                resizeMode="contain"
                aria-label={
                  menu.find((x) => x.id === "bibimbap")?.name[lang] || "담다"
                }
              />
            )}
            <View style={s.welcomeSeal}>
              <Utensils size={15} color={p.green} />
              <Text style={s.small}>{c.powered}</Text>
            </View>
          </View>
          <View style={s.languageSection}>
            <Text style={s.eyebrow}>{c.language}</Text>
            <Text style={s.title}>{c.select}</Text>
            <Text style={[s.description, { marginTop: 10 }]}>
              {g.welcomeNote}
            </Text>
            <View style={s.languageGrid}>
              {languages.map((entry) => (
                <Pressable
                  key={entry.code}
                  role="button"
                  aria-label={entry.native}
                  aria-pressed={lang === entry.code}
                  disabled={Boolean(busy) || restoring || approvalUnknown}
                  onPress={() => {
                    setDraftLang(entry.code);
                    if (
                      sessionRef.current &&
                      entry.code !== sessionRef.current.language
                    ) {
                      setPanel("language");
                    } else setLang(entry.code);
                  }}
                  style={[
                    s.languageCard,
                    lang === entry.code && s.languageSelected,
                  ]}
                >
                  <View>
                    <Text style={s.languageName}>{entry.native}</Text>
                    <Text style={[s.small, { fontSize: 10, marginTop: 3 }]}>
                      {entry.english}
                    </Text>
                  </View>
                  {lang === entry.code ? (
                    <Check size={20} color={p.green} />
                  ) : (
                    <ChevronRight size={18} color="#a1a894" />
                  )}
                </Pressable>
              ))}
            </View>
            <View style={s.tableReminder}>
              <Text style={s.body}>
                {c.table}{" "}
                <Text style={{ fontWeight: "700" }}>
                  {table.padStart(2, "0")}
                </Text>
              </Text>
              <Pressable
                role="button"
                aria-label={g.tableEdit}
                onPress={() => setPanel("table")}
                style={s.linkButton}
              >
                <Text style={s.linkText}>{g.tableEdit}</Text>
                <ChevronRight size={16} />
              </Pressable>
            </View>
            <Button
              onPress={() => void start()}
              disabled={
                !loaded || restoring || loadError || !online || Boolean(busy)
              }
              testID="start-order"
            >
              <BT>{busy || !loaded ? c.loading : c.start}</BT>
              {busy || !loaded ? (
                <ActivityIndicator color="white" />
              ) : (
                <ArrowRight size={20} color="white" />
              )}
            </Button>
            <View style={s.quiet}>
              <VolumeX size={15} color={p.muted} />
              <Text style={s.small}>{g.quiet}</Text>
            </View>
          </View>
        </View>
      ) : (
        <View style={[s.layout, mobile && s.layoutMobile]}>
          <View style={s.menuSection}>
            <View style={s.menuHeading}>
              <View style={s.between}>
                <Text style={s.eyebrow}>
                  {c.table} {table.padStart(2, "0")} · DAMDA
                </Text>
                <Button
                  secondary
                  onPress={() => {
                    setPanel("history");
                    void loadHistory();
                  }}
                  style={{
                    minHeight: 48,
                    paddingVertical: 8,
                    paddingHorizontal: 12,
                  }}
                  label={h.title}
                >
                  <Clock3 size={16} color={p.green} />
                  <BT secondary>{h.title}</BT>
                </Button>
              </View>
              <Text
                style={[
                  s.menuTitle,
                  mobile && { fontSize: 25, lineHeight: 35 },
                ]}
              >
                {g.menuIntro}
              </Text>
              <Text style={s.description}>{g.menuNote}</Text>
            </View>
            <ScrollView
              horizontal
              contentContainerStyle={s.categories}
              style={{ flexGrow: 0 }}
              aria-label={c.filter}
            >
              {["all", ...new Set(menu.map((m) => m.category))].map((key) => (
                <Pressable
                  key={key}
                  role="button"
                  aria-pressed={category === key}
                  onPress={() => setCategory(key)}
                  style={[s.category, category === key && s.categoryActive]}
                >
                  <Text
                    style={[
                      s.categoryText,
                      category === key && { color: "white" },
                    ]}
                  >
                    {key === "all" ? c.all : categoryNames[key]?.[lang] || key}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
            {!menu.length ? (
              <View style={s.empty}>
                <Text style={s.description}>
                  {loaded ? c.menuEmpty : c.loading}
                </Text>
                <Button secondary onPress={() => void load()}>
                  <BT secondary>{c.retry}</BT>
                </Button>
              </View>
            ) : (
              <View style={s.grid}>
                {menuItems.map((entry) => (
                  <View
                    key={entry.id}
                    style={[
                      s.card,
                      {
                        width: `${100 / columns - (columns === 3 ? 1.2 : 1.5)}%`,
                      },
                    ]}
                  >
                    <Pressable
                      role="button"
                      aria-label={`${entry.name[lang]} ${g.details}`}
                      onPress={() => {
                        setDish(entry);
                        setPanel("dish");
                      }}
                    >
                      <Image
                        source={{ uri: `/images/${entry.id}.svg` }}
                        style={[s.dishImage, mobile && { height: 135 }]}
                        resizeMode="cover"
                        aria-label={entry.name[lang]}
                      />
                      {entry.id === "bibimbap" && (
                        <View style={s.recommended}>
                          <Text style={s.recommendedText}>{c.recommended}</Text>
                        </View>
                      )}
                    </Pressable>
                    <View style={[s.cardBody, mobile && { padding: 11 }]}>
                      <View style={s.row}>
                        <Text style={[s.dishName, mobile && { fontSize: 15 }]}>
                          {entry.name[lang]}
                        </Text>
                        {entry.vegetarian && <Leaf size={14} color="#788f61" />}
                      </View>
                      <Text
                        style={[s.dishDescription, mobile && { fontSize: 11 }]}
                        numberOfLines={mobile ? 3 : 2}
                      >
                        {entry.description[lang]}
                      </Text>
                      <Pressable
                        role="button"
                        aria-label={`${entry.name[lang]} ${c.allergens}`}
                        onPress={() => {
                          setDish(entry);
                          setPanel("dish");
                        }}
                        style={s.allergenLink}
                      >
                        <Text style={s.allergenLinkText}>
                          {entry.spicy ? `${c.spicy} · ` : ""}
                          {c.allergens}
                        </Text>
                      </Pressable>
                      <View
                        style={[
                          s.cardBottom,
                          mobile && { alignItems: "flex-start" },
                        ]}
                      >
                        <Text style={[s.price, mobile && { fontSize: 16 }]}>
                          {money(entry.price)}
                        </Text>
                        {qty(entry)}
                      </View>
                    </View>
                  </View>
                ))}
              </View>
            )}
            <View style={s.footnote}>
              <Leaf size={15} color={p.muted} />
              <Text style={[s.small, { flex: 1 }]}>{g.allergyNote}</Text>
            </View>
          </View>
          {!mobile && (
            <View
              style={[s.sidebar, narrow && { width: 300 }]}
              dataSet={{ area: "cart" }}
            >
              <View style={s.cartSurface}>{basket()}</View>
              <View style={s.sidebarHelp}>
                {staff()}
                <Text style={s.centerHint}>{c.callSub}</Text>
              </View>
              <View style={s.quiet}>
                <VolumeX size={15} color={p.muted} />
                <Text style={s.small}>{g.quiet}</Text>
              </View>
            </View>
          )}
        </View>
      )}
      <View style={[s.dock, mobile && s.dockMobile]} dataSet={{ area: "dock" }}>
        {stage === "menu" ? (
          <Button
            secondary={!count}
            onPress={() => setPanel("cart")}
            style={[s.dockCart, mobile && { flex: 1 }]}
            label={`${c.cart} ${count}`}
            testID="open-basket"
          >
            <ShoppingBag size={20} color={count ? "white" : p.green} />
            <View>
              <Text style={[s.buttonText, !count && { color: p.ink }]}>
                {count ? `${count} ${c.count} · ${money(total)}` : c.cart}
              </Text>
              {count > 0 && (
                <Text
                  style={{
                    fontSize: 9,
                    color: "white",
                    textAlign: "center",
                    marginTop: 2,
                  }}
                >
                  {c.review}
                </Text>
              )}
            </View>
          </Button>
        ) : (
          <Button
            secondary
            onPress={() => {
              setPanel("history");
              void loadHistory();
            }}
            style={mobile ? { flex: 1 } : undefined}
          >
            <Clock3 size={19} color={p.green} />
            <BT secondary>{h.title}</BT>
          </Button>
        )}
        {voice(true)}
      </View>
      <Modal
        visible={panel !== null}
        transparent
        animationType="fade"
        onRequestClose={() => void close()}
      >
        <View
          style={[
            s.scrim,
            mobile && { justifyContent: "flex-end", padding: 0 },
          ]}
        >
          <Pressable
            children={null}
            style={StyleSheet.absoluteFillObject}
            role="button"
            aria-label={c.close}
            onPress={() => void close()}
          />
          <View
            testID="order-sheet"
            style={[
              s.sheet,
              { maxHeight: (height || 900) - (mobile ? 25 : 60) },
              mobile && s.sheetMobile,
            ]}
          >
            <View style={s.sheetHeader}>
              <View style={{ flex: 1 }}>
                <Text style={s.eyebrow}>
                  {c.table} {table.padStart(2, "0")}
                </Text>
                <Text style={s.sheetTitle}>{title}</Text>
              </View>
              {panel !== "request" && (
                <Button
                  icon
                  onPress={() => void openRequest("order")}
                  disabled={requestBlocked("order")}
                  label={h.request}
                >
                  <Mic size={20} color="white" />
                </Button>
              )}
              {panel !== "request" && staff(true)}
              <Button
                secondary
                icon
                onPress={() => void close()}
                disabled={
                  (Boolean(busy) && panel !== "request") ||
                  (approvalUnknown && panel === "review")
                }
                label={c.close}
              >
                <X size={20} />
              </Button>
            </View>
            <ScrollView
              contentContainerStyle={s.sheetBody}
              style={{ flexShrink: 1 }}
            >
              {(error || retryPending || syncPending || approvalUnknown) && (
                <View style={s.inlineNotice}>
                  <Text style={s.noticeText}>
                    {approvalUnknown && panel === "review"
                      ? c.approvalUnknown
                      : retryPending
                        ? g.requestUnknown
                        : syncPending
                          ? g.cartSync
                          : error}
                  </Text>
                  {retryPending && (
                    <Button
                      secondary
                      onPress={retry}
                      disabled={Boolean(busy) || !online}
                    >
                      <BT secondary>{g.requestRetry}</BT>
                    </Button>
                  )}
                  {syncPending && (
                    <Button
                      secondary
                      onPress={() => void sync()}
                      disabled={Boolean(busy) || !online}
                    >
                      <BT secondary>{g.sync}</BT>
                    </Button>
                  )}
                </View>
              )}
              {panel === "cart" && basket(true)}
              {panel === "request" && (
                <View style={{ gap: 18 }}>
                  <View style={s.twoButtons}>
                    {(["order", "service"] as const).map((value) => (
                      <Button
                        key={value}
                        secondary={kind !== value}
                        onPress={() => {
                          setKind(value);
                          setTranscript("");
                          setReply("");
                          setLatestRequest(null);
                        }}
                        disabled={
                          Boolean(busy) ||
                          recording ||
                          micPending ||
                          retryPending ||
                          (value === "order" && approvalUnknown)
                        }
                      >
                        <BT secondary={kind !== value}>
                          {value === "order" ? g.voiceShort : g.callShort}
                        </BT>
                      </Button>
                    ))}
                  </View>
                  <Text style={s.description}>
                    {kind === "service" ? g.serviceNote : g.voiceInstruction}
                  </Text>
                  <View
                    style={[
                      s.recordBox,
                      recording && {
                        backgroundColor: "#f7e8df",
                        borderColor: "#ddb39a",
                      },
                    ]}
                  >
                    <View style={s.recordIcon}>
                      <Mic size={29} color={recording ? p.orange : p.green} />
                    </View>
                    <Text style={s.recordTitle}>
                      {recording
                        ? c.listening
                        : micPending
                          ? g.permission
                          : busy
                            ? c.processing
                            : g.tellUs}
                    </Text>
                    <Text style={[s.small, { textAlign: "center" }]}>
                      {recording
                        ? `0:${String(elapsed).padStart(2, "0")} / 0:25`
                        : kind === "service"
                          ? g.callHint
                          : g.orderHint}
                    </Text>
                    <Button
                      onPress={() =>
                        recording ? void stopRecording() : void startRecording()
                      }
                      disabled={
                        Boolean(busy) ||
                        micPending ||
                        retryPending ||
                        syncPending ||
                        !online ||
                        (kind === "order" && approvalUnknown)
                      }
                      style={{
                        width: "100%",
                        minHeight: 56,
                        backgroundColor: recording ? p.orange : p.green,
                      }}
                    >
                      {recording ? (
                        <Square size={19} color="white" fill="white" />
                      ) : busy || micPending ? (
                        <ActivityIndicator color="white" />
                      ) : (
                        <Mic size={21} color="white" />
                      )}
                      <BT>
                        {recording
                          ? c.stop
                          : busy
                            ? c.processing
                            : micPending
                              ? g.permission
                              : c.mic}
                      </BT>
                    </Button>
                    {(recording || micPending) && (
                      <Button secondary onPress={() => void cancelRecording()}>
                        <BT secondary>{c.cancel}</BT>
                      </Button>
                    )}
                    <Text style={s.centerHint}>{c.recordingHint}</Text>
                  </View>
                  {transcript && (
                    <View style={s.heard}>
                      <Text style={s.label}>{c.serviceReply}</Text>
                      <Text style={s.body}>{transcript}</Text>
                    </View>
                  )}
                  {reply && (
                    <View style={s.reply}>
                      <Text style={s.replyText}>{reply}</Text>
                    </View>
                  )}
                  {kind === "service" && currentRequest && (
                    <View style={{ gap: 9 }}>
                      <Text style={s.label}>
                        {currentRequest.translationStatus === "pending"
                          ? h.preparing
                          : g.serviceReceived}
                      </Text>
                      {deliveries(currentRequest.deliveries)}
                    </View>
                  )}
                  {returnPanel.current === "review" && confirmation && (
                    <Button
                      onPress={() => void close()}
                      disabled={Boolean(busy) || recording || micPending}
                      testID="return-to-review"
                    >
                      <ArrowRight size={18} color="white" />
                      <BT>{g.returnReview}</BT>
                    </Button>
                  )}
                  {kind === "order" && count > 0 && (
                    <Button
                      onPress={() => setPanel("cart")}
                      disabled={Boolean(busy) || recording || micPending}
                    >
                      <ShoppingBag size={19} color="white" />
                      <BT>
                        {c.cart} · {money(total)}
                      </BT>
                    </Button>
                  )}
                  <View style={s.quiet}>
                    <VolumeX size={15} color={p.muted} />
                    <Text style={s.small}>{g.quiet}</Text>
                  </View>
                </View>
              )}
              {panel === "review" && confirmation && (
                <View style={{ gap: 17 }}>
                  <Text style={s.description}>{g.reviewNote}</Text>
                  <View style={s.reviewTable}>
                    <Text style={s.body}>{c.table}</Text>
                    <Text style={s.tableNumber}>{table.padStart(2, "0")}</Text>
                  </View>
                  {confirmation.summary.map((line) => (
                    <View key={line.itemId} style={s.reviewLine}>
                      <View style={{ flex: 1, gap: 4 }}>
                        <Text style={s.dishName}>
                          {menu.find((m) => m.id === line.itemId)?.name[lang] ||
                            itemName(line.name, lang)}
                        </Text>
                        <Text style={s.small}>
                          {c.quantity} × {line.quantity}
                        </Text>
                      </View>
                      <Text style={s.price}>{money(line.lineTotal)}</Text>
                    </View>
                  ))}
                  <View style={s.total}>
                    <Text style={s.body}>{c.total}</Text>
                    <Text style={s.totalAmount}>
                      {money(confirmation.total)}
                    </Text>
                  </View>
                  <Text style={s.payment}>{g.payAtRestaurant}</Text>
                  {currentRequest && (
                    <View style={s.heard} testID="review-service-request">
                      <Text style={s.label}>{g.serviceReceived}</Text>
                      <Text style={s.body}>
                        {currentRequest.naturalLanguage}
                      </Text>
                    </View>
                  )}
                  <Button
                    secondary
                    onPress={() => void openRequest("service")}
                    disabled={requestBlocked("service")}
                    testID="review-voice-request"
                  >
                    <Mic size={20} color={p.green} />
                    <BT secondary>{g.extraRequest}</BT>
                  </Button>
                  <Button
                    onPress={() => void approve()}
                    disabled={
                      Boolean(busy) ||
                      recording ||
                      micPending ||
                      retryPending ||
                      !online
                    }
                    testID="confirm-order"
                  >
                    <Check size={21} color="white" />
                    <BT>
                      {busy === "approve"
                        ? c.sending
                        : approvalUnknown
                          ? c.recoverApproval
                          : c.approve}
                    </BT>
                  </Button>
                  <View style={s.twoButtons}>
                    {voice()}
                    {staff()}
                  </View>
                  <Button
                    secondary
                    onPress={() => {
                      setConfirmation(null);
                      setPanel("cart");
                    }}
                    disabled={locked}
                  >
                    <BT secondary>{c.back}</BT>
                  </Button>
                </View>
              )}
              {panel === "history" && (
                <View style={{ gap: 17 }}>
                  {justOrdered && orders.some((o) => o.id === justOrdered) && (
                    <View style={{ gap: 12, alignItems: "center" }}>
                      <View style={s.successIcon}>
                        <Check size={34} color={p.green} />
                      </View>
                      <Text style={s.title}>{g.committed}</Text>
                      <Text style={s.payment}>{g.payAtRestaurant}</Text>
                      <Button
                        secondary
                        onPress={() => {
                          setPanel(null);
                          setJustOrdered(null);
                          setStage("menu");
                        }}
                      >
                        <BT secondary>{g.more}</BT>
                        <ArrowRight size={17} />
                      </Button>
                    </View>
                  )}
                  {historyError && (
                    <View style={s.inlineNotice}>
                      <Text style={s.noticeText}>{c.networkError}</Text>
                    </View>
                  )}
                  {(!justOrdered || historyError) && (
                    <Button
                      secondary
                      onPress={() => void loadHistory()}
                      disabled={historyBusy || !online}
                    >
                      <Clock3 size={17} />
                      <BT secondary>
                        {historyBusy ? c.processing : h.refresh}
                      </BT>
                    </Button>
                  )}
                  {!orders.length && !historyBusy ? (
                    <Text style={s.description}>{h.empty}</Text>
                  ) : (
                    orders.map((order) => (
                      <View key={order.id} style={s.historyCard}>
                        <View style={s.between}>
                          <Text style={s.historyStage}>
                            {h.stages[order.stage || "new"] || h.stages.new}
                          </Text>
                          <Tag>
                            {c.table} {order.table}
                          </Tag>
                        </View>
                        <Text style={s.small}>
                          {c.orderNumber} · {order.id.slice(-8).toUpperCase()}
                        </Text>
                        {order.items.map((line) => (
                          <View key={line.itemId} style={s.between}>
                            <Text style={[s.historyLine, { flex: 1 }]}>
                              {menu.find((m) => m.id === line.itemId)?.name[
                                lang
                              ] || itemName(line.name, lang)}{" "}
                              × {line.quantity}
                            </Text>
                            <Text style={s.cartPrice}>
                              {money(line.lineTotal)}
                            </Text>
                          </View>
                        ))}
                        <View style={s.between}>
                          <Text style={s.body}>{c.total}</Text>
                          <Text style={s.price}>{money(order.total)}</Text>
                        </View>
                        {deliveries(order.deliveries || [])}
                      </View>
                    ))
                  )}
                  {requests.map((request) => (
                    <View key={request.id} style={s.historyCard}>
                      <View style={s.between}>
                        <Text style={s.label}>{g.callShort}</Text>
                        <Tag>
                          {c.table} {request.table}
                        </Tag>
                      </View>
                      <Text style={s.body}>{request.naturalLanguage}</Text>
                      <Text style={s.small}>
                        {request.translationStatus === "pending"
                          ? h.preparing
                          : h.stages[request.stage || "new"] ||
                            g.serviceReceived}
                      </Text>
                    </View>
                  ))}
                </View>
              )}
              {panel === "dish" && dish && (
                <View style={{ gap: 17 }}>
                  <Image
                    source={{ uri: `/images/${dish.id}.svg` }}
                    style={s.dishDetail}
                    resizeMode="cover"
                    aria-label={dish.name[lang]}
                  />
                  <Text style={s.description}>{dish.description[lang]}</Text>
                  <View style={s.row}>
                    {dish.spicy && <Tag>{c.spicy}</Tag>}
                    {dish.vegetarian && <Tag>{c.vegetarian}</Tag>}
                  </View>
                  <Text style={s.label}>{c.allergens}</Text>
                  <View style={[s.row, { flexWrap: "wrap" }]}>
                    {dish.allergens.map((a) => (
                      <Tag key={a}>{allergenNames[a]?.[lang] || a}</Tag>
                    ))}
                  </View>
                  <Text style={s.small}>{g.allergyNote}</Text>
                  <View style={s.between}>
                    <Text style={s.totalAmount}>{money(dish.price)}</Text>
                    {qty(dish)}
                  </View>
                  <View style={s.twoButtons}>
                    {voice()}
                    {staff()}
                  </View>
                </View>
              )}
              {panel === "language" && (
                <View style={{ gap: 18 }}>
                  <Text style={s.description}>
                    {session ? g.languageNote : c.selectSub}
                  </Text>
                  <View style={s.languageGrid}>
                    {languages.map((entry) => (
                      <Pressable
                        key={entry.code}
                        role="button"
                        aria-pressed={draftLang === entry.code}
                        onPress={() => setDraftLang(entry.code)}
                        style={[
                          s.languageCard,
                          draftLang === entry.code && s.languageSelected,
                        ]}
                      >
                        <Text style={s.languageName}>{entry.native}</Text>
                        {draftLang === entry.code && (
                          <Check size={18} color={p.green} />
                        )}
                      </Pressable>
                    ))}
                  </View>
                  <Button
                    onPress={() => {
                      if (draftLang === lang) setPanel(null);
                      else reset(draftLang);
                    }}
                    disabled={locked}
                  >
                    <BT>{g.apply}</BT>
                  </Button>
                </View>
              )}
              {panel === "table" && (
                <View style={{ gap: 17 }}>
                  <Text style={s.description}>{g.tableHint}</Text>
                  <TextInput
                    aria-label={c.table}
                    value={draftTable}
                    onChangeText={(v) =>
                      setDraftTable(v.replace(/\D/g, "").slice(0, 2))
                    }
                    keyboardType="number-pad"
                    maxLength={2}
                    style={s.tableInput}
                    selectTextOnFocus
                  />
                  <Text style={s.small}>
                    {session ? g.tableChangeNote : g.tableHint}
                  </Text>
                  <Button
                    onPress={() => {
                      const next = Number(draftTable);
                      if (!Number.isInteger(next) || next < 1 || next > 99) {
                        setError(g.tableInvalid);
                        return;
                      }
                      if (String(next) === table) setPanel(null);
                      else reset(lang, String(next));
                    }}
                    disabled={locked}
                  >
                    <BT>{g.apply}</BT>
                  </Button>
                </View>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}
