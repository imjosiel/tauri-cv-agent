// PageReport.tsx
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface NightReport {
  date: string;
  found: number;
  analyzed: number;
  applied: number;
  skipped_score: number;
  skipped_captcha: number;
  skipped_error: number;
  jobs: any[];
}

const STATUS_COLOR: Record<string, string> = {
  applied: "var(--green)",
  skipped: "var(--text3)",
  captcha: "var(--amber)",
  error:   "var(--red)",
};

export default function PageReport() {
  const [report, setReport] = useState<NightReport | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    invoke<NightReport>("get_night_report", { date: null })
      .then(setReport)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div style={{ padding: "28px 32px", color: "var(--text3)", fontSize: 13 }}>
        Carregando relatório...
      </div>
    );
  }

  if (!report || report.found === 0) {
    return (
      <div style={{ padding: "28px 32px" }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>Relatório</h1>
        <div style={{
          background: "var(--bg2)", border: "1px solid var(--border)",
          borderRadius: 8, padding: 24, color: "var(--text3)", fontSize: 13, marginTop: 16
        }}>
          Nenhuma sessão noturna encontrada para hoje. Inicie o modo noturno para gerar um relatório.
        </div>
      </div>
    );
  }

  const successRate = report.found > 0
    ? Math.round((report.applied / report.found) * 100)
    : 0;

  return (
    <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <h1 style={{ fontSize: 20, fontWeight: 600 }}>Relatório matinal</h1>
        <p style={{ color: "var(--text2)", fontSize: 13, marginTop: 4 }}>
          Sessão de {new Date(report.date).toLocaleDateString("pt-BR", {
            weekday: "long", day: "numeric", month: "long"
          })}
        </p>
      </div>

      {/* Cards de resumo */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
        {[
          { label: "Vagas encontradas", value: report.found,          color: "var(--blue)"   },
          { label: "Candidaturas enviadas", value: report.applied,    color: "var(--green)"  },
          { label: "CAPTCHAs",          value: report.skipped_captcha, color: "var(--amber)" },
          { label: "Taxa de sucesso",   value: `${successRate}%`,     color: "var(--accent)" },
        ].map(({ label, value, color }) => (
          <div key={label} style={{
            background: "var(--bg2)", border: "1px solid var(--border)",
            borderRadius: 10, padding: "16px 18px"
          }}>
            <div style={{ fontSize: 11, color: "var(--text3)", textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 8 }}>
              {label}
            </div>
            <div style={{ fontSize: 28, fontWeight: 600, color }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Barra de progresso visual */}
      <div style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 10, padding: "16px 18px" }}>
        <div style={{ fontSize: 12, color: "var(--text3)", marginBottom: 10 }}>Distribuição das vagas</div>
        <div style={{ display: "flex", height: 10, borderRadius: 5, overflow: "hidden", gap: 2 }}>
          {[
            { n: report.applied,          color: "var(--green)"  },
            { n: report.skipped_score,    color: "var(--text3)"  },
            { n: report.skipped_captcha,  color: "var(--amber)"  },
            { n: report.skipped_error,    color: "var(--red)"    },
          ].filter(s => s.n > 0).map(({ n, color }, i) => (
            <div key={i} style={{
              flex: n, background: color, borderRadius: 2
            }} />
          ))}
        </div>
        <div style={{ display: "flex", gap: 16, marginTop: 10 }}>
          {[
            { label: "Enviados",          n: report.applied,         color: "var(--green)"  },
            { label: "Score baixo",       n: report.skipped_score,   color: "var(--text3)"  },
            { label: "CAPTCHA",           n: report.skipped_captcha, color: "var(--amber)"  },
            { label: "Erro",              n: report.skipped_error,   color: "var(--red)"    },
          ].map(({ label, n, color }) => (
            <div key={label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: color, display: "inline-block" }} />
              <span style={{ fontSize: 11, color: "var(--text2)" }}>{label}: <strong style={{ color: "var(--text)" }}>{n}</strong></span>
            </div>
          ))}
        </div>
      </div>

      {/* Lista de vagas */}
      <div>
        <div style={{ fontSize: 12, fontWeight: 500, color: "var(--text3)", textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 12 }}>
          Detalhes por vaga
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {report.jobs.map((job) => (
            <div key={job.id} style={{
              background: "var(--bg2)", border: "1px solid var(--border)",
              borderRadius: 8, padding: "12px 16px",
              display: "flex", alignItems: "center", gap: 12,
            }}>
              <span style={{
                fontSize: 11, fontWeight: 500, padding: "2px 8px", borderRadius: 4,
                background: (STATUS_COLOR[job.status] ?? "var(--text3)") + "22",
                color: STATUS_COLOR[job.status] ?? "var(--text3)",
                minWidth: 70, textAlign: "center", flexShrink: 0,
              }}>
                {job.status === "applied" ? "Enviado" : job.status === "captcha" ? "CAPTCHA" : "Pulado"}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{job.title}</div>
                <div style={{ fontSize: 12, color: "var(--text2)" }}>{job.company} · {job.site}</div>
              </div>
              {job.score != null && (
                <span style={{ fontSize: 12, fontWeight: 500, color: "var(--accent)", flexShrink: 0 }}>
                  {job.score}% fit
                </span>
              )}
              {job.applied_at && (
                <span style={{ fontSize: 11, color: "var(--text3)", flexShrink: 0 }}>
                  {new Date(job.applied_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
                </span>
              )}
              {job.screenshot_path && (
                <span style={{ fontSize: 11, color: "var(--amber)", flexShrink: 0 }}>📸 screenshot</span>
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
      </div>
    </div>
  );
}
