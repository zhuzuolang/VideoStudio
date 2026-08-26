import { expect, test, vi } from "vitest";
import { ApiError } from "@/lib/server/api";
import { generationFailure, serializeAssetGeneration } from "@/lib/server/asset-generation-jobs";

vi.mock("@/lib/server/store", () => ({ allRows: vi.fn() }));

const baseRow = {
  id: "gen-1",
  projectId: "project-1",
  ownerId: "user-1",
  clientRequestId: "request-1",
  modelId: "model-1",
  modelName: "Image model",
  name: "角色概念图",
  category: "character",
  prompt: "电影感人物设定",
  size: null,
  aspectRatio: "1:1",
  relationsJson: "[]",
  status: "running",
  phase: "model",
  progress: 15,
  attemptCount: 1,
  leaseToken: "lease-1",
  leaseExpiresAt: "2020-01-01T00:00:00.000Z",
  errorCode: null,
  errorMessage: null,
  retryable: 1,
  assetId: null,
  storageKey: null,
  dismissedAt: null,
  createdAt: "2026-08-23T00:00:00.000Z",
  updatedAt: "2026-08-23T00:00:00.000Z",
  startedAt: null,
  completedAt: null,
};

test("供应商调用后的未知错误不会被自动重试，避免重复计费", () => {
  expect(generationFailure(new Error("D1 write interrupted"), true)).toMatchObject({
    code: "IMAGE_PROCESSING_FAILED",
    retryable: false,
  });
  expect(generationFailure(new Error("preflight interrupted"), false).retryable).toBe(true);
});

test("供应商模糊结果不可重试，明确限流仍允许重试", () => {
  expect(generationFailure(new ApiError(502, "IMAGE_PROVIDER_UNAVAILABLE", "provider 503")).retryable).toBe(false);
  expect(generationFailure(new ApiError(429, "IMAGE_RATE_LIMITED", "rate limited")).retryable).toBe(true);
  expect(generationFailure(new ApiError(404, "MODEL_NOT_FOUND", "missing model")).retryable).toBe(false);
});

test("视频创建响应不确定时禁止重提，但安全轮询与入库失败可以重试", () => {
  const timeout = new ApiError(502, "VIDEO_MODEL_TIMEOUT", "timeout");
  expect(generationFailure(timeout, true, "video").retryable).toBe(false);
  expect(generationFailure(timeout, false, "video").retryable).toBe(true);
  expect(generationFailure(new ApiError(502, "VIDEO_RESPONSE_STREAM_FAILED", "body interrupted"), true, "video").retryable).toBe(false);
  expect(generationFailure(new ApiError(422, "VIDEO_TASK_FAILED", "failed"), false, "video").retryable).toBe(false);
  expect(generationFailure(new ApiError(503, "VIDEO_STORAGE_FAILED", "r2"), false, "video").retryable).toBe(true);
});

test("达到三次尝试或已归档的任务不会再次被 runner 认领", () => {
  expect(serializeAssetGeneration({ ...baseRow, attemptCount: 3 })).toMatchObject({
    canRun: false,
    retryable: false,
  });
  expect(serializeAssetGeneration({ ...baseRow, dismissedAt: "2026-08-23T01:00:00.000Z" })).toMatchObject({
    canRun: false,
  });
});

test("视频轮询尊重 nextPollAt，丢失供应商任务号时不自动重提", () => {
  expect(serializeAssetGeneration({
    ...baseRow,
    mediaType: "video",
    optionsJson: "{}",
    providerTaskId: "cgt-1",
    nextPollAt: "2999-01-01T00:00:00.000Z",
  }).canRun).toBe(false);
  expect(serializeAssetGeneration({
    ...baseRow,
    mediaType: "video",
    optionsJson: "{}",
    providerTaskId: "cgt-1",
    nextPollAt: "2020-01-01T00:00:00.000Z",
  }).canRun).toBe(true);
  expect(serializeAssetGeneration({
    ...baseRow,
    mediaType: "video",
    optionsJson: "{}",
    providerTaskId: null,
    nextPollAt: null,
  }).canRun).toBe(false);
});
