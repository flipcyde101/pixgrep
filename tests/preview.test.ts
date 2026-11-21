import { describe, it, expect } from "vitest";
import { encodeRgbPng } from "../src/ocr/png.js";
import { renderPngHalfBlockPreview, renderPngKittyPreview } from "../src/preview/terminal.js";

describe("inline terminal preview renderer (half-block & Kitty)", () => {
  it("renders ANSI truecolor half-blocks with neon-green match box highlight and valid Kitty escape sequences", () => {
    const w = 64;
    const h = 32;
    const rgb = new Uint8Array(w * h * 3).fill(18);
    const png = encodeRgbPng(w, h, rgb);

    const preview = renderPngHalfBlockPreview(png, {
      cols: 32,
      rows: 10,
      highlightWords: [{ text: "ERR_CERT", x: 10, y: 10, w: 30, h: 10 }],
    });
    expect(preview).toContain("▀");
    // Neon green RGB (57, 255, 20) border must be rendered!
    expect(preview).toContain("57;255;20");

    const kitty = renderPngKittyPreview(png, 32);
    expect(kitty).toMatch(/^\x1b_Ga=T,f=100,c=32,m=[01];/);
    expect(kitty.endsWith("\x1b\\")).toBe(true);
  });
});
