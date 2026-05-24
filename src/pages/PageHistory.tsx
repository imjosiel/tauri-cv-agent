// src/pages/PageHistory.tsx
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store/appStore";
import type { JobListing } from "../store/appStore";

const STATUS_COLOR: Record<string, string> = {
  applied:  "var(--green)",
  found:    "var(--blue)",
  analyzed: "var(--accent)",
  skipped:  "var(--text3)",
  captcha:  "var(--amber)",
  error:    "var(--red)",
};

const STATUS_LABEL: Record<string, string> = {
  applied:  "Enviado",
  found:    "Encontrado",
  analyzed: "Analisado",
  skipped:  "Pulado",
  captcha:  "CAPTCHA",
  error:    "Erro",
};

const STATUS_FILTERS = [
  { id: "applied",  label: "Enviado"    },
  { id: "skipped",  label: "Pulado"     },
  { id: "analyzed", label: "Analisado"  },
  { id: "found",    label: "Encontrado" },
  { id: "captcha",  label: "CAPTCHA"    },
  { id: "error",    label: "Erro"       },
];

export default function PageHistory() {
  const { liveEvents } = useAppStore();
  const [dbJobs, setDbJobs]               = useState<JobListing[]>([]);
  const [loading, setLoading]             = useState(true);
  const [selectedStatuses, setSelectedStatuses] = useState<string[]>(
    STATUS_FILTERS.map((f) => f.id)
  );

  // Carrega do banco ao montar e quando os filtros mudam
  useEffect(() => {
    setLoading(true);
    invoke<JobListing[]>("get_jobs", { limit: 500, status: null })
      .then((rows) => setDbJobs(rows ?? []))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  // Constrói a lista de vagas mesclando banco + eventos ao vivo do store.
  // Eventos ao vivo têm precedência (status mais recente) sobre o banco,
  // garantindo que a lista seja atualizada em tempo real sem precisar
  // recarregar do banco a cada evento.
  const merged = (() => {
    const map = new Map<string, JobListing>();

    // 1. Popula com dados do banco (base persistida)
    for (const job of dbJobs) {
      map.set(job.id, job);
    }

    // 2. Sobrescreve / adiciona com eventos ao vivo do store
    for (const ev of liveEvents) {
      const p = ev.payload;
      if (!p?.id) continue;
      const status = ev.type === "found"    ? "found"
                   : ev.type === "analyzed" ? "analyzed"
                   : ev.type === "applied"  ? "applied"
                   : ev.type === "skipped"  ? "skipped"
                   : ev.type === "captcha"  ? "captcha"
                   : null;
      if (!status) continue;

      const existing = map.get(p.id);
      map.set(p.id, {
        id:              p.id,
        title:           p.title           ?? existing?.title    ?? "",
        company:         p.company         ?? existing?.company  ?? "",
        url:             p.url             ?? existing?.url      ?? "",
        site:            p.site            ?? existing?.site     ?? "",
        description:     p.description     ?? existing?.description ?? "",
        score:           p.score           ?? existing?.score    ?? undefined,
        status,
        applied_at:      p.applied_at      ?? existing?.applied_at ?? undefined,
        resume_path:     p.resume_path     ?? existing?.resume_path ?? undefined,
        skip_reason:     p.skip_reason     ?? p.reason ?? existing?.skip_reason ?? undefined,
        screenshot_path: p.screenshot_path ?? existing?.screenshot_path ?? undefined,
      });
    }

    return [...map.values()]
      .filter((j) => selectedStatuses.includes(j.status))
      .sort((a, b) => {
        // Mantém ordem de inserção dos eventos ao vivo no topo
        const aLive = liveEvents.findIndex((e) => e.payload?.id === a.id);
        const bLive = liveEvents.findIndex((e) => e.payload?.id === b.id);
        if (aLive !== -1 && bLive !== -1) return aLive - bLive;
        if (aLive !== -1) return -1;
        if (bLive !== -1) return 1;
        return 0;
      });
  })();

  async function handleClear() {
    if (!confirm("Limpar todo o histórico de vagas?")) return;
    try {
      await invoke("clear_history");
      setDbJobs([]);
    } catch (err) {
      console.error(err);
    }
  }

  function toggleStatus(id: string) {
    setSelectedStatuses((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]
    );
  }

  return (
    <div style={{ padding: "28px 32px" }}>
      <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>Histórico</h1>
      <p style={{ color: "var(--text2)", fontSize: 13, marginBottom: 20 }}>
        Todas as vagas encontradas e candidaturas enviadas
      </p>

      {/* Filtros */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {STATUS_FILTERS.map((f) => (
            <label key={f.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text2)", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={selectedStatuses.includes(f.id)}
                onChange={() => toggleStatus(f.id)}
              />
              <span style={{ color: STATUS_COLOR[f.id] }}>{f.label}</span>
            </label>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => setSelectedStatuses(STATUS_FILTERS.map((f) => f.id))}
            style={{ background: "var(--bg2)", color: "var(--text2)", border: "1px solid var(--border)", borderRadius: 6, padding: "5px 12px", fontSize: 12, cursor: "pointer" }}
          >
            Todos
          </button>
          <button
            onClick={handleClear}
            style={{ background: "var(--red)", color: "#fff", border: "none", borderRadius: 6, padding: "5px 12px", fontSize: 12, cursor: "pointer" }}
          >
            Limpar histórico
          </button>
        </div>
      </div>

      {/* Contador */}
      <div style={{ fontSize: 12, color: "var(--text3)", marginBottom: 12 }}>
        {merged.length} vaga(s) · {loading ? "sincronizando com banco..." : "banco sincronizado"}
      </div>

      {/* Lista */}
      {merged.length === 0 ? (
        <div style={{ color: "var(--text3)", fontSize: 13 }}>
          {loading
            ? "Carregando histórico..."
            : "Nenhuma vaga registrada ainda. Inicie o modo noturno para começar."}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {merged.map((job) => (
            <div
              key={job.id}
              style={{
                background: "var(--bg2)", border: "1px solid var(--border)",
                borderRadius: 8, padding: "12px 16px",
                display: "flex", alignItems: "center", gap: 12,
              }}
            >
              <span style={{
                fontSize: 11, fontWeight: 500, padding: "2px 8px", borderRadius: 4,
                background: (STATUS_COLOR[job.status] ?? "var(--text3)") + "22",
                color: STATUS_COLOR[job.status] ?? "var(--text3)",
                minWidth: 74, textAlign: "center", flexShrink: 0,
              }}>
                {STATUS_LABEL[job.status] ?? job.status}
              </span>

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {job.title || "(sem título)"}
                </div>
                <div style={{ fontSize: 12, color: "var(--text2)" }}>
                  {job.company}{job.site ? ` · ${job.site}` : ""}
                </div>
              </div>

              {job.score != null && (
                <span style={{ fontSize: 12, fontWeight: 500, color: "var(--accent)", flexShrink: 0 }}>
                  {job.score}% fit
                </span>
              )}
              {job.skip_reason && (
                <span style={{ fontSize: 11, color: "var(--text3)", maxWidth: 180, textAlign: "right", flexShrink: 0 }}>
                  {job.skip_reason}
                </span>
              )}
              {job.url && (
                <a href={job.url} target="_blank" rel="noreferrer"
                  style={{ fontSize: 11, color: "var(--blue)", flexShrink: 0 }}>
                  Ver vaga ↗
                </a>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
