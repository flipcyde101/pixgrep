import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PixgrepIndex, sanitizeFts5Query } from "../src/db/index.js";

describe("SQLite FTS5 incremental SHA-256 index", () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("sanitizes arbitrary punctuation & FTS5 operators without crashing", () => {
    expect(sanitizeFts5Query('ERR_CERT -foo "bar" OR NEAR:baz')).toBe('"ERR_CERT"* "-foo"* "bar"* "OR"* "NEAR:baz"*');
    expect(sanitizeFts5Query("   ")).toBe("");
  });

  it("indexes images once, skips unchanged SHA-256 on repeat run, searches FTS5 with word boxes, and prunes deleted files", () => {
    const dir = mkdtempSync(join(tmpdir(), "pg-idx-"));
    dirs.push(dir);
    const f1 = join(dir, "err.svg");
    const f2 = join(dir, "inv.svg");
    writeFileSync(f1, '<svg width="400" height="200"><text x="20" y="50">ERR_CERT_REVOKED api.prod</text></svg>');
    writeFileSync(f2, '<svg width="400" height="200"><text x="20" y="50">Invoice 2026-11 Total $99</text></svg>');

    const idx = new PixgrepIndex(join(dir, "index.db"));
    try {
      const first = idx.indexDirectory(dir, "builtin");
      expect(first.indexed).toBe(2);
      expect(first.skippedCached).toBe(0);

      const second = idx.indexDirectory(dir, "builtin");
      expect(second.indexed).toBe(0);
      expect(second.skippedCached).toBe(2);

      // Query with tricky FTS5 characters must succeed cleanly
      const hits = idx.search("ERR_CERT", { dir });
      expect(hits).toHaveLength(1);
      expect(hits[0].filePath).toBe(f1);
      expect(hits[0].matchedWords[0].text).toBe("ERR_CERT_REVOKED");

      // Deleting a file prunes it on re-index
      unlinkSync(f2);
      const third = idx.indexDirectory(dir, "builtin");
      expect(third.removedStale).toBe(1);
      expect(idx.count()).toBe(1);
    } finally {
      idx.close();
    }
  });
});
