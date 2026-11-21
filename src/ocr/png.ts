import { deflateSync, inflateSync } from "node:zlib";

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_DIMENSION = 4096;
const MAX_DECODED_BYTES = 64 * 1024 * 1024;

export interface DecodedPng {
  width: number;
  height: number;
  /** Tightly packed RGBA bytes (width * height * 4) */
  rgba: Uint8Array;
  textChunks: Record<string, string>;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Pure-TS zero-dependency PNG decoder supporting 8-bit non-interlaced Grayscale (0),
 * Truecolor RGB (2), Grayscale+Alpha (4), and RGBA (6), plus `tEXt` metadata extraction.
 */
export function decodePng(buf: Buffer): DecodedPng {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error("Invalid PNG signature");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatChunks: Buffer[] = [];
  const textChunks: Record<string, string> = {};

  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buf.length) break;
    const data = buf.subarray(dataStart, dataEnd);
    offset = dataEnd + 4;

    if (type === "IHDR") {
      if (length < 13) throw new Error("Invalid PNG IHDR chunk");
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
      if (width <= 0 || height <= 0 || width > MAX_DIMENSION || height > MAX_DIMENSION) {
        throw new Error(`Unsupported PNG dimensions ${width}x${height}`);
      }
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "tEXt") {
      const nul = data.indexOf(0);
      if (nul > 0) {
        const key = data.subarray(0, nul).toString("latin1");
        const val = data.subarray(nul + 1).toString("utf8");
        textChunks[key] = val;
      }
    } else if (type === "IEND") {
      break;
    }
  }

  if (width === 0 || height === 0) throw new Error("Missing PNG IHDR chunk");
  if (bitDepth !== 8 || interlace !== 0) {
    throw new Error(`Unsupported PNG format (bitDepth=${bitDepth}, interlace=${interlace})`);
  }

  const channels =
    colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (channels === 0) {
    throw new Error(`Unsupported PNG colorType=${colorType}`);
  }

  const bpp = channels;
  const stride = width * bpp;
  const expectedRawLen = height * (1 + stride);
  if (expectedRawLen > MAX_DECODED_BYTES) {
    throw new Error("PNG image exceeds maximum decoded buffer size");
  }

  const raw = inflateSync(Buffer.concat(idatChunks), { maxOutputLength: MAX_DECODED_BYTES });
  if (raw.length < expectedRawLen) {
    throw new Error("Truncated PNG IDAT stream");
  }

  const recon = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const rowIn = y * (stride + 1) + 1;
    const rowOut = y * stride;
    const prevOut = (y - 1) * stride;

    for (let x = 0; x < stride; x++) {
      const v = raw[rowIn + x];
      const left = x >= bpp ? recon[rowOut + x - bpp] : 0;
      const up = y > 0 ? recon[prevOut + x] : 0;
      const upLeft = x >= bpp && y > 0 ? recon[prevOut + x - bpp] : 0;

      let outByte = v;
      if (filter === 1) outByte = (v + left) & 0xff;
      else if (filter === 2) outByte = (v + up) & 0xff;
      else if (filter === 3) outByte = (v + ((left + up) >>> 1)) & 0xff;
      else if (filter === 4) outByte = (v + paethPredictor(left, up, upLeft)) & 0xff;
      recon[rowOut + x] = outByte;
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, p = 0; i < width * height; i++) {
    if (colorType === 6) {
      rgba[i * 4] = recon[p++];
      rgba[i * 4 + 1] = recon[p++];
      rgba[i * 4 + 2] = recon[p++];
      rgba[i * 4 + 3] = recon[p++];
    } else if (colorType === 2) {
      rgba[i * 4] = recon[p++];
      rgba[i * 4 + 1] = recon[p++];
      rgba[i * 4 + 2] = recon[p++];
      rgba[i * 4 + 3] = 255;
    } else if (colorType === 0) {
      const g = recon[p++];
      rgba[i * 4] = g;
      rgba[i * 4 + 1] = g;
      rgba[i * 4 + 2] = g;
      rgba[i * 4 + 3] = 255;
    } else {
      const g = recon[p++];
      const a = recon[p++];
      rgba[i * 4] = g;
      rgba[i * 4 + 1] = g;
      rgba[i * 4 + 2] = g;
      rgba[i * 4 + 3] = a;
    }
  }

  return { width, height, rgba, textChunks };
}

export function readPngTextChunks(buf: Buffer): { width: number; height: number; textChunks: Record<string, string> } | null {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
  let offset = 8;
  let width = 0;
  let height = 0;
  const textChunks: Record<string, string> = {};
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buf.length) break;
    const data = buf.subarray(dataStart, dataEnd);
    offset = dataEnd + 4;
    if (type === "IHDR" && length >= 8) {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    } else if (type === "tEXt") {
      const nul = data.indexOf(0);
      if (nul > 0) {
        textChunks[data.subarray(0, nul).toString("latin1")] = data.subarray(nul + 1).toString("utf8");
      }
    } else if (type === "IEND") {
      break;
    }
  }
  return width > 0 && height > 0 ? { width, height, textChunks } : null;
}

function makePngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/**
 * Pure-TS zero-dependency RGB PNG encoder with optional `tEXt` metadata chunks.
 */
export function encodeRgbPng(
  width: number,
  height: number,
  rgb: Uint8Array,
  textChunks: Record<string, string> = {}
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 3;
  const raw = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + stride)] = 0; // filter None
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (1 + stride) + 1);
  }
  const compressed = deflateSync(raw);

  const chunks: Buffer[] = [PNG_SIG, makePngChunk("IHDR", ihdr)];
  for (const [k, v] of Object.entries(textChunks)) {
    chunks.push(makePngChunk("tEXt", Buffer.concat([Buffer.from(k, "latin1"), Buffer.from([0]), Buffer.from(v, "utf8")])));
  }
  chunks.push(makePngChunk("IDAT", compressed), makePngChunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(chunks);
}
