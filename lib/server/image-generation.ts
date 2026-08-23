import { ApiError, parseJson } from "./api";
import { decryptApiKey } from "./crypto";
import { validateModelEndpoint, validatePublicHttpsUrl } from "./outbound";

const MAX_PROVIDER_RESPONSE_BYTES = 28 * 1024 * 1024;
export const MAX_GENERATED_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 120_000;

export type ImageGenerationInput = {
  prompt: string;
  size?: string;
  aspectRatio?: string;
};

export type GeneratedImage = {
  bytes: Uint8Array;
  mimeType: string;
  sourceUrl: string | null;
  revisedPrompt: string | null;
};

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
  const descriptor = `${String(model.name ?? "")} ${String(model.model_id ?? model.modelId ?? "")}`;
  return explicitlyGenerative
    || /seedream|dall-e|image[-_ ]?(?:gen|generation)|text[-_ ]?to[-_ ]?image|图片生成|图像生成/i.test(descriptor);
}

export function imageGenerationEndpoint(value: string): string {
  const url = new URL(value);
  const path = url.pathname.replace(/\/+$/, "");
  if (/\/images\/generations$/i.test(path)) return url.toString();
  if (/\/chat\/completions$/i.test(path)) url.pathname = path.replace(/\/chat\/completions$/i, "/images/generations");
  else url.pathname = `${path}/images/generations`.replace(/\/+/g, "/");
  return url.toString();
}

function defaultImageSize(model: Record<string, unknown>, aspectRatio?: string): string {
  const descriptor = `${String(model.name ?? "")} ${String(model.model_id ?? model.modelId ?? "")}`;
  const ratio = aspectRatio || "1:1";
  if (/seedream|doubao/i.test(descriptor)) {
    return ({ "9:16": "1440x2560", "16:9": "2560x1440", "4:3": "2304x1728", "3:4": "1728x2304", "1:1": "2048x2048" } as Record<string, string>)[ratio] ?? "2048x2048";
  }
  return ({ "9:16": "1024x1792", "16:9": "1792x1024", "4:3": "1792x1024", "3:4": "1024x1792", "1:1": "1024x1024" } as Record<string, string>)[ratio] ?? "1024x1024";
}

export async function generateImageWithModel(
  model: Record<string, unknown>,
  input: ImageGenerationInput,
  fetchImpl: typeof fetch = fetch,
): Promise<GeneratedImage> {
  if (!model.enabled) throw new ApiError(400, "MODEL_DISABLED", "所选模型已停用。 ");
  if (!model.api_key_ciphertext || !model.api_key_iv) throw new ApiError(400, "MODEL_API_KEY_MISSING", "所选模型尚未配置 API Key。 ");
  if (!modelSupportsImageGeneration(model)) throw new ApiError(400, "MODEL_IMAGE_UNSUPPORTED", "所选模型未声明图像生成能力。 ");
  const prompt = input.prompt.trim();
  if (!prompt || prompt.length > 8_000) throw new ApiError(400, "INVALID_IMAGE_PROMPT", "图像提示词长度必须在 1 到 8000 字符之间。 ");
  const size = input.size?.trim() || defaultImageSize(model, input.aspectRatio);
  if (!/^\d{2,5}x\d{2,5}$/.test(size) && !/^[124]K$/i.test(size)) throw new ApiError(400, "INVALID_IMAGE_SIZE", "图片尺寸格式必须类似 1024x1024 或 2K。 ");
  const baseEndpoint = await validateModelEndpoint(String(model.endpoint));
  const endpoint = await validateModelEndpoint(imageGenerationEndpoint(baseEndpoint));
  let apiKey: string;
  try { apiKey = await decryptApiKey(String(model.api_key_ciphertext), String(model.api_key_iv)); }
  catch { throw new ApiError(503, "MODEL_API_KEY_DECRYPT_FAILED", "模型 API Key 无法解密，请重新保存密钥。 "); }
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: String(model.model_id), prompt, size, response_format: "b64_json" }),
      redirect: "manual",
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ApiError(502, "IMAGE_MODEL_NETWORK_ERROR", error instanceof Error && error.name === "TimeoutError" ? "图像生成超时。" : "无法连接图像生成服务。 ");
  }
  if (response.status >= 300 && response.status < 400) throw new ApiError(502, "IMAGE_MODEL_REDIRECT_REJECTED", "图像生成服务返回重定向，已拒绝。 ");
  const raw = await readLimitedBytes(response, MAX_PROVIDER_RESPONSE_BYTES, "图像生成响应");
  let result: Record<string, unknown>;
  try { result = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>; }
  catch { throw new ApiError(502, "INVALID_IMAGE_MODEL_RESPONSE", "图像生成服务返回了无法解析的响应。 "); }
  if (!response.ok) {
    const providerMessage = extractProviderError(result);
    throw new ApiError(response.status === 401 || response.status === 403 ? 401 : 502, "IMAGE_GENERATION_FAILED", providerMessage || "图像生成服务请求失败。 ");
  }
  const first = Array.isArray(result.data) ? result.data[0] as Record<string, unknown> | undefined : undefined;
  if (!first) throw new ApiError(502, "IMAGE_RESULT_MISSING", "图像生成服务没有返回图片。 ");
  const revisedPrompt = typeof first.revised_prompt === "string" ? first.revised_prompt : null;
  if (typeof first.b64_json === "string") {
    const bytes = decodeBase64(first.b64_json);
    return { bytes, mimeType: sniffImageType(bytes), sourceUrl: null, revisedPrompt };
  }
  if (typeof first.url !== "string") throw new ApiError(502, "IMAGE_RESULT_MISSING", "图像生成服务未返回 URL 或 b64_json。 ");
  const sourceUrl = await validatePublicHttpsUrl(first.url, { allowQuery: true, purpose: "生成图片地址" });
  let imageResponse: Response;
  try { imageResponse = await fetchImpl(sourceUrl, { redirect: "manual", signal: AbortSignal.timeout(30_000) }); }
  catch { throw new ApiError(502, "IMAGE_DOWNLOAD_FAILED", "无法下载生成图片。 "); }
  if (imageResponse.status >= 300 && imageResponse.status < 400) throw new ApiError(502, "IMAGE_DOWNLOAD_REDIRECT_REJECTED", "生成图片地址返回重定向，已拒绝。 ");
  if (!imageResponse.ok) throw new ApiError(502, "IMAGE_DOWNLOAD_FAILED", "生成图片下载失败。 ");
  const declaredType = imageResponse.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
  if (!declaredType.startsWith("image/") || declaredType === "image/svg+xml") throw new ApiError(502, "INVALID_IMAGE_CONTENT_TYPE", "生成结果不是受支持的位图图片。 ");
  const bytes = await readLimitedBytes(imageResponse, MAX_GENERATED_IMAGE_BYTES, "生成图片");
  const detected = sniffImageType(bytes);
  return { bytes, mimeType: detected || declaredType, sourceUrl, revisedPrompt };
}

async function readLimitedBytes(response: Response, limit: number, label: string): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  const declared = contentLength === null ? null : Number(contentLength);
  if (declared !== null && Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    throw new ApiError(502, "IMAGE_RESPONSE_TOO_LARGE", `${label}超过大小限制。 `);
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
        throw new ApiError(502, "IMAGE_RESPONSE_TOO_LARGE", `${label}超过大小限制。 `);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function decodeBase64(value: string): Uint8Array {
  if (value.length > Math.ceil(MAX_GENERATED_IMAGE_BYTES * 4 / 3) + 4) throw new ApiError(502, "IMAGE_RESPONSE_TOO_LARGE", "生成图片超过大小限制。 ");
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (bytes.byteLength > MAX_GENERATED_IMAGE_BYTES) throw new ApiError(502, "IMAGE_RESPONSE_TOO_LARGE", "生成图片超过大小限制。 ");
    return bytes;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, "INVALID_IMAGE_BASE64", "图像生成服务返回了无效的 base64 图片。 ");
  }
}

function sniffImageType(bytes: Uint8Array): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  throw new ApiError(502, "INVALID_IMAGE_BYTES", "生成结果不是受支持的 PNG、JPEG 或 WebP 图片。 ");
}

function extractProviderError(result: Record<string, unknown>): string | null {
  const error = result.error;
  if (typeof error === "string") return error.slice(0, 500);
  if (error && typeof error === "object" && typeof (error as Record<string, unknown>).message === "string") return String((error as Record<string, unknown>).message).slice(0, 500);
  return null;
}
