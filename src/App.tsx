import { Routes, Route, NavLink } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
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
    active: boolean; pct: number; message: string;
  }>({ active: false, pct: 0, message: "" });

  // Ref para garantir que os listeners só são registrados uma vez,
  // mesmo em StrictMode (que monta/desmonta componentes duas vezes em dev).
  const listenersRegistered = useRef(false);

  useEffect(() => {
    invoke<any>("check_ollama").then(setOllama).catch(console.error);

    // Carrega currículos do disco uma única vez
    if (!resumesLoaded) {
      invoke<ResumePackage[]>("load_saved_resume_packages")
        .then((pkgs) => { setResumePackages(pkgs ?? []); setResumesLoaded(true); })
        .catch(() => setResumesLoaded(true));
    }

    // Evita registro duplo de listeners (React StrictMode monta duas vezes em dev)
    if (listenersRegistered.current) return;
    listenersRegistered.current = true;

    const unlisten: Array<() => void> = [];
    const on = (event: string, handler: (p: any) => void) => {
      listen(event, (e) => handler(e.payload)).then((off) => unlisten.push(off));
    };

    // ── TinyTeX ──────────────────────────────────────────────────────────────
    on("texlive_progress", (p: { pct: number; message: string }) => {
      if (p.pct >= 100) {
        setTexInstall({ active: true, pct: 100, message: p.message });
        setTimeout(() => setTexInstall({ active: false, pct: 0, message: "" }), 1500);
      } else {
        setTexInstall({ active: true, pct: p.pct, message: p.message });
      }
    });

    // ── Modo noturno ─────────────────────────────────────────────────────────
    on("night_started",  () => setRunning(true));
    on("night_finished", (p) => { setRunning(false); addEvent("finished", p); });
    on("night_error",    (p) => { setRunning(false); addEvent("error", p); });

    on("job_found", (p) => {
      addEvent("found", p);
      saveJob({ ...p, status: "found" });
    });

    on("job_analyzed", (p) => {
      addEvent("analyzed", p);
      saveJob({ ...p, status: "analyzed" });
    });

    on("job_applied", (p) => {
      addEvent("applied", p);
      saveJob({ ...p, status: "applied" });
    });

    on("job_skipped", (p) => {
      addEvent("skipped", p);
      saveJob({ ...p, status: "skipped" });
    });

    on("captcha_detected",     (p) => { addEvent("captcha",  p); saveJob({ ...p, status: "captcha" }); });
    on("night_progress",       (p) => addEvent("progress", p));
    on("job_awaiting_approval",(p) => addEvent("approval", p));

    return () => {
      unlisten.forEach((f) => f());
      listenersRegistered.current = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function saveJob(p: any) {
  // Garante que todos os campos obrigatórios estejam presentes
  // antes de enviar ao backend — evita erros de deserialização no Rust.
  const job = {
    id:              p.id              ?? crypto.randomUUID(),
    title:           p.title           ?? p.job_title ?? "",
    company:         p.company         ?? "",
    url:             p.url             ?? p.link      ?? "",
    site:            p.site            ?? "",
    description:     p.description     ?? "",
    score:           p.score           ?? null,
    status:          p.status          ?? "found",
    applied_at:      p.applied_at      ?? null,
    resume_path:     p.resume_path     ?? null,
    skip_reason:     p.skip_reason     ?? p.reason ?? null,
    screenshot_path: p.screenshot_path ?? null,
  };
  invoke("save_job", { job }).catch(console.error);
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
