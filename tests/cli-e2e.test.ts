import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

describe("built dist/cli.js --demo end-to-end", () => {
  it("runs --demo --json cleanly and finds ERR_CERT with bounding box coordinates", () => {
    const cliPath = resolve(process.cwd(), "dist", "cli.js");
    const out = execFileSync(process.execPath, [cliPath, "--demo", "--json"], { encoding: "utf8" });
    const parsed = JSON.parse(out) as {
      query: string;
      stats: { indexed: number };
      hits: Array<{ filePath: string; matchedWords: Array<{ text: string; x: number; y: number }> }>;
    };
    expect(parsed.query).toBe("ERR_CERT");
    expect(parsed.stats.indexed).toBe(4);
    expect(parsed.hits).toHaveLength(1);
    expect(parsed.hits[0].matchedWords[0].text).toBe("ERR_CERT_AUTHORITY_INVALID");
  });
});
