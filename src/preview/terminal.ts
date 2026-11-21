import { readFileSync } from "node:fs";
import { decodePng } from "../ocr/png.js";
import type { OcrWord, PreviewProtocol } from "../types.js";

const NEON_GREEN: [number, number, number] = [57, 255, 20];

export interface RenderPreviewOptions {
  cols?: number;
  rows?: number;
  protocol?: PreviewProtocol;
  highlightWords?: OcrWord[];
}

function isOnHighlightBorder(
  px: number,
  py: number,
  scaleX: number,
  scaleY: number,
  boxes: OcrWord[]
): boolean {
  const padX = Math.max(2, Math.round(scaleX * 1.2));
  const padY = Math.max(2, Math.round(scaleY * 1.2));
  for (const b of boxes) {
    const x0 = b.x - padX;
    const y0 = b.y - padY;
    const x1 = b.x + b.w + padX;
    const y1 = b.y + b.h + padY;
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
    if (boxes.length > 0 && isOnHighlightBorder(px, py, scaleX, scaleY, boxes)) {
      return NEON_GREEN;
    }
    const idx = (py * img.width + px) * 4;
    return [img.rgba[idx], img.rgba[idx + 1], img.rgba[idx + 2]];
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

/**
 * Emits a Kitty Graphics Protocol escape sequence for a PNG buffer (chunked 4096 B).
 */
export function renderPngKittyPreview(pngBuf: Buffer, cols = 48): string {
  const b64 = pngBuf.toString("base64");
  const chunkSize = 4096;
  const parts: string[] = [];
  for (let i = 0; i < b64.length; i += chunkSize) {
    const chunk = b64.slice(i, i + chunkSize);
    const more = i + chunkSize < b64.length ? 1 : 0;
    const header = i === 0 ? `a=T,f=100,c=${cols},m=${more}` : `m=${more}`;
    parts.push(`\x1b_G${header};${chunk}\x1b\\`);
  }
  return parts.join("");
}

export function renderImagePreview(filePath: string, opts: RenderPreviewOptions = {}): string {
  const buf = readFileSync(filePath);
  const protocol = opts.protocol ?? "halfblock";
  if (filePath.toLowerCase().endsWith(".png")) {
    if (protocol === "kitty") {
      return renderPngKittyPreview(buf, opts.cols ?? 48);
    }
    return renderPngHalfBlockPreview(buf, opts);
  }
  return `[preview available for PNG files; matched ${opts.highlightWords?.length ?? 0} word(s) in ${filePath}]`;
}
