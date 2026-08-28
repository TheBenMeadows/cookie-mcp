import { describe, it, expect, vi, afterEach } from "vitest";

import { fetchRemoteImage, isPrivateAddress } from "./imageFetch";

vi.mock("node:dns/promises", () => ({
  default: {
    // Every hostname in these tests resolves public unless the test says otherwise.
    lookup: vi.fn(async (host: string) =>
      host === "internal.example" ? [{ address: "10.0.0.5" }] : [{ address: "93.184.216.34" }],
    ),
  },
}));

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

function imageRes(bytes: Buffer, headers: Record<string, string> = {}) {
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
  } as unknown as Response;
}

function redirectRes(to: string) {
  return {
    ok: false,
    status: 302,
    headers: { get: (k: string) => (k.toLowerCase() === "location" ? to : null) },
  } as unknown as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe("isPrivateAddress", () => {
  it("blocks loopback, RFC1918, CGNAT and cloud metadata", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254"]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    expect(isPrivateAddress("100.64.0.1")).toBe(true);
  });

  it("blocks the IPv6 forms, including an IPv4-mapped loopback", () => {
    for (const ip of ["::1", "::", "fc00::1", "fe80::1", "::ffff:127.0.0.1"]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
  });

  it("allows ordinary public addresses", () => {
    expect(isPrivateAddress("93.184.216.34")).toBe(false);
    expect(isPrivateAddress("2606:2800:220:1::1")).toBe(false);
  });

  it("refuses anything it cannot parse", () => {
    expect(isPrivateAddress("not-an-ip")).toBe(true);
  });
});

describe("fetchRemoteImage", () => {
  it("downloads the bytes and types them from the magic bytes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(imageRes(PNG)));

    const got = await fetchRemoteImage("https://example.com/logo.png");
    expect(got.mimeType).toBe("image/png");
    expect(Buffer.from(got.base64, "base64").equals(PNG)).toBe(true);
  });

  it("ignores a lying content-type and trusts the bytes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(imageRes(PNG, { "content-type": "image/gif" })),
    );
    expect((await fetchRemoteImage("https://example.com/x")).mimeType).toBe("image/png");
  });

  it("refuses a non-https URL without fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchRemoteImage("http://example.com/logo.png")).rejects.toThrow(/must be https/);
    await expect(fetchRemoteImage("file:///etc/passwd")).rejects.toThrow(/must be https/);
    await expect(fetchRemoteImage("not a url")).rejects.toThrow(/not a valid URL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a host that resolves into a private network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchRemoteImage("https://internal.example/logo.png")).rejects.toThrow(
      /private network/,
    );
    // A literal address skips DNS but is checked the same way.
    await expect(fetchRemoteImage("https://169.254.169.254/latest/meta-data")).rejects.toThrow(
      /private network/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-checks each redirect hop, so a public host cannot bounce us inward", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(redirectRes("https://169.254.169.254/latest/meta-data")),
    );

    await expect(fetchRemoteImage("https://example.com/logo.png")).rejects.toThrow(
      /private network/,
    );
  });

  it("follows a redirect to a public host", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(redirectRes("https://cdn.example/real.png"))
      .mockResolvedValueOnce(imageRes(PNG));
    vi.stubGlobal("fetch", fetchMock);

    expect((await fetchRemoteImage("https://example.com/logo.png")).mimeType).toBe("image/png");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up on a redirect loop", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(redirectRes("https://example.com/again")));

    await expect(fetchRemoteImage("https://example.com/logo.png")).rejects.toThrow(
      /redirected more than/,
    );
  });

  it("rejects an oversized image on its declared length, before reading the body", async () => {
    const arrayBuffer = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: (k: string) => (k.toLowerCase() === "content-length" ? "99999999" : null) },
        arrayBuffer,
      } as unknown as Response),
    );

    await expect(fetchRemoteImage("https://example.com/huge.png")).rejects.toThrow(/limit is 5 MB/);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("rejects an HTML page dressed as an image URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(imageRes(Buffer.from("<!doctype html><html>", "latin1"))),
    );

    await expect(fetchRemoteImage("https://example.com/logo.png")).rejects.toThrow(
      /not a PNG, JPEG, GIF or WebP/,
    );
  });

  it("surfaces a 404 rather than launching with a broken logo", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        headers: { get: () => null },
      } as unknown as Response),
    );

    await expect(fetchRemoteImage("https://example.com/gone.png")).rejects.toThrow(/HTTP 404/);
  });
});
