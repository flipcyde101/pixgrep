import { readFileSync, statSync } from "node:fs";
import { decodePng, encodeRgbPng, PNG_SIG } from "../ocr/png.js";
import type { OcrWord, PreviewProtocol } from "../types.js";

const NEON_GREEN: [number, number, number] = [57, 255, 20];
const MAX_PREVIEW_BYTES = 16 * 1024 * 1024;
const MAX_KITTY_BYTES = 6 * 1024 * 1024;

export interface RenderPreviewOptions {
  cols?: number;
  rows?: number;
  protocol?: PreviewProtocol;
  highlightWords?: OcrWord[];
}

function isOnHighlightBorder(
  px: number,
  py: number,
  imgW: number,
  imgH: number,
  scaleX: number,
  scaleY: number,
  boxes: OcrWord[]
): boolean {
  const padX = Math.max(2, Math.round(scaleX * 1.2));
  const padY = Math.max(2, Math.round(scaleY * 1.2));
  for (const b of boxes) {
    const x0 = Math.max(0, b.x - padX);
    const y0 = Math.max(0, b.y - padY);
    const x1 = Math.min(imgW - 1, b.x + b.w + padX);
    const y1 = Math.min(imgH - 1, b.y + b.h + padY);
    const inOuter = px >= x0 && px <= x1 && py >= y0 && py <= y1;
    if (!inOuter) continue;
    const inInner = px > x0 + padX && px < x1 - padX && py > y0 + padY && py < y1 - padY;
    if (!inInner) return true;
  }
  return false;
}

/**
 * Renders a PNG buffer to ANSI truecolor Unicode half-block characters (`▀`) with
 * neon-green (`#39ff14`) bounding boxes drawn directly around matched OCR words.
 */
export function renderPngHalfBlockPreview(
  pngBuf: Buffer,
  opts: RenderPreviewOptions = {}
): string {
  const img = decodePng(pngBuf);
  const cols = Math.max(16, Math.min(120, opts.cols ?? 48));
  const aspect = img.height / Math.max(1, img.width);
  const rows = Math.max(8, Math.min(40, opts.rows ?? Math.round(cols * aspect * 0.5)));
  const pixelRows = rows * 2;
  const boxes = opts.highlightWords ?? [];
  const scaleX = img.width / cols;
  const scaleY = img.height / pixelRows;

  const sample = (cx: number, cy: number): [number, number, number] => {
    const px = Math.min(img.width - 1, Math.floor(cx * scaleX));
    const py = Math.min(img.height - 1, Math.floor(cy * scaleY));
    if (boxes.length > 0 && isOnHighlightBorder(px, py, img.width, img.height, scaleX, scaleY, boxes)) {
      return NEON_GREEN;
    }
    const idx = (py * img.width + px) * 4;
    const a = img.rgba[idx + 3] / 255;
    const bg = 13; // dark terminal canvas composite
    return [
      Math.round(img.rgba[idx] * a + bg * (1 - a)),
      Math.round(img.rgba[idx + 1] * a + bg * (1 - a)),
      Math.round(img.rgba[idx + 2] * a + bg * (1 - a)),
    ];
  };

  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    let line = "";
    for (let c = 0; c < cols; c++) {
      const [tr, tg, tb] = sample(c, r * 2);
      const [br, bg, bb] = sample(c, r * 2 + 1);
      line += `\x1b[38;2;${tr};${tg};${tb}m\x1b[48;2;${br};${bg};${bb}m▀`;
    }
    lines.push(`${line}\x1b[0m`);
  }
  return lines.join("\n");
}

function overlayBoxesOnPng(pngBuf: Buffer, boxes: OcrWord[]): Buffer {
  if (boxes.length === 0) return pngBuf;
  try {
    const img = decodePng(pngBuf);
    const rgb = new Uint8Array(img.width * img.height * 3);
    for (let i = 0; i < img.width * img.height; i++) {
      const a = img.rgba[i * 4 + 3] / 255;
      rgb[i * 3] = Math.round(img.rgba[i * 4] * a + 13 * (1 - a));
      rgb[i * 3 + 1] = Math.round(img.rgba[i * 4 + 1] * a + 13 * (1 - a));
      rgb[i * 3 + 2] = Math.round(img.rgba[i * 4 + 2] * a + 13 * (1 - a));
    }
    const thickness = Math.max(2, Math.round(Math.min(img.width, img.height) * 0.01));
    for (const b of boxes) {
      const x0 = Math.max(0, b.x - thickness);
      const y0 = Math.max(0, b.y - thickness);
      const x1 = Math.min(img.width - 1, b.x + b.w + thickness);
      const y1 = Math.min(img.height - 1, b.y + b.h + thickness);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const onEdge = x < x0 + thickness || x > x1 - thickness || y < y0 + thickness || y > y1 - thickness;
          if (!onEdge) continue;
          const idx = (y * img.width + x) * 3;
          rgb[idx] = NEON_GREEN[0];
          rgb[idx + 1] = NEON_GREEN[1];
          rgb[idx + 2] = NEON_GREEN[2];
        }
      }
    }
    return encodeRgbPng(img.width, img.height, rgb);
  } catch {
    return pngBuf;
  }
}

/**
 * Emits a Kitty Graphics Protocol escape sequence for a validated PNG buffer (chunked 4096 B).
 */
export function renderPngKittyPreview(pngBuf: Buffer, cols = 48, highlightWords: OcrWord[] = []): string {
  if (pngBuf.length < 8 || !pngBuf.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error("Kitty preview requires a valid PNG image");
  }
  if (pngBuf.length > MAX_KITTY_BYTES) {
    throw new Error(`PNG exceeds Kitty preview size limit (${MAX_KITTY_BYTES} bytes)`);
  }
  const safeCols = Math.max(16, Math.min(120, Math.round(cols)));
  const finalBuf = overlayBoxesOnPng(pngBuf, highlightWords);
  const b64 = finalBuf.toString("base64");
  const chunkSize = 4096;
  const parts: string[] = [];
  for (let i = 0; i < b64.length; i += chunkSize) {
    const chunk = b64.slice(i, i + chunkSize);
    const more = i + chunkSize < b64.length ? 1 : 0;
    const header = i === 0 ? `a=T,f=100,c=${safeCols},m=${more}` : `m=${more}`;
    parts.push(`\x1b_G${header};${chunk}\x1b\\`);
  }
  return parts.join("");
}

export function renderImagePreview(filePath: string, opts: RenderPreviewOptions = {}): string {
  const protocol = opts.protocol ?? "halfblock";
  if (!filePath.toLowerCase().endsWith(".png")) {
    return `[preview available for PNG files; matched ${opts.highlightWords?.length ?? 0} word(s) in ${filePath}]`;
  }
  try {
    const st = statSync(filePath);
    if (st.size > MAX_PREVIEW_BYTES) {
      return `[preview unavailable: PNG exceeds 16 MB limit (${filePath})]`;
    }
    const buf = readFileSync(filePath);
    if (protocol === "kitty") {
      return renderPngKittyPreview(buf, opts.cols ?? 48, opts.highlightWords ?? []);
    }
    return renderPngHalfBlockPreview(buf, opts);
  } catch (err) {
    return `[preview unavailable for ${filePath}: ${(err as Error).message}]`;
  }
}
