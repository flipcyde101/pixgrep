import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractBuiltinOcr, parseTesseractTsv } from "../src/ocr/backends.js";

describe("OCR backends & TSV/SVG parsers", () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("parses Tesseract TSV word bounding boxes and dimensions accurately", () => {
    const tsv = [
      "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
      "1\t1\t0\t0\t0\t0\t0\t0\t1280\t720\t-1\t",
      "5\t1\t1\t1\t1\t1\t120\t240\t180\t24\t96\tERR_CERT_INVALID",
      "5\t1\t1\t1\t1\t2\t310\t240\t90\t24\t94\tlocalhost",
    ].join("\n");
    const parsed = parseTesseractTsv(tsv);
    expect(parsed.width).toBe(1280);
    expect(parsed.height).toBe(720);
    expect(parsed.words).toHaveLength(2);
    expect(parsed.words[0]).toMatchObject({ text: "ERR_CERT_INVALID", x: 120, y: 240, w: 180, h: 24 });
  });

  it("extracts SVG <text> nodes with coordinates via builtin backend", () => {
    const dir = mkdtempSync(join(tmpdir(), "pg-svg-"));
    dirs.push(dir);
    const svgPath = join(dir, "shot.svg");
    writeFileSync(
      svgPath,
      '<svg width="800" height="400"><text x="40" y="90">Invoice INV-9001 Paid</text></svg>',
      "utf8"
    );
    const res = extractBuiltinOcr(svgPath);
    expect(res?.width).toBe(800);
    expect(res?.fullText).toContain("INV-9001");
    expect(res?.words.some((w) => w.text === "INV-9001" && w.x > 40)).toBe(true);
  });
});
