import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore, NightConfig } from "../store/appStore";
import styles from "./PageNightMode.module.css";

const SITES = [
  { id: "linkedin",  label: "LinkedIn"  },
  { id: "indeed",    label: "Indeed"    },
  { id: "catho",     label: "Catho"     },
  { id: "infojobs",  label: "InfoJobs"  },
  { id: "glassdoor", label: "Glassdoor" },
];

const MODES = [
  {
    id: "dry_run",
    icon: "◎",
    label: "Dry-run",
    desc: "Prepara tudo, não envia. Você aprova de manhã.",
  },
  {
    id: "autonomous",
    icon: "⬡",
    label: "Autônomo",
    desc: "Envia dentro dos limites que você definir.",
  },
  {
    id: "manual",
    icon: "⏸",
    label: "Manual",
    desc: "Pausa e aguarda sua aprovação em cada envio.",
  },
] as const;

export default function PageNightMode() {
  const { nightConfig, setNightConfig, running, setRunning, liveEvents, clearEvents, ollama } =
    useAppStore();
  const [query, setQuery] = useState("desenvolvedor");
  const [error, setError] = useState("");
  const [newCompany, setNewCompany] = useState("");

  const cfg = nightConfig;
  const set = (patch: Partial<NightConfig>) => setNightConfig(patch);

  async function handleStart() {
    if (!ollama?.connected) {
      setError("Ollama não está conectado. Inicie o Ollama antes de continuar.");
      return;
    }
    setError("");
    clearEvents();
    try {
      await invoke("start_night_mode", { config: cfg, query });
    } catch (e: any) {
      setError(e.toString());
    }
  }

  async function handleStop() {
    await invoke("stop_night_mode");
    setRunning(false);
  }

  function addToBlacklist() {
    const c = newCompany.trim();
    if (!c || cfg.blacklist.includes(c)) return;
    set({ blacklist: [...cfg.blacklist, c] });
    setNewCompany("");
  }

  function removeFromBlacklist(company: string) {
    set({ blacklist: cfg.blacklist.filter((b) => b !== company) });
  }

  function toggleSite(id: string) {
    const has = cfg.sites.includes(id);
    set({ sites: has ? cfg.sites.filter((s) => s !== id) : [...cfg.sites, id] });
  }

  const applied  = liveEvents.filter((e) => e.type === "applied").length;
  const captchas = liveEvents.filter((e) => e.type === "captcha").length;
  const skipped  = liveEvents.filter((e) => e.type === "skipped").length;

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Modo noturno</h1>
          <p className={styles.subtitle}>Configure e deixe o agente trabalhar enquanto você dorme</p>
        </div>
        {running ? (
          <button className={styles.btnStop} onClick={handleStop}>
            ⏹ Parar
          </button>
        ) : (
          <button className={styles.btnStart} onClick={handleStart}>
            ▶ Iniciar
          </button>
        )}
      </div>

      {error && <div className={styles.error}>{error}</div>}

      {running && (
        <div className={styles.liveBar}>
          <span className={styles.liveDot} />
          <span>Rodando · </span>
          <span className={styles.liveStats}>
            {applied} enviada(s) · {skipped} pulada(s) · {captchas} CAPTCHA(s)
          </span>
        </div>
      )}

      <div className={styles.grid}>
        {/* Coluna esquerda - configuração */}
        <div className={styles.col}>

          {/* Busca */}
          <section className={styles.card}>
            <div className={styles.cardTitle}>O que buscar</div>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="ex: desenvolvedor React pleno São Paulo"
            />
          </section>

          {/* Modo */}
          <section className={styles.card}>
            <div className={styles.cardTitle}>Modo de operação</div>
            <div className={styles.modeGrid}>
              {MODES.map((m) => (
                <button
                  key={m.id}
                  className={`${styles.modeCard} ${cfg.mode === m.id ? styles.modeActive : ""}`}
                  onClick={() => set({ mode: m.id })}
                >
                  <span className={styles.modeIcon}>{m.icon}</span>
                  <span className={styles.modeName}>{m.label}</span>
                  <span className={styles.modeDesc}>{m.desc}</span>
                </button>
              ))}
            </div>
          </section>

          {/* Sites */}
          <section className={styles.card}>
            <div className={styles.cardTitle}>Sites de busca</div>
            <div className={styles.siteGrid}>
              {SITES.map((s) => (
                <label key={s.id} className={styles.siteToggle}>
                  <input
                    type="checkbox"
                    checked={cfg.sites.includes(s.id)}
                    onChange={() => toggleSite(s.id)}
                  />
                  <span>{s.label}</span>
                </label>
              ))}
            </div>
          </section>
        </div>

        {/* Coluna direita - limites e opções */}
        <div className={styles.col}>

          {/* Limites (só no modo autônomo) */}
          {cfg.mode === "autonomous" && (
            <section className={styles.card}>
              <div className={styles.cardTitle}>Limites</div>

              <SliderRow
                label="Score mínimo de fit"
                sub="Só candidata em vagas acima deste valor"
                value={cfg.min_score}
                min={40} max={95}
                format={(v) => `${v}%`}
                onChange={(v) => set({ min_score: v })}
              />
              <SliderRow
                label="Máx. candidaturas por noite"
                sub="Distribui ao longo da noite"
                value={cfg.max_per_night}
                min={1} max={30}
                format={(v) => `${v}`}
                onChange={(v) => set({ max_per_night: v })}
              />
              <SliderRow
                label="Intervalo entre envios"
                sub="Tempo mínimo randomizado"
                value={cfg.delay_minutes}
                min={2} max={30}
                format={(v) => `${v} min`}
                onChange={(v) => set({ delay_minutes: v })}
              />
            </section>
          )}

          {/* Opções */}
          <section className={styles.card}>
            <div className={styles.cardTitle}>Opções</div>

            <ToggleRow
              label="Gerar cover letter"
              sub="IA escreve carta de apresentação por vaga"
              value={cfg.cover_letter}
              onChange={(v) => set({ cover_letter: v })}
            />
            <ToggleRow
              label="Pular no CAPTCHA"
              sub="Se ativado, pula a vaga e continua; se desativado, tenta resolver manualmente"
              value={cfg.stop_on_captcha}
              onChange={(v) => set({ stop_on_captcha: v })}
            />
          </section>

          {/* Blacklist */}
          <section className={styles.card}>
            <div className={styles.cardTitle}>Empresas bloqueadas</div>
            <div className={styles.tagWrap}>
              {cfg.blacklist.map((c) => (
                <span key={c} className={styles.tag}>
                  {c}
                  <button onClick={() => removeFromBlacklist(c)}>×</button>
                </span>
              ))}
            </div>
            <div className={styles.addRow}>
              <input
                type="text"
                value={newCompany}
                onChange={(e) => setNewCompany(e.target.value)}
                placeholder="Nome da empresa..."
                onKeyDown={(e) => e.key === "Enter" && addToBlacklist()}
              />
              <button className={styles.btnAdd} onClick={addToBlacklist}>+</button>
            </div>
          </section>
        </div>
      </div>

      {/* Feed de eventos ao vivo */}
      {liveEvents.length > 0 && (
        <section className={styles.card} style={{ marginTop: 0 }}>
          <div className={styles.cardTitle}>Eventos ao vivo</div>
          <div className={styles.eventFeed}>
            {liveEvents.slice(0, 40).map((e, i) => (
              <EventRow key={i} event={e} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ── Sub-componentes ────────────────────────────────────────────────────────────

function SliderRow({
  label, sub, value, min, max, format, onChange,
}: {
  label: string; sub: string; value: number;
  min: number; max: number; format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <div className={styles.sliderRow}>
      <div>
        <div className={styles.rowLabel}>{label}</div>
        <div className={styles.rowSub}>{sub}</div>
      </div>
      <div className={styles.sliderRight}>
        <input
          type="range" min={min} max={max} value={value} step={1}
          onChange={(e) => onChange(Number(e.target.value))}
          style={{ width: 100 }}
        />
        <span className={styles.sliderVal}>{format(value)}</span>
      </div>
    </div>
  );
}

function ToggleRow({
  label, sub, value, onChange,
}: {
  label: string; sub: string; value: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className={styles.sliderRow}>
      <div>
        <div className={styles.rowLabel}>{label}</div>
        <div className={styles.rowSub}>{sub}</div>
      </div>
      <div
        className={`${styles.toggleTrack} ${value ? styles.toggleOn : ""}`}
        onClick={() => onChange(!value)}
      >
        <div className={styles.toggleKnob} />
      </div>
    </div>
  );
}

const EVENT_COLORS: Record<string, string> = {
  applied:  "var(--green)",
  found:    "var(--blue)",
  analyzed: "var(--accent)",
  skipped:  "var(--text3)",
  captcha:  "var(--amber)",
  error:    "var(--red)",
};

const EVENT_LABELS: Record<string, string> = {
  applied:  "Enviado",
  found:    "Encontrado",
  analyzed: "Analisado",
  skipped:  "Pulado",
  captcha:  "CAPTCHA",
  error:    "Erro",
  progress: "Info",
  finished: "Concluído",
};

function EventRow({ event }: { event: { type: string; payload: any; ts: number } }) {
  const color = EVENT_COLORS[event.type] ?? "var(--text3)";
  const label = EVENT_LABELS[event.type] ?? event.type;
  const p = event.payload ?? {};
  const desc = p.title
    ? `${p.title} — ${p.company ?? ""}`
    : p.message ?? p.error ?? "";

  return (
    <div className={styles.eventRow}>
      <span className={styles.eventBadge} style={{ background: color + "22", color }}>
        {label}
      </span>
      <span className={styles.eventDesc}>{desc}</span>
      {p.score != null && (
        <span className={styles.eventScore}>{p.score}%</span>
      )}
      <span className={styles.eventTime}>
        {new Date(event.ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
      </span>
    </div>
  );
}
