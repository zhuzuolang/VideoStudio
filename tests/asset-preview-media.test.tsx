import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import AssetPreviewMedia from "@/app/components/AssetPreviewMedia";
import type { ProjectAsset } from "@/lib/platform-types";

function previewAsset(overrides: Partial<ProjectAsset> = {}): ProjectAsset {
  return {
    id: "asset-video",
    projectId: "project-1",
    name: "海面追逐",
    mediaType: "video",
    category: "final",
    description: null,
    contentUrl: "/api/projects/project-1/assets/asset-video/content",
    sourceUrl: null,
    thumbnailUrl: null,
    status: "ready",
    metadata: null,
    relations: [],
    relationsLoaded: true,
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AssetPreviewMedia", () => {
  test("视频资产进入可视区域后才通过内容地址解码并显示首帧", async () => {
    let onIntersection: ((entries: Array<{ isIntersecting: boolean }>) => void) | null = null;
    class IntersectionObserverStub {
      constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
        onIntersection = callback;
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", IntersectionObserverStub);
    const view = render(<AssetPreviewMedia asset={previewAsset()} />);
    const video = view.container.querySelector("video");

    expect(video).not.toBeNull();
    expect(video).not.toHaveAttribute("src");
    expect(video).toHaveAttribute("preload", "none");
    expect(video).toHaveProperty("muted", true);
    expect(video).toHaveAttribute("playsinline");
    expect(video).toHaveAttribute("data-first-frame-ready", "false");

    act(() => {
      onIntersection?.([{ isIntersecting: true }]);
    });
    await waitFor(() => expect(video).toHaveAttribute(
      "src",
      "/api/projects/project-1/assets/asset-video/content",
    ));
    expect(video).toHaveAttribute("preload", "metadata");

    Object.defineProperty(video, "duration", { configurable: true, value: 8 });
    fireEvent.loadedMetadata(video as HTMLVideoElement);
    expect((video as HTMLVideoElement).currentTime).toBeCloseTo(0.001);

    fireEvent.loadedData(video as HTMLVideoElement);
    expect(video).toHaveAttribute("data-first-frame-ready", "true");

    const pause = vi.spyOn(video as HTMLVideoElement, "pause").mockImplementation(() => undefined);
    const unload = vi.spyOn(video as HTMLVideoElement, "load").mockImplementation(() => undefined);
    act(() => {
      onIntersection?.([{ isIntersecting: false }]);
    });
    await waitFor(() => expect(video).not.toHaveAttribute("src"));
    expect(pause).toHaveBeenCalledOnce();
    expect(unload).toHaveBeenCalledOnce();
    expect(video).toHaveAttribute("preload", "none");
    expect(video).toHaveAttribute("data-first-frame-ready", "false");

    act(() => {
      onIntersection?.([{ isIntersecting: true }]);
    });
    await waitFor(() => expect(video).toHaveAttribute(
      "src",
      "/api/projects/project-1/assets/asset-video/content",
    ));
  });

  test("视频首帧读取失败时回退到资产缩略图", async () => {
    const view = render(
      <AssetPreviewMedia
        asset={previewAsset({ thumbnailUrl: "https://example.test/video-cover.jpg" })}
        alt="海面追逐预览"
      />,
    );
    const video = view.container.querySelector("video");
    expect(video).not.toBeNull();
    expect(view.container.querySelector("img")).toHaveAttribute(
      "src",
      "https://example.test/video-cover.jpg",
    );
    await waitFor(() => expect(video).toHaveAttribute(
      "src",
      "/api/projects/project-1/assets/asset-video/content",
    ));

    fireEvent.error(video as HTMLVideoElement);

    await waitFor(() => expect(view.container.querySelector("video")).toBeNull());
    const image = view.container.querySelector("img");
    expect(image).toHaveAttribute("src", "https://example.test/video-cover.jpg");
    expect(image).toHaveAttribute("alt", "海面追逐预览");
  });

  test("可为分镜卡保留定制缩略图优先级", () => {
    const view = render(
      <AssetPreviewMedia
        asset={previewAsset({
          mediaType: "image",
          contentUrl: "/api/projects/project-1/assets/image-1/content",
          thumbnailUrl: "https://example.test/image-thumb.jpg",
        })}
        preferThumbnail
      />,
    );

    expect(view.container.querySelector("img")).toHaveAttribute(
      "src",
      "https://example.test/image-thumb.jpg",
    );
  });
});
