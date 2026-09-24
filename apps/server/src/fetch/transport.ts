import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import { Agent, request } from "undici";

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Resolves a hostname to every address it has. Tests inject a fake; production uses the OS resolver. */
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export const systemResolver: Resolver = async (hostname) => {
  const all = await dnsLookup(hostname, { all: true, verbatim: true });
  return all.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
};

export interface TransportRequest {
  url: URL;
  /** The already-vetted IP to connect to. The hostname is still used for the Host header and TLS SNI. */
  address: ResolvedAddress;
  headers: Record<string, string>;
  timeoutMs: number;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  /** Reads at most maxBytes; `truncated` is true when the body was longer. */
  readBody(maxBytes: number): Promise<{ body: Buffer; truncated: boolean }>;
  /** Releases the connection without reading the body. */
  discard(): Promise<void>;
}

/** One HTTP GET with no redirect following. Tests inject a fake that serves saved fixtures. */
export type HttpTransport = (req: TransportRequest) => Promise<TransportResponse>;

/**
 * Destroying an undici body emits an AbortError; without a listener that would be an uncaught
 * exception and take the server down. Swallow it: we are deliberately abandoning the body.
 */
function abandon(body: NodeJS.ReadableStream & { destroy(): void }): void {
  body.on("error", () => undefined);
  body.destroy();
}

function flattenHeaders(raw: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined) out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

/**
 * Real transport. The socket connects to the pinned IP via a custom lookup, so a second DNS answer
 * (DNS rebinding) can never redirect this request to a different address.
 */
export const undiciTransport: HttpTransport = async ({ url, address, headers, timeoutMs }) => {
  const pinned: LookupFunction = (_hostname, options, callback) => {
    const cb = callback as (...args: unknown[]) => void;
    if (options && (options as { all?: boolean }).all) cb(null, [{ address: address.address, family: address.family }]);
    else cb(null, address.address, address.family);
  };
  const agent = new Agent({
    connect: { lookup: pinned, timeout: timeoutMs },
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  });
  const signal = AbortSignal.timeout(timeoutMs);
  const close = () => agent.close().catch(() => undefined);

  let res: Awaited<ReturnType<typeof request>>;
  try {
    res = await request(url, { method: "GET", headers, dispatcher: agent, signal });
  } catch (err) {
    await close();
    throw err;
  }

  return {
    status: res.statusCode,
    headers: flattenHeaders(res.headers),
    async readBody(maxBytes) {
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      try {
        for await (const chunk of res.body) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
          if (size + buf.length > maxBytes) {
            chunks.push(buf.subarray(0, maxBytes - size));
            size = maxBytes;
            truncated = true;
            break;
          }
          chunks.push(buf);
          size += buf.length;
        }
      } finally {
        if (truncated) abandon(res.body);
        await close();
      }
      return { body: Buffer.concat(chunks), truncated };
    },
    async discard() {
      abandon(res.body);
      await close();
    },
  };
};
