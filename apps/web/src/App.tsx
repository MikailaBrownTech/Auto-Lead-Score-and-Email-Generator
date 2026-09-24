import { CacheWarnings } from "./components/CacheWarnings";
import { SpendMeter } from "./components/SpendMeter";

export function App() {
  return (
    <div className="app">
      <header className="app-header">
        <h1>ClearPath Lead Console</h1>
        <SpendMeter />
      </header>
      <CacheWarnings />
      <main>
        <p className="muted">Milestone 0: scaffold. Screens arrive in Milestone 5.</p>
      </main>
    </div>
  );
}
