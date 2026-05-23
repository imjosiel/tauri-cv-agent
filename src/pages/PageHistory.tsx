// PageHistory.tsx
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

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
  { id: "applied",  label: "Enviado" },
  { id: "skipped",  label: "Pulado" },
  { id: "captcha",  label: "CAPTCHA" },
  { id: "error",    label: "Erro" },
];

export default function PageHistory() {
  const [jobs, setJobs] = useState<any[]>([]);
  const [selectedStatuses, setSelectedStatuses] = useState<string[]>([
    "applied",
    "skipped",
    "captcha",
    "error",
  ]);
  const [loading, setLoading] = useState(true);

  const loadJobs = async () => {
    setLoading(true);
    const status = selectedStatuses.length === 0 ? null : selectedStatuses;
    invoke<any[]>("get_jobs", {
      limit: 100,
      status,
    })
      .then(setJobs)
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadJobs();
  }, [selectedStatuses]);

  return (
    <div style={{ padding: "28px 32px" }}>
      <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>Histórico</h1>
      <p style={{ color: "var(--text2)", fontSize: 13, marginBottom: 20 }}>
        Todas as vagas encontradas e candidaturas enviadas
      </p>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {STATUS_FILTERS.map((filter) => (
            <label key={filter.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text2)" }}>
              <input
                type="checkbox"
                checked={selectedStatuses.includes(filter.id)}
                onChange={() => {
                  setSelectedStatuses((prev) =>
                    prev.includes(filter.id)
                      ? prev.filter((status) => status !== filter.id)
                      : [...prev, filter.id]
                  );
                }}
              />
              {filter.label}
            </label>
          ))}
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            onClick={() => setSelectedStatuses(STATUS_FILTERS.map((f) => f.id))}
            style={{
              background: "var(--bg2)",
              color: "var(--text2)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: "5px 12px",
              fontSize: 12,
            }}
          >
            Selecionar todos
          </button>
          <button
            onClick={async () => {
              if (!window.confirm("Tem certeza que deseja limpar todo o histórico de vagas?")) return;
              try {
                await invoke("clear_history");
                loadJobs();
              } catch (err) {
                console.error(err);
              }
            }}
            style={{
              background: "var(--red)",
              color: "#fff",
              border: "1px solid transparent",
              borderRadius: 6,
              padding: "5px 12px",
              fontSize: 12,
            }}
          >
            Limpar histórico
          </button>
        </div>
      </div>

      {loading ? (
        <div style={{ color: "var(--text2)", fontSize: 13 }}>Carregando histórico...</div>
      ) : jobs.length === 0 ? (
        <div style={{ color: "var(--text3)", fontSize: 13 }}>
          Nenhuma vaga registrada ainda. Inicie o modo noturno para começar.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {jobs.map((job) => (
            <div
              key={job.id}
              style={{
                background: "var(--bg2)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: "12px 16px",
                display: "flex",
                alignItems: "center",
                gap: 12,
              }}
            >
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 500,
                  padding: "2px 8px",
                  borderRadius: 4,
                  background: (STATUS_COLOR[job.status] ?? "var(--text3)") + "22",
                  color: STATUS_COLOR[job.status] ?? "var(--text3)",
                  minWidth: 70,
                  textAlign: "center",
                  flexShrink: 0,
                }}
              >
                {STATUS_LABEL[job.status] ?? job.status}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text)" }}>
                  {job.title}
                </div>
                <div style={{ fontSize: 12, color: "var(--text2)" }}>{job.company} · {job.site}</div>
              </div>
              {job.score != null && (
                <span style={{ fontSize: 12, fontWeight: 500, color: "var(--accent)", flexShrink: 0 }}>
                  {job.score}% fit
                </span>
              )}
              {job.skip_reason && (
                <span style={{ fontSize: 11, color: "var(--text3)", maxWidth: 160, textAlign: "right" }}>
                  {job.skip_reason}
                </span>
              )}
              {job.url && (
                <a
                  href={job.url}
                  target="_blank"
                  rel="noreferrer"
                  style={{ fontSize: 11, color: "var(--blue)", flexShrink: 0 }}
                >
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
