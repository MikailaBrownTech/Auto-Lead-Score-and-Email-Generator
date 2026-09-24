import { DNS_EVIDENCE_RE, countWords } from "@clearpath/shared";
import { describe, expect, it } from "vitest";
import { loadMxProviders, lookupDns, mailDomainFor, mxProviderName, type DnsResolver } from "../src/dns/lookup";

const providers = loadMxProviders();

function fakeDns(answers: {
  mx?: { exchange: string; priority: number }[] | string;
  txt?: string[][] | string;
  dmarc?: string[][] | string;
}): DnsResolver {
  const reply = <T>(v: T | string | undefined): Promise<T> => {
    if (v === undefined) return Promise.reject(Object.assign(new Error("queryTxt ENODATA"), { code: "ENODATA" }));
    if (typeof v === "string") return Promise.reject(Object.assign(new Error(`query ${v}`), { code: v }));
    return Promise.resolve(v);
  };
  return {
    resolveMx: () => reply(answers.mx),
    resolveTxt: (name) => (name.startsWith("_dmarc.") ? reply(answers.dmarc) : reply(answers.txt)),
  };
}

describe("lookupDns", () => {
  it("reads MX provider, SPF, and DMARC policy; DKIM is always NOT_CHECKED", async () => {
    const { dns, failures } = await lookupDns(
      "smithtax.example",
      fakeDns({
        mx: [
          { exchange: "alt1.aspmx.l.google.com", priority: 5 },
          { exchange: "aspmx.l.google.com", priority: 1 },
        ],
        txt: [["google-site-verification=abc"], ["v=spf1 include:_spf.google.com ", "~all"]],
        dmarc: [["v=DMARC1; p=none; rua=mailto:dmarc@smithtax.example"]],
      }),
      providers,
    );
    expect(failures).toEqual([]);
    expect(dns.mx_provider).toEqual({ value: "Google Workspace", evidence_url: "dns:MX smithtax.example", evidence_quote: "1 aspmx.l.google.com" });
    expect(dns.spf_present).toMatchObject({ value: true, evidence_quote: "v=spf1 include:_spf.google.com ~all" });
    expect(dns.dmarc_present).toMatchObject({ value: true, evidence_url: "dns:TXT _dmarc.smithtax.example" });
    expect(dns.dmarc_policy).toMatchObject({ value: "none" });
    expect(dns.dkim).toBe("NOT_CHECKED");
  });

  it("a definitive 'no DMARC record' is a finding (dmarc_present=false), not NOT_FOUND", async () => {
    const { dns } = await lookupDns("a.example", fakeDns({ txt: [["v=spf1 -all"]], dmarc: "ENOTFOUND" }), providers);
    expect(dns.dmarc_present).toEqual({ value: false, evidence_url: "dns:TXT _dmarc.a.example", evidence_quote: "no record (ENOTFOUND)" });
    expect(dns.dmarc_policy).toBe("NOT_FOUND");
  });

  it("no SPF among TXT records -> spf_present=false with evidence", async () => {
    const { dns } = await lookupDns("a.example", fakeDns({ txt: [["some-verification"]] }), providers);
    expect(dns.spf_present).toMatchObject({ value: false, evidence_url: "dns:TXT a.example" });
  });

  it("lookup errors (SERVFAIL, timeout) leave fields NOT_FOUND and are recorded", async () => {
    const { dns, failures } = await lookupDns("a.example", fakeDns({ mx: "ESERVFAIL", txt: "ETIMEOUT", dmarc: "ESERVFAIL" }), providers);
    expect(dns.mx_provider).toBe("NOT_FOUND");
    expect(dns.spf_present).toBe("NOT_FOUND");
    expect(dns.dmarc_present).toBe("NOT_FOUND");
    expect(failures).toHaveLength(3);
  });

  it("multiple DMARC records: present, but no policy applies", async () => {
    const { dns, failures } = await lookupDns(
      "a.example",
      fakeDns({ txt: [], dmarc: [["v=DMARC1; p=reject"], ["v=DMARC1; p=none"]] }),
      providers,
    );
    expect(dns.dmarc_present).toMatchObject({ value: true });
    expect(dns.dmarc_policy).toBe("NOT_FOUND");
    expect(failures[0]).toMatch(/2 DMARC records/);
  });

  it("evidence always matches the dossier's DNS evidence format and the 15-word limit", async () => {
    const longSpf = "v=spf1 " + Array.from({ length: 30 }, (_, i) => `include:s${i}.example`).join(" ") + " -all";
    const { dns } = await lookupDns(
      "a.example",
      fakeDns({ mx: [{ exchange: "mx.unknownhost.example", priority: 10 }], txt: [[longSpf]], dmarc: [["v=DMARC1; p=quarantine"]] }),
      providers,
    );
    for (const f of [dns.mx_provider, dns.spf_present, dns.dmarc_present, dns.dmarc_policy]) {
      if (f === "NOT_FOUND") continue;
      expect(f.evidence_url).toMatch(DNS_EVIDENCE_RE);
      expect(countWords(f.evidence_quote)).toBeLessThanOrEqual(15);
    }
    expect(dns.mx_provider).toMatchObject({ value: "Other (unknownhost.example)" });
  });

  it("maps MX hosts to providers and strips www. for the mail domain", () => {
    expect(mxProviderName("smithtax-example.mail.protection.outlook.com.", providers)).toBe("Microsoft 365");
    expect(mxProviderName("mx1.smithtax.example.pphosted.com", providers)).toBe("Proofpoint");
    expect(mailDomainFor("WWW.Oakcpa.example")).toBe("oakcpa.example");
  });
});
