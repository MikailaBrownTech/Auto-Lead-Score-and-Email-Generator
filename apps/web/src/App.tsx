import { AuthProvider, useAuth } from "./auth";
import { CacheWarnings } from "./components/CacheWarnings";
import { SpendMeter } from "./components/SpendMeter";
import { Icon, type IconName } from "./components/ui";
import { signOut } from "./lib/supabase";
import { ExportPage } from "./pages/Export";
import { ImportPage } from "./pages/Import";
import { LeadDetailPage } from "./pages/LeadDetail";
import { LeadsPage } from "./pages/Leads";
import { LoginPage } from "./pages/Login";
import { SequencePage, SequencesPage } from "./pages/Sequence";
import { SettingsPage } from "./pages/Settings";
import { href, useRoute } from "./router";

const NAV: [string, string, IconName][] = [
  ["import", "Import", "import"],
  ["leads", "Leads", "leads"],
  ["sequences", "Sequences", "mail"],
  ["export", "Export", "download"],
  ["settings", "Settings", "settings"],
];

/** Self-contained: carries its own auth state, so it can be rendered standalone (including in tests). */
export function App() {
  return (
    <AuthProvider>
      <AuthedApp />
    </AuthProvider>
  );
}

function AuthedApp() {
  const { session } = useAuth();
  if (session === undefined) return <div className="shell" aria-busy="true" />;
  if (session === null) return <LoginPage />;
  return <Shell email={session.user.email ?? null} />;
}

function Shell(props: { email: string | null }) {
  const [page = "leads", id] = useRoute();
  let body;
  let where: string;
  if (page === "import") [body, where] = [<ImportPage />, "Import"];
  else if (page === "leads" && id) [body, where] = [<LeadDetailPage key={id} id={id} />, "Leads / Lead"];
  else if (page === "sequences" && id) [body, where] = [<SequencePage key={id} id={id} />, "Sequences / Sequence"];
  else if (page === "sequences") [body, where] = [<SequencesPage />, "Sequences"];
  else if (page === "export") [body, where] = [<ExportPage />, "Export"];
  else if (page === "settings") [body, where] = [<SettingsPage />, "Settings"];
  else [body, where] = [<LeadsPage />, "Leads"];
  const current = NAV.some(([p]) => p === page) ? page : "leads";
  return (
    <div className="shell">
      <aside className="sidebar-col">
        <div className="sidebar">
        <a className="brand" href={href("leads")} aria-label="ClearPath Lead Console">
          <span className="brand-mark" aria-hidden="true">
            CP
          </span>
          <span className="brand-text">
            <strong>ClearPath</strong>
            <span>Lead Console</span>
          </span>
        </a>
        <nav className="nav" aria-label="Main">
          {NAV.map(([p, label, icon]) => (
            <a key={p} href={href(p)} className={`nav-link${current === p ? " active" : ""}`} aria-current={current === p ? "page" : undefined} title={label}>
              <Icon name={icon} />
              <span>{label}</span>
            </a>
          ))}
        </nav>
        <div className="sidebar-foot sidebar-account">
          <span className="break">{props.email ?? "Signed in"}</span>
          <button type="button" className="link-button" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <span className="topbar-title">{where}</span>
          <SpendMeter />
        </header>
        <main className="content">
          <CacheWarnings />
          {body}
        </main>
      </div>
    </div>
  );
}
