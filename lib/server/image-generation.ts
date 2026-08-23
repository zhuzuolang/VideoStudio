import { ApiError, parseJson } from "./api";
import { decryptApiKey } from "./crypto";
import { validateModelEndpoint, validatePublicHttpsUrl } from "./outbound";

const MAX_PROVIDER_RESPONSE_BYTES = 18 * 1024 * 1024;
export const MAX_GENERATED_IMAGE_BYTES = 12 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 120_000;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_IMAGE_REDIRECTS = 3;

export type ImageGenerationInput = {
  prompt: string;
  size?: string;
  aspectRatio?: string;
  signal?: AbortSignal;
};

export type GeneratedImage = {
  bytes: Uint8Array;
  mimeType: string;
  sourceUrl: string | null;
  revisedPrompt: string | null;
};

type ImageProviderFamily = "seedream" | "gpt-image" | "dall-e-2" | "dall-e-3" | "compatible";

function modelDescriptor(model: Record<string, unknown>): string {
  return `${String(model.provider ?? "")} ${String(model.name ?? "")} ${String(model.model_id ?? model.modelId ?? "")} ${String(model.endpoint ?? "")}`;
}

function imageProviderFamily(model: Record<string, unknown>): ImageProviderFamily {
  const descriptor = modelDescriptor(model);
  if (/seedream|doubao|volces|volcengine|火山|豆包/i.test(descriptor)) return "seedream";
  if (/gpt[-_ ]?image/i.test(descriptor)) return "gpt-image";
  if (/dall[-_ ]?e[-_ ]?2/i.test(descriptor)) return "dall-e-2";
  if (/dall[-_ ]?e/i.test(descriptor)) return "dall-e-3";
  return "compatible";
}

export function modelSupportsImageGeneration(model: Record<string, unknown>): boolean {
  const parameters = parseJson<Record<string, unknown>>(model.parameters_json ?? model.parametersJson, {});
  const capabilities = Array.isArray(parameters.capabilities)
    ? parameters.capabilities.map((value) => String(value).trim().toLowerCase())
    : [];
  const explicitlyGenerative = capabilities.some((value) => [
    "image-generation",
    "image_generation",
    "text-to-image",
    "图片生成",
    "图像生成",
  ].includes(value));
  return explicitlyGenerative
    || /seedream|dall-e|gpt[-_ ]?image|image[-_ ]?(?:gen|generation)|text[-_ ]?to[-_ ]?image|图片生成|图像生成/i.test(modelDescriptor(model));
}

export function imageGenerationEndpoint(value: string): string {
  const url = new URL(value);
  const path = url.pathname.replace(/\/+$/, "");
  if (/\/images\/generations$/i.test(path)) return url.toString();
  if (/\/chat\/completions$/i.test(path)) url.pathname = path.replace(/\/chat\/completions$/i, "/images/generations");
  else url.pathname = `${path}/images/generations`.replace(/\/+/g, "/");
  return url.toString();
}

export function defaultImageSize(model: Record<string, unknown>, aspectRatio?: string): string {
  const ratio = aspectRatio || "1:1";
  const family = imageProviderFamily(model);
  if (family === "seedream") {
    return ({ "9:16": "1440x2560", "16:9": "2560x1440", "4:3": "2304x1728", "3:4": "1728x2304", "1:1": "2048x2048" } as Record<string, string>)[ratio] ?? "2048x2048";
  }
  if (family === "gpt-image") {
    return ({ "9:16": "1024x1536", "16:9": "1536x1024", "4:3": "1536x1024", "3:4": "1024x1536", "1:1": "1024x1024" } as Record<string, string>)[ratio] ?? "1024x1024";
  }
  if (family === "dall-e-2") return "1024x1024";
  return ({ "9:16": "1024x1792", "16:9": "1792x1024", "4:3": "1792x1024", "3:4": "1024x1792", "1:1": "1024x1024" } as Record<string, string>)[ratio] ?? "1024x1024";
}

export function buildImageGenerationRequest(
  model: Record<string, unknown>,
  input: ImageGenerationInput,
): Record<string, unknown> {
  const prompt = input.prompt.trim();
  const size = input.size?.trim() || defaultImageSize(model, input.aspectRatio);
  const parameters = parseJson<Record<string, unknown>>(model.parameters_json ?? model.parametersJson, {});
  const configuredResponseFormat = typeof parameters.imageResponseFormat === "string"
    ? parameters.imageResponseFormat
    : typeof parameters.image_response_format === "string"
      ? parameters.image_response_format
      : undefined;
  const outputFormat = typeof parameters.imageOutputFormat === "string"
    ? parameters.imageOutputFormat
    : typeof parameters.image_output_format === "string"
      ? parameters.image_output_format
      : "webp";
  const base = { model: String(model.model_id ?? model.modelId ?? ""), prompt, size };
  switch (imageProviderFamily(model)) {
    case "gpt-image":
      // GPT Image always returns base64 and rejects the DALL-E-only response_format field.
      return { ...base, output_format: outputFormat };
    case "seedream":
      // A short URL response avoids holding both a large base64 JSON document and decoded image in memory.
      return { ...base, response_format: configuredResponseFormat || "url", stream: false };
    case "dall-e-2":
    case "dall-e-3":
    case "compatible":
    default:
      return { ...base, response_format: configuredResponseFormat || "b64_json" };
  }
}

export async function generateImageWithModel(
  model: Record<string, unknown>,
  input: ImageGenerationInput,
  fetchImpl: typeof fetch = fetch,
): Promise<GeneratedImage> {
  if (!model.enabled) throw new ApiError(400, "MODEL_DISABLED", "所选模型已停用。");
  if (!model.api_key_ciphertext || !model.api_key_iv) throw new ApiError(400, "MODEL_API_KEY_MISSING", "所选模型尚未配置 API Key。");
  if (!modelSupportsImageGeneration(model)) throw new ApiError(400, "MODEL_IMAGE_UNSUPPORTED", "所选模型未声明图像生成能力。");
  const prompt = input.prompt.trim();
  if (!prompt || prompt.length > 8_000) throw new ApiError(400, "INVALID_IMAGE_PROMPT", "图像提示词长度必须在 1 到 8000 字符之间。");
  const size = input.size?.trim() || defaultImageSize(model, input.aspectRatio);
  if (!/^\d{2,5}x\d{2,5}$/.test(size) && !/^[124]K$/i.test(size)) throw new ApiError(400, "INVALID_IMAGE_SIZE", "图片尺寸格式必须类似 1024x1024 或 2K。");
  validateImageSizeForModel(model, size, input.aspectRatio, Boolean(input.size?.trim()));
  const baseEndpoint = await validateModelEndpoint(String(model.endpoint));
  const endpoint = await validateModelEndpoint(imageGenerationEndpoint(baseEndpoint));
  let apiKey: string;
  try {
    apiKey = await decryptApiKey(String(model.api_key_ciphertext), String(model.api_key_iv));
  } catch {
    throw new ApiError(503, "MODEL_API_KEY_DECRYPT_FAILED", "模型 API Key 无法解密，请重新保存密钥。");
  }

  let response: Response;
  if (input.signal?.aborted) throw new ApiError(409, "GENERATION_LEASE_LOST", "生成任务执行权已过期。");
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(buildImageGenerationRequest(model, { ...input, prompt, size })),
      redirect: "manual",
      signal: input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(IMAGE_TIMEOUT_MS)])
        : AbortSignal.timeout(IMAGE_TIMEOUT_MS),
    });
  } catch (error) {
    if (input.signal?.aborted) throw new ApiError(409, "GENERATION_LEASE_LOST", "生成任务执行权已过期，已停止等待模型结果。");
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new ApiError(502, timedOut ? "IMAGE_MODEL_TIMEOUT" : "IMAGE_MODEL_NETWORK_ERROR", timedOut
      ? "图像服务在 120 秒内未完成请求。该请求可能已被服务商受理，请核对调用记录后再决定是否重试。"
      : "无法连接图像生成服务，请检查模型地址或稍后重试。");
  }
  if (response.status >= 300 && response.status < 400) {
    throw new ApiError(502, "IMAGE_MODEL_REDIRECT_REJECTED", "图像生成接口返回了不受信任的重定向，请检查模型地址。");
  }

  const raw = await readLimitedBytes(response, MAX_PROVIDER_RESPONSE_BYTES, "图像生成响应");
  const rawText = new TextDecoder().decode(raw);
  let result: Record<string, unknown> | null = null;
  try {
    result = JSON.parse(rawText) as Record<string, unknown>;
  } catch {
    if (response.ok) throw new ApiError(502, "INVALID_IMAGE_MODEL_RESPONSE", "图像生成服务返回了无法解析的成功响应。");
  }
  if (!response.ok) throw providerApiError(response.status, result, rawText);
  if (!result) throw new ApiError(502, "INVALID_IMAGE_MODEL_RESPONSE", "图像生成服务返回了无法解析的响应。");

  const first = Array.isArray(result.data) ? result.data[0] as Record<string, unknown> | undefined : undefined;
  if (!first) throw new ApiError(502, "IMAGE_RESULT_MISSING", "图像生成服务没有返回图片。");
  const revisedPrompt = typeof first.revised_prompt === "string" ? first.revised_prompt : null;
  if (typeof first.b64_json === "string") {
    const bytes = decodeBase64(first.b64_json);
    return { bytes, mimeType: sniffImageType(bytes), sourceUrl: null, revisedPrompt };
  }
  if (typeof first.url !== "string") throw new ApiError(502, "IMAGE_RESULT_MISSING", "图像生成服务未返回图片 URL 或 base64 数据。");

  const downloaded = await downloadGeneratedImage(first.url, fetchImpl, input.signal);
  const declaredType = downloaded.response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
  if (declaredType === "image/svg+xml" || (declaredType && !declaredType.startsWith("image/") && declaredType !== "application/octet-stream")) {
    throw new ApiError(502, "INVALID_IMAGE_CONTENT_TYPE", "生成结果不是受支持的位图图片。");
  }
  const bytes = await readLimitedBytes(downloaded.response, MAX_GENERATED_IMAGE_BYTES, "生成图片");
  const detected = sniffImageType(bytes);
  return { bytes, mimeType: detected, sourceUrl: downloaded.url, revisedPrompt };
}

async function downloadGeneratedImage(
  initialUrl: string,
  fetchImpl: typeof fetch,
  externalSignal?: AbortSignal,
): Promise<{ response: Response; url: string }> {
  let currentUrl = await validatePublicHttpsUrl(initialUrl, { allowQuery: true, purpose: "生成图片地址" });
  for (let redirectCount = 0; redirectCount <= MAX_IMAGE_REDIRECTS; redirectCount += 1) {
    let response: Response;
    try {
      response = await fetchImpl(currentUrl, {
        redirect: "manual",
        signal: externalSignal
          ? AbortSignal.any([externalSignal, AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS)])
          : AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS),
      });
    } catch {
      if (externalSignal?.aborted) throw new ApiError(409, "GENERATION_LEASE_LOST", "生成任务执行权已过期，已停止下载模型结果。");
      throw new ApiError(502, "IMAGE_DOWNLOAD_FAILED", "图片已生成，但下载结果时连接中断。");
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirectCount === MAX_IMAGE_REDIRECTS) {
        throw new ApiError(502, "IMAGE_DOWNLOAD_REDIRECT_REJECTED", "图片已生成，但下载地址的重定向次数过多或缺少目标地址。");
      }
      await response.body?.cancel();
      let redirectedUrl: string;
      try {
        redirectedUrl = new URL(location, currentUrl).toString();
      } catch {
        throw new ApiError(502, "IMAGE_DOWNLOAD_REDIRECT_REJECTED", "图片已生成，但下载服务返回了无效的重定向地址。");
      }
      currentUrl = await validatePublicHttpsUrl(redirectedUrl, { allowQuery: true, purpose: "生成图片重定向地址" });
      continue;
    }
    if (!response.ok) throw new ApiError(502, "IMAGE_DOWNLOAD_FAILED", `图片已生成，但下载服务返回 HTTP ${response.status}。`);
    return { response, url: currentUrl };
  }
  throw new ApiError(502, "IMAGE_DOWNLOAD_REDIRECT_REJECTED", "图片下载重定向未完成。");
}

async function readLimitedBytes(response: Response, limit: number, label: string): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  const declared = contentLength === null ? null : Number(contentLength);
  if (declared !== null && Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    throw new ApiError(502, "IMAGE_RESPONSE_TOO_LARGE", `${label}超过 ${Math.round(limit / 1024 / 1024)} MB 大小限制。`);
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
        throw new ApiError(502, "IMAGE_RESPONSE_TOO_LARGE", `${label}超过 ${Math.round(limit / 1024 / 1024)} MB 大小限制。`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, "IMAGE_RESPONSE_STREAM_FAILED", `${label}读取中断，请稍后重试。`);
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

function decodeBase64(value: string): Uint8Array {
  if (value.length > Math.ceil(MAX_GENERATED_IMAGE_BYTES * 4 / 3) + 4) throw new ApiError(502, "IMAGE_RESPONSE_TOO_LARGE", "生成图片超过 12 MB 大小限制。");
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (bytes.byteLength > MAX_GENERATED_IMAGE_BYTES) throw new ApiError(502, "IMAGE_RESPONSE_TOO_LARGE", "生成图片超过 12 MB 大小限制。");
    return bytes;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, "INVALID_IMAGE_BASE64", "图像生成服务返回了无效的 base64 图片。");
  }
}

function sniffImageType(bytes: Uint8Array): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  throw new ApiError(502, "INVALID_IMAGE_BYTES", "生成结果不是受支持的 PNG、JPEG 或 WebP 图片。");
}

function providerApiError(status: number, result: Record<string, unknown> | null, rawText: string): ApiError {
  const providerMessage = sanitizeProviderMessage(extractProviderError(result) || (!result ? rawText : ""));
  const providerCode = extractProviderErrorCode(result);
  if (status === 401 || status === 403) return new ApiError(422, "IMAGE_AUTH_FAILED", "图像服务拒绝了 API Key，请更新密钥并确认模型调用权限。");
  if (status === 429) return new ApiError(429, "IMAGE_RATE_LIMITED", "图像服务正在限流或账户配额不足，请稍后重试并检查供应商配额。");
  if (status === 400 || status === 404 || status === 409 || status === 422) {
    if (/content[_-]?policy|safety|moderation|sensitive|审核|安全策略/i.test(`${providerCode} ${providerMessage}`)) {
      return new ApiError(400, "IMAGE_CONTENT_POLICY", "提示词未通过图像服务的内容安全检查，请调整描述后重试。");
    }
    return new ApiError(400, "IMAGE_INVALID_REQUEST", providerMessage || `图像服务拒绝了生成参数（HTTP ${status}），请核对模型 ID、尺寸和模型类型。`);
  }
  if (status >= 500) return new ApiError(502, "IMAGE_PROVIDER_UNAVAILABLE", `图像服务暂时不可用（HTTP ${status}），请稍后重试。`);
  return new ApiError(502, "IMAGE_GENERATION_FAILED", providerMessage || `图像服务请求失败（HTTP ${status}）。`);
}

function extractProviderError(result: Record<string, unknown> | null): string {
  if (!result) return "";
  const error = result.error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const object = error as Record<string, unknown>;
    if (typeof object.message === "string") return object.message;
    if (typeof object.code === "string") return object.code;
  }
  if (typeof result.message === "string") return result.message;
  return "";
}

function extractProviderErrorCode(result: Record<string, unknown> | null): string {
  if (!result?.error || typeof result.error !== "object") return "";
  const error = result.error as Record<string, unknown>;
  return typeof error.code === "string" ? error.code : typeof error.type === "string" ? error.type : "";
}

function validateImageSizeForModel(
  model: Record<string, unknown>,
  size: string,
  aspectRatio: string | undefined,
  hasCustomSize: boolean,
): void {
  const family = imageProviderFamily(model);
  if (family === "seedream" || family === "compatible") return;
  if (/^[124]K$/i.test(size)) {
    throw new ApiError(400, "INVALID_IMAGE_SIZE", "当前模型不接受 1K/2K/4K 尺寸档位，请选择模型支持的像素尺寸。");
  }
  if (family === "dall-e-2") {
    if (!hasCustomSize && aspectRatio && aspectRatio !== "1:1") {
      throw new ApiError(400, "INVALID_IMAGE_SIZE", "DALL-E 2 只支持 1:1 画幅，请选择 1:1 后重试。");
    }
    if (!["256x256", "512x512", "1024x1024"].includes(size)) {
      throw new ApiError(400, "INVALID_IMAGE_SIZE", "DALL-E 2 仅支持 256x256、512x512 或 1024x1024。");
    }
    return;
  }
  if (family === "dall-e-3" && !["1024x1024", "1792x1024", "1024x1792"].includes(size)) {
    throw new ApiError(400, "INVALID_IMAGE_SIZE", "DALL-E 3 仅支持 1024x1024、1792x1024 或 1024x1792。");
  }
  if (family === "gpt-image" && !/gpt[-_ ]?image[-_ ]?2/i.test(modelDescriptor(model))
    && !["1024x1024", "1536x1024", "1024x1536"].includes(size)) {
    throw new ApiError(400, "INVALID_IMAGE_SIZE", "当前 GPT Image 模型仅支持 1024x1024、1536x1024 或 1024x1536。");
  }
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
