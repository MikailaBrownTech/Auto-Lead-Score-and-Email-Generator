import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { DnsResolver } from "../dns/lookup";
import type { MessagesApi } from "../llm/client";
import type { HttpTransport, Resolver } from "./transport";

/**
 * Wraps the real network, DNS, and model clients and records everything a lead's run saw, so it can
 * be replayed offline as a regression fixture (test/fixtures/live/<name>/manifest.json + bodies).
 */
export interface FixtureManifest {
  capturedAt: string;
  input: string;
  routes: Record<string, { status: number; headers: Record<string, string>; file?: string }>;
  hosts: Record<string, string[]>;
  dns: Record<string, { answer?: unknown; code?: string }>;
  model: { callIndex: number; toolInput: unknown }[];
}

export class Recorder {
  private readonly manifests = new Map<string, FixtureManifest>();
  private readonly bodies = new Map<string, Map<string, Buffer>>();
  current: string | null = null;

  start(name: string, input: string): void {
    this.current = name;
    if (!this.manifests.has(name)) {
      this.manifests.set(name, { capturedAt: new Date().toISOString(), input, routes: {}, hosts: {}, dns: {}, model: [] });
      this.bodies.set(name, new Map());
    }
  }

  private get m(): FixtureManifest | null {
    return this.current ? this.manifests.get(this.current)! : null;
  }

  resolver(inner: Resolver): Resolver {
    return async (host) => {
      const answer = await inner(host);
      if (this.m) this.m.hosts[host] = answer.map((a) => a.address);
      return answer;
    };
  }

  transport(inner: HttpTransport): HttpTransport {
    return async (req) => {
      const res = await inner(req);
      const m = this.m;
      const bodies = this.current ? this.bodies.get(this.current)! : null;
      const url = req.url.toString();
      const headers: Record<string, string> = {};
      for (const k of ["content-type", "location"]) if (res.headers[k]) headers[k] = res.headers[k]!;
      if (m) m.routes[url] = { status: res.status, headers };
      return {
        ...res,
        readBody: async (max) => {
          const r = await res.readBody(max);
          if (m && bodies) {
            const ext = /xml/.test(headers["content-type"] ?? "") ? "xml" : /text\/plain/.test(headers["content-type"] ?? "") ? "txt" : "html";
            const file = `body-${Object.keys(m.routes).indexOf(url)}.${ext}`;
            m.routes[url]!.file = file;
            bodies.set(file, r.body);
          }
          return r;
        },
      };
    };
  }

  dnsResolver(inner: DnsResolver): DnsResolver {
    const wrap = <T>(kind: string, fn: (name: string) => Promise<T>) => async (name: string) => {
      const key = `${kind} ${name}`;
      try {
        const answer = await fn(name);
        if (this.m) this.m.dns[key] = { answer };
        return answer;
      } catch (err) {
        if (this.m) this.m.dns[key] = { code: (err as NodeJS.ErrnoException).code ?? "ERROR" };
        throw err;
      }
    };
    return { resolveMx: wrap("MX", (n) => inner.resolveMx(n)), resolveTxt: wrap("TXT", (n) => inner.resolveTxt(n)) };
  }

  api(inner: MessagesApi): MessagesApi {
    return {
      messages: {
        countTokens: (p) => inner.messages.countTokens(p),
        create: async (p: Anthropic.MessageCreateParamsNonStreaming) => {
          const msg = await inner.messages.create(p);
          const m = this.m;
          if (m) {
            const tool = msg.content.find((b) => b.type === "tool_use") as Anthropic.ToolUseBlock | undefined;
            m.model.push({ callIndex: m.model.length, toolInput: tool?.input ?? null });
          }
          return msg;
        },
      },
    };
  }

  save(rootDir: string): string[] {
    const written: string[] = [];
    for (const [name, manifest] of this.manifests) {
      const dir = path.join(rootDir, name);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      for (const [file, body] of this.bodies.get(name)!) fs.writeFileSync(path.join(dir, file), body);
      fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
      written.push(dir);
    }
    return written;
  }
}
