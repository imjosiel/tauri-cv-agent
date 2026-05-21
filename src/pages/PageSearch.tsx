import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../store/appStore";
import styles from "./PageSearch.module.css";

// ── Tipos ─────────────────────────────────────────────────────────────────────

type Modality = "remote" | "hybrid" | "onsite" | "any";

interface SearchFilters {
  query: string;
  modality: Modality;
  locations: string[];
  sites: string[];
  seniority: string;
}

interface JobResult {
  id: string;
  title: string;
  company: string;
  url: string;
  site: string;
  location: string;
  modality?: string;
  score?: number;
  status: string;
  description: string;
}

const SITES = [
  { id: "linkedin",  label: "LinkedIn"  },
  { id: "indeed",    label: "Indeed"    },
  { id: "catho",     label: "Catho"     },
  { id: "infojobs",  label: "InfoJobs"  },
  { id: "glassdoor", label: "Glassdoor" },
];

const SENIORITY = [
  { id: "",         label: "Qualquer"   },
  { id: "estágio",  label: "Estágio"    },
  { id: "júnior",   label: "Júnior"     },
  { id: "pleno",    label: "Pleno"      },
  { id: "sênior",   label: "Sênior"     },
  { id: "lead",     label: "Lead / Tech Lead" },
  { id: "gerente",  label: "Gerente / Manager" },
];

const MODALITIES: { id: Modality; icon: string; label: string; sub: string }[] = [
  { id: "any",    icon: "◈", label: "Qualquer",  sub: "Todos os formatos"         },
  { id: "remote", icon: "⌂", label: "Remoto",    sub: "100% home office"          },
  { id: "hybrid", icon: "⇄", label: "Híbrido",   sub: "Parte presencial"          },
  { id: "onsite", icon: "⊙", label: "Presencial", sub: "Localização importa"      },
];

const SCORE_COLOR = (s: number) =>
  s >= 80 ? "var(--green)" : s >= 60 ? "var(--amber)" : "var(--red)";

// ── Componente principal ──────────────────────────────────────────────────────

export default function PageSearch() {
  const { ollama } = useAppStore();

  const [filters, setFilters] = useState<SearchFilters>({
    query: "",
    modality: "any",
    locations: [],
    sites: ["linkedin", "indeed", "catho", "infojobs"],
    seniority: "",
  });

  const [locationInput, setLocationInput] = useState("");
  const [results, setResults] = useState<JobResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchDone, setSearchDone] = useState(false);
  const [analyzing, setAnalyzing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [debugLog, setDebugLog] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);

  const log = (msg: string) => setDebugLog((prev) => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev].slice(0, 20));

  const set = (patch: Partial<SearchFilters>) =>
    setFilters((f) => ({ ...f, ...patch }));

  function toggleSite(id: string) {
    const has = filters.sites.includes(id);
    set({ sites: has ? filters.sites.filter((s) => s !== id) : [...filters.sites, id] });
  }

  function addLocation() {
    const loc = locationInput.trim();
    if (!loc || filters.locations.includes(loc)) return;
    set({ locations: [...filters.locations, loc] });
    setLocationInput("");
  }

  function removeLocation(loc: string) {
    set({ locations: filters.locations.filter((l) => l !== loc) });
  }

  // Monta query completa com modificadores de modalidade e localização
  function buildQuery(): string {
    let q = filters.query.trim();
    if (filters.seniority) q += ` ${filters.seniority}`;

    const modalityTerms: Record<Modality, string> = {
      remote:  "remoto OR remote OR \"home office\"",
      hybrid:  "híbrido OR hybrid",
      onsite:  "",
      any:     "",
    };
    if (modalityTerms[filters.modality]) q += ` ${modalityTerms[filters.modality]}`;

    return q;
  }

  async function handleSearch() {
    if (!filters.query.trim()) return;
    if (!ollama?.connected) {
      setError("Ollama não está conectado. Inicie o Ollama antes de buscar.");
      return;
    }

    setError("");
    setResults([]);
    setSearching(true);
    setSearchDone(false);
    setDebugLog([]);
    log("Iniciando busca...");

    const unlisteners: (() => void)[] = [];

    const on = async (event: string, handler: (p: any) => void) => {
      const off = await listen<any>(event, (e) => handler(e.payload));
      unlisteners.push(off);
    };

    const cleanup = () => unlisteners.forEach((f) => f());

    await on("job_found", (p) => {
      log(`Vaga encontrada: ${p.title} @ ${p.company}`);
      setResults((prev) => prev.find((j) => j.id === p.id) ? prev : [p, ...prev]);
    });

    await on("job_analyzed", (p) => {
      log(`Analisado: score ${p.score}%`);
      setResults((prev) => prev.map((j) => j.id === p.id ? { ...j, score: p.score } : j));
      setAnalyzing(null);
    });

    await on("night_started", (p) => {
      log(`Modo iniciado: ${p.mode}`);
    });

    await on("night_progress", (p) => {
      log(p.message ?? JSON.stringify(p));
    });

    await on("night_finished", (p) => {
      log(`Finalizado: ${JSON.stringify(p)}`);
      setSearching(false);
      setSearchDone(true);
      cleanup();
    });

    await on("night_error", (p) => {
      log(`ERRO: ${p?.error}`);
      setError(p?.error ?? "Erro ao buscar. Veja o log abaixo.");
      setSearching(false);
      setSearchDone(true);
      cleanup();
    });

    try {
      log("Chamando search_jobs...");
      await invoke("search_jobs", {
        query: buildQuery(),
        sites: filters.sites,
        modality: filters.modality,
        locations: filters.locations,
      });
      log("search_jobs invocado com sucesso, aguardando eventos...");
    } catch (e: any) {
      log(`ERRO invoke: ${e}`);
      setError(`Erro ao iniciar busca: ${e}`);
      setSearching(false);
      setSearchDone(true);
      cleanup();
    }
  }

  async function analyzeJob(job: JobResult) {
    if (!ollama?.model) return;
    setAnalyzing(job.id);
    try {
      const res = await invoke<any>("analyze_job", {
        jobDescription: job.description,
        resumeTex: "",
        model: ollama.model,
      });
      setResults((prev) =>
        prev.map((j) => j.id === job.id ? { ...j, score: res.score } : j)
      );
    } catch {}
    setAnalyzing(null);
  }

  const scored   = results.filter((r) => r.score != null).length;
  const avgScore = scored > 0
    ? Math.round(results.filter((r) => r.score != null)
        .reduce((a, r) => a + (r.score ?? 0), 0) / scored)
    : null;

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Buscar vagas</h1>
          <p className={styles.subtitle}>Busca manual com análise de fit em tempo real</p>
        </div>
        {results.length > 0 && (
          <div className={styles.summary}>
            <span className={styles.summaryNum}>{results.length}</span>
            <span className={styles.summarySub}>encontradas</span>
            {avgScore != null && (
              <>
                <span className={styles.summarySep}>·</span>
                <span className={styles.summaryNum} style={{ color: SCORE_COLOR(avgScore) }}>
                  {avgScore}%
                </span>
                <span className={styles.summarySub}>fit médio</span>
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Painel de filtros ──────────────────────────────────────────────── */}
      <div className={styles.filtersCard}>

        {/* Linha 1: query + seniority + botão */}
        <div className={styles.queryRow}>
          <input
            className={styles.queryInput}
            type="text"
            value={filters.query}
            onChange={(e) => set({ query: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && !searching && handleSearch()}
            placeholder="ex: desenvolvedor React, analista de dados, UX designer..."
            disabled={searching}
          />
          <select
            className={styles.select}
            value={filters.seniority}
            onChange={(e) => set({ seniority: e.target.value })}
            disabled={searching}
          >
            {SENIORITY.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
          {searching ? (
            <button className={styles.btnStop} onClick={() => setSearching(false)}>
              ⏹ Parar
            </button>
          ) : (
            <button
              className={styles.btnSearch}
              onClick={handleSearch}
              disabled={!filters.query.trim()}
            >
              Buscar
            </button>
          )}
        </div>

        {/* Linha 2: modalidade */}
        <div className={styles.filterRow}>
          <span className={styles.filterLabel}>Modalidade</span>
          <div className={styles.modalityGrid}>
            {MODALITIES.map((m) => (
              <button
                key={m.id}
                className={`${styles.modalityBtn} ${filters.modality === m.id ? styles.modalityActive : ""}`}
                onClick={() => set({ modality: m.id })}
              >
                <span className={styles.modalityIcon}>{m.icon}</span>
                <span className={styles.modalityLabel}>{m.label}</span>
                <span className={styles.modalitySub}>{m.sub}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Linha 3: localização (visível se não for remoto puro) */}
        {filters.modality !== "remote" && (
          <div className={styles.filterRow}>
            <span className={styles.filterLabel}>
              {filters.modality === "any" ? "Localização preferida" : "Localização"}
            </span>
            <div className={styles.locationWrap}>
              <div className={styles.tagWrap}>
                {filters.locations.map((loc) => (
                  <span key={loc} className={styles.tag}>
                    {loc}
                    <button onClick={() => removeLocation(loc)}>×</button>
                  </span>
                ))}
                <input
                  type="text"
                  className={styles.locationInput}
                  value={locationInput}
                  onChange={(e) => setLocationInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addLocation()}
                  placeholder={
                    filters.locations.length === 0
                      ? "ex: São Paulo, Curitiba, Rio de Janeiro..."
                      : "adicionar cidade..."
                  }
                />
              </div>
              {locationInput && (
                <button className={styles.btnAdd} onClick={addLocation}>+</button>
              )}
            </div>
          </div>
        )}

        {/* Linha 4: sites */}
        <div className={styles.filterRow}>
          <span className={styles.filterLabel}>Sites</span>
          <div className={styles.siteRow}>
            {SITES.map((s) => (
              <label key={s.id} className={styles.siteToggle}>
                <input
                  type="checkbox"
                  checked={filters.sites.includes(s.id)}
                  onChange={() => toggleSite(s.id)}
                />
                <span>{s.label}</span>
              </label>
            ))}
          </div>
        </div>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      {/* ── Resultados ────────────────────────────────────────────────────── */}
      {searching && results.length === 0 && (
        <div className={styles.loadingState}>
          <span className={styles.spinner} />
          <div>
            <div>Buscando vagas nos sites selecionados...</div>
            <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 4 }}>
              O Edge vai abrir automaticamente. Isso pode levar alguns minutos.
            </div>
          </div>
        </div>
      )}

      {searching && results.length > 0 && (
        <div className={styles.loadingBar}>
          <span className={styles.spinnerSm} />
          <span>Buscando mais vagas...</span>
        </div>
      )}

      {results.length > 0 && (
        <div className={styles.results}>
          {results.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              expanded={expanded === job.id}
              analyzing={analyzing === job.id}
              onToggle={() => setExpanded(expanded === job.id ? null : job.id)}
              onAnalyze={() => analyzeJob(job)}
            />
          ))}
        </div>
      )}

      {!searching && searchDone && results.length === 0 && !error && (
        <div className={styles.emptyState}>
          Nenhuma vaga encontrada. Tente termos mais amplos ou outros sites.
        </div>
      )}

      {/* Painel de debug — remover depois que estiver funcionando */}
      {debugLog.length > 0 && (
        <div className={styles.debugPanel}>
          <div className={styles.debugTitle}>Log de execução</div>
          {debugLog.map((line, i) => (
            <div key={i} className={styles.debugLine}>{line}</div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── JobCard ───────────────────────────────────────────────────────────────────

function JobCard({ job, expanded, analyzing, onToggle, onAnalyze }: {
  job: JobResult;
  expanded: boolean;
  analyzing: boolean;
  onToggle: () => void;
  onAnalyze: () => void;
}) {
  const score = job.score;
  const modalityIcon: Record<string, string> = {
    remote: "⌂", hybrid: "⇄", onsite: "⊙",
  };

  return (
    <div className={`${styles.jobCard} ${expanded ? styles.jobExpanded : ""}`}>
      <div className={styles.jobMain} onClick={onToggle}>

        {/* Score */}
        <div
          className={styles.scoreBox}
          style={{ borderColor: score != null ? SCORE_COLOR(score) + "60" : "var(--border)" }}
        >
          {score != null ? (
            <>
              <span className={styles.scoreNum} style={{ color: SCORE_COLOR(score) }}>
                {score}
              </span>
              <span className={styles.scorePct}>%</span>
            </>
          ) : (
            <span className={styles.scoreEmpty}>—</span>
          )}
        </div>

        {/* Info */}
        <div className={styles.jobInfo}>
          <div className={styles.jobTitle}>{job.title}</div>
          <div className={styles.jobMeta}>
            <span>{job.company}</span>
            <span className={styles.dot}>·</span>
            <span className={styles.siteBadge}>{job.site}</span>
            {job.location && (
              <>
                <span className={styles.dot}>·</span>
                <span>{job.location}</span>
              </>
            )}
            {job.modality && (
              <>
                <span className={styles.dot}>·</span>
                <span>{modalityIcon[job.modality] ?? ""} {job.modality}</span>
              </>
            )}
          </div>
        </div>

        {/* Ações */}
        <div className={styles.jobActions} onClick={(e) => e.stopPropagation()}>
          {score == null && (
            <button
              className={styles.btnAnalyze}
              onClick={onAnalyze}
              disabled={analyzing}
            >
              {analyzing ? <span className={styles.spinnerSm} /> : "Analisar fit"}
            </button>
          )}
          <a
            href={job.url}
            target="_blank"
            rel="noreferrer"
            className={styles.btnLink}
          >
            Ver ↗
          </a>
          <span className={`${styles.chevron} ${expanded ? styles.chevronUp : ""}`}>
            ›
          </span>
        </div>
      </div>

      {/* Descrição expandida */}
      {expanded && (
        <div className={styles.jobDetail}>
          <div className={styles.jobDesc}>
            {job.description
              ? job.description.slice(0, 800) + (job.description.length > 800 ? "..." : "")
              : "Descrição não disponível."}
          </div>
          <a
            href={job.url}
            target="_blank"
            rel="noreferrer"
            className={styles.btnFull}
          >
            Ver vaga completa ↗
          </a>
        </div>
      )}
    </div>
  );
}
