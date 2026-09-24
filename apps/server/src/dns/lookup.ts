import dns from "node:dns/promises";
import fs from "node:fs";
import { NOT_FOUND, type DnsFindings } from "@clearpath/shared";
import { z } from "zod";
import { fromRoot } from "../config/paths";

/** The DNS queries this module makes. Tests inject a fake; nothing here contacts the prospect's servers. */
export interface DnsResolver {
  resolveMx(name: string): Promise<{ exchange: string; priority: number }[]>;
  resolveTxt(name: string): Promise<string[][]>;
}

export const systemDnsResolver: DnsResolver = {
  resolveMx: (name) => dns.resolveMx(name),
  resolveTxt: (name) => dns.resolveTxt(name),
};

const MxProvidersSchema = z.object({
  providers: z.array(z.object({ suffix: z.string().min(1), name: z.string().min(1) })),
});
export type MxProvider = z.infer<typeof MxProvidersSchema>["providers"][number];

export function loadMxProviders(file = fromRoot("config/mx-providers.json")): MxProvider[] {
  return MxProvidersSchema.parse(JSON.parse(fs.readFileSync(file, "utf8"))).providers;
}

/** "No such record" answers: the record definitively does not exist. */
const NO_RECORD_CODES = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN"]);

type Answer<T> = { kind: "records"; records: T } | { kind: "none"; code: string } | { kind: "error"; message: string };

async function ask<T>(fn: () => Promise<T>): Promise<Answer<T>> {
  try {
    return { kind: "records", records: await fn() };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    if (NO_RECORD_CODES.has(code)) return { kind: "none", code };
    return { kind: "error", message: `${code || "error"}: ${(err as Error).message}` };
  }
}

/** First 15 words, so DNS evidence obeys the same quote limit as page evidence. */
function quote(text: string): string {
  return text.trim().split(/\s+/).slice(0, 15).join(" ");
}

export function mxProviderName(exchange: string, providers: MxProvider[]): string {
  const host = exchange.toLowerCase().replace(/\.$/, "");
  const match = providers.find((p) => host === p.suffix || host.endsWith(`.${p.suffix}`));
  if (match) return match.name;
  const labels = host.split(".");
  return `Other (${labels.slice(-2).join(".")})`;
}

/** Registrable-ish domain for DNS: the site's host without a leading "www.". */
export function mailDomainFor(host: string): string {
  return host.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
}

/**
 * MX, SPF (TXT on the domain) and DMARC (TXT on _dmarc.domain). Passive public lookups only.
 * A definitive "no record" answer is a finding (e.g. dmarc_present=false); a lookup error is NOT_FOUND
 * plus a failure note. DKIM is never checked (selectors are not public), so it is always NOT_CHECKED.
 */
export async function lookupDns(
  domain: string,
  resolver: DnsResolver,
  providers: MxProvider[],
): Promise<{ dns: DnsFindings; failures: string[] }> {
  const failures: string[] = [];
  const dmarcName = `_dmarc.${domain}`;
  const [mx, txt, dmarcTxt] = await Promise.all([
    ask(() => resolver.resolveMx(domain)),
    ask(() => resolver.resolveTxt(domain)),
    ask(() => resolver.resolveTxt(dmarcName)),
  ]);

  const findings: DnsFindings = {
    mx_provider: NOT_FOUND,
    spf_present: NOT_FOUND,
    dmarc_present: NOT_FOUND,
    dmarc_policy: NOT_FOUND,
    dkim: "NOT_CHECKED",
  };

  // MX
  if (mx.kind === "records" && mx.records.length > 0) {
    const top = [...mx.records].sort((a, b) => a.priority - b.priority)[0]!;
    findings.mx_provider = {
      value: mxProviderName(top.exchange, providers),
      evidence_url: `dns:MX ${domain}`,
      evidence_quote: quote(`${top.priority} ${top.exchange}`),
    };
  } else if (mx.kind === "error") {
    failures.push(`DNS MX ${domain}: ${mx.message}`);
  }

  // SPF
  if (txt.kind === "error") {
    failures.push(`DNS TXT ${domain}: ${txt.message}`);
  } else {
    const records = txt.kind === "records" ? txt.records.map((chunks) => chunks.join("")) : [];
    const spf = records.filter((r) => /^v=spf1(\s|$)/i.test(r.trim()));
    findings.spf_present =
      spf.length > 0
        ? { value: true, evidence_url: `dns:TXT ${domain}`, evidence_quote: quote(spf[0]!) }
        : { value: false, evidence_url: `dns:TXT ${domain}`, evidence_quote: "no v=spf1 record in TXT answers" };
    if (spf.length > 1) failures.push(`DNS TXT ${domain}: ${spf.length} SPF records (only one is valid)`);
  }

  // DMARC
  if (dmarcTxt.kind === "error") {
    failures.push(`DNS TXT ${dmarcName}: ${dmarcTxt.message}`);
  } else {
    const records = dmarcTxt.kind === "records" ? dmarcTxt.records.map((c) => c.join("")) : [];
    const dmarc = records.filter((r) => /^v=DMARC1(\s*;|\s*$)/i.test(r.trim()));
    if (dmarc.length === 0) {
      const why = dmarcTxt.kind === "none" ? `no record (${dmarcTxt.code})` : "no v=DMARC1 record";
      findings.dmarc_present = { value: false, evidence_url: `dns:TXT ${dmarcName}`, evidence_quote: why };
    } else {
      findings.dmarc_present = { value: true, evidence_url: `dns:TXT ${dmarcName}`, evidence_quote: quote(dmarc[0]!) };
      if (dmarc.length > 1) {
        failures.push(`DNS TXT ${dmarcName}: ${dmarc.length} DMARC records, so no policy applies; policy left NOT_FOUND`);
      } else {
        const p = /(?:^|;)\s*p\s*=\s*([a-z]+)/i.exec(dmarc[0]!)?.[1]?.toLowerCase();
        if (p === "none" || p === "quarantine" || p === "reject") {
          findings.dmarc_policy = { value: p, evidence_url: `dns:TXT ${dmarcName}`, evidence_quote: quote(dmarc[0]!) };
        } else {
          failures.push(`DNS TXT ${dmarcName}: DMARC record has no valid p= tag`);
        }
      }
    }
  }

  return { dns: findings, failures };
}
