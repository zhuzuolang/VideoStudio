import { env } from "cloudflare:workers";
import { ApiError } from "./api";

export type RuntimeBindings = {
  DB?: D1Database;
  MEDIA?: R2Bucket;
  MODEL_KEY_ENCRYPTION_SECRET?: string;
  ALLOW_LOCAL_MODEL_ENDPOINTS?: string;
};

export function bindings(): RuntimeBindings {
  return env as unknown as RuntimeBindings;
}

export function database(): D1Database {
  const db = bindings().DB;
  if (!db) {
    throw new ApiError(503, "DATABASE_NOT_CONFIGURED", "数据库尚未配置，请联系站点管理员。 ");
  }
  return db;
}

export function mediaBucket(): R2Bucket {
  const bucket = bindings().MEDIA;
  if (!bucket) {
    throw new ApiError(503, "MEDIA_STORAGE_NOT_CONFIGURED", "媒体存储尚未配置，请联系站点管理员。 ");
  }
  return bucket;
}

export function encryptionSecret(): string {
  const secret = bindings().MODEL_KEY_ENCRYPTION_SECRET?.trim();
  if (!secret) {
    throw new ApiError(
      503,
      "MODEL_ENCRYPTION_NOT_CONFIGURED",
      "模型密钥加密尚未配置，请设置 MODEL_KEY_ENCRYPTION_SECRET。",
    );
  }
  if (secret.length < 32) {
    throw new ApiError(503, "MODEL_ENCRYPTION_SECRET_WEAK", "模型密钥加密配置至少需要 32 个字符。 ");
  }
  return secret;
}
