"use client";

// The detail page's theatre, once Play is pressed.
//
// Streaming-app layout: "Now playing" and the title centred at the top, one
// large translucent play button in the middle, and along the bottom the
// elapsed time, a thin scrubber and the running time, with transport on the
// left (play, back 10, forward 10, volume) and viewing options on the right
// (audio & subtitles, settings, picture-in-picture, fullscreen). Everything
// but the picture fades away while the film plays and nobody is touching it.
import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { cx } from "@/lib/cx";
import type { Season } from "@/lib/content-types";

/** What the player is showing for a series: an episode, or the trailer. */
export type PlayerPick = { season: number; episode: number } | "trailer";

/** A series to suggest from a film's episodes panel. */
export interface SeriesSuggestion {
  id: string;
  title: string;
  still: string;
  meta: string;
}

export interface PlayerSeries {
  /** Empty for a film: the panel then points to series that have episodes. */
  seasons: Season[];
  current: PlayerPick;
  /** Thumbnail for anything without a still of its own. */
  fallbackStill: string;
  onSelect: (pick: PlayerPick) => void;
  suggestions?: SeriesSuggestion[];
  onOpenTitle?: (id: string) => void;
}

/** One encode of the same film at a given frame height. */
export interface Rendition {
  height: number;
  url: string;
}

/** What to play, and at which qualities. */
export interface PlayerMedia {
  /** Lowest first. Empty for a title with a single file: Quality offers Auto only. */
  renditions: Rendition[];
  /** Tried after the chosen rendition, in order, if it cannot play. */
  fallbacks: string[];
  /** Seconds into the renditions to open at. */
  startAt?: number;
}

interface MoviePlayerProps {
  title: string;
  /** Follows the title in the top bar, e.g. "S1:E4 · The Secret Door". */
  episodeLabel?: string;
  media: PlayerMedia;
  poster: string;
  onClose: () => void;
  /** Powers the episodes panel, which every title has. */
  series?: PlayerSeries;
  /** Present when there is a next episode to go to. */
  onNext?: () => void;
  /** Seconds into this title to open at, measured from its own start. */
  resumeAt?: number;
  /** Where playback is, every few seconds and on pause, end and close. */
  onProgress?: (seconds: number, duration: number) => void;
}

/** "S03E04", the way episode lists label them. */
export function episodeCode(season: number, episode: number) {
  return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

/* ------------------------------------------------------------- behaviour -- */

/** How long the controls stay up after the last sign of life. */
const HIDE_AFTER_MS = 2800;
const SKIP_SECONDS = 10;
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

/* Rotation is only offered where it can be honoured: something to call lock()
   on, and a screen for which sideways means anything. Android has both; iOS
   Safari has no lock, so the control never appears there. */
const COARSE_QUERY = "(pointer: coarse)";

/** The lock half of the Screen Orientation API, which the DOM lib omits. */
type LockableOrientation = ScreenOrientation & {
  lock?: (orientation: string) => Promise<void>;
  unlock?: () => void;
};

/** iPhone Safari has no element fullscreen, only the video's own. */
type WebkitVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };

function subscribeToPointerKind(onChange: () => void) {
  const query = window.matchMedia(COARSE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function readCanRotate() {
  const orientation = window.screen?.orientation as LockableOrientation | undefined;
  return typeof orientation?.lock === "function" && window.matchMedia(COARSE_QUERY).matches;
}

function readIsCoarse() {
  return window.matchMedia(COARSE_QUERY).matches;
}

const noSubscribe = () => () => undefined;
const readCanPip = () => typeof document !== "undefined" && document.pictureInPictureEnabled === true;

/** 83 → "1:23", 4023 → "1:07:03". */
function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** 2160 → "4K", 1440 → "1440p". */
function qualityLabel(height: number) {
  return height >= 2160 ? "4K" : `${height}p`;
}

function qualityBadge(height: number) {
  if (height >= 2160) return "UHD";
  if (height >= 1440) return "QHD";
  if (height >= 720) return "HD";
  return null;
}

/* Auto picks the smallest encode that still covers the screen's pixels, and
   stops at 1080p: past that the file grows fourfold for a difference few
   screens show, which is what choosing 1440p or 4K by hand is for. */
const AUTO_CAP = 1080;

function autoRendition(renditions: Rendition[]) {
  if (renditions.length === 0) return undefined;
  const needed = typeof window === "undefined" ? 720 : Math.min(window.innerWidth * 0.5625, window.innerHeight) * (window.devicePixelRatio || 1);
  const allowed = renditions.filter((r) => r.height <= AUTO_CAP);
  const pool = allowed.length ? allowed : renditions.slice(0, 1);
  return pool.find((r) => r.height >= needed * 0.9) ?? pool[pool.length - 1];
}

function seekBy(video: HTMLVideoElement, delta: number) {
  const end = Number.isFinite(video.duration) ? video.duration : video.currentTime + delta;
  video.currentTime = Math.min(end, Math.max(0, video.currentTime + delta));
}

/* --------------------------------------------------------------- styling -- */

const FOCUS_RING = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink";

/* One button shape for the whole bar: a translucent disc that brightens on
   hover. The disc is smaller on a phone, where eight of them share 343px. */
const DISC_BASE =
  "relative inline-grid flex-none cursor-pointer place-items-center rounded-full border border-[rgba(255,255,255,0.1)] bg-[rgba(255,255,255,0.12)] p-0 text-white backdrop-blur-[14px] transition-[background-color,border-color,scale,opacity] duration-200 ease-[ease] hover:border-[rgba(255,255,255,0.22)] hover:bg-[rgba(255,255,255,0.24)] active:scale-95 aria-expanded:bg-[rgba(255,255,255,0.28)] motion-reduce:transition-none " +
  FOCUS_RING;
/* Sizes kept apart from the base, so a bigger disc never has two size
   utilities fighting over the same property. */
const DISC = DISC_BASE + " size-11 max-[560px]:size-9 [&_svg]:size-5 max-[560px]:[&_svg]:size-[18px]";
const EPISODES_PILL =
  DISC_BASE +
  " h-11 grid-flow-col gap-2 pr-4 pl-3.5 [&_svg]:size-5 max-[560px]:size-9 max-[560px]:gap-0 max-[560px]:px-0 max-[560px]:[&_svg]:size-[18px]";
const DISC_SKIP_CENTRE = DISC_BASE + " size-12 min-[561px]:hidden [&_svg]:size-6";
const DISC_HERO = DISC_BASE + " size-[clamp(4.5rem,8vw,6rem)] max-[560px]:size-[4.25rem] [&_svg]:size-[42%]";

const MENU =
  "absolute right-0 bottom-[calc(100%+0.75rem)] z-[8] max-h-[min(34rem,calc(100dvh-7rem))] overflow-y-auto overscroll-contain [scrollbar-width:thin] w-[15rem] max-w-[calc(100vw-2rem)] animate-menu-in rounded-2xl border border-[rgba(255,255,255,0.1)] bg-[rgba(18,18,18,0.86)] p-2 text-left shadow-[0_18px_48px_rgba(0,0,0,0.55)] backdrop-blur-[18px] motion-reduce:animate-none";
const MENU_HEADING = "px-3 pt-2 pb-1 text-[0.62rem] font-semibold tracking-[0.2em] text-[rgba(255,255,255,0.5)] uppercase";
const MENU_ITEM =
  "flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg border-0 bg-transparent px-3 py-2 text-left text-[0.86rem] text-white transition-[background-color] duration-150 hover:bg-[rgba(255,255,255,0.1)] disabled:cursor-default disabled:text-[rgba(255,255,255,0.4)] disabled:hover:bg-transparent " +
  FOCUS_RING;

/* ----------------------------------------------------------------- icons -- */

const svgProps = {
  viewBox: "0 0 24 24",
  "aria-hidden": true,
  focusable: false,
} as const;
const strokeProps = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.9,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

const PlayIcon = () => (
  <svg {...svgProps}>
    <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.2-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" fill="currentColor" />
  </svg>
);
const PauseIcon = () => (
  <svg {...svgProps}>
    <rect x="6.5" y="5" width="3.6" height="14" rx="1" fill="currentColor" />
    <rect x="13.9" y="5" width="3.6" height="14" rx="1" fill="currentColor" />
  </svg>
);
const ReplayIcon = () => (
  <svg {...svgProps}>
    <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" {...strokeProps} />
    <path d="M4.2 3.8v3.6h3.6" {...strokeProps} />
  </svg>
);
/* A circling arrow with the seconds inside it. */
const SkipIcon = ({ forward }: { forward?: boolean }) => (
  <svg {...svgProps} className="overflow-visible">
    <g transform={forward ? "translate(24 0) scale(-1 1)" : undefined}>
      <path d="M5.6 8.2A7.6 7.6 0 1 1 4.4 12" {...strokeProps} />
      <path d="M5.2 3.9v4.6h4.6" {...strokeProps} />
    </g>
    <text x="12.4" y="15.3" textAnchor="middle" fill="currentColor" fontSize="7.2" fontWeight="700">
      10
    </text>
  </svg>
);
const VolumeIcon = ({ level }: { level: "muted" | "low" | "high" }) => (
  <svg {...svgProps}>
    <path d="M4 9.5h3.2L11.5 6v12l-4.3-3.5H4z" fill="currentColor" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    {level === "muted" ? (
      <path d="M15.5 9.5l5 5M20.5 9.5l-5 5" {...strokeProps} />
    ) : (
      <>
        <path d="M15 9.2a4 4 0 0 1 0 5.6" {...strokeProps} />
        {level === "high" && <path d="M17.8 6.6a7.6 7.6 0 0 1 0 10.8" {...strokeProps} />}
      </>
    )}
  </svg>
);
const GlobeIcon = () => (
  <svg {...svgProps}>
    <circle cx="12" cy="12" r="8.5" {...strokeProps} />
    <path d="M3.5 12h17M12 3.5c2.4 2.4 3.6 5.2 3.6 8.5s-1.2 6.1-3.6 8.5c-2.4-2.4-3.6-5.2-3.6-8.5S9.6 5.9 12 3.5z" {...strokeProps} />
  </svg>
);
const GearIcon = () => (
  <svg {...svgProps}>
    <path
      d="M10.3 3.6h3.4l.5 2.3 1.7 1 2.2-.8 1.7 3-1.7 1.5v2l1.7 1.5-1.7 3-2.2-.8-1.7 1-.5 2.3h-3.4l-.5-2.3-1.7-1-2.2.8-1.7-3 1.7-1.5v-2L4.2 9.1l1.7-3 2.2.8 1.7-1z"
      {...strokeProps}
    />
    <circle cx="12" cy="12" r="2.6" {...strokeProps} />
  </svg>
);
const PipIcon = () => (
  <svg {...svgProps}>
    <rect x="3" y="5" width="18" height="14" rx="2" {...strokeProps} />
    <rect x="12" y="11.5" width="6.5" height="5" rx="1" fill="currentColor" />
  </svg>
);
const FullscreenIcon = ({ exit }: { exit?: boolean }) => (
  <svg {...svgProps}>
    {exit ? (
      <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" {...strokeProps} />
    ) : (
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" {...strokeProps} />
    )}
  </svg>
);
/* A handset upright or on its side, showing where the next press takes it. */
const RotateIcon = ({ landscape }: { landscape: boolean }) => (
  <svg {...svgProps}>
    <rect
      x={landscape ? "3" : "7.5"}
      y={landscape ? "7.5" : "3"}
      width={landscape ? "18" : "9"}
      height={landscape ? "9" : "18"}
      rx="1.8"
      {...strokeProps}
    />
  </svg>
);
const CloseIcon = () => (
  <svg {...svgProps}>
    <path d="M6 6l12 12M18 6L6 18" {...strokeProps} strokeWidth={2.1} />
  </svg>
);
/* A stack of episodes: one frame in front of two behind. */
const EpisodesIcon = () => (
  <svg {...svgProps}>
    <rect x="3" y="8" width="14" height="12" rx="2" {...strokeProps} />
    <path d="M6.5 5h11A2.5 2.5 0 0 1 20 7.5V16" {...strokeProps} />
    <path d="M8.5 11.6v4.8l4-2.4z" fill="currentColor" />
  </svg>
);
const NextIcon = () => (
  <svg {...svgProps}>
    <path d="M5.5 5.6v12.8a.8.8 0 0 0 1.2.7l9.6-6.4a.8.8 0 0 0 0-1.4L6.7 4.9a.8.8 0 0 0-1.2.7z" fill="currentColor" />
    <rect x="17.4" y="5" width="2.4" height="14" rx="1" fill="currentColor" />
  </svg>
);
const CheckIcon = () => (
  <svg {...svgProps} className="size-4 flex-none">
    <path d="M5 12.5l4.5 4.5L19 7.5" {...strokeProps} strokeWidth={2.2} />
  </svg>
);

/* ------------------------------------------------------------- component -- */

export default function MoviePlayer({ title, episodeLabel, media, poster, onClose, series, onNext, resumeAt, onProgress }: MoviePlayerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [paused, setPaused] = useState(true);
  const [ended, setEnded] = useState(false);
  const [waiting, setWaiting] = useState(true);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  // "auto", or the height chosen by hand. Kept across episodes, the way a
  // chosen quality is everywhere else.
  const [quality, setQuality] = useState<"auto" | number>("auto");
  // Where to pick up after a quality change reloads the file.
  const resumeRef = useRef<{ time: number; playing: boolean } | null>(null);

  const [awake, setAwake] = useState(true);
  const [menu, setMenu] = useState<"language" | "settings" | "episodes" | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  // Where the scrubber preview sits: the time it shows, and its x within the
  // track, already clamped so the frame never runs off the player's edge.
  const [preview, setPreview] = useState<{ ratio: number; x: number } | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // One seek at a time: the latest wanted time waits for the current seek to
  // land, so fast mouse movement never queues up a backlog of stale frames.
  const previewSeekRef = useRef<{ busy: boolean; pending: number | null }>({ busy: false, pending: null });
  const [pulse, setPulse] = useState<"back" | "forward" | null>(null);

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isLandscape, setIsLandscape] = useState(false);
  const [inPip, setInPip] = useState(false);

  // Device capabilities live outside React; the server snapshot is false, so
  // these controls are absent until the client has looked.
  const canRotate = useSyncExternalStore(subscribeToPointerKind, readCanRotate, () => false);
  const isCoarse = useSyncExternalStore(subscribeToPointerKind, readIsCoarse, () => false);
  const canPip = useSyncExternalStore(noSubscribe, readCanPip, () => false);

  // Paused, finished, mid-drag or with a menu open, the controls never hide.
  const showControls = awake || paused || ended || scrubbing || menu !== null;

  /* -- waking the controls --------------------------------------------- */

  const wake = () => {
    setAwake(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setAwake(false), HIDE_AFTER_MS);
  };

  const flashSkip = (direction: "back" | "forward") => {
    if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current);
    setPulse(direction);
    pulseTimerRef.current = setTimeout(() => setPulse(null), 620);
  };

  /* -- transport ---------------------------------------------------------- */

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused || video.ended) void video.play().catch(() => undefined);
    else video.pause();
  };

  const skip = (direction: "back" | "forward") => {
    const video = videoRef.current;
    if (!video) return;
    seekBy(video, direction === "forward" ? SKIP_SECONDS : -SKIP_SECONDS);
    flashSkip(direction);
    wake();
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    // Unmuting at zero volume would change nothing you could hear.
    if (video.muted || video.volume === 0) {
      video.muted = false;
      if (video.volume === 0) video.volume = 0.6;
    } else {
      video.muted = true;
    }
  };

  const changeVolume = (value: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = value;
    video.muted = value === 0;
  };

  const changeQuality = (next: "auto" | number) => {
    const video = videoRef.current;
    setMenu(null);
    if (next === quality) return;
    if (video && video.currentSrc) resumeRef.current = { time: video.currentTime, playing: !video.paused };
    setQuality(next);
  };

  // Close means stop, not hide. Unmounting alone leaves a detached element
  // that some browsers keep playing or downloading, a pending play() that can
  // still start it, and a picture-in-picture window that keeps it alive; so
  // the film is paused and its file released before the player goes.
  const stopAndClose = () => {
    const video = videoRef.current;
    if (video) {
      report(true);
      resumeRef.current = null;
      video.pause();
      if (document.pictureInPictureElement === video) void document.exitPictureInPicture().catch(() => undefined);
      video.querySelectorAll("source").forEach((source) => source.removeAttribute("src"));
      video.removeAttribute("src");
      video.load();
    }
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    onClose();
  };

  const changeSpeed = (value: number) => {
    const video = videoRef.current;
    if (video) {
      // load() resets playbackRate to the default, so set both, or a new
      // episode or quality would quietly drop back to normal speed.
      video.defaultPlaybackRate = value;
      video.playbackRate = value;
    }
    setMenu(null);
  };

  /* -- scrubber ----------------------------------------------------------- */

  const ratioAt = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  };

  const seekToRatio = (ratio: number) => {
    const video = videoRef.current;
    if (!video || !duration) return;
    video.currentTime = ratio * duration;
    setCurrent(ratio * duration);
  };

  const seekPreview = (time: number) => {
    const video = previewVideoRef.current;
    const state = previewSeekRef.current;
    if (!video) return;
    // Before metadata there is nothing to seek; loadedmetadata picks it up.
    if (state.busy || video.readyState < 1) {
      state.pending = time;
      return;
    }
    state.busy = true;
    // fastSeek lands on the nearest keyframe, which is plenty for a thumbnail
    // and far quicker where the browser has it.
    if (typeof video.fastSeek === "function") video.fastSeek(time);
    else video.currentTime = time;
  };

  const onPreviewReady = () => {
    const state = previewSeekRef.current;
    state.busy = false;
    // Copy the landed frame onto the canvas. The canvas holds the last good
    // frame while the next seek is in flight, where a visible <video> would
    // flash black between them.
    const video = previewVideoRef.current;
    const canvas = previewCanvasRef.current;
    if (video && canvas && video.readyState >= 2) {
      canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
    }
    if (state.pending === null) return;
    const time = state.pending;
    state.pending = null;
    seekPreview(time);
  };

  const showPreviewAt = (clientX: number) => {
    const track = trackRef.current?.getBoundingClientRect();
    const root = rootRef.current?.getBoundingClientRect();
    if (!track || !root || !duration) return;
    const ratio = Math.min(1, Math.max(0, (clientX - track.left) / track.width));
    const half = (previewRef.current?.offsetWidth ?? 200) / 2;
    const edge = 12;
    const inRoot = Math.min(root.width - half - edge, Math.max(half + edge, clientX - root.left));
    setPreview({ ratio, x: inRoot - (track.left - root.left) });
    seekPreview(ratio * duration);
  };

  const onScrubDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    setScrubbing(true);
    seekToRatio(ratioAt(event.clientX));
    showPreviewAt(event.clientX);
  };
  const onScrubMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const ratio = ratioAt(event.clientX);
    // A mouse previews by hovering; a finger only while dragging.
    if (event.pointerType === "mouse" || scrubbing) showPreviewAt(event.clientX);
    if (scrubbing) seekToRatio(ratio);
  };
  const onScrubUp = (event: React.PointerEvent<HTMLDivElement>) => {
    setScrubbing(false);
    if (event.pointerType !== "mouse") setPreview(null);
    wake();
  };
  const onScrubKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const video = videoRef.current;
    if (!video) return;
    const moves: Record<string, () => void> = {
      ArrowLeft: () => seekBy(video, -5),
      ArrowRight: () => seekBy(video, 5),
      ArrowDown: () => seekBy(video, -5),
      ArrowUp: () => seekBy(video, 5),
      PageDown: () => seekBy(video, -SKIP_SECONDS),
      PageUp: () => seekBy(video, SKIP_SECONDS),
      Home: () => (video.currentTime = 0),
      End: () => (video.currentTime = duration),
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    move();
    wake();
  };

  /* -- screen modes ------------------------------------------------------- */

  const toggleFullscreen = () => {
    const root = rootRef.current;
    const video = videoRef.current as WebkitVideo | null;
    if (!root) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    if (typeof root.requestFullscreen === "function") {
      void root.requestFullscreen().catch(() => undefined);
    } else {
      video?.webkitEnterFullscreen?.();
    }
  };

  // The orientation lock is only granted to a fullscreen element, so turning
  // sideways enters fullscreen first. Going back releases both.
  const toggleOrientation = async () => {
    const root = rootRef.current;
    const orientation = window.screen?.orientation as LockableOrientation | undefined;
    if (!root || typeof orientation?.lock !== "function") return;

    if (isLandscape) {
      orientation.unlock?.();
      setIsLandscape(false);
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
      return;
    }

    if (!document.fullscreenElement) await root.requestFullscreen().catch(() => undefined);
    // A refused lock leaves the film fullscreen and upright, which is still a
    // better place to watch from than where it started.
    await orientation.lock("landscape").then(
      () => setIsLandscape(true),
      () => setIsLandscape(false),
    );
  };

  const togglePip = () => {
    const video = videoRef.current;
    if (!video) return;
    if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => undefined);
    else void video.requestPictureInPicture().catch(() => undefined);
  };

  /* -- the surface -------------------------------------------------------- */

  // A mouse click on the picture plays or pauses, as everywhere else. A tap
  // cannot mean that — you could never bring the controls up without also
  // stopping the film — so a tap only shows or hides them.
  const onSurfaceClick = () => {
    if (menu) {
      setMenu(null);
      return;
    }
    if (isCoarse) {
      if (showControls && !paused) {
        if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
        setAwake(false);
      } else {
        wake();
      }
      return;
    }
    togglePlay();
    wake();
  };

  /* -- effects ------------------------------------------------------------ */

  // Play was the gesture that opened the theatre, so starting with sound is
  // allowed. If the browser refuses anyway, the big play button is waiting.
  //
  // Keyed on the sources, so picking another episode swaps the film inside
  // the same player: fullscreen, volume and speed all carry over. <source>
  // children are only re-read on load(), so changing them alone does nothing.
  const chosen =
    quality === "auto"
      ? autoRendition(media.renditions)
      : (media.renditions.find((r) => r.height === quality) ?? autoRendition(media.renditions));
  const sources = [
    ...(chosen ? [media.startAt ? `${chosen.url}#t=${media.startAt}` : chosen.url] : []),
    ...media.fallbacks,
  ];
  const sourceKey = sources.join("|");
  const base = chosen ? (media.startAt ?? 0) : 0;
  const lastReportRef = useRef(0);
  const report = (force = false) => {
    const video = videoRef.current;
    if (!video || !onProgress || !Number.isFinite(video.duration) || video.duration <= 0) return;
    // Every 3 seconds of film, not of wall clock: a paused film has nothing new to say.
    if (!force && Math.abs(video.currentTime - lastReportRef.current) < 3) return;
    lastReportRef.current = video.currentTime;
    onProgress(Math.max(0, video.currentTime - base), Math.max(0, video.duration - base));
  };
  // The latest resume point, read by the load effect below without making it
  // reload whenever the parent re-renders.
  const resumeAtRef = useRef({ resumeAt, base });
  useEffect(() => {
    resumeAtRef.current = { resumeAt, base };
  });
  // The scrubber's thumbnails come from the smallest encode: a frame the size
  // of a stamp does not need the 4K file seeking around behind it.
  const previewSrc = media.renditions[0]?.url ?? media.fallbacks[0];
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !sourceKey) return;
    // Opening a title or episode where it was left: the metadata handler
    // below seeks there once the file is ready. A quality change sets its own
    // resume point first and wins.
    const saved = resumeAtRef.current;
    if (!resumeRef.current && saved.resumeAt && saved.resumeAt > 0) {
      resumeRef.current = { time: saved.resumeAt + saved.base, playing: true };
    }
    video.load();
    // A quality change that happened while paused stays paused.
    if (resumeRef.current && !resumeRef.current.playing) return;
    void video.play().catch(() => undefined);
  }, [sourceKey]);

  useEffect(() => {
    const root = rootRef.current;
    const video = videoRef.current;

    const onFullscreenChange = () => {
      const open = document.fullscreenElement === root;
      setIsFullscreen(open);
      // Leaving fullscreen releases the lock with it, and takes the episodes
      // panel along, since its button only exists in fullscreen.
      if (!open) {
        setIsLandscape(false);
        setMenu((current) => (current === "episodes" ? null : current));
      }
    };
    const onEnterPip = () => setInPip(true);
    const onLeavePip = () => setInPip(false);

    document.addEventListener("fullscreenchange", onFullscreenChange);
    video?.addEventListener("enterpictureinpicture", onEnterPip);
    video?.addEventListener("leavepictureinpicture", onLeavePip);

    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      video?.removeEventListener("enterpictureinpicture", onEnterPip);
      video?.removeEventListener("leavepictureinpicture", onLeavePip);
      // Closing the theatre takes every borrowed screen mode with it.
      // Also covers leaving the page without pressing close.
      video?.pause();
      if (document.fullscreenElement === root) void document.exitFullscreen().catch(() => undefined);
      if (document.pictureInPictureElement === video) void document.exitPictureInPicture().catch(() => undefined);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current);
    };
  }, []);

  // The keyboard listener is bound once; these hand it the current handlers.
  const flashSkipRef = useRef(flashSkip);
  const toggleFullscreenRef = useRef(toggleFullscreen);
  const wakeRef = useRef(wake);
  useEffect(() => {
    flashSkipRef.current = flashSkip;
    toggleFullscreenRef.current = toggleFullscreen;
    wakeRef.current = wake;
  });

  // Keyboard, the way every player does it. Keys typed into a field (the
  // search overlay) are left alone, and so are keys a focused control
  // already handles, so nothing happens twice.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const video = videoRef.current;
      const target = event.target instanceof Element ? event.target : null;
      if (!video || event.altKey || event.ctrlKey || event.metaKey) return;
      if (target?.closest("input, textarea, select, [contenteditable='true'], [role='slider'], [role='dialog']")) return;
      const onButton = !!target?.closest("button, a");

      switch (event.key) {
        case " ":
        case "k":
          if (onButton && event.key === " ") return;
          event.preventDefault();
          if (video.paused || video.ended) void video.play().catch(() => undefined);
          else video.pause();
          break;
        case "ArrowLeft":
        case "j":
          event.preventDefault();
          seekBy(video, -SKIP_SECONDS);
          flashSkipRef.current("back");
          break;
        case "ArrowRight":
        case "l":
          event.preventDefault();
          seekBy(video, SKIP_SECONDS);
          flashSkipRef.current("forward");
          break;
        case "ArrowUp":
          event.preventDefault();
          video.muted = false;
          video.volume = Math.min(1, video.volume + 0.1);
          break;
        case "ArrowDown":
          event.preventDefault();
          video.volume = Math.max(0, video.volume - 0.1);
          break;
        case "m":
          video.muted = !video.muted;
          break;
        case "f":
          toggleFullscreenRef.current();
          break;
        case "Escape":
          setMenu(null);
          return;
        default:
          return;
      }
      wakeRef.current();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // A click anywhere outside an open menu closes it.
  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-player-menu]")) return;
      setMenu(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [menu]);

  /* -- derived ------------------------------------------------------------ */

  const progress = duration > 0 ? Math.min(1, current / duration) : 0;
  const bufferedRatio = duration > 0 ? Math.min(1, buffered / duration) : 0;
  const level = muted || volume === 0 ? "muted" : volume < 0.5 ? "low" : "high";
  const fade = cx(
    "transition-opacity duration-300 ease-[ease] motion-reduce:transition-none",
    showControls ? "opacity-100" : "pointer-events-none opacity-0",
  );
  // For buttons inside a pass-through layer: pointer-events-auto on a child
  // beats none on its parent, so a hidden button would still take the tap.
  const live = showControls ? "pointer-events-auto" : "pointer-events-none";

  // With the episodes panel open, the picture and the panel are the whole
  // screen: transport steps aside, and only the title stays.
  const panelOpen = menu === "episodes" && !!series && isFullscreen;
  const barFade = panelOpen ? "pointer-events-none opacity-0 transition-opacity duration-300" : fade;
  const barLive = panelOpen ? "pointer-events-none" : live;

  const centreLabel = ended ? "Replay" : paused ? "Play" : "Pause";

  return (
    <div
      ref={rootRef}
      className={cx(
        "absolute inset-0 z-[2] overflow-hidden bg-black font-body text-white select-none [--panel-w:min(28rem,44%)] max-[900px]:[--panel-w:min(26rem,60%)]",
        !showControls && "cursor-none",
      )}
      onPointerMove={(event) => {
        if (event.pointerType === "mouse") wake();
      }}
    >
      <video
        ref={videoRef}
        className="absolute inset-0 block h-full w-full bg-black object-contain"
        poster={poster}
        playsInline
        preload="auto"
        onPlay={() => {
          setPaused(false);
          setEnded(false);
          wake();
        }}
        onPause={() => {
          setPaused(true);
          report(true);
        }}
        onEnded={() => {
          setPaused(true);
          setEnded(true);
          report(true);
        }}
        onWaiting={() => setWaiting(true)}
        onPlaying={() => setWaiting(false)}
        onCanPlay={() => setWaiting(false)}
        onLoadedMetadata={(event) => {
          const video = event.currentTarget;
          setDuration(video.duration);
          // After a quality change, carry on from the same moment.
          const resume = resumeRef.current;
          if (resume) {
            resumeRef.current = null;
            video.currentTime = Math.min(resume.time, video.duration || resume.time);
            setCurrent(video.currentTime);
          }
        }}
        onDurationChange={(event) => setDuration(event.currentTarget.duration)}
        // A new episode empties the element first; start its clock from zero
        // rather than showing the last one's position until metadata lands.
        onEmptied={() => {
          // A quality change keeps its place; only a new episode starts over.
          if (resumeRef.current) return;
          setCurrent(0);
          setDuration(0);
          setBuffered(0);
          setEnded(false);
          setWaiting(true);
        }}
        onTimeUpdate={(event) => {
          if (!scrubbing) setCurrent(event.currentTarget.currentTime);
          report();
        }}
        onProgress={(event) => {
          const ranges = event.currentTarget.buffered;
          if (ranges.length) setBuffered(ranges.end(ranges.length - 1));
        }}
        onVolumeChange={(event) => {
          setVolume(event.currentTarget.volume);
          setMuted(event.currentTarget.muted);
        }}
        onRateChange={(event) => setSpeed(event.currentTarget.playbackRate)}
      >
        {sources.map((source) => (
          // The type lets a browser skip a format it cannot play without
          // downloading it first.
          <source key={source} src={source} type={/\.webm(\?|#|$)/i.test(source) ? "video/webm" : "video/mp4"} />
        ))}
      </video>

      {/* The surface: takes clicks and taps meant for the picture itself. */}
      <div className="absolute inset-0 z-[1]" onClick={onSurfaceClick} aria-hidden="true" />

      {/* Scrims, so white controls read over a white sky. */}
      <div
        className={cx(
          "pointer-events-none absolute inset-0 z-[2] bg-[image:linear-gradient(to_bottom,rgba(0,0,0,0.72),rgba(0,0,0,0)_26%),linear-gradient(to_top,rgba(0,0,0,0.82),rgba(0,0,0,0)_38%)]",
          fade,
        )}
        aria-hidden="true"
      />

      {/* ---- top: close, and what is playing ---- */}
      <div
        className={cx(
          "absolute inset-x-0 top-0 z-[3] grid grid-cols-[2.75rem_minmax(0,1fr)_2.75rem] items-start gap-3 px-[clamp(1rem,3vw,2.25rem)] pt-[clamp(0.9rem,2.2vw,1.6rem)] transition-[padding] duration-300 max-[560px]:grid-cols-[2.25rem_minmax(0,1fr)_2.25rem] max-[560px]:px-3 max-[560px]:pt-3",
          // The title re-centres in the picture left beside the panel.
          panelOpen && "pr-[calc(var(--panel-w)+1rem)]",
          fade,
        )}
      >
        <span aria-hidden="true" />
        <div className="min-w-0 pt-1 text-center">
          <p className="text-[0.72rem] font-medium tracking-[0.04em] text-[rgba(255,255,255,0.72)] max-[560px]:text-[0.66rem]">Now playing</p>
          <h2 className="mt-1 truncate font-heading text-[clamp(1.05rem,2vw,1.5rem)] leading-tight font-semibold tracking-[-0.01em] text-white [text-shadow:0_2px_16px_rgba(0,0,0,0.5)]">
            {title}
            {episodeLabel && <span className="font-medium"> · {episodeLabel}</span>}
          </h2>
        </div>
        <button type="button" className={cx(DISC, panelOpen && "invisible")} aria-label="Close player" onClick={stopAndClose}>
          <CloseIcon />
        </button>
      </div>

      {/* ---- centre: the big play button, flanked by skips on a phone ---- */}
      <div
        className={cx(
          "pointer-events-none absolute inset-0 z-[3] flex items-center justify-center gap-[clamp(2rem,6vw,4.5rem)]",
          barFade,
        )}
      >
        <button
          type="button"
          className={cx(DISC_SKIP_CENTRE, barLive)}
          aria-label={`Back ${SKIP_SECONDS} seconds`}
          onClick={() => skip("back")}
        >
          <SkipIcon />
        </button>

        <button
          type="button"
          className={cx(DISC_HERO, barLive, waiting && !paused && "opacity-0")}
          aria-label={centreLabel}
          onClick={() => {
            togglePlay();
            wake();
          }}
        >
          {ended ? <ReplayIcon /> : paused ? <PlayIcon /> : <PauseIcon />}
        </button>

        <button
          type="button"
          className={cx(DISC_SKIP_CENTRE, barLive)}
          aria-label={`Forward ${SKIP_SECONDS} seconds`}
          onClick={() => skip("forward")}
        >
          <SkipIcon forward />
        </button>
      </div>

      {/* Buffering: a ring where the play button was, always visible. */}
      {waiting && !paused && (
        <div className="pointer-events-none absolute top-1/2 left-1/2 z-[3] size-14 -translate-1/2 animate-spin rounded-full border-[3px] border-[rgba(255,255,255,0.22)] border-t-white motion-reduce:animate-none" aria-hidden="true" />
      )}

      {pulse && (
        <div
          className={cx(
            "pointer-events-none absolute top-1/2 z-[4] grid size-[clamp(4.5rem,8vw,6rem)] animate-skip-flash place-items-center rounded-full bg-[rgba(0,0,0,0.45)] text-[clamp(1rem,1.8vw,1.35rem)] font-semibold text-white backdrop-blur-[10px] motion-reduce:animate-none motion-reduce:opacity-100",
            pulse === "back" ? "left-[18%] max-[560px]:left-[6%]" : "right-[18%] max-[560px]:right-[6%]",
          )}
          aria-hidden="true"
        >
          {pulse === "back" ? `−${SKIP_SECONDS}` : `+${SKIP_SECONDS}`}
        </div>
      )}

      {/* ---- bottom: time, scrubber, and the two button rows ---- */}
      <div
        className={cx(
          "absolute inset-x-0 bottom-0 z-[4] px-[clamp(1rem,3vw,2.25rem)] pb-[clamp(0.9rem,2.2vw,1.6rem)] max-[560px]:px-3 max-[560px]:pb-3",
          barFade,
        )}
      >
        <div className="flex items-center gap-[clamp(0.7rem,1.4vw,1.1rem)] text-[0.8rem] font-medium text-white tabular-nums max-[560px]:gap-2.5 max-[560px]:text-[0.72rem]">
          <span className="min-w-[2.6rem] text-left">{formatTime(current)}</span>

          <div
            ref={trackRef}
            role="slider"
            tabIndex={0}
            aria-label="Seek"
            aria-valuemin={0}
            aria-valuemax={Math.round(duration)}
            aria-valuenow={Math.round(current)}
            aria-valuetext={`${formatTime(current)} of ${formatTime(duration)}`}
            className={cx("group/scrub relative flex h-6 flex-1 cursor-pointer touch-none items-center rounded-full", FOCUS_RING)}
            onPointerDown={onScrubDown}
            onPointerMove={onScrubMove}
            onPointerUp={onScrubUp}
            onPointerCancel={onScrubUp}
            onPointerLeave={() => {
              if (!scrubbing) setPreview(null);
            }}
            onKeyDown={onScrubKey}
          >
            <div className="relative h-[3px] w-full overflow-hidden rounded-full bg-[rgba(255,255,255,0.24)] transition-[height] duration-150 group-hover/scrub:h-[5px] motion-reduce:transition-none">
              <div className="absolute inset-y-0 left-0 bg-[rgba(255,255,255,0.38)]" style={{ width: `${bufferedRatio * 100}%` }} />
              {/* How far a click would take you, lighter than what is played. */}
              {preview && !scrubbing && (
                <div className="absolute inset-y-0 left-0 bg-[rgba(255,255,255,0.55)]" style={{ width: `${preview.ratio * 100}%` }} />
              )}
              <div className="absolute inset-y-0 left-0 bg-[#ff3040]" style={{ width: `${progress * 100}%` }} />
            </div>
            <div
              className={cx(
                "pointer-events-none absolute top-1/2 size-3.5 -translate-1/2 rounded-full bg-white shadow-[0_0_0_4px_rgba(255,48,64,0.35)] transition-[scale] duration-150 group-hover/scrub:scale-110 motion-reduce:transition-none",
                scrubbing && "scale-125",
              )}
              style={{ left: `${progress * 100}%` }}
              aria-hidden="true"
            />
            {/* The frame at the pointer, with its time beneath. Always mounted,
                just hidden, so the small preview file has its metadata ready
                before the first hover. */}
            <div
              ref={previewRef}
              className={cx(
                "pointer-events-none absolute bottom-[calc(100%+0.85rem)] left-0 flex -translate-x-1/2 flex-col items-center gap-2 transition-opacity duration-150 motion-reduce:transition-none",
                preview && duration > 0 ? "opacity-100" : "invisible opacity-0",
              )}
              style={{ left: preview ? `${preview.x}px` : undefined }}
              aria-hidden="true"
            >
              <div
                className={cx(
                  "aspect-video w-[clamp(9.5rem,15vw,13rem)] overflow-hidden rounded-xl border-2 border-[rgba(255,255,255,0.85)] bg-black shadow-[0_14px_36px_rgba(0,0,0,0.6)]",
                  previewFailed && "hidden",
                )}
              >
                <canvas ref={previewCanvasRef} width={320} height={180} className="block h-full w-full" />
                {/* The source of the frames, never shown itself. */}
                <video
                  ref={previewVideoRef}
                  key={previewSrc}
                  className="hidden"
                  src={previewSrc}
                  muted
                  playsInline
                  preload="metadata"
                  tabIndex={-1}
                  onLoadedMetadata={onPreviewReady}
                  onLoadedData={onPreviewReady}
                  onSeeked={onPreviewReady}
                  onError={() => setPreviewFailed(true)}
                />
              </div>
              <span className="rounded-md bg-[rgba(0,0,0,0.82)] px-2.5 py-1 text-[0.82rem] leading-none font-bold text-white tabular-nums shadow-[0_4px_14px_rgba(0,0,0,0.4)]">
                {formatTime((preview?.ratio ?? 0) * duration)}
              </span>
            </div>
          </div>

          <span className="min-w-[2.6rem] text-right">{formatTime(duration)}</span>
        </div>

        <div className="mt-[clamp(0.55rem,1.2vw,0.85rem)] flex items-center justify-between gap-2">
          <div className="flex items-center gap-[clamp(0.45rem,0.9vw,0.7rem)]">
            {/* A phone has play and the skips in the middle of the screen. */}
            <button type="button" className={cx(DISC, "max-[560px]:hidden")} aria-label={ended ? "Replay" : paused ? "Play" : "Pause"} onClick={togglePlay}>
              {ended ? <ReplayIcon /> : paused ? <PlayIcon /> : <PauseIcon />}
            </button>
            <button type="button" className={cx(DISC, "max-[560px]:hidden")} aria-label={`Back ${SKIP_SECONDS} seconds`} onClick={() => skip("back")}>
              <SkipIcon />
            </button>
            <button type="button" className={cx(DISC, "max-[560px]:hidden")} aria-label={`Forward ${SKIP_SECONDS} seconds`} onClick={() => skip("forward")}>
              <SkipIcon forward />
            </button>

            {/* The level slider slides out of the mute button on hover. Touch
                screens set volume with the hardware keys, so they get mute. */}
            <div className="group/volume flex items-center rounded-full transition-[background-color] duration-200 hover:bg-[rgba(255,255,255,0.08)] focus-within:bg-[rgba(255,255,255,0.08)]">
              <button type="button" className={DISC} aria-label={level === "muted" ? "Unmute" : "Mute"} onClick={toggleMute}>
                <VolumeIcon level={level} />
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={muted ? 0 : volume}
                aria-label="Volume"
                className="player-volume w-0 opacity-0 transition-[width,opacity,margin] duration-200 ease-[ease] group-hover/volume:mx-3 group-hover/volume:w-20 group-hover/volume:opacity-100 focus-visible:mx-3 focus-visible:w-20 focus-visible:opacity-100 group-focus-within/volume:mx-3 group-focus-within/volume:w-20 group-focus-within/volume:opacity-100 pointer-coarse:hidden motion-reduce:transition-none"
                style={{ "--fill": `${(muted ? 0 : volume) * 100}%` } as React.CSSProperties}
                onChange={(event) => changeVolume(Number(event.currentTarget.value))}
              />
            </div>
          </div>

          <div className="flex items-center gap-[clamp(0.45rem,0.9vw,0.7rem)] max-[560px]:gap-1.5">
            <div className="relative" data-player-menu>
              <button
                type="button"
                className={DISC}
                aria-label="Audio and subtitles"
                aria-haspopup="menu"
                aria-expanded={menu === "language"}
                onClick={() => setMenu((open) => (open === "language" ? null : "language"))}
              >
                <GlobeIcon />
              </button>
              {menu === "language" && (
                <div className={MENU} role="menu" aria-label="Audio and subtitles">
                  <p className={MENU_HEADING}>Audio</p>
                  <button type="button" role="menuitemradio" aria-checked="true" className={MENU_ITEM} onClick={() => setMenu(null)}>
                    English <span className="ml-auto text-[0.72rem] text-[rgba(255,255,255,0.5)]">Original</span>
                    <CheckIcon />
                  </button>
                  <p className={cx(MENU_HEADING, "mt-1")}>Subtitles</p>
                  <button type="button" role="menuitemradio" aria-checked="true" className={MENU_ITEM} onClick={() => setMenu(null)}>
                    Off
                    <CheckIcon />
                  </button>
                  {/* Listed but disabled: no title carries a caption file yet,
                      and a switch that changes nothing is worse than none. */}
                  <button type="button" role="menuitemradio" aria-checked="false" className={MENU_ITEM} disabled>
                    English
                    <span className="text-[0.72rem]">Not available</span>
                  </button>
                </div>
              )}
            </div>

            <div className="relative" data-player-menu>
              <button
                type="button"
                className={DISC}
                aria-label="Settings"
                aria-haspopup="menu"
                aria-expanded={menu === "settings"}
                onClick={() => setMenu((open) => (open === "settings" ? null : "settings"))}
              >
                <GearIcon />
              </button>
              {menu === "settings" && (
                <div className={MENU} role="menu" aria-label="Settings">
                  <p className={MENU_HEADING}>Playback speed</p>
                  <div className="grid grid-cols-3 gap-1 px-1 pb-1">
                    {SPEEDS.map((value) => (
                      <button
                        key={value}
                        type="button"
                        role="menuitemradio"
                        aria-checked={speed === value}
                        className={cx(
                          "cursor-pointer rounded-lg border-0 px-2 py-2 text-[0.8rem] font-medium transition-[background-color] duration-150 " + FOCUS_RING,
                          speed === value ? "bg-white text-black" : "bg-[rgba(255,255,255,0.06)] text-white hover:bg-[rgba(255,255,255,0.14)]",
                        )}
                        onClick={() => changeSpeed(value)}
                      >
                        {value === 1 ? "Normal" : `${value}×`}
                      </button>
                    ))}
                  </div>
                  <p className={cx(MENU_HEADING, "mt-1")}>Quality</p>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={quality === "auto"}
                    className={MENU_ITEM}
                    onClick={() => changeQuality("auto")}
                  >
                    <span>
                      Auto
                      {quality === "auto" && chosen && (
                        <span className="ml-1.5 text-[0.74rem] text-[rgba(255,255,255,0.5)]">{qualityLabel(chosen.height)}</span>
                      )}
                    </span>
                    {quality === "auto" && <CheckIcon />}
                  </button>
                  {/* Lowest to highest, the way the files step up. */}
                  {media.renditions.map((rendition) => {
                    const badge = qualityBadge(rendition.height);
                    const active = quality === rendition.height;
                    return (
                      <button
                        key={rendition.height}
                        type="button"
                        role="menuitemradio"
                        aria-checked={active}
                        className={MENU_ITEM}
                        onClick={() => changeQuality(rendition.height)}
                      >
                        <span className="flex items-center gap-2 tabular-nums">
                          {qualityLabel(rendition.height)}
                          {badge && (
                            <span
                              className={cx(
                                "rounded-[4px] px-1 py-px text-[0.56rem] leading-none font-bold tracking-[0.06em]",
                                rendition.height >= 2160 ? "bg-[#ff3040] text-white" : "bg-[rgba(255,255,255,0.16)] text-[rgba(255,255,255,0.85)]",
                              )}
                            >
                              {badge}
                            </span>
                          )}
                        </span>
                        {active && <CheckIcon />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Fullscreen only. In the page the episode row sits right under
                the player, so a second way in would only crowd the bar; in
                fullscreen that row is out of reach, and this is the way to it.
                Beside Settings and labelled; on a phone just the disc. */}
            {series && isFullscreen && (
              <button
                type="button"
                className={EPISODES_PILL}
                aria-label="Episodes"
                aria-haspopup="dialog"
                aria-expanded={panelOpen}
                data-player-menu
                onClick={() => setMenu((open) => (open === "episodes" ? null : "episodes"))}
              >
                <EpisodesIcon />
                <span className="text-[0.8rem] font-semibold tracking-[0.01em] max-[560px]:hidden">Episodes</span>
              </button>
            )}

            {onNext && (
              <button type="button" className={DISC} aria-label="Next episode" onClick={onNext}>
                <NextIcon />
              </button>
            )}

            {canPip && (
              <button type="button" className={cx(DISC, onNext && "max-[400px]:hidden")} aria-label={inPip ? "Exit picture-in-picture" : "Picture-in-picture"} aria-pressed={inPip} onClick={togglePip}>
                <PipIcon />
              </button>
            )}

            {canRotate && (
              <button
                type="button"
                className={DISC}
                aria-label={isLandscape ? "Back to portrait" : "Watch in landscape"}
                aria-pressed={isLandscape}
                onClick={toggleOrientation}
              >
                <RotateIcon landscape={isLandscape} />
              </button>
            )}

            <button type="button" className={DISC} aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"} onClick={toggleFullscreen}>
              <FullscreenIcon exit={isFullscreen} />
            </button>
          </div>
        </div>
      </div>

      {panelOpen && series && (
        <EpisodesPanel series={series} progress={progress} onDismiss={() => setMenu(null)} />
      )}
    </div>
  );
}

/* --------------------------------------------------------- episodes panel -- */

/* Light glass: the picture stays legible through it, so switching episodes
   never feels like leaving the film. */
const TAB = "cursor-pointer rounded-lg border-0 px-3 py-1.5 text-[0.8rem] font-semibold transition-[background-color,color] duration-200 " + FOCUS_RING;

function EpisodesPanel({
  series,
  progress,
  onDismiss,
}: {
  series: PlayerSeries;
  progress: number;
  onDismiss: () => void;
}) {
  const { seasons, current, fallbackStill, onSelect, suggestions = [], onOpenTitle } = series;
  // Always opens on Episodes: that is the button that was pressed.
  const [tab, setTab] = useState<"episodes" | "extras">(current === "trailer" && seasons.length > 0 ? "extras" : "episodes");
  // Opens on the season being watched, not the first one.
  const [seasonNumber, setSeasonNumber] = useState(current === "trailer" ? seasons[0]?.number : current.season);
  const season = seasons.find((s) => s.number === seasonNumber) ?? seasons[0];
  const listRef = useRef<HTMLDivElement | null>(null);

  // Bring the playing episode into view when the panel opens on its season.
  useEffect(() => {
    listRef.current?.querySelector("[aria-current='true']")?.scrollIntoView({ block: "center" });
  }, [seasonNumber, tab]);

  return (
    <div
      role="dialog"
      aria-label="Episodes"
      data-player-menu
      className="absolute inset-y-0 right-0 z-[6] flex w-(--panel-w) max-w-full animate-sheet-in flex-col border-l border-[rgba(255,255,255,0.12)] bg-[rgba(52,52,56,0.42)] shadow-[-24px_0_60px_rgba(0,0,0,0.35)] backdrop-blur-[26px] backdrop-saturate-150 motion-reduce:animate-none max-[560px]:w-full max-[560px]:border-l-0"
    >
      <div className="flex items-center justify-between gap-3 px-3 pt-3">
        <div className="flex items-center gap-1" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "episodes"}
            className={cx(TAB, tab === "episodes" ? "bg-[rgba(255,255,255,0.16)] text-white" : "bg-transparent text-[rgba(255,255,255,0.6)] hover:text-white")}
            onClick={() => setTab("episodes")}
          >
            Episodes
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "extras"}
            className={cx(TAB, tab === "extras" ? "bg-[rgba(255,255,255,0.16)] text-white" : "bg-transparent text-[rgba(255,255,255,0.6)] hover:text-white")}
            onClick={() => setTab("extras")}
          >
            Trailers &amp; extras
          </button>
        </div>
        <button
          type="button"
          className={cx("inline-grid size-9 flex-none cursor-pointer place-items-center rounded-lg border-0 bg-transparent text-white transition-[background-color] duration-200 hover:bg-[rgba(255,255,255,0.14)] [&_svg]:size-[18px]", FOCUS_RING)}
          aria-label="Close episodes"
          onClick={onDismiss}
        >
          <CloseIcon />
        </button>
      </div>

      {tab === "episodes" && seasons.length > 0 && (
        <div className="flex items-center gap-1 overflow-x-auto px-4 pt-4 pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <span className="mr-2 text-[0.66rem] font-bold tracking-[0.14em] text-[rgba(255,255,255,0.6)] uppercase">Season</span>
          {seasons.map((s) => (
            <button
              key={s.number}
              type="button"
              aria-pressed={s.number === season?.number}
              aria-label={`Season ${s.number}`}
              className={cx(
                "inline-grid h-7 min-w-7 flex-none cursor-pointer place-items-center rounded-md border-0 px-1.5 text-[0.8rem] font-semibold tabular-nums transition-[background-color,color] duration-200",
                FOCUS_RING,
                s.number === season?.number ? "bg-[#ff3040] text-white" : "bg-transparent text-[rgba(255,255,255,0.72)] hover:bg-[rgba(255,255,255,0.12)] hover:text-white",
              )}
              onClick={() => setSeasonNumber(s.number)}
            >
              {s.number}
            </button>
          ))}
        </div>
      )}

      <div ref={listRef} className={cx("flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain px-3 pb-3", tab === "extras" && "pt-4")}>
        {tab === "episodes" &&
          season?.episodes.map((episode) => {
            const isCurrent = current !== "trailer" && current.season === season.number && current.episode === episode.number;
            return (
              <EpisodeCard
                key={episode.number}
                still={episode.still || fallbackStill}
                meta={`${episodeCode(season.number, episode.number)} · ${episode.duration}`}
                title={episode.title}
                number={String(episode.number)}
                isCurrent={isCurrent}
                progress={isCurrent ? progress : 0}
                onPick={() => onSelect({ season: season.number, episode: episode.number })}
              />
            );
          })}

        {tab === "episodes" && seasons.length === 0 && (
          <>
            <div className="px-1.5 pt-4 pb-2">
              <p className="text-[0.95rem] font-semibold text-white">No episodes for this one</p>
              <p className="mt-1 text-[0.82rem] leading-relaxed text-[rgba(255,255,255,0.66)]">
                It is a film, so it plays in one go. These series have seasons and episodes to switch between.
              </p>
            </div>
            {suggestions.map((item) => (
              <EpisodeCard
                key={item.id}
                still={item.still}
                meta={item.meta}
                title={item.title}
                isCurrent={false}
                progress={0}
                onPick={() => onOpenTitle?.(item.id)}
              />
            ))}
          </>
        )}

        {tab === "extras" && (
          <EpisodeCard
            still={fallbackStill}
            meta="Trailer"
            title="Official trailer"
            isCurrent={current === "trailer"}
            progress={current === "trailer" ? progress : 0}
            onPick={() => onSelect("trailer")}
          />
        )}
      </div>
    </div>
  );
}

function EpisodeCard({
  still,
  meta,
  title,
  number,
  isCurrent,
  progress,
  onPick,
}: {
  still: string;
  meta: string;
  title: string;
  number?: string;
  isCurrent: boolean;
  progress: number;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={isCurrent}
      className={cx(
        "group/ep grid w-full flex-none cursor-pointer grid-cols-[minmax(0,10.5rem)_minmax(0,1fr)_auto] items-center gap-4 rounded-xl border p-3.5 text-left transition-[background-color,border-color] duration-200 max-[400px]:grid-cols-[minmax(0,8.5rem)_minmax(0,1fr)_auto] max-[400px]:gap-3 max-[400px]:p-2.5",
        FOCUS_RING,
        isCurrent
          ? "border-[rgba(255,255,255,0.22)] bg-[rgba(255,255,255,0.2)]"
          : "border-[rgba(255,255,255,0.06)] bg-[rgba(255,255,255,0.08)] hover:bg-[rgba(255,255,255,0.15)]",
      )}
      onClick={onPick}
    >
      <span className="relative block aspect-video overflow-hidden rounded-md bg-[rgba(0,0,0,0.3)]">
        {/* eslint-disable-next-line @next/next/no-img-element -- remote stills, same as every card */}
        <img src={still} alt="" loading="lazy" className="block h-full w-full object-cover" />
        <span
          className={cx(
            "absolute inset-0 grid place-items-center bg-[rgba(0,0,0,0.18)] text-white transition-opacity duration-200 [&_svg]:size-6 [&_svg]:drop-shadow-[0_2px_6px_rgba(0,0,0,0.6)]",
            isCurrent ? "opacity-100 [&_svg]:text-[#ff3040]" : "opacity-0 group-hover/ep:opacity-100 group-focus-visible/ep:opacity-100",
          )}
          aria-hidden="true"
        >
          <PlayIcon />
        </span>
        {isCurrent && (
          <span className="absolute inset-x-0 bottom-0 h-[3px] bg-[rgba(255,255,255,0.25)]" aria-hidden="true">
            <span className="block h-full bg-[#ff3040]" style={{ width: `${progress * 100}%` }} />
          </span>
        )}
      </span>

      <span className="min-w-0">
        <span className="block text-[0.62rem] font-bold tracking-[0.08em] text-[rgba(255,255,255,0.62)] uppercase">
          {isCurrent ? <span className="text-[#ff3040]">Playing · </span> : null}
          {meta}
        </span>
        <span className="mt-1 line-clamp-2 block text-[0.94rem] leading-snug font-semibold text-white max-[400px]:text-[0.86rem]">{title}</span>
      </span>

      {number ? (
        <span
          className={cx(
            "pr-1 font-heading text-[2.6rem] leading-none font-bold tabular-nums max-[400px]:text-[2rem]",
            isCurrent ? "text-[#ff3040]" : "text-[rgba(255,255,255,0.22)]",
          )}
          aria-hidden="true"
        >
          {number}
        </span>
      ) : (
        <span aria-hidden="true" />
      )}
    </button>
  );
}
