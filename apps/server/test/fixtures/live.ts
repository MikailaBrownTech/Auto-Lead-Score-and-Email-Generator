import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DnsResolver } from "../../src/dns/lookup";
import type { FixtureManifest } from "../../src/fetch/recording";
import { FakeWeb } from "./fakeweb";

const LIVE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "live");

export interface LiveFixture {
  name: string;
  manifest: FixtureManifest;
  web: FakeWeb;
  dns: DnsResolver;
  /** The model's recorded tool inputs, in call order (first pass, then retry). */
  toolInputs: unknown[];
}

/**
 * Replays a site recorded with `npm run extract-live -- <url> --refresh --record`: every HTTP answer,
 * DNS answer, and model tool call exactly as seen live, with no network and no API.
 */
export function loadLiveFixture(name: string): LiveFixture {
  const dir = path.join(LIVE_DIR, name);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as FixtureManifest;
  const web = new FakeWeb();
  for (const [host, ips] of Object.entries(manifest.hosts)) web.host(host, ips);
  for (const [url, r] of Object.entries(manifest.routes)) {
    web.route(url, { status: r.status, headers: r.headers, ...(r.file ? { body: fs.readFileSync(path.join(dir, r.file)) } : {}) });
  }
  const answer = <T>(key: string): Promise<T> => {
    const rec = manifest.dns[key];
    if (!rec) return Promise.reject(Object.assign(new Error(`not recorded: ${key}`), { code: "ESERVFAIL" }));
    if (rec.code) return Promise.reject(Object.assign(new Error(`${key} ${rec.code}`), { code: rec.code }));
    return Promise.resolve(rec.answer as T);
  };
  const dns: DnsResolver = { resolveMx: (n) => answer(`MX ${n}`), resolveTxt: (n) => answer(`TXT ${n}`) };
  return { name, manifest, web, dns, toolInputs: manifest.model.map((m) => m.toolInput) };
}

export const LIVE_FIXTURES = fs.existsSync(LIVE_DIR) ? fs.readdirSync(LIVE_DIR).filter((d) => fs.existsSync(path.join(LIVE_DIR, d, "manifest.json"))) : [];
