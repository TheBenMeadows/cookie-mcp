// Read a logo off local disk for deploy_token.
//
// Without this, a file on the user's machine can only reach the launchpad by being base64'd through
// the model's context — tens of thousands of tokens to *move* an image nobody needs to read, and a
// truncated paste silently corrupts the logo that immutable metadata then pins forever.
//
// The MIME type comes from magic bytes, never the extension: the launchpad stores whatever we
// declare, and a `.png` that is really a JPEG would be pinned with the wrong content type.
import fs from "node:fs";
import path from "node:path";

import { CookieMcpError } from "./errors";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Raw bytes we accept as a logo. The launchpad pins the file as-is; these are what UIs render. */
const SIGNATURES: { mimeType: string; matches: (b: Buffer) => boolean }[] = [
  { mimeType: "image/png", matches: (b) => b.subarray(0, 8).equals(PNG_MAGIC) },
  { mimeType: "image/jpeg", matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mimeType: "image/gif",
    matches: (b) =>
      b
        .subarray(0, 6)
        .toString("latin1")
        .match(/^GIF8[79]a$/) !== null,
  },
  {
    mimeType: "image/webp",
    matches: (b) =>
      b.subarray(0, 4).toString("latin1") === "RIFF" &&
      b.subarray(8, 12).toString("latin1") === "WEBP",
  },
];

/**
 * Cap on the file we will pin. Generous for a logo and well under what the upload endpoint and IPFS
 * gateways are happy with; a 4K screenshot lands here and gets told to resize rather than timing out
 * mid-launch.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** `~/x.png` and relative paths resolve the way the shell would. */
export function resolveImagePath(input: string): string {
  const s = input.trim();
  if (s.startsWith("~")) return path.join(process.env.HOME ?? "", s.slice(1));
  return path.isAbsolute(s) ? s : path.resolve(process.cwd(), s);
}

/** Sniff the format from the leading bytes (pure). `null` when it is not an image we accept. */
export function sniffImageMimeType(bytes: Buffer): string | null {
  return SIGNATURES.find((s) => s.matches(bytes))?.mimeType ?? null;
}

/**
 * Read a local image and return exactly what `uploadImage` wants. Throws a `CookieMcpError` the
 * caller can surface verbatim — this runs before any spend, so every failure here is free.
 */
export function readImageFile(input: string): { base64: string; mimeType: string; bytes: number } {
  const abs = resolveImagePath(input);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new CookieMcpError(
      `no such file: ${abs}`,
      "pass the full path to the image on this machine, or use imageUrl for a hosted one",
    );
  }
  if (stat.isDirectory()) {
    throw new CookieMcpError(`${abs} is a directory, not an image file`);
  }
  if (stat.size === 0) {
    throw new CookieMcpError(`${abs} is empty`);
  }
  if (stat.size > MAX_IMAGE_BYTES) {
    throw new CookieMcpError(
      `${abs} is ${(stat.size / 1024 / 1024).toFixed(1)} MB — the limit is ${MAX_IMAGE_BYTES / 1024 / 1024} MB`,
      "resize it first; a launchpad logo renders at a few hundred pixels",
    );
  }

  let buf: Buffer;
  try {
    buf = fs.readFileSync(abs);
  } catch (e) {
    throw new CookieMcpError(
      `cannot read ${abs}: ${e instanceof Error ? e.message : String(e)}`,
      "check the file's permissions",
    );
  }

  const mimeType = sniffImageMimeType(buf);
  if (!mimeType) {
    throw new CookieMcpError(
      `${abs} is not a PNG, JPEG, GIF or WebP image`,
      "the format is read from the file's own bytes, not its extension — convert it first",
    );
  }

  return { base64: buf.toString("base64"), mimeType, bytes: stat.size };
}
