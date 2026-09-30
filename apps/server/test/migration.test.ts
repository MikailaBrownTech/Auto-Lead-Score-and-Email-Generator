import { describe, expect, it } from "vitest";
import type { MigrationClient } from "../src/migration/client";
import { formatReport, runMigration, type TablePlan } from "../src/migration/run";
import { leadEventRow, leadRows, runRow, sequenceRow, settingsRow, suppressionRow } from "../src/migration/transform";

/** An in-memory fake standing in for Supabase, so the orchestration logic needs no live project. */
function fakeClient(opts: { failTable?: string } = {}): { client: MigrationClient; tables: Map<string, Record<string, unknown>[]> } {
  const tables = new Map<string, Record<string, unknown>[]>();
  const client: MigrationClient = {
    async insert(table, idColumn, rows) {
      if (table === opts.failTable) return { ids: [], error: `simulated failure inserting into ${table}` };
      const existing = tables.get(table) ?? [];
      tables.set(table, [...existing, ...rows]);
      return { ids: rows.map((r) => r[idColumn]), error: null };
    },
    async count(table) {
      return { count: (tables.get(table) ?? []).length, error: null };
    },
    async deleteByIds(table, idColumn, ids) {
      const existing = tables.get(table) ?? [];
      const idSet = new Set(ids);
      tables.set(
        table,
        existing.filter((r) => !idSet.has(r[idColumn])),
      );
      return { error: null };
    },
  };
  return { client, tables };
}

const plans: TablePlan[] = [
  { table: "leads", idColumn: "id", rows: [{ id: "lead-a" }, { id: "lead-b" }] },
  { table: "lead_sequences", idColumn: "id", rows: [{ id: 1, lead_id: "lead-a" }] },
];

describe("runMigration", () => {
  it("dry run: inserts everything, reports the counts, then deletes it all again", async () => {
    const { client, tables } = fakeClient();
    const result = await runMigration(client, plans, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.hasErrors).toBe(false);
    expect(result.tables).toEqual([
      { table: "leads", sourceCount: 2, destinationCountAfterInsert: 2, error: null },
      { table: "lead_sequences", sourceCount: 1, destinationCountAfterInsert: 1, error: null },
    ]);
    // Cleaned up: nothing left in the fake "Supabase" after a dry run.
    expect(tables.get("leads")).toEqual([]);
    expect(tables.get("lead_sequences")).toEqual([]);
  });

  it("--commit: inserts everything and leaves it there", async () => {
    const { client, tables } = fakeClient();
    const result = await runMigration(client, plans, { dryRun: false });

    expect(result.dryRun).toBe(false);
    expect(tables.get("leads")).toHaveLength(2);
    expect(tables.get("lead_sequences")).toHaveLength(1);
  });

  it("a table's insert error is reported and flagged, not silently skipped", async () => {
    const { client } = fakeClient({ failTable: "lead_sequences" });
    const result = await runMigration(client, plans, { dryRun: true });

    expect(result.hasErrors).toBe(true);
    const seq = result.tables.find((t) => t.table === "lead_sequences")!;
    expect(seq.error).toMatch(/simulated failure/);
    expect(seq.destinationCountAfterInsert).toBe(0);
    // leads still succeeded and is reported as such.
    expect(result.tables.find((t) => t.table === "leads")!.error).toBeNull();
  });

  it("formatReport: a clean dry run reads as a match with nothing dropped", async () => {
    const { client } = fakeClient();
    const result = await runMigration(client, plans, { dryRun: true });
    const report = formatReport(result);
    expect(report).toMatch(/DRY RUN/);
    expect(report).toMatch(/leads\s+2\s+2\s+match/);
    expect(report).toMatch(/lead_sequences\s+1\s+1\s+match/);
    expect(report).toMatch(/Every table's row count matched\. Nothing was dropped\./);
  });

  it("formatReport: an error is never reported as a match", async () => {
    const { client } = fakeClient({ failTable: "leads" });
    const result = await runMigration(client, plans, { dryRun: true });
    const report = formatReport(result);
    expect(report).toMatch(/leads\s+2\s+0\s+ERROR \(simulated failure inserting into leads\)/);
    expect(report).toMatch(/Some tables had errors/);
  });
});

describe("transform: SQLite rows -> Supabase rows", () => {
  it("leadRows: splits the lead row from its dossier, and parses the JSON columns", () => {
    const { lead, dossier } = leadRows({
      id: "lead-a",
      inputUrl: "https://a.example",
      source: "web",
      status: "extracted",
      dossierJson: JSON.stringify({ firm_name: { value: "A Firm" } }),
      score: 70,
      tier: "B",
      gateStatus: "qualified",
      gateReasonsJson: JSON.stringify(["reason one"]),
      gateApproved: false,
      directContactOverrideReason: null,
      directContactOverrideAt: null,
      incompleteData: false,
      error: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(lead).toMatchObject({ id: "lead-a", status: "extracted", gate_reasons: ["reason one"], gate_approved: false });
    expect(dossier).toEqual({ lead_id: "lead-a", dossier: { firm_name: { value: "A Firm" } }, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-02T00:00:00.000Z" });
  });

  it("leadRows: no dossier row for a lead with no research yet", () => {
    const { dossier } = leadRows({
      id: "lead-b",
      inputUrl: null,
      source: "web",
      status: "new",
      dossierJson: null,
      score: null,
      tier: null,
      gateStatus: null,
      gateReasonsJson: null,
      gateApproved: false,
      directContactOverrideReason: null,
      directContactOverrideAt: null,
      incompleteData: false,
      error: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(dossier).toBeNull();
  });

  it("sequenceRow, leadEventRow, runRow, suppressionRow: parse their JSON text columns", () => {
    const seq = sequenceRow({
      id: 1,
      leadId: "lead-a",
      tier: "B",
      status: "passed",
      sequenceJson: JSON.stringify({ emails: [] }),
      validationJson: JSON.stringify({ pass: true, issues: [] }),
      judgeJson: null,
      approvedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(seq).toMatchObject({ id: 1, sequence: { emails: [] }, validation: { pass: true, issues: [] }, judge: null });

    expect(leadEventRow({ id: 1, leadId: "lead-a", kind: "write_attempt", detail: "x", createdAt: "2026-01-01T00:00:00.000Z" })).toEqual({
      id: 1,
      lead_id: "lead-a",
      kind: "write_attempt",
      detail: "x",
      created_at: "2026-01-01T00:00:00.000Z",
    });

    expect(
      runRow(
        {
          id: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          model: "claude-sonnet-5",
          callType: "write",
          leadId: "lead-a",
          status: "ok",
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cacheWrite5mTokens: null,
          cacheWrite1hTokens: null,
          prefixKey: null,
          costUsd: 0.01,
          stopReason: "end_turn",
          messageId: "msg_1",
          error: null,
        },
        new Set(["lead-a"]),
      ),
    ).toMatchObject({ id: 1, call_type: "write", cost_usd: 0.01, lead_id: "lead-a" });
  });

  it("runRow: nulls out lead_id when it no longer matches any migrated lead (deleted lead, or an old record-sequences.ts fixture)", () => {
    const row = runRow(
      {
        id: 2,
        createdAt: "2026-01-01T00:00:00.000Z",
        model: "claude-sonnet-5",
        callType: "extract",
        leadId: "record-essentialacctg-com",
        status: "ok",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheWrite5mTokens: null,
        cacheWrite1hTokens: null,
        prefixKey: null,
        costUsd: 0.02,
        stopReason: "end_turn",
        messageId: "msg_2",
        error: null,
      },
      new Set(["lead-a", "lead-b"]), // "record-essentialacctg-com" is not among the leads being migrated
    );
    expect(row).toMatchObject({ id: 2, call_type: "extract", cost_usd: 0.02, lead_id: null });
  });

  it("suppressionRow", () => {
    expect(suppressionRow({ id: 1, kind: "domain", value: "example.com", createdAt: "2026-01-01T00:00:00.000Z" })).toEqual({
      id: 1,
      kind: "domain",
      value: "example.com",
      created_at: "2026-01-01T00:00:00.000Z",
    });
  });

  it("settingsRow: docs/01 + the spend cap become the one settings row", () => {
    const row = settingsRow(
      {
        sender_name: "Mikaila Brown",
        sender_title: "Founder",
        company_name: "ClearPath IT",
        company_website: "https://www.clearpathsecure.com",
        opt_out_line: "Reply no and I will not email again.",
        physical_address: "100 E Broad St, Columbus, OH 43215",
        approved_proof: [],
        founding_client_offer: "half off the first three months",
        booking_link: "https://cal.example.com/clearpath",
        region: "Columbus-area",
        company_one_liner: "",
        include_dns_observation: false,
        checklist_ready: true,
      },
      10,
    );
    expect(row).toMatchObject({ id: true, sender_name: "Mikaila Brown", monthly_spend_cap_usd: 10, checklist_ready: true });
  });
});
