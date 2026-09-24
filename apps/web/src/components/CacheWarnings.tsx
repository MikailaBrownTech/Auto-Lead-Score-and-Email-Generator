import { useEffect, useState } from "react";
import { CacheHealthSchema, type CacheWarning } from "@clearpath/shared";

/** Banner shown when a cacheable static prefix got zero cache reads over its recent calls. */
export function CacheWarnings() {
  const [warnings, setWarnings] = useState<CacheWarning[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/cache-health");
        if (!res.ok) return;
        const data = CacheHealthSchema.parse(await res.json());
        if (!cancelled) setWarnings(data.warnings);
      } catch {
        // The spend meter already reports API connectivity problems.
      }
    }
    void load();
    const id = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (warnings.length === 0) return null;
  return (
    <div className="banner banner-warn" role="alert">
      <strong>Prompt caching is not working</strong> for{" "}
      {warnings.map((w) => `${w.callType} (${w.model})`).join(", ")}: the last {warnings[0]!.recentCalls} calls
      read nothing from cache, so every call pays full input price. Likely causes: the static prefix is below the
      model's minimum cacheable size, something that changes per call is inside it, or calls are more than 5
      minutes apart.
    </div>
  );
}
