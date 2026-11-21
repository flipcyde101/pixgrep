import { describe, it, expect } from "vitest";
import { decodePng, encodeRgbPng, readPngTextChunks } from "../src/ocr/png.js";

describe("pure-TS PNG encoder & decoder", () => {
  it("encodes and decodes RGB pixels and tEXt metadata chunks losslessly", () => {
    const w = 16;
    const h = 12;
    const rgb = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) {
      rgb[i * 3] = 20;
      rgb[i * 3 + 1] = 140;
      rgb[i * 3 + 2] = 240;
    }
    const png = encodeRgbPng(w, h, rgb, { pixgrep_ocr: '{"fullText":"hello world"}' });
    const decoded = decodePng(png);
    expect(decoded.width).toBe(w);
    expect(decoded.height).toBe(h);
    expect(decoded.rgba[0]).toBe(20);
    expect(decoded.rgba[1]).toBe(140);
    expect(decoded.rgba[2]).toBe(240);
    expect(decoded.rgba[3]).toBe(255);
    expect(decoded.textChunks["pixgrep_ocr"]).toContain("hello world");

    const fastMeta = readPngTextChunks(png);
    expect(fastMeta?.width).toBe(w);
    expect(fastMeta?.textChunks["pixgrep_ocr"]).toContain("hello world");
  });

  it("rejects invalid PNG signatures", () => {
    expect(() => decodePng(Buffer.from("not a png"))).toThrow(/signature/i);
  });
});
