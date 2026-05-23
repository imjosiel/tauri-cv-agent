import { Routes, Route, NavLink } from "react-router-dom";
import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "./store/appStore";
import PageSearch from "./pages/PageSearch";
import PageNightMode from "./pages/PageNightMode";
import PageResumes from "./pages/PageResumes";
import PageHistory from "./pages/PageHistory";
import PageReport from "./pages/PageReport";
import styles from "./App.module.css";

const NAV = [
  { to: "/",        icon: "⌕",  label: "Buscar vagas" },
  { to: "/night",   icon: "☽",  label: "Modo noturno" },
  { to: "/resumes", icon: "⊞",  label: "Currículos"   },
  { to: "/history", icon: "⊡",  label: "Histórico"    },
  { to: "/report",  icon: "⊟",  label: "Relatório"    },
];

export default function App() {
  const { setOllama, setRunning, addEvent } = useAppStore();

  useEffect(() => {
    // Verifica Ollama ao iniciar
    invoke<any>("check_ollama").then(setOllama).catch(console.error);

    // Escuta eventos do backend
    const unlisten: Array<() => void> = [];

    const on = async (event: string, handler: (p: any) => void) => {
      const off = await listen(event, (e) => handler(e.payload));
      unlisten.push(off);
    };

    on("night_started",  () => setRunning(true));
    on("night_finished", (p) => { setRunning(false); addEvent("finished", p); });
    on("night_error",    (p) => { setRunning(false); addEvent("error", p); });
    on("job_found",      (p) => {
      addEvent("found", p);
      try {
        const job = {
          id: p.id,
          title: p.title ?? p.job_title ?? "",
          company: p.company ?? "",
          url: p.url ?? p.link ?? "",
          site: p.site ?? "",
          description: p.description ?? "",
          score: null,
          status: "found",
          applied_at: null,
          resume_path: null,
          skip_reason: null,
          screenshot_path: null,
        };
        invoke("save_job", { job }).catch(console.error);
      } catch (e) { console.error(e); }
    });

    on("job_analyzed",   (p) => {
      addEvent("analyzed", p);
      try {
        const job = {
          id: p.id,
          title: p.title ?? p.job_title ?? "",
          company: p.company ?? "",
          url: p.url ?? p.link ?? "",
          site: p.site ?? "",
          description: p.description ?? "",
          score: p.score ?? null,
          status: "analyzed",
          applied_at: null,
          resume_path: null,
          skip_reason: null,
          screenshot_path: null,
        };
        invoke("save_job", { job }).catch(console.error);
      } catch (e) { console.error(e); }
    });

    on("job_applied",    (p) => {
      addEvent("applied", p);
      try {
        const job = {
          id: p.id,
          title: p.title ?? p.job_title ?? "",
          company: p.company ?? "",
          url: p.url ?? p.link ?? "",
          site: p.site ?? "",
          description: p.description ?? "",
          score: p.score ?? null,
          status: "applied",
          applied_at: p.applied_at ?? new Date().toISOString(),
          resume_path: p.resume_path ?? null,
          skip_reason: null,
          screenshot_path: p.screenshot_path ?? null,
        };
        invoke("save_job", { job }).catch(console.error);
      } catch (e) { console.error(e); }
    });

    on("job_skipped",    (p) => {
      addEvent("skipped", p);
      try {
        const job = {
          id: p.id,
          title: p.title ?? p.job_title ?? "",
          company: p.company ?? "",
          url: p.url ?? p.link ?? "",
          site: p.site ?? "",
          description: p.description ?? "",
          score: p.score ?? null,
          status: "skipped",
          applied_at: null,
          resume_path: null,
          skip_reason: p.skip_reason ?? p.reason ?? null,
          screenshot_path: p.screenshot_path ?? null,
        };
        invoke("save_job", { job }).catch(console.error);
      } catch (e) { console.error(e); }
    });
    on("captcha_detected",(p) => addEvent("captcha", p));
    on("night_progress", (p) => addEvent("progress", p));

    return () => unlisten.forEach((f) => f());
  }, []);

  return (
    <div className={styles.shell}>
      <nav className={styles.sidebar}>
        <div className={styles.logo}>
          <span className={styles.logoIcon}>◈</span>
          <span className={styles.logoText}>CV Agent</span>
        </div>

        {NAV.map(({ to, icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === "/"}
            className={({ isActive }) =>
              `${styles.navItem} ${isActive ? styles.navActive : ""}`
            }
          >
            <span className={styles.navIcon}>{icon}</span>
            <span>{label}</span>
          </NavLink>
        ))}

        <div className={styles.sidebarBottom}>
          <OllamaIndicator />
        </div>
      </nav>

      <main className={styles.main}>
        <Routes>
          <Route path="/"        element={<PageSearch />} />
          <Route path="/night"   element={<PageNightMode />} />
          <Route path="/resumes" element={<PageResumes />} />
          <Route path="/history" element={<PageHistory />} />
          <Route path="/report"  element={<PageReport />} />
        </Routes>
      </main>
    </div>
  );
}

function OllamaIndicator() {
  const { ollama } = useAppStore();
  return (
    <div className={styles.ollamaStatus}>
      <span
        className={styles.statusDot}
        style={{ background: ollama?.connected ? "var(--green)" : "var(--red)" }}
      />
      <span className={styles.statusText}>
        {ollama?.connected
          ? (ollama.model ?? "Ollama conectado")
          : "Ollama offline"}
      </span>
    </div>
  );
}
