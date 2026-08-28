// Fetch a remote logo so it can be re-pinned to IPFS.
//
// `imageUrl` used to be stored verbatim in the token's metadata JSON, and nothing on the path — not
// this server, not the launchpad backend — ever pinned it. The metadata is immutable, so the logo
// was a permanent pointer at someone else's host: when that link rots, expires, or turns out to have
// been a signed URL, the token's image is gone and cannot be replaced. We fetch the bytes and pin
// them instead, which is what the tool description always claimed happened.
//
// This server runs on the user's machine, so a URL it fetches is a request from inside their
// network. Every hop is therefore checked against the private address space *after* DNS resolution
// and redirects are followed by hand, so a public hostname cannot bounce us onto localhost or a
// cloud metadata endpoint.
import dns from "node:dns/promises";
import net from "node:net";

import { HTTP_TIMEOUT_MS } from "./config";
import { CookieMcpError } from "./errors";
import { MAX_IMAGE_BYTES, sniffImageMimeType } from "./imageFile";

/** Redirect hops to follow before giving up — real image hosts use one or two. */
const MAX_REDIRECTS = 3;

function ipv4IsPrivate(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/** Is this address one we refuse to fetch from? (pure) */
export function isPrivateAddress(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (net.isIPv4(v)) return ipv4IsPrivate(v);
  if (!net.isIPv6(v)) return true; // unparseable → refuse
  // IPv4-mapped (::ffff:127.0.0.1) is the classic bypass.
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4IsPrivate(mapped[1]);
  if (v === "::" || v === "::1") return true; // unspecified, loopback
  if (/^f[cd]/.test(v)) return true; // unique-local fc00::/7
  if (/^fe[89ab]/.test(v)) return true; // link-local fe80::/10
  if (/^ff/.test(v)) return true; // multicast
  return false;
}

/** Reject anything that is not a plain https URL to a public host. Resolves DNS. */
async function assertFetchableUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CookieMcpError(
      `imageUrl is not a valid URL: ${raw}`,
      "pass a full https URL, or use imagePath for a file on this machine",
    );
  }
  if (url.protocol !== "https:") {
    throw new CookieMcpError(
      `imageUrl must be https, got ${url.protocol.replace(":", "") || "no scheme"}`,
      "an http or file URL cannot be pinned; use imagePath for a local file",
    );
  }

  // A literal IP skips DNS; a hostname is resolved and every answer must be public.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw privateHostError(url);
    return url;
  }
  let addrs: { address: string }[];
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw new CookieMcpError(
      `cannot resolve ${host}`,
      "check the URL; the launch was not sent, so nothing was spent",
    );
  }
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw privateHostError(url);
  return url;
}

function privateHostError(url: URL): CookieMcpError {
  return new CookieMcpError(
    `refusing to fetch ${url.hostname} — it resolves inside a private network`,
    "the logo has to be reachable publicly so it can be pinned; use imagePath for a local file",
  );
}

/**
 * Download a remote image and return it ready for `uploadImage`. Follows redirects manually,
 * re-checking each hop. Throws a `CookieMcpError` the caller can surface verbatim — this runs before
 * any spend, so every failure here is free.
 */
export async function fetchRemoteImage(
  raw: string,
): Promise<{ base64: string; mimeType: string; bytes: number }> {
  let url = await assertFetchableUrl(raw.trim());

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    let res: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let r: Response;
      try {
        r = await fetch(url, {
          redirect: "manual",
          signal: controller.signal,
          headers: { Accept: "image/*" },
        });
      } catch (e) {
        throw new CookieMcpError(
          `cannot fetch ${url.href}: ${e instanceof Error ? e.message : String(e)}`,
          "the image must be publicly downloadable to be pinned",
        );
      }
      if (r.status >= 300 && r.status < 400) {
        const location = r.headers.get("location");
        if (!location) {
          throw new CookieMcpError(`${url.href} redirected without a location header`);
        }
        // Re-validate the target: a public host may redirect anywhere, including inward.
        url = await assertFetchableUrl(new URL(location, url).href);
        continue;
      }
      res = r;
      break;
    }
    if (!res) {
      throw new CookieMcpError(
        `${raw} redirected more than ${MAX_REDIRECTS} times`,
        "link the image directly rather than through a redirector",
      );
    }
    if (!res.ok) {
      throw new CookieMcpError(
        `${url.href} returned HTTP ${res.status}`,
        "the image must be publicly downloadable to be pinned",
      );
    }

    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) throw tooBig(declared);

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_IMAGE_BYTES) throw tooBig(buf.byteLength);
    if (!buf.byteLength) throw new CookieMcpError(`${url.href} returned an empty body`);

    // The bytes decide the type, not the server's content-type header — same rule as imagePath.
    const mimeType = sniffImageMimeType(buf);
    if (!mimeType) {
      throw new CookieMcpError(
        `${url.href} is not a PNG, JPEG, GIF or WebP image`,
        "it may be an HTML page rather than the image itself — link the file directly",
      );
    }
    return { base64: buf.toString("base64"), mimeType, bytes: buf.byteLength };
  } finally {
    clearTimeout(timer);
  }
}

function tooBig(bytes: number): CookieMcpError {
  return new CookieMcpError(
    `the image is ${(bytes / 1024 / 1024).toFixed(1)} MB — the limit is ${MAX_IMAGE_BYTES / 1024 / 1024} MB`,
    "resize it first; a launchpad logo renders at a few hundred pixels",
  );
}
