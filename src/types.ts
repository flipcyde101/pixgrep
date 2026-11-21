export type OcrBackendName = "auto" | "winrt" | "vision" | "tesseract" | "builtin";

export type PreviewProtocol = "halfblock" | "kitty";

export interface OcrWord {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  confidence?: number;
}

export interface OcrResult {
  backend: Exclude<OcrBackendName, "auto">;
  width: number;
  height: number;
  fullText: string;
  words: OcrWord[];
}

export interface IndexedImage {
  filePath: string;
  sha256: string;
  width: number;
  height: number;
  backend: string;
  fullText: string;
  words: OcrWord[];
  indexedAt: string;
}

export interface SearchHit {
  filePath: string;
  width: number;
  height: number;
  backend: string;
  snippet: string;
  fullText: string;
  matchedWords: OcrWord[];
  score: number;
}

export interface IndexStats {
  scanned: number;
  indexed: number;
  skippedCached: number;
  removedStale: number;
  failed: number;
  durationMs: number;
}
