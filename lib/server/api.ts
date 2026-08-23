export type ErrorDetails = Record<string, unknown> | unknown[] | string;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: ErrorDetails;

  constructor(status: number, code: string, message: string, details?: ErrorDetails) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function ok<T>(data: T, init: ResponseInit = {}): Response {
  return Response.json({ data }, init);
}

export function created<T>(data: T): Response {
  return ok(data, { status: 201 });
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return Response.json(
      {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      },
      { status: error.status },
    );
  }

  if (error instanceof Error && /(?:UNIQUE|PRIMARY KEY) constraint failed/i.test(error.message)) {
    return Response.json(
      { error: { code: "RESOURCE_CONFLICT", message: "该编号或名称已存在，请刷新后重试。" } },
      { status: 409 },
    );
  }

  console.error("Unhandled API error", error);
  return Response.json(
    { error: { code: "INTERNAL_ERROR", message: "服务器暂时无法完成请求，请稍后重试。" } },
    { status: 500 },
  );
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new ApiError(400, "INVALID_JSON", "请求正文必须是有效的 JSON。 ");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "INVALID_BODY", "请求正文必须是 JSON 对象。 ");
  }
  return value as Record<string, unknown>;
}

export function requiredString(
  body: Record<string, unknown>,
  key: string,
  options: { max?: number; min?: number } = {},
): string {
  const value = body[key];
  if (typeof value !== "string") {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} 必须是字符串。`, { field: key });
  }
  const trimmed = value.trim();
  const min = options.min ?? 1;
  const max = options.max ?? 10_000;
  if (trimmed.length < min || trimmed.length > max) {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} 长度必须在 ${min} 到 ${max} 个字符之间。`, { field: key });
  }
  return trimmed;
}

export function optionalString(
  body: Record<string, unknown>,
  key: string,
  options: { max?: number; nullable?: boolean } = {},
): string | null | undefined {
  if (!(key in body)) return undefined;
  const value = body[key];
  if (value === null && options.nullable) return null;
  if (typeof value !== "string") {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} 必须是字符串。`, { field: key });
  }
  const trimmed = value.trim();
  if (trimmed.length > (options.max ?? 50_000)) {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} 内容过长。`, { field: key });
  }
  return trimmed;
}

export function optionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  if (!(key in body)) return undefined;
  if (typeof body[key] !== "boolean") {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} 必须是布尔值。`, { field: key });
  }
  return body[key] as boolean;
}

export function optionalInteger(
  body: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  if (!(key in body)) return undefined;
  const value = body[key];
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} 必须是 ${min} 到 ${max} 之间的整数。`, { field: key });
  }
  return value as number;
}

export function jsonText(value: unknown, fallback: unknown): string {
  return JSON.stringify(value === undefined ? fallback : value);
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
