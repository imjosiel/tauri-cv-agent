// playwright/src/ollama.js
// Lê o template .tex da pasta de dados e chama Ollama para análise/edição

import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const OLLAMA_URL = "http://localhost:11434";
const DATA_DIR   = `${process.env.APPDATA ?? "."}/cv-agent`;
const TEX_DIR    = join(DATA_DIR, "curriculo", "templates");

function getResumeTeX() {
  try {
    const files = readdirSync(TEX_DIR).filter((f) => f.endsWith(".tex"));
    if (files.length === 0) throw new Error("Nenhum template .tex encontrado em " + TEX_DIR);
    return readFileSync(join(TEX_DIR, files[0]), "utf8");
  } catch (e) {
    throw new Error(`Erro ao ler template LaTeX: ${e.message}`);
  }
}

async function chat(prompt, model = "qwen2.5:7b") {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
      options: { temperature: 0.3, num_predict: 4096 },
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) throw new Error(`Ollama retornou ${res.status}`);
  const data = await res.json();
  const text = data?.message?.content ?? "";

  // Remove markdown fences se presentes
  return text.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
}

export async function callOllama(action, payload) {
  if (action === "analyze") {
    const prompt = `Você é especialista em recrutamento. Analise a compatibilidade.

VAGA: ${payload.job_title} @ ${payload.company}
DESCRIÇÃO:
${payload.job_description.slice(0, 2000)}

Responda APENAS com JSON válido (sem markdown):
{"score":0-100,"reasons":["..."],"missing_skills":["..."],"strong_points":["..."],"recommendation":"aplicar"|"pular"}`;

    const raw = await chat(prompt, "qwen2.5:3b"); // modelo leve para triagem
    return JSON.parse(raw);
  }

  if (action === "edit_resume") {
    const resumeTex = getResumeTeX();
    const prompt = `Você é especialista em currículos LaTeX. Edite o currículo para a vaga.

REGRAS:
- Mantenha TODA a formatação LaTeX intacta
- Adapte apenas: resumo/objetivo, ordem de skills, palavras-chave
- NÃO invente experiências ou habilidades inexistentes
- Responda APENAS com JSON válido (sem markdown)

CURRÍCULO ORIGINAL:
${resumeTex.slice(0, 4000)}

VAGA: ${payload.job_title}
DESCRIÇÃO:
${payload.job_description.slice(0, 1500)}

Responda com:
{"edited_tex":"<LaTeX completo>","changes":["..."],"cover_letter":"<carta em português, 3 parágrafos>"}`;

    const raw = await chat(prompt, "qwen2.5:7b"); // modelo maior para edição
    return JSON.parse(raw);
  }

  throw new Error(`Ação Ollama desconhecida: ${action}`);
}
