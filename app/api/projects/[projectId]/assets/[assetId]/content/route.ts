import { ApiError, errorResponse } from "@/lib/server/api";
import { safeFilename } from "@/lib/server/assets";
import { apiContext, type RouteContext } from "@/lib/server/context";
import { mediaBucket } from "@/lib/server/runtime";
import { requireOwnedProject } from "@/lib/server/store";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: RouteContext<{ projectId: string; assetId: string }>): Promise<Response> {
  try {
    const { projectId, assetId } = await context.params; const { db, identity } = await apiContext(request);
    await requireOwnedProject(db, projectId, identity.userId);
    const asset = await db.prepare(`SELECT name, mime_type AS mimeType, storage_key AS storageKey FROM assets WHERE id = ? AND project_id = ?`).bind(assetId, projectId).first<Record<string, unknown>>();
    if (!asset) throw new ApiError(404, "ASSET_NOT_FOUND", "资产不存在。 ");
    if (!asset.storageKey) throw new ApiError(404, "ASSET_CONTENT_NOT_FOUND", "该资产没有已上传的文件。 ");
    const object = await mediaBucket().get(String(asset.storageKey));
    if (!object) throw new ApiError(404, "ASSET_CONTENT_NOT_FOUND", "资产文件不存在。 ");
    const mimeType = String(asset.mimeType || object.httpMetadata?.contentType || "application/octet-stream");
    const unsafeInline = /(?:text\/html|image\/svg\+xml|application\/(?:xhtml\+xml|xml))/i.test(mimeType);
    const headers = new Headers({
      "Content-Type": unsafeInline ? "application/octet-stream" : mimeType,
      "Content-Disposition": `${unsafeInline ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(safeFilename(String(asset.name)))}`,
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
      ETag: object.httpEtag,
    });
    if (object.size !== undefined) headers.set("Content-Length", String(object.size));
    return new Response(object.body, { headers });
  } catch (error) { return errorResponse(error); }
}
