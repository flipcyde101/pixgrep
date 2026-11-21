import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PixgrepIndex } from "../db/index.js";
import { encodeRgbPng } from "../ocr/png.js";
import { renderImagePreview } from "../preview/terminal.js";
import type { IndexStats, OcrWord, PreviewProtocol, SearchHit } from "../types.js";

function drawRect(
  rgb: Uint8Array,
  imgW: number,
  imgH: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
  color: [number, number, number]
): void {
  const xEnd = Math.min(imgW, x0 + w);
  const yEnd = Math.min(imgH, y0 + h);
  for (let y = Math.max(0, y0); y < yEnd; y++) {
    for (let x = Math.max(0, x0); x < xEnd; x++) {
      const idx = (y * imgW + x) * 3;
      rgb[idx] = color[0];
      rgb[idx + 1] = color[1];
      rgb[idx + 2] = color[2];
    }
  }
}

function makeScreenshotPng(
  accent: [number, number, number],
  fullText: string,
  words: OcrWord[]
): Buffer {
  const w = 160;
  const h = 96;
  const rgb = new Uint8Array(w * h * 3);
  // Dark terminal/browser window background
  drawRect(rgb, w, h, 0, 0, w, h, [13, 17, 23]);
  // Title bar
  drawRect(rgb, w, h, 0, 0, w, 14, [22, 27, 34]);
  // Window card
  drawRect(rgb, w, h, 10, 20, w - 20, h - 30, [24, 32, 46]);
  // Accent banner inside card
  drawRect(rgb, w, h, 16, 26, w - 32, 14, accent);
  // Simulated text lines where OCR words sit
  for (const word of words) {
    drawRect(rgb, w, h, word.x, word.y, word.w, word.h, [210, 224, 240]);
  }
  return encodeRgbPng(w, h, rgb, {
    pixgrep_ocr: JSON.stringify({ fullText, words }),
  });
}

export interface DemoRunOutput {
  query: string;
  stats: IndexStats;
  hits: SearchHit[];
  preview?: string;
}

export function runPixgrepDemo(opts: { query?: string; preview?: boolean; protocol?: PreviewProtocol } = {}): DemoRunOutput {
  const dir = mkdtempSync(join(tmpdir(), "pixgrep-demo-"));
  const query = opts.query?.trim() || "ERR_CERT";
  const index = new PixgrepIndex(":memory:");

  try {
    const files: Array<{ name: string; accent: [number, number, number]; text: string; words: OcrWord[] }> = [
      {
        name: "Screenshot-2026-11-18-ERR_CERT.png",
        accent: [220, 56, 72],
        text: "Chrome TLS Failure ERR_CERT_AUTHORITY_INVALID on api.staging.internal:443",
        words: [
          { text: "Chrome", x: 18, y: 46, w: 28, h: 8 },
          { text: "TLS", x: 50, y: 46, w: 16, h: 8 },
          { text: "ERR_CERT_AUTHORITY_INVALID", x: 18, y: 60, w: 96, h: 10 },
          { text: "api.staging.internal:443", x: 18, y: 74, w: 86, h: 8 },
        ],
      },
      {
        name: "Invoice-AWS-Oct2026.png",
        accent: [46, 160, 67],
        text: "AWS Invoice INV-2026-1042 Total Due $412.80 us-east-1 NAT Gateway",
        words: [
          { text: "Invoice", x: 18, y: 46, w: 34, h: 8 },
          { text: "INV-2026-1042", x: 56, y: 46, w: 58, h: 8 },
          { text: "$412.80", x: 18, y: 62, w: 34, h: 10 },
        ],
      },
      {
        name: "StackTrace-Postgres-Pool.png",
        accent: [210, 153, 34],
        text: "FATAL: remaining connection slots reserved for superuser pg_pool_exhausted",
        words: [
          { text: "FATAL:", x: 18, y: 46, w: 28, h: 8 },
          { text: "pg_pool_exhausted", x: 18, y: 62, w: 74, h: 10 },
        ],
      },
      {
        name: "Receipt-Flight-SFO.png",
        accent: [56, 139, 253],
        text: "Boarding Pass SFO to DEN Confirmation X9K4P2 Seat 14A",
        words: [
          { text: "SFO", x: 18, y: 46, w: 18, h: 8 },
          { text: "X9K4P2", x: 42, y: 46, w: 32, h: 8 },
        ],
      },
    ];

    for (const f of files) {
      writeFileSync(join(dir, f.name), makeScreenshotPng(f.accent, f.text, f.words));
    }

    const stats = index.indexDirectory(dir, "builtin");
    const hits = index.search(query, { dir });
    const preview =
      opts.preview && hits.length > 0
        ? renderImagePreview(hits[0].filePath, {
            cols: 44,
            protocol: opts.protocol ?? "halfblock",
            highlightWords: hits[0].matchedWords,
          })
        : undefined;

    return { query, stats, hits, preview };
  } finally {
    index.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
