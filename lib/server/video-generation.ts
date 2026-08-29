import {
  findSeedanceModelPreset,
  type SeedanceModelPreset,
  type SeedanceRequestProfile,
  type SeedanceVideoPreset,
} from "../seedance-model-presets";
import { ApiError, parseJson } from "./api";
import { decryptApiKey } from "./crypto";
import { validateModelEndpoint, validatePublicHttpsUrl } from "./outbound";

const MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_GENERATED_VIDEO_BYTES = 100 * 1024 * 1024;
const TASK_STATUS_REQUEST_TIMEOUT_MS = 30_000;
const CONNECTION_TEST_TIMEOUT_MS = 30_000;
const VIDEO_DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_VIDEO_REDIRECTS = 3;
const MAX_REFERENCE_IMAGE_BYTES = 30 * 1024 * 1024;

export type VideoReferenceImageRole = "first_frame" | "last_frame" | "reference_image";

export type VideoReferenceImageInput = {
  url: string;
  role?: VideoReferenceImageRole;
};

export type VideoGenerationInput = {
  prompt: string;
  resolution?: string;
  aspectRatio?: string;
  ratio?: string;
  duration?: number;
  generateAudio?: boolean;
  imageUrl?: string;
  referenceImageUrl?: string;
  referenceImageRole?: VideoReferenceImageRole;
  firstFrameUrl?: string;
  lastFrameUrl?: string;
  referenceImages?: readonly (string | VideoReferenceImageInput)[];
  returnLastFrame?: boolean;
  watermark?: boolean;
  seed?: number;
  callbackUrl?: string;
  executionExpiresAfter?: number;
  safetyIdentifier?: string;
  signal?: AbortSignal;
};

export type VideoGenerationTaskStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

export type VideoGenerationTask = {
  status: VideoGenerationTaskStatus;
  videoUrl?: string;
  lastFrameUrl?: string;
  errorCode?: string;
  errorMessage?: string;
  usage?: Record<string, unknown>;
};

export type DownloadedVideo = {
  bytes: Uint8Array;
  mimeType: "video/mp4" | "video/quicktime";
  sourceUrl: string;
};

export type GeneratedVideoStream = {
  body: ReadableStream<Uint8Array>;
  mimeType: "video/mp4" | "video/quicktime";
  sourceUrl: string;
  completed: Promise<{ size: number }>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function modelParameters(model: Record<string, unknown>): Record<string, unknown> {
  const direct = asRecord(model.parameters);
  if (direct) return direct;
  return parseJson<Record<string, unknown>>(model.parameters_json ?? model.parametersJson, {});
}

function modelDescriptor(model: Record<string, unknown>): string {
  return [model.provider, model.name, model.model_id ?? model.modelId, model.endpoint]
    .map((value) => String(value ?? ""))
    .join(" ");
}

export function modelSupportsVideoGeneration(model: Record<string, unknown>): boolean {
  const parameters = modelParameters(model);
  const configuredCapabilities = Array.isArray(parameters.capabilities) ? parameters.capabilities : [];
  const directCapabilities = Array.isArray(model.capabilities) ? model.capabilities : [];
  const capabilities = [...configuredCapabilities, ...directCapabilities]
    .map((value) => String(value).trim().toLowerCase());
  const explicitlyGenerative = capabilities.some((value) => [
    "video-generation",
    "video_generation",
    "text-to-video",
    "text_to_video",
    "image-to-video",
    "image_to_video",
    "视频生成",
    "文生视频",
    "图生视频",
  ].includes(value));
  return explicitlyGenerative
    || /seedance|video[-_ ]?(?:gen|generation)|text[-_ ]?to[-_ ]?video|image[-_ ]?to[-_ ]?video|视频生成|文生视频|图生视频/i.test(modelDescriptor(model));
}

/** Normalizes an Ark base URL (or another generation endpoint) to the task collection URL. */
export function videoGenerationEndpoint(value: string): string {
  const url = new URL(value);
  let path = url.pathname.replace(/\/+$/, "");
  const taskPath = path.match(/^(.*\/contents\/generations\/tasks)(?:\/[^/]*)?$/i);
  if (taskPath) {
    url.pathname = taskPath[1];
    return url.toString();
  }
  const knownSuffix = /\/(?:chat\/completions|images\/generations|responses|contents\/generations)$/i;
  path = knownSuffix.test(path)
    ? path.replace(knownSuffix, "/contents/generations/tasks")
    : `${path}/contents/generations/tasks`;
  url.pathname = path.replace(/\/+/g, "/");
  return url.toString();
}

export function videoGenerationTaskEndpoint(value: string, taskId: string): string {
  const normalizedTaskId = taskId.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$/.test(normalizedTaskId)) {
    throw new ApiError(400, "INVALID_VIDEO_TASK_ID", "视频生成任务编号格式无效。");
  }
  const url = new URL(videoGenerationEndpoint(value));
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${encodeURIComponent(normalizedTaskId)}`;
  return url.toString();
}

export function seedanceRequestProfile(
  model: Record<string, unknown>,
): { profile: SeedanceVideoPreset; preset: SeedanceModelPreset } {
  const parameters = modelParameters(model);
  const video = asRecord(parameters.video);
  const configuredProfile = typeof video?.requestProfile === "string"
    ? video.requestProfile
    : typeof parameters.requestProfile === "string"
      ? parameters.requestProfile
      : typeof parameters.presetKey === "string"
        ? parameters.presetKey
        : "";
  const modelId = String(model.model_id ?? model.modelId ?? "").trim();
  const preset = findSeedanceModelPreset(configuredProfile || modelId);
  if (!preset) {
    throw new ApiError(
      400,
      "VIDEO_REQUEST_PROFILE_MISSING",
      "当前视频模型没有可识别的 Seedance 请求配置，请从官方预设卡片配置模型。",
    );
  }
  return { profile: preset.parameters.video, preset };
}

export function buildVideoGenerationRequest(
  model: Record<string, unknown>,
  input: VideoGenerationInput,
): Record<string, unknown> {
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt || prompt.length > 8_000) {
    throw new ApiError(400, "INVALID_VIDEO_PROMPT", "视频提示词长度必须在 1 到 8000 个字符之间。");
  }
  const modelId = String(model.model_id ?? model.modelId ?? "").trim();
  if (!modelId) throw new ApiError(400, "VIDEO_MODEL_ID_MISSING", "视频模型缺少服务商模型 ID。");

  const { profile } = seedanceRequestProfile(model);
  const resolution = (input.resolution?.trim() || profile.defaultResolution).toLowerCase();
  if (!profile.resolutions.includes(resolution)) {
    throw new ApiError(
      400,
      "INVALID_VIDEO_RESOLUTION",
      `当前模型仅支持 ${profile.resolutions.join("、")} 分辨率。`,
    );
  }
  const ratio = (input.ratio?.trim() || input.aspectRatio?.trim() || profile.defaultAspectRatio).toLowerCase();
  if (!profile.aspectRatios.includes(ratio)) {
    throw new ApiError(
      400,
      "INVALID_VIDEO_ASPECT_RATIO",
      `当前模型仅支持 ${profile.aspectRatios.join("、")} 画幅比例。`,
    );
  }
  const duration = input.duration ?? profile.defaultDuration;
  const durationIsValid = Number.isInteger(duration)
    && (duration === -1 ? profile.supportsAutoDuration : duration >= profile.minDuration && duration <= profile.maxDuration);
  if (!durationIsValid) {
    const autoHint = profile.supportsAutoDuration ? "，或使用 -1 自动选择时长" : "";
    throw new ApiError(
      400,
      "INVALID_VIDEO_DURATION",
      `当前模型时长必须是 ${profile.minDuration} 到 ${profile.maxDuration} 秒的整数${autoHint}。`,
    );
  }

  const images = collectReferenceImages(input);
  validateReferenceImageMode(images);
  const generalReferences = images.filter((image) => image.role === "reference_image");
  if (generalReferences.length > profile.maxReferenceImages) {
    throw new ApiError(
      400,
      "TOO_MANY_VIDEO_REFERENCES",
      `当前模型最多接收 ${profile.maxReferenceImages} 张内容参考图。`,
    );
  }
  const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
  for (const image of images) {
    if (!profile.referenceImageRoles.includes(image.role)) {
      throw new ApiError(400, "INVALID_VIDEO_REFERENCE_ROLE", `当前模型不支持 ${image.role} 参考图角色。`);
    }
    validateReferenceImageUrlSyntax(image.url);
    content.push({ type: "image_url", image_url: { url: image.url }, role: image.role });
  }

  const requestedGenerateAudio = input.generateAudio ?? profile.defaultGenerateAudio;
  if (requestedGenerateAudio && !profile.supportsGenerateAudio) {
    throw new ApiError(400, "VIDEO_AUDIO_UNSUPPORTED", "当前模型不支持生成同步音频。");
  }

  const request: Record<string, unknown> = {
    model: modelId,
    content,
    resolution,
    ratio,
    duration,
    watermark: input.watermark ?? false,
  };
  // Unsupported optional fields are omitted entirely because Ark rejects them even when false.
  if (profile.supportsGenerateAudio) request.generate_audio = requestedGenerateAudio;
  if (input.returnLastFrame !== undefined) request.return_last_frame = input.returnLastFrame;
  if (input.seed !== undefined) {
    if (!Number.isInteger(input.seed) || input.seed < -1 || input.seed > 4_294_967_295) {
      throw new ApiError(400, "INVALID_VIDEO_SEED", "视频随机种子必须是 -1 到 4294967295 之间的整数。");
    }
    request.seed = input.seed;
  }
  if (input.executionExpiresAfter !== undefined) {
    if (!Number.isInteger(input.executionExpiresAfter)
      || input.executionExpiresAfter < 3_600
      || input.executionExpiresAfter > 259_200) {
      throw new ApiError(400, "INVALID_VIDEO_EXPIRY", "任务过期时间必须是 3600 到 259200 秒之间的整数。");
    }
    request.execution_expires_after = input.executionExpiresAfter;
  }
  if (input.safetyIdentifier !== undefined) {
    const identifier = input.safetyIdentifier.trim();
    if (!identifier || identifier.length > 64 || !/^[\x21-\x7e]+$/.test(identifier)) {
      throw new ApiError(400, "INVALID_VIDEO_SAFETY_IDENTIFIER", "终端用户标识必须是 1 到 64 位英文可打印字符。");
    }
    request.safety_identifier = identifier;
  }
  if (input.callbackUrl !== undefined) {
    request.callback_url = validateHttpsUrlSyntax(input.callbackUrl, "视频任务回调地址");
  }
  return request;
}

export async function createVideoGenerationTask(
  model: Record<string, unknown>,
  input: VideoGenerationInput,
  fetchImpl: typeof fetch = fetch,
): Promise<{ taskId: string }> {
  assertModelReady(model);
  const request = buildVideoGenerationRequest(model, input);
  await validateRequestUrls(request);
  const { endpoint, apiKey } = await modelConnection(model);
  if (input.signal?.aborted) {
    throw new ApiError(409, "GENERATION_LEASE_LOST", "生成任务执行权已过期，未提交付费视频任务。");
  }

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(request),
      redirect: "manual",
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (error) {
    throw taskNetworkError(error, input.signal, "提交");
  }
  rejectTaskRedirect(response);
  const { result, rawText } = await parseProviderResponse(response);
  if (!response.ok) throw providerApiError(response.status, result, rawText, "create");
  if (!result) throw invalidTaskResponse("视频服务返回了无法解析的任务创建响应。");
  const nestedData = asRecord(result.data);
  const taskId = typeof result.id === "string" ? result.id.trim()
    : typeof nestedData?.id === "string" ? nestedData.id.trim()
      : "";
  if (!taskId) throw invalidTaskResponse("视频服务没有返回任务编号。");
  return { taskId };
}

export async function getVideoGenerationTask(
  model: Record<string, unknown>,
  taskId: string,
  fetchImpl: typeof fetch = fetch,
  externalSignal?: AbortSignal,
): Promise<VideoGenerationTask> {
  assertModelReady(model);
  // Resolving the profile here prevents a generic text/image endpoint from being polled as a video task.
  seedanceRequestProfile(model);
  const { endpoint: collectionEndpoint, apiKey } = await modelConnection(model);
  const endpoint = await validateModelEndpoint(videoGenerationTaskEndpoint(collectionEndpoint, taskId));
  const requestSignal = externalSignal
    ? AbortSignal.any([externalSignal, AbortSignal.timeout(TASK_STATUS_REQUEST_TIMEOUT_MS)])
    : AbortSignal.timeout(TASK_STATUS_REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
      redirect: "manual",
      signal: requestSignal,
    });
  } catch (error) {
    throw taskNetworkError(error, externalSignal, "查询");
  }
  rejectTaskRedirect(response);
  const { result, rawText } = await parseProviderResponse(response);
  if (!response.ok) throw providerApiError(response.status, result, rawText, "query");
  if (!result) throw invalidTaskResponse("视频服务返回了无法解析的任务查询响应。");

  const nestedData = asRecord(result.data);
  const payload = nestedData && typeof result.status !== "string" ? nestedData : result;
  const status = typeof payload.status === "string" ? payload.status.trim().toLowerCase() : "";
  if (!isTaskStatus(status)) throw invalidTaskResponse("视频服务返回了未知的任务状态。");
  const content = asRecord(payload.content);
  const error = asRecord(payload.error);
  const videoUrl = typeof content?.video_url === "string" && content.video_url.trim()
    ? content.video_url.trim()
    : undefined;
  if (status === "succeeded" && !videoUrl) {
    throw new ApiError(502, "VIDEO_RESULT_MISSING", "视频任务已完成，但服务商没有返回视频地址。");
  }
  const lastFrameUrl = typeof content?.last_frame_url === "string" && content.last_frame_url.trim()
    ? content.last_frame_url.trim()
    : undefined;
  const errorCode = typeof error?.code === "string" ? error.code : undefined;
  const errorMessage = typeof error?.message === "string"
    ? sanitizeProviderMessage(error.message)
    : undefined;
  const usage = asRecord(payload.usage) ?? undefined;
  return {
    status,
    ...(videoUrl ? { videoUrl } : {}),
    ...(lastFrameUrl ? { lastFrameUrl } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(errorMessage ? { errorMessage } : {}),
    ...(usage ? { usage } : {}),
  };
}

/**
 * Verifies the Ark API key and task endpoint without creating a billable video.
 * An empty task list is still a successful connectivity result.
 */
export async function testVideoGenerationConnection(
  model: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<{ taskCount: number }> {
  assertModelReady(model);
  seedanceRequestProfile(model);
  const { endpoint: collectionEndpoint, apiKey } = await modelConnection(model);
  const endpoint = new URL(collectionEndpoint);
  endpoint.searchParams.set("page_num", "1");
  endpoint.searchParams.set("page_size", "1");

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
      redirect: "manual",
      signal: AbortSignal.timeout(CONNECTION_TEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw taskNetworkError(error, undefined, "验证");
  }
  rejectTaskRedirect(response);
  const { result, rawText } = await parseProviderResponse(response);
  if (!response.ok) throw providerApiError(response.status, result, rawText, "query");
  if (!result) throw invalidTaskResponse("视频服务返回了无法解析的连接测试响应。");
  const total = typeof result.total === "number" && Number.isFinite(result.total)
    ? Math.max(0, Math.floor(result.total))
    : Array.isArray(result.items)
      ? result.items.length
      : 0;
  return { taskCount: total };
}

export async function downloadGeneratedVideo(
  initialUrl: string,
  fetchImpl: typeof fetch = fetch,
  externalSignal?: AbortSignal,
): Promise<DownloadedVideo> {
  const { response, sourceUrl } = await fetchGeneratedVideoResponse(initialUrl, fetchImpl, externalSignal);
  const bytes = await readLimitedBytes(response, MAX_GENERATED_VIDEO_BYTES, "生成视频");
  return { bytes, mimeType: sniffVideoType(bytes), sourceUrl };
}

/** Streams a generated video into durable storage without buffering the full file in Worker memory. */
export async function openGeneratedVideoStream(
  initialUrl: string,
  fetchImpl: typeof fetch = fetch,
  externalSignal?: AbortSignal,
): Promise<GeneratedVideoStream> {
  const { response, sourceUrl } = await fetchGeneratedVideoResponse(initialUrl, fetchImpl, externalSignal);
  if (!response.body) throw new ApiError(502, "INVALID_VIDEO_BYTES", "生成结果没有可读取的视频内容。");
  const reader = response.body.getReader();
  const prefixChunks: Uint8Array[] = [];
  let prefixSize = 0;
  let sourceEnded = false;
  try {
    while (prefixSize < 12) {
      const { done, value } = await reader.read();
      if (done) {
        sourceEnded = true;
        break;
      }
      prefixSize += value.byteLength;
      if (prefixSize > MAX_GENERATED_VIDEO_BYTES) {
        await reader.cancel();
        throw new ApiError(502, "VIDEO_RESPONSE_TOO_LARGE", "生成视频超过 100 MB 大小限制。");
      }
      prefixChunks.push(value);
    }
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {
      // The source may already be errored; releasing the reader is still sufficient.
    }
    reader.releaseLock();
    if (error instanceof ApiError) throw error;
    if (externalSignal?.aborted) {
      throw new ApiError(409, "GENERATION_LEASE_LOST", "生成任务执行权已过期，已停止下载视频结果。");
    }
    throw new ApiError(502, "VIDEO_RESPONSE_STREAM_FAILED", "生成视频读取中断，请稍后重试。");
  }
  const prefix = joinBytes(prefixChunks, prefixSize);
  let mimeType: "video/mp4" | "video/quicktime";
  try {
    mimeType = sniffVideoType(prefix);
  } catch (error) {
    await reader.cancel();
    reader.releaseLock();
    throw error;
  }

  let resolveCompleted!: (value: { size: number }) => void;
  let rejectCompleted!: (reason: unknown) => void;
  const completed = new Promise<{ size: number }>((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  let transferred = prefix.byteLength;
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    reader.releaseLock();
    resolveCompleted({ size: transferred });
  };
  const fail = (reason: unknown) => {
    if (settled) return;
    settled = true;
    rejectCompleted(reason);
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(prefix);
      if (sourceEnded) {
        controller.close();
        finish();
      }
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          finish();
          return;
        }
        transferred += value.byteLength;
        if (transferred > MAX_GENERATED_VIDEO_BYTES) {
          const error = new ApiError(502, "VIDEO_RESPONSE_TOO_LARGE", "生成视频超过 100 MB 大小限制。");
          await reader.cancel(error);
          reader.releaseLock();
          controller.error(error);
          fail(error);
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        const failure = externalSignal?.aborted
          ? new ApiError(409, "GENERATION_LEASE_LOST", "生成任务执行权已过期，已停止下载视频结果。")
          : error instanceof ApiError
            ? error
            : new ApiError(502, "VIDEO_RESPONSE_STREAM_FAILED", "生成视频读取中断，请稍后重试。");
        try {
          await reader.cancel(failure);
        } catch {
          // A failed source can reject cancel; release the lock either way.
        }
        reader.releaseLock();
        controller.error(failure);
        fail(failure);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        reader.releaseLock();
        fail(reason instanceof Error ? reason : new ApiError(502, "VIDEO_RESPONSE_STREAM_FAILED", "生成视频传输被中断。"));
      }
    },
  });
  return { body, mimeType, sourceUrl, completed };
}

async function fetchGeneratedVideoResponse(
  initialUrl: string,
  fetchImpl: typeof fetch,
  externalSignal?: AbortSignal,
): Promise<{ response: Response; sourceUrl: string }> {
  if (externalSignal?.aborted) {
    throw new ApiError(409, "GENERATION_LEASE_LOST", "生成任务执行权已过期，已停止下载视频结果。");
  }
  let currentUrl = await validatePublicHttpsUrl(initialUrl, { allowQuery: true, purpose: "生成视频地址" });
  for (let redirectCount = 0; redirectCount <= MAX_VIDEO_REDIRECTS; redirectCount += 1) {
    let response: Response;
    try {
      response = await fetchImpl(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: externalSignal
          ? AbortSignal.any([externalSignal, AbortSignal.timeout(VIDEO_DOWNLOAD_TIMEOUT_MS)])
          : AbortSignal.timeout(VIDEO_DOWNLOAD_TIMEOUT_MS),
      });
    } catch {
      if (externalSignal?.aborted) {
        throw new ApiError(409, "GENERATION_LEASE_LOST", "生成任务执行权已过期，已停止下载视频结果。");
      }
      throw new ApiError(502, "VIDEO_DOWNLOAD_FAILED", "视频已生成，但下载结果时连接中断。");
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirectCount === MAX_VIDEO_REDIRECTS) {
        await response.body?.cancel();
        throw new ApiError(502, "VIDEO_DOWNLOAD_REDIRECT_REJECTED", "视频下载地址的重定向次数过多或缺少目标地址。");
      }
      await response.body?.cancel();
      let redirectedUrl: string;
      try {
        redirectedUrl = new URL(location, currentUrl).toString();
      } catch {
        throw new ApiError(502, "VIDEO_DOWNLOAD_REDIRECT_REJECTED", "视频下载服务返回了无效的重定向地址。");
      }
      currentUrl = await validatePublicHttpsUrl(redirectedUrl, { allowQuery: true, purpose: "生成视频重定向地址" });
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ApiError(502, "VIDEO_DOWNLOAD_FAILED", `视频已生成，但下载服务返回 HTTP ${response.status}。`);
    }
    const declaredType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
    if (declaredType && ![
      "video/mp4",
      "video/quicktime",
      "application/octet-stream",
      "binary/octet-stream",
    ].includes(declaredType)) {
      await response.body?.cancel();
      throw new ApiError(502, "INVALID_VIDEO_CONTENT_TYPE", "生成结果不是受支持的 MP4 或 MOV 视频。");
    }
    const contentLength = response.headers.get("content-length");
    const declaredSize = contentLength === null ? null : Number(contentLength);
    if (declaredSize !== null && Number.isFinite(declaredSize) && declaredSize > MAX_GENERATED_VIDEO_BYTES) {
      await response.body?.cancel();
      throw new ApiError(502, "VIDEO_RESPONSE_TOO_LARGE", "生成视频超过 100 MB 大小限制。");
    }
    return { response, sourceUrl: currentUrl };
  }
  throw new ApiError(502, "VIDEO_DOWNLOAD_REDIRECT_REJECTED", "视频下载重定向未完成。");
}

function joinBytes(chunks: Uint8Array[], total: number): Uint8Array {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function collectReferenceImages(input: VideoGenerationInput): Array<{ url: string; role: VideoReferenceImageRole }> {
  const images: Array<{ url: string; role: VideoReferenceImageRole }> = [];
  if (input.imageUrl) images.push({ url: input.imageUrl.trim(), role: "first_frame" });
  if (input.referenceImageUrl) {
    images.push({ url: input.referenceImageUrl.trim(), role: input.referenceImageRole ?? "reference_image" });
  }
  if (input.firstFrameUrl) images.push({ url: input.firstFrameUrl.trim(), role: "first_frame" });
  if (input.lastFrameUrl) images.push({ url: input.lastFrameUrl.trim(), role: "last_frame" });
  for (const image of input.referenceImages ?? []) {
    images.push(typeof image === "string"
      ? { url: image.trim(), role: "reference_image" }
      : { url: image.url.trim(), role: image.role ?? "reference_image" });
  }
  if (images.length > 30) throw new ApiError(400, "TOO_MANY_VIDEO_REFERENCES", "单次视频任务最多接收 30 张参考图。");
  for (const singletonRole of ["first_frame", "last_frame"] as const) {
    if (images.filter((image) => image.role === singletonRole).length > 1) {
      throw new ApiError(400, "DUPLICATE_VIDEO_REFERENCE_ROLE", `${singletonRole} 参考图最多只能提供一张。`);
    }
  }
  return images;
}

function validateReferenceImageMode(images: readonly { role: VideoReferenceImageRole }[]): void {
  const generalCount = images.filter((image) => image.role === "reference_image").length;
  const firstCount = images.filter((image) => image.role === "first_frame").length;
  const lastCount = images.filter((image) => image.role === "last_frame").length;
  if (generalCount > 0 && (firstCount > 0 || lastCount > 0)) {
    throw new ApiError(400, "INVALID_VIDEO_REFERENCE_MODE", "内容参考图不能与首帧或尾帧模式混用。");
  }
  if (lastCount > 0 && firstCount === 0) {
    throw new ApiError(400, "INVALID_VIDEO_REFERENCE_MODE", "设置尾帧时必须同时提供首帧。");
  }
  if (firstCount > 0 && images[0]?.role !== "first_frame") {
    throw new ApiError(400, "INVALID_VIDEO_REFERENCE_MODE", "首帧必须是第一张输入图片。");
  }
  if (lastCount > 0 && (images.length !== 2 || images[1]?.role !== "last_frame")) {
    throw new ApiError(400, "INVALID_VIDEO_REFERENCE_MODE", "首尾帧模式必须依次提供一张首帧和一张尾帧图片。");
  }
}

function validateReferenceImageUrlSyntax(value: string): void {
  if (!value) throw new ApiError(400, "INVALID_VIDEO_REFERENCE_URL", "参考图地址不能为空。");
  if (/^asset:\/\/[A-Za-z0-9._~-]+$/i.test(value)) return;
  const data = value.match(/^data:(image\/(?:jpeg|png|webp|bmp|tiff|gif|heic|heif));base64,([A-Za-z0-9+/=]+)$/);
  if (data) {
    if (data[2].length > Math.ceil(MAX_REFERENCE_IMAGE_BYTES * 4 / 3) + 4) {
      throw new ApiError(400, "VIDEO_REFERENCE_TOO_LARGE", "单张参考图不能超过 30 MB。");
    }
    return;
  }
  validateHttpsUrlSyntax(value, "参考图地址", "INVALID_VIDEO_REFERENCE_URL");
}

function validateHttpsUrlSyntax(value: string, label: string, code = "INVALID_VIDEO_CALLBACK_URL"): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError(400, code, `${label}必须是有效的 HTTPS URL。`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new ApiError(400, code, `${label}必须使用 HTTPS，且不能包含凭据或片段。`);
  }
  return url.toString();
}

async function validateRequestUrls(request: Record<string, unknown>): Promise<void> {
  const content = Array.isArray(request.content) ? request.content : [];
  for (const item of content) {
    const object = asRecord(item);
    const imageUrl = asRecord(object?.image_url);
    if (typeof imageUrl?.url === "string" && imageUrl.url.startsWith("https:")) {
      await validatePublicHttpsUrl(imageUrl.url, { allowQuery: true, purpose: "视频参考图地址" });
    }
  }
  if (typeof request.callback_url === "string") {
    await validatePublicHttpsUrl(request.callback_url, { allowQuery: true, purpose: "视频任务回调地址" });
  }
}

function assertModelReady(model: Record<string, unknown>): void {
  if (model.enabled === false || model.enabled === 0) {
    throw new ApiError(400, "MODEL_DISABLED", "所选模型已停用。");
  }
  const ciphertext = model.api_key_ciphertext ?? model.apiKeyCiphertext;
  const iv = model.api_key_iv ?? model.apiKeyIv;
  if (!ciphertext || !iv) throw new ApiError(400, "MODEL_API_KEY_MISSING", "所选模型尚未配置 API Key。");
  if (!modelSupportsVideoGeneration(model)) {
    throw new ApiError(400, "MODEL_VIDEO_UNSUPPORTED", "所选模型未声明视频生成能力。");
  }
}

async function modelConnection(model: Record<string, unknown>): Promise<{ endpoint: string; apiKey: string }> {
  const baseEndpoint = await validateModelEndpoint(String(model.endpoint ?? ""));
  const endpoint = await validateModelEndpoint(videoGenerationEndpoint(baseEndpoint));
  let apiKey: string;
  try {
    apiKey = await decryptApiKey(
      String(model.api_key_ciphertext ?? model.apiKeyCiphertext),
      String(model.api_key_iv ?? model.apiKeyIv),
    );
  } catch {
    throw new ApiError(503, "MODEL_API_KEY_DECRYPT_FAILED", "模型 API Key 无法解密，请重新保存密钥。");
  }
  return { endpoint, apiKey };
}

async function parseProviderResponse(response: Response): Promise<{
  result: Record<string, unknown> | null;
  rawText: string;
}> {
  const raw = await readLimitedBytes(response, MAX_PROVIDER_RESPONSE_BYTES, "视频服务响应");
  const rawText = new TextDecoder().decode(raw);
  if (!rawText.trim()) return { result: null, rawText };
  try {
    return { result: asRecord(JSON.parse(rawText)), rawText };
  } catch {
    if (response.ok) throw invalidTaskResponse("视频服务返回了无法解析的成功响应。");
    return { result: null, rawText };
  }
}

async function readLimitedBytes(response: Response, limit: number, label: string): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  const declared = contentLength === null ? null : Number(contentLength);
  if (declared !== null && Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    throw new ApiError(502, "VIDEO_RESPONSE_TOO_LARGE", `${label}超过 ${Math.round(limit / 1024 / 1024)} MB 大小限制。`);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new ApiError(502, "VIDEO_RESPONSE_TOO_LARGE", `${label}超过 ${Math.round(limit / 1024 / 1024)} MB 大小限制。`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, "VIDEO_RESPONSE_STREAM_FAILED", `${label}读取中断，请稍后重试。`);
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function sniffVideoType(bytes: Uint8Array): "video/mp4" | "video/quicktime" {
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(4, 8)) === "ftyp") {
    return String.fromCharCode(...bytes.slice(8, 12)) === "qt  " ? "video/quicktime" : "video/mp4";
  }
  throw new ApiError(502, "INVALID_VIDEO_BYTES", "生成结果不是有效的 MP4 或 MOV 视频。");
}

function rejectTaskRedirect(response: Response): void {
  if (response.status >= 300 && response.status < 400) {
    throw new ApiError(502, "VIDEO_MODEL_REDIRECT_REJECTED", "视频生成接口返回了不受信任的重定向，请检查模型地址。");
  }
}

function taskNetworkError(error: unknown, externalSignal: AbortSignal | undefined, action: string): ApiError {
  if (externalSignal?.aborted) {
    return new ApiError(409, "GENERATION_LEASE_LOST", `生成任务执行权已过期，已停止${action}视频任务。`);
  }
  const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
  const timeoutMessage = action === "提交"
    ? "视频服务提交请求长时间未响应，任务可能已被服务商受理。为避免重复计费，请先在服务商控制台核对任务记录。"
    : `视频服务${action}请求超时，请稍后重试。`;
  return new ApiError(
    502,
    timedOut ? "VIDEO_MODEL_TIMEOUT" : "VIDEO_MODEL_NETWORK_ERROR",
    timedOut ? timeoutMessage : `无法连接视频生成服务，${action}任务失败。`,
  );
}

function invalidTaskResponse(message: string): ApiError {
  return new ApiError(502, "INVALID_VIDEO_TASK_RESPONSE", message);
}

function isTaskStatus(value: string): value is VideoGenerationTaskStatus {
  return ["queued", "running", "succeeded", "failed", "cancelled", "expired"].includes(value);
}

function providerApiError(
  status: number,
  result: Record<string, unknown> | null,
  rawText: string,
  operation: "create" | "query",
): ApiError {
  const providerMessage = sanitizeProviderMessage(extractProviderError(result) || (!result ? rawText : ""));
  const providerCode = extractProviderErrorCode(result);
  const diagnostic = `${providerCode} ${providerMessage}`;
  if (status === 401 || status === 403) {
    return new ApiError(422, "VIDEO_AUTH_FAILED", "视频服务拒绝了 API Key，请更新密钥并确认模型调用权限。");
  }
  if (status === 429 || /QuotaExceeded|rate.?limit|quota/i.test(diagnostic)) {
    return new ApiError(429, "VIDEO_RATE_LIMITED", "视频服务正在限流或账户配额不足，请稍后重试并检查供应商配额。");
  }
  if (/InputTextSensitiveContentDetected|InputImageSensitiveContentDetected|OutputVideoSensitiveContentDetected|content[_-]?policy|safety|moderation|sensitive|审核|安全策略/i.test(diagnostic)) {
    return new ApiError(400, "VIDEO_CONTENT_POLICY", "输入或生成结果未通过视频服务的内容安全检查，请调整素材与描述后重试。");
  }
  if (operation === "query" && status === 404) {
    return new ApiError(404, "VIDEO_TASK_NOT_FOUND", "视频生成任务不存在或已超过服务商的保留期限。");
  }
  if (status === 400 || status === 404 || status === 409 || status === 422) {
    return new ApiError(400, "VIDEO_INVALID_REQUEST", providerMessage || `视频服务拒绝了请求（HTTP ${status}），请核对模型 ID 与生成参数。`);
  }
  if (status >= 500) {
    return new ApiError(502, "VIDEO_PROVIDER_UNAVAILABLE", `视频服务暂时不可用（HTTP ${status}），请稍后重试。`);
  }
  return new ApiError(502, "VIDEO_GENERATION_FAILED", providerMessage || `视频服务请求失败（HTTP ${status}）。`);
}

function extractProviderError(result: Record<string, unknown> | null): string {
  if (!result) return "";
  const error = result.error;
  if (typeof error === "string") return error;
  const object = asRecord(error);
  if (typeof object?.message === "string") return object.message;
  if (typeof object?.code === "string") return object.code;
  return typeof result.message === "string" ? result.message : "";
}

function extractProviderErrorCode(result: Record<string, unknown> | null): string {
  const error = asRecord(result?.error);
  if (typeof error?.code === "string") return error.code;
  return typeof error?.type === "string" ? error.type : "";
}

function sanitizeProviderMessage(value: string): string {
  return value
    .replace(/\b(?:sk|ak)-[A-Za-z0-9_-]{8,}\b/gi, "[已隐藏密钥]")
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [已隐藏]")
    .replace(/https:\/\/\S+\?\S+/gi, "[已隐藏签名地址]")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, 500);
}

export function isOfficialSeedanceProfile(value: string): value is SeedanceRequestProfile {
  return Boolean(findSeedanceModelPreset(value));
}
