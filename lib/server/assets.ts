import { ApiError } from "./api";

import type { AssetRelationInput } from "../platform-types";

export const ASSET_MEDIA_TYPES = new Set(["image", "audio", "video", "model3d", "document", "other"]);
export const ASSET_CATEGORIES = new Set([
  "character", "costume", "prop", "scene", "environment", "vehicle", "storyboard", "final", "reference", "other",
]);

export function validateAssetMediaType(value: unknown): string {
  if (typeof value !== "string" || !ASSET_MEDIA_TYPES.has(value)) {
    throw new ApiError(400, "INVALID_ASSET_MEDIA_TYPE", "资产介质属性无效。", { allowed: [...ASSET_MEDIA_TYPES] });
  }
  return value;
}

export function validateAssetCategory(value: unknown): string {
  if (typeof value !== "string" || !ASSET_CATEGORIES.has(value)) {
    throw new ApiError(400, "INVALID_ASSET_CATEGORY", "资产制作分类无效。", { allowed: [...ASSET_CATEGORIES] });
  }
  return value;
}

export function inferAssetMediaType(mimeType: string): string {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.includes("gltf") || mimeType.includes("model") || mimeType.includes("fbx")) return "model3d";
  if (mimeType.startsWith("text/") || mimeType.includes("pdf") || mimeType.includes("document")) return "document";
  return "other";
}

export function parseAssetRelations(body: Record<string, unknown>): AssetRelationInput[] | undefined {
  const hasRelations = "relations" in body || "relatedAssetIds" in body || "relatedCharacterIds" in body;
  if (!hasRelations) return undefined;
  const normalized: AssetRelationInput[] = [];
  const addIds = (value: unknown, targetType: "asset" | "character") => {
    if (value === undefined) return;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
      throw new ApiError(400, "INVALID_ASSET_RELATIONS", `${targetType === "asset" ? "relatedAssetIds" : "relatedCharacterIds"} 必须是 ID 数组。`);
    }
    for (const targetId of value as string[]) normalized.push({ targetType, targetId: targetId.trim() });
  };
  addIds(body.relatedAssetIds, "asset");
  addIds(body.relatedCharacterIds, "character");
  if (body.relations !== undefined) {
    if (!Array.isArray(body.relations)) throw new ApiError(400, "INVALID_ASSET_RELATIONS", "relations 必须是数组。 ");
    for (const value of body.relations) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "INVALID_ASSET_RELATIONS", "关系项必须是对象。 ");
      const item = value as Record<string, unknown>;
      if ((item.targetType !== "asset" && item.targetType !== "character") || typeof item.targetId !== "string" || !item.targetId.trim()) {
        throw new ApiError(400, "INVALID_ASSET_RELATIONS", "关系目标无效。 ");
      }
      const relationType = typeof item.relationType === "string" ? item.relationType.trim().slice(0, 80) : "related";
      const note = typeof item.note === "string" ? item.note.trim().slice(0, 1_000) : "";
      normalized.push({ targetType: item.targetType, targetId: item.targetId.trim(), relationType: relationType || "related", note });
    }
  }
  const unique = new Map<string, AssetRelationInput>();
  for (const relation of normalized) unique.set(`${relation.targetType}:${relation.targetId}:${relation.relationType ?? "related"}`, relation);
  if (unique.size > 100) throw new ApiError(400, "TOO_MANY_ASSET_RELATIONS", "单个资产最多关联 100 个目标。 ");
  return [...unique.values()];
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
