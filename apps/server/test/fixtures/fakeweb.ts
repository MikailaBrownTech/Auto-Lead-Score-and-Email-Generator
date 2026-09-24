import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HostRateLimiter } from "../../src/fetch/rate-limit";
import type { HttpTransport, Resolver } from "../../src/fetch/transport";

const HTML_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "html");

export interface Route {
  status: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Path under test/fixtures/html. */
  file?: string;
}

export const html = (file: string): Route => ({ status: 200, headers: { "content-type": "text/html; charset=utf-8" }, file });
export const redirect = (location: string, status = 301): Route => ({ status, headers: { location } });
export const text = (body: string, status = 200): Route => ({ status, headers: { "content-type": "text/plain" }, body });

/**
 * An in-memory internet for tests: DNS answers and HTTP routes keyed by exact URL. Records every
 * connection with the address it was pinned to. No real network is touched.
 */
export class FakeWeb {
  readonly routes = new Map<string, Route>();
  readonly dns = new Map<string, string[] | (() => string[])>();
  readonly requests: { url: string; address: string; headers: Record<string, string>; bodyRead: boolean }[] = [];
  readonly resolveCalls: string[] = [];
  failConnect = new Set<string>();

  route(url: string, r: Route): this {
    this.routes.set(url, r);
    return this;
  }

  host(name: string, ips: string[] | (() => string[])): this {
    this.dns.set(name, ips);
    return this;
  }

  resolver: Resolver = async (host) => {
    this.resolveCalls.push(host);
    const entry = this.dns.get(host);
    if (!entry) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    const ips = typeof entry === "function" ? entry() : entry;
    return ips.map((address) => ({ address, family: address.includes(":") ? (6 as const) : (4 as const) }));
  };

  transport: HttpTransport = async ({ url, address, headers }) => {
    const record = { url: url.toString(), address: address.address, headers, bodyRead: false };
    this.requests.push(record);
    if (this.failConnect.has(url.toString())) throw new Error("connect ECONNREFUSED");
    const r = this.routes.get(url.toString()) ?? {
      status: 404,
      headers: { "content-type": "text/html" },
      body: "<html><body>Not found</body></html>",
    };
    const body = r.file ? fs.readFileSync(path.join(HTML_DIR, r.file)) : Buffer.from(r.body ?? "");
    return {
      status: r.status,
      headers: r.headers ?? {},
      readBody: async (max) => {
        record.bodyRead = true;
        return { body: body.subarray(0, max), truncated: body.length > max };
      },
      discard: async () => undefined,
    };
  };
}

/**
 * A limiter on a fake clock. Like a real timer, a sleep moves the clock forward only when it
 * finishes (to the time it was due), so concurrent callers all see the same "now" when they queue.
 */
export function fakeLimiter(intervalMs = 1000) {
  let t = 0;
  const sleeps: number[] = [];
  const limiter = new HostRateLimiter(
    intervalMs,
    () => t,
    async (ms) => {
      sleeps.push(ms);
      const due = t + ms;
      await Promise.resolve();
      t = Math.max(t, due);
    },
  );
  return { limiter, sleeps, now: () => t, advance: (ms: number) => (t += ms) };
}

export const PUBLIC_IP = "93.184.216.34";
export const PUBLIC_IP_2 = "93.184.216.35";

/** The three sample sites plus hosts used for failure cases. */
export function sampleWeb(): FakeWeb {
  const web = new FakeWeb();
  // smithtax.example: tax preparer; robots disallows /private/.
  web
    .host("smithtax.example", [PUBLIC_IP])
    .route("https://smithtax.example/robots.txt", text("User-agent: *\nDisallow: /private/\n"))
    .route("http://smithtax.example/robots.txt", text("User-agent: *\nDisallow: /private/\n"))
    .route("http://smithtax.example/", redirect("https://smithtax.example/"))
    .route("https://smithtax.example/", html("smithtax/index.html"))
    .route("https://smithtax.example/about", html("smithtax/about.html"))
    .route("https://smithtax.example/services", html("smithtax/services.html"))
    .route("https://smithtax.example/contact", html("smithtax/contact.html"))
    .route("https://smithtax.example/privacy-policy", html("smithtax/privacy-policy.html"));

  // oakcpa.example: CPA; no robots.txt (404); redirect, PDF, and a redirect into cloud metadata.
  web
    .host("oakcpa.example", [PUBLIC_IP_2])
    .host("www.oakcpa.example", [PUBLIC_IP_2])
    .route("https://oakcpa.example/", redirect("https://www.oakcpa.example/"))
    .route("https://www.oakcpa.example/", html("oakcpa/index.html"))
    .route("https://www.oakcpa.example/about-us", redirect("/about/"))
    .route("https://www.oakcpa.example/about/", html("oakcpa/about.html"))
    .route("https://www.oakcpa.example/our-team", html("oakcpa/our-team.html"))
    .route("https://www.oakcpa.example/services", { status: 200, headers: { "content-type": "application/pdf" }, body: "%PDF-1.7" })
    .route("https://www.oakcpa.example/security", html("oakcpa/security.html"))
    .route("https://www.oakcpa.example/contact", redirect("http://169.254.169.254/latest/meta-data/", 302));

  // brightbooks.example: bookkeeper; JavaScript-only homepage; robots sets Crawl-delay: 2.
  web
    .host("brightbooks.example", [PUBLIC_IP])
    .route("https://brightbooks.example/robots.txt", text("User-agent: *\nCrawl-delay: 2\nAllow: /\n"))
    .route("https://brightbooks.example/", html("brightbooks/index.html"));

  // down.example: robots.txt returns 503, so the whole site is off limits this run.
  web
    .host("down.example", [PUBLIC_IP])
    .route("https://down.example/robots.txt", { status: 503, headers: { "content-type": "text/html" }, body: "busy" })
    .route("https://down.example/", html("smithtax/index.html"));

  // pinepayroll.example: page with prompt-injection text (used in Milestone 3 too).
  web.host("pinepayroll.example", [PUBLIC_IP]).route("https://pinepayroll.example/", html("injection/index.html"));

  return web;
}
