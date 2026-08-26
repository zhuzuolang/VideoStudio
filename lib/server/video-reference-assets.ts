import type {
  VideoReferenceAssetInput,
  VideoReferenceImageRole,
} from "../platform-types";
import type { SeedanceVideoPreset } from "../seedance-model-presets";
import { ApiError } from "./api";
import { allRows } from "./store";
import type { VideoReferenceImageInput } from "./video-generation";

export const MAX_VIDEO_REFERENCE_IMAGES = 30;
export const MAX_LOCAL_VIDEO_REFERENCE_BYTES = 8 * 1024 * 1024;
export const MAX_TOTAL_LOCAL_VIDEO_REFERENCE_BYTES = 24 * 1024 * 1024;

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
): Promise<VideoReferenceImageInput[]> {
  if (references.length === 0) return [];
  const rows = await loadReferenceAssetRows(db, projectId, references);
  let localBytes = 0;
  const resolved: VideoReferenceImageInput[] = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    validateReferenceAssetRow(row);
    const role = references[index].role;
    if (!row.storageKey) {
      resolved.push({ url: row.sourceUrl as string, role });
      continue;
    }

    const object = await bucket.get(row.storageKey);
    if (!object) {
      throw new ApiError(409, "VIDEO_REFERENCE_ASSET_CONTENT_MISSING", `项目图片“${row.name}”的文件已不存在，请重新选择参考图。`);
    }
    if (object.size > MAX_LOCAL_VIDEO_REFERENCE_BYTES) {
      throw new ApiError(413, "VIDEO_REFERENCE_ASSET_TOO_LARGE", `项目图片“${row.name}”超过 8 MB，无法作为视频参考图。`);
    }
    if (localBytes + object.size > MAX_TOTAL_LOCAL_VIDEO_REFERENCE_BYTES) {
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
    resolved.push({
      url: `data:${mimeType};base64,${arrayBufferToBase64(buffer)}`,
      role,
    });
  }
  return resolved;
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

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 32_768, bytes.length)));
  }
  return btoa(binary);
}
