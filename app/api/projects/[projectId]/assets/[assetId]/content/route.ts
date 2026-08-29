import { ApiError, errorResponse } from "@/lib/server/api";
import { safeFilename } from "@/lib/server/assets";
import { apiContext, type RouteContext } from "@/lib/server/context";
import { mediaBucket } from "@/lib/server/runtime";
import { requireOwnedProject } from "@/lib/server/store";

export const dynamic = "force-dynamic";

function parseByteRange(value: string, size: number): { offset: number; length: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || size <= 0) return null;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    const length = Math.min(size, suffixLength);
    return { offset: size - length, length };
  }
  const offset = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(requestedEnd)
    || offset < 0 || offset >= size || requestedEnd < offset) return null;
  const end = Math.min(requestedEnd, size - 1);
  return { offset, length: end - offset + 1 };
}

export async function GET(request: Request, context: RouteContext<{ projectId: string; assetId: string }>): Promise<Response> {
  try {
    const { projectId, assetId } = await context.params; const { db, identity } = await apiContext(request);
    await requireOwnedProject(db, projectId, identity.userId);
    const asset = await db.prepare(`SELECT name, mime_type AS mimeType, size_bytes AS sizeBytes, storage_key AS storageKey FROM assets WHERE id = ? AND project_id = ?`).bind(assetId, projectId).first<Record<string, unknown>>();
    if (!asset) throw new ApiError(404, "ASSET_NOT_FOUND", "资产不存在。 ");
    if (!asset.storageKey) throw new ApiError(404, "ASSET_CONTENT_NOT_FOUND", "该资产没有已上传的文件。 ");
    const bucket = mediaBucket();
    const rangeHeader = request.headers.get("range");
    let range: { offset: number; length: number } | null = null;
    let totalSize: number | null = null;
    if (rangeHeader) {
      const recordedSize = Number(asset.sizeBytes);
      if (Number.isSafeInteger(recordedSize) && recordedSize > 0) {
        totalSize = recordedSize;
      } else {
        const metadata = await bucket.head(String(asset.storageKey));
        if (!metadata) throw new ApiError(404, "ASSET_CONTENT_NOT_FOUND", "资产文件不存在。 ");
        totalSize = metadata.size;
      }
      range = parseByteRange(rangeHeader, totalSize);
      if (!range) {
        return new Response(null, {
          status: 416,
          headers: {
            "Accept-Ranges": "bytes",
            "Content-Range": `bytes */${totalSize}`,
            "Cache-Control": "private, max-age=300",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }
    }
    const object = await bucket.get(String(asset.storageKey), range ? { range } : undefined);
    if (!object) throw new ApiError(404, "ASSET_CONTENT_NOT_FOUND", "资产文件不存在。 ");
    const mimeType = String(asset.mimeType || object.httpMetadata?.contentType || "application/octet-stream");
    const unsafeInline = /(?:text\/html|image\/svg\+xml|application\/(?:xhtml\+xml|xml))/i.test(mimeType);
    const headers = new Headers({
      "Content-Type": unsafeInline ? "application/octet-stream" : mimeType,
      "Content-Disposition": `${unsafeInline ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(safeFilename(String(asset.name)))}`,
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
      "Accept-Ranges": "bytes",
      ETag: object.httpEtag,
    });
    if (range) {
      const end = range.offset + range.length - 1;
      headers.set("Content-Range", `bytes ${range.offset}-${end}/${totalSize ?? object.size}`);
      headers.set("Content-Length", String(range.length));
    } else if (object.size !== undefined) {
      headers.set("Content-Length", String(object.size));
    }
    return new Response(object.body, { status: range ? 206 : 200, headers });
  } catch (error) { return errorResponse(error); }
}
