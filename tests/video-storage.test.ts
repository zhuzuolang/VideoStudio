import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/server/outbound", () => ({
  validateModelEndpoint: vi.fn(async (value: string) => value),
  validatePublicHttpsUrl: vi.fn(async (value: string) => value),
}));
vi.mock("@/lib/server/crypto", () => ({
  decryptApiKey: vi.fn(async () => "provider-key"),
}));

import { ApiError } from "@/lib/server/api";
import {
  storeGeneratedVideoStream,
  VIDEO_MULTIPART_PART_BYTES,
} from "@/lib/server/video-storage";
import { openGeneratedVideoStream, type GeneratedVideoStream } from "@/lib/server/video-generation";

const originalFixedLengthStream = Object.getOwnPropertyDescriptor(globalThis, "FixedLengthStream");
const fixedLengths: number[] = [];

class TestFixedLengthStream {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;

  constructor(length: number | bigint) {
    const expected = Number(length);
    fixedLengths.push(expected);
    const stream = new TransformStream<Uint8Array, Uint8Array>();
    const writer = stream.writable.getWriter();
    let received = 0;
    this.readable = stream.readable;
    this.writable = new WritableStream<Uint8Array>({
      async write(chunk) {
        received += chunk.byteLength;
        if (received > expected) {
          const error = new TypeError("FixedLengthStream received too many bytes");
          await writer.abort(error);
          throw error;
        }
        await writer.write(chunk);
      },
      async close() {
        if (received !== expected) {
          await writer.abort(new TypeError("FixedLengthStream received too few bytes"));
          throw new TypeError("FixedLengthStream received too few bytes");
        }
        await writer.close();
      },
      async abort(reason) {
        await writer.abort(reason);
      },
    });
  }
}

function videoStream(
  chunks: Uint8Array[],
  expectedSize: number | null,
  completion: Promise<{ size: number }> = Promise.resolve({
    size: chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
  }),
): GeneratedVideoStream {
  return {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    mimeType: "video/mp4",
    sourceUrl: "https://cdn.example.test/generated.mp4",
    expectedSize,
    completed: completion,
  };
}

function installFixedLengthStream(value: typeof TestFixedLengthStream | undefined): void {
  Object.defineProperty(globalThis, "FixedLengthStream", {
    configurable: true,
    writable: true,
    value,
  });
}

beforeEach(() => {
  fixedLengths.length = 0;
  installFixedLengthStream(TestFixedLengthStream);
});

afterEach(() => {
  if (originalFixedLengthStream) Object.defineProperty(globalThis, "FixedLengthStream", originalFixedLengthStream);
  else Reflect.deleteProperty(globalThis, "FixedLengthStream");
});

describe("生成视频 R2 入库", () => {
  test("已知响应大小时通过 FixedLengthStream 保留 R2 所需的长度信息", async () => {
    const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 1, 2, 3, 4]);
    let stored = new Uint8Array();
    const put = vi.fn(async (_key: string, body: ReadableStream<Uint8Array>) => {
      stored = new Uint8Array(await new Response(body).arrayBuffer());
      return {};
    });
    const createMultipartUpload = vi.fn();
    const size = await storeGeneratedVideoStream(
      { put, createMultipartUpload } as unknown as R2Bucket,
      "projects/project-1/asset-1/video.mp4",
      videoStream([bytes], bytes.byteLength),
      { httpMetadata: { contentType: "video/mp4" } },
    );

    expect(size).toBe(bytes.byteLength);
    expect(fixedLengths).toEqual([bytes.byteLength]);
    expect(stored).toEqual(bytes);
    expect(createMultipartUpload).not.toHaveBeenCalled();
  });

  test("未知响应大小时按固定大小分片上传，避免把未知长度流直接交给 R2", async () => {
    installFixedLengthStream(undefined);
    const bytes = new Uint8Array(VIDEO_MULTIPART_PART_BYTES + 3);
    bytes.set([7, 8, 9], VIDEO_MULTIPART_PART_BYTES);
    const uploaded: Uint8Array[] = [];
    const uploadPart = vi.fn(async (partNumber: number, value: ArrayBufferView) => {
      uploaded.push(new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice());
      return { partNumber, etag: `etag-${partNumber}` };
    });
    const complete = vi.fn(async () => ({ size: bytes.byteLength, httpEtag: "etag" }));
    const abort = vi.fn();
    const createMultipartUpload = vi.fn(async () => ({ uploadPart, complete, abort }));
    const put = vi.fn();

    const size = await storeGeneratedVideoStream(
      { put, createMultipartUpload } as unknown as R2Bucket,
      "projects/project-1/asset-1/video.mp4",
      videoStream([bytes.subarray(0, 13), bytes.subarray(13)], null),
      { httpMetadata: { contentType: "video/mp4" } },
    );

    expect(size).toBe(bytes.byteLength);
    expect(put).not.toHaveBeenCalled();
    expect(createMultipartUpload).toHaveBeenCalledWith(
      "projects/project-1/asset-1/video.mp4",
      { httpMetadata: { contentType: "video/mp4" } },
    );
    expect(uploadPart).toHaveBeenCalledTimes(2);
    expect(uploaded.map((part) => part.byteLength)).toEqual([VIDEO_MULTIPART_PART_BYTES, 3]);
    expect(complete).toHaveBeenCalledWith([
      { partNumber: 1, etag: "etag-1" },
      { partNumber: 2, etag: "etag-2" },
    ]);
    expect(abort).not.toHaveBeenCalled();
  });

  test("固定长度声明多于或少于实际下载大小时都返回稳定错误", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    for (const expectedSize of [bytes.byteLength - 1, bytes.byteLength + 1]) {
      const put = vi.fn(async (_key: string, body: ReadableStream<Uint8Array>) => {
        await new Response(body).arrayBuffer();
        return {};
      });
      await expect(storeGeneratedVideoStream(
        { put } as unknown as R2Bucket,
        "projects/project-1/asset-1/video.mp4",
        videoStream([bytes], expectedSize),
        {},
      )).rejects.toMatchObject({ code: "VIDEO_RESPONSE_SIZE_MISMATCH" });
    }
  });

  test("真实下载流短于 Content-Length 时经过固定长度存储仍保留大小错误", async () => {
    const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 1, 2, 3, 4]);
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }), {
      status: 200,
      headers: { "content-type": "video/mp4", "content-length": String(bytes.byteLength + 1) },
    })) as unknown as typeof fetch;
    const opened = await openGeneratedVideoStream("https://cdn.example.test/generated.mp4", fetchImpl);
    const put = vi.fn(async (_key: string, body: ReadableStream<Uint8Array>) => {
      await new Response(body).arrayBuffer();
      return {};
    });

    await expect(storeGeneratedVideoStream(
      { put } as unknown as R2Bucket,
      "projects/project-1/asset-1/video.mp4",
      opened,
      {},
    )).rejects.toMatchObject({ code: "VIDEO_RESPONSE_SIZE_MISMATCH" });
  });

  test("分片写入失败时中止上传，并保留更具体的视频流错误", async () => {
    installFixedLengthStream(undefined);
    const streamError = new ApiError(502, "VIDEO_RESPONSE_STREAM_FAILED", "视频读取中断。");
    const completed = Promise.reject(streamError);
    const uploadPart = vi.fn(async () => {
      throw new Error("R2 unavailable");
    });
    const complete = vi.fn();
    const abort = vi.fn(async () => undefined);
    const createMultipartUpload = vi.fn(async () => ({ uploadPart, complete, abort }));

    await expect(storeGeneratedVideoStream(
      { createMultipartUpload } as unknown as R2Bucket,
      "projects/project-1/asset-1/video.mp4",
      videoStream([new Uint8Array([1, 2, 3])], null, completed),
      {},
    )).rejects.toMatchObject({ code: "VIDEO_RESPONSE_STREAM_FAILED" });
    expect(abort).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
  });
});
