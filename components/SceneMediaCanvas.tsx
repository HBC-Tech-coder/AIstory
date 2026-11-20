"use client";

import type { MouseEvent } from "react";

import {
  VideoStoryPlayer,
  type VideoStoryCompletion,
  type VideoStoryPlaybackTime,
} from "./VideoStoryPlayer";
import type { SceneMedia } from "@infiplot/types";

export function SceneMediaCanvas({
  media,
  fallbackImageUrl,
  imageRef,
  intrinsicWidth,
  intrinsicHeight,
  imageAlt,
  imageClassName,
  imageStyle,
  muted,
  dimmed,
  fallbackSubtitle,
  onImageClick,
  onReady,
  onVideoTimeChange,
  onVideoComplete,
}: {
  media: SceneMedia;
  fallbackImageUrl: string | null;
  imageRef: React.RefObject<HTMLImageElement | null>;
  intrinsicWidth: number;
  intrinsicHeight: number;
  imageAlt: string;
  imageClassName: string;
  imageStyle: React.CSSProperties;
  muted: boolean;
  dimmed: boolean;
  fallbackSubtitle?: { speaker?: string; text: string };
  onImageClick: (event: MouseEvent<HTMLImageElement>) => void;
  onReady?: () => void;
  onVideoTimeChange?: (event: VideoStoryPlaybackTime) => void;
  onVideoComplete: (event: VideoStoryCompletion) => void;
}) {
  if (media.kind === "video") {
    return (
      <VideoStoryPlayer
        key={media.url}
        media={media}
        fallbackSubtitle={fallbackSubtitle}
        muted={muted}
        dimmed={dimmed}
        onReady={onReady}
        onTimeChange={onVideoTimeChange}
        onComplete={onVideoComplete}
      />
    );
  }

  const imageUrl = media.url || fallbackImageUrl;
  if (!imageUrl) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- raw/blob/data scene media must preserve exact canvas geometry and provider URLs.
    <img
      key={imageUrl.slice(-48)}
      ref={imageRef}
      src={imageUrl}
      width={intrinsicWidth}
      height={intrinsicHeight}
      alt={imageAlt}
      onClick={onImageClick}
      draggable={false}
      onLoad={() => {
        if (!onReady) return;
        const image = imageRef.current;
        if (!image) {
          onReady();
          return;
        }
        const notify = () => {
          if (imageRef.current === image) onReady();
        };
        image.decode().then(notify, notify);
      }}
      className={imageClassName}
      style={imageStyle}
    />
  );
}
