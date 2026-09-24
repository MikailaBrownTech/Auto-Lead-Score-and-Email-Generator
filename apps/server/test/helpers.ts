import Anthropic from "@anthropic-ai/sdk";

/** Builds the same typed error the SDK throws for an HTTP status. */
export function apiError(status: number, headers: Record<string, string> = {}) {
  return Anthropic.APIError.generate(status, { type: "error" }, `status ${status}`, new Headers(headers));
}
