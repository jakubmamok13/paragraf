import { useEffect, useState } from "react";
import { DbProvider } from "./ui";
import { runtime, type Runtime } from "./runtime";
import { Today } from "./screens/Today";
import { Subjects } from "./screens/Subjects";
import { Workshop } from "./screens/Workshop";
import { Settings } from "./screens/Settings";
import { Session } from "./screens/Session";
import { Progress } from "./screens/Progress";
import type { SessionPlan } from "@paragraf/core";

type Tab = "today" | "subjects" | "workshop" | "progress" | "settings";
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "today", label: "Dziś", icon: "◎" },
  { id: "subjects", label: "Przedmioty", icon: "§" },
  { id: "workshop", label: "Pracownia", icon: "⚙" },
  { id: "progress", label: "Postęp", icon: "▤" },
  { id: "settings", label: "Ustawienia", icon: "☰" },
];

export function App() {
  const [rt, setRt] = useState<Runtime | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("today");
  const [session, setSession] = useState<{ plan: SessionPlan; mode: string } | null>(null);
  const start = (plan: SessionPlan, mode = "daily") => setSession({ plan, mode });

  useEffect(() => {
    runtime().then(setRt, (e) => setError(String(e)));
  }, []);

  if (error) return <div className="boot">Nie udało się otworzyć bazy danych: {error}</div>;
  if (!rt) return <div className="boot">Paragraf…</div>;

  if (session) {
    return (
      <DbProvider db={rt.db}>
        <Session plan={session.plan} mode={session.mode} onClose={() => setSession(null)} />
      </DbProvider>
    );
  }

  return (
    <DbProvider db={rt.db}>
      <main className="main">
        {tab === "today" && <Today goTo={setTab} onStart={start} />}
        {tab === "progress" && <Progress onStart={start} />}
        {tab === "subjects" && <Subjects />}
        {tab === "workshop" && <Workshop />}
        {tab === "settings" && <Settings />}
      </main>
      <nav className="tabbar">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)} aria-current={tab === t.id}>
            <span className="tab-icon" aria-hidden>
              {t.icon}
            </span>
            {t.label}
          </button>
        ))}
      </nav>
    </DbProvider>
  );
}
