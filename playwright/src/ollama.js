// playwright/src/ollama.js
// Lê o template .tex da pasta de dados e chama Ollama para análise/edição

import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const OLLAMA_URL = "http://localhost:11434";
const DATA_DIR   = `${process.env.APPDATA ?? "."}/cv-agent`;
const TEX_DIR    = join(DATA_DIR, "curriculo", "templates");

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
  try {
    const texFile = findTexFile(TEX_DIR);
    if (!texFile) throw new Error("Nenhum template .tex encontrado em " + TEX_DIR);
    return readFileSync(texFile, "utf8");
  } catch (e) {
    throw new Error(`Erro ao ler template LaTeX: ${e.message}`);
  }
}

function extractJson(raw) {
  // Remove markdown code fences if present
  const cleaned = raw.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  
  // Find the start of JSON object or array
  const start = cleaned.search(/[\[{]/);
  if (start === -1) return cleaned;

  const text = cleaned.slice(start);
  const stack = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    
    // Track escaped characters inside strings
    if (inString && escaped) {
      escaped = false;
      continue;
    }
    
    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }
    
    if (ch === '"' && !escaped) {
      inString = !inString;
      continue;
    }
    
    // Track braces/brackets outside strings
    if (!inString) {
      if (ch === "{" || ch === "[") {
        stack.push(ch);
      } else if (ch === "}") {
        if (stack[stack.length - 1] === "{") {
          stack.pop();
          if (stack.length === 0) {
            return text.slice(0, i + 1);
          }
        }
      } else if (ch === "]") {
        if (stack[stack.length - 1] === "[") {
          stack.pop();
          if (stack.length === 0) {
            return text.slice(0, i + 1);
          }
        }
      }
    }
  }
  
  return text;
}

function sanitizeJson(json) {
  // Remove control characters (except \n, \r, \t which are valid in JSON)
  let sanitized = json.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  
  // Aggressive fix: inside strings, replace unescaped backslashes followed by 
  // anything that's not a valid JSON escape sequence with a double backslash
  let result = "";
  let inString = false;
  let escaped = false;
  
  for (let i = 0; i < sanitized.length; i++) {
    const ch = sanitized[i];
    const next = sanitized[i + 1];
    
    if (escaped) {
      result += ch;
      escaped = false;
    } else if (ch === "\\" && inString) {
      // Check if this is a valid JSON escape sequence
      if (next && "\"\\\/bfnrtu".includes(next)) {
        // Valid escape sequence
        result += ch;
        escaped = true;
      } else if (next) {
        // Invalid escape - need to double it
        result += "\\\\";
        // Don't consume next; let it be processed normally
      } else {
        result += ch;
      }
    } else if (ch === '"') {
      result += ch;
      inString = !inString;
    } else {
      result += ch;
    }
  }
  
  return result;
}

function unescapeJsonString(value) {
  let result = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "\\" && i + 1 < value.length) {
      const next = value[i + 1];
      const rest = value.slice(i + 2);
      i += 1;

      const nextIsLetter = /^[A-Za-z]/.test(rest[0] ?? "");
      const nextStartsWith = (prefix) => rest.startsWith(prefix);

      switch (next) {
        case '"': result += '"'; break;
        case '\\': result += '\\'; break;
        case '/': result += '/'; break;
        case 'n':
          if (nextStartsWith('ewline') || nextStartsWith('ewpage') || nextStartsWith('ewcommand') || nextStartsWith('ewenvironment') || nextStartsWith('ewrelax')) {
            result += '\\n';
          } else {
            result += '\n';
          }
          break;
        case 't':
          if (nextStartsWith('ext')) {
            result += '\\t';
          } else {
            result += '\t';
          }
          break;
        case 'r':
          if (nextIsLetter) {
            result += '\\r';
          } else {
            result += '\r';
          }
          break;
        case 'b':
          if (nextIsLetter) {
            result += '\\b';
          } else {
            result += '\b';
          }
          break;
        case 'f':
          if (nextIsLetter) {
            result += '\\f';
          } else {
            result += '\f';
          }
          break;
        case 'u': {
          const hex = value.slice(i + 1, i + 5);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            result += `\\u${hex}`;
            i += 4;
          } else {
            result += '\\u';
          }
        } break;
        default:
          result += `\\${next}`;
      }
    } else {
      result += ch;
    }
  }
  return result;
}

function findJsonField(text, fieldName) {
  // Find a field value in JSON text, handling malformed JSON gracefully
  const pattern = new RegExp(`"${fieldName}"\\s*:\\s*`, "i");
  const match = pattern.exec(text);
  if (!match) return null;

  let start = match.index + match[0].length;
  
  // Skip whitespace
  while (start < text.length && /\s/.test(text[start])) start++;
  
  if (text[start] === '"') {
    // String field — find closing quote
    start++;
    let value = "";
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escaped) {
        value += "\\" + ch;
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        return unescapeJsonString(value);
      }
      value += ch;
    }
    return unescapeJsonString(value);
  } else if (text[start] === "{" || text[start] === "[") {
    // Object or array field
    let depth = 1;
    let i = start + 1;
    let value = text[start];
    let escaped = false;
    while (i < text.length && depth > 0) {
      const ch = text[i];
      value += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "{" || ch === "[") {
        depth++;
      } else if (ch === "}" || ch === "]") {
        depth--;
      }
      i++;
    }
    return value;
  }
  
  return null;
}

function normalizeLatexString(tex) {
  if (typeof tex !== "string") return tex;
  return tex
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    // Convert literal JSON-style \n markers into LaTeX linebreaks.
    .replace(/\\n(?![A-Za-z])/g, "\\\\")
    .replace(/\\r(?![A-Za-z])/g, "\\\\")
    .replace(/\\t(?![A-Za-z])/g, "\\t");
}

function escapeLatexSpecialChars(tex) {
  if (typeof tex !== "string") return tex;
  return tex.replace(/(^|[^\\])([#&_])/g, "$1\\$2");
}

function parseJson(raw) {
  const candidate = extractJson(raw);
  const sanitized = sanitizeJson(candidate);
  
  try {
    const parsed = JSON.parse(sanitized);
    if (parsed && typeof parsed.edited_tex === "string") {
      parsed.edited_tex = normalizeLatexString(parsed.edited_tex);
      parsed.edited_tex = escapeLatexSpecialChars(parsed.edited_tex);
    }
    return parsed;
  } catch (e) {
    // Try removing trailing commas and extra whitespace
    const relaxed = sanitized
      .replace(/,\s*(?=[}\]])/g, "")  // trailing commas
      .replace(/:\s*""\s*}/g, ': ""}')  // empty strings before closing brace
      .replace(/:\s*""\s*,/g, ': "",'); // empty strings before comma
    
    try {
      const parsed = JSON.parse(relaxed);
      if (parsed && typeof parsed.edited_tex === "string") {
        parsed.edited_tex = normalizeLatexString(parsed.edited_tex);
        parsed.edited_tex = escapeLatexSpecialChars(parsed.edited_tex);
      }
      return parsed;
    } catch (e2) {
      // Last resort: manually extract known fields
      const expectedFields = ["edited_tex", "changes", "cover_letter", "contact", "score", "reasons", "missing_skills", "strong_points", "recommendation"];
      const reconstructed = {};
      
      for (const field of expectedFields) {
        const value = findJsonField(raw, field);
        if (value !== null) {
          try {
            reconstructed[field] = value.startsWith("{") || value.startsWith("[") 
              ? JSON.parse(value) 
              : unescapeJsonString(value);
          } catch {
            reconstructed[field] = unescapeJsonString(value);
          }
        }
      }
      
      if (Object.keys(reconstructed).length > 0) {
        if (typeof reconstructed.edited_tex === "string") {
          reconstructed.edited_tex = normalizeLatexString(reconstructed.edited_tex);
          reconstructed.edited_tex = escapeLatexSpecialChars(reconstructed.edited_tex);
        }
        console.warn("JSON reconstructed from broken response (fields found:", Object.keys(reconstructed).join(", ") + ")");
        return reconstructed;
      }
      
      console.error("JSON parse triple-fail. Raw (first 300 chars):", raw.slice(0, 300));
      throw new Error(`JSON parse failed (tried 3 times). Position ${e.message}`);
    }
  }
}

async function chat(prompt, model = "qwen2.5:7b") {
  let res;
  try {
    res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        stream: false,
        options: { temperature: 0.3, num_predict: 4096 },
      }),
      signal: AbortSignal.timeout(300_000),
    });
  } catch (err) {
    if (err?.name === "AbortError" || err?.message?.includes("timeout")) {
      throw new Error("Ollama demorou demais para responder. Verifique se o servidor está ativo e tente novamente.");
    }
    throw err;
  }

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
    return parseJson(raw);
  }

  if (action === "edit_resume") {
    const resumeTex = getResumeTeX();
    const prompt = `Você é especialista em currículos LaTeX. Edite o currículo para a vaga.

  REGRAS:
  - Mantenha TODA a formatação LaTeX intacta (\\textbf, \\section, etc)
  - Adapte apenas: resumo/objetivo, ordem de skills, palavras-chave relevantes
  - NÃO invente experiências ou habilidades que não existem
  - NÃO altere datas, empresas, cargos ou conquistas
  - Responda APENAS com um JSON válido e bem formatado
  - O campo 'edited_tex' deve conter LaTeX válido, sem o texto literal "\\n" no resultado final
  - Use "\\\\" para quebras de linha LaTeX no conteúdo de 'edited_tex'; não deixe "\\\\n" literais no resultado final
  - Escape corretamente todas as aspas e barras invertidas; cada barra invertida LaTeX deve ser representada como "\\\\" no JSON bruto

CURRÍCULO ORIGINAL (primeiras 3000 chars):
${resumeTex.slice(0, 3000)}

VAGA: ${payload.job_title}
DESCRIÇÃO (primeiras 1000 chars):
${payload.job_description.slice(0, 1000)}

Retorne JSON em UMA ÚNICA LINHA (sem quebras literais):
{"edited_tex":"<LaTeX completo com \\\\n para quebras>","changes":["mudança 1","mudança 2"],"cover_letter":"<3 parágrafos em português>","contact":{"name":"","email":"","phone":""}}`;

    const raw = await chat(prompt, "qwen2.5:7b"); // modelo maior para edição
    return parseJson(raw);
  }

  if (action === "map_form") {
    // payload.prompt must contain the context JSON
    const raw = await chat(payload.prompt, "qwen2.5:3b");
    return raw; // expected to be JSON already
  }

  throw new Error(`Ação Ollama desconhecida: ${action}`);
}
