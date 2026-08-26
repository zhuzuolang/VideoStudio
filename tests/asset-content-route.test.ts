import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireOwnedProject: vi.fn(),
  head: vi.fn(),
  get: vi.fn(),
}));

const asset = {
  name: "生成视频.mp4",
  mimeType: "video/mp4",
  storageKey: "projects/project-1/asset-1/video.mp4",
};

const fakeDb = {
  prepare: vi.fn(() => ({
    bind() { return this; },
    first: vi.fn(async () => asset),
  })),
} as unknown as D1Database;

vi.mock("@/lib/server/context", () => ({
  apiContext: vi.fn(async () => ({ db: fakeDb, identity: { userId: "user-1" } })),
}));
vi.mock("@/lib/server/store", () => ({ requireOwnedProject: mocks.requireOwnedProject }));
vi.mock("@/lib/server/runtime", () => ({
  mediaBucket: () => ({ head: mocks.head, get: mocks.get }),
}));

import { GET } from "@/app/api/projects/[projectId]/assets/[assetId]/content/route";

function body(length: number): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(length));
      controller.close();
    },
  });
}

function object(length: number, totalSize = length): R2ObjectBody {
  return {
    body: body(length),
    size: totalSize,
    httpEtag: '"etag-1"',
    httpMetadata: { contentType: "video/mp4" },
    text: vi.fn(),
    arrayBuffer: vi.fn(),
  };
}

const context = { params: Promise.resolve({ projectId: "project-1", assetId: "asset-1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.head.mockResolvedValue({ size: 1_000, httpEtag: '"etag-1"', httpMetadata: { contentType: "video/mp4" } });
  mocks.get.mockResolvedValue(object(1_000));
});

describe("资产媒体 Range 响应", () => {
  test("普通请求保持完整流并声明支持字节范围", async () => {
    const response = await GET(new Request("https://example.test/content"), context);

    expect(response.status).toBe(200);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-length")).toBe("1000");
    expect(mocks.head).not.toHaveBeenCalled();
    expect(mocks.get).toHaveBeenCalledWith(asset.storageKey, undefined);
  });

  test("视频范围请求只读取所需字节并返回 206", async () => {
    mocks.get.mockResolvedValueOnce(object(100, 1_000));
    const response = await GET(new Request("https://example.test/content", {
      headers: { Range: "bytes=100-199" },
    }), context);

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 100-199/1000");
    expect(response.headers.get("content-length")).toBe("100");
    expect(mocks.get).toHaveBeenCalledWith(asset.storageKey, { range: { offset: 100, length: 100 } });
  });

  test("拒绝多段或越界范围并返回 416", async () => {
    const response = await GET(new Request("https://example.test/content", {
      headers: { Range: "bytes=100-199,300-399" },
    }), context);

    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */1000");
    expect(mocks.get).not.toHaveBeenCalled();
  });
});
