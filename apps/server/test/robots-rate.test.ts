import { describe, expect, it } from "vitest";
import { RobotsPolicy } from "../src/fetch/robots";
import { FakeWeb, fakeLimiter, PUBLIC_IP, text } from "./fixtures/fakeweb";

function policy(web: FakeWeb, limiter = fakeLimiter().limiter) {
  return new RobotsPolicy(
    { resolver: web.resolver, transport: web.transport, userAgent: "ClearPathLeadConsole/0.1 (+x)", timeoutMs: 1000, maxBytes: 500_000 },
    limiter,
  );
}

describe("robots.txt", () => {
  it("applies Disallow rules", async () => {
    const web = new FakeWeb().host("a.example", [PUBLIC_IP]).route("https://a.example/robots.txt", text("User-agent: *\nDisallow: /private/\n"));
    const p = policy(web);
    expect(await p.check(new URL("https://a.example/about"))).toEqual({ allowed: true });
    expect(await p.check(new URL("https://a.example/private/x"))).toMatchObject({ allowed: false, reason: /robots/ });
  });

  it("honors rules aimed at our own user agent token", async () => {
    const web = new FakeWeb()
      .host("a.example", [PUBLIC_IP])
      .route("https://a.example/robots.txt", text("User-agent: *\nAllow: /\n\nUser-agent: ClearPathLeadConsole\nDisallow: /\n"));
    expect(await policy(web).check(new URL("https://a.example/"))).toMatchObject({ allowed: false });
  });

  it("treats 4xx as no robots.txt: everything allowed", async () => {
    const web = new FakeWeb().host("a.example", [PUBLIC_IP]); // robots.txt route missing -> 404
    expect(await policy(web).check(new URL("https://a.example/anything"))).toEqual({ allowed: true });
  });

  it("treats 5xx as disallowed for the whole run and records it once", async () => {
    const web = new FakeWeb()
      .host("a.example", [PUBLIC_IP])
      .route("https://a.example/robots.txt", { status: 503, headers: { "content-type": "text/html" }, body: "down" });
    const p = policy(web);
    expect(await p.check(new URL("https://a.example/"))).toMatchObject({ allowed: false });
    expect(await p.check(new URL("https://a.example/about"))).toMatchObject({ allowed: false });
    expect(p.failures).toHaveLength(1);
    expect(p.failures[0]).toMatch(/robots\.txt for https:\/\/a\.example unavailable \(HTTP 503\)/);
    expect(web.requests.filter((r) => r.url.endsWith("/robots.txt"))).toHaveLength(1);
  });

  it("treats an unreachable robots.txt as disallowed", async () => {
    const web = new FakeWeb().host("a.example", [PUBLIC_IP]);
    web.failConnect.add("https://a.example/robots.txt");
    const p = policy(web);
    expect(await p.check(new URL("https://a.example/"))).toMatchObject({ allowed: false });
    expect(p.failures[0]).toMatch(/unavailable/);
  });

  it("fetches robots.txt through the SSRF guard (a private host is unavailable, not allowed)", async () => {
    const web = new FakeWeb().host("a.example", ["192.168.0.10"]);
    const p = policy(web);
    expect(await p.check(new URL("https://a.example/"))).toMatchObject({ allowed: false });
    expect(web.requests).toHaveLength(0);
  });

  it("applies Crawl-delay to the host's rate limit", async () => {
    const web = new FakeWeb()
      .host("a.example", [PUBLIC_IP])
      .route("https://a.example/robots.txt", text("User-agent: *\nCrawl-delay: 3\n"));
    const { limiter } = fakeLimiter();
    await policy(web, limiter).check(new URL("https://a.example/"));
    expect(limiter.intervalFor("a.example")).toBe(3000);
  });
});

describe("HostRateLimiter", () => {
  it("spaces requests to one host at least 1 second apart", async () => {
    const { limiter, sleeps } = fakeLimiter();
    await limiter.acquire("a.example");
    await limiter.acquire("a.example");
    await limiter.acquire("A.EXAMPLE");
    expect(sleeps).toEqual([1000, 1000]);
  });

  it("does not delay different hosts", async () => {
    const { limiter, sleeps } = fakeLimiter();
    await limiter.acquire("a.example");
    await limiter.acquire("b.example");
    expect(sleeps).toEqual([]);
  });

  it("queues concurrent callers in order", async () => {
    const { limiter, sleeps, now } = fakeLimiter();
    await Promise.all([1, 2, 3].map(() => limiter.acquire("a.example")));
    // All three queued at t=0: the second waits 1s, the third 2s.
    expect(sleeps).toEqual([1000, 2000]);
    expect(now()).toBe(2000);
  });

  it("never lowers the interval below 1 second", () => {
    const { limiter } = fakeLimiter();
    limiter.setInterval("a.example", 200);
    expect(limiter.intervalFor("a.example")).toBe(1000);
  });
});
