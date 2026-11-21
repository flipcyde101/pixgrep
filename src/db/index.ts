import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { extractTextFromImage } from "../ocr/backends.js";
import type { IndexedImage, IndexStats, OcrBackendName, OcrWord, SearchHit } from "../types.js";

const IMAGE_EXT_RE = /\.(?:png|jpe?g|webp|bmp|svg)$/i;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

export function sanitizeFts5Query(rawQuery: string): string {
  const tokens = rawQuery
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/"/g, "").trim())
    .filter(Boolean);
  if (tokens.length === 0) return "";
  // Wrap each token in double-quotes with prefix wildcard so FTS5 operators (OR, NOT, NEAR, -, :, *) never cause syntax errors
  return tokens.map((t) => `"${t}"*`).join(" ");
}

function collectImageFiles(rootDir: string): string[] {
  const files: string[] = [];
  const visitedDirs = new Set<string>();

  const walk = (dir: string, depth: number): void => {
    if (depth > 16) return;
    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      return;
    }
    if (visitedDirs.has(real)) return;
    visitedDirs.add(real);

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile() && IMAGE_EXT_RE.test(entry.name)) {
        try {
          const st = statSync(full);
          if (st.size <= MAX_IMAGE_BYTES) files.push(full);
        } catch {
          // skip unreadable file
        }
      }
    }
  };

  walk(resolve(rootDir), 0);
  return files;
}

export class PixgrepIndex {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL UNIQUE,
        sha256 TEXT NOT NULL,
        width INTEGER NOT NULL DEFAULT 0,
        height INTEGER NOT NULL DEFAULT 0,
        backend TEXT NOT NULL,
        full_text TEXT NOT NULL,
        words_json TEXT NOT NULL,
        indexed_at TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS images_fts USING fts5(
        file_path,
        full_text,
        content='images',
        content_rowid='id'
      );

      CREATE TRIGGER IF NOT EXISTS images_ai AFTER INSERT ON images BEGIN
        INSERT INTO images_fts(rowid, file_path, full_text) VALUES (new.id, new.file_path, new.full_text);
      END;

      CREATE TRIGGER IF NOT EXISTS images_ad AFTER DELETE ON images BEGIN
        INSERT INTO images_fts(images_fts, rowid, file_path, full_text) VALUES('delete', old.id, old.file_path, old.full_text);
      END;

      CREATE TRIGGER IF NOT EXISTS images_au AFTER UPDATE ON images BEGIN
        INSERT INTO images_fts(images_fts, rowid, file_path, full_text) VALUES('delete', old.id, old.file_path, old.full_text);
        INSERT INTO images_fts(rowid, file_path, full_text) VALUES (new.id, new.file_path, new.full_text);
      END;
    `);
  }

  upsertImage(img: IndexedImage): void {
    this.db
      .prepare(
        `INSERT INTO images (file_path, sha256, width, height, backend, full_text, words_json, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(file_path) DO UPDATE SET
           sha256 = excluded.sha256,
           width = excluded.width,
           height = excluded.height,
           backend = excluded.backend,
           full_text = excluded.full_text,
           words_json = excluded.words_json,
           indexed_at = excluded.indexed_at`
      )
      .run(
        img.filePath,
        img.sha256,
        img.width,
        img.height,
        img.backend,
        img.fullText,
        JSON.stringify(img.words),
        img.indexedAt
      );
  }

  indexDirectory(dir: string, backend: OcrBackendName = "auto"): IndexStats {
    const started = Date.now();
    const absDir = resolve(dir);
    const files = collectImageFiles(absDir);
    const foundSet = new Set(files);

    let indexed = 0;
    let skippedCached = 0;
    let failed = 0;

    const getHashStmt = this.db.prepare("SELECT sha256 FROM images WHERE file_path = ?");

    for (const filePath of files) {
      try {
        const bytes = readFileSync(filePath);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const existing = getHashStmt.get(filePath) as { sha256?: string } | undefined;
        if (existing?.sha256 === sha256) {
          skippedCached++;
          continue;
        }
        const ocr = extractTextFromImage(filePath, backend);
        this.upsertImage({
          filePath,
          sha256,
          width: ocr.width,
          height: ocr.height,
          backend: ocr.backend,
          fullText: ocr.fullText,
          words: ocr.words,
          indexedAt: new Date().toISOString(),
        });
        indexed++;
      } catch {
        failed++;
      }
    }

    // Prune deleted files scoped under `absDir`
    const prefix = absDir.endsWith("\\") || absDir.endsWith("/") ? absDir : `${absDir}${process.platform === "win32" ? "\\" : "/"}`;
    const allRows = this.db.prepare("SELECT file_path FROM images").all() as Array<{ file_path: string }>;
    const delStmt = this.db.prepare("DELETE FROM images WHERE file_path = ?");
    let removedStale = 0;
    for (const row of allRows) {
      if (row.file_path.startsWith(prefix) && !foundSet.has(row.file_path)) {
        delStmt.run(row.file_path);
        removedStale++;
      }
    }

    return {
      scanned: files.length,
      indexed,
      skippedCached,
      removedStale,
      failed,
      durationMs: Date.now() - started,
    };
  }

  search(query: string, opts: { dir?: string; limit?: number } = {}): SearchHit[] {
    const ftsQuery = sanitizeFts5Query(query);
    if (!ftsQuery) return [];
    const limit = Math.max(1, Math.min(200, opts.limit ?? 30));
    const lowerTerms = query
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);

    const rows = this.db
      .prepare(
        `SELECT i.file_path, i.width, i.height, i.backend, i.full_text, i.words_json,
                snippet(images_fts, 1, '[', ']', '...', 14) AS snip,
                bm25(images_fts) AS rank
         FROM images_fts
         JOIN images i ON i.id = images_fts.rowid
         WHERE images_fts MATCH ?
         ORDER BY rank ASC
         LIMIT ?`
      )
      .all(ftsQuery, limit) as Array<{
      file_path: string;
      width: number;
      height: number;
      backend: string;
      full_text: string;
      words_json: string;
      snip: string;
      rank: number;
    }>;

    const dirPrefix = opts.dir ? resolve(opts.dir) : null;
    const hits: SearchHit[] = [];

    for (const r of rows) {
      if (dirPrefix && !r.file_path.startsWith(dirPrefix)) continue;
      let words: OcrWord[] = [];
      try {
        words = JSON.parse(r.words_json) as OcrWord[];
      } catch {
        words = [];
      }
      const matchedWords = words.filter((w) => {
        const lw = w.text.toLowerCase();
        return lowerTerms.some((t) => lw.includes(t));
      });
      hits.push({
        filePath: r.file_path,
        width: r.width,
        height: r.height,
        backend: r.backend,
        snippet: r.snip || r.full_text.slice(0, 120),
        fullText: r.full_text,
        matchedWords,
        score: Number(r.rank) || 0,
      });
    }

    return hits;
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS c FROM images").get() as { c: number };
    return Number(row.c);
  }

  close(): void {
    this.db.close();
  }
}
