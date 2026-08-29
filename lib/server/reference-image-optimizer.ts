import { Unzlib } from "fflate";
import jpeg from "jpeg-js";
import { webpCodec } from "purejsimage/codecs/webp";

// Decoding an image expands it to RGBA inside a 128 MB Worker isolate. These
// limits leave headroom for the R2 source bytes, the application heap, and the
// JPEG encoder. Inputs are processed one at a time by video-reference-assets.
const MAX_REFERENCE_PIXELS = 2_500_000;
const MAX_REFERENCE_DIMENSION = 4_096;
const MAX_REFERENCE_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_JPEG_DECODE_MEMORY_MB = 64;
const MAX_JPEG_ENCODE_PIXELS = 1_500_000;
const MAX_PNG_CHUNKS = 4_096;
const MAX_PNG_IDAT_CHUNKS = 2_048;
const MAX_WEBP_CHUNKS = 4_096;

export type ReferenceImageOptimizationAttempt = {
  width: number;
  quality: number;
};

export class ReferenceImageOptimizationInputError extends Error {
  constructor(
    readonly reason: "invalid_image" | "unsafe_dimensions" | "unsupported_format",
    message: string,
  ) {
    super(message);
    this.name = "ReferenceImageOptimizationInputError";
  }
}

type RasterDimensions = {
  width: number;
  height: number;
};

type DecodedRaster = RasterDimensions & {
  data: Uint8Array;
  orientation: number;
};

type PngHeader = RasterDimensions & {
  bitDepth: number;
  colorType: number;
  compressionMethod: number;
  filterMethod: number;
  interlaceMethod: number;
};

/**
 * Compresses a project reference image without a hosted Images binding.
 *
 * The decoder is deliberately bounded before it sees untrusted pixels. JPEG
 * uses jpeg-js' own allocation guard; PNG inflation writes into an exact-size
 * output buffer so a compressed-data bomb cannot grow the Worker heap.
 */
export async function optimizeReferenceImageInWorker(
  sourceBytes: Uint8Array<ArrayBuffer>,
  mimeType: string,
  byteBudget: number,
  attempts: readonly ReferenceImageOptimizationAttempt[],
): Promise<{ bytes: Uint8Array<ArrayBuffer>; mimeType: "image/jpeg" } | null> {
  if (sourceBytes.byteLength > MAX_REFERENCE_INPUT_BYTES) {
    throw new ReferenceImageOptimizationInputError(
      "unsafe_dimensions",
      "Reference image exceeds the 8 MB Worker input limit",
    );
  }
  let working: DecodedRaster;
  if (mimeType === "image/webp") {
    working = await decodeWebp(sourceBytes);
  } else {
    const dimensions = assertSafeRasterDimensions(sourceBytes, mimeType);
    working = decodeRaster(sourceBytes, mimeType, dimensions);
  }
  const orientedWidth = swapsOrientationAxes(working.orientation) ? working.height : working.width;
  const orientedHeight = swapsOrientationAxes(working.orientation) ? working.width : working.height;
  let currentOrientation = working.orientation;
  const attemptedVariants = new Set<string>();

  for (const attempt of attempts) {
    const scale = Math.min(
      1,
      attempt.width / Math.max(orientedWidth, orientedHeight),
      Math.sqrt(MAX_JPEG_ENCODE_PIXELS / (orientedWidth * orientedHeight)),
    );
    const width = Math.max(1, Math.round(orientedWidth * scale));
    const height = Math.max(1, Math.round(orientedHeight * scale));
    const attemptKey = `${width}x${height}@${attempt.quality}`;
    if (attemptedVariants.has(attemptKey)) continue;
    attemptedVariants.add(attemptKey);

    // Resize progressively. Once the first opaque frame has been produced the
    // larger decoded buffer is no longer retained while jpeg-js encodes it.
    const rendered = resizeAndComposite(working, width, height, currentOrientation);
    working = rendered;
    currentOrientation = 1;
    const encoded = jpeg.encode(rendered, attempt.quality).data;
    if (encoded.byteLength > 0 && encoded.byteLength <= byteBudget) {
      return {
        bytes: Uint8Array.from(encoded),
        mimeType: "image/jpeg",
      };
    }
  }
  return null;
}

async function decodeWebp(bytes: Uint8Array<ArrayBuffer>): Promise<DecodedRaster> {
  assertWorkerSafeWebp(bytes);
  const limits = {
    maxWidth: MAX_REFERENCE_DIMENSION,
    maxHeight: MAX_REFERENCE_DIMENSION,
    maxPixels: MAX_REFERENCE_PIXELS,
    maxInputBytes: MAX_REFERENCE_INPUT_BYTES,
    maxFrames: 1,
    maxDecodedBytes: MAX_REFERENCE_PIXELS * 4,
  };
  const source = {
    size: bytes.byteLength,
    async read(offset: number, length: number): Promise<Uint8Array<ArrayBuffer>> {
      if (
        !Number.isSafeInteger(offset)
        || !Number.isSafeInteger(length)
        || offset < 0
        || length < 0
        || offset > bytes.byteLength
      ) {
        throw new Error("WebP decoder requested an invalid byte range");
      }
      return bytes.subarray(offset, Math.min(bytes.byteLength, offset + length));
    },
  };

  try {
    if (!webpCodec.createDecoder) throw new Error("WebP decoder is unavailable");
    const decoder = await webpCodec.createDecoder(source, limits);
    if (
      decoder.pixelFormat !== "rgba8"
      || decoder.width <= 0
      || decoder.height <= 0
      || decoder.width > MAX_REFERENCE_DIMENSION
      || decoder.height > MAX_REFERENCE_DIMENSION
      || decoder.width * decoder.height > MAX_REFERENCE_PIXELS
    ) {
      throw new Error("WebP decoder returned an unsupported pixel layout");
    }

    const rgba = new Uint8Array(decoder.width * decoder.height * 4);
    const rowBytes = decoder.width * 4;
    let nextRow = 0;
    for await (const block of decoder.decode()) {
      try {
        const requiredBytes = block.height > 0
          ? (block.height - 1) * block.stride + rowBytes
          : 0;
        if (
          block.format !== "rgba8"
          || block.x !== 0
          || block.y !== nextRow
          || block.width !== decoder.width
          || block.height <= 0
          || block.stride < rowBytes
          || block.data.byteLength < requiredBytes
          || nextRow + block.height > decoder.height
        ) {
          throw new Error("WebP decoder returned a malformed pixel block");
        }
        for (let row = 0; row < block.height; row += 1) {
          const sourceOffset = row * block.stride;
          rgba.set(
            block.data.subarray(sourceOffset, sourceOffset + rowBytes),
            (nextRow + row) * rowBytes,
          );
        }
        nextRow += block.height;
      } finally {
        block.release?.();
      }
    }
    if (nextRow !== decoder.height) throw new Error("WebP decoder returned an incomplete image");
    return {
      data: rgba,
      width: decoder.width,
      height: decoder.height,
      orientation: 1,
    };
  } catch (cause) {
    if (cause instanceof ReferenceImageOptimizationInputError) throw cause;
    const code = imageCodecErrorCode(cause);
    if (code === "LIMIT_EXCEEDED") {
      throw new ReferenceImageOptimizationInputError(
        "unsafe_dimensions",
        `Reference WebP exceeds the safe Worker limit: ${errorMessage(cause)}`,
      );
    }
    throw new ReferenceImageOptimizationInputError(
      "invalid_image",
      `Reference WebP could not be decoded: ${errorMessage(cause)}`,
    );
  }
}

function assertWorkerSafeWebp(bytes: Uint8Array): void {
  if (
    bytes.byteLength < 20
    || ascii(bytes, 0, 4) !== "RIFF"
    || ascii(bytes, 8, 4) !== "WEBP"
  ) {
    throw new ReferenceImageOptimizationInputError(
      "invalid_image",
      "Reference WebP has an invalid RIFF header",
    );
  }

  let offset = 12;
  let chunkCount = 0;
  while (offset + 8 <= bytes.byteLength) {
    chunkCount += 1;
    if (chunkCount > MAX_WEBP_CHUNKS) {
      throw new ReferenceImageOptimizationInputError(
        "invalid_image",
        "Reference WebP contains too many chunks",
      );
    }
    const chunkType = ascii(bytes, offset, 4);
    const chunkLength = uint32le(bytes, offset + 4);
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + chunkLength;
    const paddedEnd = dataEnd + (chunkLength & 1);
    if (dataEnd < dataOffset || paddedEnd > bytes.byteLength) {
      throw new ReferenceImageOptimizationInputError(
        "invalid_image",
        "Reference WebP chunk exceeds file bounds",
      );
    }
    // purejsimage 0.17.0 does not bound VP8L spatial Huffman group tables.
    // Reject lossless payloads before decoding so a crafted, otherwise small
    // image cannot exhaust the 128 MB Worker isolate. Lossy VP8 and VP8X+VP8
    // (including alpha) remain supported and cover the app's default output.
    if (chunkType === "VP8L") {
      throw new ReferenceImageOptimizationInputError(
        "unsupported_format",
        "Lossless WebP is not supported by the bounded Worker optimizer",
      );
    }
    if (chunkType === "ALPH") {
      if (chunkLength < 1) {
        throw new ReferenceImageOptimizationInputError(
          "invalid_image",
          "Reference WebP contains an empty alpha chunk",
        );
      }
      // ALPH compression mode 1 re-enters the same VP8L lossless decoder and
      // inherits its unbounded spatial Huffman group allocation. Only raw
      // alpha mode 0 is safe here; values 2 and 3 are reserved by the format.
      if ((bytes[dataOffset] & 0x03) !== 0) {
        throw new ReferenceImageOptimizationInputError(
          "unsupported_format",
          "Compressed WebP alpha is not supported by the bounded Worker optimizer",
        );
      }
    }
    offset = paddedEnd;
  }
}

function imageCodecErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "invalid image bytes";
}

function assertSafeRasterDimensions(bytes: Uint8Array, mimeType: string): RasterDimensions {
  const dimensions = rasterDimensions(bytes, mimeType);
  if (!dimensions) {
    throw new ReferenceImageOptimizationInputError(
      "invalid_image",
      "Reference image dimensions could not be read safely",
    );
  }
  const { width, height } = dimensions;
  if (
    width <= 0
    || height <= 0
    || width > MAX_REFERENCE_DIMENSION
    || height > MAX_REFERENCE_DIMENSION
    || width * height > MAX_REFERENCE_PIXELS
  ) {
    throw new ReferenceImageOptimizationInputError(
      "unsafe_dimensions",
      `Reference image dimensions exceed the safe Worker limit (${width}x${height})`,
    );
  }
  return dimensions;
}

function decodeRaster(
  bytes: Uint8Array<ArrayBuffer>,
  mimeType: string,
  dimensions: RasterDimensions,
): DecodedRaster {
  try {
    if (mimeType === "image/jpeg") return decodeJpeg(bytes, dimensions);
    if (mimeType === "image/png") return decodePng(bytes, dimensions);
    if (mimeType === "image/bmp") return decodeBmp(bytes, dimensions);
    throw new Error(`Unsupported reference image type: ${mimeType}`);
  } catch (cause) {
    if (cause instanceof ReferenceImageOptimizationInputError) throw cause;
    throw new ReferenceImageOptimizationInputError(
      "invalid_image",
      `Reference image could not be decoded: ${cause instanceof Error ? cause.message : "invalid image bytes"}`,
    );
  }
}

function decodeJpeg(bytes: Uint8Array, dimensions: RasterDimensions): DecodedRaster {
  const decoded = jpeg.decode(bytes, {
    useTArray: true,
    tolerantDecoding: false,
    maxResolutionInMP: MAX_REFERENCE_PIXELS / 1_000_000,
    maxMemoryUsageInMB: MAX_JPEG_DECODE_MEMORY_MB,
  });
  if (
    decoded.width !== dimensions.width
    || decoded.height !== dimensions.height
    || decoded.data.byteLength !== decoded.width * decoded.height * 4
  ) {
    throw new Error("JPEG dimensions changed while decoding");
  }
  return {
    data: decoded.data,
    width: decoded.width,
    height: decoded.height,
    orientation: jpegExifOrientation(bytes),
  };
}

function decodePng(bytes: Uint8Array, dimensions: RasterDimensions): DecodedRaster {
  let offset = 8;
  let header: PngHeader | null = null;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const idatChunks: Uint8Array[] = [];
  let idatLength = 0;
  let chunkCount = 0;
  let reachedEnd = false;

  while (offset + 12 <= bytes.byteLength) {
    chunkCount += 1;
    if (chunkCount > MAX_PNG_CHUNKS) throw new Error("PNG contains too many chunks");
    const length = uint32be(bytes, offset);
    const typeOffset = offset + 4;
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + length;
    const chunkEnd = dataEnd + 4;
    if (dataEnd < dataOffset || chunkEnd > bytes.byteLength) throw new Error("PNG chunk exceeds file bounds");
    const type = ascii(bytes, typeOffset, 4);
    const expectedCrc = uint32be(bytes, dataEnd);
    if (crc32(bytes.subarray(typeOffset, dataEnd)) !== expectedCrc) {
      throw new Error(`PNG ${type} chunk checksum is invalid`);
    }
    const data = bytes.subarray(dataOffset, dataEnd);

    if (type === "IHDR") {
      if (header || length !== 13 || offset !== 8) throw new Error("PNG IHDR chunk is invalid");
      header = {
        width: uint32be(data, 0),
        height: uint32be(data, 4),
        bitDepth: data[8],
        colorType: data[9],
        compressionMethod: data[10],
        filterMethod: data[11],
        interlaceMethod: data[12],
      };
    } else if (type === "PLTE") {
      if (length === 0 || length > 768 || length % 3 !== 0) throw new Error("PNG palette is invalid");
      palette = Uint8Array.from(data);
    } else if (type === "tRNS") {
      if (length > 256) throw new Error("PNG transparency table is invalid");
      transparency = Uint8Array.from(data);
    } else if (type === "IDAT") {
      if (idatChunks.length >= MAX_PNG_IDAT_CHUNKS) throw new Error("PNG contains too many image-data chunks");
      idatLength += data.byteLength;
      if (idatLength > bytes.byteLength) throw new Error("PNG image data is invalid");
      idatChunks.push(data);
    } else if (type === "IEND") {
      if (length !== 0) throw new Error("PNG IEND chunk is invalid");
      reachedEnd = true;
      break;
    }
    offset = chunkEnd;
  }

  if (!header || !reachedEnd || idatChunks.length === 0) throw new Error("PNG is incomplete");
  if (header.width !== dimensions.width || header.height !== dimensions.height) {
    throw new Error("PNG dimensions changed while decoding");
  }
  if (header.compressionMethod !== 0 || header.filterMethod !== 0 || header.interlaceMethod !== 0) {
    throw new Error("PNG compression, filtering, or interlacing mode is unsupported");
  }
  const channels = pngChannelCount(header.colorType);
  if (!validPngBitDepth(header.colorType, header.bitDepth)) throw new Error("PNG bit depth is unsupported");
  if (header.colorType === 3 && !palette) throw new Error("Indexed PNG is missing its palette");

  const rowBytes = Math.ceil(header.width * channels * header.bitDepth / 8);
  const expectedInflatedBytes = header.height * (rowBytes + 1);
  if (!Number.isSafeInteger(expectedInflatedBytes) || expectedInflatedBytes <= 0) {
    throw new Error("PNG decoded size is invalid");
  }
  const inflated = inflatePngData(idatChunks, expectedInflatedBytes);
  unfilterPngScanlines(inflated, header.height, rowBytes, Math.max(1, Math.ceil(channels * header.bitDepth / 8)));

  const rgba = new Uint8Array(header.width * header.height * 4);
  const maxSample = (1 << Math.min(header.bitDepth, 8)) - 1;
  const transparentGray = transparency && transparency.byteLength === 2 ? uint16be(transparency, 0) : null;
  const transparentRgb = transparency && transparency.byteLength === 6
    ? [uint16be(transparency, 0), uint16be(transparency, 2), uint16be(transparency, 4)]
    : null;

  for (let y = 0; y < header.height; y += 1) {
    const rowOffset = y * (rowBytes + 1) + 1;
    for (let x = 0; x < header.width; x += 1) {
      const target = (y * header.width + x) * 4;
      if (header.colorType === 0) {
        const grayRaw = pngSample(inflated, rowOffset, x, header.bitDepth);
        const gray = scalePngSample(grayRaw, header.bitDepth, maxSample);
        rgba[target] = gray;
        rgba[target + 1] = gray;
        rgba[target + 2] = gray;
        rgba[target + 3] = transparentGray !== null && grayRaw === transparentGray ? 0 : 255;
      } else if (header.colorType === 2) {
        const sample = x * 3;
        const redRaw = pngSample(inflated, rowOffset, sample, header.bitDepth);
        const greenRaw = pngSample(inflated, rowOffset, sample + 1, header.bitDepth);
        const blueRaw = pngSample(inflated, rowOffset, sample + 2, header.bitDepth);
        rgba[target] = scalePngSample(redRaw, header.bitDepth, maxSample);
        rgba[target + 1] = scalePngSample(greenRaw, header.bitDepth, maxSample);
        rgba[target + 2] = scalePngSample(blueRaw, header.bitDepth, maxSample);
        rgba[target + 3] = transparentRgb
          && redRaw === transparentRgb[0]
          && greenRaw === transparentRgb[1]
          && blueRaw === transparentRgb[2] ? 0 : 255;
      } else if (header.colorType === 3) {
        const paletteIndex = pngSample(inflated, rowOffset, x, header.bitDepth);
        const paletteOffset = paletteIndex * 3;
        if (!palette || paletteOffset + 2 >= palette.byteLength) throw new Error("PNG palette index is out of range");
        rgba[target] = palette[paletteOffset];
        rgba[target + 1] = palette[paletteOffset + 1];
        rgba[target + 2] = palette[paletteOffset + 2];
        rgba[target + 3] = transparency?.[paletteIndex] ?? 255;
      } else if (header.colorType === 4) {
        const sample = x * 2;
        const gray = scalePngSample(pngSample(inflated, rowOffset, sample, header.bitDepth), header.bitDepth, maxSample);
        rgba[target] = gray;
        rgba[target + 1] = gray;
        rgba[target + 2] = gray;
        rgba[target + 3] = scalePngSample(
          pngSample(inflated, rowOffset, sample + 1, header.bitDepth),
          header.bitDepth,
          maxSample,
        );
      } else {
        const sample = x * 4;
        rgba[target] = scalePngSample(pngSample(inflated, rowOffset, sample, header.bitDepth), header.bitDepth, maxSample);
        rgba[target + 1] = scalePngSample(pngSample(inflated, rowOffset, sample + 1, header.bitDepth), header.bitDepth, maxSample);
        rgba[target + 2] = scalePngSample(pngSample(inflated, rowOffset, sample + 2, header.bitDepth), header.bitDepth, maxSample);
        rgba[target + 3] = scalePngSample(pngSample(inflated, rowOffset, sample + 3, header.bitDepth), header.bitDepth, maxSample);
      }
    }
  }
  return { data: rgba, width: header.width, height: header.height, orientation: 1 };
}

function inflatePngData(chunks: readonly Uint8Array[], expectedBytes: number): Uint8Array {
  const output = new Uint8Array(expectedBytes);
  let written = 0;
  const inflator = new Unzlib((chunk) => {
    if (written + chunk.byteLength > expectedBytes) {
      throw new Error("PNG decompressed data exceeds the expected scanline size");
    }
    output.set(chunk, written);
    written += chunk.byteLength;
  });
  // Feeding bounded pieces limits both CPU and temporary output if a tiny PNG
  // header is paired with a maliciously high-ratio DEFLATE stream.
  const compressedSliceBytes = 1_024;
  for (const chunk of chunks) {
    for (let offset = 0; offset < chunk.byteLength; offset += compressedSliceBytes) {
      inflator.push(chunk.subarray(offset, Math.min(offset + compressedSliceBytes, chunk.byteLength)), false);
    }
  }
  inflator.push(new Uint8Array(), true);
  if (written !== expectedBytes) throw new Error("PNG decompressed data has an unexpected size");
  return output;
}

function decodeBmp(bytes: Uint8Array, dimensions: RasterDimensions): DecodedRaster {
  if (bytes.byteLength < 54) throw new Error("BMP header is incomplete");
  const pixelOffset = uint32le(bytes, 10);
  const dibSize = uint32le(bytes, 14);
  if (dibSize < 40 || pixelOffset < 14 + dibSize || pixelOffset > bytes.byteLength) {
    throw new Error("BMP header is unsupported");
  }
  const width = int32le(bytes, 18);
  const signedHeight = int32le(bytes, 22);
  const height = Math.abs(signedHeight);
  const planes = uint16le(bytes, 26);
  const bitsPerPixel = uint16le(bytes, 28);
  const compression = uint32le(bytes, 30);
  if (
    width !== dimensions.width
    || height !== dimensions.height
    || planes !== 1
    || (bitsPerPixel !== 24 && bitsPerPixel !== 32)
    || compression !== 0
  ) {
    throw new Error("BMP layout is unsupported");
  }
  const rowBytes = Math.ceil(width * bitsPerPixel / 32) * 4;
  const requiredBytes = pixelOffset + rowBytes * height;
  if (!Number.isSafeInteger(requiredBytes) || requiredBytes > bytes.byteLength) throw new Error("BMP pixel data is incomplete");
  const rgba = new Uint8Array(width * height * 4);
  const bytesPerPixel = bitsPerPixel / 8;
  for (let y = 0; y < height; y += 1) {
    const sourceY = signedHeight > 0 ? height - 1 - y : y;
    const sourceRow = pixelOffset + sourceY * rowBytes;
    for (let x = 0; x < width; x += 1) {
      const source = sourceRow + x * bytesPerPixel;
      const target = (y * width + x) * 4;
      rgba[target] = bytes[source + 2];
      rgba[target + 1] = bytes[source + 1];
      rgba[target + 2] = bytes[source];
      // BI_RGB 32-bit BMP commonly stores an unused zero byte, not alpha.
      rgba[target + 3] = 255;
    }
  }
  return { data: rgba, width, height, orientation: 1 };
}

function resizeAndComposite(
  source: DecodedRaster,
  targetWidth: number,
  targetHeight: number,
  orientation: number,
): DecodedRaster {
  const orientedWidth = swapsOrientationAxes(orientation) ? source.height : source.width;
  const orientedHeight = swapsOrientationAxes(orientation) ? source.width : source.height;
  const output = new Uint8Array(targetWidth * targetHeight * 4);

  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = Math.max(0, Math.min(orientedHeight - 1, (y + 0.5) * orientedHeight / targetHeight - 0.5));
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(orientedHeight - 1, y0 + 1);
    const yWeight = sourceY - y0;
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.max(0, Math.min(orientedWidth - 1, (x + 0.5) * orientedWidth / targetWidth - 0.5));
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(orientedWidth - 1, x0 + 1);
      const xWeight = sourceX - x0;
      const topLeftWeight = (1 - xWeight) * (1 - yWeight);
      const topRightWeight = xWeight * (1 - yWeight);
      const bottomLeftWeight = (1 - xWeight) * yWeight;
      const bottomRightWeight = xWeight * yWeight;
      const topLeft = orientedPixelOffset(x0, y0, source.width, source.height, orientation);
      const topRight = orientedPixelOffset(x1, y0, source.width, source.height, orientation);
      const bottomLeft = orientedPixelOffset(x0, y1, source.width, source.height, orientation);
      const bottomRight = orientedPixelOffset(x1, y1, source.width, source.height, orientation);
      const topLeftAlpha = source.data[topLeft + 3] * topLeftWeight;
      const topRightAlpha = source.data[topRight + 3] * topRightWeight;
      const bottomLeftAlpha = source.data[bottomLeft + 3] * bottomLeftWeight;
      const bottomRightAlpha = source.data[bottomRight + 3] * bottomRightWeight;
      const alpha = topLeftAlpha + topRightAlpha + bottomLeftAlpha + bottomRightAlpha;
      const premultipliedRed = source.data[topLeft] * topLeftAlpha
        + source.data[topRight] * topRightAlpha
        + source.data[bottomLeft] * bottomLeftAlpha
        + source.data[bottomRight] * bottomRightAlpha;
      const premultipliedGreen = source.data[topLeft + 1] * topLeftAlpha
        + source.data[topRight + 1] * topRightAlpha
        + source.data[bottomLeft + 1] * bottomLeftAlpha
        + source.data[bottomRight + 1] * bottomRightAlpha;
      const premultipliedBlue = source.data[topLeft + 2] * topLeftAlpha
        + source.data[topRight + 2] * topRightAlpha
        + source.data[bottomLeft + 2] * bottomLeftAlpha
        + source.data[bottomRight + 2] * bottomRightAlpha;
      const target = (y * targetWidth + x) * 4;
      output[target] = Math.round(premultipliedRed / 255 + 255 - alpha);
      output[target + 1] = Math.round(premultipliedGreen / 255 + 255 - alpha);
      output[target + 2] = Math.round(premultipliedBlue / 255 + 255 - alpha);
      output[target + 3] = 255;
    }
  }
  return { data: output, width: targetWidth, height: targetHeight, orientation: 1 };
}

function orientedPixelOffset(
  x: number,
  y: number,
  width: number,
  height: number,
  orientation: number,
): number {
  if (orientation === 2) return (y * width + width - 1 - x) * 4;
  if (orientation === 3) return ((height - 1 - y) * width + width - 1 - x) * 4;
  if (orientation === 4) return ((height - 1 - y) * width + x) * 4;
  if (orientation === 5) return (x * width + y) * 4;
  if (orientation === 6) return ((height - 1 - x) * width + y) * 4;
  if (orientation === 7) return ((height - 1 - x) * width + width - 1 - y) * 4;
  if (orientation === 8) return (x * width + width - 1 - y) * 4;
  return (y * width + x) * 4;
}

function swapsOrientationAxes(orientation: number): boolean {
  return orientation >= 5 && orientation <= 8;
}

function unfilterPngScanlines(data: Uint8Array, height: number, rowBytes: number, bytesPerPixel: number): void {
  for (let y = 0; y < height; y += 1) {
    const filterOffset = y * (rowBytes + 1);
    const filter = data[filterOffset];
    const rowOffset = filterOffset + 1;
    const previousRowOffset = rowOffset - rowBytes - 1;
    if (filter > 4) throw new Error("PNG scanline filter is invalid");
    for (let x = 0; x < rowBytes; x += 1) {
      const left = x >= bytesPerPixel ? data[rowOffset + x - bytesPerPixel] : 0;
      const up = y > 0 ? data[previousRowOffset + x] : 0;
      const upLeft = y > 0 && x >= bytesPerPixel ? data[previousRowOffset + x - bytesPerPixel] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else if (filter === 4) predictor = paethPredictor(left, up, upLeft);
      data[rowOffset + x] = (data[rowOffset + x] + predictor) & 0xff;
    }
  }
}

function paethPredictor(left: number, up: number, upLeft: number): number {
  const prediction = left + up - upLeft;
  const leftDistance = Math.abs(prediction - left);
  const upDistance = Math.abs(prediction - up);
  const upLeftDistance = Math.abs(prediction - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  return upDistance <= upLeftDistance ? up : upLeft;
}

function pngChannelCount(colorType: number): number {
  if (colorType === 0 || colorType === 3) return 1;
  if (colorType === 2) return 3;
  if (colorType === 4) return 2;
  if (colorType === 6) return 4;
  throw new Error("PNG color type is unsupported");
}

function validPngBitDepth(colorType: number, bitDepth: number): boolean {
  if (colorType === 0) return [1, 2, 4, 8, 16].includes(bitDepth);
  if (colorType === 3) return [1, 2, 4, 8].includes(bitDepth);
  return [2, 4, 6].includes(colorType) && [8, 16].includes(bitDepth);
}

function pngSample(data: Uint8Array, rowOffset: number, sampleIndex: number, bitDepth: number): number {
  if (bitDepth === 8) return data[rowOffset + sampleIndex];
  if (bitDepth === 16) return uint16be(data, rowOffset + sampleIndex * 2);
  const bitOffset = sampleIndex * bitDepth;
  const shift = 8 - bitDepth - (bitOffset % 8);
  return (data[rowOffset + Math.floor(bitOffset / 8)] >>> shift) & ((1 << bitDepth) - 1);
}

function scalePngSample(value: number, bitDepth: number, maxSample: number): number {
  if (bitDepth === 16) return value >>> 8;
  return bitDepth === 8 ? value : Math.round(value * 255 / maxSample);
}

function rasterDimensions(bytes: Uint8Array, mimeType: string): RasterDimensions | null {
  if (mimeType === "image/png") return pngDimensions(bytes);
  if (mimeType === "image/jpeg") return jpegDimensions(bytes);
  if (mimeType === "image/bmp") return bmpDimensions(bytes);
  return null;
}

function pngDimensions(bytes: Uint8Array): RasterDimensions | null {
  if (
    bytes.length < 24
    || bytes[0] !== 0x89
    || bytes[1] !== 0x50
    || bytes[2] !== 0x4e
    || bytes[3] !== 0x47
    || bytes[4] !== 0x0d
    || bytes[5] !== 0x0a
    || bytes[6] !== 0x1a
    || bytes[7] !== 0x0a
    || ascii(bytes, 12, 4) !== "IHDR"
  ) return null;
  return { width: uint32be(bytes, 16), height: uint32be(bytes, 20) };
}

function jpegDimensions(bytes: Uint8Array): RasterDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) return null;
    const segmentLength = uint16be(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (segmentLength < 7) return null;
      return {
        height: uint16be(bytes, offset + 3),
        width: uint16be(bytes, offset + 5),
      };
    }
    offset += segmentLength;
  }
  return null;
}

function jpegExifOrientation(bytes: Uint8Array): number {
  let offset = 2;
  while (offset + 4 <= bytes.byteLength) {
    if (bytes[offset] !== 0xff) return 1;
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) return 1;
    if (offset + 2 > bytes.byteLength) return 1;
    const segmentLength = uint16be(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) return 1;
    const dataOffset = offset + 2;
    const dataLength = segmentLength - 2;
    if (
      marker === 0xe1
      && dataLength >= 14
      && ascii(bytes, dataOffset, 6) === "Exif\u0000\u0000"
    ) {
      const tiffOffset = dataOffset + 6;
      const littleEndian = ascii(bytes, tiffOffset, 2) === "II";
      const bigEndian = ascii(bytes, tiffOffset, 2) === "MM";
      if (!littleEndian && !bigEndian) return 1;
      const read16 = (at: number) => littleEndian ? uint16le(bytes, at) : uint16be(bytes, at);
      const read32 = (at: number) => littleEndian ? uint32le(bytes, at) : uint32be(bytes, at);
      if (read16(tiffOffset + 2) !== 42) return 1;
      const ifdOffset = tiffOffset + read32(tiffOffset + 4);
      if (ifdOffset + 2 > offset + segmentLength) return 1;
      const entryCount = read16(ifdOffset);
      for (let index = 0; index < entryCount; index += 1) {
        const entry = ifdOffset + 2 + index * 12;
        if (entry + 12 > offset + segmentLength) return 1;
        if (read16(entry) === 0x0112 && read16(entry + 2) === 3 && read32(entry + 4) === 1) {
          const orientation = read16(entry + 8);
          return orientation >= 1 && orientation <= 8 ? orientation : 1;
        }
      }
    }
    offset += segmentLength;
  }
  return 1;
}

function bmpDimensions(bytes: Uint8Array): RasterDimensions | null {
  if (bytes.length < 26 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return null;
  const dibSize = uint32le(bytes, 14);
  if (dibSize === 12) {
    return { width: uint16le(bytes, 18), height: uint16le(bytes, 20) };
  }
  if (dibSize < 40 || bytes.byteLength < 26) return null;
  const width = int32le(bytes, 18);
  const height = Math.abs(int32le(bytes, 22));
  return { width, height };
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

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || offset + length > bytes.byteLength) return "";
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function uint16be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function uint16le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function uint32be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24)
    | (bytes[offset + 1] << 16)
    | (bytes[offset + 2] << 8)
    | bytes[offset + 3]) >>> 0;
}

function uint32le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)) >>> 0;
}

function int32le(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getInt32(0, true);
}
