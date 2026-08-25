import { useState, useEffect, useMemo, useCallback, createContext, useContext, useRef } from "react";
import {
  Check, X, Minus, Flame, TrendingUp, TrendingDown, Calendar as CalendarIcon,
  Settings as SettingsIcon, BarChart3, Grid3x3, Trophy, Download, Upload,
  Plus, Archive, ArchiveRestore, Bell, Home,
  Target, LayoutGrid, History as HistoryIcon, Swords, Sparkles, AlertCircle,
  Sun, Moon, Sunset, MoonStar, Pencil, Trash2, Activity, Menu
} from "lucide-react";
import { loadAppState, saveAppState } from "./db";
/* ============================================================================
   DESIGN TOKENS
============================================================================ */
const COLORS = {
  bg: "#0B0F17",
  surface: "rgba(22, 31, 48, 0.74)",
  surface2: "rgba(29, 41, 63, 0.86)",
  border: "rgba(148, 163, 184, 0.18)",
  text: "#F9FAFB",
  textDim: "#AAB5C7",
  textFaint: "#718096",
  emerald: "#22D3A2",
  indigo: "#6366F1",
  cyan: "#06B6D4",
  crimson: "#EF4444",
  amber: "#F59E0B",
  slate: "#64748B",
};

/* ============================================================================
   TYPES (JSDoc for reference only, runtime is plain JS)
   Habit: { id, name, category, type:'binary'|'quantitative', targetValue, unit,
            weight, frequency:number[] (0=Sun..6=Sat), createdAt, archived,
            reminderEnabled, reminderTime, allowGraceFreeze }
   Record: { id, habitId, date:'YYYY-MM-DD', status, loggedValue, targetSnapshot, updatedAt }
   status: completed | missed | partial | off_day | grace_protected | untracked
============================================================================ */

const CATEGORIES = ["Fitness", "Health", "Productivity", "Discipline", "Mind"];
const WEEKDAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];

/* ============================================================================
   DATE UTILITIES  (local-timezone safe, no UTC drift)
============================================================================ */
function pad2(n) { return String(n).padStart(2, "0"); }
function toDateStr(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function fromDateStr(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
function todayStr() { return toDateStr(new Date()); }
function addDays(dateStr, n) { const d = fromDateStr(dateStr); d.setDate(d.getDate() + n); return toDateStr(d); }
function getMonthKey(dateStr) { return dateStr.slice(0, 7); }
function monthLabel(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}
function daysInMonth(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}
function prevMonthKey(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}
function nextMonthKey(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  const d = new Date(y, m, 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}
function niceDate(dateStr) {
  return fromDateStr(dateStr).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}
function shortDate(dateStr) {
  return fromDateStr(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }
/* ============================================================================
   NOTIFICATION ENGINE
============================================================================ */

async function requestNotificationPermission() {
  if (!("Notification" in window)) {
    return "unsupported";
  }

  if (Notification.permission === "granted") {
    return "granted";
  }

  if (Notification.permission === "denied") {
    return "denied";
  }

  return await Notification.requestPermission();
}

function showHabitNotification(habit) {
  if (
    !("Notification" in window) ||
    Notification.permission !== "granted"
  ) {
    return;
  }

  new Notification(
    `Habit OS — ${habit.name}`,
    {
      body: `It's time to complete your ${habit.name} habit.`,
      icon: "/favicon.ico",
      tag: `habit-${habit.id}`,
    }
  );
}


/* ============================================================================
   STORAGE  (persisted via artifact key-value storage, personal/private)
============================================================================ */

async function loadState() {
  try {
    return await loadAppState();
  } catch (e) {
    console.error("Storage load failed", e);
    return null;
  }
}

async function saveState(state) {
  try {
    await saveAppState(state);
  } catch (e) {
    console.error("Storage save failed", e);
  }
}

function defaultState() {
  return {
    schemaVersion: 1,
    onboarded: false,
    habits: [],
    records: [],
    graceUsage: {}, // { [habitId]: { [monthKey]: count } }
    settings: {
      firstDayOfWeek: 0,
      streakSaverGlobalEnabled: true,
      streakThreshold: 70,
    },
  };
}

/* ============================================================================
   SCORING / SCHEDULE ENGINE
============================================================================ */
function isScheduledDay(habit, dateStr) {
  const dow = fromDateStr(dateStr).getDay();
  if (!habit.frequency || habit.frequency.length === 0) return true; // daily default
  return habit.frequency.includes(dow);
}
function habitActiveOn(habit, dateStr) {
  return dateStr >= habit.createdAt.slice(0, 10) && !(habit.archived && habit.archivedAt && dateStr > habit.archivedAt.slice(0,10));
}
function findRecord(records, habitId, dateStr) {
  return records.find(r => r.habitId === habitId && r.date === dateStr) || null;
}

/** Returns { score: number|null, excluded: bool, status } for a single habit/day */
function dayEval(habit, record, dateStr, today) {
  if (dateStr > today) return { score: null, excluded: true, status: "future" };
  if (!habitActiveOn(habit, dateStr)) return { score: null, excluded: true, status: "inactive" };
  if (!isScheduledDay(habit, dateStr)) return { score: null, excluded: true, status: "off_schedule" };

  const status = record ? record.status : "untracked";

  if (status === "off_day") return { score: null, excluded: true, status };
  if (status === "grace_protected") return { score: null, excluded: true, status, graced: true };
  if (status === "completed") return { score: 1, excluded: false, status };
  if (status === "missed") return { score: 0, excluded: false, status };
  if (status === "partial") {
    const target = record?.targetSnapshot ?? habit.targetValue ?? 1;
    const logged = record?.loggedValue ?? 0;
    const s = target > 0 ? Math.min(logged / target, 1) : 0;
    return { score: s, excluded: false, status, loggedValue: logged, target };
  }
  // untracked
  if (dateStr === today) return { score: null, excluded: true, status: "untracked" };
  return { score: 0, excluded: false, status: "missed_untracked" };
}

function habitConsistency(habit, records, fromDate, toDate, today) {
  let sum = 0, count = 0;
  let d = fromDate;
  while (d <= toDate && d <= today) {
    const rec = findRecord(records, habit.id, d);
    const ev = dayEval(habit, rec, d, today);
    if (!ev.excluded) { sum += ev.score; count++; }
    d = addDays(d, 1);
  }
  if (count === 0) return null;
  return (sum / count) * 100;
}

function dailyWeightedScore(habits, records, dateStr, today) {
  let wSum = 0, sSum = 0, any = false;
  for (const h of habits) {
    if (h.archived && dateStr > (h.archivedAt || "9999-99-99").slice(0,10)) continue;
    const rec = findRecord(records, h.id, dateStr);
    const ev = dayEval(h, rec, dateStr, today);
    if (ev.excluded) continue;
    any = true;
    sSum += ev.score * h.weight;
    wSum += h.weight;
  }
  if (!any || wSum === 0) return null;
  return (sSum / wSum) * 100;
}

function overallScore(habits, records, fromDate, toDate, today) {
  let wSum = 0, sSum = 0;
  for (const h of habits) {
    const c = habitConsistency(h, records, fromDate, toDate, today);
    if (c === null) continue;
    sSum += c * h.weight;
    wSum += h.weight;
  }
  if (wSum === 0) return null;
  return sSum / wSum;
}

function categoryBreakdown(habits, records, fromDate, toDate, today) {
  const byCat = {};
  for (const h of habits) {
    if (h.archived) continue;
    const c = habitConsistency(h, records, fromDate, toDate, today);
    if (c === null) continue;
    if (!byCat[h.category]) byCat[h.category] = { sum: 0, wSum: 0 };
    byCat[h.category].sum += c * h.weight;
    byCat[h.category].wSum += h.weight;
  }
  return Object.entries(byCat).map(([category, v]) => ({
    category, score: v.wSum ? v.sum / v.wSum : 0,
  })).sort((a, b) => b.score - a.score);
}

/* Streak for a single habit: consecutive scheduled occurrences completed (or graced), walking backward from today */
function habitStreak(habit, records, today) {
  let current, best = 0, run = 0;
  // walk forward from creation to compute best, and track current from the end
  let d = habit.createdAt.slice(0, 10);
  const seq = [];
  while (d <= today) {
    if (isScheduledDay(habit, d)) {
      const rec = findRecord(records, habit.id, d);
      const ev = dayEval(habit, rec, d, today);
      if (d === today && ev.status === "untracked") { d = addDays(d, 1); continue; }
      const good = ev.score === 1 || ev.graced;
      if (ev.excluded && !ev.graced) { /* skip, doesn't break or extend */ }
      else { seq.push(good); }
    }
    d = addDays(d, 1);
  }
  for (const g of seq) {
    if (g) { run++; best = Math.max(best, run); } else { run = 0; }
  }
  // current streak = trailing run of trues
  current = 0;
  for (let i = seq.length - 1; i >= 0; i--) {
    if (seq[i]) current++; else break;
  }
  return { current, best };
}

function overallStreak(habits, records, today, threshold) {
  let current, best = 0, run = 0;
  const active = habits.filter(h => !h.archived);
  if (active.length === 0) return { current: 0, best: 0 };
  const earliest = active.reduce((min, h) => h.createdAt.slice(0,10) < min ? h.createdAt.slice(0,10) : min, today);
  const seq = [];
  let d = earliest;
  while (d < today) { // exclude today (in progress) from streak calc unless fully done
    const s = dailyWeightedScore(habits, records, d, today);
    if (s !== null) seq.push(s >= threshold);
    d = addDays(d, 1);
  }
  const todayScore = dailyWeightedScore(habits, records, today, today);
  if (todayScore !== null && todayScore >= threshold) seq.push(true);

  for (const g of seq) { if (g) { run++; best = Math.max(best, run); } else run = 0; }
  current = 0;
  for (let i = seq.length - 1; i >= 0; i--) { if (seq[i]) current++; else break; }
  return { current, best };
}

function performanceLevel(score) {
  if (score === null || score === undefined) return { label: "NO DATA", color: COLORS.textFaint };
  if (score >= 90) return { label: "ELITE", color: COLORS.emerald };
  if (score >= 80) return { label: "EXCELLENT", color: COLORS.emerald };
  if (score >= 70) return { label: "GOOD", color: COLORS.amber };
  if (score >= 60) return { label: "NEEDS WORK", color: COLORS.amber };
  return { label: "RESET & REBUILD", color: COLORS.crimson };
}

/* ============================================================================
   GLOBAL APP CONTEXT
============================================================================ */
const AppCtx = createContext(null);
function useApp() { return useContext(AppCtx); }

/* ============================================================================
   ROOT APP
============================================================================ */
export default function App() {
  const [state, setState] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState("command");
  const [navOpen, setNavOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const saveTimer = useRef(null);

  useEffect(() => {
    (async () => {
     const s = await loadState();

const normalizedState = s
  ? {
      ...defaultState(),
      ...s,

      habits: Array.isArray(s.habits)
        ? s.habits.map(habit => ({
            archived: false,
            weight: 1,
            frequency: [
              0,
              1,
              2,
              3,
              4,
              5,
              6,
            ],
            allowGraceFreeze: true,
            reminderEnabled: false,
            reminderTime: "19:00",
            ...habit,
          }))
        : [],

      records: Array.isArray(
        s.records
      )
        ? s.records
        : [],

      graceUsage:
        s.graceUsage &&
        typeof s.graceUsage === "object"
          ? s.graceUsage
          : {},

      settings: {
        ...defaultState().settings,
        ...(s.settings || {}),
      },
    }
  : defaultState();

setState(normalizedState);
setLoaded(true);
      setLoaded(true);
    })();
  }, []);

  // debounced persistence
  useEffect(() => {
    if (!loaded || !state) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveState(state), 250);
    return () => clearTimeout(saveTimer.current);
  }, [state, loaded]);

  const showToast = useCallback((msg, kind = "info") => {
    setToast({ msg, kind, id: uid() });
    setTimeout(() => setToast(t => (t && t.msg === msg ? null : t)), 2600);
  }, []);

  const today = todayStr();
  useEffect(() => {
  if (!state) return;

  let lastTriggeredMinute = "";

  const checkReminders = () => {
    const now = new Date();

    const currentTime =
      `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;

    const currentDate =
      toDateStr(now);

    const triggerKey =
      `${currentDate}-${currentTime}`;

    // Prevent duplicate notifications during
    // the same minute.
    if (lastTriggeredMinute === triggerKey) {
      return;
    }

    for (const habit of state.habits) {
      if (habit.archived) continue;
      if (!habit.reminderEnabled) continue;

      // Only remind on the habit's scheduled days.
      if (!isScheduledDay(habit, currentDate)) {
        continue;
      }

      // Correct reminder time.
      if (habit.reminderTime !== currentTime) {
        continue;
      }

      // Don't remind if already completed.
      const record =
        findRecord(
          state.records,
          habit.id,
          currentDate
        );

      if (record?.status === "completed") {
        continue;
      }

      showHabitNotification(habit);
    }

    lastTriggeredMinute = triggerKey;
  };

  checkReminders();

  const interval =
    setInterval(
      checkReminders,
      15 * 1000
    );

  return () =>
    clearInterval(interval);

}, [state]);

  const api = useMemo(() => {
    if (!state) return null;
    return {
      state, setState, today, showToast,

      addHabit(habit) {
        setState(s => ({ ...s, habits: [...s.habits, {
          id: uid(), archived: false, createdAt: new Date().toISOString(),
          weight: 1, frequency: [0,1,2,3,4,5,6], allowGraceFreeze: true, ...habit,
        }] }));
      },
      updateHabit(id, patch) {
        setState(s => ({ ...s, habits: s.habits.map(h => h.id === id ? { ...h, ...patch } : h) }));
      },
      archiveHabit(id) {
        setState(s => ({ ...s, habits: s.habits.map(h => h.id === id ? { ...h, archived: true, archivedAt: new Date().toISOString() } : h) }));
      },
      restoreHabit(id) {
        setState(s => ({ ...s, habits: s.habits.map(h => h.id === id ? { ...h, archived: false, archivedAt: null } : h) }));
      },
      deleteHabit(id) {
        setState(s => ({ ...s, habits: s.habits.filter(h => h.id !== id), records: s.records.filter(r => r.habitId !== id) }));
      },

      setRecord(habitId, dateStr, patch) {
        setState(s => {
          const idx = s.records.findIndex(r => r.habitId === habitId && r.date === dateStr);
          const now = new Date().toISOString();
          if (idx === -1) {
            return { ...s, records: [...s.records, { id: uid(), habitId, date: dateStr, status: "untracked", updatedAt: now, ...patch }] };
          }
          const next = [...s.records];
          next[idx] = { ...next[idx], ...patch, updatedAt: now };
          return { ...s, records: next };
        });
      },

     cycleBinary(habitId, dateStr) {
  const rec = findRecord(state.records, habitId, dateStr);

  // Once a habit is completed, lock it for the day.
  if (rec?.status === "completed") {
    return;
  }

  const order = ["untracked", "completed", "missed"];
  const cur = rec ? rec.status : "untracked";

  const idx = order.indexOf(
    cur === "grace_protected" || cur === "off_day"
      ? "untracked"
      : cur
  );

  const next = order[(idx + 1) % order.length];

  api_setRecordSafe();

  function api_setRecordSafe() {
    setState(s => {
      const i = s.records.findIndex(
        r =>
          r.habitId === habitId &&
          r.date === dateStr
      );

      const now = new Date().toISOString();

      if (i === -1) {
        return {
          ...s,
          records: [
            ...s.records,
            {
              id: uid(),
              habitId,
              date: dateStr,
              status: next,
              updatedAt: now
            }
          ]
        };
      }

      const arr = [...s.records];

      arr[i] = {
        ...arr[i],
        status: next,
        updatedAt: now
      };

      return {
        ...s,
        records: arr
      };
    });
  }
},

      toggleOffDay(habitId, dateStr) {
        const rec = findRecord(state.records, habitId, dateStr);
        const status = rec && rec.status === "off_day" ? "untracked" : "off_day";
        this.setRecord(habitId, dateStr, { status });
      },

      useGraceFreeze(habitId, dateStr, reason) {
        const mk = getMonthKey(dateStr);
        const used = state.graceUsage[habitId]?.[mk] || 0;
        if (used >= 1) { showToast("No grace freezes left this month", "warn"); return; }
        setState(s => ({
          ...s,
          records: (() => {
            const i = s.records.findIndex(r => r.habitId === habitId && r.date === dateStr);
            const now = new Date().toISOString();
            if (i === -1) return [...s.records, { id: uid(), habitId, date: dateStr, status: "grace_protected", reason, updatedAt: now }];
            const arr = [...s.records]; arr[i] = { ...arr[i], status: "grace_protected", reason, updatedAt: now };
            return arr;
          })(),
          graceUsage: { ...s.graceUsage, [habitId]: { ...(s.graceUsage[habitId] || {}), [mk]: used + 1 } },
        }));
        showToast("Streak Saver used", "good");
      },

      importData(data) {
  if (
    !data ||
    typeof data !== "object"
  ) {
    showToast(
      "Invalid backup data",
      "warn"
    );
    return;
  }

  setState({
    ...defaultState(),
    ...data,

    habits: Array.isArray(
      data.habits
    )
      ? data.habits
      : [],

    records: Array.isArray(
      data.records
    )
      ? data.records
      : [],

    graceUsage:
      data.graceUsage &&
      typeof data.graceUsage ===
        "object"
        ? data.graceUsage
        : {},

    settings: {
      ...defaultState().settings,
      ...(data.settings || {}),
    },
  });

  showToast(
    "Backup restored",
    "good"
  );
},
      resetAll() {
        setState(defaultState());
        showToast("All data cleared", "warn");
      },
      completeOnboarding() {
        setState(s => ({ ...s, onboarded: true }));
      },
    };
  }, [state]); // eslint-disable-line

  if (!loaded || !state) {
    return <Shell><LoadingScreen /></Shell>;
  }

  const showOnboarding = !state.onboarded && state.habits.length === 0;

  return (
    <AppCtx.Provider value={api}>
      <Shell>
        {showOnboarding ? (
          <Onboarding />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
            <AppHeader view={view} setView={setView} navOpen={navOpen} setNavOpen={setNavOpen} />
            <main className="app-main" style={{ flex: 1, overflow: "auto", minWidth: 0 }}>
              <div style={{ maxWidth: 1180, margin: "0 auto", padding: "20px 20px 100px" }}>
                {view === "command" && <CommandCenter setView={setView} />}
                {view === "today" && <TodayFocusMode setView={setView} />}
                {view === "habits" && <HabitMatrixView />}
                {view === "analytics" && <AnalyticsView />}
                {view === "heatmap" && <HeatmapView />}
                {view === "history" && <HistoryView />}
                {view === "compare" && <YouVsYouView />}
                {view === "settings" && <SettingsView />}
              </div>
            </main>
          </div>
        )}
        {toast && <Toast toast={toast} />}
      </Shell>
    </AppCtx.Provider>
  );
}

/* ============================================================================
   SHELL / GLOBAL STYLE
============================================================================ */
function Shell({ children }) {
  return (
    <div style={{
      background: `radial-gradient(circle at 82% -10%, ${COLORS.indigo}22, transparent 34%), radial-gradient(circle at 8% 92%, ${COLORS.cyan}12, transparent 30%), ${COLORS.bg}`,
      color: COLORS.text, minHeight: "100%", height: "100%",
      fontFamily: "'DM Sans', 'Inter', system-ui, sans-serif",
      fontSize: 14, position: "relative", display: "flex", flexDirection: "column",
    }}>
      <GlobalStyle />
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      {children}
    </div>
  );
}

function GlobalStyle() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&family=Space+Mono:wght@400;700&display=swap');
      * { box-sizing: border-box; }
      body, html, #root { height: 100%; margin: 0; }
      body { background: ${COLORS.bg}; }
      #root { width: 100%; max-width: none; min-height: 100svh; text-align: left; }
      ::-webkit-scrollbar { width: 8px; height: 8px; }
      ::-webkit-scrollbar-track { background: ${COLORS.bg}; }
      ::-webkit-scrollbar-thumb { background: #34415a; border-radius: 4px; }
      .mono { font-family: 'Space Mono', monospace; }
      button, input, select { font-family: inherit; }
      button { cursor: pointer; }
      .focus-ring:focus-visible { outline: 2px solid ${COLORS.cyan}; outline-offset: 3px; }
      @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
      @keyframes fadeUp { from { opacity:0; transform: translateY(6px);} to {opacity:1; transform:translateY(0);} }
      @keyframes popIn { from { opacity:0; transform: scale(.92);} to {opacity:1; transform:scale(1);} }
      .card-anim { animation: fadeUp .35s ease both; }
      .glass-panel { backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); }
      .heatmap-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(15px, 1fr)); gap: clamp(4px, .65vw, 9px); width: 100%; }
      .heatmap-cell { width: 100%; aspect-ratio: 1; min-width: 0; border-radius: clamp(3px, .35vw, 6px); transition: transform .16s ease, filter .16s ease; }
      .heatmap-cell:hover { transform: scale(1.18); filter: brightness(1.2); }
      .heatmap-legend { display: flex; align-items: center; flex-wrap: wrap; gap: 1rem; margin-top: 1.5rem; }
      .heatmap-scale { display: inline-flex; align-items: center; flex-wrap: wrap; gap: clamp(5px, .7vw, 9px); }
      .heatmap-swatch { width: clamp(13px, 1.35vw, 20px); height: clamp(13px, 1.35vw, 20px); border-radius: clamp(3px, .3vw, 5px); flex: 0 0 auto; }
      .app-header { position: fixed; top: 0; left: 0; right: 0; height: 68px; z-index: 80; border-bottom: 1px solid ${COLORS.border}; background: rgba(7, 10, 17, .76); backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px); }
      .app-header-inner { height: 100%; max-width: 1240px; margin: 0 auto; padding: 0 22px; display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 24px; }
      .header-links { display: flex; align-items: center; justify-content: center; gap: 4px; }
      .header-link { color: ${COLORS.textDim}; background: transparent; border: 1px solid transparent; border-radius: 7px; padding: 8px 10px; font-size: 10px; font-weight: 800; letter-spacing: .7px; white-space: nowrap; }
      .header-link.active { color: ${COLORS.text}; background: ${COLORS.indigo}1c; border-color: ${COLORS.indigo}55; }
      .mobile-menu-button, .mobile-drawer { display: none; }
      .ambient { position: fixed; pointer-events: none; border-radius: 999px; filter: blur(80px); opacity: .32; z-index: 0; animation: floatGlow 12s ease-in-out infinite; }
      .ambient-one { width: 260px; height: 260px; top: 8%; right: 8%; background: ${COLORS.indigo}; }
      .ambient-two { width: 220px; height: 220px; bottom: 4%; left: 10%; background: ${COLORS.cyan}; animation-delay: -5s; }
      @keyframes floatGlow { 0%, 100% { transform: translate3d(0, 0, 0) scale(1); } 50% { transform: translate3d(22px, -18px, 0) scale(1.12); } }
      .app-main { position: relative; z-index: 1; padding-top: 68px; }
      @media (max-width: 1100px) { .header-links { gap: 0; } .header-link { padding-inline: 7px; font-size: 9px; } }
      @media (max-width: 900px) {
        .app-header { height: 62px; }
        .app-header-inner { display: flex; justify-content: space-between; padding: 0 16px; }
        .header-links, .header-cta { display: none; }
        .mobile-menu-button { display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; border: 1px solid ${COLORS.border}; border-radius: 9px; background: ${COLORS.surface2}; color: ${COLORS.text}; }
        .mobile-drawer { display: flex; position: fixed; top: 62px; left: 0; right: 0; z-index: 79; flex-direction: column; gap: 4px; padding: 12px 16px 16px; background: rgba(11, 15, 23, .94); border-bottom: 1px solid ${COLORS.border}; backdrop-filter: blur(18px); transform: translateY(-120%); transition: transform .28s ease; }
        .mobile-drawer.open { transform: translateY(0); }
        .mobile-drawer .header-link { display: flex; align-items: center; gap: 10px; width: 100%; padding: 12px; font-size: 11px; text-align: left; }
        .app-main { padding-top: 62px; }
      }
      @media (hover: hover) {
        button:hover { filter: brightness(1.08); }
        .card-anim:hover { border-color: rgba(99, 102, 241, .38); }
      }
    `}</style>
  );
}

function LoadingScreen() {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", color: COLORS.textDim }}>
      Loading your system…
    </div>
  );
}

/* ============================================================================
   NAVIGATION
============================================================================ */
const NAV_ITEMS = [
  { id: "command", label: "COMMAND CENTER", icon: Home },
  { id: "today", label: "TODAY", icon: Target },
  { id: "habits", label: "HABITS", icon: Grid3x3 },
  { id: "analytics", label: "ANALYTICS", icon: BarChart3 },
  { id: "heatmap", label: "HEATMAP", icon: LayoutGrid },
  { id: "history", label: "HISTORY", icon: HistoryIcon },
  { id: "compare", label: "YOU VS YOU", icon: Swords },
  { id: "settings", label: "SETTINGS", icon: SettingsIcon },
];

function AppHeader({ view, setView, navOpen, setNavOpen }) {
  const navigate = id => { setView(id); setNavOpen(false); };
  return (
    <header className="app-header">
      <div className="app-header-inner">
        <button onClick={() => navigate("command")} className="focus-ring" style={{ display: "flex", alignItems: "center", gap: 9, border: "none", background: "transparent", color: COLORS.text, padding: 0, textAlign: "left" }} aria-label="Go to command center">
          <span style={{ width: 30, height: 30, borderRadius: 9, display: "grid", placeItems: "center", background: `linear-gradient(135deg, ${COLORS.indigo}, ${COLORS.cyan})`, color: "white", boxShadow: `0 0 22px ${COLORS.indigo}55` }}><Activity size={16} /></span>
          <span><strong style={{ display: "block", fontSize: 14, letterSpacing: .8 }}>HABIT OS</strong><small className="mono" style={{ display: "block", color: COLORS.textFaint, fontSize: 8, marginTop: 1 }}>PERFORMANCE SYSTEM</small></span>
        </button>
        <nav className="header-links" aria-label="Primary navigation">
          {NAV_ITEMS.slice(0, 6).map(item => { const Icon = item.icon; return <button key={item.id} onClick={() => navigate(item.id)} className={`header-link focus-ring ${view === item.id ? "active" : ""}`}><Icon size={13} /> {item.label.replace("COMMAND CENTER", "COMMAND")}</button>; })}
        </nav>
        <div className="header-cta" style={{ justifySelf: "end" }}><Btn variant="primary" icon={Target} onClick={() => navigate("today")} style={{ padding: "9px 14px", fontSize: 11 }}>TODAY'S FOCUS</Btn></div>
        <button className="mobile-menu-button focus-ring" onClick={() => setNavOpen(open => !open)} aria-label={navOpen ? "Close navigation" : "Open navigation"} aria-expanded={navOpen}><Menu size={20} /></button>
      </div>
      <nav className={`mobile-drawer ${navOpen ? "open" : ""}`} aria-label="Mobile navigation">
        {NAV_ITEMS.map(item => { const Icon = item.icon; return <button key={item.id} onClick={() => navigate(item.id)} className={`header-link focus-ring ${view === item.id ? "active" : ""}`}><Icon size={16} /> {item.label}</button>; })}
        <Btn variant="primary" icon={Target} onClick={() => navigate("today")} style={{ marginTop: 6, justifyContent: "center" }}>TODAY'S FOCUS</Btn>
      </nav>
    </header>
  );
}

function Toast({ toast }) {
  const color = toast.kind === "good" ? COLORS.emerald : toast.kind === "warn" ? COLORS.amber : COLORS.text;
  return (
    <div style={{
      position: "fixed", bottom: 90, left: "50%", transform: "translateX(-50%)",
      background: COLORS.surface2, border: `1px solid ${COLORS.border}`, borderLeft: `3px solid ${color}`,
      padding: "10px 16px", borderRadius: 8, fontSize: 13, zIndex: 60, animation: "fadeUp .25s ease",
      boxShadow: "0 8px 24px rgba(0,0,0,.4)",
    }}>
      {toast.msg}
    </div>
  );
}

/* ============================================================================
   SHARED UI PRIMITIVES
============================================================================ */
function Card({ children, style, className }) {
  return (
    <div className={`card-anim glass-panel ${className || ""}`} style={{
      background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 10,
      padding: 16, boxShadow: "0 14px 40px rgba(0, 0, 0, .16)", ...style,
    }}>
      {children}
    </div>
  );
}

function StatCard({ label, value, sub, accent, icon: Icon }) {
  return (
    <Card style={{ minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <span style={{ fontSize: 10.5, letterSpacing: 0.8, color: COLORS.textFaint, fontWeight: 700 }}>{label}</span>
        {Icon && <Icon size={14} color={accent || COLORS.textFaint} />}
      </div>
      <div className="mono" style={{ fontSize: 26, fontWeight: 700, color: accent || COLORS.text, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11.5, color: COLORS.textDim, marginTop: 6 }}>{sub}</div>}
    </Card>
  );
}

function SectionTitle({ children, right }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "28px 0 12px" }}>
      <h2 style={{ fontSize: 12.5, letterSpacing: 1, color: COLORS.textDim, fontWeight: 700, margin: 0, textTransform: "uppercase" }}>{children}</h2>
      {right}
    </div>
  );
}

function Btn({ children, onClick, variant = "default", style, icon: Icon, disabled, type = "button" }) {
  const base = {
    display: "inline-flex", alignItems: "center", gap: 7, padding: "9px 14px", borderRadius: 7,
    fontSize: 12.5, fontWeight: 600, border: `1px solid ${COLORS.border}`, letterSpacing: 0.2,
    opacity: disabled ? 0.5 : 1, transition: "all .15s",
  };
  const variants = {
    default: { background: COLORS.surface2, color: COLORS.text },
    primary: { background: `linear-gradient(135deg, ${COLORS.indigo}, ${COLORS.cyan})`, color: "#F9FAFB", border: "1px solid rgba(255,255,255,.18)", boxShadow: `0 8px 24px ${COLORS.indigo}44` },
    danger: { background: "transparent", color: COLORS.crimson, border: `1px solid ${COLORS.crimson}44` },
    ghost: { background: "transparent", color: COLORS.textDim, border: "1px solid transparent" },
  };
  return (
    <button type={type} disabled={disabled} onClick={onClick} className="focus-ring" style={{ ...base, ...variants[variant], ...style }}>
      {Icon && <Icon size={14} />}
      {children}
    </button>
  );
}

function EmptyState({ title, body, cta, onCta }) {
  return (
    <Card style={{ textAlign: "center", padding: "48px 24px" }}>
      <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: 1, marginBottom: 8, color: COLORS.textDim }}>{title}</div>
      <div style={{ color: COLORS.textFaint, fontSize: 13, maxWidth: 360, margin: "0 auto 18px", lineHeight: 1.6 }}>{body}</div>
      {cta && <Btn variant="primary" icon={Plus} onClick={onCta}>{cta}</Btn>}
    </Card>
  );
}

function Bar({ pct, color }) {
  const c = color || (pct >= 80 ? COLORS.emerald : pct >= 60 ? COLORS.amber : COLORS.crimson);
  return (
    <div style={{ background: COLORS.surface2, borderRadius: 4, height: 8, overflow: "hidden" }}>
      <div style={{ width: `${Math.max(0, Math.min(100, pct))}%`, height: "100%", background: c, borderRadius: 4, transition: "width .4s ease" }} />
    </div>
  );
}

/* ============================================================================
   ONBOARDING
============================================================================ */
function Onboarding() {
  const app = useApp();
  const [step, setStep] = useState(0);
  const [focus, setFocus] = useState("Fitness");
  const [name, setName] = useState("");
  const [type, setType] = useState("binary");
  const [freq, setFreq] = useState([1,2,3,4,5]);

  const steps = ["Goal", "Habit", "Schedule", "Start"];

  function finish() {
    if (name.trim()) {
      app.addHabit({ name: name.trim(), category: focus, type, targetValue: type === "quantitative" ? 1 : undefined, unit: type === "quantitative" ? "units" : undefined, frequency: freq, weight: 2 });
    }
    app.completeOnboarding();
  }

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", padding: 20 }}>
      <div style={{ maxWidth: 460, width: "100%" }} className="card-anim">
        <div style={{ display: "flex", gap: 6, marginBottom: 24 }}>
          {steps.map((s, i) => (
            <div key={s} style={{ flex: 1, height: 3, borderRadius: 2, background: i <= step ? COLORS.emerald : COLORS.border }} />
          ))}
        </div>

        {step === 0 && (
          <>
            <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 6 }}>What do you want to improve?</h1>
            <p style={{ color: COLORS.textDim, marginBottom: 22, fontSize: 13 }}>Pick a starting focus. You can add more later.</p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {CATEGORIES.slice(0,4).map(c => (
                <button key={c} onClick={() => setFocus(c)} className="focus-ring" style={{
                  padding: "18px 12px", borderRadius: 8, textAlign: "left", fontWeight: 700, fontSize: 13,
                  background: focus === c ? COLORS.surface2 : COLORS.surface, border: `1px solid ${focus === c ? COLORS.emerald : COLORS.border}`,
                  color: focus === c ? COLORS.emerald : COLORS.text,
                }}>{c}</button>
              ))}
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 6 }}>Create your first habit.</h1>
            <p style={{ color: COLORS.textDim, marginBottom: 18, fontSize: 13 }}>Start with one. Consistency beats ambition.</p>
            <TextField label="Habit name" value={name} onChange={setName} placeholder="e.g. Workout" autoFocus />
            <div style={{ marginTop: 14 }}>
              <FieldLabel>Type</FieldLabel>
              <div style={{ display: "flex", gap: 8 }}>
                <ToggleChip active={type === "binary"} onClick={() => setType("binary")}>Binary (done / not done)</ToggleChip>
                <ToggleChip active={type === "quantitative"} onClick={() => setType("quantitative")}>Quantitative (amount)</ToggleChip>
              </div>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 6 }}>Set your schedule.</h1>
            <p style={{ color: COLORS.textDim, marginBottom: 18, fontSize: 13 }}>Which days does "{name || "this habit"}" apply?</p>
            <WeekdayPicker value={freq} onChange={setFreq} />
          </>
        )}

        {step === 3 && (
          <>
            <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 6 }}>Start today.</h1>
            <p style={{ color: COLORS.textDim, marginBottom: 18, fontSize: 13, lineHeight: 1.6 }}>
              Your system is ready. Track today, build tomorrow. Don't chase perfection — build consistency.
            </p>
          </>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 26 }}>
          {step > 0 ? <Btn onClick={() => setStep(s => s - 1)}>Back</Btn> : <span />}
          {step < 3 ? (
            <Btn variant="primary" onClick={() => setStep(s => s + 1)} disabled={step === 1 && !name.trim()}>Continue</Btn>
          ) : (
            <Btn variant="primary" onClick={finish}>Enter Performance OS</Btn>
          )}
        </div>
      </div>
    </div>
  );
}

 function TextField({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  autoFocus,
  suffix,
  name
}) {
  const fieldId =
    name ||
    label?.toLowerCase().replace(/\s+/g, "-");

  return (
    <label
      htmlFor={fieldId}
      style={{ display: "block" }}
    >
      {label && (
        <FieldLabel>
          {label}
        </FieldLabel>
      )}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <input
          id={fieldId}
          name={fieldId}
          autoFocus={autoFocus}
          type={type}
          value={value}
          placeholder={placeholder}
          onChange={e =>
            onChange(e.target.value)
          }
          className="focus-ring"
          style={{
            width: "100%",
            background: COLORS.surface2,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 7,
            padding: "10px 12px",
            color: COLORS.text,
            fontSize: 13.5,
          }}
        />

        {suffix && (
          <span
            style={{
              color: COLORS.textFaint,
              fontSize: 12,
            }}
          >
            {suffix}
          </span>
        )}
      </div>
    </label>
  );
}
function FieldLabel({ children }) {
  return <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, color: COLORS.textFaint, marginBottom: 6, textTransform: "uppercase" }}>{children}</div>;
}
function ToggleChip({ active, onClick, children }) {
  return (
    <button onClick={onClick} className="focus-ring" style={{
      flex: 1, padding: "10px 10px", borderRadius: 7, fontSize: 12, fontWeight: 600, textAlign: "center",
      background: active ? `${COLORS.emerald}1a` : COLORS.surface2, border: `1px solid ${active ? COLORS.emerald : COLORS.border}`,
      color: active ? COLORS.emerald : COLORS.textDim,
    }}>{children}</button>
  );
}
function WeekdayPicker({ value, onChange }) {
  return (
    <div style={{ display: "flex", gap: 6 }}>
      {WEEKDAY_LABELS.map((l, i) => {
        const active = value.includes(i);
        return (
          <button key={i} onClick={() => onChange(active ? value.filter(x => x !== i) : [...value, i])} className="focus-ring"
            style={{
              width: 38, height: 38, borderRadius: "50%", fontSize: 12, fontWeight: 700,
              background: active ? COLORS.emerald : COLORS.surface2, color: active ? "#04120C" : COLORS.textDim,
              border: `1px solid ${active ? COLORS.emerald : COLORS.border}`,
            }}>{l}</button>
        );
      })}
    </div>
  );
}

/* ============================================================================
   COMMAND CENTER (Dashboard)
============================================================================ */
function greeting() {
  const h = new Date().getHours();
  if (h < 5) return { text: "GOOD NIGHT", icon: MoonStar };
  if (h < 12) return { text: "GOOD MORNING", icon: Sun };
  if (h < 17) return { text: "GOOD AFTERNOON", icon: Sunset };
  if (h < 21) return { text: "GOOD EVENING", icon: Sunset };
  return { text: "GOOD NIGHT", icon: Moon };
}

function CommandCenter({ setView }) {
  const { state, today } = useApp();
  const activeHabits = state.habits.filter(h => !h.archived);
  const g = greeting();
  const GIcon = g.icon;

  if (activeHabits.length === 0) {
    return <EmptyState title="BUILD YOUR SYSTEM" body="You don't have any habits yet. Start with one habit. Build consistency. Build momentum." cta="Create First Habit" onCta={() => setView("habits")} />;
  }

  const monthKey = getMonthKey(today);
  const monthStart = monthKey + "-01";
  const score = overallScore(activeHabits, state.records, monthStart, today, today);
  const prevMK = prevMonthKey(monthKey);
  const prevStart = prevMK + "-01";
  const prevEnd = prevMK + "-" + pad2(daysInMonth(prevMK));
  const prevScore = overallScore(activeHabits, state.records, prevStart, prevEnd, today);
  const streak = overallStreak(activeHabits, state.records, today, state.settings.streakThreshold);
  const daysTracked = Array.from({ length: Number(today.slice(8,10)) }).filter((_, i) => {
    const d = monthKey + "-" + pad2(i + 1);
    return state.records.some(r => r.date === d && r.status !== "untracked");
  }).length;
  const daysInCurMonth = daysInMonth(monthKey);
  const delta = (score !== null && prevScore !== null) ? score - prevScore : null;

  const cats = categoryBreakdown(activeHabits, state.records, monthStart, today, today);
  const best = cats[0];
  const weak = cats[cats.length - 1];

  const level = performanceLevel(score);

  const todayScore = dailyWeightedScore(activeHabits, state.records, today, today);
  const strong = [], attention = [];
  for (const h of activeHabits) {
    if (!isScheduledDay(h, today)) continue;
    const rec = findRecord(state.records, h.id, today);
    const ev = dayEval(h, rec, today, today);
    if (ev.excluded) continue;
    if (ev.score >= 1) strong.push(h); else if (ev.score < 1) attention.push(h);
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 2 }}>
        <GIcon size={20} color={COLORS.emerald} />
        <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: 1.2, color: COLORS.textDim }}>{g.text}</span>
      </div>
      <h1 style={{ fontSize: 24, fontWeight: 800, margin: "4px 0 18px" }}>{niceDate(today)}</h1>

      <Btn variant="primary" icon={Target} onClick={() => setView("today")} style={{ marginBottom: 22, padding: "12px 20px", fontSize: 13 }}>
        ENTER TODAY MODE
      </Btn>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12 }}>
        <StatCard label="OVERALL SCORE" value={score !== null ? `${score.toFixed(1)}%` : "—"} sub={level.label} accent={level.color} icon={Trophy} />
        <StatCard label="CURRENT STREAK" value={streak.current > 0 ? `🔥 ${streak.current}` : "0"} sub={`Best: ${streak.best} days`} accent={streak.current > 0 ? COLORS.amber : undefined} icon={Flame} />
        <StatCard label="DAYS TRACKED" value={`${daysTracked} / ${daysInCurMonth}`} sub="this month" icon={CalendarIcon} />
        <StatCard label="VS LAST MONTH" value={delta !== null ? `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%` : "—"} sub={delta !== null ? (delta >= 0 ? "improving ↑" : "declining ↓") : "not enough data"} accent={delta !== null ? (delta >= 0 ? COLORS.emerald : COLORS.crimson) : undefined} icon={delta >= 0 ? TrendingUp : TrendingDown} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12, marginTop: 12 }}>
        <StatCard label="BEST CATEGORY" value={best ? `${best.score.toFixed(0)}%` : "—"} sub={best ? best.category : "no data"} accent={COLORS.emerald} />
        <StatCard label="NEEDS FOCUS" value={weak ? `${weak.score.toFixed(0)}%` : "—"} sub={weak ? weak.category : "no data"} accent={COLORS.amber} />
        <StatCard label="TODAY'S SCORE" value={todayScore !== null ? `${todayScore.toFixed(0)}%` : "—"} sub="live" />
      </div>

      <SectionTitle>Today's Signal</SectionTitle>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Card>
          <div style={{ fontSize: 11, fontWeight: 700, color: COLORS.emerald, letterSpacing: 0.6, marginBottom: 10 }}>STRONG TODAY</div>
          {strong.length === 0 && <div style={{ color: COLORS.textFaint, fontSize: 12.5 }}>Nothing logged yet.</div>}
          {strong.map(h => (
            <div key={h.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", fontSize: 13 }}>
              <Check size={14} color={COLORS.emerald} /> {h.name}
            </div>
          ))}
        </Card>
        <Card>
          <div style={{ fontSize: 11, fontWeight: 700, color: COLORS.crimson, letterSpacing: 0.6, marginBottom: 10 }}>NEEDS ATTENTION</div>
          {attention.length === 0 && <div style={{ color: COLORS.textFaint, fontSize: 12.5 }}>All clear.</div>}
          {attention.map(h => (
            <div key={h.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", fontSize: 13 }}>
              <X size={14} color={COLORS.crimson} /> {h.name}
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}

/* ============================================================================
   TODAY FOCUS MODE
============================================================================ */
function TodayFocusMode({ setView }) {
  const app = useApp();
  const { state, today } = app;
  const activeHabits = state.habits.filter(h => !h.archived && isScheduledDay(h, today) && habitActiveOn(h, today));
  const [editing, setEditing] =
  useState(null);

const [editingBinary, setEditingBinary] =
  useState(null);

  if (state.habits.filter(h => !h.archived).length === 0) {
    return <EmptyState title="NOTHING SCHEDULED" body="Create a habit to start your daily check-in." cta="Create Habit" onCta={() => setView("habits")} />;
  }

  const score = dailyWeightedScore(state.habits.filter(h => !h.archived), state.records, today, today);
  const level = performanceLevel(score);

  return (
    <div style={{ maxWidth: 480, margin: "0 auto" }}>
      <div style={{ textAlign: "center", marginBottom: 20 }}>
        <div style={{ fontSize: 11, letterSpacing: 1.4, color: COLORS.textFaint, fontWeight: 700 }}>TODAY</div>
        <div className="mono" style={{ fontSize: 20, fontWeight: 700, marginTop: 2 }}>{shortDate(today).toUpperCase()}</div>
      </div>

      {activeHabits.length === 0 ? (
        <Card style={{ textAlign: "center", padding: 30, color: COLORS.textDim }}>No habits scheduled today. Rest well.</Card>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {activeHabits.map(h => (
<TodayRow
  key={h.id}
  habit={h}
  onEdit={() => {
    if (h.type === "quantitative") {
      setEditing(h);
    } else {
      setEditingBinary(h);
    }
  }}
/>
          ))}
        </div>
      )}

      <div style={{ textAlign: "center", marginTop: 28 }}>
        <div style={{ fontSize: 11, letterSpacing: 1, color: COLORS.textFaint, fontWeight: 700 }}>DAILY SCORE</div>
        <div className="mono" style={{ fontSize: 44, fontWeight: 800, color: level.color, lineHeight: 1.1, margin: "6px 0" }}>
          {score !== null ? `${score.toFixed(0)}%` : "—"}
        </div>
        <div style={{ fontSize: 11.5, color: level.color, fontWeight: 700, letterSpacing: 0.6 }}>{level.label}</div>
        <Btn variant="primary" style={{ marginTop: 18, padding: "12px 30px" }} onClick={() => setView("command")}>DONE</Btn>
      </div>

     {editing && (
  <QuantModal
    habit={editing}
    date={today}
    onClose={() =>
      setEditing(null)
    }
  />
)}

{editingBinary && (
  <BinaryEditModal
    habit={editingBinary}
    date={today}
    onClose={() =>
      setEditingBinary(null)
    }
  />
)}
    </div>
  );
}

function TodayRow({ habit, onEdit }) {
  const app = useApp();
  const { state, today } = app;

  const rec = findRecord(
    state.records,
    habit.id,
    today
  );

  const ev = dayEval(
    habit,
    rec,
    today,
    today
  );

  /* ============================================================
     BINARY HABIT
  ============================================================ */

  if (habit.type === "binary") {
    const status =
      rec?.status || "untracked";

    const cfg = {
      completed: {
        icon: Check,
        color: COLORS.emerald,
        bg: `${COLORS.emerald}14`,
        label: "Completed",
      },

      missed: {
        icon: X,
        color: COLORS.crimson,
        bg: `${COLORS.crimson}14`,
        label: "Missed",
      },

      untracked: {
        icon: Minus,
        color: COLORS.textFaint,
        bg: COLORS.surface,
        label: "Not completed",
      },
    }[status] || {
      icon: Minus,
      color: COLORS.textFaint,
      bg: COLORS.surface,
      label: "Not completed",
    };

    const Icon = cfg.icon;

    /*
     * IMPORTANT:
     * Completed habits are no longer toggled by clicking
     * the entire card. The user must use Edit.
     */
    const isCompleted =
      status === "completed";

    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          width: "100%",
          background: cfg.bg,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 10,
          padding: "14px 16px",
        }}
      >

        {/* MAIN HABIT BUTTON */}

        <button
          onClick={() => {
            if (isCompleted) return;

            app.cycleBinary(
              habit.id,
              today
            );
          }}
          className="focus-ring"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flex: 1,
            minWidth: 0,
            background: "transparent",
            border: "none",
            padding: 0,
            textAlign: "left",
            color: COLORS.text,
          }}
        >

          <div
            style={{
              minWidth: 0,
            }}
          >

            <div
              style={{
                fontWeight: 700,
                fontSize: 14.5,
              }}
            >
              {habit.name}
            </div>

            <div
              style={{
                fontSize: 11,
                color: COLORS.textFaint,
                marginTop: 3,
              }}
            >
              {isCompleted
                ? "Completed today"
                : habit.category}
            </div>

          </div>

          <div
            style={{
              width: 34,
              height: 34,
              borderRadius: "50%",
              background:
                cfg.color + "22",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <Icon
              size={18}
              color={cfg.color}
              strokeWidth={2.6}
            />
          </div>

        </button>


        {/* EDIT BUTTON — TODAY ONLY */}

        {isCompleted && (
          <button
            onClick={() =>
              onEdit()
            }
            className="focus-ring"
            title="Edit today's record"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 30,
              height: 30,
              borderRadius: 7,
              background:
                COLORS.surface2,
              border:
                `1px solid ${COLORS.border}`,
              color:
                COLORS.textDim,
              flexShrink: 0,
            }}
          >
            <Pencil size={13} />
          </button>
        )}

      </div>
    );
  }


  /* ============================================================
     QUANTITATIVE HABIT
  ============================================================ */

  const pct =
    ev.score !== null &&
    ev.score !== undefined
      ? Math.round(
          ev.score * 100
        )
      : 0;

  const isCompleted =
    rec?.status === "completed";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "100%",
        background: COLORS.surface,
        border:
          `1px solid ${COLORS.border}`,
        borderRadius: 10,
        padding: "14px 16px",
      }}
    >

      {/* QUANTITATIVE MAIN BUTTON */}

      <button
        onClick={() => {
          if (isCompleted) return;
          onEdit();
        }}
        className="focus-ring"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flex: 1,
          minWidth: 0,
          background: "transparent",
          border: "none",
          padding: 0,
          textAlign: "left",
          color: COLORS.text,
        }}
      >

        <div
          style={{
            flex: 1,
            minWidth: 0,
          }}
        >

          <div
            style={{
              fontWeight: 700,
              fontSize: 14.5,
            }}
          >
            {habit.name}
          </div>

          <div
            style={{
              fontSize: 11,
              color: COLORS.textFaint,
              marginTop: 2,
            }}
          >
            {rec?.loggedValue ?? 0}
            {" / "}
            {habit.targetValue}
            {" "}
            {habit.unit}
          </div>

          <div
            style={{
              marginTop: 8,
              width: 140,
            }}
          >
            <Bar pct={pct} />
          </div>

        </div>

        <div
          className="mono"
          style={{
            fontSize: 18,
            fontWeight: 700,
            color:
              pct >= 100
                ? COLORS.emerald
                : COLORS.text,
            marginLeft: 12,
            flexShrink: 0,
          }}
        >
          {pct}%
        </div>

      </button>


      {/* EDIT BUTTON AFTER COMPLETION */}

      {isCompleted && (
        <button
          onClick={() =>
            onEdit()
          }
          className="focus-ring"
          title="Edit today's record"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 30,
            height: 30,
            borderRadius: 7,
            background:
              COLORS.surface2,
            border:
              `1px solid ${COLORS.border}`,
            color:
              COLORS.textDim,
            flexShrink: 0,
          }}
        >
          <Pencil size={13} />
        </button>
      )}

    </div>
  );
}

function QuantModal({ habit, date, onClose }) {
  const app = useApp();
  const rec = findRecord(app.state.records, habit.id, date);
  const [val, setVal] = useState(rec?.loggedValue ?? "");

  function save() {
    const n = Number(val) || 0;
    const status = n >= habit.targetValue ? "completed" : n > 0 ? "partial" : "untracked";
    app.setRecord(habit.id, date, { loggedValue: n, status, targetSnapshot: habit.targetValue });
    onClose();
  }

  return (
    <ModalShell onClose={onClose}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.8, color: COLORS.textFaint, marginBottom: 4 }}>{habit.name.toUpperCase()}</div>
      <div style={{ fontSize: 13, color: COLORS.textDim, marginBottom: 16 }}>Target: {habit.targetValue} {habit.unit}</div>
      <input id="quantitative-value" name="quantitativeValue" autoFocus type="number" value={val} onChange={e => setVal(e.target.value)}
        className="focus-ring mono"
        style={{ width: "100%", fontSize: 30, fontWeight: 700, background: COLORS.surface2, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: "14px 16px", color: COLORS.text, marginBottom: 10 }} />
      <div style={{ fontSize: 12, color: COLORS.textFaint, marginBottom: 18 }} className="mono">
        {val || 0} / {habit.targetValue} {habit.unit} · {Math.min(100, Math.round((Number(val || 0) / habit.targetValue) * 100))}%
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" onClick={save}>Save</Btn>
      </div>
    </ModalShell>
  );
}

function BinaryEditModal({
  habit,
  date,
  onClose,
}) {
  const app = useApp();

  const rec =
    findRecord(
      app.state.records,
      habit.id,
      date
    );

  const [status, setStatus] =
    useState(
      rec?.status || "untracked"
    );

  function save() {
    app.setRecord(
      habit.id,
      date,
      {
        status,
      }
    );

    onClose();
  }

  return (
    <ModalShell onClose={onClose}>

      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 0.8,
          color: COLORS.textFaint,
          marginBottom: 4,
        }}
      >
        EDIT TODAY'S RECORD
      </div>

      <div
        style={{
          fontSize: 16,
          fontWeight: 800,
          marginBottom: 18,
        }}
      >
        {habit.name}
      </div>

      <FieldLabel>
        Status
      </FieldLabel>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >

        <ToggleChip
          active={
            status === "completed"
          }
          onClick={() =>
            setStatus("completed")
          }
        >
          ✓ Completed
        </ToggleChip>

        <ToggleChip
          active={
            status === "missed"
          }
          onClick={() =>
            setStatus("missed")
          }
        >
          ✕ Missed
        </ToggleChip>

        <ToggleChip
          active={
            status === "untracked"
          }
          onClick={() =>
            setStatus("untracked")
          }
        >
          · Untracked
        </ToggleChip>

      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: 8,
          marginTop: 20,
        }}
      >
        <Btn onClick={onClose}>
          Cancel
        </Btn>

        <Btn
          variant="primary"
          onClick={save}
        >
          Save
        </Btn>
      </div>

    </ModalShell>
  );
}

function ModalShell({ children, onClose, wide }) {
  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", display: "flex", alignItems: "center",
      justifyContent: "center", zIndex: 100, padding: 16,
    }}>
      <div onClick={e => e.stopPropagation()} className="card-anim" style={{
        background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 14,
        padding: 24, width: "100%", maxWidth: wide ? 560 : 380, maxHeight: "85vh", overflow: "auto",
      }}>
        {children}
      </div>
    </div>
  );
}

/* ============================================================================
   HABIT MATRIX VIEW
============================================================================ */
function HabitMatrixView() {
  const app = useApp();
  const { state, today } = app;

  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editHabit, setEditHabit] = useState(null);
  const [quantEdit, setQuantEdit] = useState(null);

  // 0 = current week
  // -1 = previous week
  // +1 = next week
  const [weekOffset, setWeekOffset] = useState(0);

  const habits = state.habits.filter(
    h => showArchived ? h.archived : !h.archived
  );

  // Find the Monday of the current week.
  const currentWeekStart = useMemo(() => {
    const d = fromDateStr(today);
    const day = d.getDay(); // Sunday = 0, Monday = 1
    const daysFromMonday = day === 0 ? 6 : day - 1;

    d.setDate(d.getDate() - daysFromMonday);

    return toDateStr(d);
  }, [today]);

  // Generate exactly 7 days for the selected week.
  const dates = useMemo(() => {
    const start = addDays(currentWeekStart, weekOffset * 7);

    return Array.from({ length: 7 }, (_, i) =>
      addDays(start, i)
    );
  }, [currentWeekStart, weekOffset]);

  const weekStart = dates[0];
  const weekEnd = dates[6];

  const isCurrentWeek = weekOffset === 0;

  // Prevent moving into a future week.
  const canGoNext = !isCurrentWeek;

  const weekLabel = `${shortDate(weekStart)} — ${shortDate(weekEnd)}`;

  return (
    <div>
      {/* HEADER */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 10,
        }}
      >
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 800, marginBottom: 3 }}>
            Habits
          </h1>

          <div
            className="mono"
            style={{
              color: COLORS.textFaint,
              fontSize: 11,
            }}
          >
            {weekLabel}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            gap: 6,
            alignItems: "center",
          }}
        >
          {/* PREVIOUS WEEK */}
          <Btn
            onClick={() => setWeekOffset(w => w - 1)}
          >
            ←
          </Btn>

          {/* TODAY */}
          <Btn
            variant={isCurrentWeek ? "primary" : "ghost"}
            onClick={() => setWeekOffset(0)}
          >
            TODAY
          </Btn>

          {/* NEXT WEEK */}
          <Btn
            onClick={() => {
              if (canGoNext) {
                setWeekOffset(w => w + 1);
              }
            }}
            disabled={!canGoNext}
          >
            →
          </Btn>

          <Btn
            onClick={() => setShowArchived(s => !s)}
            icon={showArchived ? ArchiveRestore : Archive}
          >
            {showArchived ? "Active" : "Archived"}
          </Btn>

          <Btn
            variant="primary"
            icon={Plus}
            onClick={() => setCreating(true)}
          >
            Add Habit
          </Btn>
        </div>
      </div>

      {/* HABIT MATRIX */}
      {habits.length === 0 ? (
        <div style={{ marginTop: 16 }}>
          <EmptyState
            title={
              showArchived
                ? "NO ARCHIVED HABITS"
                : "BUILD YOUR SYSTEM"
            }
            body={
              showArchived
                ? "Habits you archive will appear here."
                : "You don't have any habits yet. Start with one habit. Build consistency. Build momentum."
            }
            cta={showArchived ? undefined : "Create First Habit"}
            onCta={() => setCreating(true)}
          />
        </div>
      ) : (
        <div
  className="habit-matrix-wrapper"
  style={{
    marginTop: 16,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 10,
    overflowX: "auto",
    overflowY: "hidden",
    WebkitOverflowScrolling: "touch",
    background: COLORS.surface,
    width: "100%",
    maxWidth: "100%",
  }}
>
  <table
  style={{
    borderCollapse: "separate",
    borderSpacing: 0,
    width: "max-content",
    minWidth: "100%",
    tableLayout: "fixed",
  }}
>

            <thead>
              <tr>
                {/* HABIT */}
                <th
                  style={{
                    ...thStyle,
                    position: "sticky",
                    left: 0,
                    background: COLORS.surface,
                    zIndex: 3,
                    minWidth: 190,
                    width: 190,
                    textAlign: "left",
                  }}
                >
                  HABIT
                </th>

                {/* WEIGHT */}
                <th
                  style={{
                    ...thStyle,
                    minWidth: 46,
                    width: 46,
                  }}
                >
                  WT
                </th>

                {/* 7 DAYS */}
                {dates.map(d => {
                  const date = fromDateStr(d);
                  const isToday = d === today;
                  const isFuture = d > today;

                  return (
                    <th
                      key={d}
                      style={{
                        ...thStyle,
                        minWidth: 58,
                        background: isToday
                          ? `${COLORS.emerald}18`
                          : isFuture
                            ? `${COLORS.slate}08`
                            : undefined,
                        color: isToday
                          ? COLORS.emerald
                          : undefined,
                      }}
                    >
                      <div
                        style={{
                          fontSize: 9,
                          marginBottom: 3,
                          textTransform: "uppercase",
                        }}
                      >
                        {date.toLocaleDateString("en-US", {
                          weekday: "short",
                        })}
                      </div>

                      <div
                        className="mono"
                        style={{
                          fontSize: 11,
                          fontWeight: isToday ? 800 : 600,
                        }}
                      >
                        {date.getDate()}
                      </div>

                      {isToday && (
                        <div
                          style={{
                            fontSize: 7,
                            marginTop: 2,
                            color: COLORS.emerald,
                            letterSpacing: 0.5,
                          }}
                        >
                          TODAY
                        </div>
                      )}
                    </th>
                  );
                })}

                {/* SCORE */}
                <th
                  style={{
                    ...thStyle,
                    minWidth: 70,
                    width: 70,
                    position: "sticky",
                    right: 0,
                    background: COLORS.surface,
                  }}
                >
                  SCORE
                </th>
              </tr>
            </thead>

            <tbody>
              {habits.map(h => {
                const c = habitConsistency(
                  h,
                  state.records,
                  weekStart,
                  today,
                  today
                );

                return (
                  <tr key={h.id}>
                    {/* HABIT NAME */}
                    <td
                      style={{
                        ...tdStyle,
                        position: "sticky",
                        left: 0,
                        background: COLORS.surface,
                        zIndex: 2,
                        textAlign: "left",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          cursor: "pointer",
                        }}
                        onClick={() => setEditHabit(h)}
                      >
                        <span
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: "50%",
                            background: catColor(h.category),
                            flexShrink: 0,
                          }}
                        />

                        <span
                          style={{
                            fontWeight: 600,
                            fontSize: 12.5,
                          }}
                        >
                          {h.name}
                        </span>

                        <Pencil
                          size={11}
                          color={COLORS.textFaint}
                        />
                      </div>
                    </td>

                    {/* WEIGHT */}
                    <td
                      style={{ ...tdStyle }}
                      className="mono"
                    >
                      {h.weight.toFixed(1)}
                    </td>

                    {/* DAYS */}
                    {dates.map(d => (
                      <MatrixCell
                        key={d}
                        habit={h}
                        date={d}
                        onQuant={() =>
                          setQuantEdit({
                            habit: h,
                            date: d,
                          })
                        }
                      />
                    ))}

                    {/* SCORE */}
                    <td
                      style={{
                        ...tdStyle,
                        position: "sticky",
                        right: 0,
                        background: COLORS.surface,
                      }}
                      className="mono"
                    >
                      <span
                        style={{
                          color:
                            c === null
                              ? COLORS.textFaint
                              : c >= 80
                                ? COLORS.emerald
                                : c >= 60
                                  ? COLORS.amber
                                  : COLORS.crimson,
                          fontWeight: 700,
                        }}
                      >
                        {c === null
                          ? "—"
                          : `${c.toFixed(0)}%`}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <HabitEditor
          onClose={() => setCreating(false)}
        />
      )}

      {editHabit && (
        <HabitEditor
          habit={editHabit}
          onClose={() => setEditHabit(null)}
        />
      )}

      {quantEdit && (
        <QuantModal
          habit={quantEdit.habit}
          date={quantEdit.date}
          onClose={() => setQuantEdit(null)}
        />
      )}
    </div>
  );
}

const thStyle = { padding: "10px 8px", fontSize: 9.5, letterSpacing: 0.6, color: COLORS.textFaint, fontWeight: 700, borderBottom: `1px solid ${COLORS.border}`, textAlign: "center" };
const tdStyle = { padding: "8px", borderBottom: `1px solid ${COLORS.border}`, fontSize: 12.5, textAlign: "center" };
const selectStyle = { background: COLORS.surface2, border: `1px solid ${COLORS.border}`, color: COLORS.text, borderRadius: 7, padding: "8px 10px", fontSize: 12.5 };

function catColor(cat) {
  const map = { Fitness: COLORS.emerald, Health: "#38BDF8", Productivity: COLORS.amber, Discipline: "#A78BFA", Mind: "#F472B6" };
  return map[cat] || COLORS.slate;
}

function MatrixCell({ habit, date, onQuant }) {
  const app = useApp();
  const { state, today } = app;
  const rec = findRecord(state.records, habit.id, date);
  const ev = dayEval(habit, rec, date, today);
  const isToday = date === today;

  let content, color, title;
  if (ev.status === "future") { content = ""; color = COLORS.textFaint; title = "Future"; }
  else if (ev.status === "off_schedule") { content = ""; color = COLORS.textFaint; title = "Not scheduled"; }
  else if (ev.status === "off_day") { content = "OFF"; color = COLORS.slate; title = "Rest day"; }
  else if (ev.graced) { content = "G"; color = COLORS.amber; title = `Grace protected${rec?.reason ? ": " + rec.reason : ""}`; }
  else if (habit.type === "binary") {
    if (ev.status === "completed") { content = <Check size={13} />; color = COLORS.emerald; title = "Completed"; }
    else if (ev.status === "missed" || ev.status === "missed_untracked") { content = <X size={13} />; color = COLORS.crimson; title = "Missed"; }
    else { content = "·"; color = COLORS.textFaint; title = "Untracked"; }
  } else {
    if (ev.score !== null && ev.score !== undefined) {
      content = `${Math.round(ev.score * 100)}`;
      color = ev.score >= 1 ? COLORS.emerald : ev.score > 0 ? COLORS.amber : COLORS.crimson;
      title = `${rec?.loggedValue ?? 0}/${habit.targetValue}${habit.unit || ""}`;
    } else { content = "·"; color = COLORS.textFaint; title = "Untracked"; }
  }

  function handleClick(e) {
    if (ev.status === "future" || ev.status === "off_schedule") return;
    if (e.shiftKey) { app.toggleOffDay(habit.id, date); return; }
    if (habit.type === "quantitative") onQuant();
    else app.cycleBinary(habit.id, date);
  }

  return (
    <td
      onClick={handleClick}
      title={title}
      style={{
        ...tdStyle, cursor: (ev.status === "future" || ev.status === "off_schedule") ? "default" : "pointer",
        background: isToday ? `${COLORS.emerald}0d` : undefined, color, fontWeight: 700, userSelect: "none",
      }}
      className="mono"
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>{content}</div>
    </td>
  );
}

function HabitEditor({ habit, onClose }) {
  const app = useApp();
  const isNew = !habit;
  const [name, setName] = useState(habit?.name || "");
  const [category, setCategory] = useState(habit?.category || "Fitness");
  const [type, setType] = useState(habit?.type || "binary");
  const [target, setTarget] = useState(habit?.targetValue || 1);
  const [unit, setUnit] = useState(habit?.unit || "reps");
  const [weight, setWeight] = useState(habit?.weight ?? 2);
  const [freq, setFreq] = useState(habit?.frequency || [0,1,2,3,4,5,6]);
  const [reminderEnabled, setReminderEnabled] = useState(habit?.reminderEnabled || false);
  const [reminderTime, setReminderTime] = useState(habit?.reminderTime || "19:00");
  const [error, setError] = useState("");

  function save() {
    if (!name.trim()) { setError("Name is required"); return; }
    if (weight < 1 || weight > 3) { setError("Weight must be between 1.0 and 3.0"); return; }
    if (freq.length === 0) { setError("Select at least one scheduled day"); return; }
    const dup = app.state.habits.some(h => h.id !== habit?.id && !h.archived && h.name.trim().toLowerCase() === name.trim().toLowerCase());
    if (dup) { setError("A habit with this name already exists"); return; }

    const payload = {
      name: name.trim(), category, type, weight: Number(weight), frequency: freq,
      targetValue: type === "quantitative" ? Number(target) : undefined,
      unit: type === "quantitative" ? unit : undefined,
      reminderEnabled, reminderTime,
    };
    if (isNew) app.addHabit(payload);
    else app.updateHabit(habit.id, payload);
    onClose();
  }

  return (
    <ModalShell onClose={onClose} wide>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
        <div style={{ fontSize: 15, fontWeight: 800 }}>{isNew ? "ADD HABIT" : "EDIT HABIT"}</div>
        {!isNew && (
          <div style={{ display: "flex", gap: 6 }}>
            {!habit.archived ? (
              <Btn variant="ghost" icon={Archive} onClick={() => { app.archiveHabit(habit.id); onClose(); }}>Archive</Btn>
            ) : (
              <Btn variant="ghost" icon={ArchiveRestore} onClick={() => { app.restoreHabit(habit.id); onClose(); }}>Restore</Btn>
            )}
          </div>
        )}
      </div>

      <div style={{ display: "grid", gap: 14 }}>
        <TextField label="Name" value={name} onChange={setName} placeholder="Workout" />

        <div>
          <FieldLabel>Category</FieldLabel>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {CATEGORIES.map(c => <ToggleChip key={c} active={category === c} onClick={() => setCategory(c)}>{c}</ToggleChip>)}
          </div>
        </div>

        <div>
          <FieldLabel>Type</FieldLabel>
          <div style={{ display: "flex", gap: 8 }}>
            <ToggleChip active={type === "binary"} onClick={() => setType("binary")}>Binary</ToggleChip>
            <ToggleChip active={type === "quantitative"} onClick={() => setType("quantitative")}>Quantitative</ToggleChip>
          </div>
        </div>

        {type === "quantitative" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <TextField label="Target" type="number" value={target} onChange={setTarget} />
            <TextField label="Unit" value={unit} onChange={setUnit} placeholder="ml, min, km, pages…" />
          </div>
        )}

        <div>
          <FieldLabel>Schedule</FieldLabel>
          <WeekdayPicker value={freq} onChange={setFreq} />
        </div>

        <TextField label="Weight (1.0 – 3.0, importance)" type="number" value={weight} onChange={setWeight} />

        <div
  style={{
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  }}
>
  <FieldLabel>Reminder</FieldLabel>

  <label
    style={{
      display: "flex",
      alignItems: "center",
      gap: 8,
      fontSize: 12.5,
      color: COLORS.textDim,
    }}
  >
    <input
      id="reminder-enabled"
      name="reminderEnabled"
      type="checkbox"
      checked={reminderEnabled}
      onChange={async e => {
        const enabled = e.target.checked;

        if (enabled) {
          const permission =
            await requestNotificationPermission();

          if (permission !== "granted") {
            setReminderEnabled(false);

            setError(
              permission === "denied"
                ? "Browser notifications are blocked. Allow them in browser settings."
                : "Notifications are not supported by this browser."
            );

            return;
          }

          setError("");
        }

        setReminderEnabled(enabled);
      }}
    />

    Enable
  </label>
</div>

        {reminderEnabled && (
  <TextField
    label="Reminder Time"
    type="time"
    value={reminderTime}
    onChange={setReminderTime}
    name="reminderTime"
  />
)}

        {error && (
          <div
            style={{
              color: COLORS.crimson,
              fontSize: 12,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <AlertCircle size={13} />
            {error}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
          {!isNew ? (
            <Btn variant="danger" icon={Trash2} onClick={() => { if (confirm("Permanently delete this habit and all its records? This cannot be undone.")) { app.deleteHabit(habit.id); onClose(); } }}>Delete</Btn>
          ) : <span />}
          <div style={{ display: "flex", gap: 8 }}>
            <Btn onClick={onClose}>Cancel</Btn>
            <Btn variant="primary" onClick={save}>{isNew ? "Create Habit" : "Save Changes"}</Btn>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

/* ============================================================================
   ANALYTICS VIEW
============================================================================ */

function AnalyticsView() {
  const { state, today } = useApp();

  const activeHabits = state.habits.filter(
    h => !h.archived
  );

  const monthKey = getMonthKey(today);
  const monthStart = monthKey + "-01";

  const previousMonth = prevMonthKey(monthKey);
  const previousStart =
    previousMonth + "-01";
  const previousEnd =
    previousMonth +
    "-" +
    pad2(daysInMonth(previousMonth));

  if (!activeHabits.length) {
    return (
      <EmptyState
        title="NO DATA YET"
        body="Add habits and start tracking to unlock your performance intelligence."
      />
    );
  }

  /* ============================================================
     CURRENT PERFORMANCE
  ============================================================ */

  const score = overallScore(
    activeHabits,
    state.records,
    monthStart,
    today,
    today
  );

  const previousScore = overallScore(
    activeHabits,
    state.records,
    previousStart,
    previousEnd,
    today
  );

  const level = performanceLevel(score);

  /* ============================================================
     STREAKS
  ============================================================ */

  const overallStreakData =
    overallStreak(
      activeHabits,
      state.records,
      today,
      state.settings.streakThreshold
    );

  const bestHabitStreak =
    getBestHabitStreak(
      activeHabits,
      state.records,
      today
    );

  /* ============================================================
     BEST / WORST HABIT
  ============================================================ */

  const bestHabit = getBestHabit(
    activeHabits,
    state.records,
    monthStart,
    today,
    today
  );

  const weakestHabit = getWeakestHabit(
    activeHabits,
    state.records,
    monthStart,
    today,
    today
  );

  /* ============================================================
     BEST / WORST DAY
  ============================================================ */

  const dayPerformance =
    getBestWorstDay(
      activeHabits,
      state.records,
      monthStart,
      today,
      today
    );

  /* ============================================================
     HISTORICAL RECORDS
  ============================================================ */

  const historical =
    getHistoricalPerformance(
      state,
      today
    );

  const previousBest =
    historical.bestScore !== null &&
    score !== null &&
    historical.bestMonth &&
    historical.bestMonth.monthKey !== monthKey
      ? historical.bestScore
      : null;

  const insight =
    getPerformanceInsight({
      score,
      previousScore,
      bestHabit,
      historicalBest: previousBest,
    });

  /* ============================================================
     DAILY TREND
  ============================================================ */

  const trendDays = 14;

  const trend = Array.from(
    { length: trendDays },
    (_, i) => {
      const d = addDays(
        today,
        -(trendDays - 1 - i)
      );

      return {
        date: d,
        score: dailyWeightedScore(
          activeHabits,
          state.records,
          d,
          today
        ),
      };
    }
  );

  /* ============================================================
     HABIT PERFORMANCE
  ============================================================ */

  const habitPerformance =
    activeHabits
      .map(h => ({
        habit: h,
        score: habitConsistency(
          h,
          state.records,
          monthStart,
          today,
          today
        ),
        streak: habitStreak(
          h,
          state.records,
          today
        ),
      }))
      .filter(
        x => x.score !== null
      )
      .sort(
        (a, b) =>
          b.score - a.score
      );

  /* ============================================================
     CATEGORY PERFORMANCE
  ============================================================ */

  const categories =
    categoryBreakdown(
      activeHabits,
      state.records,
      monthStart,
      today,
      today
    );

  /* ============================================================
     TRACKING DAYS
  ============================================================ */

  const elapsedDays =
    Number(today.slice(8, 10));

  const trackedDays =
    Array.from(
      { length: elapsedDays },
      (_, i) =>
        `${monthKey}-${pad2(i + 1)}`
    ).filter(date =>
      state.records.some(
        r =>
          r.date === date &&
          r.status !== "untracked"
      )
    ).length;

  const trackingPercent =
    elapsedDays
      ? (trackedDays / elapsedDays) * 100
      : 0;

  /* ============================================================
     UI
  ============================================================ */

  return (
    <div>

      {/* ======================================================
          HEADER
      ====================================================== */}

      <h1
        style={{
          fontSize: 20,
          fontWeight: 800,
          marginBottom: 4,
        }}
      >
        Analytics
      </h1>

      <div
        style={{
          color: COLORS.textFaint,
          fontSize: 12.5,
        }}
      >
        {monthLabel(monthKey)}
        {" · "}
        Personal performance intelligence
      </div>


      {/* ======================================================
          PERFORMANCE OVERVIEW
      ====================================================== */}

      <div
        style={{
          display: "grid",
          gridTemplateColumns:
            "repeat(auto-fit,minmax(160px,1fr))",
          gap: 12,
          marginTop: 20,
        }}
      >

        <StatCard
          label="OVERALL SCORE"
          value={
            score !== null
              ? `${score.toFixed(1)}%`
              : "—"
          }
          sub={level.label}
          accent={level.color}
          icon={Trophy}
        />

        <StatCard
          label="CURRENT STREAK"
          value={
            overallStreakData.current
              ? `🔥 ${overallStreakData.current}`
              : "0"
          }
          sub={`Best overall: ${overallStreakData.best} days`}
          accent={COLORS.amber}
          icon={Flame}
        />

        <StatCard
          label="DAYS TRACKED"
          value={`${trackedDays} / ${elapsedDays}`}
          sub={`${trackingPercent.toFixed(0)}% of elapsed days`}
          icon={CalendarIcon}
        />

        <StatCard
          label="MONTHLY CHANGE"
          value={
            previousScore !== null &&
            score !== null
              ? `${score >= previousScore ? "+" : ""}${(
                  score - previousScore
                ).toFixed(1)}%`
              : "—"
          }
          sub={
            previousScore === null
              ? "No previous data"
              : score >= previousScore
                ? "Improving ↑"
                : "Declining ↓"
          }
          accent={
            previousScore !== null &&
            score !== null &&
            score >= previousScore
              ? COLORS.emerald
              : COLORS.crimson
          }
          icon={
            previousScore !== null &&
            score !== null &&
            score >= previousScore
              ? TrendingUp
              : TrendingDown
          }
        />

      </div>


      {/* ======================================================
          PERFORMANCE INTELLIGENCE
      ====================================================== */}

      <SectionTitle>
        Performance Intelligence
      </SectionTitle>

      <Card
        style={{
          borderColor:
            `${insight.color}55`,
          background:
            `${insight.color}08`,
        }}
      >

        <div
          style={{
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: 0.8,
            color: insight.color,
            marginBottom: 7,
          }}
        >
          {insight.title}
        </div>

        <div
          style={{
            fontSize: 13,
            lineHeight: 1.7,
            color: COLORS.text,
          }}
        >
          {insight.text}
        </div>

      </Card>


      {/* ======================================================
          PERSONAL RECORDS
      ====================================================== */}

      <SectionTitle>
        Personal Records
      </SectionTitle>

      <div
        style={{
          display: "grid",
          gridTemplateColumns:
            "repeat(auto-fit,minmax(180px,1fr))",
          gap: 12,
        }}
      >

        <Card>

          <div
            style={{
              color: COLORS.textFaint,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: 0.7,
            }}
          >
            BEST HABIT
          </div>

          <div
            style={{
              fontSize: 16,
              fontWeight: 800,
              marginTop: 8,
            }}
          >
            {bestHabit
              ? bestHabit.habit.name
              : "—"}
          </div>

          {bestHabit && (
            <div
              className="mono"
              style={{
                marginTop: 5,
                color: COLORS.emerald,
                fontWeight: 800,
              }}
            >
              {bestHabit.score.toFixed(0)}%
            </div>
          )}

        </Card>


        <Card>

          <div
            style={{
              color: COLORS.textFaint,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: 0.7,
            }}
          >
            WEAKEST HABIT
          </div>

          <div
            style={{
              fontSize: 16,
              fontWeight: 800,
              marginTop: 8,
            }}
          >
            {weakestHabit
              ? weakestHabit.habit.name
              : "—"}
          </div>

          {weakestHabit && (
            <div
              className="mono"
              style={{
                marginTop: 5,
                color:
                  performanceLevel(
                    weakestHabit.score
                  ).color,
                fontWeight: 800,
              }}
            >
              {weakestHabit.score.toFixed(0)}%
            </div>
          )}

        </Card>


        <Card>

          <div
            style={{
              color: COLORS.textFaint,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: 0.7,
            }}
          >
            BEST HABIT STREAK
          </div>

          <div
            style={{
              fontSize: 16,
              fontWeight: 800,
              marginTop: 8,
            }}
          >
            {bestHabitStreak
              ? bestHabitStreak.habit.name
              : "—"}
          </div>

          {bestHabitStreak && (
            <div
              className="mono"
              style={{
                marginTop: 5,
                color: COLORS.amber,
                fontWeight: 800,
              }}
            >
              🔥 {bestHabitStreak.streak.best} days
            </div>
          )}

        </Card>


        <Card>

          <div
            style={{
              color: COLORS.textFaint,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: 0.7,
            }}
          >
            BEST MONTH
          </div>

          <div
            style={{
              fontSize: 16,
              fontWeight: 800,
              marginTop: 8,
            }}
          >
            {historical.bestMonth
              ? monthLabel(
                  historical.bestMonth.monthKey
                )
              : "—"}
          </div>

          {historical.bestScore !== null && (
            <div
              className="mono"
              style={{
                marginTop: 5,
                color: COLORS.emerald,
                fontWeight: 800,
              }}
            >
              {historical.bestScore.toFixed(1)}%
            </div>
          )}

        </Card>

      </div>


      {/* ======================================================
          BEST / WORST DAYS
      ====================================================== */}

      <SectionTitle>
        Your Best & Worst Days
      </SectionTitle>

      <div
        style={{
          display: "grid",
          gridTemplateColumns:
            "repeat(auto-fit,minmax(220px,1fr))",
          gap: 12,
        }}
      >

        <Card>

          <div
            style={{
              color: COLORS.emerald,
              fontSize: 10,
              fontWeight: 800,
              letterSpacing: 0.7,
            }}
          >
            🏆 BEST DAY
          </div>

          <div
            style={{
              fontSize: 16,
              fontWeight: 800,
              marginTop: 8,
            }}
          >
            {dayPerformance.best
              ? niceDate(
                  dayPerformance.best.date
                )
              : "Not enough data"}
          </div>

          {dayPerformance.best && (
            <div
              className="mono"
              style={{
                marginTop: 5,
                color: COLORS.emerald,
                fontWeight: 800,
              }}
            >
              {dayPerformance.best.score.toFixed(0)}%
            </div>
          )}

        </Card>


        <Card>

          <div
            style={{
              color: COLORS.crimson,
              fontSize: 10,
              fontWeight: 800,
              letterSpacing: 0.7,
            }}
          >
            ⚠ WORST DAY
          </div>

          <div
            style={{
              fontSize: 16,
              fontWeight: 800,
              marginTop: 8,
            }}
          >
            {dayPerformance.worst
              ? niceDate(
                  dayPerformance.worst.date
                )
              : "Not enough data"}
          </div>

          {dayPerformance.worst && (
            <div
              className="mono"
              style={{
                marginTop: 5,
                color: COLORS.crimson,
                fontWeight: 800,
              }}
            >
              {dayPerformance.worst.score.toFixed(0)}%
            </div>
          )}

        </Card>

      </div>


      {/* ======================================================
          HABIT PERFORMANCE
      ====================================================== */}

      <SectionTitle>
        Habit Performance
      </SectionTitle>

      <Card>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 18,
          }}
        >

          {habitPerformance.map(
            ({ habit, score: habitScore, streak }) => {

              const habitLevel =
                performanceLevel(
                  habitScore
                );

              return (
                <div key={habit.id}>

                  <div
                    style={{
                      display: "flex",
                      justifyContent:
                        "space-between",
                      alignItems:
                        "center",
                      marginBottom: 7,
                    }}
                  >

                    <div>

                      <div
                        style={{
                          fontSize: 12.5,
                          fontWeight: 650,
                        }}
                      >
                        {habit.name}
                      </div>

                      <div
                        style={{
                          fontSize: 10,
                          color:
                            COLORS.textFaint,
                          marginTop: 2,
                        }}
                      >
                        🔥 {streak.current} day
                        current streak
                      </div>

                    </div>


                    <div
                      style={{
                        textAlign: "right",
                      }}
                    >

                      <div
                        className="mono"
                        style={{
                          fontSize: 13,
                          fontWeight: 800,
                        }}
                      >
                        {habitScore.toFixed(0)}%
                      </div>

                      <div
                        style={{
                          fontSize: 9,
                          color:
                            habitLevel.color,
                          fontWeight: 700,
                        }}
                      >
                        {habitLevel.label}
                      </div>

                    </div>

                  </div>


                  <Bar
                    pct={habitScore}
                    color={habitLevel.color}
                  />

                </div>
              );
            }
          )}

        </div>

      </Card>


      {/* ======================================================
          CATEGORY PERFORMANCE
      ====================================================== */}

      <SectionTitle>
        Category Breakdown
      </SectionTitle>

      <Card>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 16,
          }}
        >

          {categories.map(
            category => (

              <div
                key={category.category}
              >

                <div
                  style={{
                    display: "flex",
                    justifyContent:
                      "space-between",
                    marginBottom: 6,
                  }}
                >

                  <span
                    style={{
                      display: "flex",
                      alignItems:
                        "center",
                      gap: 7,
                      fontSize: 12.5,
                      fontWeight: 650,
                    }}
                  >

                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius:
                          "50%",
                        background:
                          catColor(
                            category.category
                          ),
                      }}
                    />

                    {category.category}

                  </span>


                  <span
                    className="mono"
                    style={{
                      fontWeight: 800,
                    }}
                  >
                    {category.score.toFixed(0)}%
                  </span>

                </div>


                <Bar
                  pct={category.score}
                  color={catColor(
                    category.category
                  )}
                />

              </div>

            )
          )}

        </div>

      </Card>


      {/* ======================================================
          PERFORMANCE TREND
      ====================================================== */}

      <SectionTitle>
        14-Day Performance Trend
      </SectionTitle>

      <Card>

        <svg
          viewBox="0 0 700 210"
          style={{
            width: "100%",
            height: 200,
          }}
          preserveAspectRatio="none"
        >

          {[0, 25, 50, 75, 100].map(
            g => (
              <line
                key={g}
                x1="0"
                x2="700"
                y1={200 - g * 1.8}
                y2={200 - g * 1.8}
                stroke={COLORS.border}
                strokeWidth="1"
              />
            )
          )}

          {(() => {
            const pts =
              trend.map(
                (t, i) => {

                  const x =
                    (i /
                      (trend.length - 1)) *
                      680 +
                    10;

                  const y =
                    t.score === null
                      ? null
                      : 200 -
                        t.score * 1.8;

                  return {
                    ...t,
                    x,
                    y,
                  };
                }
              );

            const valid =
              pts.filter(
                p =>
                  p.y !== null
              );

            const path =
              valid
                .map(
                  (p, i) =>
                    `${
                      i === 0
                        ? "M"
                        : "L"
                    } ${p.x} ${p.y}`
                )
                .join(" ");

            return (
              <>
                {valid.length > 0 && (
                  <path
                    d={path}
                    fill="none"
                    stroke={
                      COLORS.emerald
                    }
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                )}

                {valid.map(
                  (p, i) => (
                    <circle
                      key={i}
                      cx={p.x}
                      cy={p.y}
                      r="4"
                      fill={
                        COLORS.emerald
                      }
                    >
                      <title>
                        {niceDate(
                          p.date
                        )}
                        {" — "}
                        {p.score.toFixed(
                          0
                        )}
                        %
                      </title>
                    </circle>
                  )
                )}
              </>
            );

          })()}

        </svg>

        <div
          style={{
            display: "flex",
            justifyContent:
              "space-between",
            fontSize: 10,
            color:
              COLORS.textFaint,
          }}
          className="mono"
        >
          <span>
            {shortDate(
              trend[0].date
            )}
          </span>

          <span>
            {shortDate(
              trend[
                trend.length - 1
              ].date
            )}
          </span>

        </div>

      </Card>


      {/* ======================================================
          SCORE EXPLANATION
      ====================================================== */}

      <Card
        style={{
          marginTop: 16,
          background:
            COLORS.surface2,
        }}
      >

        <div
          style={{
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: 0.7,
            marginBottom: 8,
          }}
        >
          HOW HABIT OS READS YOUR PERFORMANCE
        </div>

        <div
          style={{
            color:
              COLORS.textDim,
            fontSize: 12,
            lineHeight: 1.7,
          }}
        >
          Your overall performance combines
          consistency across your active habits.
          Higher-priority habits have more influence
          on the final score. Scheduled off-days are
          not treated as failures.
        </div>

      </Card>

    </div>
  );
}
/* ============================================================================
   PHASE 2 — PERSONAL PERFORMANCE INTELLIGENCE
============================================================================ */

function getMonthlyPerformance(state, monthKey, today) {
  const habits = state.habits.filter(h => !h.archived);

  if (!habits.length) return null;

  const start = monthKey + "-01";
  const endDate = monthKey + "-" + pad2(daysInMonth(monthKey));
  const end = endDate > today ? today : endDate;

  if (start > today) return null;

  return overallScore(
    habits,
    state.records,
    start,
    end,
    today
  );
}


function getBestWorstDay(habits, records, fromDate, toDate, today) {
  const days = [];

  let d = fromDate;

  while (d <= toDate && d <= today) {
    const score = dailyWeightedScore(
      habits,
      records,
      d,
      today
    );

    if (score !== null) {
      days.push({
        date: d,
        score,
      });
    }

    d = addDays(d, 1);
  }

  if (!days.length) {
    return {
      best: null,
      worst: null,
    };
  }

  const sorted = [...days].sort(
    (a, b) => b.score - a.score
  );

  return {
    best: sorted[0],
    worst: sorted[sorted.length - 1],
  };
}


function getBestHabit(habits, records, fromDate, toDate, today) {
  return habits
    .map(h => ({
      habit: h,
      score: habitConsistency(
        h,
        records,
        fromDate,
        toDate,
        today
      ),
      streak: habitStreak(
        h,
        records,
        today
      ),
    }))
    .filter(x => x.score !== null)
    .sort((a, b) => b.score - a.score)[0] || null;
}


function getWeakestHabit(habits, records, fromDate, toDate, today) {
  return habits
    .map(h => ({
      habit: h,
      score: habitConsistency(
        h,
        records,
        fromDate,
        toDate,
        today
      ),
      streak: habitStreak(
        h,
        records,
        today
      ),
    }))
    .filter(x => x.score !== null)
    .sort((a, b) => a.score - b.score)[0] || null;
}


function getBestHabitStreak(habits, records, today) {
  return habits
    .map(h => ({
      habit: h,
      streak: habitStreak(
        h,
        records,
        today
      ),
    }))
    .sort(
      (a, b) =>
        b.streak.best - a.streak.best
    )[0] || null;
}


function getHistoricalPerformance(state, today) {
  const habits = state.habits.filter(
    h => !h.archived
  );

  if (!habits.length) {
    return {
      bestMonth: null,
      bestScore: null,
      average: null,
      monthsTracked: 0,
    };
  }

  const createdDates = habits
    .map(h => h.createdAt.slice(0, 10))
    .sort();

  const firstMonth =
    createdDates.length
      ? getMonthKey(createdDates[0])
      : getMonthKey(today);

  const currentMonth = getMonthKey(today);

  const months = [];

  let mk = firstMonth;

  while (mk <= currentMonth) {
    const score = getMonthlyPerformance(
      state,
      mk,
      today
    );

    if (score !== null) {
      months.push({
        monthKey: mk,
        score,
      });
    }

    mk = nextMonthKey(mk);
  }

  if (!months.length) {
    return {
      bestMonth: null,
      bestScore: null,
      average: null,
      monthsTracked: 0,
    };
  }

  const bestMonth = [...months].sort(
    (a, b) => b.score - a.score
  )[0];

  const average =
    months.reduce(
      (sum, m) => sum + m.score,
      0
    ) / months.length;

  return {
    bestMonth,
    bestScore: bestMonth.score,
    average,
    monthsTracked: months.length,
  };
}


function getPerformanceInsight({
  score,
  previousScore,
  bestHabit,
  historicalBest,
}) {

  if (score === null) {
    return {
      title: "KEEP TRACKING",
      text: "Complete more habits to unlock deeper performance insights.",
      color: COLORS.textDim,
    };
  }

  if (
    historicalBest !== null &&
    score > historicalBest
  ) {
    return {
      title: "🏆 NEW PERSONAL BEST",
      text: `You're performing at ${score.toFixed(1)}%, your strongest monthly performance yet.`,
      color: COLORS.emerald,
    };
  }

  if (
    previousScore !== null &&
    score > previousScore
  ) {
    return {
      title: "📈 YOU'RE IMPROVING",
      text: `You're ${(
        score - previousScore
      ).toFixed(1)}% ahead of last month.`,
      color: COLORS.emerald,
    };
  }

  if (
    previousScore !== null &&
    score < previousScore
  ) {
    return {
      title: "⚠ PERFORMANCE IS SLIPPING",
      text: `You're ${(
        previousScore - score
      ).toFixed(1)}% below last month. Focus on your weakest habit.`,
      color: COLORS.crimson,
    };
  }

  if (bestHabit) {
    return {
      title: "🔥 KEEP THE MOMENTUM",
      text: `${bestHabit.habit.name} is currently your strongest habit at ${bestHabit.score.toFixed(0)}%.`,
      color: COLORS.emerald,
    };
  }

  return {
    title: "STAY CONSISTENT",
    text: "Your next goal is simple: keep showing up.",
    color: COLORS.amber,
  };
}

/* ============================================================================
   PHASE 3 — MONTHLY ARCHIVE ENGINE
============================================================================ */

function getAllTrackedMonths(state, today) {
  const months = new Set();

  // Habit creation months
  state.habits.forEach(habit => {
    if (habit.createdAt) {
      const createdDate =
        habit.createdAt.slice(0, 10);

      if (createdDate <= today) {
        months.add(
          getMonthKey(createdDate)
        );
      }
    }
  });

  // Habit archive months
  state.habits.forEach(habit => {
    if (habit.archivedAt) {
      const archivedDate =
        habit.archivedAt.slice(0, 10);

      if (archivedDate <= today) {
        months.add(
          getMonthKey(archivedDate)
        );
      }
    }
  });

  // Actual tracked record months
  state.records.forEach(record => {
    if (
      record.date &&
      record.date <= today
    ) {
      months.add(
        getMonthKey(record.date)
      );
    }
  });

  return Array.from(months)
    .sort()
    .reverse();
}

function getArchiveStatistics(archive) {
  if (!archive.length) {
    return {
      bestMonth: null,
      worstMonth: null,
      average: null,
      totalMonths: 0,
    };
  }

  const completedMonths =
    archive.filter(
      month => month.isComplete
    );

  const average =
    archive.reduce(
      (sum, month) =>
        sum + month.score,
      0
    ) / archive.length;

  if (!completedMonths.length) {
    return {
      bestMonth: null,
      worstMonth: null,
      average,
      totalMonths: archive.length,
    };
  }

  const sorted = [...completedMonths].sort(
    (a, b) =>
      b.score - a.score
  );

  return {
    bestMonth: sorted[0],
    worstMonth:
      sorted[sorted.length - 1],
    average,
    totalMonths: archive.length,
  };
}
function buildMonthlyArchive(state, today) {
  const monthKeys = getAllTrackedMonths(state, today);

  return monthKeys
    .map(monthKey => {
      const start = `${monthKey}-01`;

      const monthEnd =
        `${monthKey}-${pad2(daysInMonth(monthKey))}`;

      const isCurrentMonth =
        monthKey === getMonthKey(today);

      const actualEnd =
        isCurrentMonth
          ? today
          : monthEnd;

      /*
       * Only include habits that existed during
       * this particular month.
       */
      const monthHabits = state.habits.filter(habit => {
        const createdDate = habit.createdAt
          ? habit.createdAt.slice(0, 10)
          : start;

        const archivedDate = habit.archivedAt
          ? habit.archivedAt.slice(0, 10)
          : null;

        // Habit didn't exist yet.
        if (createdDate > actualEnd) {
          return false;
        }

        // Habit was already archived before this month.
        if (
          archivedDate &&
          archivedDate < start
        ) {
          return false;
        }

        return true;
      });

      if (!monthHabits.length) {
        return null;
      }

      const score = overallScore(
        monthHabits,
        state.records,
        start,
        actualEnd,
        today
      );

      if (score === null) {
        return null;
      }

      /* --------------------------------------------------------
         HABIT RESULTS
      -------------------------------------------------------- */

      const habitResults = monthHabits
        .map(habit => ({
          habit,
          score: habitConsistency(
            habit,
            state.records,
            start,
            actualEnd,
            today
          ),
        }))
        .filter(
          result =>
            result.score !== null
        );

      const sortedHabits =
        [...habitResults].sort(
          (a, b) =>
            b.score - a.score
        );

      const bestHabit =
        sortedHabits[0] || null;

      const weakestHabit =
        sortedHabits[
          sortedHabits.length - 1
        ] || null;

      /* --------------------------------------------------------
         BEST / WORST DAY
      -------------------------------------------------------- */

      const dayResults =
        getBestWorstDay(
          monthHabits,
          state.records,
          start,
          actualEnd,
          today
        );

      /* --------------------------------------------------------
         COMPLETION COUNT
      -------------------------------------------------------- */

      const totalCompletions =
        state.records.filter(record =>
          record.date >= start &&
          record.date <= actualEnd &&
          record.status === "completed" &&
          monthHabits.some(
            habit =>
              habit.id === record.habitId
          )
        ).length;

      return {
        monthKey,
        label: monthLabel(monthKey),

        score,

        level:
          performanceLevel(score),

        isCurrentMonth,

        isComplete:
          !isCurrentMonth,

        bestHabit:
          bestHabit
            ? {
                id:
                  bestHabit.habit.id,
                name:
                  bestHabit.habit.name,
                score:
                  bestHabit.score,
              }
            : null,

        weakestHabit:
          weakestHabit
            ? {
                id:
                  weakestHabit.habit.id,
                name:
                  weakestHabit.habit.name,
                score:
                  weakestHabit.score,
              }
            : null,

        bestDay:
          dayResults.best,

        worstDay:
          dayResults.worst,

        totalCompletions,

        daysElapsed:
          Number(
            actualEnd.slice(8, 10)
          ),

        daysInMonth:
          daysInMonth(monthKey),
      };
    })
    .filter(Boolean);
}

/* ============================================================================
   HEATMAP VIEW (365-day contribution graph)
============================================================================ */
function HeatmapView() {
  const { state, today } = useApp();
  const activeHabits = state.habits.filter(h => !h.archived);
  const [hover, setHover] = useState(null);

  const dates = useMemo(() => {
    const end = fromDateStr(today);
    const start = new Date(end); start.setDate(start.getDate() - 370);
    while (start.getDay() !== 0) start.setDate(start.getDate() - 1);
    let cur = new Date(start);
    const days = [];
    while (cur <= end) { days.push(toDateStr(cur)); cur.setDate(cur.getDate() + 1); }
    return days;
  }, [today]);

  function scoreFor(d) {
    if (d > today) return null;
    return dailyWeightedScore(activeHabits, state.records, d, today);
  }
  function colorFor(s) {
    if (s === null) return COLORS.surface2;
    if (s >= 90) return COLORS.emerald;
    if (s >= 70) return "#34D399";
    if (s >= 40) return COLORS.amber;
    if (s > 0) return "#F97373";
    return COLORS.crimson;
  }

  if (activeHabits.length === 0) return <EmptyState title="NO DATA YET" body="Your 365-day performance heatmap will appear once you start tracking." />;

  return (
    <div>
      <h1 style={{ fontSize: 20, fontWeight: 800, marginBottom: 16 }}>365-Day Heatmap</h1>
      <Card style={{ width: "100%" }}>
        <div className="heatmap-grid" role="grid" aria-label="365-day performance heatmap">
          {dates.map(d => {
            const s = scoreFor(d);
            return (
              <div key={d}
                className="heatmap-cell"
                role="gridcell"
                onMouseEnter={() => setHover({ d, s })}
                onMouseLeave={() => setHover(h => (h && h.d === d ? null : h))}
                title={`${d}: ${s === null ? "no data" : s.toFixed(0) + "%"}`}
                style={{ background: colorFor(s), cursor: "pointer" }} />
            );
          })}
        </div>
      </Card>
      <div className="heatmap-legend" style={{ minHeight: 20, fontSize: 12.5, color: COLORS.textDim }}>
        {hover ? (
          <span className="mono">{niceDate(hover.d)} — {hover.s === null ? "no data" : `Score ${hover.s.toFixed(0)}%`}</span>
        ) : "Hover a square to inspect that day."}
        <div className="heatmap-scale" style={{ fontSize: 11, color: COLORS.textFaint }}>
          <span>Less</span>
          {[COLORS.surface2, COLORS.crimson, "#F97373", COLORS.amber, "#34D399", COLORS.emerald].map((c, i) => (
            <span key={i} className="heatmap-swatch" style={{ background: c }} />
          ))}
          <span>More</span>
        </div>
      </div>
    </div>
  );
}

/* ============================================================================
   HISTORY / MONTHLY ARCHIVE
============================================================================ */
function getPersonalRecords(archive) {
  const completedMonths =
    archive.filter(
      month => month.isComplete
    );

  if (!completedMonths.length) {
    return {
      bestMonth: null,
      currentMonthBest: null,
      biggestImprovement: null,
      biggestDrop: null,
    };
  }

  const bestMonth =
    [...completedMonths].sort(
      (a, b) =>
        b.score - a.score
    )[0];

  const currentMonth =
    archive.find(
      month => month.isCurrentMonth
    ) || null;

  let biggestImprovement = null;
  let biggestDrop = null;

  for (
    let i = 0;
    i < completedMonths.length - 1;
    i++
  ) {
    const current =
      completedMonths[i];

    const previous =
      completedMonths[i + 1];

    const difference =
      current.score -
      previous.score;

    const result = {
      month:
        current.monthKey,

      previousMonth:
        previous.monthKey,

      difference,
    };

    if (
      difference > 0 &&
      (
        !biggestImprovement ||
        difference >
          biggestImprovement.difference
      )
    ) {
      biggestImprovement =
        result;
    }

    if (
      difference < 0 &&
      (
        !biggestDrop ||
        difference <
          biggestDrop.difference
      )
    ) {
      biggestDrop =
        result;
    }
  }

  return {
    bestMonth,
    currentMonthBest:
      currentMonth,
    biggestImprovement,
    biggestDrop,
  };
}
function HistoryView() {
  const { state, today } = useApp();

  const archive =
    buildMonthlyArchive(
      state,
      today
    );

  const stats =
    getArchiveStatistics(
      archive
    );
    const records =
  getPersonalRecords(
    archive
  );

  if (!archive.length) {
    return (
      <EmptyState
        title="NO HISTORY YET"
        body="Start tracking your habits and your monthly performance will appear here."
      />
    );
  }

  return (
    <div>

      {/* HEADER */}

      <h1
        style={{
          fontSize: 20,
          fontWeight: 800,
          marginBottom: 4,
        }}
      >
        History
      </h1>

      <div
        style={{
          color: COLORS.textFaint,
          fontSize: 12.5,
        }}
      >
        Your complete performance record
      </div>


      {/* SUMMARY */}

      <div
        style={{
          display: "grid",
          gridTemplateColumns:
            "repeat(auto-fit,minmax(170px,1fr))",
          gap: 12,
          marginTop: 20,
        }}
      >

        <StatCard
          label="MONTHS TRACKED"
          value={stats.totalMonths}
          sub="Total recorded months"
          icon={CalendarIcon}
        />

        <StatCard
          label="ALL-TIME AVERAGE"
          value={
            `${stats.average.toFixed(1)}%`
          }
          sub="Average performance"
          accent={COLORS.amber}
          icon={Activity}
        />

        <StatCard
  label="BEST MONTH"
  value={
    stats.bestMonth
      ? `${stats.bestMonth.score.toFixed(1)}%`
      : "—"
  }
  sub={
    stats.bestMonth
      ? stats.bestMonth.label
      : "No completed month yet"
  }
  accent={COLORS.emerald}
  icon={Trophy}
/>

       <StatCard
  label="LOWEST MONTH"
  value={
    stats.worstMonth
      ? `${stats.worstMonth.score.toFixed(1)}%`
      : "—"
  }
  sub={
    stats.worstMonth
      ? stats.worstMonth.label
      : "No completed month yet"
  }
  accent={COLORS.crimson}
  icon={TrendingDown}
/>

      </div>


      {/* MONTHLY TIMELINE */}

      <SectionTitle>
        Monthly Performance
      </SectionTitle>

      <Card>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 18,
          }}
        >

          {archive.map(
            (month, index) => {

              const previous =
                archive[index + 1];

              const difference =
                previous
                  ? month.score -
                    previous.score
                  : null;

              return (
                <div
                  key={month.monthKey}
                  style={{
                    paddingBottom: 18,
                    borderBottom:
                      index ===
                      archive.length - 1
                        ? "none"
                        : `1px solid ${COLORS.border}`,
                  }}
                >

                  {/* MONTH HEADER */}

                  <div
                    style={{
                      display: "flex",
                      justifyContent:
                        "space-between",
                      alignItems:
                        "center",
                      marginBottom: 10,
                    }}
                  >

                    <div>

                      <div
                        style={{
                          fontSize: 14,
                          fontWeight: 800,
                        }}
                      >
                        {month.label}
                      </div>

                      <div
                        style={{
                          marginTop: 3,
                          fontSize: 10,
                          color:
                            COLORS.textFaint,
                        }}
                      >
                        {month.totalCompletions}
                        {" "}
                        completed actions
                      </div>

                    </div>


                    <div
                      style={{
                        textAlign: "right",
                      }}
                    >

                      <div
                        className="mono"
                        style={{
                          fontSize: 17,
                          fontWeight: 900,
                          color:
                            month.level.color,
                        }}
                      >
                        {month.score.toFixed(1)}%
                      </div>

                      <div
                        style={{
                          fontSize: 9,
                          color:
                            month.level.color,
                          fontWeight: 800,
                        }}
                      >
                        {month.level.label}
                      </div>
                      <div
  style={{
    fontSize: 9,
    marginTop: 3,
    color: month.isCurrentMonth
      ? COLORS.amber
      : COLORS.textFaint,
    fontWeight: 700,
  }}
>
  {month.isCurrentMonth
    ? "CURRENT · IN PROGRESS"
    : "COMPLETED MONTH"}
</div>

                    </div>

                  </div>


                  {/* SCORE BAR */}

                  <Bar
                    pct={month.score}
                    color={month.level.color}
                  />


                  {/* COMPARISON */}

                  {difference !== null && (
                    <div
                      style={{
                        marginTop: 8,
                        fontSize: 10,
                        color:
                          difference >= 0
                            ? COLORS.emerald
                            : COLORS.crimson,
                      }}
                    >
                      {difference >= 0
                        ? "↑"
                        : "↓"}
                      {" "}
                      {Math.abs(
                        difference
                      ).toFixed(1)}
                      {" "}
                      percentage points
                      {" vs previous month"}
                    </div>
                  )}


                  {/* MONTH HIGHLIGHTS */}

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(auto-fit,minmax(150px,1fr))",
                      gap: 8,
                      marginTop: 12,
                    }}
                  >

                    {month.bestHabit && (
                      <div
                        style={{
                          padding: 10,
                          background:
                            COLORS.surface2,
                          borderRadius: 8,
                        }}
                      >

                        <div
                          style={{
                            fontSize: 9,
                            color:
                              COLORS.textFaint,
                            fontWeight: 800,
                          }}
                        >
                          BEST HABIT
                        </div>

                        <div
                          style={{
                            marginTop: 5,
                            fontSize: 11,
                            fontWeight: 700,
                          }}
                        >
                          {month.bestHabit.name}
                        </div>

                        <div
                          className="mono"
                          style={{
                            marginTop: 3,
                            color:
                              COLORS.emerald,
                            fontWeight: 800,
                          }}
                        >
                          {month.bestHabit.score.toFixed(0)}%
                        </div>

                      </div>
                    )}


                    {month.weakestHabit && (
                      <div
                        style={{
                          padding: 10,
                          background:
                            COLORS.surface2,
                          borderRadius: 8,
                        }}
                      >

                        <div
                          style={{
                            fontSize: 9,
                            color:
                              COLORS.textFaint,
                            fontWeight: 800,
                          }}
                        >
                          NEEDS WORK
                        </div>

                        <div
                          style={{
                            marginTop: 5,
                            fontSize: 11,
                            fontWeight: 700,
                          }}
                        >
                          {month.weakestHabit.name}
                        </div>

                        <div
                          className="mono"
                          style={{
                            marginTop: 3,
                            color:
                              COLORS.crimson,
                            fontWeight: 800,
                          }}
                        >
                          {month.weakestHabit.score.toFixed(0)}%
                        </div>

                      </div>
                    )}

                  </div>

                </div>
              );
            }
          )}

        </div>

      </Card>

      <SectionTitle>
  Personal Records
</SectionTitle>

<div
  style={{
    display: "grid",
    gridTemplateColumns:
      "repeat(auto-fit,minmax(180px,1fr))",
    gap: 12,
  }}
>

  <Card>

    <div
      style={{
        fontSize: 10,
        fontWeight: 800,
        color: COLORS.textFaint,
      }}
    >
      🏆 BEST MONTH
    </div>

    <div
      style={{
        marginTop: 8,
        fontSize: 16,
        fontWeight: 800,
      }}
    >
      {records.bestMonth
        ? records.bestMonth.label
        : "—"}
    </div>

    {records.bestMonth && (
      <div
        className="mono"
        style={{
          marginTop: 4,
          color: COLORS.emerald,
          fontWeight: 900,
        }}
      >
        {records.bestMonth.score.toFixed(1)}%
      </div>
    )}

  </Card>


  <Card>

    <div
      style={{
        fontSize: 10,
        fontWeight: 800,
        color: COLORS.textFaint,
      }}
    >
      📈 BIGGEST IMPROVEMENT
    </div>

    <div
      style={{
        marginTop: 8,
        fontSize: 16,
        fontWeight: 800,
      }}
    >
      {records.biggestImprovement
        ? `+${records.biggestImprovement.difference.toFixed(1)}%`
        : "—"}
    </div>

    <div
      style={{
        marginTop: 4,
        fontSize: 10,
        color: COLORS.textFaint,
      }}
    >
      {records.biggestImprovement
        ? `${monthLabel(
            records.biggestImprovement.previousMonth
          )} → ${monthLabel(
            records.biggestImprovement.month
          )}`
        : "Not enough data"}
    </div>

  </Card>


  <Card>

    <div
      style={{
        fontSize: 10,
        fontWeight: 800,
        color: COLORS.textFaint,
      }}
    >
      ⚠ BIGGEST DROP
    </div>

    <div
      style={{
        marginTop: 8,
        fontSize: 16,
        fontWeight: 800,
        color: COLORS.crimson,
      }}
    >
      {records.biggestDrop
        ? `${records.biggestDrop.difference.toFixed(1)}%`
        : "—"}
    </div>

    <div
      style={{
        marginTop: 4,
        fontSize: 10,
        color: COLORS.textFaint,
      }}
    >
      {records.biggestDrop
        ? `${monthLabel(
            records.biggestDrop.previousMonth
          )} → ${monthLabel(
            records.biggestDrop.month
          )}`
        : "Not enough data"}
    </div>

  </Card>
<Card
  style={{
    marginTop: 12,
    borderColor:
      `${COLORS.amber}55`,
    background:
      `${COLORS.amber}08`,
  }}
>
  <div
    style={{
      fontSize: 10,
      fontWeight: 800,
      color: COLORS.amber,
      letterSpacing: 0.7,
    }}
  >
    🔥 CURRENT MONTH BEST SO FAR
  </div>

  <div
    style={{
      marginTop: 8,
      fontSize: 16,
      fontWeight: 800,
    }}
  >
    {records.currentMonthBest
      ? records.currentMonthBest.label
      : "—"}
  </div>

  {records.currentMonthBest && (
    <div
      className="mono"
      style={{
        marginTop: 4,
        color: COLORS.amber,
        fontWeight: 900,
      }}
    >
      {records.currentMonthBest.score.toFixed(1)}%
    </div>
  )}

  <div
    style={{
      marginTop: 5,
      fontSize: 10,
      color: COLORS.textFaint,
    }}
  >
    Current month is still in progress.
  </div>
</Card>





</div>

    </div>
  );
}
/* ============================================================================
   YOU VS YOU — PHASE 3
============================================================================ */

function YouVsYouView() {
  const { state, today } = useApp();

  const activeHabits = state.habits.filter(
    h => !h.archived
  );

  if (!activeHabits.length) {
    return (
      <EmptyState
        title="NO COMPARISON YET"
        body="Start tracking your habits to compare your current performance against your own history."
      />
    );
  }

  const currentMonth = getMonthKey(today);
  const currentStart = currentMonth + "-01";

  const previousMonth = prevMonthKey(currentMonth);
  const previousStart = previousMonth + "-01";
  const previousEnd =
    previousMonth +
    "-" +
    pad2(daysInMonth(previousMonth));

  /* ============================================================
     OVERALL SCORES
  ============================================================ */

  const currentScore = overallScore(
    activeHabits,
    state.records,
    currentStart,
    today,
    today
  );

  const previousScore = overallScore(
    activeHabits,
    state.records,
    previousStart,
    previousEnd,
    today
  );

  /* ============================================================
     MONTHLY ARCHIVE
  ============================================================ */

  const archive = buildMonthlyArchive(
    state,
    today
  );


  /* ============================================================
     HISTORICAL AVERAGE
  ============================================================ */

  const historicalMonths =
    archive.filter(
      month =>
        month.monthKey !== currentMonth
    );

  const historicalAverage =
    historicalMonths.length
      ? historicalMonths.reduce(
          (sum, month) =>
            sum + month.score,
          0
        ) / historicalMonths.length
      : null;

  /* ============================================================
     PERSONAL BEST
  ============================================================ */

const completedMonths =
  archive.filter(
    month => month.isComplete
  );

const historicalBest =
  completedMonths.length
    ? [...completedMonths].sort(
        (a, b) =>
          b.score - a.score
      )[0]
    : null;

const isNewPersonalBest =
  currentScore !== null &&
  historicalBest !== null &&
  currentScore >
    historicalBest.score;

  /* ============================================================
     DELTAS
  ============================================================ */

  const vsLastMonth =
    currentScore !== null &&
    previousScore !== null
      ? currentScore - previousScore
      : null;

  const vsHistoricalAverage =
    currentScore !== null &&
    historicalAverage !== null
      ? currentScore -
        historicalAverage
      : null;

  /* ============================================================
     HABIT COMPARISON
  ============================================================ */

  const habitRows =
    activeHabits
      .map(habit => {

        const current =
          habitConsistency(
            habit,
            state.records,
            currentStart,
            today,
            today
          );

        const previous =
          habitConsistency(
            habit,
            state.records,
            previousStart,
            previousEnd,
            today
          );

        const change =
          current !== null &&
          previous !== null
            ? current - previous
            : null;

        return {
          habit,
          current,
          previous,
          change,
        };
      })
      .filter(
        row =>
          row.current !== null ||
          row.previous !== null
      )
      .sort(
        (a, b) =>
          (b.current ?? -1) -
          (a.current ?? -1)
      );

  /* ============================================================
     MOST IMPROVED HABIT
  ============================================================ */

  const mostImproved =
    [...habitRows]
      .filter(
        row =>
          row.change !== null
      )
      .sort(
        (a, b) =>
          b.change - a.change
      )[0] || null;

  /* ============================================================
     MOST DECLINED HABIT
  ============================================================ */

  const mostDeclined =
    [...habitRows]
      .filter(
        row =>
          row.change !== null
      )
      .sort(
        (a, b) =>
          a.change - b.change
      )[0] || null;

  return (
    <div>

      {/* ======================================================
          HEADER
      ====================================================== */}

      <h1
        style={{
          fontSize: 20,
          fontWeight: 800,
          marginBottom: 4,
        }}
      >
        You vs You
      </h1>

      <div
        style={{
          color: COLORS.textFaint,
          fontSize: 12.5,
          marginBottom: 20,
        }}
      >
        You are competing with your own history —
        not anyone else.
      </div>


      {/* ======================================================
          OVERALL COMPARISON
      ====================================================== */}

      <div
        style={{
          display: "grid",
          gridTemplateColumns:
            "repeat(auto-fit,minmax(170px,1fr))",
          gap: 12,
        }}
      >

        <StatCard
          label="THIS MONTH"
          value={
            currentScore !== null
              ? `${currentScore.toFixed(1)}%`
              : "—"
          }
          sub={
            currentScore !== null
              ? performanceLevel(
                  currentScore
                ).label
              : "No data"
          }
          accent={
            currentScore !== null
              ? performanceLevel(
                  currentScore
                ).color
              : undefined
          }
          icon={Trophy}
        />

        <StatCard
          label="LAST MONTH"
          value={
            previousScore !== null
              ? `${previousScore.toFixed(1)}%`
              : "—"
          }
          sub={
            previousScore !== null
              ? "Previous month"
              : "No previous data"
          }
        />

        <StatCard
          label="HISTORICAL AVG"
          value={
            historicalAverage !== null
              ? `${historicalAverage.toFixed(1)}%`
              : "—"
          }
          sub="All completed months"
          accent={COLORS.amber}
        />

        <StatCard
          label="PERSONAL BEST"
          value={
            historicalBest
              ? `${historicalBest.score.toFixed(1)}%`
              : "—"
          }
          sub={
            historicalBest
              ? historicalBest.label
              : "No record yet"
          }
          accent={COLORS.emerald}
          icon={Sparkles}
        />

      </div>


      {/* ======================================================
          MAIN VERDICT
      ====================================================== */}

      {currentScore !== null && (
        <Card
          style={{
            marginTop: 16,
            borderColor:
              vsHistoricalAverage !== null &&
              vsHistoricalAverage >= 0
                ? `${COLORS.emerald}55`
                : `${COLORS.crimson}55`,
            background:
              vsHistoricalAverage !== null &&
              vsHistoricalAverage >= 0
                ? `${COLORS.emerald}08`
                : `${COLORS.crimson}08`,
          }}
        >

          <div
            style={{
              fontSize: 11,
              fontWeight: 800,
              letterSpacing: 0.8,
              marginBottom: 8,
              color:
                vsHistoricalAverage !== null &&
                vsHistoricalAverage >= 0
                  ? COLORS.emerald
                  : COLORS.crimson,
            }}
          >
            {isNewPersonalBest
              ? "🏆 NEW PERSONAL BEST"
              : vsHistoricalAverage !== null &&
                vsHistoricalAverage >= 0
                ? "📈 YOU ARE IMPROVING"
                : "⚠ YOU HAVE ROOM TO IMPROVE"}
          </div>

          <div
            style={{
              fontSize: 13,
              lineHeight: 1.7,
            }}
          >

            {vsLastMonth !== null && (
              <div>
                Compared with last month,
                you're{" "}
                <b>
                  {Math.abs(
                    vsLastMonth
                  ).toFixed(1)}
                  %
                </b>{" "}
                {vsLastMonth >= 0
                  ? "better"
                  : "behind"}.
              </div>
            )}

            {vsHistoricalAverage !== null && (
              <div>
                Compared with your historical
                average, you're{" "}
                <b>
                  {Math.abs(
                    vsHistoricalAverage
                  ).toFixed(1)}
                  %
                </b>{" "}
                {vsHistoricalAverage >= 0
                  ? "ahead"
                  : "behind"}.
              </div>
            )}

            {isNewPersonalBest && (
              <div
                style={{
                  marginTop: 6,
                  color: COLORS.emerald,
                  fontWeight: 700,
                }}
              >
                This is currently your best
                monthly performance on record.
              </div>
            )}

          </div>

        </Card>
      )}


      {/* ======================================================
          PERFORMANCE COMPARISON
      ====================================================== */}

      <SectionTitle>
        Performance Comparison
      </SectionTitle>

      <Card>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 16,
          }}
        >

          <ComparisonBar
            label="This Month"
            value={currentScore}
            color={COLORS.emerald}
          />

          <ComparisonBar
            label="Last Month"
            value={previousScore}
          />

          <ComparisonBar
            label="Historical Average"
            value={historicalAverage}
            color={COLORS.amber}
          />

          <ComparisonBar
            label="Personal Best"
            value={
              historicalBest
                ? historicalBest.score
                : null
            }
            color={COLORS.emerald}
          />

        </div>

      </Card>


      {/* ======================================================
          HABIT COMPARISON
      ====================================================== */}

      <SectionTitle>
        Habit-by-Habit Comparison
      </SectionTitle>

      <Card
        style={{
          overflow: "auto",
        }}
      >

        <table
          style={{
            width: "100%",
            minWidth: 620,
            borderCollapse:
              "collapse",
          }}
        >

          <thead>

            <tr>

              <th
                style={{
                  ...thStyle,
                  textAlign: "left",
                }}
              >
                HABIT
              </th>

              <th style={thStyle}>
                THIS MONTH
              </th>

              <th style={thStyle}>
                LAST MONTH
              </th>

              <th style={thStyle}>
                CHANGE
              </th>

              <th style={thStyle}>
                STATUS
              </th>

            </tr>

          </thead>

          <tbody>

            {habitRows.map(row => {

              const change =
                row.change;

              const status =
                change === null
                  ? "No comparison"
                  : change > 0
                    ? "Improving"
                    : change < 0
                      ? "Declining"
                      : "Stable";

              const statusColor =
                change === null
                  ? COLORS.textFaint
                  : change > 0
                    ? COLORS.emerald
                    : change < 0
                      ? COLORS.crimson
                      : COLORS.amber;

              return (
                <tr key={row.habit.id}>

                  <td
                    style={{
                      ...tdStyle,
                      textAlign:
                        "left",
                      fontWeight: 650,
                    }}
                  >
                    {row.habit.name}
                  </td>

                  <td
                    style={tdStyle}
                    className="mono"
                  >
                    {row.current !== null
                      ? `${row.current.toFixed(0)}%`
                      : "—"}
                  </td>

                  <td
                    style={tdStyle}
                    className="mono"
                  >
                    {row.previous !== null
                      ? `${row.previous.toFixed(0)}%`
                      : "—"}
                  </td>

                  <td
                    style={{
                      ...tdStyle,
                      color:
                        change === null
                          ? COLORS.textFaint
                          : change >= 0
                            ? COLORS.emerald
                            : COLORS.crimson,
                      fontWeight: 800,
                    }}
                    className="mono"
                  >
                    {change === null
                      ? "—"
                      : `${change >= 0 ? "+" : ""}${change.toFixed(0)}%`}
                  </td>

                  <td
                    style={{
                      ...tdStyle,
                      color:
                        statusColor,
                      fontWeight: 700,
                      fontSize: 10,
                    }}
                  >
                    {status}
                  </td>

                </tr>
              );
            })}

          </tbody>

        </table>

      </Card>


      {/* ======================================================
          BIGGEST MOVERS
      ====================================================== */}

      <SectionTitle>
        Biggest Movers
      </SectionTitle>

      <div
        style={{
          display: "grid",
          gridTemplateColumns:
            "repeat(auto-fit,minmax(220px,1fr))",
          gap: 12,
        }}
      >

        <Card>

          <div
            style={{
              fontSize: 10,
              fontWeight: 800,
              letterSpacing: 0.7,
              color: COLORS.emerald,
            }}
          >
            📈 MOST IMPROVED
          </div>

          {mostImproved ? (
            <>
              <div
                style={{
                  marginTop: 8,
                  fontSize: 15,
                  fontWeight: 800,
                }}
              >
                {mostImproved.habit.name}
              </div>

              <div
                className="mono"
                style={{
                  marginTop: 4,
                  color: COLORS.emerald,
                  fontWeight: 800,
                }}
              >
                +{mostImproved.change.toFixed(1)}%
              </div>
            </>
          ) : (
            <div
              style={{
                marginTop: 8,
                color:
                  COLORS.textFaint,
                fontSize: 12,
              }}
            >
              Not enough comparison data.
            </div>
          )}

        </Card>


        <Card>

          <div
            style={{
              fontSize: 10,
              fontWeight: 800,
              letterSpacing: 0.7,
              color: COLORS.crimson,
            }}
          >
            📉 MOST DECLINED
          </div>

          {mostDeclined ? (
            <>
              <div
                style={{
                  marginTop: 8,
                  fontSize: 15,
                  fontWeight: 800,
                }}
              >
                {mostDeclined.habit.name}
              </div>

              <div
                className="mono"
                style={{
                  marginTop: 4,
                  color: COLORS.crimson,
                  fontWeight: 800,
                }}
              >
                {mostDeclined.change.toFixed(1)}%
              </div>
            </>
          ) : (
            <div
              style={{
                marginTop: 8,
                color:
                  COLORS.textFaint,
                fontSize: 12,
              }}
            >
              Not enough comparison data.
            </div>
          )}

        </Card>

      </div>


      {/* ======================================================
          COACHING MESSAGE
      ====================================================== */}

      <Card
        style={{
          marginTop: 16,
          background:
            COLORS.surface2,
        }}
      >

        <div
          style={{
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: 0.7,
            marginBottom: 7,
          }}
        >
          YOUR NEXT MOVE
        </div>

        <div
          style={{
            fontSize: 12.5,
            color:
              COLORS.textDim,
            lineHeight: 1.7,
          }}
        >
          {mostDeclined &&
          mostDeclined.change < 0 ? (
            <>
              Your biggest opportunity is{" "}
              <b
                style={{
                  color:
                    COLORS.text,
                }}
              >
                {mostDeclined.habit.name}
              </b>
              . Focus on restoring consistency
              there before adding more habits.
            </>
          ) : mostImproved &&
            mostImproved.change > 0 ? (
            <>
              Keep the momentum on{" "}
              <b
                style={{
                  color:
                    COLORS.emerald,
                }}
              >
                {mostImproved.habit.name}
              </b>
              . You're proving that consistency
              can improve over time.
            </>
          ) : (
            <>
              Keep your current system stable.
              Your goal is not perfection — it is
              sustained consistency.
            </>
          )}
        </div>

      </Card>

    </div>
  );
}


function ComparisonBar({
  label,
  value,
  color,
}) {
  return (
    <div>

      <div
        style={{
          display: "flex",
          justifyContent:
            "space-between",
          marginBottom: 6,
        }}
      >

        <span
          style={{
            fontSize: 12,
            fontWeight: 650,
          }}
        >
          {label}
        </span>

        <span
          className="mono"
          style={{
            fontSize: 12,
            fontWeight: 800,
          }}
        >
          {value !== null &&
          value !== undefined
            ? `${value.toFixed(1)}%`
            : "—"}
        </span>

      </div>

      <Bar
        pct={value ?? 0}
        color={
          color ||
          COLORS.textDim
        }
      />

    </div>
  );
}
/* ============================================================================
   SETTINGS
============================================================================ */
function SettingsView() {
  const app = useApp();
  const { state } = app;
  const fileRef = useRef(null);
  const [importError, setImportError] = useState("");

  function exportJSON() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `habit-os-backup-${todayStr()}.json`; a.click();
    URL.revokeObjectURL(url);
    app.showToast("JSON backup downloaded", "good");
  }

  function exportCSV() {
    const rows = [["date", "habit", "status", "loggedValue", "score"]];
    for (const r of state.records) {
      const h = state.habits.find(x => x.id === r.habitId);
      if (!h) continue;
      const ev = dayEval(h, r, r.date, todayStr());
      rows.push([r.date, h.name, r.status, r.loggedValue ?? "", ev.score ?? ""]);
    }
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `habit-os-records-${todayStr()}.csv`; a.click();
    URL.revokeObjectURL(url);
    app.showToast("CSV exported", "good");
  }
function handleFile(e) {
  const file = e.target.files[0];

  if (!file) return;

  const reader = new FileReader();

  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);

      /* --------------------------------------------------------
         BASIC BACKUP VALIDATION
      -------------------------------------------------------- */

      if (!data || typeof data !== "object") {
        setImportError(
          "Invalid backup file."
        );
        return;
      }

      if (!Array.isArray(data.habits)) {
        setImportError(
          "Backup is missing the habits data."
        );
        return;
      }

      if (!Array.isArray(data.records)) {
        setImportError(
          "Backup is missing the records data."
        );
        return;
      }

      /* --------------------------------------------------------
         NORMALIZE BACKUP
      -------------------------------------------------------- */

      const restoredState = {
        ...defaultState(),
        ...data,

        habits:
          data.habits.map(habit => ({
            archived: false,
            weight: 1,
            frequency: [
              0,
              1,
              2,
              3,
              4,
              5,
              6,
            ],
            allowGraceFreeze: true,
            reminderEnabled: false,
            reminderTime: "19:00",
            ...habit,
          })),

        records:
          data.records.map(record => ({
            status: "untracked",
            ...record,
          })),
      };

      /* --------------------------------------------------------
         FINAL CONFIRMATION
      -------------------------------------------------------- */

      if (
        confirm(
          "This will replace your current Habit OS data with the imported backup. Continue?"
        )
      ) {
        app.importData(
          restoredState
        );

        setImportError("");

        app.showToast(
          "Backup restored successfully",
          "good"
        );
      }

    } catch (err) {
      console.error(
        "Backup import failed:",
        err
      );

      setImportError(
        "Could not read this backup. The file may be corrupted or invalid."
      );
    }
  };

  reader.onerror = () => {
    setImportError(
      "Could not read the selected file."
    );
  };

  reader.readAsText(file);

  // Allow the same file to be selected again
  e.target.value = "";
}

  return (
    <div style={{ maxWidth: 640 }}>
      <h1 style={{ fontSize: 20, fontWeight: 800, marginBottom: 18 }}>Settings</h1>

      <SectionTitle>Data</SectionTitle>
      <Card style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <SettingRow label="Export complete backup" desc="All habits, records, and settings as JSON.">
          <Btn icon={Download} onClick={exportJSON}>Export JSON</Btn>
        </SettingRow>
        <SettingRow label="Export records" desc="Human-readable CSV of all tracked days.">
          <Btn icon={Download} onClick={exportCSV}>Export CSV</Btn>
        </SettingRow>
        <SettingRow label="Restore backup" desc="Import a previously exported JSON file.">
          <Btn icon={Upload} onClick={() => fileRef.current.click()}>Import JSON</Btn>
          <input id="import-backup" name="importBackup" ref={fileRef} type="file" accept="application/json" style={{ display: "none" }} onChange={handleFile} />
        </SettingRow>
        {importError && <div style={{ color: COLORS.crimson, fontSize: 12 }}>{importError}</div>}
        <SettingRow label="Reset all data" desc="Permanently erase every habit and record.">
          <Btn variant="danger" icon={Trash2} onClick={() => { if (confirm("This permanently deletes ALL data. This cannot be undone. Continue?")) app.resetAll(); }}>Reset</Btn>
        </SettingRow>
      </Card>

      <SectionTitle>Tracking</SectionTitle>
      <Card style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <SettingRow label="Streak threshold" desc="Minimum daily score to keep the overall streak alive.">
          <select id="streak-threshold" name="streakThreshold" value={state.settings.streakThreshold} className="focus-ring" style={selectStyle}
            onChange={e => app.setState(s => ({ ...s, settings: { ...s.settings, streakThreshold: Number(e.target.value) } }))}>
            {[50,60,70,80,90].map(v => <option key={v} value={v}>{v}%</option>)}
          </select>
        </SettingRow>
        <SettingRow label="Streak Saver" desc="Allow 1 grace freeze per habit per month.">
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input id="streak-saver-enabled" name="streakSaverEnabled" type="checkbox" checked={state.settings.streakSaverGlobalEnabled}
              onChange={e => app.setState(s => ({ ...s, settings: { ...s.settings, streakSaverGlobalEnabled: e.target.checked } }))} />
          </label>
        </SettingRow>
      </Card>

            <SectionTitle>Notifications</SectionTitle>

      <Card>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div>
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              Test notification
            </div>

            <div
              style={{
                fontSize: 11.5,
                color: COLORS.textFaint,
                marginTop: 2,
              }}
            >
              Check that browser notifications are working.
            </div>
          </div>

          <Btn
            icon={Bell}
            onClick={async () => {
              const permission =
                await requestNotificationPermission();

              if (permission === "granted") {
                new Notification(
                  "Habit OS",
                  {
                    body:
                      "Notifications are working correctly.",
                    tag: "habit-os-test",
                  }
                );

                app.showToast(
                  "Test notification sent",
                  "good"
                );
              } else {
                app.showToast(
                  "Notification permission is not available",
                  "warn"
                );
              }
            }}
          >
            Test
          </Btn>
        </div>
      </Card>

      <SectionTitle>About</SectionTitle>
      <Card>
        <div style={{ fontSize: 12.5, color: COLORS.textDim, lineHeight: 1.7 }}>
          Schema version <span className="mono">{state.schemaVersion}</span>. All data is stored locally and never leaves your device.
          You are not competing with other people — you're competing with the person you were yesterday.
        </div>
      </Card>
    </div>
  );
}

function SettingRow({ label, desc, children }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "8px 0", borderBottom: `1px solid ${COLORS.border}` }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{label}</div>
        <div style={{ fontSize: 11.5, color: COLORS.textFaint, marginTop: 2 }}>{desc}</div>
      </div>
      <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>{children}</div>
    </div>
  );
}
