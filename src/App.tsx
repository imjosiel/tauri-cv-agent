import { Routes, Route, NavLink } from "react-router-dom";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "./store/appStore";
import type { ResumePackage } from "./store/appStore";
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
  const {
    setOllama, setRunning, addEvent,
    setResumePackages, setResumesLoaded, resumesLoaded,
  } = useAppStore();

  const [texInstall, setTexInstall] = useState<{
    active: boolean;
    pct: number;
    message: string;
  }>({ active: false, pct: 0, message: "" });

  useEffect(() => {
    invoke<any>("check_ollama").then(setOllama).catch(console.error);

    // Carrega currículos do disco uma única vez — ficam no store global
    // e sobrevivem à navegação entre abas
    if (!resumesLoaded) {
      invoke<ResumePackage[]>("load_saved_resume_packages")
        .then((pkgs) => {
          setResumePackages(pkgs ?? []);
          setResumesLoaded(true);
        })
        .catch(() => setResumesLoaded(true));
    }

    const unlisten: Array<() => void> = [];
    const on = async (event: string, handler: (p: any) => void) => {
      const off = await listen(event, (e) => handler(e.payload));
      unlisten.push(off);
    };

    // Instalação do TinyTeX
    on("texlive_progress", (p: { pct: number; message: string }) => {
      if (p.pct >= 100) {
        setTexInstall({ active: true, pct: 100, message: p.message });
        setTimeout(() => setTexInstall({ active: false, pct: 0, message: "" }), 1500);
      } else {
        setTexInstall({ active: true, pct: p.pct, message: p.message });
      }
    });

    // Eventos do modo noturno
    on("night_started",  () => setRunning(true));
    on("night_finished", (p) => { setRunning(false); addEvent("finished", p); });
    on("night_error",    (p) => { setRunning(false); addEvent("error", p); });
    on("job_found",      (p) => { addEvent("found",    p); saveJob(p, "found"); });
    on("job_analyzed",   (p) => { addEvent("analyzed", p); saveJob(p, "analyzed", { score: p.score ?? null }); });
    on("job_applied",    (p) => { addEvent("applied",  p); saveJob(p, "applied",  { score: p.score ?? null, applied_at: p.applied_at ?? new Date().toISOString(), resume_path: p.resume_path ?? null }); });
    on("job_skipped",    (p) => { addEvent("skipped",  p); saveJob(p, "skipped",  { score: p.score ?? null, skip_reason: p.skip_reason ?? p.reason ?? null }); });
    on("captcha_detected",    (p) => addEvent("captcha",  p));
    on("night_progress",      (p) => addEvent("progress", p));
    on("job_awaiting_approval",(p) => addEvent("approval", p));

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

      {texInstall.active && (
        <div className={styles.texOverlay}>
          <div className={styles.texCard}>
            <div className={styles.texTitle}>
              {texInstall.pct < 100 ? "⬇ Instalando suporte a PDF" : "✓ Suporte a PDF pronto"}
            </div>
            <div className={styles.texMessage}>{texInstall.message}</div>
            <div className={styles.texBarWrap}>
              <div className={styles.texBar} style={{ width: `${texInstall.pct}%` }} />
            </div>
            <div className={styles.texPct}>{texInstall.pct}%</div>
            {texInstall.pct < 100 && (
              <div className={styles.texNote}>
                Isso acontece apenas uma vez. O TinyTeX (~200 MB) está sendo
                baixado e instalado automaticamente.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function saveJob(p: any, status: string, extra: Record<string, any> = {}) {
  invoke("save_job", {
    job: {
      id: p.id, title: p.title ?? "", company: p.company ?? "",
      url: p.url ?? "", site: p.site ?? "", description: p.description ?? "",
      score: null, status, applied_at: null, resume_path: null,
      skip_reason: null, screenshot_path: null, ...extra,
    },
  }).catch(console.error);
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
        {ollama?.connected ? (ollama.model ?? "Ollama conectado") : "Ollama offline"}
      </span>
    </div>
  );
}
