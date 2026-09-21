// How far someone has watched, remembered on this device.
//
// One localStorage entry per title: the last thing played in it (the trailer
// or an episode) and a position for each thing played. Local rather than on a
// server because accounts are front-end only for now; the shape moves to an
// API unchanged once there is one.

export interface WatchPosition {
  /** Seconds watched. */
  t: number;
  /** Length in seconds. */
  d: number;
}

export interface TitleProgress {
  /** Key of the last thing played: "trailer" or "s1e3". */
  last: string;
  items: Record<string, WatchPosition>;
  updatedAt: number;
}

const PREFIX = "showtiva-progress:";
const EVENT = "showtiva-progress";

/** Near the end counts as finished: the next visit starts over. */
export const FINISHED_WITHIN_SECONDS = 15;

export function progressKey(pick: "trailer" | { season: number; episode: number }) {
  return pick === "trailer" ? "trailer" : `s${pick.season}e${pick.episode}`;
}

export function parsePick(key: string): "trailer" | { season: number; episode: number } | null {
  if (key === "trailer") return "trailer";
  const m = /^s(\d+)e(\d+)$/.exec(key);
  return m ? { season: Number(m[1]), episode: Number(m[2]) } : null;
}

/** The raw stored string: a stable snapshot for useSyncExternalStore. */
export function readRaw(titleId: string): string | null {
  try {
    return window.localStorage.getItem(PREFIX + titleId);
  } catch {
    return null;
  }
}

export function parseProgress(raw: string | null): TitleProgress | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as TitleProgress;
    return value && typeof value.last === "string" && value.items ? value : null;
  } catch {
    return null;
  }
}

export function saveProgress(titleId: string, key: string, t: number, d: number) {
  if (!Number.isFinite(t) || !Number.isFinite(d) || d <= 0) return;
  try {
    const current = parseProgress(readRaw(titleId)) ?? { last: key, items: {}, updatedAt: 0 };
    const next: TitleProgress = {
      last: key,
      items: { ...current.items, [key]: { t: Math.max(0, Math.min(t, d)), d } },
      updatedAt: Date.now(),
    };
    window.localStorage.setItem(PREFIX + titleId, JSON.stringify(next));
    window.dispatchEvent(new Event(EVENT));
  } catch {
    // Storage full or blocked: progress simply is not remembered.
  }
}

/** Fires on this tab's saves and on other tabs' (the storage event). */
export function subscribeProgress(onChange: () => void) {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** 0–1, or 0 for nothing watched. Finished counts as 1. */
export function fractionWatched(position: WatchPosition | undefined) {
  if (!position || position.d <= 0) return 0;
  if (position.d - position.t <= FINISHED_WITHIN_SECONDS) return 1;
  return Math.min(1, position.t / position.d);
}

/** Where to resume from, or 0 to start over. */
export function resumeSeconds(position: WatchPosition | undefined) {
  if (!position || position.t < 5 || position.d - position.t <= FINISHED_WITHIN_SECONDS) return 0;
  return position.t;
}
