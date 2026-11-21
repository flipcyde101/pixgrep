import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { OcrBackendName, OcrResult, OcrWord } from "../types.js";
import { readPngTextChunks } from "./png.js";

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_SIDECAR_BYTES = 4 * 1024 * 1024;

const WINRT_OCR_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
[void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
[void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
[void][Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await-WinRT($op, $resultType) {
  $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($op))
  $task.Wait() | Out-Null
  return $task.Result
}
$imgPath = $env:PIXGREP_IMAGE_PATH
$file = Await-WinRT ([Windows.Storage.StorageFile]::GetFileFromPathAsync($imgPath)) ([Windows.Storage.StorageFile])
$stream = Await-WinRT ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await-WinRT ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await-WinRT ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('en-US')) }
if (-not $engine) { throw 'No Windows WinRT OCR language pack available' }
$ocr = Await-WinRT ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$words = @()
foreach ($line in $ocr.Lines) {
  foreach ($w in $line.Words) {
    $words += @{ text = $w.Text; x = [math]::Max(0, [int][math]::Round($w.BoundingRect.X)); y = [math]::Max(0, [int][math]::Round($w.BoundingRect.Y)); w = [math]::Max(1, [int][math]::Round($w.BoundingRect.Width)); h = [math]::Max(1, [int][math]::Round($w.BoundingRect.Height)) }
  }
}
$out = @{ width = $bitmap.PixelWidth; height = $bitmap.PixelHeight; fullText = $ocr.Text; words = $words }
$out | ConvertTo-Json -Depth 4 -Compress
`;

const MACOS_VISION_SWIFT = `
import Foundation
import Vision
import AppKit

guard let path = ProcessInfo.processInfo.environment["PIXGREP_IMAGE_PATH"], !path.isEmpty else { exit(1) }
guard let img = NSImage(contentsOfFile: path),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { exit(2) }
let width = cg.width
let height = cg.height
let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
let handler = VNImageRequestHandler(cgImage: cg, options: [:])
try handler.perform([req])
var words: [[String: Any]] = []
var lines: [String] = []
for obs in req.results ?? [] {
  guard let cand = obs.topCandidates(1).first else { continue }
  let lineText = cand.string
  lines.append(lineText)
  var idx = lineText.startIndex
  while idx < lineText.endIndex {
    while idx < lineText.endIndex && lineText[idx].isWhitespace { idx = lineText.index(after: idx) }
    let start = idx
    while idx < lineText.endIndex && !lineText[idx].isWhitespace { idx = lineText.index(after: idx) }
    if start < idx {
      let token = String(lineText[start..<idx])
      let rectObs = try? cand.boundingBox(for: start..<idx)
      let box = rectObs?.boundingBox ?? obs.boundingBox
      let x = max(0, Int(box.origin.x * Double(width)))
      let y = max(0, Int((1.0 - box.origin.y - box.size.height) * Double(height)))
      let w = max(1, Int(box.size.width * Double(width)))
      let h = max(1, Int(box.size.height * Double(height)))
      words.append(["text": token, "x": x, "y": y, "w": w, "h": h])
    }
  }
}
let payload: [String: Any] = ["width": width, "height": height, "fullText": lines.joined(separator: "\\n"), "words": words]
let data = try JSONSerialization.data(withJSONObject: payload, options: [])
FileHandle.standardOutput.write(data)
`;

function sanitizeWords(raw: unknown): OcrWord[] {
  if (!Array.isArray(raw)) return [];
  const out: OcrWord[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.text !== "string" || !rec.text.trim()) continue;
    const x = Number(rec.x);
    const y = Number(rec.y);
    const w = Number(rec.w);
    const h = Number(rec.h);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) continue;
    out.push({
      text: rec.text.trim(),
      x: Math.max(0, Math.round(x)),
      y: Math.max(0, Math.round(y)),
      w: Math.max(1, Math.round(w)),
      h: Math.max(1, Math.round(h)),
      confidence: typeof rec.confidence === "number" && Number.isFinite(rec.confidence) ? rec.confidence : undefined,
    });
  }
  return out;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => {
      const code = Number(n);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    });
}

function parseSvgDimensions(svg: string): { width: number; height: number } {
  const openTagEnd = svg.indexOf(">", svg.toLowerCase().indexOf("<svg"));
  const header = openTagEnd !== -1 ? svg.slice(0, openTagEnd + 1) : svg.slice(0, 512);
  const wMatch = /\bwidth=["'](\d+(?:\.\d+)?)/i.exec(header);
  const hMatch = /\bheight=["'](\d+(?:\.\d+)?)/i.exec(header);
  if (wMatch && hMatch) {
    return { width: Math.round(Number(wMatch[1])), height: Math.round(Number(hMatch[1])) };
  }
  const vbMatch = /\bviewBox=["']\s*-?\d+(?:\.\d+)?[\s,]+-?\d+(?:\.\d+)?[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)\s*["']/i.exec(header);
  if (vbMatch) {
    return { width: Math.round(Number(vbMatch[1])), height: Math.round(Number(vbMatch[2])) };
  }
  return { width: 1280, height: 720 };
}

/**
 * Linear-time SVG `<text>...</text>` scanner (immune to quadratic ReDoS on unclosed tags).
 */
function extractSvgTextWords(svg: string): OcrWord[] {
  const words: OcrWord[] = [];
  const lower = svg.toLowerCase();
  let pos = 0;

  while (pos < svg.length) {
    const start = lower.indexOf("<text", pos);
    if (start === -1) break;
    const afterTag = lower[start + 5] ?? "";
    if (afterTag !== ">" && afterTag !== " " && afterTag !== "\t" && afterTag !== "\n" && afterTag !== "\r" && afterTag !== "/") {
      pos = start + 5;
      continue;
    }
    const openEnd = svg.indexOf(">", start + 5);
    if (openEnd === -1) break;
    if (svg[openEnd - 1] === "/") {
      pos = openEnd + 1;
      continue;
    }
    const closeStart = lower.indexOf("</text>", openEnd + 1);
    if (closeStart === -1) break;

    const attrs = svg.slice(start + 5, openEnd);
    const inner = svg.slice(openEnd + 1, closeStart);
    pos = closeStart + 7;

    const plain = decodeXmlEntities(inner.replace(/<[^>]+>/g, " "))
      .replace(/\s+/g, " ")
      .trim();
    if (!plain) continue;

    const xm = /\bx=["'](\d+(?:\.\d+)?)/i.exec(attrs);
    const ym = /\by=["'](\d+(?:\.\d+)?)/i.exec(attrs);
    const baseX = xm ? Math.round(Number(xm[1])) : 20;
    const baseY = ym ? Math.round(Number(ym[1])) : 20;
    let offsetX = baseX;
    for (const tok of plain.split(/\s+/)) {
      const estW = Math.max(12, tok.length * 10);
      words.push({ text: tok, x: offsetX, y: Math.max(0, baseY - 16), w: estW, h: 20 });
      offsetX += estW + 8;
    }
  }

  return words;
}

export function parseTesseractTsv(tsv: string): { width: number; height: number; fullText: string; words: OcrWord[] } {
  const words: OcrWord[] = [];
  let width = 0;
  let height = 0;
  for (const rawLine of tsv.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    const cols = rawLine.split("\t");
    if (cols.length < 12 || cols[0] === "level") continue;
    const level = Number(cols[0]);
    const left = Number(cols[6]);
    const top = Number(cols[7]);
    const w = Number(cols[8]);
    const h = Number(cols[9]);
    const conf = Number(cols[10]);
    const text = cols.slice(11).join("\t").trim();
    if (!Number.isFinite(level) || !Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(w) || !Number.isFinite(h)) {
      continue;
    }
    if (level === 1 && w > 0 && h > 0) {
      width = Math.round(w);
      height = Math.round(h);
    } else if (level === 5 && text) {
      words.push({
        text,
        x: Math.max(0, Math.round(left)),
        y: Math.max(0, Math.round(top)),
        w: Math.max(1, Math.round(w)),
        h: Math.max(1, Math.round(h)),
        confidence: Number.isFinite(conf) ? conf : undefined,
      });
    }
  }
  return {
    width,
    height,
    fullText: words.map((w) => w.text).join(" "),
    words,
  };
}

export function extractBuiltinOcr(filePath: string): OcrResult | null {
  const sidecarPath = `${filePath}.ocr.json`;
  if (existsSync(sidecarPath)) {
    try {
      if (statSync(sidecarPath).size <= MAX_SIDECAR_BYTES) {
        const parsed = JSON.parse(readFileSync(sidecarPath, "utf8")) as {
          width?: number;
          height?: number;
          fullText?: string;
          words?: unknown;
        };
        const words = sanitizeWords(parsed.words);
        return {
          backend: "builtin",
          width: typeof parsed.width === "number" && Number.isFinite(parsed.width) ? parsed.width : 0,
          height: typeof parsed.height === "number" && Number.isFinite(parsed.height) ? parsed.height : 0,
          fullText: typeof parsed.fullText === "string" ? parsed.fullText : words.map((w) => w.text).join(" "),
          words,
        };
      }
    } catch {
      // fall through
    }
  }

  const lower = filePath.toLowerCase();
  if (!lower.endsWith(".svg") && !lower.endsWith(".png")) {
    return null;
  }

  try {
    if (statSync(filePath).size > MAX_IMAGE_BYTES) return null;
  } catch {
    return null;
  }

  const buf = readFileSync(filePath);

  if (lower.endsWith(".svg")) {
    const svg = buf.toString("utf8");
    const { width, height } = parseSvgDimensions(svg);
    const words = extractSvgTextWords(svg);
    return {
      backend: "builtin",
      width,
      height,
      fullText: words.map((w) => w.text).join(" "),
      words,
    };
  }

  if (lower.endsWith(".png")) {
    const meta = readPngTextChunks(buf);
    if (meta) {
      if (meta.textChunks["pixgrep_ocr"]) {
        try {
          const parsed = JSON.parse(meta.textChunks["pixgrep_ocr"]) as { words?: unknown; fullText?: string };
          const words = sanitizeWords(parsed.words);
          return {
            backend: "builtin",
            width: meta.width,
            height: meta.height,
            fullText: typeof parsed.fullText === "string" ? parsed.fullText : words.map((w) => w.text).join(" "),
            words,
          };
        } catch {
          // fall through
        }
      }
      const fallbackText = meta.textChunks["Comment"] ?? meta.textChunks["Description"];
      if (fallbackText && fallbackText.trim()) {
        const words: OcrWord[] = fallbackText
          .trim()
          .split(/\s+/)
          .map((tok, i) => ({ text: tok, x: 10 + i * 24, y: 10, w: Math.max(10, tok.length * 8), h: 16 }));
        return {
          backend: "builtin",
          width: meta.width,
          height: meta.height,
          fullText: fallbackText.trim(),
          words,
        };
      }
    }
  }

  return null;
}

export function runWinRtOcr(filePath: string): OcrResult {
  const absPath = resolve(filePath);
  const stdout = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", WINRT_OCR_SCRIPT], {
    env: { ...process.env, PIXGREP_IMAGE_PATH: absPath },
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (!stdout) throw new Error("WinRT OCR returned empty output");
  const parsed = JSON.parse(stdout) as {
    width?: number;
    height?: number;
    fullText?: string;
    words?: unknown;
  };
  return {
    backend: "winrt",
    width: typeof parsed.width === "number" ? parsed.width : 0,
    height: typeof parsed.height === "number" ? parsed.height : 0,
    fullText: typeof parsed.fullText === "string" ? parsed.fullText : "",
    words: sanitizeWords(parsed.words),
  };
}

export function runMacVisionOcr(filePath: string): OcrResult {
  const absPath = resolve(filePath);
  const stdout = execFileSync("swift", ["-"], {
    input: MACOS_VISION_SWIFT,
    env: { ...process.env, PIXGREP_IMAGE_PATH: absPath },
    encoding: "utf8",
    timeout: 25_000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
  if (!stdout) throw new Error("macOS Vision OCR returned empty output");
  const parsed = JSON.parse(stdout) as {
    width?: number;
    height?: number;
    fullText?: string;
    words?: unknown;
  };
  return {
    backend: "vision",
    width: typeof parsed.width === "number" ? parsed.width : 0,
    height: typeof parsed.height === "number" ? parsed.height : 0,
    fullText: typeof parsed.fullText === "string" ? parsed.fullText : "",
    words: sanitizeWords(parsed.words),
  };
}

export function runTesseractOcr(filePath: string): OcrResult {
  const absPath = resolve(filePath);
  const stdout = execFileSync("tesseract", [absPath, "stdout", "tsv"], {
    encoding: "utf8",
    timeout: 25_000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const parsed = parseTesseractTsv(stdout);
  return {
    backend: "tesseract",
    ...parsed,
  };
}

export function extractTextFromImage(filePath: string, backend: OcrBackendName = "auto"): OcrResult {
  if (backend === "builtin") {
    return (
      extractBuiltinOcr(filePath) ?? {
        backend: "builtin",
        width: 0,
        height: 0,
        fullText: "",
        words: [],
      }
    );
  }
  if (backend === "winrt") return runWinRtOcr(filePath);
  if (backend === "vision") return runMacVisionOcr(filePath);
  if (backend === "tesseract") return runTesseractOcr(filePath);

  const builtin = extractBuiltinOcr(filePath);
  if (builtin && builtin.fullText.trim().length > 0) return builtin;

  const attempts: Array<() => OcrResult> = [];
  if (process.platform === "win32") {
    attempts.push(() => runWinRtOcr(filePath), () => runTesseractOcr(filePath));
  } else if (process.platform === "darwin") {
    attempts.push(() => runMacVisionOcr(filePath), () => runTesseractOcr(filePath));
  } else {
    attempts.push(() => runTesseractOcr(filePath));
  }

  for (const run of attempts) {
    try {
      return run();
    } catch {
      // try next available backend
    }
  }

  return builtin ?? { backend: "builtin", width: 0, height: 0, fullText: "", words: [] };
}
