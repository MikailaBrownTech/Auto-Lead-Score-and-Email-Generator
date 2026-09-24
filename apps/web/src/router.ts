import { useEffect, useState } from "react";

/** Hash routes: #/import, #/leads, #/leads/<id>, #/sequences/<id>, #/export, #/settings. */
export function useRoute(): string[] {
  const read = () => window.location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const [parts, setParts] = useState<string[]>(read);
  useEffect(() => {
    const on = () => setParts(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return parts;
}

export function href(...parts: (string | number)[]): string {
  return `#/${parts.map((p) => encodeURIComponent(String(p))).join("/")}`;
}

export function navigate(...parts: (string | number)[]): void {
  window.location.hash = href(...parts);
}
