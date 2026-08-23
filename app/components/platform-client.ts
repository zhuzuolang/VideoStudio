import type { AiModel, ModelCapability } from "@/lib/platform-types";

export class PlatformApiError extends Error {
  code: string;
  details?: unknown;

  constructor(message: string, code = "REQUEST_FAILED", details?: unknown) {
    super(message);
    this.name = "PlatformApiError";
    this.code = code;
    this.details = details;
  }
}

export async function apiRequest<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers:
      init?.body instanceof FormData
        ? init.headers
        : { "Content-Type": "application/json", ...init?.headers },
  });

  let payload: unknown = null;
  const text = await response.text();
  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      if (!response.ok) {
        throw new PlatformApiError("服务返回了无法解析的响应，请稍后重试。", `HTTP_${response.status}`);
      }
    }
  }

  if (payload && typeof payload === "object" && "error" in payload) {
    const failure = payload as { error?: { code?: string; message?: string; details?: unknown } };
    throw new PlatformApiError(
      failure.error?.message ?? "请求未完成，请稍后重试。",
      failure.error?.code ?? `HTTP_${response.status}`,
      failure.error?.details,
    );
  }

  if (!response.ok) {
    throw new PlatformApiError(`请求未完成（${response.status}），请稍后重试。`, `HTTP_${response.status}`);
  }

  if (payload && typeof payload === "object" && "data" in payload) {
    return (payload as { data: T }).data;
  }

  return payload as T;
}

export function joinClassNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export function getModelCapabilities(model: AiModel): ModelCapability[] {
  const capabilities = model.parameters?.capabilities;
  return Array.isArray(capabilities)
    ? capabilities.filter((item): item is ModelCapability => typeof item === "string" && item.trim().length > 0)
    : [];
}

export function formatCompactDate(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
