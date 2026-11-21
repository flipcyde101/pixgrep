import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { extractTextFromImage } from "../ocr/backends.js";
import type { IndexedImage, IndexStats, OcrBackendName, OcrWord, SearchHit } from "../types.js";

const IMAGE_EXT_RE = /\.(?:png|jpe?g|webp|bmp|svg)$/i;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

function normalizePathKey(p: string): string {
  const abs = resolve(p);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

function normalizeDirPrefixKey(dir: string): string {
  let canonical = resolve(dir);
  try {
    canonical = realpathSync.native ? realpathSync.native(canonical) : realpathSync(canonical);
  } catch {
    // keep resolved path if dir does not exist
  }
  const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  return key.endsWith(sep) ? key : `${key}${sep}`;
}

function escapeSqlLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export function extractNormalizedQueryTokens(rawQuery: string): string[] {
  const cleaned = rawQuery.replace(/[\x00-\x1f\x7f"]/g, " ");
  return cleaned
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && /[\p{L}\p{N}]/u.test(t));
}

export function sanitizeFts5Query(rawQuery: string): string {
  const tokens = extractNormalizedQueryTokens(rawQuery);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"*`).join(" ");
}

function collectImageFiles(rootDir: string): string[] {
  const files: string[] = [];
  const visitedDirs = new Set<string>();

  const walk = (dir: string, depth: number): void => {
    if (depth > 16) return;
    let real: string;
    try {
      real = realpathSync.native ? realpathSync.native(dir) : realpathSync(dir);
    } catch {
      return;
    }
    const dirKey = process.platform === "win32" ? real.toLowerCase() : real;
    if (visitedDirs.has(dirKey)) return;
    visitedDirs.add(dirKey);

    let entries;
    try {
      entries = readdirSync(real, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = join(real, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        if (IMAGE_EXT_RE.test(entry.name)) {
          try {
            const st = statSync(full);
            if (st.size <= MAX_IMAGE_BYTES) files.push(full);
          } catch {
            // skip unreadable file
          }
        }
      } else if (entry.isSymbolicLink()) {
        try {
          const st = statSync(full);
          if (st.isDirectory()) {
            walk(full, depth + 1);
          } else if (st.isFile() && IMAGE_EXT_RE.test(entry.name) && st.size <= MAX_IMAGE_BYTES) {
            files.push(full);
          }
        } catch {
          // ignore dangling symlinks
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
        file_path TEXT NOT NULL,
        path_key TEXT NOT NULL UNIQUE,
        sha256 TEXT NOT NULL,
        width INTEGER NOT NULL DEFAULT 0,
        height INTEGER NOT NULL DEFAULT 0,
        backend TEXT NOT NULL,
        full_text TEXT NOT NULL,
        words_json TEXT NOT NULL,
        indexed_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_images_path_key ON images(path_key);

      CREATE VIRTUAL TABLE IF NOT EXISTS images_fts USING fts5(
        full_text,
        content='images',
        content_rowid='id'
      );

      CREATE TRIGGER IF NOT EXISTS images_ai AFTER INSERT ON images BEGIN
        INSERT INTO images_fts(rowid, full_text) VALUES (new.id, new.full_text);
      END;

      CREATE TRIGGER IF NOT EXISTS images_ad AFTER DELETE ON images BEGIN
        INSERT INTO images_fts(images_fts, rowid, full_text) VALUES('delete', old.id, old.full_text);
      END;

      CREATE TRIGGER IF NOT EXISTS images_au AFTER UPDATE ON images BEGIN
        INSERT INTO images_fts(images_fts, rowid, full_text) VALUES('delete', old.id, old.full_text);
        INSERT INTO images_fts(rowid, full_text) VALUES (new.id, new.full_text);
      END;
    `);
  }

  upsertImage(img: IndexedImage): void {
    const pathKey = normalizePathKey(img.filePath);
    this.db
      .prepare(
        `INSERT INTO images (file_path, path_key, sha256, width, height, backend, full_text, words_json, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path_key) DO UPDATE SET
           file_path = excluded.file_path,
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
        pathKey,
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
    const foundKeySet = new Set(files.map((f) => normalizePathKey(f)));

    let indexed = 0;
    let skippedCached = 0;
    let failed = 0;

    const getExistingStmt = this.db.prepare("SELECT sha256, backend, full_text FROM images WHERE path_key = ?");

    this.db.exec("BEGIN");
    try {
      for (const filePath of files) {
        try {
          const bytes = readFileSync(filePath);
          const sha256 = createHash("sha256").update(bytes).digest("hex");
          const pathKey = normalizePathKey(filePath);
          const existing = getExistingStmt.get(pathKey) as { sha256?: string; backend?: string; full_text?: string } | undefined;
          const sameBackend = backend === "auto"
            ? !(existing?.backend === "builtin" && !existing?.full_text)
            : existing?.backend === backend;
          if (existing?.sha256 === sha256 && sameBackend) {
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

      // Prune deleted files scoped cleanly under `dirPrefixKey`
      const dirPrefixKey = normalizeDirPrefixKey(absDir);
      const likePattern = `${escapeSqlLike(dirPrefixKey)}%`;
      const scopedRows = this.db
        .prepare("SELECT path_key FROM images WHERE path_key LIKE ? ESCAPE '\\'")
        .all(likePattern) as Array<{ path_key: string }>;
      const delStmt = this.db.prepare("DELETE FROM images WHERE path_key = ?");
      let removedStale = 0;
      for (const row of scopedRows) {
        if (!foundKeySet.has(row.path_key)) {
          delStmt.run(row.path_key);
          removedStale++;
        }
      }

      this.db.exec("COMMIT");
      return {
        scanned: files.length,
        indexed,
        skippedCached,
        removedStale,
        failed,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  search(query: string, opts: { dir?: string; limit?: number } = {}): SearchHit[] {
    const tokens = extractNormalizedQueryTokens(query);
    const ftsQuery = tokens.length > 0 ? tokens.map((t) => `"${t}"*`).join(" ") : "";
    if (!ftsQuery) return [];
    const limit = Math.max(1, Math.min(200, opts.limit ?? 30));
    const lowerTerms = tokens.map((t) => t.toLowerCase());

    let rows: Array<{
      file_path: string;
      width: number;
      height: number;
      backend: string;
      full_text: string;
      words_json: string;
      snip: string;
      rank: number;
    }>;

    if (opts.dir) {
      const dirPrefixKey = normalizeDirPrefixKey(opts.dir);
      const likePattern = `${escapeSqlLike(dirPrefixKey)}%`;
      rows = this.db
        .prepare(
          `SELECT i.file_path, i.width, i.height, i.backend, i.full_text, i.words_json,
                  snippet(images_fts, 0, '[', ']', '...', 14) AS snip,
                  bm25(images_fts) AS rank
           FROM images_fts
           JOIN images i ON i.id = images_fts.rowid
           WHERE images_fts MATCH ? AND i.path_key LIKE ? ESCAPE '\\'
           ORDER BY rank ASC
           LIMIT ?`
        )
        .all(ftsQuery, likePattern, limit) as typeof rows;
    } else {
      rows = this.db
        .prepare(
          `SELECT i.file_path, i.width, i.height, i.backend, i.full_text, i.words_json,
                  snippet(images_fts, 0, '[', ']', '...', 14) AS snip,
                  bm25(images_fts) AS rank
           FROM images_fts
           JOIN images i ON i.id = images_fts.rowid
           WHERE images_fts MATCH ?
           ORDER BY rank ASC
           LIMIT ?`
        )
        .all(ftsQuery, limit) as typeof rows;
    }

    const hits: SearchHit[] = [];
    for (const r of rows) {
      let words: OcrWord[] = [];
      try {
        const parsed = JSON.parse(r.words_json) as unknown;
        if (Array.isArray(parsed)) {
          words = parsed.filter((w): w is OcrWord => Boolean(w) && typeof (w as OcrWord).text === "string");
        }
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
