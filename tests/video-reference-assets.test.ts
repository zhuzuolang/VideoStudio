import { describe, expect, test, vi } from "vitest";
import {
  MAX_INLINE_VIDEO_REFERENCE_BYTES,
  MAX_LOCAL_VIDEO_REFERENCE_BYTES,
  MAX_TOTAL_LOCAL_VIDEO_REFERENCE_BYTES,
  MAX_VIDEO_REFERENCE_IMAGES,
  parseVideoReferenceAssets,
  resolveVideoReferenceAssets,
  validateVideoReferenceAssets,
} from "@/lib/server/video-reference-assets";
import type { ImageTransformationBinding } from "@/lib/server/runtime";

vi.mock("@/lib/server/store", () => ({
  allRows: async (statement: { all: () => Promise<{ results?: Record<string, unknown>[] }> }) => {
    const result = await statement.all();
    return result.results ?? [];
  },
}));

type ReferenceAssetRow = {
  id: string;
  name: string;
  mediaType: string;
  mimeType: string | null;
  sizeBytes: number | null;
  storageKey: string | null;
  sourceUrl: string | null;
  status: string;
};

function databaseReturning(rows: ReferenceAssetRow[]) {
  const all = vi.fn(async () => ({ results: rows }));
  const bind = vi.fn((...values: unknown[]) => {
    void values;
    return { all };
  });
  const prepare = vi.fn((sql: string) => {
    void sql;
    return { bind };
  });
  return {
    db: { prepare } as unknown as D1Database,
    all,
    bind,
    prepare,
  };
}

function readyImageRow(
  id: string,
  overrides: Partial<ReferenceAssetRow> = {},
): ReferenceAssetRow {
  return {
    id,
    name: `${id}.png`,
    mediaType: "image",
    mimeType: "image/png",
    sizeBytes: 4,
    storageKey: `projects/project-1/${id}.png`,
    sourceUrl: null,
    status: "ready",
    ...overrides,
  };
}

function r2ImageObject(bytes: Uint8Array, contentType = "image/png") {
  return {
    size: bytes.byteLength,
    httpEtag: `etag-${bytes.byteLength}`,
    httpMetadata: { contentType },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    arrayBuffer: async () => bytes.slice().buffer,
  };
}

function imagesReturning(outputs: Uint8Array[]) {
  const transforms: ReturnType<typeof vi.fn>[] = [];
  const outputCalls: ReturnType<typeof vi.fn>[] = [];
  let index = 0;
  const input = vi.fn(() => {
    const bytes = outputs[index++] ?? outputs.at(-1) ?? new Uint8Array();
    const output = vi.fn(async () => ({
      response: () => new Response(bytes.slice().buffer as ArrayBuffer, {
        status: 200,
        headers: { "content-type": "image/webp" },
      }),
    }));
    const transform = vi.fn(() => ({ output }));
    transforms.push(transform);
    outputCalls.push(output);
    return { transform };
  });
  return {
    binding: { input } as unknown as ImageTransformationBinding,
    input,
    transforms,
    outputCalls,
  };
}

function capturedError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to throw");
}

describe("parseVideoReferenceAssets", () => {
  test("parses, normalizes, and preserves the caller's asset order", () => {
    expect(parseVideoReferenceAssets(undefined)).toEqual([]);
    expect(parseVideoReferenceAssets([
      { assetId: " asset-street ", role: "reference_image" },
      { assetId: "asset-character" },
      { assetId: " asset-prop ", role: "reference_image" },
    ])).toEqual([
      { assetId: "asset-street", role: "reference_image" },
      { assetId: "asset-character", role: "reference_image" },
      { assetId: "asset-prop", role: "reference_image" },
    ]);
  });

  test("rejects duplicate asset IDs after normalization", () => {
    const error = capturedError(() => parseVideoReferenceAssets([
      { assetId: "asset-1", role: "reference_image" },
      { assetId: " asset-1 ", role: "reference_image" },
    ]));

    expect(error).toMatchObject({
      status: 400,
      code: "DUPLICATE_VIDEO_REFERENCE_ASSET",
    });
  });

  test("rejects lists above the global reference-image limit", () => {
    const error = capturedError(() => parseVideoReferenceAssets(
      Array.from({ length: MAX_VIDEO_REFERENCE_IMAGES + 1 }, (_, index) => ({
        assetId: `asset-${index}`,
        role: "reference_image",
      })),
    ));

    expect(error).toMatchObject({
      status: 400,
      code: "TOO_MANY_VIDEO_REFERENCES",
    });
  });
});

describe("resolveVideoReferenceAssets", () => {
  test("restores input order, converts R2 bytes to a data URL, and preserves external URLs", async () => {
    const externalUrl = "https://images.example.test/street.webp?version=2";
    const rows = [
      readyImageRow("asset-r2", {
        mimeType: null,
        storageKey: "projects/project-1/reference-portrait.bin",
      }),
      readyImageRow("asset-external", {
        mimeType: "image/webp",
        storageKey: null,
        sourceUrl: externalUrl,
      }),
    ];
    const { db, bind } = databaseReturning(rows);
    const get = vi.fn(async (key: string) => {
      expect(key).toBe("projects/project-1/reference-portrait.bin");
      return {
        httpMetadata: { contentType: "image/png" },
        arrayBuffer: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer,
      };
    });
    const bucket = { get } as unknown as R2Bucket;

    const resolved = await resolveVideoReferenceAssets(db, bucket, "project-1", [
      { assetId: "asset-external", role: "reference_image" },
      { assetId: "asset-r2", role: "reference_image" },
    ]);

    expect(bind).toHaveBeenCalledWith("project-1", "asset-external", "asset-r2");
    expect(resolved).toEqual([
      { url: externalUrl, role: "reference_image" },
      { url: "data:image/png;base64,iVBORw==", role: "reference_image" },
    ]);
    expect(get).toHaveBeenCalledOnce();
  });

  test("keeps local references unchanged when their aggregate fits the inline budget", async () => {
    const dominantBytes = new Uint8Array(1_400_000).fill(0x31);
    const companionBytes = new Uint8Array(300_000).fill(0x32);
    expect(dominantBytes.byteLength).toBeGreaterThan(MAX_INLINE_VIDEO_REFERENCE_BYTES / 2);
    expect(dominantBytes.byteLength + companionBytes.byteLength).toBeLessThan(MAX_INLINE_VIDEO_REFERENCE_BYTES);
    const { db } = databaseReturning([
      readyImageRow("asset-dominant", { sizeBytes: dominantBytes.byteLength }),
      readyImageRow("asset-companion", { sizeBytes: companionBytes.byteLength }),
    ]);
    const get = vi.fn(async (key: string) => {
      if (key.endsWith("asset-dominant.png")) return r2ImageObject(dominantBytes);
      if (key.endsWith("asset-companion.png")) return r2ImageObject(companionBytes);
      throw new Error(`unexpected R2 key: ${key}`);
    });

    const resolved = await resolveVideoReferenceAssets(
      db,
      { get } as unknown as R2Bucket,
      "project-1",
      [
        { assetId: "asset-dominant", role: "reference_image" },
        { assetId: "asset-companion", role: "reference_image" },
      ],
    );

    expect(resolved.map((reference) => reference.url.slice(0, reference.url.indexOf(",") + 1))).toEqual([
      "data:image/png;base64,",
      "data:image/png;base64,",
    ]);
    expect(resolved[0].url.split(",")[1]).toHaveLength(4 * Math.ceil(dominantBytes.byteLength / 3));
    expect(resolved[1].url.split(",")[1]).toHaveLength(4 * Math.ceil(companionBytes.byteLength / 3));
  });

  test("water-fills the inline budget so small references stay intact and larger ones use the remainder", async () => {
    const smallBytes = new Uint8Array(128 * 1024).fill(0x31);
    const largeBytes = new Uint8Array(MAX_INLINE_VIDEO_REFERENCE_BYTES).fill(0x32);
    const largeBudget = MAX_INLINE_VIDEO_REFERENCE_BYTES - smallBytes.byteLength;
    const compactedBytes = new Uint8Array(largeBudget).fill(0x33);
    const { db } = databaseReturning([
      readyImageRow("asset-small", { sizeBytes: smallBytes.byteLength }),
      readyImageRow("asset-large", { sizeBytes: largeBytes.byteLength }),
    ]);
    const get = vi.fn(async (key: string) => {
      if (key.endsWith("asset-small.png")) return r2ImageObject(smallBytes);
      if (key.endsWith("asset-large.png")) return r2ImageObject(largeBytes);
      throw new Error(`unexpected R2 key: ${key}`);
    });
    const images = imagesReturning([compactedBytes]);

    const resolved = await resolveVideoReferenceAssets(
      db,
      { get } as unknown as R2Bucket,
      "project-1",
      [
        { assetId: "asset-small", role: "reference_image" },
        { assetId: "asset-large", role: "reference_image" },
      ],
      images.binding,
    );

    expect(resolved[0].url).toMatch(/^data:image\/png;base64,/);
    expect(resolved[1].url).toMatch(/^data:image\/webp;base64,/);
    expect(resolved[0].url.split(",")[1]).toHaveLength(4 * Math.ceil(smallBytes.byteLength / 3));
    expect(resolved[1].url.split(",")[1]).toHaveLength(4 * Math.ceil(compactedBytes.byteLength / 3));
    expect(images.input).toHaveBeenCalledOnce();
  });

  test("compacts large local references to WebP while preserving order, roles, and remote URL bypass", async () => {
    const firstBytes = new Uint8Array(2_360_000).fill(0x31);
    const lastBytes = new Uint8Array(1_950_000).fill(0x32);
    const remoteUrl = "https://images.example.test/reference.webp?signature=kept";
    const rows = [
      readyImageRow("asset-last", { sizeBytes: lastBytes.byteLength }),
      readyImageRow("asset-remote", {
        mimeType: "image/webp",
        sizeBytes: null,
        storageKey: null,
        sourceUrl: remoteUrl,
      }),
      readyImageRow("asset-first", { sizeBytes: firstBytes.byteLength }),
    ];
    const { db } = databaseReturning(rows);
    const get = vi.fn(async (key: string) => {
      if (key.endsWith("asset-first.png")) return r2ImageObject(firstBytes);
      if (key.endsWith("asset-last.png")) return r2ImageObject(lastBytes);
      throw new Error(`unexpected R2 key: ${key}`);
    });
    const images = imagesReturning([
      new Uint8Array([0x52, 0x49, 0x46, 0x46]),
      new Uint8Array([0x57, 0x45, 0x42, 0x50]),
    ]);

    const resolved = await resolveVideoReferenceAssets(
      db,
      { get } as unknown as R2Bucket,
      "project-1",
      [
        { assetId: "asset-first", role: "reference_image" },
        { assetId: "asset-remote", role: "reference_image" },
        { assetId: "asset-last", role: "reference_image" },
      ],
      images.binding,
    );

    expect(resolved).toEqual([
      { url: "data:image/webp;base64,UklGRg==", role: "reference_image" },
      { url: remoteUrl, role: "reference_image" },
      { url: "data:image/webp;base64,V0VCUA==", role: "reference_image" },
    ]);
    expect(get).toHaveBeenCalledTimes(2);
    expect(images.input).toHaveBeenCalledTimes(2);
    expect(images.transforms).toHaveLength(2);
    for (const transform of images.transforms) {
      expect(transform).toHaveBeenCalledWith(expect.objectContaining({
        width: expect.any(Number),
        height: expect.any(Number),
        fit: "scale-down",
      }));
      const transformOptions = transform.mock.calls[0][0] as { width: number; height: number };
      expect(transformOptions.height).toBe(transformOptions.width);
    }
    for (const output of images.outputCalls) {
      expect(output).toHaveBeenCalledWith(expect.objectContaining({
        format: "image/webp",
        quality: expect.any(Number),
      }));
    }
    const encodedBytes = resolved.reduce((total, item) => total + item.url.length, 0);
    expect(encodedBytes).toBeLessThan((firstBytes.byteLength + lastBytes.byteLength) / 10);
  });

  test("uses the injected Worker fallback when a large local reference has no Images binding", async () => {
    const bytes = new Uint8Array(2_360_000).fill(0x31);
    const compactedBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const { db } = databaseReturning([
      readyImageRow("asset-large", { sizeBytes: bytes.byteLength }),
    ]);
    const bucket = {
      get: vi.fn(async () => r2ImageObject(bytes)),
    } as unknown as R2Bucket;
    const fallback = vi.fn(async (
      sourceBytes: Uint8Array<ArrayBuffer>,
      mimeType: string,
      byteBudget: number,
      attempts: readonly { width: number; quality: number }[],
    ) => {
      expect(sourceBytes.byteLength).toBe(bytes.byteLength);
      expect(mimeType).toBe("image/png");
      expect(byteBudget).toBe(MAX_INLINE_VIDEO_REFERENCE_BYTES);
      expect(attempts).toEqual([{ width: 720, quality: 62 }]);
      return { bytes: compactedBytes, mimeType: "image/jpeg" as const };
    });

    await expect(resolveVideoReferenceAssets(
      db,
      bucket,
      "project-1",
      [{ assetId: "asset-large", role: "reference_image" }],
      undefined,
      fallback,
    )).resolves.toEqual([
      { url: "data:image/jpeg;base64,/9j/2Q==", role: "reference_image" },
    ]);
    expect(fallback).toHaveBeenCalledOnce();
  });

  test("reads and optimizes fallback references one at a time to bound Worker memory", async () => {
    const bytes = new Uint8Array(1_500_000).fill(0x31);
    const { db } = databaseReturning([
      readyImageRow("asset-first", { sizeBytes: bytes.byteLength }),
      readyImageRow("asset-second", { sizeBytes: bytes.byteLength }),
    ]);
    const get = vi.fn(async () => r2ImageObject(bytes));
    const bucket = { get } as unknown as R2Bucket;
    const fallback = vi.fn(async () => ({
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      mimeType: "image/jpeg" as const,
    }));

    await resolveVideoReferenceAssets(
      db,
      bucket,
      "project-1",
      [
        { assetId: "asset-first", role: "reference_image" },
        { assetId: "asset-second", role: "reference_image" },
      ],
      undefined,
      fallback,
    );

    expect(get).toHaveBeenCalledTimes(2);
    expect(fallback).toHaveBeenCalledTimes(2);
    expect(get.mock.invocationCallOrder[1]).toBeGreaterThan(fallback.mock.invocationCallOrder[0]);
  });

  test("maps an injected Worker fallback failure to a retryable optimization error", async () => {
    const bytes = new Uint8Array(2_360_000).fill(0x31);
    const { db } = databaseReturning([
      readyImageRow("asset-large", { sizeBytes: bytes.byteLength }),
    ]);
    const bucket = {
      get: vi.fn(async () => r2ImageObject(bytes)),
    } as unknown as R2Bucket;
    const fallback = vi.fn(async () => {
      throw new Error("Worker codec failed");
    });

    await expect(resolveVideoReferenceAssets(
      db,
      bucket,
      "project-1",
      [{ assetId: "asset-large", role: "reference_image" }],
      undefined,
      fallback,
    )).rejects.toMatchObject({
      status: 503,
      code: "VIDEO_REFERENCE_OPTIMIZATION_FAILED",
    });
    expect(fallback).toHaveBeenCalledOnce();
  });

  test("rejects fallback output that exceeds its allocated inline budget", async () => {
    const bytes = new Uint8Array(2_360_000).fill(0x31);
    const { db } = databaseReturning([
      readyImageRow("asset-large", { sizeBytes: bytes.byteLength }),
    ]);
    const bucket = {
      get: vi.fn(async () => r2ImageObject(bytes)),
    } as unknown as R2Bucket;
    const fallback = vi.fn(async () => ({
      bytes: new Uint8Array(MAX_INLINE_VIDEO_REFERENCE_BYTES + 1),
      mimeType: "image/jpeg" as const,
    }));

    await expect(resolveVideoReferenceAssets(
      db,
      bucket,
      "project-1",
      [{ assetId: "asset-large", role: "reference_image" }],
      undefined,
      fallback,
    )).rejects.toMatchObject({
      status: 413,
      code: "VIDEO_REFERENCE_PAYLOAD_TOO_LARGE",
    });
  });

  test("keeps unsupported fallback formats as deterministic input errors", async () => {
    const bytes = new Uint8Array(2_360_000).fill(0x31);
    const { db } = databaseReturning([
      readyImageRow("asset-large", {
        mimeType: "image/gif",
        sizeBytes: bytes.byteLength,
        storageKey: "projects/project-1/asset-large.gif",
      }),
    ]);
    const bucket = {
      get: vi.fn(async () => r2ImageObject(bytes, "image/gif")),
    } as unknown as R2Bucket;
    const fallback = vi.fn(async () => ({
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      mimeType: "image/jpeg" as const,
    }));

    await expect(resolveVideoReferenceAssets(
      db,
      bucket,
      "project-1",
      [{ assetId: "asset-large", role: "reference_image" }],
      undefined,
      fallback,
    )).rejects.toMatchObject({
      status: 415,
      code: "VIDEO_REFERENCE_OPTIMIZATION_UNSUPPORTED",
    });
    expect(fallback).not.toHaveBeenCalled();
  });

  test("uses the bounded Worker fallback when an available Images binding cannot compact a local reference", async () => {
    const bytes = new Uint8Array(2_360_000).fill(0x31);
    const { db } = databaseReturning([
      readyImageRow("asset-large", { sizeBytes: bytes.byteLength }),
    ]);
    const bucket = {
      get: vi.fn(async () => r2ImageObject(bytes)),
    } as unknown as R2Bucket;
    const images = {
      input: vi.fn(() => ({
        transform: vi.fn(() => ({
          output: vi.fn(async () => {
            throw new Error("Images binding unavailable");
          }),
        })),
      })),
    };
    const fallback = vi.fn(async () => ({
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      mimeType: "image/jpeg" as const,
    }));

    await expect(resolveVideoReferenceAssets(
      db,
      bucket,
      "project-1",
      [{ assetId: "asset-large", role: "reference_image" }],
      images as unknown as ImageTransformationBinding,
      fallback,
    )).resolves.toEqual([
      { url: "data:image/jpeg;base64,/9j/2Q==", role: "reference_image" },
    ]);
    expect(fallback).toHaveBeenCalledOnce();
  });

  test("rejects an Images result that remains above the inline payload budget after all attempts", async () => {
    const original = new Uint8Array(2_360_000).fill(0x31);
    const oversized = new Uint8Array(MAX_LOCAL_VIDEO_REFERENCE_BYTES + 1).fill(0x32);
    const { db } = databaseReturning([
      readyImageRow("asset-large", { sizeBytes: original.byteLength }),
    ]);
    const bucket = {
      get: vi.fn(async () => r2ImageObject(original)),
    } as unknown as R2Bucket;
    const images = imagesReturning([oversized]);

    await expect(resolveVideoReferenceAssets(
      db,
      bucket,
      "project-1",
      [{ assetId: "asset-large", role: "reference_image" }],
      images.binding,
    )).rejects.toMatchObject({
      status: 413,
      code: "VIDEO_REFERENCE_PAYLOAD_TOO_LARGE",
    });
    expect(images.input).toHaveBeenCalledTimes(4);
  });

  test("streams transformed output and cancels an attempt as soon as it crosses the byte budget", async () => {
    const original = new Uint8Array(2_360_000).fill(0x31);
    const { db } = databaseReturning([
      readyImageRow("asset-large", { sizeBytes: original.byteLength }),
    ]);
    const bucket = {
      get: vi.fn(async () => r2ImageObject(original)),
    } as unknown as R2Bucket;
    const cancelOversized = vi.fn();
    const oversizedResponse = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1_100_000).fill(0x32));
        controller.enqueue(new Uint8Array(1_100_000).fill(0x32));
      },
      cancel: cancelOversized,
    }), { status: 200 });
    const acceptedBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
    const responses = [
      oversizedResponse,
      new Response(acceptedBytes.slice().buffer as ArrayBuffer, { status: 200 }),
    ];
    let responseIndex = 0;
    const input = vi.fn(() => {
      const response = responses[responseIndex++];
      return {
        transform: vi.fn(() => ({
          output: vi.fn(async () => ({ response: () => response })),
        })),
      };
    });

    await expect(resolveVideoReferenceAssets(
      db,
      bucket,
      "project-1",
      [{ assetId: "asset-large", role: "reference_image" }],
      { input } as unknown as ImageTransformationBinding,
    )).resolves.toEqual([
      { url: "data:image/webp;base64,UklGRg==", role: "reference_image" },
    ]);
    expect(input).toHaveBeenCalledTimes(2);
    expect(cancelOversized).toHaveBeenCalledOnce();
  });
});

describe("validateVideoReferenceAssets", () => {
  test("rejects missing and non-image project assets", async () => {
    const missing = databaseReturning([]);
    await expect(validateVideoReferenceAssets(missing.db, "project-1", [
      { assetId: "asset-from-another-project", role: "reference_image" },
    ])).rejects.toMatchObject({
      status: 400,
      code: "VIDEO_REFERENCE_ASSET_NOT_FOUND",
    });

    const nonImage = databaseReturning([
      readyImageRow("asset-video", { mediaType: "video", mimeType: "video/mp4" }),
    ]);
    await expect(validateVideoReferenceAssets(nonImage.db, "project-1", [
      { assetId: "asset-video", role: "reference_image" },
    ])).rejects.toMatchObject({
      status: 400,
      code: "VIDEO_REFERENCE_ASSET_NOT_IMAGE",
    });
  });

  test("rejects per-file and aggregate local-byte limits before reading R2", async () => {
    const oversized = databaseReturning([
      readyImageRow("asset-large", { sizeBytes: MAX_LOCAL_VIDEO_REFERENCE_BYTES + 1 }),
    ]);
    await expect(validateVideoReferenceAssets(oversized.db, "project-1", [
      { assetId: "asset-large", role: "reference_image" },
    ])).rejects.toMatchObject({
      status: 413,
      code: "VIDEO_REFERENCE_ASSET_TOO_LARGE",
    });

    const aggregateSize = Math.floor(MAX_TOTAL_LOCAL_VIDEO_REFERENCE_BYTES / 4) + 1;
    const aggregateRows = Array.from({ length: 4 }, (_, index) => (
      readyImageRow(`asset-${index}`, { sizeBytes: aggregateSize })
    ));
    const aggregate = databaseReturning(aggregateRows.slice().reverse());
    await expect(validateVideoReferenceAssets(
      aggregate.db,
      "project-1",
      aggregateRows.map((row) => ({ assetId: row.id, role: "reference_image" as const })),
    )).rejects.toMatchObject({
      status: 413,
      code: "VIDEO_REFERENCE_ASSETS_TOO_LARGE",
    });
  });
});
