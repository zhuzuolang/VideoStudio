import type {
  VideoReferenceAssetInput,
  VideoReferenceImageRole,
} from "../platform-types";
import type { SeedanceVideoPreset } from "../seedance-model-presets";
import { ApiError } from "./api";
import type { ImageTransformationBinding } from "./runtime";
import { allRows } from "./store";
import type { VideoReferenceImageInput } from "./video-generation";

export const MAX_VIDEO_REFERENCE_IMAGES = 30;
export const MAX_LOCAL_VIDEO_REFERENCE_BYTES = 8 * 1024 * 1024;
export const MAX_TOTAL_LOCAL_VIDEO_REFERENCE_BYTES = 24 * 1024 * 1024;
// Inline image bytes are base64-expanded inside the provider JSON request. Keeping
// the raw total near 2 MB leaves enough time for the cross-region upload before
// the hosting platform's request lifetime limit.
export const MAX_INLINE_VIDEO_REFERENCE_BYTES = 2 * 1024 * 1024;
const REFERENCE_IO_CONCURRENCY = 4;

const VIDEO_REFERENCE_ROLES = new Set<VideoReferenceImageRole>([
  "first_frame",
  "last_frame",
  "reference_image",
]);
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/bmp",
  "image/tiff",
  "image/gif",
  "image/heic",
  "image/heif",
]);
const OPTIMIZABLE_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
]);

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

type LoadedReference = {
  kind: "local";
  name: string;
  role: VideoReferenceImageRole;
  mimeType: string;
  bytes: Uint8Array<ArrayBuffer>;
} | {
  kind: "remote";
  role: VideoReferenceImageRole;
  url: string;
};

export function parseVideoReferenceAssets(value: unknown): VideoReferenceAssetInput[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ApiError(400, "INVALID_VIDEO_REFERENCE_ASSETS", "参考图必须是有序资产列表。");
  }
  if (value.length > MAX_VIDEO_REFERENCE_IMAGES) {
    throw new ApiError(400, "TOO_MANY_VIDEO_REFERENCES", `单次视频任务最多接收 ${MAX_VIDEO_REFERENCE_IMAGES} 张参考图。`);
  }

  const references = value.map((item, index): VideoReferenceAssetInput => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ApiError(400, "INVALID_VIDEO_REFERENCE_ASSETS", `第 ${index + 1} 张参考图格式无效。`);
    }
    const record = item as Record<string, unknown>;
    const assetId = typeof record.assetId === "string" ? record.assetId.trim() : "";
    const role = typeof record.role === "string" ? record.role.trim() as VideoReferenceImageRole : "reference_image";
    if (!assetId || assetId.length > 240 || /[\u0000-\u001f\u007f]/.test(assetId)) {
      throw new ApiError(400, "INVALID_VIDEO_REFERENCE_ASSETS", `第 ${index + 1} 张参考图缺少有效的资产编号。`);
    }
    if (!VIDEO_REFERENCE_ROLES.has(role)) {
      throw new ApiError(400, "INVALID_VIDEO_REFERENCE_ROLE", `第 ${index + 1} 张参考图的参考方式无效。`);
    }
    return { assetId, role };
  });

  const ids = new Set<string>();
  for (const reference of references) {
    if (ids.has(reference.assetId)) {
      throw new ApiError(400, "DUPLICATE_VIDEO_REFERENCE_ASSET", "同一项目图片不能在参考图列表中重复添加。");
    }
    ids.add(reference.assetId);
  }
  validateReferenceMode(references);
  return references;
}

export function validateVideoReferenceProfile(
  references: readonly VideoReferenceAssetInput[],
  profile: SeedanceVideoPreset,
): void {
  for (const reference of references) {
    if (!profile.referenceImageRoles.includes(reference.role)) {
      throw new ApiError(400, "INVALID_VIDEO_REFERENCE_ROLE", `当前模型不支持 ${reference.role} 参考方式。`);
    }
  }
  const generalCount = references.filter((reference) => reference.role === "reference_image").length;
  if (generalCount > profile.maxReferenceImages) {
    throw new ApiError(
      400,
      "TOO_MANY_VIDEO_REFERENCES",
      `当前模型最多接收 ${profile.maxReferenceImages} 张内容参考图。`,
    );
  }
}

export async function validateVideoReferenceAssets(
  db: D1Database,
  projectId: string,
  references: readonly VideoReferenceAssetInput[],
): Promise<void> {
  if (references.length === 0) return;
  const rows = await loadReferenceAssetRows(db, projectId, references);
  let knownLocalBytes = 0;
  for (const row of rows) {
    validateReferenceAssetRow(row);
    if (row.storageKey && row.sizeBytes) {
      if (row.sizeBytes > MAX_LOCAL_VIDEO_REFERENCE_BYTES) {
        throw new ApiError(413, "VIDEO_REFERENCE_ASSET_TOO_LARGE", `项目图片“${row.name}”超过 8 MB，无法作为视频参考图。`);
      }
      knownLocalBytes += row.sizeBytes;
    }
  }
  if (knownLocalBytes > MAX_TOTAL_LOCAL_VIDEO_REFERENCE_BYTES) {
    throw new ApiError(413, "VIDEO_REFERENCE_ASSETS_TOO_LARGE", "所选项目图片的本地文件合计不能超过 24 MB。");
  }
}

export async function resolveVideoReferenceAssets(
  db: D1Database,
  bucket: R2Bucket,
  projectId: string,
  references: readonly VideoReferenceAssetInput[],
  images?: ImageTransformationBinding,
): Promise<VideoReferenceImageInput[]> {
  if (references.length === 0) return [];
  const rows = await loadReferenceAssetRows(db, projectId, references);
  let declaredLocalBytes = 0;
  let localBytes = 0;
  const loaded = await mapWithConcurrency(rows, REFERENCE_IO_CONCURRENCY, async (row, index): Promise<LoadedReference> => {
    validateReferenceAssetRow(row);
    const role = references[index].role;
    if (!row.storageKey) {
      return { kind: "remote", url: row.sourceUrl as string, role };
    }

    const object = await bucket.get(row.storageKey);
    if (!object) {
      throw new ApiError(409, "VIDEO_REFERENCE_ASSET_CONTENT_MISSING", `项目图片“${row.name}”的文件已不存在，请重新选择参考图。`);
    }
    if (object.size > MAX_LOCAL_VIDEO_REFERENCE_BYTES) {
      throw new ApiError(413, "VIDEO_REFERENCE_ASSET_TOO_LARGE", `项目图片“${row.name}”超过 8 MB，无法作为视频参考图。`);
    }
    declaredLocalBytes += object.size;
    if (declaredLocalBytes > MAX_TOTAL_LOCAL_VIDEO_REFERENCE_BYTES) {
      throw new ApiError(413, "VIDEO_REFERENCE_ASSETS_TOO_LARGE", "所选项目图片的本地文件合计不能超过 24 MB。");
    }
    const buffer = await object.arrayBuffer();
    if (buffer.byteLength > MAX_LOCAL_VIDEO_REFERENCE_BYTES) {
      throw new ApiError(413, "VIDEO_REFERENCE_ASSET_TOO_LARGE", `项目图片“${row.name}”超过 8 MB，无法作为视频参考图。`);
    }
    localBytes += buffer.byteLength;
    if (localBytes > MAX_TOTAL_LOCAL_VIDEO_REFERENCE_BYTES) {
      throw new ApiError(413, "VIDEO_REFERENCE_ASSETS_TOO_LARGE", "所选项目图片的本地文件合计不能超过 24 MB。");
    }
    const mimeType = normalizedImageMimeType(
      row.mimeType || object.httpMetadata?.contentType || "",
      row.storageKey,
    );
    if (!mimeType) {
      throw new ApiError(400, "VIDEO_REFERENCE_ASSET_TYPE_UNSUPPORTED", `项目图片“${row.name}”的文件格式不受 Seedance 支持。`);
    }
    return {
      kind: "local",
      name: row.name,
      role,
      mimeType,
      bytes: new Uint8Array(buffer),
    };
  });

  const localSizes = loaded
    .filter((reference): reference is Extract<LoadedReference, { kind: "local" }> => reference.kind === "local")
    .map((reference) => reference.bytes.byteLength);
  const localBudgets = allocateInlineByteBudgets(localSizes, MAX_INLINE_VIDEO_REFERENCE_BYTES);
  let localIndex = 0;
  const budgetsByReference = loaded.map((reference) => (
    reference.kind === "local" ? localBudgets[localIndex++] : null
  ));

  return mapWithConcurrency(loaded, REFERENCE_IO_CONCURRENCY, async (reference, index) => {
    if (reference.kind === "remote") return { url: reference.url, role: reference.role };
    const inlineByteBudget = budgetsByReference[index] as number;
    let inlineBytes = reference.bytes;
    let inlineMimeType = reference.mimeType;
    if (inlineBytes.byteLength > inlineByteBudget) {
      if (!OPTIMIZABLE_IMAGE_MIME_TYPES.has(inlineMimeType)) {
        throw new ApiError(
          415,
          "VIDEO_REFERENCE_OPTIMIZATION_UNSUPPORTED",
          `项目图片“${reference.name}”的格式无法在线压缩，请先转换为 JPEG、PNG 或 WebP。`,
        );
      }
      if (!images) {
        throw new ApiError(
          503,
          "VIDEO_REFERENCE_OPTIMIZATION_UNAVAILABLE",
          `项目图片“${reference.name}”需要压缩后才能提交视频任务，但图片处理服务当前不可用，请稍后重试。`,
        );
      }
      const optimized = await optimizeInlineReferenceImage(
        images,
        inlineBytes,
        inlineByteBudget,
        reference.name,
      );
      inlineBytes = optimized.bytes;
      inlineMimeType = optimized.mimeType;
    }
    return {
      url: `data:${inlineMimeType};base64,${arrayBufferToBase64(inlineBytes)}`,
      role: reference.role,
    };
  });
}

async function optimizeInlineReferenceImage(
  images: ImageTransformationBinding,
  sourceBytes: Uint8Array<ArrayBuffer>,
  byteBudget: number,
  assetName: string,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; mimeType: "image/webp" }> {
  const attempts = optimizationAttempts(byteBudget);
  try {
    for (const attempt of attempts) {
      const source = new Response(sourceBytes.slice().buffer).body;
      if (!source) throw new Error("Reference image stream is unavailable");
      const transformed = await images
        .input(source)
        .transform({ width: attempt.width, height: attempt.width, fit: "scale-down" })
        .output({ format: "image/webp", quality: attempt.quality, anim: false });
      const response = transformed.response();
      if (!response.ok) throw new Error(`Image transformation returned ${response.status}`);
      const bytes = await readTransformBytesWithinLimit(response, byteBudget);
      if (bytes && bytes.byteLength > 0) {
        return { bytes, mimeType: "image/webp" };
      }
    }
  } catch (error) {
    console.error("Video reference image optimization failed", { assetName, error });
    throw new ApiError(
      503,
      "VIDEO_REFERENCE_OPTIMIZATION_FAILED",
      `项目图片“${assetName}”暂时无法压缩为视频参考图，请稍后重试。`,
    );
  }
  throw new ApiError(
    413,
    "VIDEO_REFERENCE_PAYLOAD_TOO_LARGE",
    `项目图片“${assetName}”压缩后仍过大，请换用尺寸更小的参考图。`,
  );
}

function allocateInlineByteBudgets(sizes: readonly number[], totalBudget: number): number[] {
  if (sizes.reduce((total, size) => total + size, 0) <= totalBudget) return [...sizes];
  const budgets = new Array<number>(sizes.length).fill(0);
  const ascending = sizes.map((size, index) => ({ size, index })).sort((a, b) => a.size - b.size);
  let remainingBudget = totalBudget;
  let cursor = 0;
  while (cursor < ascending.length) {
    const remainingCount = ascending.length - cursor;
    const equalShare = Math.floor(remainingBudget / remainingCount);
    if (ascending[cursor].size > equalShare) break;
    budgets[ascending[cursor].index] = ascending[cursor].size;
    remainingBudget -= ascending[cursor].size;
    cursor += 1;
  }
  const remainingCount = ascending.length - cursor;
  if (remainingCount > 0) {
    const equalShare = Math.floor(remainingBudget / remainingCount);
    let remainder = remainingBudget - equalShare * remainingCount;
    for (; cursor < ascending.length; cursor += 1) {
      budgets[ascending[cursor].index] = equalShare + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder -= 1;
    }
  }
  return budgets;
}

async function readTransformBytesWithinLimit(
  response: Response,
  byteBudget: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!response.body) throw new Error("Image transformation returned an empty body");
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > byteBudget) {
    await response.body.cancel().catch(() => undefined);
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBufferLike>[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > byteBudget) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      results[index] = await mapper(values[index], index);
    }
  }));
  return results;
}

function optimizationAttempts(byteBudget: number): Array<{ width: number; quality: number }> {
  if (byteBudget >= 768 * 1024) {
    return [
      { width: 1_600, quality: 84 },
      { width: 1_280, quality: 78 },
      { width: 960, quality: 70 },
      { width: 720, quality: 62 },
    ];
  }
  if (byteBudget >= 384 * 1024) {
    return [
      { width: 1_280, quality: 80 },
      { width: 1_024, quality: 74 },
      { width: 768, quality: 66 },
      { width: 576, quality: 58 },
    ];
  }
  if (byteBudget >= 192 * 1024) {
    return [
      { width: 960, quality: 76 },
      { width: 768, quality: 68 },
      { width: 576, quality: 60 },
      { width: 480, quality: 52 },
    ];
  }
  return [
    { width: 720, quality: 68 },
    { width: 576, quality: 60 },
    { width: 480, quality: 52 },
    { width: 384, quality: 44 },
  ];
}

function validateReferenceMode(references: readonly VideoReferenceAssetInput[]): void {
  const generalCount = references.filter((reference) => reference.role === "reference_image").length;
  const firstCount = references.filter((reference) => reference.role === "first_frame").length;
  const lastCount = references.filter((reference) => reference.role === "last_frame").length;
  if (firstCount > 1 || lastCount > 1) {
    throw new ApiError(400, "DUPLICATE_VIDEO_REFERENCE_ROLE", "首帧和尾帧分别最多只能选择一张图片。");
  }
  if (generalCount > 0 && (firstCount > 0 || lastCount > 0)) {
    throw new ApiError(400, "INVALID_VIDEO_REFERENCE_MODE", "内容参考图不能与首帧或尾帧模式混用。");
  }
  if (lastCount > 0 && firstCount === 0) {
    throw new ApiError(400, "INVALID_VIDEO_REFERENCE_MODE", "设置尾帧时必须同时提供首帧。");
  }
  if (firstCount > 0 && references[0]?.role !== "first_frame") {
    throw new ApiError(400, "INVALID_VIDEO_REFERENCE_MODE", "首帧必须是参考图列表中的第一张图片。");
  }
  if (lastCount > 0 && (references.length !== 2 || references[1]?.role !== "last_frame")) {
    throw new ApiError(400, "INVALID_VIDEO_REFERENCE_MODE", "首尾帧模式必须依次提供一张首帧和一张尾帧图片。");
  }
}

async function loadReferenceAssetRows(
  db: D1Database,
  projectId: string,
  references: readonly VideoReferenceAssetInput[],
): Promise<ReferenceAssetRow[]> {
  const placeholders = references.map(() => "?").join(", ");
  const rows = await allRows(db.prepare(`SELECT id, name, media_type AS mediaType, mime_type AS mimeType,
    size_bytes AS sizeBytes, storage_key AS storageKey, source_url AS sourceUrl, status
    FROM assets WHERE project_id = ? AND id IN (${placeholders})`).bind(
    projectId,
    ...references.map((reference) => reference.assetId),
  )) as ReferenceAssetRow[];
  if (rows.length !== references.length) {
    throw new ApiError(400, "VIDEO_REFERENCE_ASSET_NOT_FOUND", "部分参考图不存在或不属于当前项目，请重新选择。");
  }
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  return references.map((reference) => byId.get(reference.assetId) as ReferenceAssetRow);
}

function validateReferenceAssetRow(row: ReferenceAssetRow): void {
  if (row.mediaType !== "image") {
    throw new ApiError(400, "VIDEO_REFERENCE_ASSET_NOT_IMAGE", `资产“${row.name}”不是图片，不能作为视频参考图。`);
  }
  if (row.status !== "ready") {
    throw new ApiError(400, "VIDEO_REFERENCE_ASSET_NOT_READY", `项目图片“${row.name}”尚未就绪。`);
  }
  if (!row.storageKey && !row.sourceUrl) {
    throw new ApiError(400, "VIDEO_REFERENCE_ASSET_CONTENT_MISSING", `项目图片“${row.name}”没有可用文件。`);
  }
  if (row.storageKey && row.mimeType && !normalizedImageMimeType(row.mimeType, row.storageKey)) {
    throw new ApiError(400, "VIDEO_REFERENCE_ASSET_TYPE_UNSUPPORTED", `项目图片“${row.name}”的文件格式不受 Seedance 支持。`);
  }
}

function normalizedImageMimeType(value: string, fallbackPath: string): string | null {
  const normalized = value.split(";", 1)[0].trim().toLowerCase();
  if (SUPPORTED_IMAGE_MIME_TYPES.has(normalized)) return normalized;
  const extension = fallbackPath.split(/[?#]/, 1)[0].match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  return ({
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    bmp: "image/bmp",
    tif: "image/tiff",
    tiff: "image/tiff",
    gif: "image/gif",
    heic: "image/heic",
    heif: "image/heif",
  } as Record<string, string>)[extension || ""] || null;
}

function arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array<ArrayBufferLike>): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 32_768, bytes.length)));
  }
  return btoa(binary);
}
