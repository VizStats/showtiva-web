"use client";

// "Premium Minimal" detail page.
//
// Confident restraint: near-black, near-white, one mid-grey, and a single
// accent that appears exactly once (the rating). No pills, no badges, no card
// borders — metadata is quiet inline text on hairline dividers. Type carries
// the hierarchy; the artwork appears once, full-bleed and unadorned.
//
// Spacing runs on a single rhythm unit (--step) and its halves, so every
// section lands on the same vertical grid at every breakpoint.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import Link from "next/link";
import { useRouter } from "next/navigation";

import { cx } from "@/lib/cx";
import { getSignupHref, isDemoSignedIn } from "../../_auth/demo-auth";
import ProfileMenu from "../../_auth/ProfileMenu";
import type { Episode, Movie } from "@/lib/content-types";
import type { Brand, DetailLabels, FooterContent, PopoverLabels } from "@/lib/site-types";
import PosterCard from "../PosterCard";
import MoviePlayer, { episodeCode, type PlayerMedia, type PlayerPick, type Rendition } from "./MoviePlayer";
import SearchOverlay from "../SearchOverlay";
import {
  fractionWatched,
  parsePick,
  parseProgress,
  progressKey,
  readRaw,
  resumeSeconds,
  saveProgress,
  subscribeProgress,
} from "@/lib/watch-progress";
import SiteFooter from "../SiteFooter";
import TitlePopover, { useTitlePopover } from "../TitlePopover";

interface DetailClientProps {
  movie: Movie;
  related: Movie[];
  /** Whole catalog, for the global search overlay. */
  allMovies: Movie[];
  brand: Brand;
  footer: FooterContent;
  labels: DetailLabels;
  popoverLabels: PopoverLabels;
}

/* ------------------------------------------------------------- styling -- */

/* Page-wide tokens: the shell width, the gutter, and the rhythm unit. */
const PAGE =
  "relative flex w-full min-h-dvh flex-1 flex-col bg-black font-body text-ink antialiased [--gutter:48px] [--shell-max:1480px] max-[768px]:[--gutter:20px] [--step:clamp(3.5rem,7.5vw,6.5rem)]";
const SHELL = "mx-auto w-full max-w-(--shell-max) px-(--gutter)";
const FOCUS_RING = "focus-visible:outline-1 focus-visible:outline-offset-4 focus-visible:outline-ink";

/* Stand-in footage. No title in the store has a playable file yet (a TMDB
   trailer is a YouTube page, which a <video> cannot play), so the player runs
   Big Buck Bunny — an open-licence (CC BY 3.0, Blender Foundation), all-ages
   short in landscape — from Wikimedia Commons, which serves it at every size
   from 240p to 4K, so the quality menu switches real files. After those, a
   10-second H.264 cut for browsers without WebM (older iPhones), and the
   site's own clip last, which is portrait, so it is only there if both hosts
   are unreachable. (The W3C's copy fails to decode in current Chrome.) A real
   file on a title replaces all of it. */
const STAND_IN_RENDITIONS: Rendition[] = [240, 360, 480, 720, 1080, 1440, 2160].map((height) => ({
  height,
  url: `https://upload.wikimedia.org/wikipedia/commons/transcoded/c/c0/Big_Buck_Bunny_4K.webm/Big_Buck_Bunny_4K.webm.${height}p.vp9.webm`,
}));
const STAND_IN_FALLBACKS = [
  "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_1MB.mp4",
  "/bg_video_5.mp4",
];
const PLAYABLE = /\.(mp4|webm|m4v)(\?|#|$)/i;

/**
 * What to play for a file URL that may be missing. `startAt` opens the
 * stand-in part way through, so each episode opens on a different scene
 * instead of every one looking like the same video restarted. Only the long
 * renditions take it; the ten-second fallback would run off its own end.
 */
function mediaFor(url: string | null, startAt = 0): PlayerMedia {
  if (url && PLAYABLE.test(url)) return { renditions: [], fallbacks: [url] };
  return { renditions: STAND_IN_RENDITIONS, fallbacks: STAND_IN_FALLBACKS, startAt };
}

function standInOffset(season: number, episode: number) {
  return (season * 97 + episode * 53) % 560;
}

/* The action pair: see the slant utilities in globals.css.

   The pair only reads as one unit split by a single diagonal while the two
   buttons sit side by side — stacked, the lead's right-hand cut and the
   trail's left-hand cut face nothing and each button is just a lone
   parallelogram. So rather than going full-width on a narrow screen, the pair
   shrinks enough to stay on one line: at these metrics it measures ~248px,
   which clears the 280px a 320px viewport leaves inside the gutter. */
const ACTION =
  "[--btn-h:3.25rem] [--slant:calc(var(--btn-h)/3)] inline-flex h-(--btn-h) cursor-pointer items-center justify-center gap-[0.7rem] rounded-none border-0 text-[0.78rem] font-semibold tracking-[0.16em] uppercase transition-[background-color,border-color,color] duration-300 ease-[ease] max-[480px]:[--btn-h:2.75rem] max-[480px]:gap-2 max-[480px]:text-[0.7rem] max-[480px]:tracking-[0.12em] motion-reduce:transition-none " +
  FOCUS_RING;

/* ----------------------------------------------------------- component -- */

export default function DetailClient({
  movie,
  related,
  allMovies,
  brand,
  footer,
  labels,
  popoverLabels,
}: DetailClientProps) {
  const router = useRouter();
  const [saved, setSaved] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  // Play opens the film in a window centred over the page, with the page
  // blurred behind it. The player's own fullscreen button takes it to the
  // whole screen from there.
  const [playing, setPlaying] = useState(false);

  // A series plays episodes; Play starts wherever the pick is, S1:E1 until
  // something else is chosen. A film only ever plays its trailer.
  const seasons = movie.seasons ?? [];
  const isSeries = seasons.length > 0 && seasons[0].episodes.length > 0;
  const [pick, setPick] = useState<PlayerPick>(() =>
    isSeries ? { season: seasons[0].number, episode: seasons[0].episodes[0].number } : "trailer",
  );
  // The season the page's list shows. Follows the player when it moves on,
  // but browsing another season on the page does not change what is playing.
  const [listSeasonNumber, setListSeasonNumber] = useState(seasons[0]?.number ?? 1);

  // The episode row scrolls sideways; the arrows know when there is nowhere
  // further to go.
  const episodeRowRef = useRef<HTMLOListElement | null>(null);
  const [rowEdges, setRowEdges] = useState({ atStart: true, atEnd: false });

  // A title opens at its title, not part way down it.
  //
  // next/link keeps the scroll position when the incoming page is already
  // visible in the viewport — documented behaviour, not a bug — and this
  // page's root spans the whole document, so it always counts as visible and
  // the scroll is never reset. Arriving from a scrolled catalog therefore
  // dropped you into the middle of a title you had not seen the top of.
  // Keyed on the id so stepping between related titles resets too.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [movie.id]);

  // While the window is open the page behind it stays put: no scrolling the
  // blurred page around under the film.
  useEffect(() => {
    if (!playing) return;
    const html = document.documentElement;
    const previous = html.style.overflow;
    html.style.overflow = "hidden";
    return () => {
      html.style.overflow = previous;
    };
  }, [playing]);

  // --- related grid state ---
  const [bookmarked, setBookmarked] = useState<{ [key: string]: boolean }>({});
  const popover = useTitlePopover();

  const toggleBookmark = (movieId: string) => {
    if (!isDemoSignedIn()) {
      router.push(getSignupHref());
      return;
    }

    setBookmarked((prev) => ({ ...prev, [movieId]: !prev[movieId] }));
  };

  const requireAuth = (action: () => void, returnTo?: string) => {
    if (isDemoSignedIn()) {
      action();
      return;
    }

    router.push(getSignupHref(returnTo));
  };

  // How far this title has been watched on this device. The stored string is
  // the snapshot, so an unchanged entry never re-renders the page; the server
  // has no storage, so it renders the no-progress state.
  const progressRaw = useSyncExternalStore(subscribeProgress, () => readRaw(movie.id), () => null);
  const progress = useMemo(() => parseProgress(progressRaw), [progressRaw]);

  // The last thing played here, if it still exists in the title.
  const savedPick = (() => {
    const candidate = progress ? parsePick(progress.last) : null;
    if (!candidate) return null;
    if (candidate === "trailer") return isSeries ? null : candidate;
    const exists = seasons.some((s) => s.number === candidate.season && s.episodes.some((e) => e.number === candidate.episode));
    return exists ? candidate : null;
  })();
  const savedPosition = savedPick && progress ? progress.items[progressKey(savedPick)] : undefined;
  const watchedFraction = fractionWatched(savedPosition);
  const canResume = resumeSeconds(savedPosition) > 0;

  // Play picks up where this device left off: the same episode, the same moment.
  const startPlayer = () => {
    if (savedPick) setPick(savedPick);
    if (savedPick && savedPick !== "trailer") setListSeasonNumber(savedPick.season);
    setPlaying(true);
  };

  // Every episode in watching order, for "next".
  const episodeOrder: { season: number; episode: number }[] = seasons.flatMap((season) =>
    season.episodes.map((episode) => ({ season: season.number, episode: episode.number })),
  );
  const pickedEpisode: Episode | null =
    pick === "trailer"
      ? null
      : (seasons.find((season) => season.number === pick.season)?.episodes.find((episode) => episode.number === pick.episode) ?? null);
  const pickIndex = pick === "trailer" ? -1 : episodeOrder.findIndex((e) => e.season === pick.season && e.episode === pick.episode);
  const nextPick = pickIndex >= 0 ? episodeOrder[pickIndex + 1] : undefined;

  // For a film's episodes panel: somewhere that does have episodes.
  const seriesSuggestions = isSeries
    ? []
    : allMovies
        .filter((m) => (m.seasons?.length ?? 0) > 0)
        .slice(0, 8)
        .map((m) => ({ id: m.id, title: m.title, still: m.backdrop, meta: `Series · ${m.duration}` }));

  const choose = (next: PlayerPick) => {
    setPick(next);
    if (next !== "trailer") setListSeasonNumber(next.season);
  };

  // From the list on the page: opens the window on that episode.
  const playFromList = (next: PlayerPick) => {
    choose(next);
    setPlaying(true);
  };

  const readRowEdges = () => {
    const row = episodeRowRef.current;
    if (!row) return;
    const atStart = row.scrollLeft <= 2;
    const atEnd = row.scrollLeft + row.clientWidth >= row.scrollWidth - 2;
    setRowEdges((prev) => (prev.atStart === atStart && prev.atEnd === atEnd ? prev : { atStart, atEnd }));
  };

  // A page of cards at a time, less one, so the last card seen stays on
  // screen as the anchor for where you were.
  const scrollRow = (direction: 1 | -1) => {
    const row = episodeRowRef.current;
    if (!row) return;
    const card = row.querySelector("li");
    const step = card ? card.getBoundingClientRect().width + 16 : row.clientWidth * 0.8;
    const perPage = Math.max(1, Math.floor(row.clientWidth / step) - 1);
    row.scrollBy({ left: direction * step * perPage, behavior: "smooth" });
  };

  // Edges are measured whenever the row's size or content changes: on load,
  // on resize, and when another season swaps the cards in.
  useEffect(() => {
    const row = episodeRowRef.current;
    if (!row) return;
    const observer = new ResizeObserver(() => readRowEdges());
    observer.observe(row);
    if (row.firstElementChild) observer.observe(row.firstElementChild);
    return () => observer.disconnect();
  }, [listSeasonNumber]);

  // The episode playing slides into view in the row, wherever it was chosen.
  useEffect(() => {
    const row = episodeRowRef.current;
    const card = row?.querySelector<HTMLElement>("[aria-current='true']")?.closest("li");
    if (!row || !card) return;
    const left = card.offsetLeft - row.offsetLeft - parseFloat(getComputedStyle(row).paddingLeft);
    row.scrollTo({ left: Math.max(0, left), behavior: "smooth" });
  }, [pick, listSeasonNumber, playing]);

  const toggleCurrentSaved = () => {
    requireAuth(() => setSaved((value) => !value));
  };

  // The player exits fullscreen and picture-in-picture as it unmounts.
  const closePlayer = () => {
    setPlaying(false);
  };

  // `||`, not `??`, throughout: the store's validator accepts "" as well as
  // null for the nullable fields, and an empty string would slip past `??` —
  // printing a blank meta cell, or a broken image for an empty src.
  const kind = movie.type || labels.typeFallback;

  // Built as a list so a blank field drops out entirely rather than leaving a
  // hairline divider with nothing beside it.
  const meta: { key: string; text: string; accent?: boolean }[] = [
    { key: "year", text: movie.year },
    // The one place the accent is allowed to appear.
    { key: "rating", text: movie.rating, accent: true },
    { key: "duration", text: movie.duration },
    { key: "type", text: kind },
    { key: "quality", text: labels.qualityBadge },
  ].filter((item) => item.text.trim().length > 0);
  const playerNode = (
    <MoviePlayer
      title={movie.title}
      episodeLabel={
        pickedEpisode && pick !== "trailer"
          ? `S${pick.season}:E${pick.episode} · ${pickedEpisode.title}`
          : isSeries
            ? "Trailer"
            : undefined
      }
      media={
        pickedEpisode && pick !== "trailer"
          ? mediaFor(pickedEpisode.videoUrl, standInOffset(pick.season, pick.episode))
          : mediaFor(movie.trailerUrl)
      }
      poster={pickedEpisode?.still || movie.backdrop}
      onClose={closePlayer}
      series={{
        seasons: isSeries ? seasons : [],
        current: pick,
        fallbackStill: movie.backdrop,
        onSelect: choose,
        suggestions: seriesSuggestions,
        onOpenTitle: (id) => router.push(`/watch/${id}`),
      }}
      onNext={nextPick ? () => choose(nextPick) : undefined}
      resumeAt={resumeSeconds(progress?.items[progressKey(pick)])}
      onProgress={(seconds, length) => saveProgress(movie.id, progressKey(pick), seconds, length)}
    />
  );

  // Title, meta, description and the action pair: above the still in v1,
  // inside the banner's blur in v2.
  const info = (
    <>
      {/* `balance` still will not break a single long word; on a 320px
          screen the display size is 34px, wide enough to run off the edge. */}
      <h1 className="mt-[clamp(1.35rem,2.1vw,1.7rem)] font-heading text-[clamp(2.2rem,4.2vw,3.4rem)] leading-[1.02] font-light tracking-[-0.03em] break-words text-balance max-[760px]:tracking-[-0.018em]">
        {movie.title}
      </h1>
      {movie.subtitle && (
        <p className="mt-[clamp(0.7rem,1vw,0.9rem)] font-heading text-[clamp(0.78rem,1.15vw,0.98rem)] font-normal tracking-[0.3em] text-[#8a8a8a] uppercase max-[430px]:tracking-[0.24em]">
          {movie.subtitle}
        </p>
      )}

      {/* Hairlines hang off the left edge of every item but the first,
          which breaks the moment the rail wraps; below 560px it always
          does, so they give way to plain spacing. */}
      {meta.length > 0 && (
        <ul className="mt-[clamp(1rem,1.55vw,1.28rem)] flex list-none flex-wrap items-center gap-x-0 gap-y-2 text-[0.84rem] tracking-[0.06em] text-[#8a8a8a] tabular-nums max-[560px]:gap-x-[1.15rem]">
          {meta.map((item) => (
            <li
              key={item.key}
              className="not-first:ml-[clamp(0.85rem,1.8vw,1.5rem)] not-first:border-l not-first:border-[rgba(250,250,250,0.11)] not-first:pl-[clamp(0.85rem,1.8vw,1.5rem)] max-[560px]:not-first:ml-0 max-[560px]:not-first:border-l-0 max-[560px]:not-first:pl-0"
            >
              {item.accent ? <span className="text-[#ff3040]">{item.text}</span> : item.text}
            </li>
          ))}
        </ul>
      )}

      {/* Three lines: enough to read the premise while keeping the block
          inside its share of the opening screen. Full text stays in the
          DOM, so screen readers and SEO are unaffected. */}
      <p className="mt-[clamp(1.05rem,1.7vw,1.35rem)] line-clamp-3 max-w-[78ch] font-[family-name:'Segoe_UI',Roboto,-apple-system,BlinkMacSystemFont,sans-serif] text-[clamp(1rem,1.12vw,1.1rem)] leading-[1.78] font-medium tracking-[0] text-[#c7c7bd]">
        {movie.description}
      </p>

      <div className="mt-[clamp(1.18rem,1.9vw,1.58rem)] flex flex-nowrap gap-0 [--edge-gap:10px]">
        <button
          type="button"
          className={cx(ACTION, "[--pad:clamp(2.5rem,4.4vw,3.6rem)] max-[480px]:[--pad:2.1rem] bg-ink pr-[calc(var(--pad)+var(--slant))] pl-(--pad) text-black slant-lead hover:bg-[#e8e8cd]")}
          onClick={startPlayer}
        >
          <svg
            className="h-3 w-[10px] flex-none"
            viewBox="0 0 12 14"
            aria-hidden="true"
            focusable="false"
          >
            <path d="M0 0v14l12-7z" fill="currentColor" />
          </svg>
          <span>{canResume ? "Resume" : labels.play}</span>
        </button>

        {/* The hairline outline is a clipped layer rather than a border,
            because clip-path shears a real border off along the cut edge:
            the element is the outline colour and ::before insets by 1px in
            the page colour. Saved reads as engaged, not disabled: a quiet
            fill, label at full strength. */}
        <button
          type="button"
          className={cx(
            ACTION,
            "[--pad:clamp(1.05rem,1.8vw,1.5rem)] max-[480px]:[--pad:0.7rem] relative isolate ml-[calc(var(--edge-gap)-var(--slant))] bg-[rgba(250,250,250,0.28)] pr-(--pad) pl-[calc(var(--pad)+var(--slant))] text-ink slant-trail before:absolute before:inset-px before:z-[-1] before:content-[''] before:[clip-path:polygon(0_0,100%_0,100%_100%,var(--slant)_100%)] hover:bg-ink",
            // Its inner layer is smoked glass over the banner's blur.
            saved
              ? "before:bg-[rgba(26,26,25,0.72)] hover:before:bg-[rgba(35,35,34,0.8)]"
              : "before:bg-[rgba(0,0,0,0.5)] backdrop-blur-[10px]",
          )}
          aria-pressed={saved}
          onClick={toggleCurrentSaved}
        >
          {/* Wrapped so the button's counter-skew rule can reach the label —
              a bare text node would stay sheared with the button. */}
          <span>{saved ? labels.inWatchlist : labels.watchlist}</span>
        </button>
      </div>
    </>
  );

  return (
    // Relative on purpose: the hover popover is positioned in document
    // coordinates and resolves against this element, which starts at 0,0 and
    // carries no padding.
    <div className={PAGE}>
      <header
        className={cx(
          SHELL,
          "grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-6 pt-[clamp(1.25rem,2vw,1.75rem)] pb-[clamp(1.25rem,2.4vw,2rem)] max-[760px]:pb-[clamp(2rem,8vw,3rem)]",
          // Over the banner rather than above it.
          "absolute inset-x-0 top-0 z-20 [&_button]:text-[rgba(255,255,255,0.82)]",
        )}
      >
        {/* A <button> rather than a link, because it calls router.back(). Just
            the angle, as on every way back in the app: no label, no tail. The
            name lives in aria-label. */}
        <button
          type="button"
          className={cx(
            "group/back -ml-2.5 inline-grid size-11 cursor-pointer place-items-center justify-self-start rounded-full border-0 bg-transparent p-0 text-[#8a8a8a] transition-[color] duration-300 ease-[ease] hover:text-ink motion-reduce:transition-none",
            FOCUS_RING,
          )}
          aria-label={labels.goBack}
          onClick={() => router.back()}
        >
          <svg
            className="size-[22px] flex-none transition-[transform] duration-300 ease-[cubic-bezier(0.2,0.7,0.2,1)] group-hover/back:[transform:translateX(-3px)] motion-reduce:transition-none"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>

        {/* On entry the lockup glides in from the left. Animated on the two
            images rather than the link, because an animation's final opacity
            outranks a normal declaration and would kill the hover fade on the
            parent. The wordmark trails the mark by a beat. */}
        <Link
          href={brand.homeHref}
          className={cx(
            "inline-flex flex-none items-center gap-[0.55rem] justify-self-center transition-[opacity] duration-300 ease-[ease] hover:opacity-70 pointer-coarse:min-h-11 motion-reduce:transition-none",
            FOCUS_RING,
          )}
        >
          <img className="block h-[clamp(17px,2.1vw,21px)] w-auto animate-lockup-glide-in motion-reduce:animate-none" src={brand.mark} alt="" />
          <img
            className="block h-[clamp(11px,1.5vw,14px)] w-auto animate-lockup-glide-in [animation-delay:0.09s] motion-reduce:animate-none"
            src={brand.wordmark}
            alt={brand.wordmarkAlt}
          />
        </Link>

        {/* Plain icon buttons, borderless — matches the Premium Minimal chrome. */}
        <div className="inline-flex items-center gap-[0.85rem] justify-self-end">
          <button
            type="button"
            className="inline-flex size-[2.35rem] flex-none cursor-pointer items-center justify-center rounded-[999px] border-0 bg-transparent p-0 text-[#8a8a8a] no-underline transition-[color] duration-300 ease-[ease] hover:text-ink"
            aria-label={labels.search}
            onClick={() => setSearchOpen(true)}
          >
            <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </button>

          <ProfileMenu ariaLabel={labels.profile} variant="minimal" />
        </div>
      </header>

      <main className="flex-1 pb-[clamp(6rem,10vw,10rem)]">
        {/* The opening screen is the title's still, full-bleed and the full
            height of the screen, blurring and darkening into the page towards
            its foot, with the title and description set inside that blur. */}
        <div className="relative h-svh min-h-[36rem] w-full overflow-hidden bg-[#101010]">
          <img className="absolute inset-0 block h-full w-full object-cover object-[center_28%]" src={movie.backdrop} alt="" />

            {/* The big play button, ringed in red by how much of it has been
                watched on this device, so coming back shows where you are. */}
            <div className="absolute top-[42%] left-1/2 z-[3] flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-3.5 max-[768px]:top-[36%] [@media(max-height:760px)]:top-[34%]">
              <button
                type="button"
                className="group/play relative grid size-[clamp(4.5rem,min(8.5vw,13vh),7.25rem)] cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ink"
                aria-label={
                  canResume
                    ? `Resume ${movie.title}, ${Math.round(watchedFraction * 100)}% watched`
                    : `Play ${movie.title}`
                }
                onClick={startPlayer}
              >
                <svg className="absolute inset-0 size-full -rotate-90 drop-shadow-[0_6px_20px_rgba(0,0,0,0.45)]" viewBox="0 0 120 120" aria-hidden="true" focusable="false">
                  <circle cx="60" cy="60" r="56" fill="none" stroke="rgba(255,255,255,0.24)" strokeWidth="4" />
                  {watchedFraction > 0 && (
                    <circle
                      cx="60"
                      cy="60"
                      r="56"
                      fill="none"
                      stroke="#ff3040"
                      strokeWidth="4.5"
                      strokeLinecap="round"
                      pathLength={100}
                      strokeDasharray={`${Math.max(1.5, watchedFraction * 100)} 100`}
                    />
                  )}
                </svg>
                <span className="grid size-[80%] place-items-center rounded-full border border-[rgba(255,255,255,0.22)] bg-[rgba(255,255,255,0.14)] text-white backdrop-blur-[14px] transition-[background-color,scale] duration-300 ease-[cubic-bezier(0.2,0.7,0.2,1)] group-hover/play:scale-105 group-hover/play:bg-[rgba(255,255,255,0.26)] motion-reduce:transition-none">
                  <svg className="ml-[6%] size-[36%]" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path d="M7 4.8v14.4a1 1 0 0 0 1.52.85l11.3-7.2a1 1 0 0 0 0-1.7L8.52 3.95A1 1 0 0 0 7 4.8z" fill="currentColor" />
                  </svg>
                </span>
              </button>

              {savedPosition && watchedFraction > 0 && (
                <p className="rounded-full border border-[rgba(255,255,255,0.14)] bg-[rgba(0,0,0,0.42)] px-3.5 py-1.5 text-[0.74rem] font-semibold whitespace-nowrap text-white tabular-nums backdrop-blur-[12px]">
                  {watchedFraction >= 1 ? (
                    <>Watched{savedPick !== "trailer" && savedPick ? ` S${savedPick.season}:E${savedPick.episode}` : ""} · Play again</>
                  ) : (
                    <>
                      Resume{savedPick !== "trailer" && savedPick ? ` S${savedPick.season}:E${savedPick.episode}` : ""}
                      <span className="text-[rgba(255,255,255,0.6)]"> · </span>
                      {Math.max(1, Math.round((savedPosition.d - savedPosition.t) / 60))} min left
                    </>
                  )}
                </p>
              )}
            </div>

          {/* Black frosted band behind the floating header. A gradient
              alone let a bright or busy still show through behind the
              white labels and icons; blurring what is under them as well
              keeps them legible on any picture. Masked, so the band fades
              out instead of ending in a hard line. */}
          <div
            className="pointer-events-none absolute inset-x-0 top-0 z-[1] h-[clamp(7.5rem,14vw,10rem)] bg-[image:linear-gradient(to_bottom,rgba(0,0,0,0.82)_0%,rgba(0,0,0,0.62)_45%,rgba(0,0,0,0)_100%)] backdrop-blur-[18px] [mask-image:linear-gradient(to_bottom,black_50%,transparent)] max-[760px]:h-[7rem]"
            aria-hidden="true"
          />

          {/* A progressive blur: three frosted layers, each stronger and
              starting lower, each faded in by its own mask. One blur
              with one mask shows a visible band where it begins; stacked,
              the picture softens gradually towards the foot. */}
          <div className="pointer-events-none absolute inset-x-0 -bottom-12 h-[calc(60%+3rem)] backdrop-blur-[3px] [mask-image:linear-gradient(to_bottom,transparent,black_40%)]" aria-hidden="true" />
          <div className="pointer-events-none absolute inset-x-0 -bottom-12 h-[calc(50%+3rem)] backdrop-blur-[10px] [mask-image:linear-gradient(to_bottom,transparent,black_45%)]" aria-hidden="true" />
          <div className="pointer-events-none absolute inset-x-0 -bottom-12 h-[calc(40%+3rem)] backdrop-blur-[26px] backdrop-saturate-[1.15] [mask-image:linear-gradient(to_bottom,transparent,black_50%)]" aria-hidden="true" />

          {/* Darkens as it blurs and lands on the page's black, so the
              banner has no bottom edge. */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 -bottom-px h-[70%] bg-[image:linear-gradient(to_bottom,rgba(0,0,0,0)_0%,rgba(0,0,0,0.32)_38%,rgba(0,0,0,0.78)_70%,#000_92%)]" aria-hidden="true" />

          <div className={cx(SHELL, "absolute inset-x-0 bottom-0 z-[2] pb-[clamp(2.25rem,5.5vw,4.5rem)] [&_h1]:[text-shadow:0_6px_30px_rgba(0,0,0,0.45)] [&_ul]:text-[rgba(255,255,255,0.74)]")}>
            {info}
          </div>
        </div>

        {isSeries && (
          <section className={cx(SHELL, "mt-[clamp(2.75rem,5.5vw,4.5rem)]")} aria-labelledby="episodes-heading">
            <div className="mb-[clamp(1.2rem,2.4vw,1.9rem)] flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
              <div className="flex items-baseline gap-4">
                <h2 id="episodes-heading" className="font-heading text-[clamp(1.4rem,2.3vw,1.85rem)] leading-none font-light tracking-[-0.02em]">
                  Episodes
                </h2>
                <span className="text-[0.7rem] tracking-[0.18em] text-[#8a8a8a] uppercase tabular-nums">{movie.duration}</span>
              </div>

              <div className="flex items-center gap-3">
                {/* The season selector is light glass: a frosted track with the
                    chosen season lifted out of it in near-white. */}
                <div
                  role="tablist"
                  aria-label="Seasons"
                  className="flex max-w-full gap-0.5 overflow-x-auto rounded-full border border-[rgba(255,255,255,0.14)] bg-[rgba(255,255,255,0.07)] p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_12px_32px_rgba(0,0,0,0.4)] backdrop-blur-[18px] backdrop-saturate-150 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                >
                  {seasons.map((season) => {
                    const active = season.number === listSeasonNumber;
                    return (
                      <button
                        key={season.number}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        className={cx(
                          "h-9 flex-none cursor-pointer rounded-full border-0 px-[1.05rem] text-[0.78rem] font-semibold tracking-[0.03em] whitespace-nowrap tabular-nums transition-[background-color,color,box-shadow] duration-250 ease-[ease] max-[480px]:h-8 max-[480px]:px-3.5 motion-reduce:transition-none",
                          FOCUS_RING,
                          active
                            ? "bg-[rgba(255,255,255,0.92)] text-black shadow-[0_4px_14px_rgba(0,0,0,0.3)]"
                            : "bg-transparent text-[rgba(255,255,255,0.72)] hover:bg-[rgba(255,255,255,0.1)] hover:text-white",
                        )}
                        onClick={() => setListSeasonNumber(season.number)}
                      >
                        <span className="max-[480px]:hidden">Season </span>
                        <span className="hidden max-[480px]:inline">S</span>
                        {season.number}
                      </button>
                    );
                  })}
                </div>

                {/* Arrows for a mouse; a finger just swipes the row. */}
                <div className="flex gap-2 pointer-coarse:hidden">
                  {([-1, 1] as const).map((direction) => (
                    <button
                      key={direction}
                      type="button"
                      aria-label={direction < 0 ? "Previous episodes" : "More episodes"}
                      disabled={direction < 0 ? rowEdges.atStart : rowEdges.atEnd}
                      className={cx(
                        "grid size-11 cursor-pointer place-items-center rounded-full border border-[rgba(255,255,255,0.14)] bg-[rgba(255,255,255,0.07)] text-white backdrop-blur-[18px] transition-[background-color,opacity] duration-200 hover:bg-[rgba(255,255,255,0.16)] disabled:cursor-default disabled:opacity-30 disabled:hover:bg-[rgba(255,255,255,0.07)]",
                        FOCUS_RING,
                      )}
                      onClick={() => scrollRow(direction)}
                    >
                      <svg className="size-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                        <polyline points={direction < 0 ? "15 18 9 12 15 6" : "9 18 15 12 9 6"} />
                      </svg>
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Keyed by season, so a new season starts at its first episode
                rather than wherever the last one was scrolled to. It bleeds
                into the gutter, so the cut-off card at the edge says "more". */}
            <ol
              key={listSeasonNumber}
              ref={episodeRowRef}
              className="-mx-(--gutter) flex list-none snap-x snap-mandatory scroll-px-(--gutter) gap-[clamp(0.85rem,1.5vw,1.25rem)] overflow-x-auto overscroll-x-contain px-(--gutter) pt-1 pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              onScroll={readRowEdges}
            >
              {(seasons.find((season) => season.number === listSeasonNumber) ?? seasons[0]).episodes.map((episode) => {
                const here = { season: listSeasonNumber, episode: episode.number };
                const watched = fractionWatched(progress?.items[progressKey(here)]);
                const isNow = playing && pick !== "trailer" && pick.season === here.season && pick.episode === here.episode;
                return (
                  <li key={episode.number} className="w-[clamp(16rem,24vw,20.5rem)] flex-none snap-start max-[640px]:w-[78vw]">
                    <button
                      type="button"
                      aria-current={isNow}
                      className={cx("group/ep block w-full cursor-pointer border-0 bg-transparent p-0 text-left text-ink", FOCUS_RING)}
                      onClick={() => playFromList(here)}
                    >
                      <span
                        className={cx(
                          "relative block aspect-video overflow-hidden rounded-lg bg-[#101010] transition-[box-shadow] duration-300 motion-reduce:transition-none",
                          isNow
                            ? "shadow-[0_0_0_2px_#ff3040,0_18px_40px_rgba(255,48,64,0.18)]"
                            : "shadow-[0_0_0_1px_rgba(255,255,255,0.08)] group-hover/ep:shadow-[0_0_0_1px_rgba(255,255,255,0.3),0_18px_40px_rgba(0,0,0,0.5)]",
                        )}
                      >
                        <img
                          className="block h-full w-full object-cover transition-[scale] duration-700 ease-[cubic-bezier(0.2,0.7,0.2,1)] group-hover/ep:scale-[1.05] motion-reduce:transition-none"
                          src={episode.still || movie.backdrop}
                          alt=""
                          loading="lazy"
                        />
                        <span className="absolute inset-0 bg-[image:linear-gradient(to_top,rgba(0,0,0,0.82),rgba(0,0,0,0)_58%)]" aria-hidden="true" />

                        {/* How much of this episode has been watched here. */}
                        {watched > 0 && (
                          <span className="absolute inset-x-0 bottom-0 z-[1] h-[3px] bg-[rgba(255,255,255,0.22)]" aria-hidden="true">
                            <span className="block h-full bg-[#ff3040]" style={{ width: `${watched * 100}%` }} />
                          </span>
                        )}

                        {isNow && (
                          <span className="absolute top-2.5 left-2.5 rounded-full bg-[#ff3040] px-2.5 py-1 text-[0.58rem] leading-none font-bold tracking-[0.14em] text-white uppercase">
                            Now playing
                          </span>
                        )}

                        {/* A glass play disc on hover, and always on the one playing. */}
                        <span
                          className={cx(
                            "absolute top-1/2 left-1/2 grid size-12 -translate-1/2 place-items-center rounded-full border border-[rgba(255,255,255,0.3)] bg-[rgba(255,255,255,0.16)] backdrop-blur-[10px] transition-opacity duration-200 motion-reduce:transition-none",
                            isNow ? "opacity-100" : "opacity-0 group-hover/ep:opacity-100 group-focus-visible/ep:opacity-100",
                          )}
                          aria-hidden="true"
                        >
                          <svg className={cx("ml-0.5 h-3.5 w-3", isNow ? "text-[#ff3040]" : "text-white")} viewBox="0 0 12 14" focusable="false">
                            <path d="M0 0v14l12-7z" fill="currentColor" />
                          </svg>
                        </span>

                        <span
                          className="absolute bottom-2 left-3 font-heading text-[clamp(1.9rem,2.8vw,2.5rem)] leading-none font-light text-[rgba(255,255,255,0.92)] tabular-nums [text-shadow:0_2px_14px_rgba(0,0,0,0.6)]"
                          aria-hidden="true"
                        >
                          {String(episode.number).padStart(2, "0")}
                        </span>
                        <span className="absolute right-2.5 bottom-2.5 rounded-full border border-[rgba(255,255,255,0.16)] bg-[rgba(0,0,0,0.35)] px-2 py-[3px] text-[0.66rem] leading-none font-medium text-white tabular-nums backdrop-blur-[8px]">
                          {episode.duration}
                        </span>
                      </span>

                      <span className="mt-3 block text-[0.62rem] font-medium tracking-[0.18em] text-[#8a8a8a] uppercase tabular-nums">
                        {episodeCode(here.season, here.episode)}
                      </span>
                      <span className="mt-1 block truncate font-heading text-[clamp(0.98rem,1.25vw,1.08rem)] leading-snug font-normal tracking-[0.005em]">
                        {episode.title}
                      </span>
                      {episode.description && (
                        <span className="mt-1.5 line-clamp-2 text-[0.84rem] leading-[1.55] text-[#9b9b92]">{episode.description}</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ol>
          </section>
        )}

        <div className={SHELL}>
          <section className="mt-(--step)">
            <div className="mb-[clamp(1.75rem,3.2vw,2.75rem)] flex items-center gap-[clamp(1.25rem,2.5vw,2rem)]">
              <h2 className="font-body text-[0.7rem] font-medium tracking-[0.28em] whitespace-nowrap text-[#8a8a8a] uppercase">{labels.relatedHeading}</h2>
              <span className="h-px flex-1 bg-[rgba(250,250,250,0.11)]" aria-hidden="true" />
            </div>

            {/* Fixed 190px tracks rather than fr-based columns: `1fr` stretched
                each card, so a related card came out larger than the same card
                on the catalog. Below 560px the cards fill the row instead, two
                up, so a fixed track cannot leave a lone column with a hole. */}
            {related.length > 0 ? (
              <ul className="grid list-none grid-cols-[repeat(auto-fill,minmax(176px,1fr))] gap-x-[10px] gap-y-[clamp(1.5rem,2.4vw,2rem)] max-[559px]:grid-cols-[repeat(auto-fill,minmax(140px,1fr))] max-[559px]:gap-y-6">
                {related.map((item) => (
                  <li key={item.id} className="min-w-0">
                    <PosterCard
                      movie={item}
                      saved={!!bookmarked[item.id]}
                      saveLabel={labels.saveToList}
                      onToggleSave={() => toggleBookmark(item.id)}
                      {...popover.cardProps(item)}
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[0.95rem] leading-[1.7] text-[#8a8a8a]">Nothing else in this collection yet.</p>
            )}
          </section>
        </div>
      </main>

      <SiteFooter brand={brand} footer={footer} />

      {playing && (
        <div
          className="fixed inset-0 z-[70] grid animate-overlay-fade place-items-center bg-[rgba(0,0,0,0.55)] p-[clamp(1rem,4vw,3rem)] backdrop-blur-[14px] backdrop-saturate-[0.9] motion-reduce:animate-none"
          role="dialog"
          aria-modal="true"
          aria-label={`Playing ${movie.title}`}
        >
          {/* 16:9 on a wide screen, sized to fit both ways. A phone held
              upright gets a taller box, so the controls have room; the film
              letterboxes inside it and fullscreen is one press away. */}
          <div className="relative aspect-video w-[min(100%,1120px,calc((100svh-6rem)*16/9))] animate-player-pop overflow-hidden rounded-[clamp(0.75rem,1.4vw,1.25rem)] bg-black shadow-[0_40px_120px_rgba(0,0,0,0.75),0_0_0_1px_rgba(255,255,255,0.08)] motion-reduce:animate-none max-[640px]:aspect-[4/5] max-[640px]:w-full">
            {playerNode}
          </div>
        </div>
      )}

      <SearchOverlay
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        movies={allMovies}
        placeholder={`${labels.search} titles…`}
      />

      {popover.movie && popover.position && (
        <TitlePopover
          movie={popover.movie}
          position={popover.position}
          labels={popoverLabels}
          saved={!!bookmarked[popover.movie.id]}
          onToggleSave={() => toggleBookmark(popover.movie!.id)}
          onWatch={() => router.push(`/watch/${popover.movie!.id}`)}
          {...popover.popoverProps}
        />
      )}
    </div>
  );
}
