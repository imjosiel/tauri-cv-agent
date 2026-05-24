// playwright/src/ollama.js
// Chama Ollama para análise de vagas e edição de currículos.
//
// ESTRATÉGIA DE EDIÇÃO:
// O LaTeX editado NUNCA entra dentro de um valor JSON.
// LLMs sobre-escapam barras invertidas dentro de JSON (\\ → \\\\),
// corrompendo o LaTeX. Usamos marcadores textuais fora do JSON,
// igual ao ollama.rs no lado Rust.

import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const OLLAMA_URL = "http://localhost:11434";
const DATA_DIR   = `${process.env.APPDATA ?? process.env.HOME ?? "."}/cv-agent`;
const TEX_DIR    = join(DATA_DIR, "curriculo", "templates");

const TEX_START = "<<<TEX_START>>>";
const TEX_END   = "<<<TEX_END>>>";

// ── Leitura do template ────────────────────────────────────────────────────────

function findTexFile(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = findTexFile(fullPath);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name.endsWith(".tex")) {
      return fullPath;
    }
  }
  return null;
}

function getResumeTeX() {
  const texFile = findTexFile(TEX_DIR);
  if (!texFile) throw new Error("Nenhum template .tex encontrado em " + TEX_DIR);
  return readFileSync(texFile, "utf8");
}

// ── HTTP ───────────────────────────────────────────────────────────────────────

async function chat(prompt, model = "qwen2.5:7b") {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
      options: { temperature: 0.2, num_predict: 8192 },
    }),
    signal: AbortSignal.timeout(300_000),
  }).catch((err) => {
    throw new Error(`Erro ao conectar ao Ollama: ${err.message}`);
  });

  if (!res.ok) throw new Error(`Ollama retornou ${res.status}`);
  const data = await res.json();
  return (data?.message?.content ?? "").trim();
}

// ── Helpers de extração ───────────────────────────────────────────────────────

function extractBetween(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  if (start === -1) return null;
  const after = start + startMarker.length;
  const end = text.indexOf(endMarker, after);
  if (end === -1) return null;
  return text.slice(after, end);
}

function stripMarkdownFences(s) {
  s = s.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```[a-z]*\n?/i, "").replace(/```\s*$/, "").trim();
  }
  return s;
}

// ── API pública ────────────────────────────────────────────────────────────────

export async function callOllama(action, payload) {
  if (action === "analyze") {
    return analyzeJob(payload);
  }
  if (action === "edit_resume") {
    return editResume(payload);
  }
  throw new Error(`Ação Ollama desconhecida: ${action}`);
}

async function analyzeJob({ job_title, company, job_description }) {
  const prompt = `Você é especialista em recrutamento. Analise a compatibilidade entre o candidato e a vaga.

VAGA: ${job_title} @ ${company}
DESCRIÇÃO:
${job_description.slice(0, 2000)}

Responda APENAS com JSON válido, sem markdown, sem texto extra:
{"score":0-100,"reasons":["razão"],"missing_skills":["skill"],"strong_points":["ponto"],"recommendation":"aplicar"|"pular"}`;

  const raw = await chat(prompt, "qwen2.5:3b");
  const clean = stripMarkdownFences(raw);

  try {
    return JSON.parse(clean);
  } catch {
    // Tenta extrair apenas o objeto JSON da resposta
    const match = clean.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`Análise retornou JSON inválido:\n${clean.slice(0, 300)}`);
  }
}

async function editResume({ job_title, job_description }) {
  const resumeTex = getResumeTeX();

  // O LaTeX fica FORA do JSON, delimitado por marcadores.
  // Isso evita que o modelo over-escape as barras invertidas.
  const prompt = `Você é especialista em currículos LaTeX. Edite o currículo para a vaga abaixo.

REGRAS OBRIGATÓRIAS:
- Mantenha TODA a formatação LaTeX intacta (\\textbf, \\section, ambientes, etc.)
- Adapte apenas: resumo/objetivo, ordem de habilidades, palavras-chave relevantes
- NÃO invente experiências ou habilidades inexistentes
- NÃO altere datas, empresas, cargos ou conquistas reais

FORMATO DA RESPOSTA — siga EXATAMENTE esta estrutura, sem desvios:

JSON_META_START
{"changes":["mudança 1","mudança 2"],"cover_letter":"carta em português, 3 parágrafos"}
JSON_META_END
${TEX_START}
<currículo LaTeX completo editado — copie e adapte o original, mantenha \\begin{document} e \\end{document}>
${TEX_END}

CURRÍCULO ORIGINAL (LaTeX):
${resumeTex}

VAGA: ${job_title}
DESCRIÇÃO:
${job_description.slice(0, 1500)}

Responda agora seguindo exatamente o formato acima.`;

  const raw = await chat(prompt, "qwen2.5:7b");

  // Extrai o bloco LaTeX pelos marcadores
  const editedTex = extractBetween(raw, TEX_START, TEX_END)?.trim();

  if (!editedTex) {
    // Fallback: modelo ignorou os marcadores — tenta encontrar \documentclass direto
    const docClassIdx = raw.indexOf("\\documentclass");
    const endDocIdx   = raw.lastIndexOf("\\end{document}");
    if (docClassIdx !== -1 && endDocIdx !== -1) {
      console.warn("[ollama] Marcadores não encontrados, extraindo por \\documentclass..\\end{document}");
      const fallbackTex = raw.slice(docClassIdx, endDocIdx + "\\end{document}".length).trim();
      return buildResult(raw, fallbackTex);
    }

    throw new Error(
      `Modelo não retornou o bloco LaTeX com os marcadores esperados.\n` +
      `Resposta (primeiros 400 chars):\n${raw.slice(0, 400)}`
    );
  }

  if (!editedTex.includes("\\documentclass")) {
    throw new Error(
      `Bloco LaTeX retornado inválido (sem \\documentclass):\n${editedTex.slice(0, 400)}`
    );
  }

  if (!editedTex.includes("\\begin{document}")) {
    throw new Error(
      `Bloco LaTeX retornado inválido (sem \\begin{document}):\n${editedTex.slice(0, 400)}`
    );
  }

  return buildResult(raw, editedTex);
}

function buildResult(raw, editedTex) {
  const metaStr = extractBetween(raw, "JSON_META_START", "JSON_META_END");
  let meta = { changes: [], cover_letter: "" };

  if (metaStr) {
    try {
      meta = JSON.parse(stripMarkdownFences(metaStr.trim()));
    } catch {
      // metadados opcionais — ignora se inválidos
    }
  }

  return { ...meta, edited_tex: editedTex };
}
