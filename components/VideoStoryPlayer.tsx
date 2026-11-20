"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  createVideoCompletionGate,
  resolveVideoSkipControlMode,
  resolveVideoSubtitlePresentation,
  type VideoCompletionGate,
  type VideoCompletionReason,
} from "@/lib/sceneMedia";
import { coerceSavedPlayerVolume } from "@/lib/playerReviewPolicy";
import type { SceneVideoMedia } from "@infiplot/types";

const PLAYER_PREFS_KEY = "aistory:video-player-prefs:v1";
const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

type PlayerPrefs = {
  volume: number;
  muted: boolean;
  playbackRate: number;
  brightness: number;
};

const DEFAULT_PREFS: PlayerPrefs = {
  volume: 1,
  muted: false,
  playbackRate: 1,
  brightness: 100,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function loadPrefs(): PlayerPrefs {
  if (typeof window === "undefined") return DEFAULT_PREFS;
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(PLAYER_PREFS_KEY) || "{}",
    ) as Partial<PlayerPrefs>;
    return {
      volume: coerceSavedPlayerVolume(parsed.volume),
      muted: parsed.muted === true,
      playbackRate: PLAYBACK_RATES.includes(
        Number(parsed.playbackRate) as (typeof PLAYBACK_RATES)[number],
      )
        ? Number(parsed.playbackRate)
        : 1,
      brightness: clamp(Number(parsed.brightness) || 100, 50, 150),
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function formatTime(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0:00";
  const seconds = Math.floor(value);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export type VideoStoryCompletion = {
  reason: VideoCompletionReason;
  currentTimeMs: number;
  durationMs: number;
};

export type VideoStoryPlaybackTime = {
  currentTimeMs: number;
  durationMs: number;
};

type VideoStoryPlayerProps = {
  media: SceneVideoMedia;
  fallbackSubtitle?: { speaker?: string; text: string };
  muted: boolean;
  dimmed: boolean;
  onReady?: () => void;
  onTimeChange?: (event: VideoStoryPlaybackTime) => void;
  onComplete: (event: VideoStoryCompletion) => void;
};

export function VideoStoryPlayer(props: VideoStoryPlayerProps) {
  return <VideoStoryPlayerSession key={props.media.url} {...props} />;
}

function VideoStoryPlayerSession({
  media,
  fallbackSubtitle,
  muted,
  dimmed,
  onReady,
  onTimeChange,
  onComplete,
}: VideoStoryPlayerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsTimerRef = useRef<number | null>(null);
  const readyNotifiedRef = useRef(false);
  const mediaFailedRef = useRef(false);
  const [prefs] = useState(loadPrefs);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(
    media.durationMs ? media.durationMs / 1000 : 0,
  );
  const [volume, setVolume] = useState(prefs.volume);
  // Initialize from the SAVED local preference only. The page-level `muted`
  // prop is combined in the sync effect below, so folding it into the initial
  // state would latch a transient global mute forever (local unmute could
  // never recover after the page unmuted).
  const [locallyMuted, setLocallyMuted] = useState(prefs.muted);
  const [playbackRate, setPlaybackRate] = useState(prefs.playbackRate);
  const [brightness, setBrightness] = useState(prefs.brightness);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const [mediaState, setMediaState] = useState<"loading" | "ready" | "failed">(
    "loading",
  );
  const [recoveryRequested, setRecoveryRequested] = useState(false);
  // Mirrors the (non-reactive) completion gate into React state so terminated
  // sessions immediately drop transport controls, subtitles, and native VTT
  // from layout, hit-testing, and the accessibility tree.
  const [terminal, setTerminal] = useState(false);
  const terminalRef = useRef(false);
  const onCompleteRef = useRef(onComplete);
  const durationRef = useRef(duration);

  onCompleteRef.current = onComplete;
  durationRef.current = duration;

  const [completionGate] = useState<VideoCompletionGate>(() =>
    createVideoCompletionGate((reason) => {
      const video = videoRef.current;
      const videoCurrentTime = video?.currentTime;
      const videoDuration = video?.duration;
      try {
        onCompleteRef.current({
          reason,
          currentTimeMs: Math.round(
            (Number.isFinite(videoCurrentTime)
              ? Number(videoCurrentTime)
              : 0) * 1000,
          ),
          durationMs: Math.round(
            (Number.isFinite(videoDuration) && Number(videoDuration) >= 0
              ? Number(videoDuration)
              : durationRef.current) * 1000,
          ),
        });
      } catch {
        // The terminal gate stays closed even if a parent callback fails.
      }
    }),
  );

  const mediaFailed = mediaState === "failed";
  // The page-level mute is applied as `muted || locallyMuted`, so while the
  // page is muted the in-player mute/volume controls cannot actually enable
  // sound. Report that explicitly instead of displaying a fake unmuted state.
  const localMuteBlocked = muted;
  const localMuteBlockedHint =
    "本页已整体静音，播放器内的静音 / 音量开关无法单独开启声音。请使用页面上的静音开关。";
  const subtitlePresentation = resolveVideoSubtitlePresentation({
    inlineCues: media.subtitles,
    vttUrl: media.vttUrl,
    fallbackSubtitle,
    currentTimeMs: currentTime * 1000,
  });
  const subtitleOverlay = subtitlePresentation.overlay;
  const skipControlMode = resolveVideoSkipControlMode(
    media.allowSkip,
    mediaFailed,
  );

  const persistPrefs = useCallback(
    (patch: Partial<PlayerPrefs>) => {
      try {
        window.localStorage.setItem(
          PLAYER_PREFS_KEY,
          JSON.stringify({
            volume,
            muted: locallyMuted,
            playbackRate,
            brightness,
            ...patch,
          }),
        );
      } catch {
        // Playback preferences are optional browser-only state.
      }
    },
    [brightness, locallyMuted, playbackRate, volume],
  );

  const showControls = useCallback(() => {
    // Pointer/focus handlers must never resurrect controls (or their hit area)
    // once the session is terminal or the completion gate has left "active".
    if (terminalRef.current || completionGate.state() !== "active") return;
    setControlsVisible(true);
    if (controlsTimerRef.current !== null) {
      window.clearTimeout(controlsTimerRef.current);
    }
    if (playing) {
      controlsTimerRef.current = window.setTimeout(() => {
        setControlsVisible(false);
        controlsTimerRef.current = null;
      }, 2600);
    }
  }, [completionGate, playing, setControlsVisible]);

  useEffect(() => {
    return () => {
      if (controlsTimerRef.current !== null) {
        window.clearTimeout(controlsTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = muted || locallyMuted;
    video.volume = volume;
    video.playbackRate = playbackRate;
  }, [locallyMuted, muted, playbackRate, volume]);

  const notifyReadyOnce = useCallback(() => {
    if (readyNotifiedRef.current) return;
    readyNotifiedRef.current = true;
    onReady?.();
  }, [onReady]);

  const exitPlayerFullscreenOnTerminal = useCallback(() => {
    if (typeof document === "undefined") return;
    const root = rootRef.current;
    // Never leave an unrelated fullscreen element (another player, a modal,
    // or a sibling surface) just because this video completed.
    if (!root || document.fullscreenElement !== root) return;
    try {
      const result = document.exitFullscreen();
      if (result && typeof result.catch === "function") {
        result.catch(() => {
          // Best-effort only; the terminal UI state is already committed.
        });
      }
    } catch {
      // exitFullscreen can reject without a user gesture; UI state stands.
    }
  }, []);

  const complete = useCallback(
    (reason: VideoCompletionReason) => {
      const didComplete = completionGate(reason);
      if (didComplete) {
        // Successful terminal completion (including explicit recovery from a
        // failed media element) is mirrored synchronously in the ref and in
        // React state. Failure itself never reaches this branch.
        exitPlayerFullscreenOnTerminal();
        terminalRef.current = true;
        setTerminal(true);
        setControlsVisible(false);
        if (controlsTimerRef.current !== null) {
          window.clearTimeout(controlsTimerRef.current);
          controlsTimerRef.current = null;
        }
      }
      return didComplete;
    },
    [completionGate, exitPlayerFullscreenOnTerminal],
  );

  const attemptPlay = useCallback(async () => {
    const video = videoRef.current;
    if (
      !video ||
      mediaFailedRef.current ||
      completionGate.state() !== "active"
    ) {
      return;
    }
    try {
      await video.play();
      if (
        mediaFailedRef.current ||
        completionGate.state() !== "active"
      ) {
        video.pause();
        return;
      }
      setPlaying(true);
      setAutoplayBlocked(false);
    } catch {
      if (
        mediaFailedRef.current ||
        completionGate.state() !== "active"
      ) {
        return;
      }
      setPlaying(false);
      setAutoplayBlocked(true);
      setControlsVisible(true);
    }
  }, [completionGate]);

  const togglePlayback = useCallback(() => {
    const video = videoRef.current;
    if (
      !video ||
      mediaFailedRef.current ||
      completionGate.state() !== "active"
    ) {
      return;
    }
    if (video.paused) void attemptPlay();
    else {
      video.pause();
      setPlaying(false);
      setControlsVisible(true);
    }
  }, [attemptPlay, completionGate]);

  const skipToEnd = useCallback(() => {
    const video = videoRef.current;
    if (
      !video ||
      mediaFailedRef.current ||
      completionGate.state() !== "active"
    ) {
      return;
    }
    const end = Number.isFinite(video.duration)
      ? video.duration
      : media.durationMs
        ? media.durationMs / 1000
        : video.currentTime;
    if (end > 0) video.currentTime = end;
    video.pause();
    setCurrentTime(end);
    setPlaying(false);
    complete("skipped");
  }, [complete, completionGate, media.durationMs]);

  const recoverFromMediaFailure = useCallback(() => {
    if (completionGate.state() !== "failed") return;
    if (complete("skipped")) setRecoveryRequested(true);
  }, [complete, completionGate, setRecoveryRequested]);

  const handleMediaError = useCallback(
    (event: React.SyntheticEvent<HTMLVideoElement>) => {
      const markedFailed = completionGate.markFailed();
      if (!markedFailed && completionGate.state() !== "failed") return;

      mediaFailedRef.current = true;
      try {
        event.currentTarget.pause();
      } catch {
        // A broken media element can reject playback operations.
      }
      setMediaState("failed");
      setPlaying(false);
      setCurrentTime(0);
      setAutoplayBlocked(false);
      setControlsVisible(true);
      notifyReadyOnce();
    },
    [
      completionGate,
      notifyReadyOnce,
      setAutoplayBlocked,
      setControlsVisible,
      setCurrentTime,
      setMediaState,
      setPlaying,
    ],
  );

  const seekTo = useCallback(
    (next: number) => {
      const video = videoRef.current;
      if (
        !video ||
        mediaFailedRef.current ||
        completionGate.state() !== "active"
      ) {
        return;
      }
      const safeDuration = duration || video.duration || 0;
      const value = clamp(next, 0, safeDuration);
      video.currentTime = value;
      setCurrentTime(value);
      if (safeDuration > 0 && value >= safeDuration - 0.2) {
        video.pause();
        setPlaying(false);
        complete("seeked");
      }
    },
    [complete, completionGate, duration],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const video = videoRef.current;
      if (!video || mediaFailedRef.current) return;
      if (event.key === " " || event.key.toLowerCase() === "k") {
        event.preventDefault();
        togglePlayback();
      } else if (event.key.toLowerCase() === "m") {
        event.preventDefault();
        // With the page muted, a local toggle would only change a value that
        // still gets OR-ed with the global mute — do not fake an unmute.
        if (!localMuteBlocked) {
          setLocallyMuted((value) => {
            persistPrefs({ muted: !value });
            return !value;
          });
        }
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        seekTo(video.currentTime - 5);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        seekTo(video.currentTime + 5);
      }
      showControls();
    },
    [localMuteBlocked, persistPrefs, seekTo, showControls, togglePlayback],
  );

  return (
    <div
      ref={rootRef}
      className={`relative h-full w-full overflow-hidden bg-black transition-opacity duration-300 motion-reduce:transition-none ${
        dimmed ? "opacity-40" : "opacity-100"
      }`}
      tabIndex={0}
      role="group"
      aria-label="剧情视频播放器"
      onKeyDown={onKeyDown}
      onPointerMove={showControls}
      onPointerDown={showControls}
      onFocusCapture={showControls}
      onMouseLeave={() => {
        if (playing) setControlsVisible(false);
      }}
    >
      <video
        ref={videoRef}
        src={media.url}
        poster={media.posterUrl}
        preload="metadata"
        playsInline
        className="h-full w-full object-contain"
        style={{ filter: `brightness(${brightness}%)` }}
        onLoadedMetadata={(event) => {
          if (
            mediaFailedRef.current ||
            completionGate.state() !== "active"
          ) {
            return;
          }
          const video = event.currentTarget;
          const nextDuration =
            Number.isFinite(video.duration) && video.duration > 0
              ? video.duration
              : media.durationMs
                ? media.durationMs / 1000
                : 0;
          setDuration(nextDuration);
          video.volume = volume;
          video.muted = muted || locallyMuted;
          video.playbackRate = playbackRate;
          onTimeChange?.({
            currentTimeMs: Math.round(video.currentTime * 1_000),
            durationMs: Math.round(nextDuration * 1_000),
          });
          setMediaState("ready");
          notifyReadyOnce();
          void attemptPlay();
        }}
        onTimeUpdate={(event) => {
          if (
            mediaFailedRef.current ||
            completionGate.state() !== "active"
          ) {
            return;
          }
          const video = event.currentTarget;
          setCurrentTime(video.currentTime);
          onTimeChange?.({
            currentTimeMs: Math.round(video.currentTime * 1_000),
            durationMs: Math.round(
              (Number.isFinite(video.duration) ? video.duration : duration) *
                1_000,
            ),
          });
        }}
        onPlay={(event) => {
          if (
            mediaFailedRef.current ||
            completionGate.state() !== "active"
          ) {
            event.currentTarget.pause();
            return;
          }
          setPlaying(true);
          showControls();
        }}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          if (
            mediaFailedRef.current ||
            completionGate.state() !== "active"
          ) {
            return;
          }
          setPlaying(false);
          setCurrentTime(videoRef.current?.duration || duration);
          complete("completed");
        }}
        onError={handleMediaError}
        onClick={togglePlayback}
      >
        {!terminal &&
          !mediaFailed &&
          subtitlePresentation.source === "vtt" && (
          <track
            kind="subtitles"
            src={subtitlePresentation.trackUrl}
            srcLang="zh-CN"
            default
          />
        )}
      </video>

      {!mediaFailed && !terminal && subtitleOverlay && (
        <div
          className="pointer-events-none absolute inset-x-[max(4%,env(safe-area-inset-left))] bottom-[max(6.5rem,calc(env(safe-area-inset-bottom)+5.5rem))] z-20 flex justify-center text-center"
          aria-live="polite"
        >
          <div className="max-w-3xl rounded bg-black/72 px-4 py-2 font-serif text-base leading-7 text-white shadow-lg backdrop-blur-sm md:text-lg">
            {subtitleOverlay.speaker && (
              <span className="mr-2 font-semibold text-blue-300">
                {subtitleOverlay.speaker}
              </span>
            )}
            <span>{subtitleOverlay.text}</span>
          </div>
        </div>
      )}

      {autoplayBlocked &&
        !mediaFailed &&
        completionGate.state() === "active" &&
        !terminal && (
        <button
          type="button"
          onClick={() => {
            if (!localMuteBlocked) {
              setLocallyMuted(false);
              persistPrefs({ muted: false });
            }
            void attemptPlay();
          }}
          title={localMuteBlocked ? localMuteBlockedHint : undefined}
          data-local-mute-blocked={localMuteBlocked ? "true" : undefined}
          className="absolute left-1/2 top-1/2 z-30 -translate-x-1/2 -translate-y-1/2 rounded border border-blue-300/70 bg-black/78 px-5 py-3 text-sm font-medium text-white shadow-xl backdrop-blur"
        >
          <i
            className={`fa-solid ${
              localMuteBlocked ? "fa-play" : "fa-volume-high"
            } mr-2`}
            aria-hidden
          />
          {localMuteBlocked ? "点击播放（本页已静音）" : "点击播放并开启声音"}
        </button>
      )}

      {mediaFailed && !terminal && (
        <div
          className="absolute inset-0 z-40 flex items-center justify-center bg-black/78 px-6 text-center backdrop-blur-sm"
          role="alert"
          data-video-media-failed
        >
          <div className="max-w-md rounded border border-red-300/55 bg-black/85 px-6 py-5 text-white shadow-2xl">
            <p className="text-base font-semibold">视频加载失败</p>
            <p className="mt-2 text-sm leading-6 text-white/75">
              当前媒体无法继续播放。你可以跳过损坏媒体并继续剧情。
            </p>
            {skipControlMode === "error-recovery" && (
              <button
                type="button"
                onClick={recoverFromMediaFailure}
                disabled={recoveryRequested}
                className="mt-4 h-10 rounded border border-blue-300/75 bg-blue-500/25 px-4 font-semibold text-blue-50 hover:bg-blue-500/35 disabled:cursor-wait disabled:opacity-65"
                data-video-error-recovery
              >
                {recoveryRequested ? "正在继续…" : "跳过并继续"}
              </button>
            )}
          </div>
        </div>
      )}

      {!mediaFailed && !terminal && (
        <div
          className={`absolute inset-x-0 bottom-0 z-30 bg-gradient-to-t from-black/95 via-black/72 to-transparent px-[max(0.75rem,env(safe-area-inset-left))] pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-10 transition-opacity duration-200 motion-reduce:transition-none ${
            controlsVisible || !playing
              ? "opacity-100"
              : "pointer-events-none opacity-0"
          }`}
        >
        <label className="block">
          <span className="sr-only">视频进度</span>
          <input
            type="range"
            min={0}
            max={Math.max(duration, 0.01)}
            step={0.05}
            value={Math.min(currentTime, Math.max(duration, 0.01))}
            onChange={(event) => seekTo(Number(event.target.value))}
            className="w-full accent-blue-500"
            aria-label="视频进度"
          />
        </label>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-white">
          <button
            type="button"
            onClick={togglePlayback}
            className="flex h-9 w-9 items-center justify-center rounded bg-white/10 hover:bg-white/20"
            aria-label={playing ? "暂停" : "播放"}
          >
            <i className={`fa-solid ${playing ? "fa-pause" : "fa-play"}`} />
          </button>
          <span className="min-w-[5.8rem] tabular-nums text-white/80">
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>
          <button
            type="button"
            onClick={() =>
              setLocallyMuted((value) => {
                persistPrefs({ muted: !value });
                return !value;
              })
            }
            disabled={localMuteBlocked}
            title={localMuteBlocked ? localMuteBlockedHint : undefined}
            data-local-mute-blocked={localMuteBlocked ? "true" : undefined}
            className="flex h-9 w-9 items-center justify-center rounded bg-white/10 hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-55"
            aria-label={
              localMuteBlocked
                ? "本页已静音，播放器内的静音开关无法单独开启声音"
                : muted || locallyMuted
                  ? "取消静音"
                  : "静音"
            }
          >
            <i
              className={`fa-solid ${
                localMuteBlocked || locallyMuted || volume === 0
                  ? "fa-volume-xmark"
                  : "fa-volume-high"
              }`}
            />
          </button>
          <label
            className="hidden items-center gap-1 sm:flex"
            title={localMuteBlocked ? localMuteBlockedHint : undefined}
          >
            <span className="sr-only">音量</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={volume}
              disabled={localMuteBlocked}
              onChange={(event) => {
                const value = Number(event.target.value);
                setVolume(value);
                if (value > 0) setLocallyMuted(false);
                persistPrefs({ volume: value, muted: value === 0 });
              }}
              className="w-20 accent-blue-500 disabled:cursor-not-allowed disabled:opacity-55"
              aria-label="音量"
            />
          </label>
          {localMuteBlocked && (
            <span
              className="text-[11px] leading-5 text-white/70"
              data-video-local-mute-note
            >
              {localMuteBlockedHint}
            </span>
          )}
          <label className="flex items-center gap-1">
            <span className="sr-only">播放速度</span>
            <select
              value={playbackRate}
              onChange={(event) => {
                const value = Number(event.target.value);
                setPlaybackRate(value);
                persistPrefs({ playbackRate: value });
              }}
              className="h-9 rounded border border-white/15 bg-black/55 px-2 text-white"
              aria-label="播放速度"
            >
              {PLAYBACK_RATES.map((rate) => (
                <option key={rate} value={rate}>
                  {rate}×
                </option>
              ))}
            </select>
          </label>
          <label className="hidden items-center gap-2 md:flex">
            <span className="whitespace-nowrap text-white/75">
              显示亮度 {brightness}%
            </span>
            <input
              type="range"
              min={50}
              max={150}
              step={5}
              value={brightness}
              onChange={(event) => {
                const value = Number(event.target.value);
                setBrightness(value);
                persistPrefs({ brightness: value });
              }}
              className="w-24 accent-blue-500"
              aria-label="客户端显示亮度"
            />
          </label>
          <button
            type="button"
            onClick={() => {
              const root = rootRef.current;
              if (!root) return;
              if (document.fullscreenElement) void document.exitFullscreen();
              else void root.requestFullscreen();
            }}
            className="ml-auto flex h-9 w-9 items-center justify-center rounded bg-white/10 hover:bg-white/20"
            aria-label="全屏"
          >
            <i className="fa-solid fa-expand" />
          </button>
          {skipControlMode === "normal-skip" && (
            <button
              type="button"
              onClick={skipToEnd}
              disabled={duration <= 0}
              className="h-9 rounded border border-blue-300/75 bg-blue-500/20 px-3 font-semibold text-blue-100 hover:bg-blue-500/30"
            >
              跳到结尾
            </button>
          )}
        </div>
        </div>
      )}
    </div>
  );
}
