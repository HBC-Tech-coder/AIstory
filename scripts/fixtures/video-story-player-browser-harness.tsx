"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";

import {
  VideoStoryPlayer,
  type VideoStoryCompletion,
  type VideoStoryPlaybackTime,
} from "@/components/VideoStoryPlayer";
import type { SceneVideoMedia } from "@infiplot/types";

export const VIDEO_STORY_PLAYER_BROWSER_SCENARIOS = [
  "inline-vtt",
  "vtt-only",
  "corrupt-media",
] as const;

export type VideoStoryPlayerBrowserScenario =
  (typeof VIDEO_STORY_PLAYER_BROWSER_SCENARIOS)[number];

export type VideoStoryPlayerBrowserHarnessProps = {
  scenario: VideoStoryPlayerBrowserScenario;
  runId: string;
};

type BrowserHarnessState = {
  schemaVersion: 1;
  scenario: VideoStoryPlayerBrowserScenario;
  runId: string;
  readyCount: number;
  nativeMediaErrorCount: number;
  nativeTrustedSeekedCount: number;
  nativeTrustedTimeUpdateCount: number;
  timeChangeCount: number;
  lastTimeChange: VideoStoryPlaybackTime | null;
  completions: VideoStoryCompletion[];
};

declare global {
  interface Window {
    __AISTORY_P114_PLAYER_HARNESS__?: BrowserHarnessState;
  }
}

const INLINE_TEXT = "P1.14 内联字幕唯一来源";
const INLINE_SPEAKER = "P1.14 内联讲述";
const FALLBACK_TEXT = "P1.14 错误回退正文";
const FALLBACK_SPEAKER = "P1.14 错误回退说话人";

function initialHarnessState(
  scenario: VideoStoryPlayerBrowserScenario,
  runId: string,
): BrowserHarnessState {
  return {
    schemaVersion: 1,
    scenario,
    runId,
    readyCount: 0,
    nativeMediaErrorCount: 0,
    nativeTrustedSeekedCount: 0,
    nativeTrustedTimeUpdateCount: 0,
    timeChangeCount: 0,
    lastTimeChange: null,
    completions: [],
  };
}

function mediaForScenario(
  scenario: VideoStoryPlayerBrowserScenario,
  runId: string,
): SceneVideoMedia {
  const suffix = `?run=${encodeURIComponent(runId)}`;
  if (scenario === "corrupt-media") {
    return {
      kind: "video",
      url: `/case-studies/p1-14/corrupt.mp4${suffix}`,
      durationMs: 30_000,
      hasAudio: false,
      subtitles: [],
      endBehavior: "unlock-interaction",
      allowSkip: false,
      hotspotsEnabled: false,
    };
  }

  return {
    kind: "video",
    url: `/case-studies/p1-14/legal.mp4${suffix}`,
    durationMs: 30_000,
    hasAudio: false,
    subtitles:
      scenario === "inline-vtt"
        ? [
            {
              id: "p114-inline-1",
              startMs: 100,
              endMs: 900,
              speaker: INLINE_SPEAKER,
              text: INLINE_TEXT,
            },
          ]
        : [],
    vttUrl: `/case-studies/p1-14/subtitles.vtt${suffix}`,
    endBehavior: "unlock-interaction",
    allowSkip: false,
    hotspotsEnabled: false,
  };
}

export function VideoStoryPlayerBrowserHarness({
  scenario,
  runId,
}: VideoStoryPlayerBrowserHarnessProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [snapshot, setSnapshot] = useState<BrowserHarnessState>(() =>
    initialHarnessState(scenario, runId),
  );
  const stateRef = useRef<BrowserHarnessState>(snapshot);
  const media = mediaForScenario(scenario, runId);

  const publish = useCallback(() => {
    window.__AISTORY_P114_PLAYER_HARNESS__ = stateRef.current;
    setSnapshot({
      ...stateRef.current,
      lastTimeChange: stateRef.current.lastTimeChange
        ? { ...stateRef.current.lastTimeChange }
        : null,
      completions: stateRef.current.completions.map((event) => ({ ...event })),
    });
  }, []);

  const recordNativeMediaError = useCallback(() => {
    if (stateRef.current.nativeMediaErrorCount !== 0) return;
    stateRef.current.nativeMediaErrorCount = 1;
    publish();
  }, [publish]);

  useLayoutEffect(() => {
    window.__AISTORY_P114_PLAYER_HARNESS__ = stateRef.current;
    const video = hostRef.current?.querySelector("video");
    if (!(video instanceof HTMLVideoElement)) return;
    const onError = () => recordNativeMediaError();
    const onSeeked = (event: Event) => {
      if (!event.isTrusted) return;
      stateRef.current.nativeTrustedSeekedCount += 1;
      publish();
    };
    const onTimeUpdate = (event: Event) => {
      if (!event.isTrusted) return;
      stateRef.current.nativeTrustedTimeUpdateCount += 1;
      publish();
    };
    video.addEventListener("error", onError, { capture: true });
    video.addEventListener("seeked", onSeeked, { capture: true });
    video.addEventListener("timeupdate", onTimeUpdate, { capture: true });
    if (video.error !== null) recordNativeMediaError();
    return () => {
      video.removeEventListener("error", onError, { capture: true });
      video.removeEventListener("seeked", onSeeked, { capture: true });
      video.removeEventListener("timeupdate", onTimeUpdate, { capture: true });
      delete window.__AISTORY_P114_PLAYER_HARNESS__;
    };
  }, [publish, recordNativeMediaError]);

  const onReady = useCallback(() => {
    const video = hostRef.current?.querySelector("video");
    if (video instanceof HTMLVideoElement && video.error !== null) {
      recordNativeMediaError();
    }
    stateRef.current.readyCount += 1;
    publish();
  }, [publish, recordNativeMediaError]);

  const onTimeChange = useCallback(
    (event: VideoStoryPlaybackTime) => {
      stateRef.current.timeChangeCount += 1;
      stateRef.current.lastTimeChange = event;
      publish();
    },
    [publish],
  );

  const onComplete = useCallback(
    (event: VideoStoryCompletion) => {
      stateRef.current.completions.push(event);
      publish();
    },
    [publish],
  );

  return (
    <main
      ref={hostRef}
      data-p114-harness
      data-p114-scenario={scenario}
      data-p114-run={runId}
    >
      <style>{`
        :root { color-scheme: dark; background: #05070c; }
        * { box-sizing: border-box; }
        html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #05070c; }
        body { font-family: system-ui, sans-serif; }
        [data-p114-harness], [data-p114-player-host], [role="group"] {
          position: relative; width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden;
        }
        [role="group"] > video { display: block; width: 100%; height: 100%; object-fit: contain; background: #000; }
        [role="group"] > [aria-live="polite"] {
          position: absolute; z-index: 20; left: 5%; right: 5%; bottom: 5.75rem;
          display: flex; justify-content: center; color: white; text-align: center;
        }
        [role="group"] > [aria-live="polite"] > div {
          max-width: min(48rem, 92vw); padding: .6rem .9rem; border-radius: .4rem; background: rgba(0,0,0,.82);
        }
        [data-video-media-failed] {
          position: absolute; z-index: 40; inset: 0; display: flex; align-items: center; justify-content: center;
          padding: 1.25rem; color: white; text-align: center; background: rgba(0,0,0,.9);
        }
        [data-video-media-failed] > div { max-width: 28rem; }
        [data-video-error-recovery] { min-height: 2.75rem; margin-top: 1rem; padding: .5rem 1rem; }
        [role="group"] > div:last-child:not([data-video-media-failed]):not([aria-live="polite"]) {
          position: absolute; z-index: 30; left: 0; right: 0; bottom: 0; max-height: 7rem; overflow: hidden;
          padding: .5rem; color: white; background: rgba(0,0,0,.72);
        }
        [data-p114-state] { position: fixed; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
      `}</style>
      <section data-p114-player-host>
        <VideoStoryPlayer
          media={media}
          fallbackSubtitle={
            scenario === "corrupt-media"
              ? undefined
              : { speaker: FALLBACK_SPEAKER, text: FALLBACK_TEXT }
          }
          muted
          dimmed={false}
          onReady={onReady}
          onTimeChange={onTimeChange}
          onComplete={onComplete}
        />
      </section>
      <output
        data-p114-state
        data-p114-ready-count={snapshot.readyCount}
        data-p114-native-error-count={snapshot.nativeMediaErrorCount}
        data-p114-native-trusted-seeked-count={snapshot.nativeTrustedSeekedCount}
        data-p114-native-trusted-timeupdate-count={snapshot.nativeTrustedTimeUpdateCount}
        data-p114-completion-count={snapshot.completions.length}
      >
        {JSON.stringify(snapshot)}
      </output>
    </main>
  );
}

export const VIDEO_STORY_PLAYER_BROWSER_EXPECTATIONS = Object.freeze({
  inlineText: INLINE_TEXT,
  inlineSpeaker: INLINE_SPEAKER,
  fallbackText: FALLBACK_TEXT,
  fallbackSpeaker: FALLBACK_SPEAKER,
  vttText: "P1.14 受控 WebVTT 字幕",
});
