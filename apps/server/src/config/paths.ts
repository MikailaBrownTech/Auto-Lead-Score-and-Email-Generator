import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repository root (three levels up from apps/server/src/config). */
export const REPO_ROOT = path.resolve(here, "../../../..");

export function fromRoot(...parts: string[]): string {
  return path.resolve(REPO_ROOT, ...parts);
}
