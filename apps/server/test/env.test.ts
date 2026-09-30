import { describe, expect, it } from "vitest";
import { EnvError, parseEnv } from "../src/config/env";

const valid = {
  ANTHROPIC_API_KEY: "sk-ant-test-key-abcdef",
  MODEL_EXTRACT: "claude-haiku-4-5",
  MODEL_WRITE: "claude-sonnet-5",
  MONTHLY_SPEND_CAP_USD: "10",
  CONTACT_URL: "https://www.clearpathsecure.com/contact",
  SUPABASE_URL: "https://pqejkprfilamahyfvtqf.supabase.co",
  SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
};

describe("parseEnv", () => {
  it("accepts a minimal valid config and applies defaults", () => {
    const env = parseEnv(valid);
    expect(env.MONTHLY_SPEND_CAP_USD).toBe(10);
    expect(env.MAX_TOKENS_PER_PAGE).toBe(6000);
    expect(env.MAX_INPUT_TOKENS_PER_LEAD).toBe(30000);
    expect(env.QUEUE_CONCURRENCY).toBe(2);
    expect(env.PORT).toBe(8787);
    expect(env.WEB_ORIGINS).toEqual(["http://localhost:5173", "http://127.0.0.1:5173"]);
    expect(env.FETCH_TIMEOUT_MS).toBe(15_000);
    expect(env.FETCH_MAX_BYTES).toBe(2_000_000);
  });

  it("lists every missing variable by name", () => {
    expect(() => parseEnv({})).toThrowError(EnvError);
    try {
      parseEnv({});
    } catch (err) {
      const msg = (err as Error).message;
      for (const name of ["ANTHROPIC_API_KEY", "MODEL_EXTRACT", "MODEL_WRITE", "MONTHLY_SPEND_CAP_USD"]) {
        expect(msg).toContain(name);
      }
    }
  });

  it("rejects the .env.example placeholder key", () => {
    expect(() => parseEnv({ ...valid, ANTHROPIC_API_KEY: "sk-ant-your-real-key-here" })).toThrow(/placeholder/);
  });

  it("never echoes the key value in the error message", () => {
    const secret = "not-a-real-key-SECRET123";
    try {
      parseEnv({ ...valid, ANTHROPIC_API_KEY: secret });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain(secret);
      expect((err as Error).message).toContain("ANTHROPIC_API_KEY");
    }
  });

  it("rejects a zero, negative, or non-numeric spend cap", () => {
    expect(() => parseEnv({ ...valid, MONTHLY_SPEND_CAP_USD: "0" })).toThrow(/MONTHLY_SPEND_CAP_USD/);
    expect(() => parseEnv({ ...valid, MONTHLY_SPEND_CAP_USD: "-5" })).toThrow(/MONTHLY_SPEND_CAP_USD/);
    expect(() => parseEnv({ ...valid, MONTHLY_SPEND_CAP_USD: "ten" })).toThrow(/MONTHLY_SPEND_CAP_USD/);
  });

  it("requires CONTACT_URL as a full http(s) URL", () => {
    const { CONTACT_URL: _omit, ...rest } = valid;
    void _omit;
    expect(() => parseEnv(rest)).toThrow(/CONTACT_URL/);
    expect(() => parseEnv({ ...valid, CONTACT_URL: "clearpathsecure.com" })).toThrow(/CONTACT_URL/);
    expect(() => parseEnv({ ...valid, CONTACT_URL: "ftp://clearpathsecure.com" })).toThrow(/CONTACT_URL/);
  });

  it("rejects non-integer token caps", () => {
    expect(() => parseEnv({ ...valid, MAX_TOKENS_PER_PAGE: "abc" })).toThrow(/MAX_TOKENS_PER_PAGE/);
  });
});
