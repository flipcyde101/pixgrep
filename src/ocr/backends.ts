import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { OcrBackendName, OcrResult, OcrWord } from "../types.js";
import { readPngTextChunks } from "./png.js";

const WINRT_OCR_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
[void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
[void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
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
$ocr = Await-WinRT ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$words = @()
foreach ($line in $ocr.Lines) {
  foreach ($w in $line.Words) {
    $words += @{ text = $w.Text; x = [math]::Round($w.BoundingRect.X); y = [math]::Round($w.BoundingRect.Y); w = [math]::Round($w.BoundingRect.Width); h = [math]::Round($w.BoundingRect.Height) }
  }
}
$out = @{ width = $bitmap.PixelWidth; height = $bitmap.PixelHeight; fullText = $ocr.Text; words = $words }
$out | ConvertTo-Json -Depth 4 -Compress
`;

const MACOS_VISION_SWIFT = `
import Foundation
import Vision
import AppKit

guard CommandLine.arguments.count >= 2 else { exit(1) }
let path = CommandLine.arguments[1]
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
  lines.append(cand.string)
  let box = obs.boundingBox
  let x = Int(box.origin.x * Double(width))
  let y = Int((1.0 - box.origin.y - box.size.height) * Double(height))
  let w = max(1, Int(box.size.width * Double(width)))
  let h = max(1, Int(box.size.height * Double(height)))
  words.append(["text": cand.string, "x": x, "y": y, "w": w, "h": h])
}
let payload: [String: Any] = ["width": width, "height": height, "fullText": lines.joined(separator: "\\n"), "words": words]
let data = try JSONSerialization.data(withJSONObject: payload, options: [])
FileHandle.standardOutput.write(data)
`;

export function parseTesseractTsv(tsv: string): { width: number; height: number; fullText: string; words: OcrWord[] } {
  const words: OcrWord[] = [];
  let width = 0;
  let height = 0;
  for (const rawLine of tsv.split(/\r?\n/).slice(1)) {
    const cols = rawLine.split("\t");
    if (cols.length < 12) continue;
    const level = Number(cols[0]);
    const left = Number(cols[6]);
    const top = Number(cols[7]);
    const w = Number(cols[8]);
    const h = Number(cols[9]);
    const conf = Number(cols[10]);
    const text = cols.slice(11).join("\t").trim();
    if (level === 1 && w > 0 && h > 0) {
      width = w;
      height = h;
    } else if (level === 5 && text) {
      words.push({ text, x: left, y: top, w, h, confidence: Number.isFinite(conf) ? conf : undefined });
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
  // 1. Optional JSON sidecar `<image>.ocr.json`
  const sidecarPath = `${filePath}.ocr.json`;
  if (existsSync(sidecarPath)) {
    try {
      const parsed = JSON.parse(readFileSync(sidecarPath, "utf8")) as {
        width?: number;
        height?: number;
        fullText?: string;
        words?: OcrWord[];
      };
      const words = Array.isArray(parsed.words) ? parsed.words : [];
      return {
        backend: "builtin",
        width: parsed.width ?? 0,
        height: parsed.height ?? 0,
        fullText: parsed.fullText ?? words.map((w) => w.text).join(" "),
        words,
      };
    } catch {
      // fall through
    }
  }

  const lower = filePath.toLowerCase();
  const buf = readFileSync(filePath);

  // 2. SVG `<text x="..." y="...">` extraction with real coordinates
  if (lower.endsWith(".svg")) {
    const svg = buf.toString("utf8");
    const wMatch = /\bwidth=["'](\d+(?:\.\d+)?)/i.exec(svg);
    const hMatch = /\bheight=["'](\d+(?:\.\d+)?)/i.exec(svg);
    const width = wMatch ? Math.round(Number(wMatch[1])) : 1280;
    const height = hMatch ? Math.round(Number(hMatch[1])) : 720;
    const words: OcrWord[] = [];
    const textRe = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
    let m: RegExpExecArray | null;
    while ((m = textRe.exec(svg)) !== null) {
      const attrs = m[1];
      const rawText = m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      if (!rawText) continue;
      const xm = /\bx=["'](\d+(?:\.\d+)?)/i.exec(attrs);
      const ym = /\by=["'](\d+(?:\.\d+)?)/i.exec(attrs);
      const baseX = xm ? Math.round(Number(xm[1])) : 20;
      const baseY = ym ? Math.round(Number(ym[1])) : 20;
      let offsetX = baseX;
      for (const tok of rawText.split(/\s+/)) {
        const estW = Math.max(12, tok.length * 10);
        words.push({ text: tok, x: offsetX, y: Math.max(0, baseY - 16), w: estW, h: 20 });
        offsetX += estW + 8;
      }
    }
    return {
      backend: "builtin",
      width,
      height,
      fullText: words.map((w) => w.text).join(" "),
      words,
    };
  }

  // 3. PNG embedded `tEXt` chunk (`pixgrep_ocr` JSON or `Comment`/`Description` text)
  if (lower.endsWith(".png")) {
    const meta = readPngTextChunks(buf);
    if (meta) {
      if (meta.textChunks["pixgrep_ocr"]) {
        try {
          const parsed = JSON.parse(meta.textChunks["pixgrep_ocr"]) as { words?: OcrWord[]; fullText?: string };
          const words = Array.isArray(parsed.words) ? parsed.words : [];
          return {
            backend: "builtin",
            width: meta.width,
            height: meta.height,
            fullText: parsed.fullText ?? words.map((w) => w.text).join(" "),
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
  const stdout = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", WINRT_OCR_SCRIPT], {
    env: { ...process.env, PIXGREP_IMAGE_PATH: filePath },
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
  const parsed = JSON.parse(stdout || "{}") as {
    width?: number;
    height?: number;
    fullText?: string;
    words?: OcrWord[];
  };
  return {
    backend: "winrt",
    width: parsed.width ?? 0,
    height: parsed.height ?? 0,
    fullText: parsed.fullText ?? "",
    words: Array.isArray(parsed.words) ? parsed.words : [],
  };
}

export function runMacVisionOcr(filePath: string): OcrResult {
  const stdout = execFileSync("swift", ["-e", MACOS_VISION_SWIFT, filePath], {
    encoding: "utf8",
    timeout: 25_000,
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
  const parsed = JSON.parse(stdout || "{}") as {
    width?: number;
    height?: number;
    fullText?: string;
    words?: OcrWord[];
  };
  return {
    backend: "vision",
    width: parsed.width ?? 0,
    height: parsed.height ?? 0,
    fullText: parsed.fullText ?? "",
    words: Array.isArray(parsed.words) ? parsed.words : [],
  };
}

export function runTesseractOcr(filePath: string): OcrResult {
  const stdout = execFileSync("tesseract", [filePath, "stdout", "tsv"], {
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

  // auto mode: fast builtin metadata/SVG path first, then native OS OCR, then tesseract
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
