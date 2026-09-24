import { describe, expect, it, vi } from "vitest";
import { isRetryable, withBackoff } from "../src/llm/retry";
import { apiError } from "./helpers";

const noSleep = () => Promise.resolve();

describe("isRetryable", () => {
  it("retries rate-limit (429) and overloaded (529) only", () => {
    expect(isRetryable(apiError(429))).toBe(true);
    expect(isRetryable(apiError(529))).toBe(true);
    for (const s of [400, 401, 403, 404, 413, 500]) expect(isRetryable(apiError(s))).toBe(false);
    expect(isRetryable(new Error("network"))).toBe(false);
  });
});

describe("withBackoff", () => {
  it("retries 429 then succeeds", async () => {
    const fn = vi.fn().mockRejectedValueOnce(apiError(429)).mockRejectedValueOnce(apiError(529)).mockResolvedValue("ok");
    await expect(withBackoff(fn, { sleep: noSleep })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry a 400", async () => {
    const fn = vi.fn().mockRejectedValue(apiError(400));
    await expect(withBackoff(fn, { sleep: noSleep })).rejects.toMatchObject({ status: 400 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxRetries", async () => {
    const fn = vi.fn().mockRejectedValue(apiError(529));
    await expect(withBackoff(fn, { sleep: noSleep, maxRetries: 3 })).rejects.toMatchObject({ status: 529 });
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("grows the delay exponentially and honors retry-after", async () => {
    const delays: number[] = [];
    const fn = vi
      .fn()
      .mockRejectedValueOnce(apiError(529))
      .mockRejectedValueOnce(apiError(529))
      .mockRejectedValueOnce(apiError(429, { "retry-after": "20" }))
      .mockResolvedValue("ok");
    await withBackoff(fn, {
      sleep: async (ms) => void delays.push(ms),
      random: () => 1,
      baseDelayMs: 1000,
    });
    expect(delays).toEqual([1000, 2000, 20_000]);
  });
});
