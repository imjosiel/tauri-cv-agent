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
- PRESERVE o número exato de argumentos de cada comando (\\cvevent, \\cvdegree, etc.)
  Ex: se o original tem \\cvevent{A}{B}{C}{D}{E}{F} com 6 args, mantenha exatamente 6
  NUNCA omita ou mescle argumentos — chaves desbalanceadas causam erro fatal

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

  // Corrige \cvevent/\cvdegree fora de tabular
  const tabularFixed = fixCveventOutsideTabular(editedTex);
  const texToValidate = tabularFixed;

  // Valida número de argumentos dos comandos customizados
  const validated = validateCustomCommands(resumeTex, texToValidate);
  if (!validated.ok) {
    console.warn(`[ollama] args inválidos: ${validated.errors.join("; ")} — restaurando comandos do original`);
    return buildResult(raw, restoreCustomCommands(resumeTex, editedTex));
  }

  return buildResult(raw, texToValidate);
}

function fixCveventOutsideTabular(tex) {
  const cmds = [
    { name: "cvevent",  fmt: "r|p{0.68\\textwidth}c" },
    { name: "cvdegree", fmt: "r p{0.68\\textwidth} c" },
  ];
  let result = tex;

  function inTabular(t, pos) {
    const sl = t.slice(0, pos);
    return (sl.match(/\\begin\{tabular\}/g)||[]).length > (sl.match(/\\end\{tabular\}/g)||[]).length;
  }

  function getCmdEnd(t, i) {
    while (i < t.length) {
      while (i < t.length && " \t\n\r".includes(t[i])) i++;
      if (t[i] === "[") { while (i < t.length && t[i] !== "]") i++; i++; continue; }
      if (t[i] !== "{") break;
      let depth = 0; i++;
      while (i < t.length) {
        if (t[i] === "{") depth++;
        else if (t[i] === "}") { if (depth === 0) { i++; break; } depth--; }
        i++;
      }
    }
    return i;
  }

  for (const { name, fmt } of cmds) {
    const needle = `\\${name}`;
    let offset = 0;
    while (true) {
      const pos = result.indexOf(needle, offset);
      if (pos === -1) break;
      const after = pos + needle.length;
      if (!/[{\[ \t\n]/.test(result[after] ?? "")) { offset = pos + 1; continue; }
      if (inTabular(result, pos)) { offset = pos + 1; continue; }
      const end = getCmdEnd(result, after);
      const inner = result.slice(pos, end);
      const wrapped = `\\begin{tabular}{${fmt}}\n    ${inner}\n\\end{tabular}`;
      result = result.slice(0, pos) + wrapped + result.slice(end);
      console.log(`[ollama] \\${name} fora de tabular — envolto`);
      offset = pos + wrapped.length;
    }
  }
  return result;
}

// ── Validação de argumentos de comandos customizados ─────────────────────────

function countArgs(tex, offset) {
  let count = 0, i = offset;
  while (i < tex.length) {
    while (i < tex.length && " \t\n".includes(tex[i])) i++;
    if (tex[i] === "[") { while (i < tex.length && tex[i] !== "]") i++; i++; continue; }
    if (tex[i] !== "{") break;
    let depth = 0; i++;
    while (i < tex.length) {
      if (tex[i] === "{") depth++;
      else if (tex[i] === "}") { if (depth === 0) { i++; break; } depth--; }
      i++;
    }
    count++;
  }
  return count;
}

function extractCommandArgCounts(tex) {
  const map = new Map();
  for (const m of tex.matchAll(/\\([a-zA-Z]+)/g)) {
    const count = countArgs(tex, m.index + m[0].length);
    if (count >= 2) {
      if (!map.has(m[1])) map.set(m[1], new Set());
      map.get(m[1]).add(count);
    }
  }
  return map;
}

function validateCustomCommands(originalTex, editedTex) {
  const orig = extractCommandArgCounts(originalTex);
  const edit = extractCommandArgCounts(editedTex);
  const errors = [];
  for (const [cmd, origSet] of orig) {
    const editSet = edit.get(cmd);
    if (!editSet) continue;
    for (const n of origSet) {
      if (!editSet.has(n)) errors.push(`\\${cmd} esperava ${n} args`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function extractCommandUses(tex, cmdName) {
  const uses = [], re = new RegExp(`\\\\${cmdName}(?=[\\s{\\[])`, "g");
  for (const m of tex.matchAll(re)) {
    let i = m.index + m[0].length;
    while (i < tex.length) {
      while (i < tex.length && " \t\n".includes(tex[i])) i++;
      if (tex[i] === "[") { while (i < tex.length && tex[i] !== "]") i++; i++; continue; }
      if (tex[i] !== "{") break;
      let depth = 0; i++;
      while (i < tex.length) {
        if (tex[i] === "{") depth++;
        else if (tex[i] === "}") { if (depth === 0) { i++; break; } depth--; }
        i++;
      }
    }
    uses.push({ start: m.index, end: i, full: tex.slice(m.index, i) });
  }
  return uses;
}

function restoreCustomCommands(originalTex, editedTex) {
  let result = editedTex;
  for (const cmd of ["cvevent", "cvdegree", "cvskill", "cvproject"]) {
    const orig = extractCommandUses(originalTex, cmd);
    const edit = extractCommandUses(result, cmd);
    if (!orig.length) continue;
    if (orig.length === edit.length) {
      for (let i = orig.length - 1; i >= 0; i--)
        result = result.slice(0, edit[i].start) + orig[i].full + result.slice(edit[i].end);
    } else if (edit.length > 0) {
      result = result.slice(0, edit[0].start)
        + orig.map(u => u.full).join("\n    \\\\\n    ")
        + result.slice(edit[edit.length - 1].end);
    }
  }
  return result;
}

// Escapa caracteres especiais LaTeX que o LLM insere em texto livre.
// Percorre char a char: se o char anterior for '\', já está escapado — não toca.
// Para '&': se a linha tiver mais de um '&' não escapado, é tabular — não toca.
function sanitizeLatex(tex) {
  const lines = tex.split("\n");
  const out = [];

  for (const line of lines) {
    // Conta & não escapados na linha para detectar ambiente tabular
    let rawAmps = 0;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === "&" && (i === 0 || line[i - 1] !== "\\")) rawAmps++;
    }
    const isTabularLine = rawAmps > 1;

    let result = "";
    for (let i = 0; i < line.length; i++) {
      const ch   = line[i];
      const prev = i > 0 ? line[i - 1] : "";

      if (ch === "#" && prev !== "\\") {
        result += "\\#";
      } else if (ch === "&" && prev !== "\\" && !isTabularLine) {
        result += "\\&";
      } else {
        result += ch;
      }
    }
    out.push(result);
  }

  return out.join("\n");
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

  return { ...meta, edited_tex: sanitizeLatex(editedTex) };
}
