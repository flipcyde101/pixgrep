import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PixgrepIndex } from "./db/index.js";
import { runPixgrepDemo } from "./demo/fixture.js";
import { renderImagePreview } from "./preview/terminal.js";
import type { OcrBackendName, PreviewProtocol } from "./types.js";

export interface ParsedCliArgs {
  mode: "help" | "search" | "index" | "demo";
  query?: string;
  dir: string;
  dbPath: string;
  backend: OcrBackendName;
  protocol: PreviewProtocol;
  preview: boolean;
  json: boolean;
  limit: number;
}

function printHelp(): void {
  console.log(`pixgrep v0.1.0 - Offline ripgrep for screenshots & images with SQLite FTS5 and inline terminal previews

Usage:
  pixgrep <query> [dir] [options]       Index (incremental SHA-256) and search screenshots for <query>
  pixgrep index <dir> [options]         Index a screenshot folder into local SQLite FTS5
  pixgrep --demo [options]              Run self-contained demo searching screenshots with neon-green match box

Options:
  --preview                             Render inline terminal preview with neon-green match highlight box
  --protocol <halfblock|kitty>          Terminal preview protocol (default: halfblock)
  --backend <auto|winrt|vision|tesseract|builtin>  OCR backend (default: auto)
  --db <path>                           SQLite FTS5 index path (default: ~/.pixgrep/index.db)
  --limit <n>                           Max search results (default: 20)
  --json                                Output machine-readable JSON (suppresses ANSI preview)
  --                                    End of options (allows queries starting with "-")
  -h, --help                            Show this help`);
}

function requireVal(argv: string[], i: number, flag: string, allowNegative = false): string {
  const v = argv[i + 1];
  if (v === undefined || !v.trim()) {
    throw new Error(`Missing or empty value for ${flag}`);
  }
  if (!allowNegative && v.trim().startsWith("-")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return v.trim();
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const parsed: ParsedCliArgs = {
    mode: "help",
    dir: process.cwd(),
    dbPath: join(homedir(), ".pixgrep", "index.db"),
    backend: "auto",
    protocol: "halfblock",
    preview: false,
    json: false,
    limit: 20,
  };

  const positionals: string[] = [];
  let endOfFlags = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (endOfFlags) {
      positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      endOfFlags = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      parsed.mode = "help";
      return parsed;
    } else if (arg === "--demo") {
      parsed.mode = "demo";
      parsed.preview = true;
    } else if (arg === "--preview") {
      parsed.preview = true;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--protocol") {
      const p = requireVal(argv, i, "--protocol");
      if (p !== "halfblock" && p !== "kitty") throw new Error('--protocol must be "halfblock" or "kitty"');
      parsed.protocol = p;
      i++;
    } else if (arg === "--backend") {
      const b = requireVal(argv, i, "--backend");
      if (!["auto", "winrt", "vision", "tesseract", "builtin"].includes(b)) {
        throw new Error("--backend must be one of auto, winrt, vision, tesseract, builtin");
      }
      parsed.backend = b as OcrBackendName;
      i++;
    } else if (arg === "--db") {
      parsed.dbPath = requireVal(argv, i, "--db");
      i++;
    } else if (arg === "--limit") {
      const raw = requireVal(argv, i, "--limit", true);
      if (!/^-?\d+$/.test(raw)) throw new Error("--limit must be an integer 1..200");
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 200) throw new Error("--limit must be an integer 1..200");
      parsed.limit = n;
      i++;
    } else if (!arg.startsWith("-")) {
      positionals.push(arg);
    } else {
      throw new Error(`Unknown argument "${arg}". Run \`pixgrep --help\`.`);
    }
  }

  if (parsed.mode === "demo") {
    if (positionals.length > 1) {
      throw new Error(`Unexpected extra argument "${positionals[1]}" for --demo`);
    }
    if (positionals[0]) parsed.query = positionals[0];
    return parsed;
  }

  if (positionals[0] === "index") {
    if (positionals.length > 2) {
      throw new Error(`Unexpected extra argument "${positionals[2]}". Usage: pixgrep index <dir>`);
    }
    parsed.mode = "index";
    parsed.dir = positionals[1] ? resolve(positionals[1]) : process.cwd();
    return parsed;
  }

  if (positionals.length > 2) {
    throw new Error(`Unexpected extra argument "${positionals[2]}". Quote multi-word queries: pixgrep "tls error" <dir>`);
  }

  if (positionals.length > 0) {
    parsed.mode = "search";
    parsed.query = positionals[0];
    if (positionals[1]) parsed.dir = resolve(positionals[1]);
  }

  return parsed;
}

function assertExistingDirectory(dir: string): void {
  let st;
  try {
    st = statSync(dir);
  } catch {
    throw new Error(`Directory not found: "${dir}"`);
  }
  if (!st.isDirectory()) {
    throw new Error(`Path is not a directory: "${dir}"`);
  }
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.mode === "help") {
    printHelp();
    return;
  }

  if (args.mode === "demo") {
    const out = runPixgrepDemo({
      query: args.query,
      preview: args.preview && !args.json,
      protocol: args.protocol,
    });
    if (args.json) {
      console.log(JSON.stringify({ query: out.query, stats: out.stats, hits: out.hits }, null, 2));
      return;
    }
    console.log(
      `pixgrep demo · indexed ${out.stats.indexed} screenshot(s) in ${out.stats.durationMs}ms · query: "${out.query}"`
    );
    for (const hit of out.hits) {
      const box = hit.matchedWords[0];
      const loc = box ? `box(${box.x},${box.y},${box.w}x${box.h})` : "match";
      console.log(`  MATCH ${basename(hit.filePath)} [${loc}] | ${hit.snippet}`);
    }
    if (out.preview) {
      console.log("");
      console.log(out.preview);
    }
    return;
  }

  assertExistingDirectory(args.dir);

  const index = new PixgrepIndex(args.dbPath);
  try {
    const stats = index.indexDirectory(args.dir, args.backend);
    if (args.mode === "index") {
      if (args.json) {
        console.log(JSON.stringify(stats, null, 2));
      } else {
        console.log(
          `pixgrep indexed ${stats.indexed} new (${stats.skippedCached} cached, ${stats.removedStale} pruned, ${stats.failed} failed) across ${stats.scanned} image(s) in ${stats.durationMs}ms`
        );
      }
      return;
    }

    const hits = index.search(args.query ?? "", { dir: args.dir, limit: args.limit });
    if (args.json) {
      console.log(JSON.stringify({ query: args.query, stats, hits }, null, 2));
      return;
    }

    if (hits.length === 0) {
      console.log(`No screenshot matches for "${args.query}" in ${args.dir} (${stats.scanned} indexed).`);
      return;
    }

    console.log(`pixgrep · ${hits.length} match(es) for "${args.query}" (${stats.skippedCached} cached, ${stats.indexed} newly indexed)`);
    for (const hit of hits) {
      const box = hit.matchedWords[0];
      const loc = box ? ` [${box.x},${box.y} ${box.w}x${box.h}]` : "";
      console.log(`  ${hit.filePath}${loc}`);
      console.log(`    ${hit.snippet}`);
    }

    if (args.preview && hits[0]) {
      console.log("");
      console.log(
        renderImagePreview(hits[0].filePath, {
          cols: 56,
          protocol: args.protocol,
          highlightWords: hits[0].matchedWords,
        })
      );
    }
  } finally {
    index.close();
  }
}

function isDirectEntry(): boolean {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(fileURLToPath(import.meta.url)).toLowerCase() ===
      realpathSync(resolve(process.argv[1])).toLowerCase()
    );
  } catch {
    return resolve(fileURLToPath(import.meta.url)).toLowerCase() === resolve(process.argv[1]).toLowerCase();
  }
}

if (isDirectEntry()) {
  main().catch((err) => {
    console.error(`[pixgrep] Error: ${(err as Error).message}`);
    process.exitCode = 1;
  });
}
