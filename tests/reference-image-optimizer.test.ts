import { zlibSync } from "fflate";
import jpeg from "jpeg-js";
import { describe, expect, test } from "vitest";

import {
  ReferenceImageOptimizationInputError,
  optimizeReferenceImageInWorker,
} from "@/lib/server/reference-image-optimizer";

function generatedPng(width: number, height: number): Uint8Array<ArrayBuffer> {
  const scanlines = new Uint8Array(height * (width * 4 + 1));
  let state = 0x1234abcd;
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (width * 4 + 1);
    scanlines[rowOffset] = 0;
    for (let x = 0; x < width; x += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      const offset = rowOffset + 1 + x * 4;
      scanlines[offset] = state & 0xff;
      scanlines[offset + 1] = (state >>> 8) & 0xff;
      scanlines[offset + 2] = (state >>> 16) & 0xff;
      scanlines[offset + 3] = 0xff;
    }
  }
  return pngFromCompressed(width, height, zlibSync(scanlines, { level: 6 }));
}

function pngFromCompressed(width: number, height: number, compressed: Uint8Array): Uint8Array<ArrayBuffer> {
  return pngFromIdatChunks(width, height, [compressed]);
}

function pngFromIdatChunks(
  width: number,
  height: number,
  compressedChunks: readonly Uint8Array[],
): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  return concatenate([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    ...compressedChunks.map((chunk) => pngChunk("IDAT", chunk)),
    pngChunk("IEND", new Uint8Array()),
  ]);
}

function generatedBmp(width: number, height: number): Uint8Array<ArrayBuffer> {
  const rowBytes = Math.ceil(width * 3 / 4) * 4;
  const bytes = new Uint8Array(54 + rowBytes * height);
  const view = new DataView(bytes.buffer);
  bytes.set([0x42, 0x4d]);
  view.setUint32(2, bytes.byteLength, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(34, rowBytes * height, true);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = 54 + y * rowBytes + x * 3;
      bytes[offset] = Math.round(255 * x / Math.max(1, width - 1));
      bytes[offset + 1] = Math.round(255 * y / Math.max(1, height - 1));
      bytes[offset + 2] = 96;
    }
  }
  return bytes;
}

function generatedJpeg(width: number, height: number): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    data[index * 4] = (index * 17) & 0xff;
    data[index * 4 + 1] = (index * 31) & 0xff;
    data[index * 4 + 2] = (index * 47) & 0xff;
    data[index * 4 + 3] = 0xff;
  }
  return Uint8Array.from(jpeg.encode({ data, width, height }, 90).data);
}

function webpFixture(base64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(Buffer.from(base64, "base64"));
}

const LOSSY_WEBP = "UklGRnIAAABXRUJQVlA4IGUAAADwAACdASoEAAMAAAA0AAAAAPw2M/P+eB05Hck+ykqf9mnEv/cA8/2acS/9wDz/ZpxL/3CB2nc//9XVVPAb//6vX6n3P//V7X/+u16qbT/0D8Gz5r+1HPD/+qGivKXvb74+CtiRwAA=";
const LOSSY_ALPHA_WEBP = "UklGRpoAAABXRUJQVlA4WAoAAAAQAAAAAwAAAgAAQUxQSA0AAAAAABcuRVxziqG4z+b9AFZQOCBlAAAA8AAAnQEqBAADAAAANAAAAAD8NjPz/ngdOR3JPspKn/ZpxL/3APP9mnEv/cA8/2acS/9wgdp3P//V1VTwG//+r1+p9z//1e1//rteqm0/9A/Bs+a/tRzw//qhoryl72++PgrYkcAA";
const LOSSLESS_WEBP = "UklGRi4AAABXRUJQVlA4TCEAAAAvAUAAEJGIiCgAgvA/bUMgQOD/mUAgaX/oAYKw7jzMwkUA";

function webpWithCompressedAlphaFlag(): Uint8Array<ArrayBuffer> {
  const bytes = webpFixture(LOSSY_ALPHA_WEBP);
  const alphaChunk = Buffer.from(bytes).indexOf("ALPH", 12, "ascii");
  if (alphaChunk < 0) throw new Error("Expected an ALPH chunk in the fixture");
  bytes[alphaChunk + 8] |= 1;
  return bytes;
}

function decodedJpegDimensions(bytes: Uint8Array): { width: number; height: number } {
  const decoded = jpeg.decode(bytes, {
    useTArray: true,
    maxResolutionInMP: 2,
    maxMemoryUsageInMB: 32,
  });
  return { width: decoded.width, height: decoded.height };
}

function pngChunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(12 + data.byteLength);
  const view = new DataView(result.buffer);
  view.setUint32(0, data.byteLength);
  const typeBytes = Uint8Array.from(type, (character) => character.charCodeAt(0));
  result.set(typeBytes, 4);
  result.set(data, 8);
  view.setUint32(8 + data.byteLength, crc32(result.subarray(4, 8 + data.byteLength)));
  return result;
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngHeaderWithDimensions(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

describe("optimizeReferenceImageInWorker", () => {
  test("resizes a PNG into a budgeted JPEG without a hosted Images binding", async () => {
    const source = generatedPng(128, 96);
    const byteBudget = 16 * 1024;

    const optimized = await optimizeReferenceImageInWorker(
      source,
      "image/png",
      byteBudget,
      [{ width: 32, quality: 70 }],
    );

    expect(optimized).not.toBeNull();
    if (!optimized) throw new Error("Expected the Worker optimizer to produce a JPEG image");
    expect(optimized.mimeType).toBe("image/jpeg");
    expect(optimized.bytes.byteLength).toBeGreaterThan(0);
    expect(optimized.bytes.byteLength).toBeLessThanOrEqual(byteBudget);
    expect(optimized.bytes.byteLength).toBeLessThan(source.byteLength);
    expect(Array.from(optimized.bytes.subarray(0, 2))).toEqual([0xff, 0xd8]);
    expect(Array.from(optimized.bytes.subarray(-2))).toEqual([0xff, 0xd9]);

    expect(decodedJpegDimensions(optimized.bytes)).toEqual({ width: 32, height: 24 });
  });

  test.each([
    ["JPEG", generatedJpeg(128, 96), "image/jpeg"],
    ["BMP", generatedBmp(128, 96), "image/bmp"],
  ])("resizes a real %s reference through the fallback pipeline", async (_label, source, mimeType) => {
    const optimized = await optimizeReferenceImageInWorker(
      source,
      mimeType,
      16 * 1024,
      [{ width: 32, quality: 70 }],
    );

    expect(optimized).not.toBeNull();
    if (!optimized) throw new Error("Expected a fallback-optimized JPEG image");
    expect(optimized.bytes.byteLength).toBeLessThanOrEqual(16 * 1024);
    expect(decodedJpegDimensions(optimized.bytes)).toEqual({ width: 32, height: 24 });
  });

  test.each([
    ["lossy VP8", LOSSY_WEBP],
    ["lossy VP8X with alpha", LOSSY_ALPHA_WEBP],
  ])("decodes the application's default %s WebP path in the Worker fallback", async (_label, fixture) => {
    const optimized = await optimizeReferenceImageInWorker(
      webpFixture(fixture),
      "image/webp",
      16 * 1024,
      [{ width: 4, quality: 70 }],
    );

    expect(optimized).not.toBeNull();
    if (!optimized) throw new Error("Expected a fallback-optimized JPEG image");
    expect(optimized.bytes.byteLength).toBeLessThanOrEqual(16 * 1024);
    expect(decodedJpegDimensions(optimized.bytes)).toEqual({ width: 4, height: 3 });
  });

  test("rejects lossless VP8L before its unbounded Huffman tables can be allocated", async () => {
    await expect(optimizeReferenceImageInWorker(
      webpFixture(LOSSLESS_WEBP),
      "image/webp",
      16 * 1024,
      [{ width: 2, quality: 70 }],
    )).rejects.toMatchObject({
      name: "ReferenceImageOptimizationInputError",
      reason: "unsupported_format",
    });
  });

  test("rejects compressed ALPH before it can re-enter the VP8L decoder", async () => {
    await expect(optimizeReferenceImageInWorker(
      webpWithCompressedAlphaFlag(),
      "image/webp",
      16 * 1024,
      [{ width: 4, quality: 70 }],
    )).rejects.toMatchObject({
      name: "ReferenceImageOptimizationInputError",
      reason: "unsupported_format",
    });
  });

  test("enforces the Worker input-byte limit inside the WebP optimizer", async () => {
    await expect(optimizeReferenceImageInWorker(
      new Uint8Array(8 * 1024 * 1024 + 1),
      "image/webp",
      16 * 1024,
      [{ width: 2, quality: 70 }],
    )).rejects.toMatchObject({
      name: "ReferenceImageOptimizationInputError",
      reason: "unsafe_dimensions",
    });
  });

  test.each(["image/jpeg", "image/png", "image/bmp"])(
    "enforces the Worker input-byte limit before decoding %s",
    async (mimeType) => {
      await expect(optimizeReferenceImageInWorker(
        new Uint8Array(8 * 1024 * 1024 + 1),
        mimeType,
        16 * 1024,
        [{ width: 2, quality: 70 }],
      )).rejects.toMatchObject({
        name: "ReferenceImageOptimizationInputError",
        reason: "unsafe_dimensions",
      });
    },
  );

  test.each([
    [4_097, 1],
    [2_000, 1_251],
  ])("rejects an oversized PNG dimension header before decoding (%ix%i)", async (width, height) => {
    const maliciousHeader = pngHeaderWithDimensions(width, height);

    await expect(optimizeReferenceImageInWorker(
      maliciousHeader,
      "image/png",
      16 * 1024,
      [{ width: 32, quality: 70 }],
    )).rejects.toThrow(`Reference image dimensions exceed the safe Worker limit (${width}x${height})`);
  });

  test("rejects corrupt PNG data as a deterministic input error", async () => {
    const corrupt = pngFromCompressed(32, 32, new Uint8Array([0x78, 0x9c, 0x00]));

    await expect(optimizeReferenceImageInWorker(
      corrupt,
      "image/png",
      16 * 1024,
      [{ width: 32, quality: 70 }],
    )).rejects.toBeInstanceOf(ReferenceImageOptimizationInputError);
  });

  test("caps PNG inflation at the exact scanline size", async () => {
    const inflatedBomb = zlibSync(new Uint8Array(512 * 1024), { level: 9 });
    const misleadingOnePixelPng = pngFromCompressed(1, 1, inflatedBomb);

    await expect(optimizeReferenceImageInWorker(
      misleadingOnePixelPng,
      "image/png",
      16 * 1024,
      [{ width: 1, quality: 70 }],
    )).rejects.toMatchObject({
      name: "ReferenceImageOptimizationInputError",
      reason: "invalid_image",
    });
  });

  test("rejects a PNG with excessive IDAT chunk bookkeeping", async () => {
    const excessiveChunks = pngFromIdatChunks(
      1,
      1,
      Array.from({ length: 2_049 }, () => new Uint8Array()),
    );

    await expect(optimizeReferenceImageInWorker(
      excessiveChunks,
      "image/png",
      16 * 1024,
      [{ width: 1, quality: 70 }],
    )).rejects.toMatchObject({
      name: "ReferenceImageOptimizationInputError",
      reason: "invalid_image",
    });
  });
});
