import { CacheWarnings } from "./components/CacheWarnings";
import { SpendMeter } from "./components/SpendMeter";
import { ExportPage } from "./pages/Export";
import { ImportPage } from "./pages/Import";
import { LeadDetailPage } from "./pages/LeadDetail";
import { LeadsPage } from "./pages/Leads";
import { SequencePage, SequencesPage } from "./pages/Sequence";
import { SettingsPage } from "./pages/Settings";
import { href, useRoute } from "./router";

const NAV: [string, string][] = [
  ["import", "Import"],
  ["leads", "Leads"],
  ["sequences", "Sequences"],
  ["export", "Export"],
  ["settings", "Settings"],
];

export function App() {
  const [page = "leads", id] = useRoute();
  let body;
  if (page === "import") body = <ImportPage />;
  else if (page === "leads" && id) body = <LeadDetailPage key={id} id={id} />;
  else if (page === "sequences" && id) body = <SequencePage key={id} id={id} />;
  else if (page === "sequences") body = <SequencesPage />;
  else if (page === "export") body = <ExportPage />;
  else if (page === "settings") body = <SettingsPage />;
  else body = <LeadsPage />;
  return (
    <div className="app">
      <header className="app-header">
        <h1>ClearPath Lead Console</h1>
        <nav>
          {NAV.map(([p, label]) => (
            <a key={p} href={href(p)} className={page === p ? "active" : ""}>
              {label}
            </a>
          ))}
        </nav>
        <SpendMeter />
      </header>
      <CacheWarnings />
      <main>{body}</main>
    </div>
  );
}
