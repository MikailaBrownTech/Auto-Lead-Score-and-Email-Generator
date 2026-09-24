import { describe, expect, it } from "vitest";
import { guardedFetch, MAX_REDIRECTS, type GuardedFetchDeps } from "../src/fetch/guarded-fetch";
import { BlockedUrlError, checkUrl, isBlockedAddress } from "../src/fetch/ip-guard";
import { FakeWeb, html, PUBLIC_IP, PUBLIC_IP_2, redirect } from "./fixtures/fakeweb";

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1", "127.8.8.8", "10.1.2.3", "172.16.5.4", "172.31.255.255", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "192.0.0.192", "198.18.0.1",
    "::1", "::", "fe80::1", "fd00:ec2::254", "fc00::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1",
    "::ffff:a9fe:a9fe", "64:ff9b::7f00:1", "2002:7f00:1::", "not-an-ip",
  ])("blocks %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])("allows %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe("checkUrl", () => {
  it.each([
    ["ftp://example.com/file", /scheme/],
    ["file:///etc/passwd", /scheme/],
    ["javascript:alert(1)", /scheme/],
    ["data:text/html,hi", /scheme/],
    ["https://user:pass@example.com/", /credentials/],
    ["https://example.com:8443/", /port/],
    ["http://localhost/", /local/],
    ["http://app.localhost/", /local/],
    ["http://printer.local/", /local/],
    ["http://db.internal/", /local/],
    ["http://metadata.google.internal/", /local/],
    ["http://intranet/", /public domain/],
    ["http://127.0.0.1/", /private/],
    ["http://2130706433/", /private/], // decimal form of 127.0.0.1
    ["http://0x7f000001/", /private/], // hex form of 127.0.0.1
    ["http://[::1]/", /private/],
    ["http://169.254.169.254/latest/meta-data/", /private/],
  ])("rejects %s", (url, reason) => {
    expect(() => checkUrl(url)).toThrow(BlockedUrlError);
    expect(() => checkUrl(url)).toThrow(reason);
  });

  it("accepts public http and https URLs on default ports", () => {
    expect(checkUrl("https://smithtax.example/about").hostname).toBe("smithtax.example");
    expect(checkUrl("http://93.184.216.34/").hostname).toBe("93.184.216.34");
    expect(checkUrl("https://example.com:443/").port).toBe("");
  });
});

function deps(web: FakeWeb, over: Partial<GuardedFetchDeps> = {}): GuardedFetchDeps {
  return {
    resolver: web.resolver,
    transport: web.transport,
    userAgent: "ClearPathLeadConsole/0.1 (+https://contact.example/)",
    timeoutMs: 1000,
    maxBytes: 100_000,
    ...over,
  };
}

describe("guardedFetch", () => {
  it("connects to the address it resolved and vetted, and sends the user agent", async () => {
    const web = new FakeWeb().host("a.example", [PUBLIC_IP]).route("https://a.example/", html("smithtax/about.html"));
    const r = await guardedFetch("https://a.example/", "html", deps(web));
    expect(r.ok).toBe(true);
    expect(web.requests).toHaveLength(1);
    expect(web.requests[0]!.address).toBe(PUBLIC_IP);
    expect(web.requests[0]!.headers["user-agent"]).toBe("ClearPathLeadConsole/0.1 (+https://contact.example/)");
  });

  it("refuses a host that resolves to a private address without connecting", async () => {
    const web = new FakeWeb().host("evil.example", ["10.0.0.5"]);
    const r = await guardedFetch("https://evil.example/", "html", deps(web));
    expect(r).toMatchObject({ ok: false, category: "blocked" });
    expect(web.requests).toHaveLength(0);
  });

  it("refuses when any of several answers is private", async () => {
    const web = new FakeWeb().host("mixed.example", [PUBLIC_IP, "127.0.0.1"]);
    expect(await guardedFetch("https://mixed.example/", "html", deps(web))).toMatchObject({ ok: false, category: "blocked" });
    expect(web.requests).toHaveLength(0);
  });

  it("re-checks every redirect: a hop into cloud metadata is blocked", async () => {
    const web = new FakeWeb()
      .host("a.example", [PUBLIC_IP])
      .route("https://a.example/go", redirect("http://169.254.169.254/latest/meta-data/", 302));
    const r = await guardedFetch("https://a.example/go", "html", deps(web));
    expect(r).toMatchObject({ ok: false, category: "blocked", finalUrl: "http://169.254.169.254/latest/meta-data/" });
    expect(web.requests.map((q) => q.url)).toEqual(["https://a.example/go"]);
  });

  it("blocks DNS rebinding: the host re-resolves to loopback on the redirect hop", async () => {
    let calls = 0;
    const web = new FakeWeb()
      .host("rebind.example", () => (++calls === 1 ? [PUBLIC_IP] : ["127.0.0.1"]))
      .route("https://rebind.example/", redirect("https://rebind.example/admin"));
    const r = await guardedFetch("https://rebind.example/", "html", deps(web));
    expect(r).toMatchObject({ ok: false, category: "blocked" });
    expect(web.resolveCalls).toEqual(["rebind.example", "rebind.example"]);
    // The only connection made went to the vetted public address.
    expect(web.requests.map((q) => q.address)).toEqual([PUBLIC_IP]);
  });

  it("re-checks the scheme on redirect", async () => {
    const web = new FakeWeb().host("a.example", [PUBLIC_IP]).route("https://a.example/", redirect("file:///etc/passwd"));
    expect(await guardedFetch("https://a.example/", "html", deps(web))).toMatchObject({ ok: false, category: "blocked" });
  });

  it(`follows up to ${MAX_REDIRECTS} redirects and refuses the sixth`, async () => {
    const chain = (n: number) => {
      const web = new FakeWeb().host("r.example", [PUBLIC_IP]);
      for (let i = 0; i < n; i++) web.route(`https://r.example/${i}`, redirect(`https://r.example/${i + 1}`));
      web.route(`https://r.example/${n}`, html("smithtax/about.html"));
      return web;
    };
    const five = await guardedFetch("https://r.example/0", "html", deps(chain(5)));
    expect(five).toMatchObject({ ok: true, finalUrl: "https://r.example/5" });
    const six = await guardedFetch("https://r.example/0", "html", deps(chain(6)));
    expect(six).toMatchObject({ ok: false, category: "redirects" });
  });

  it("follows a cross-host redirect only after vetting the new host", async () => {
    const web = new FakeWeb()
      .host("a.example", [PUBLIC_IP])
      .host("www.a.example", [PUBLIC_IP_2])
      .route("https://a.example/", redirect("https://www.a.example/"))
      .route("https://www.a.example/", html("smithtax/about.html"));
    const r = await guardedFetch("https://a.example/", "html", deps(web));
    expect(r).toMatchObject({ ok: true, finalUrl: "https://www.a.example/" });
    expect(web.requests.map((q) => q.address)).toEqual([PUBLIC_IP, PUBLIC_IP_2]);
  });

  it("skips non-HTML content (PDF) without reading the body", async () => {
    const web = new FakeWeb()
      .host("a.example", [PUBLIC_IP])
      .route("https://a.example/file", { status: 200, headers: { "content-type": "application/pdf" }, body: "%PDF" });
    expect(await guardedFetch("https://a.example/file", "html", deps(web))).toMatchObject({ ok: false, category: "type" });
    expect(web.requests[0]!.bodyRead).toBe(false);
  });

  it("does not read non-200 HTML bodies", async () => {
    const web = new FakeWeb().host("a.example", [PUBLIC_IP]);
    expect(await guardedFetch("https://a.example/missing", "html", deps(web))).toMatchObject({ ok: false, status: 404 });
    expect(web.requests[0]!.bodyRead).toBe(false);
  });

  it("caps the body size and marks it truncated", async () => {
    const web = new FakeWeb()
      .host("a.example", [PUBLIC_IP])
      .route("https://a.example/", { status: 200, headers: { "content-type": "text/html" }, body: "x".repeat(5000) });
    const r = await guardedFetch("https://a.example/", "html", deps(web, { maxBytes: 1000 }));
    expect(r).toMatchObject({ ok: true, truncated: true });
    if (r.ok) expect(r.body.length).toBe(1000);
  });

  it("reports network failures and DNS failures", async () => {
    const web = new FakeWeb().host("a.example", [PUBLIC_IP]);
    web.failConnect.add("https://a.example/");
    expect(await guardedFetch("https://a.example/", "html", deps(web))).toMatchObject({ ok: false, category: "network" });
    expect(await guardedFetch("https://nowhere.example/", "html", deps(web))).toMatchObject({ ok: false, category: "dns" });
  });

  it("lets beforeRequest (robots) refuse a hop", async () => {
    const web = new FakeWeb().host("a.example", [PUBLIC_IP]);
    const r = await guardedFetch("https://a.example/x", "html", deps(web, { beforeRequest: async () => "disallowed by robots.txt" }));
    expect(r).toMatchObject({ ok: false, category: "robots" });
    expect(web.requests).toHaveLength(0);
  });
});
