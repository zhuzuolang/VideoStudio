import { describe, expect, test, vi } from "vitest";
import {
  MAX_LOCAL_VIDEO_REFERENCE_BYTES,
  MAX_TOTAL_LOCAL_VIDEO_REFERENCE_BYTES,
  MAX_VIDEO_REFERENCE_IMAGES,
  parseVideoReferenceAssets,
  resolveVideoReferenceAssets,
  validateVideoReferenceAssets,
} from "@/lib/server/video-reference-assets";

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
