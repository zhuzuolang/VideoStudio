import { ApiError } from "./api";
import type { GeneratedVideoStream } from "./video-generation";

export const VIDEO_MULTIPART_PART_BYTES = 8 * 1024 * 1024;
const STORAGE_CLEANUP_TIMEOUT_MS = 5_000;

type FixedLengthStreamConstructor = new (expectedLength: number | bigint) => {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
};

function fixedLengthStreamConstructor(): FixedLengthStreamConstructor | null {
  const value = (globalThis as typeof globalThis & {
    FixedLengthStream?: FixedLengthStreamConstructor;
  }).FixedLengthStream;
  return typeof value === "function" ? value : null;
}

function completionApiError(results: PromiseSettledResult<unknown>[]): ApiError | null {
  for (const result of results) {
    if (result.status === "rejected" && result.reason instanceof ApiError) return result.reason;
  }
  return null;
}

async function settleWithCleanupTimeout(promises: Promise<unknown>[]): Promise<PromiseSettledResult<unknown>[]> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<PromiseSettledResult<unknown>[]>((resolve) => {
    timer = setTimeout(() => resolve([]), STORAGE_CLEANUP_TIMEOUT_MS);
  });
  try {
    return await Promise.race([Promise.allSettled(promises), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function putFixedLengthVideo(
  bucket: R2Bucket,
  storageKey: string,
  video: GeneratedVideoStream,
  expectedSize: number,
  options: R2WriteOptions,
  FixedLengthStreamImpl: FixedLengthStreamConstructor,
): Promise<number> {
  const fixed = new FixedLengthStreamImpl(expectedSize);
  const abortController = new AbortController();
  const pipe = video.body.pipeTo(fixed.writable, { signal: abortController.signal });
  const put = Promise.resolve().then(() => bucket.put(storageKey, fixed.readable, options));
  try {
    const [, , completed] = await Promise.all([put, pipe, video.completed]);
    if (completed.size !== expectedSize) {
      throw new ApiError(502, "VIDEO_RESPONSE_SIZE_MISMATCH", "视频下载结果的实际大小与服务器声明不一致，请继续处理重试。");
    }
    return completed.size;
  } catch (error) {
    abortController.abort(error);
    const settled = await settleWithCleanupTimeout([put, pipe, video.completed]);
    const completed = settled[2];
    if (completed?.status === "fulfilled" && (completed.value as { size: number }).size !== expectedSize) {
      throw new ApiError(502, "VIDEO_RESPONSE_SIZE_MISMATCH", "视频下载结果的实际大小与服务器声明不一致，请继续处理重试。");
    }
    throw completionApiError(settled) ?? error;
  }
}

async function putMultipartVideo(
  bucket: R2Bucket,
  storageKey: string,
  video: GeneratedVideoStream,
  options: R2WriteOptions,
): Promise<number> {
  const reader = video.body.getReader();
  let multipart: R2MultipartUpload | null = null;
  let partBuffer = new Uint8Array(VIDEO_MULTIPART_PART_BYTES);
  let partSize = 0;
  let totalSize = 0;
  let partNumber = 1;
  const uploadedParts: R2UploadedPart[] = [];
  const flushPart = async () => {
    if (!multipart || partSize === 0) return;
    uploadedParts.push(await multipart.uploadPart(partNumber, partBuffer.subarray(0, partSize)));
    partNumber += 1;
    partBuffer = new Uint8Array(VIDEO_MULTIPART_PART_BYTES);
    partSize = 0;
  };

  try {
    multipart = await bucket.createMultipartUpload(storageKey, options);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalSize += value.byteLength;
      let offset = 0;
      while (offset < value.byteLength) {
        const length = Math.min(VIDEO_MULTIPART_PART_BYTES - partSize, value.byteLength - offset);
        partBuffer.set(value.subarray(offset, offset + length), partSize);
        partSize += length;
        offset += length;
        if (partSize === VIDEO_MULTIPART_PART_BYTES) await flushPart();
      }
    }
    await flushPart();
    const completed = await video.completed;
    if (completed.size !== totalSize) {
      throw new ApiError(502, "VIDEO_RESPONSE_SIZE_MISMATCH", "视频下载流未能完整读取，请继续处理重试。");
    }
    if (uploadedParts.length === 0) {
      throw new ApiError(502, "INVALID_VIDEO_BYTES", "生成结果没有可写入的视频内容。");
    }
    await multipart.complete(uploadedParts);
    return totalSize;
  } catch (error) {
    const cancel = Promise.resolve().then(() => reader.cancel(error)).catch(() => undefined);
    const abort = multipart
      ? Promise.resolve().then(() => multipart?.abort()).catch((abortError) => {
        console.error("Generated video multipart abort failed", {
          storageKey,
          errorName: abortError instanceof Error ? abortError.name : typeof abortError,
          errorMessage: (abortError instanceof Error ? abortError.message : String(abortError)).slice(0, 500),
        });
      })
      : Promise.resolve();
    const cleanupResults = await settleWithCleanupTimeout([abort, cancel, video.completed]);
    throw completionApiError(cleanupResults) ?? error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A cancellation can release or invalidate the reader first.
    }
  }
}

/** Stores a validated video stream without buffering the whole file in Worker memory. */
export async function storeGeneratedVideoStream(
  bucket: R2Bucket,
  storageKey: string,
  video: GeneratedVideoStream,
  options: R2WriteOptions,
): Promise<number> {
  // Observe the producer promise immediately so a storage failure followed by
  // cancellation cannot create an unhandled rejection.
  void video.completed.catch(() => undefined);
  const FixedLengthStreamImpl = fixedLengthStreamConstructor();
  if (video.expectedSize !== null && FixedLengthStreamImpl) {
    return putFixedLengthVideo(bucket, storageKey, video, video.expectedSize, options, FixedLengthStreamImpl);
  }
  return putMultipartVideo(bucket, storageKey, video, options);
}
