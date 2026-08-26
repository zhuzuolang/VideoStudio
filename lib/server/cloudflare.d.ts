declare module "cloudflare:workers" {
  export const env: {
    DB?: D1Database;
    MEDIA?: R2Bucket;
    MODEL_KEY_ENCRYPTION_SECRET?: string;
    [key: string]: unknown;
  };
}

interface D1Result<T = Record<string, unknown>> {
  results?: T[];
  success: boolean;
  meta: { changes?: number; [key: string]: unknown };
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(columnName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

interface R2Object {
  size: number;
  httpEtag: string;
  httpMetadata?: { contentType?: string };
}

interface R2ObjectBody extends R2Object {
  body: ReadableStream<Uint8Array>;
  range?: { offset: number; length: number };
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface R2Bucket {
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null,
    options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ): Promise<unknown>;
  head(key: string): Promise<R2Object | null>;
  get(key: string, options?: { range?: { offset: number; length: number } | Headers }): Promise<R2ObjectBody | null>;
  delete(keys: string | string[]): Promise<void>;
}

interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}
