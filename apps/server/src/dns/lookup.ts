import dns from "node:dns/promises";
import fs from "node:fs";
import { NOT_FOUND, type DnsFindings, type EmailSecurityHint } from "@clearpath/shared";
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
): Promise<{ dns: DnsFindings; failures: string[]; dmarcRecord: string | null }> {
  const failures: string[] = [];
  let dmarcRecord: string | null = null;
  const dmarcName = `_dmarc.${domain}`;
  const [mx, txt, dmarcTxt] = await Promise.all([
    ask(() => resolver.resolveMx(domain)),
    ask(() => resolver.resolveTxt(domain)),
    ask(() => resolver.resolveTxt(dmarcName)),
  ]);

  const findings: DnsFindings = {
    mx_provider: NOT_FOUND,
    no_domain_email: NOT_FOUND,
    spf_present: NOT_FOUND,
    dmarc_present: NOT_FOUND,
    dmarc_policy: NOT_FOUND,
    dkim: "NOT_CHECKED",
  };

  // MX. A definitive "no MX" (NXDOMAIN/NODATA, or a null MX "0 .") means the domain receives no
  // email: recorded as no_domain_email, and SPF/DMARC then score nothing. Lookup errors decide nothing.
  const realMx = mx.kind === "records" ? mx.records.filter((r) => r.exchange && r.exchange !== ".") : [];
  if (realMx.length > 0) {
    const top = [...realMx].sort((a, b) => a.priority - b.priority)[0]!;
    findings.mx_provider = {
      value: mxProviderName(top.exchange, providers),
      evidence_url: `dns:MX ${domain}`,
      evidence_quote: quote(`${top.priority} ${top.exchange}`),
    };
    findings.no_domain_email = { value: false, evidence_url: `dns:MX ${domain}`, evidence_quote: quote(`${top.priority} ${top.exchange}`) };
  } else if (mx.kind === "error") {
    failures.push(`DNS MX ${domain}: lookup failed (${mx.message}); email findings not scored`);
  } else {
    const why = mx.kind === "none" ? `no MX record (${mx.code})` : "null MX record: domain accepts no email";
    findings.no_domain_email = { value: true, evidence_url: `dns:MX ${domain}`, evidence_quote: why };
  }

  // SPF
  if (txt.kind === "error") {
    failures.push(`DNS TXT ${domain}: lookup failed (${txt.message}); SPF not scored`);
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
    failures.push(`DNS TXT ${dmarcName}: lookup failed (${dmarcTxt.message}); DMARC not scored`);
  } else {
    const records = dmarcTxt.kind === "records" ? dmarcTxt.records.map((c) => c.join("")) : [];
    const dmarc = records.filter((r) => /^v=DMARC1(\s*;|\s*$)/i.test(r.trim()));
    if (dmarc.length === 0) {
      const why = dmarcTxt.kind === "none" ? `no record (${dmarcTxt.code})` : "no v=DMARC1 record";
      findings.dmarc_present = { value: false, evidence_url: `dns:TXT ${dmarcName}`, evidence_quote: why };
    } else {
      findings.dmarc_present = { value: true, evidence_url: `dns:TXT ${dmarcName}`, evidence_quote: quote(dmarc[0]!) };
      if (dmarc.length === 1) dmarcRecord = dmarc[0]!;
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

  return { dns: findings, failures, dmarcRecord };
}

const DmarcVendorsSchema = z.object({ vendors: z.array(z.string().trim().toLowerCase().min(3)) });

/** DMARC report-processing services (config/dmarc-vendors.json, editable). */
export function loadDmarcVendors(file = fromRoot("config/dmarc-vendors.json")): string[] {
  return DmarcVendorsSchema.parse(JSON.parse(fs.readFileSync(file, "utf8"))).vendors;
}

function underDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** The mailto: domains of one DMARC tag (rua or ruf). */
export function dmarcReportDomains(record: string, tag: "rua" | "ruf"): string[] {
  const value = new RegExp(`(?:^|;)\\s*${tag}\\s*=\\s*([^;]+)`, "i").exec(record)?.[1] ?? "";
  const domains = [...value.matchAll(/mailto:[^@\s,]+@([a-z0-9.-]+)/gi)].map((m) => m[1]!.toLowerCase().replace(/\.$/, ""));
  return [...new Set(domains)];
}

/**
 * INTERNAL ONLY: DMARC report addresses at an outside domain that is neither the firm's own nor a
 * known DMARC vendor often mean someone (an IT provider) already manages the firm's email. Never
 * sent to the writer and never mentioned in emails; shown in the report and UI only.
 */
export function emailSecurityHint(record: string | null, domain: string, vendors: string[]): EmailSecurityHint | typeof NOT_FOUND {
  if (!record || !domain) return NOT_FOUND;
  const own = domain.toLowerCase().replace(/^www\./, "");
  const rua = dmarcReportDomains(record, "rua");
  const ruf = dmarcReportDomains(record, "ruf");
  const outside = [...new Set([...rua, ...ruf])].filter((d) => !underDomain(d, own) && !underDomain(own, d) && !vendors.some((v) => underDomain(d, v)));
  if (outside.length === 0) return NOT_FOUND;
  return {
    rua_domains: rua,
    ruf_domains: ruf,
    outside_domains: outside,
    evidence_url: `dns:TXT _dmarc.${own}`,
    note: `possible existing IT provider: DMARC reports go to ${outside.join(", ")}`,
  };
}
