"use client";

/* eslint-disable @next/next/no-img-element -- previews can use authenticated or user-provided URLs. */

import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import type { ProjectAsset } from "@/lib/platform-types";

type PreviewAsset = Pick<
  ProjectAsset,
  "mediaType" | "contentUrl" | "sourceUrl" | "thumbnailUrl"
>;

type AssetPreviewMediaProps = {
  asset: PreviewAsset;
  alt?: string;
  preferThumbnail?: boolean;
};

const FIRST_FRAME_TIME_SECONDS = 0.001;

function VideoFirstFrame({
  src,
  onError,
}: {
  src: string;
  onError: () => void;
}) {
  const [ready, setReady] = useState(false);
  const [shouldLoad, setShouldLoad] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (typeof IntersectionObserver === "undefined") {
      const timer = setTimeout(() => setShouldLoad(true), 0);
      return () => clearTimeout(timer);
    }
    const observer = new IntersectionObserver((entries) => {
      const isNearViewport = entries.some((entry) => entry.isIntersecting);
      setShouldLoad(isNearViewport);
      if (!isNearViewport) {
        setReady(false);
        if (video.hasAttribute("src")) {
          video.pause();
          video.removeAttribute("src");
          video.load();
        }
      }
    }, { rootMargin: "240px" });
    observer.observe(video);
    return () => observer.disconnect();
  }, [src]);

  function requestFirstFrame(event: SyntheticEvent<HTMLVideoElement>) {
    const video = event.currentTarget;
    const target = Number.isFinite(video.duration) && video.duration > 0
      ? Math.min(FIRST_FRAME_TIME_SECONDS, video.duration / 2)
      : FIRST_FRAME_TIME_SECONDS;
    try {
      video.currentTime = target;
    } catch {
      // Some browsers paint the frame at zero without accepting an early seek.
    }
  }

  return (
    <video
      ref={videoRef}
      src={shouldLoad ? src : undefined}
      preload={shouldLoad ? "metadata" : "none"}
      muted
      playsInline
      disablePictureInPicture
      aria-hidden="true"
      tabIndex={-1}
      data-first-frame-ready={ready ? "true" : "false"}
      onLoadedMetadata={requestFirstFrame}
      onLoadedData={() => setReady(true)}
      onSeeked={() => setReady(true)}
      onError={onError}
    />
  );
}

/** Paints a video's decoded first frame, falling back to its thumbnail or icon. */
export default function AssetPreviewMedia({
  asset,
  alt = "",
  preferThumbnail = false,
}: AssetPreviewMediaProps) {
  const videoSource = asset.mediaType === "video"
    ? asset.contentUrl || asset.sourceUrl
    : null;
  const imageSource = asset.mediaType === "image"
    ? preferThumbnail
      ? asset.thumbnailUrl || asset.contentUrl || asset.sourceUrl
      : asset.contentUrl || asset.thumbnailUrl || asset.sourceUrl
    : asset.thumbnailUrl;
  const [failedVideoSource, setFailedVideoSource] = useState<string | null>(null);
  const [failedImageSource, setFailedImageSource] = useState<string | null>(null);

  const showVideo = Boolean(videoSource && failedVideoSource !== videoSource);
  const showImage = Boolean(imageSource && failedImageSource !== imageSource);

  return (
    <>
      {showImage && imageSource && (
        <img
          key={imageSource}
          src={imageSource}
          alt={alt}
          onError={() => setFailedImageSource(imageSource)}
        />
      )}
      {showVideo && videoSource && (
        <VideoFirstFrame
          key={videoSource}
          src={videoSource}
          onError={() => setFailedVideoSource(videoSource)}
        />
      )}
    </>
  );
}
