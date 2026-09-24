import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { undiciTransport } from "../src/fetch/transport";

/**
 * Exercises the real undici transport against a throwaway server on the loopback interface. No
 * outside network: "fixture.invalid" has no DNS record, so a successful request proves the socket
 * went to the pinned address rather than through DNS.
 */
describe("undiciTransport (loopback only)", () => {
  let server: http.Server;
  let port = 0;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/hello") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<p>host=${req.headers.host} ua=${req.headers["user-agent"]}</p>`);
      } else if (req.url === "/big") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("x".repeat(300_000));
      } else if (req.url === "/redirect") {
        res.writeHead(302, { location: "/hello" });
        res.end();
      } else if (req.url === "/slow") {
        // never responds
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  const req = (path: string, timeoutMs = 3000) =>
    undiciTransport({
      url: new URL(`http://fixture.invalid:${port}${path}`),
      address: { address: "127.0.0.1", family: 4 },
      headers: { "user-agent": "ClearPathLeadConsole/0.1 (+https://x.example/)" },
      timeoutMs,
    });

  it("connects to the pinned address while sending the original Host header", async () => {
    const res = await req("/hello");
    expect(res.status).toBe(200);
    const { body } = await res.readBody(10_000);
    expect(body.toString()).toBe(`<p>host=fixture.invalid:${port} ua=ClearPathLeadConsole/0.1 (+https://x.example/)</p>`);
  });

  it("does not follow redirects itself", async () => {
    const res = await req("/redirect");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/hello");
    await res.discard();
  });

  it("stops reading at the size cap and reports truncation", async () => {
    const res = await req("/big");
    const { body, truncated } = await res.readBody(50_000);
    expect(truncated).toBe(true);
    expect(body.length).toBe(50_000);
  });

  it("times out a server that never answers", async () => {
    const started = Date.now();
    await expect(req("/slow", 300)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
