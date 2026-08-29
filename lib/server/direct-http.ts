import { ApiError } from "./api";
import { allowlistedPublicHttpModelEndpoint } from "./outbound";

type DirectSocket = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  opened: Promise<unknown>;
  close(): Promise<void>;
};

type DirectSocketConnector = (
  address: { hostname: string; port: number },
  options: { secureTransport: "off"; allowHalfOpen: boolean },
) => DirectSocket | Promise<DirectSocket>;

type DirectHttpFetchOptions = {
  connect?: DirectSocketConnector;
  timeoutMs?: number;
  maxResponseBytes?: number;
};

const MAX_RESPONSE_HEADER_BYTES = 64 * 1024;
const MAX_CHUNK_FRAMING_BYTES = 256 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function directHttpFetch(
  input: string,
  init: RequestInit,
  options: DirectHttpFetchOptions = {},
): Promise<Response> {
  const url = new URL(input);
  if (
    !allowlistedPublicHttpModelEndpoint(input)
    || url.protocol !== "http:"
    || !url.port
    || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname)
  ) {
    throw new ApiError(500, "INVALID_DIRECT_HTTP_TARGET", "直连模型地址必须是带端口的 HTTP 公网 IPv4 地址。");
  }

  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ApiError(500, "INVALID_DIRECT_HTTP_TARGET", "直连模型地址端口无效。");
  }

  const body = requestBodyBytes(init.body);
  const headers = new Headers(init.headers);
  headers.delete("host");
  headers.delete("content-length");
  headers.delete("connection");
  headers.delete("transfer-encoding");
  if (!headers.has("accept-encoding")) headers.set("Accept-Encoding", "identity");

  const requestLines = [
    `${String(init.method ?? "GET").toUpperCase()} ${url.pathname || "/"}${url.search} HTTP/1.1`,
    `Host: ${url.host}`,
  ];
  for (const [name, value] of headers) requestLines.push(`${name}: ${value}`);
  requestLines.push(`Content-Length: ${body.byteLength}`, "Connection: close", "", "");

  const connect = options.connect ?? cloudflareSocketConnect;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxResponseBytes = options.maxResponseBytes ?? 2 * 1024 * 1024;
  const deadline = Date.now() + timeoutMs;
  let socket: DirectSocket | undefined;
  const closeSocket = () => {
    if (!socket) return;
    try { void socket.close().catch(() => undefined); }
    catch { /* Closing is best-effort while another socket operation is pending. */ }
  };
  try {
    socket = await withinDeadline(
      Promise.resolve(connect(
        { hostname: url.hostname, port },
        { secureTransport: "off", allowHalfOpen: true },
      )),
      deadline,
      closeSocket,
    );
    await withinDeadline(socket.opened, deadline, closeSocket);

    const writer = socket.writable.getWriter();
    try {
      await withinDeadline(writer.write(encoder.encode(requestLines.join("\r\n"))), deadline, closeSocket);
      if (body.byteLength > 0) await withinDeadline(writer.write(body), deadline, closeSocket);
      // Do not half-close the TCP write side after the declared request body.
      // Some OpenAI-compatible gateways treat a client FIN as cancellation and
      // return 499 (and some runtimes may also truncate the readable side).
      // Content-Length already frames the request; the server's
      // `Connection: close` response and our finally block close the socket.
    } finally {
      try { writer.releaseLock(); }
      catch { /* A timed-out write may still own the lock until the socket closes. */ }
    }

    return await readHttpResponse(socket, deadline, maxResponseBytes);
  } finally {
    if (socket) await socket.close().catch(() => undefined);
  }
}

async function cloudflareSocketConnect(
  address: { hostname: string; port: number },
  options: { secureTransport: "off"; allowHalfOpen: boolean },
): Promise<DirectSocket> {
  const { connect } = await import("cloudflare:sockets");
  return connect(address, options);
}

async function readHttpResponse(
  socket: DirectSocket,
  deadline: number,
  maxResponseBytes: number,
): Promise<Response> {
  const reader = socket.readable.getReader();
  const rawLimit = MAX_RESPONSE_HEADER_BYTES + maxResponseBytes + MAX_CHUNK_FRAMING_BYTES;
  const raw = new Uint8Array(rawLimit);
  let total = 0;
  let headerEnd = -1;
  let parsedHead: ParsedResponseHead | undefined;
  try {
    while (true) {
      const { done, value } = await withinDeadline(reader.read(), deadline, () => {
        try { void socket.close().catch(() => undefined); }
        catch { /* Closing is best-effort while a read is pending. */ }
      });
      if (done) break;
      if (value.byteLength > rawLimit - total) throw responseTooLarge();
      raw.set(value, total);
      total += value.byteLength;

      if (headerEnd < 0) {
        headerEnd = indexOfSequence(raw.subarray(0, total), new Uint8Array([13, 10, 13, 10]));
        if (headerEnd < 0) {
          if (total > MAX_RESPONSE_HEADER_BYTES) throw invalidHttpResponse();
          continue;
        }
        if (headerEnd > MAX_RESPONSE_HEADER_BYTES) throw invalidHttpResponse();
        parsedHead = parseResponseHead(raw.subarray(0, headerEnd));
        const declared = parsedHead.contentLength;
        if (declared !== null && declared > maxResponseBytes) throw responseTooLarge();
      }

      const bodyBytes = total - headerEnd - 4;
      if (parsedHead?.contentLength !== null && parsedHead?.contentLength !== undefined) {
        if (bodyBytes >= parsedHead.contentLength) break;
      } else if (parsedHead?.chunked) {
        if (decodeChunkedBody(raw.subarray(headerEnd + 4, total), maxResponseBytes) !== null) break;
      } else if (bodyBytes > maxResponseBytes) {
        throw responseTooLarge();
      }
    }
  } finally {
    try { reader.releaseLock(); }
    catch { /* A timed-out read may still own the lock until the socket closes. */ }
  }

  if (headerEnd < 0 || !parsedHead) throw invalidHttpResponse();
  const framedBody = raw.subarray(headerEnd + 4, total);
  let responseBody: Uint8Array;
  if (parsedHead.chunked) {
    const decoded = decodeChunkedBody(framedBody, maxResponseBytes);
    if (!decoded) throw invalidHttpResponse();
    responseBody = decoded;
  } else if (parsedHead.contentLength !== null) {
    if (framedBody.byteLength < parsedHead.contentLength) throw invalidHttpResponse();
    responseBody = framedBody.slice(0, parsedHead.contentLength);
  } else {
    if (framedBody.byteLength > maxResponseBytes) throw responseTooLarge();
    responseBody = framedBody.slice();
  }

  parsedHead.headers.delete("connection");
  parsedHead.headers.delete("transfer-encoding");
  parsedHead.headers.set("Content-Length", String(responseBody.byteLength));
  const bodyForbidden = parsedHead.status === 204 || parsedHead.status === 205 || parsedHead.status === 304;
  return new Response(bodyForbidden ? null : asArrayBuffer(responseBody), {
    status: parsedHead.status,
    headers: parsedHead.headers,
  });
}

type ParsedResponseHead = {
  status: number;
  headers: Headers;
  contentLength: number | null;
  chunked: boolean;
};

function parseResponseHead(bytes: Uint8Array): ParsedResponseHead {
  const lines = decoder.decode(bytes).split("\r\n");
  const statusMatch = lines.shift()?.match(/^HTTP\/1\.[01] (\d{3})(?: |$)/);
  const status = statusMatch ? Number(statusMatch[1]) : 0;
  if (status < 200 || status > 599) throw invalidHttpResponse();

  const headers = new Headers();
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator <= 0) throw invalidHttpResponse();
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    try { headers.append(name, value); }
    catch { throw invalidHttpResponse(); }
  }

  const contentLengthValue = headers.get("content-length");
  let contentLength: number | null = null;
  if (contentLengthValue !== null) {
    if (!/^\d+$/.test(contentLengthValue)) throw invalidHttpResponse();
    contentLength = Number(contentLengthValue);
    if (!Number.isSafeInteger(contentLength)) throw invalidHttpResponse();
  }
  const transferEncoding = headers.get("transfer-encoding")?.trim().toLowerCase() ?? null;
  const chunked = transferEncoding === "chunked";
  if (transferEncoding !== null && !chunked) throw invalidHttpResponse();
  if (chunked && contentLength !== null) throw invalidHttpResponse();
  const contentEncoding = headers.get("content-encoding")?.trim().toLowerCase() ?? null;
  if (contentEncoding !== null && contentEncoding !== "identity") throw invalidHttpResponse();
  return { status, headers, contentLength, chunked };
}

function decodeChunkedBody(bytes: Uint8Array, maxResponseBytes: number): Uint8Array | null {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let offset = 0;
  while (true) {
    const lineEnd = indexOfSequence(bytes, new Uint8Array([13, 10]), offset);
    if (lineEnd < 0) return null;
    const sizeText = decoder.decode(bytes.subarray(offset, lineEnd)).split(";", 1)[0].trim();
    if (!/^[0-9a-f]+$/i.test(sizeText)) throw invalidHttpResponse();
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isSafeInteger(size)) throw invalidHttpResponse();
    offset = lineEnd + 2;

    if (size === 0) {
      if (bytes.byteLength < offset + 2) return null;
      if (bytes[offset] === 13 && bytes[offset + 1] === 10) return concatenate(chunks, total);
      const trailerEnd = indexOfSequence(bytes, new Uint8Array([13, 10, 13, 10]), offset);
      return trailerEnd < 0 ? null : concatenate(chunks, total);
    }

    if (size > maxResponseBytes - total) throw responseTooLarge();
    if (bytes.byteLength < offset + size + 2) return null;
    if (bytes[offset + size] !== 13 || bytes[offset + size + 1] !== 10) throw invalidHttpResponse();
    chunks.push(bytes.slice(offset, offset + size));
    total += size;
    offset += size + 2;
  }
}

function requestBodyBytes(body: BodyInit | null | undefined): Uint8Array {
  if (body === undefined || body === null) return new Uint8Array();
  if (typeof body === "string") return encoder.encode(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  throw new ApiError(500, "UNSUPPORTED_DIRECT_HTTP_BODY", "直连模型请求正文格式不受支持。");
}

function concatenate(chunks: Uint8Array[], total: number): Uint8Array {
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function indexOfSequence(bytes: Uint8Array, sequence: Uint8Array, start = 0): number {
  outer: for (let index = start; index <= bytes.byteLength - sequence.byteLength; index += 1) {
    for (let offset = 0; offset < sequence.byteLength; offset += 1) {
      if (bytes[index + offset] !== sequence[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function withinDeadline<T>(
  promise: Promise<T>,
  deadline: number,
  onTimeout?: () => void,
): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw timeoutError();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          onTimeout?.();
          reject(timeoutError());
        }, remaining);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function timeoutError(): Error {
  const error = new Error("Direct HTTP request timed out");
  error.name = "TimeoutError";
  return error;
}

function invalidHttpResponse(): ApiError {
  return new ApiError(502, "INVALID_MODEL_RESPONSE", "模型服务返回了无效的 HTTP 响应。");
}

function responseTooLarge(): ApiError {
  return new ApiError(502, "MODEL_RESPONSE_TOO_LARGE", "模型响应超过 2 MB 限制。");
}
