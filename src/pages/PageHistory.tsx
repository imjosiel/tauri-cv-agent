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

export default function PageHistory() {
  const [jobs, setJobs] = useState<any[]>([]);
  const [filter, setFilter] = useState("all");

  useEffect(() => {
    invoke<any[]>("get_jobs", {
      limit: 100,
      status: filter === "all" ? null : filter,
    }).then(setJobs).catch(console.error);
  }, [filter]);

  const filters = ["all", "applied", "skipped", "captcha", "error"];

  return (
    <div style={{ padding: "28px 32px" }}>
      <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>Histórico</h1>
      <p style={{ color: "var(--text2)", fontSize: 13, marginBottom: 20 }}>
        Todas as vagas encontradas e candidaturas enviadas
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        {filters.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            style={{
              background: filter === f ? "var(--accent)" : "var(--bg2)",
              color: filter === f ? "#fff" : "var(--text2)",
              border: `1px solid ${filter === f ? "var(--accent)" : "var(--border)"}`,
              borderRadius: 6,
              padding: "5px 12px",
              fontSize: 12,
            }}
          >
            {f === "all" ? "Todos" : STATUS_LABEL[f] ?? f}
          </button>
        ))}
      </div>

      {jobs.length === 0 ? (
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
