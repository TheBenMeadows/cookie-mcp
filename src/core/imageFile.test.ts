import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { MAX_IMAGE_BYTES, readImageFile, resolveImagePath, sniffImageMimeType } from "./imageFile";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF = Buffer.from("GIF89a....", "latin1");
const WEBP = Buffer.concat([
  Buffer.from("RIFF", "latin1"),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from("WEBP", "latin1"),
]);

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cookie-img-"));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function write(name: string, bytes: Buffer): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, bytes);
  return p;
}

describe("sniffImageMimeType", () => {
  it("recognises the formats a launchpad UI can render", () => {
    expect(sniffImageMimeType(PNG)).toBe("image/png");
    expect(sniffImageMimeType(JPEG)).toBe("image/jpeg");
    expect(sniffImageMimeType(GIF)).toBe("image/gif");
    expect(sniffImageMimeType(WEBP)).toBe("image/webp");
  });

  it("rejects anything else, including SVG and a PDF", () => {
    expect(sniffImageMimeType(Buffer.from("<svg xmlns=...", "latin1"))).toBeNull();
    expect(sniffImageMimeType(Buffer.from("%PDF-1.7", "latin1"))).toBeNull();
    expect(sniffImageMimeType(Buffer.from([]))).toBeNull();
  });
});

describe("readImageFile", () => {
  it("returns base64 + the sniffed type", () => {
    const file = readImageFile(write("logo.png", PNG));
    expect(file.mimeType).toBe("image/png");
    expect(Buffer.from(file.base64, "base64").equals(PNG)).toBe(true);
    expect(file.bytes).toBe(PNG.length);
  });

  it("trusts the bytes over the extension — a JPEG named .png is typed image/jpeg", () => {
    expect(readImageFile(write("liar.png", JPEG)).mimeType).toBe("image/jpeg");
  });

  it("names the resolved path when the file is missing", () => {
    const missing = path.join(dir, "nope.png");
    expect(() => readImageFile(missing)).toThrow(new RegExp(missing));
  });

  it("refuses a directory, an empty file, and a non-image", () => {
    expect(() => readImageFile(dir)).toThrow(/directory/);
    expect(() => readImageFile(write("empty.png", Buffer.alloc(0)))).toThrow(/empty/);
    expect(() => readImageFile(write("notes.txt", Buffer.from("hello")))).toThrow(
      /not a PNG, JPEG, GIF or WebP/,
    );
  });

  it("refuses a file over the size cap before reading it", () => {
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]);
    expect(() => readImageFile(write("huge.png", big))).toThrow(/limit is 5 MB/);
  });
});

describe("resolveImagePath", () => {
  it("expands ~ and resolves a relative path against cwd", () => {
    const home = process.env.HOME;
    process.env.HOME = "/home/x";
    expect(resolveImagePath("~/a.png")).toBe("/home/x/a.png");
    expect(resolveImagePath("a.png")).toBe(path.resolve(process.cwd(), "a.png"));
    expect(resolveImagePath("  /tmp/a.png  ")).toBe("/tmp/a.png");
    process.env.HOME = home;
  });
});
