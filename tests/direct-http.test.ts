import { describe, expect, test, vi } from "vitest";

vi.mock("@/lib/server/outbound", () => ({
  allowlistedPublicHttpModelEndpoint: (value: string) => value,
}));

import { directHttpFetch } from "@/lib/server/direct-http";

function fakeSocket(responseChunks: Array<string | Uint8Array>) {
  const writes: Uint8Array[] = [];
  const closeWritable = vi.fn();
  const socket = {
    readable: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of responseChunks) {
          controller.enqueue(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
        }
        controller.close();
      },
    }),
    writable: new WritableStream<Uint8Array>({
      write(chunk) { writes.push(chunk.slice()); },
      close: closeWritable,
    }),
    opened: Promise.resolve({ remoteAddress: "8.163.6.244:8317" }),
    close: vi.fn(async () => undefined),
  };
  return { socket, writes, closeWritable };
}

function contentLengthResponse(status: number, body: string, contentType = "application/json"): string {
  const length = new TextEncoder().encode(body).byteLength;
  return `HTTP/1.1 ${status} Test\r\nContent-Type: ${contentType}\r\nContent-Length: ${length}\r\n\r\n${body}`;
}

describe("allowlisted direct HTTP transport", () => {
  test("sends the custom port, bearer header and JSON body unchanged", async () => {
    const responseBody = JSON.stringify({ choices: [{ message: { content: "OK" } }] });
    const wire = contentLengthResponse(200, responseBody);
    const split = Math.floor(wire.length / 2);
    const { socket, writes, closeWritable } = fakeSocket([wire.slice(0, split), wire.slice(split)]);
    const connect = vi.fn(() => socket);
    const requestBody = JSON.stringify({ model: "gpt-5.6-luna", prompt: "连接测试", stream: false });

    const response = await directHttpFetch("http://8.163.6.244:8317/v1/chat/completions", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: "Bearer test-provider-secret",
      },
      body: requestBody,
    }, { connect, maxResponseBytes: 1024, timeoutMs: 1_000 });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ choices: [{ message: { content: "OK" } }] });
    expect(connect).toHaveBeenCalledWith(
      { hostname: "8.163.6.244", port: 8317 },
      { secureTransport: "off", allowHalfOpen: true },
    );
    const rawRequest = new TextDecoder().decode(concatenate(writes));
    expect(rawRequest).toContain("POST /v1/chat/completions HTTP/1.1\r\n");
    expect(rawRequest).toContain("Host: 8.163.6.244:8317\r\n");
    expect(rawRequest).toContain("authorization: Bearer test-provider-secret\r\n");
    expect(rawRequest).toContain("accept-encoding: identity\r\n");
    expect(rawRequest).toContain(`Content-Length: ${new TextEncoder().encode(requestBody).byteLength}\r\n`);
    expect(rawRequest).toContain("Connection: close\r\n\r\n");
    expect(rawRequest.endsWith(requestBody)).toBe(true);
    expect(closeWritable).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalled();
  });

  test("decodes a chunked provider response split across socket reads", async () => {
    const body = JSON.stringify({ choices: [{ message: { content: "模型连接正常" } }] });
    const first = body.slice(0, 9);
    const second = body.slice(9);
    const wire = [
      "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n",
      `${new TextEncoder().encode(first).byteLength.toString(16)}\r\n${first}\r\n`,
      `${new TextEncoder().encode(second).byteLength.toString(16)}\r\n${second}\r\n`,
      "0\r\n\r\n",
    ].join("");
    const encodedWire = new TextEncoder().encode(wire);
    const socketChunks: Uint8Array[] = [];
    for (let offset = 0; offset < encodedWire.byteLength; offset += 3) {
      socketChunks.push(encodedWire.slice(offset, offset + 3));
    }
    const { socket } = fakeSocket(socketChunks);

    const response = await directHttpFetch("http://8.163.6.244:8317/v1/chat/completions", {
      method: "POST",
      body: "{}",
    }, { connect: () => socket, maxResponseBytes: 1024, timeoutMs: 1_000 });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ choices: [{ message: { content: "模型连接正常" } }] });
    expect(response.headers.get("transfer-encoding")).toBeNull();
  });

  test("preserves an upstream authentication status for the caller to map safely", async () => {
    const { socket } = fakeSocket([contentLengthResponse(401, "Unauthorized", "text/plain")]);
    const response = await directHttpFetch("http://8.163.6.244:8317/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer test-provider-secret" },
      body: "{}",
    }, { connect: () => socket, maxResponseBytes: 1024, timeoutMs: 1_000 });

    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toBe("Unauthorized");
  });

  test("aborts an in-flight response and closes the socket", async () => {
    const controller = new AbortController();
    const socket = {
      readable: new ReadableStream<Uint8Array>({ pull() { return new Promise(() => undefined); } }),
      writable: new WritableStream<Uint8Array>(),
      opened: Promise.resolve({ remoteAddress: "8.163.6.244:8317" }),
      close: vi.fn(async () => undefined),
    };
    const pending = directHttpFetch("http://8.163.6.244:8317/v1/chat/completions", {
      method: "POST",
      body: "{}",
      signal: controller.signal,
    }, { connect: () => socket, maxResponseBytes: 1024, timeoutMs: 1_000 });

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(socket.close).toHaveBeenCalled();
  });

  test("rejects truncated and ambiguous response framing", async () => {
    const truncated = fakeSocket(["HTTP/1.1 200 OK\r\nContent-Length: 12\r\n\r\nshort"]);
    await expect(directHttpFetch("http://8.163.6.244:8317/v1/chat/completions", {
      method: "POST",
      body: "{}",
    }, { connect: () => truncated.socket, maxResponseBytes: 100, timeoutMs: 1_000 }))
      .rejects.toMatchObject({ code: "INVALID_MODEL_RESPONSE" });

    const ambiguous = fakeSocket([
      "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n",
    ]);
    await expect(directHttpFetch("http://8.163.6.244:8317/v1/chat/completions", {
      method: "POST",
      body: "{}",
    }, { connect: () => ambiguous.socket, maxResponseBytes: 100, timeoutMs: 1_000 }))
      .rejects.toMatchObject({ code: "INVALID_MODEL_RESPONSE" });
  });

  test("rejects oversized and malformed responses with stable safe errors", async () => {
    const oversized = fakeSocket(["HTTP/1.1 200 OK\r\nContent-Length: 9999\r\n\r\n"]);
    await expect(directHttpFetch("http://8.163.6.244:8317/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer must-not-leak" },
      body: "{}",
    }, { connect: () => oversized.socket, maxResponseBytes: 100, timeoutMs: 1_000 }))
      .rejects.toMatchObject({ code: "MODEL_RESPONSE_TOO_LARGE" });

    const malformed = fakeSocket(["not-http\r\n\r\nsecret-response"]);
    const error = await directHttpFetch("http://8.163.6.244:8317/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer must-not-leak" },
      body: "{}",
    }, { connect: () => malformed.socket, maxResponseBytes: 100, timeoutMs: 1_000 }).catch((reason) => reason);
    expect(error).toMatchObject({ code: "INVALID_MODEL_RESPONSE" });
    expect(String(error.message)).not.toContain("must-not-leak");
    expect(String(error.message)).not.toContain("secret-response");
  });
});

function concatenate(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
