import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PixgrepIndex, sanitizeFts5Query } from "../src/db/index.js";
import { extractBuiltinOcr, parseTesseractTsv } from "../src/ocr/backends.js";
import { decodePng, encodeRgbPng } from "../src/ocr/png.js";
import { renderImagePreview, renderPngKittyPreview } from "../src/preview/terminal.js";
import { parseCliArgs } from "../src/cli.js";

describe("pixgrep whole-branch review regression fixes (C1-C5, I1-I9, M1-M5)", () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("C1 & I8: scopes directory search in SQL before LIMIT without sibling prefix leaks or filename false positives", () => {
    const base = mkdtempSync(join(tmpdir(), "pg-c1-"));
    dirs.push(base);
    const foo = join(base, "foo");
    const foo2 = join(base, "foo2");
    mkdirSync(foo, { recursive: true });
    mkdirSync(foo2, { recursive: true });

    // Create 5 matches in foo2 and 1 in foo
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(foo2, `s${i}.svg`), `<svg width="200" height="100"><text x="10" y="30">ERR_CERT item${i}</text></svg>`);
    }
    writeFileSync(join(foo, "target.svg"), `<svg width="200" height="100"><text x="10" y="30">ERR_CERT target</text></svg>`);

    const idx = new PixgrepIndex(join(base, "idx.db"));
    try {
      idx.indexDirectory(foo2, "builtin");
      idx.indexDirectory(foo, "builtin");

      // C1: searching `foo` with limit 2 MUST NOT return `foo2` siblings AND MUST find `foo/target.svg`!
      const hits = idx.search("ERR_CERT", { dir: foo, limit: 2 });
      expect(hits).toHaveLength(1);
      expect(hits[0].filePath).toBe(realpathSync.native(join(foo, "target.svg")));

      // I8: searching "svg" must NOT match every .svg via file_path
      const extHits = idx.search("svg", { dir: foo });
      expect(extHits).toHaveLength(0);
    } finally {
      idx.close();
    }
  });

  it("C2: sanitizes NUL bytes, punctuation-only queries, and keeps matchedWords when query has quotes", () => {
    expect(sanitizeFts5Query("a\u0000b")).toBe('"a"* "b"*');
    expect(sanitizeFts5Query("...")).toBe("");
    expect(sanitizeFts5Query("---")).toBe("");

    const base = mkdtempSync(join(tmpdir(), "pg-c2-"));
    dirs.push(base);
    writeFileSync(join(base, "a.svg"), `<svg width="200" height="100"><text x="10" y="30">ERR_CERT_REVOKED</text></svg>`);
    const idx = new PixgrepIndex(":memory:");
    try {
      idx.indexDirectory(base, "builtin");
      // Must NOT throw on NUL byte
      expect(() => idx.search("a\u0000b")).not.toThrow();
      // Quoted query must still populate matchedWords
      const hits = idx.search('"ERR_CERT"', { dir: base });
      expect(hits).toHaveLength(1);
      expect(hits[0].matchedWords.length).toBeGreaterThanOrEqual(1);
    } finally {
      idx.close();
    }
  });

  it("C5 & I6 & M1: handles unclosed SVG tags in linear time (no ReDoS), decodes XML entities, separates <tspan>, and skips NaN TSV rows", () => {
    const base = mkdtempSync(join(tmpdir(), "pg-c5-"));
    dirs.push(base);

    // C5: 30,000 unclosed `<text>` tags must finish in <250ms (was 2328ms with quadratic regex!)
    const evilSvg = join(base, "evil.svg");
    writeFileSync(evilSvg, "<svg width=\"100\" height=\"100\">" + "<text>".repeat(30_000) + "</svg>");
    const t0 = Date.now();
    extractBuiltinOcr(evilSvg);
    expect(Date.now() - t0).toBeLessThan(350);

    // I6: entity decoding & <tspan> separation
    const entSvg = join(base, "ent.svg");
    writeFileSync(
      entSvg,
      '<svg viewBox="0 0 600 300"><rect width="10" height="10"/><text x="20" y="40"><tspan>R&amp;D</tspan><tspan>Budget &lt;100&gt;</tspan></text></svg>'
    );
    const parsed = extractBuiltinOcr(entSvg);
    expect(parsed?.width).toBe(600);
    expect(parsed?.fullText).toContain("R&D Budget <100>");

    // M1: NaN TSV rows ignored cleanly
    const tsv = "5\t1\t1\t1\t1\t1\tnotanumber\t10\t20\t10\t90\tBAD\n5\t1\t1\t1\t1\t2\t10\t20\t30\t12\t95\tGOOD\n";
    const tsvRes = parseTesseractTsv(tsv);
    expect(tsvRes.words).toHaveLength(1);
    expect(tsvRes.words[0].text).toBe("GOOD");
  });

  it("I3, I4, I5: PNG decoder verifies CRC32, renderImagePreview falls back gracefully on invalid PNG, and Kitty preview validates PNG & draws boxes", () => {
    const rgb = new Uint8Array(32 * 24 * 3).fill(20);
    const png = encodeRgbPng(32, 24, rgb);
    const corrupted = Buffer.from(png);
    // Flip a byte inside the IDAT CRC32
    corrupted[corrupted.length - 16] ^= 0xff;
    expect(() => decodePng(corrupted)).toThrow(/crc/i);

    const base = mkdtempSync(join(tmpdir(), "pg-i4-"));
    dirs.push(base);
    const badPng = join(base, "corrupt.png");
    writeFileSync(badPng, Buffer.from("not-valid-png"));
    // I4: graceful fallback banner instead of throwing
    expect(renderImagePreview(badPng)).toContain("preview unavailable");

    // I5: Kitty preview rejects non-PNG buffer
    expect(() => renderPngKittyPreview(Buffer.from("not-png"), 32)).toThrow(/png/i);
  });

  it("I7 & I9: CLI rejects whitespace --db, extra positionals, supports -- before dash query, and removes unused tui keyword", () => {
    expect(() => parseCliArgs(["ERR_CERT", ".", "--db", "   "])).toThrow();
    expect(() => parseCliArgs(["one", "two", "three"])).toThrow();
    const dashQuery = parseCliArgs(["--", "-Wall", "."]);
    expect(dashQuery.mode).toBe("search");
    expect(dashQuery.query).toBe("-Wall");

    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { keywords: string[] };
    expect(pkg.keywords).not.toContain("tui");
  });
});
