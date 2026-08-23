import { ApiError } from "./api";

export const ASSET_TYPES = new Set([
  "image", "audio", "video", "model3d", "document", "prop", "scene", "costume", "character", "other",
]);

export function validateAssetType(value: unknown): string {
  if (typeof value !== "string" || !ASSET_TYPES.has(value)) {
    throw new ApiError(400, "INVALID_ASSET_TYPE", "资产类型无效。", { allowed: [...ASSET_TYPES] });
  }
  return value;
}

export function inferAssetType(mimeType: string): string {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.includes("gltf") || mimeType.includes("model") || mimeType.includes("fbx")) return "model3d";
  if (mimeType.startsWith("text/") || mimeType.includes("pdf") || mimeType.includes("document")) return "document";
  return "other";
}

export function safeRemoteUrl(value: string | null | undefined, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  let url: URL;
  try { url = new URL(value); } catch {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} 必须是有效 URL。`, { field });
  }
  if (url.protocol !== "https:") {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} 必须使用 HTTPS。`, { field });
  }
  if (url.username || url.password) {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} 不能包含 URL 凭据。`, { field });
  }
  return url.toString();
}

export function safeFilename(value: string): string {
  const cleaned = value.replace(/[\x00-\x1f\x7f"\\/]/g, "_").trim();
  return (cleaned || "asset").slice(0, 180);
}
