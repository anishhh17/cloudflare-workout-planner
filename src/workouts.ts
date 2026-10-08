// Pure workout logic: types, progressive overload, monthly stats.
// No I/O here — the agent calls these and the LLM only narrates the results.

export type WorkoutEntry = {
  id: string;
  date: string; // YYYY-MM-DD, in the user's local timezone
  exercise: string; // normalized: lowercase, single spaces
  weight: number; // kg (0 for bodyweight)
  sets: number;
  reps: number;
};

export type WorkoutState = { workouts: WorkoutEntry[] };

// Double progression: +1 rep per session until 12, then +2.5 kg and back to 8.
export const REP_CEILING = 12;
export const REP_RESET = 8;
export const WEIGHT_STEP_KG = 2.5;

const DAY_MS = 86_400_000;

export function normalizeExercise(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Today's date as YYYY-MM-DD in the given IANA timezone (falls back to UTC). */
export function localDate(timezone?: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(
      new Date()
    );
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(date) + days * DAY_MS).toISOString().slice(0, 10);
}

const volume = (e: WorkoutEntry) => e.weight * e.sets * e.reps;
const epley1RM = (e: WorkoutEntry) =>
  Math.round(e.weight * (1 + e.reps / 30) * 10) / 10;

/** Top set (heaviest, then most reps) of an exercise's most recent session. */
function lastTopSet(entries: WorkoutEntry[]): WorkoutEntry {
  const lastDate = entries.reduce((d, e) => (e.date > d ? e.date : d), "");
  return entries
    .filter((e) => e.date === lastDate)
    .reduce((best, e) =>
      e.weight > best.weight || (e.weight === best.weight && e.reps > best.reps)
        ? e
        : best
    );
}

/** The single overload rule, applied to every exercise. */
export function nextPrescription(last: WorkoutEntry) {
  if (last.reps < REP_CEILING) {
    return {
      weight: last.weight,
      sets: last.sets,
      reps: last.reps + 1,
      reason: "+1 rep"
    };
  }
  return {
    weight: last.weight + WEIGHT_STEP_KG,
    sets: last.sets,
    reps: REP_RESET,
    reason: `hit ${REP_CEILING} reps → +${WEIGHT_STEP_KG} kg, back to ${REP_RESET}`
  };
}

function groupByExercise(workouts: WorkoutEntry[]) {
  const groups = new Map<string, WorkoutEntry[]>();
  for (const w of workouts) {
    groups.set(w.exercise, [...(groups.get(w.exercise) ?? []), w]);
  }
  return groups;
}

export function suggestNext(workouts: WorkoutEntry[], today: string) {
  const plan = [...groupByExercise(workouts)]
    .map(([exercise, entries]) => {
      const last = lastTopSet(entries);
      const daysSince = daysBetween(last.date, today);
      return {
        exercise,
        last: {
          date: last.date,
          weight: last.weight,
          sets: last.sets,
          reps: last.reps
        },
        next: nextPrescription(last),
        daysSince,
        priority: daysSince > 7
      };
    })
    .sort((a, b) => b.daysSince - a.daysSince);
  // Explicit list so the LLM doesn't have to interpret per-exercise flags.
  const priorities = plan
    .filter((p) => p.priority)
    .map((p) => `${p.exercise} (${p.daysSince} days since last session)`);
  return { plan, priorities };
}

export function summarizeMonth(workouts: WorkoutEntry[], today: string) {
  const start = addDays(today, -29); // 30-day window including today
  const mid = addDays(today, -14);
  const inWindow = workouts.filter((w) => w.date >= start && w.date <= today);
  const before = workouts.filter((w) => w.date < start);

  // Volume per 7-day bucket, oldest first (last bucket ends today).
  const weeks = [4, 3, 2, 1, 0].map((k) => {
    const from = addDays(today, -7 * k - 6);
    const to = addDays(today, -7 * k);
    const vol = inWindow
      .filter((w) => w.date >= from && w.date <= to)
      .reduce((s, w) => s + volume(w), 0);
    return { from: from < start ? start : from, to, volume: vol };
  });

  const exercises = [...groupByExercise(inWindow)].map(
    ([exercise, entries]) => {
      const firstHalf = entries
        .filter((e) => e.date < mid)
        .reduce((s, e) => s + volume(e), 0);
      const secondHalf = entries
        .filter((e) => e.date >= mid)
        .reduce((s, e) => s + volume(e), 0);
      const firstDate = entries.reduce(
        (d, e) => (e.date < d ? e.date : d),
        today
      );
      const startWeight = Math.max(
        ...entries.filter((e) => e.date === firstDate).map((e) => e.weight)
      );
      const bestWeight = Math.max(...entries.map((e) => e.weight));
      const best1RM = Math.max(...entries.map(epley1RM));
      const prior = before.filter((e) => e.exercise === exercise);
      const priorBestWeight = prior.length
        ? Math.max(...prior.map((e) => e.weight))
        : null;
      const priorBest1RM = prior.length
        ? Math.max(...prior.map(epley1RM))
        : null;
      return {
        exercise,
        sessions: new Set(entries.map((e) => e.date)).size,
        // Pre-computed so the LLM doesn't misread two raw numbers.
        volumeTrend:
          firstHalf === 0
            ? "only trained in the last 2 weeks"
            : secondHalf === 0
              ? "not trained in the last 2 weeks"
              : `${secondHalf >= firstHalf ? "up" : "down"} ${Math.round(
                  (Math.abs(secondHalf - firstHalf) / firstHalf) * 100
                )}% (last 2 weeks vs the 2 before)`,
        startWeight,
        bestWeight,
        best1RM,
        // A PR needs earlier history to beat; brand-new lifts are flagged instead.
        weightPR: priorBestWeight !== null && bestWeight > priorBestWeight,
        e1rmPR: priorBest1RM !== null && best1RM > priorBest1RM,
        firstTimeLogged: prior.length === 0
      };
    }
  );

  // Explicit, human-readable facts so the LLM doesn't misread boolean flags.
  const prs = exercises.flatMap((e) => [
    ...(e.weightPR
      ? [`${e.exercise}: heaviest weight ${e.bestWeight} kg`]
      : []),
    ...(e.e1rmPR ? [`${e.exercise}: best estimated 1RM ${e.best1RM} kg`] : [])
  ]);
  const progress = exercises
    .filter((e) => e.bestWeight > e.startWeight)
    .map((e) => `${e.exercise}: ${e.startWeight} → ${e.bestWeight} kg`);
  const newLifts = exercises
    .filter((e) => e.firstTimeLogged)
    .map((e) => e.exercise);

  return {
    window: { from: start, to: today },
    prs,
    progress,
    newLifts,
    sessions: new Set(inWindow.map((w) => w.date)).size,
    totalVolumeKg: inWindow.reduce((s, w) => s + volume(w), 0),
    weeks,
    exercises
  };
}
