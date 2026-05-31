// playwright/src/ats-agent.js
//
// Agente guiado por LLM (qwen2-vl:7b) para preencher formulários de candidatura
// em ATSs externos: Gupy, Greenhouse, Lever, Workday, TOTVS, etc.
//
// Fluxo por passo:
//   screenshot → base64 → qwen2-vl → JSON {action, selector, value} → executa → repete

import { existsSync } from "fs";

const OLLAMA_URL   = "http://localhost:11434";
const VISION_MODEL = "qwen2-vl:7b";
const MAX_STEPS    = 20;
const STEP_DELAY   = 1800;

export const KNOWN_ATS = [
  "gupy.io", "greenhouse.io", "lever.co", "workday.com", "myworkdayjobs.com",
  "totvs.com", "kenoby.com", "pandape.com.br", "solides.com.br", "breezy.hr",
  "jobscore.com", "recruitee.com", "abler.com.br", "vagas.com.br",
  "trampos.co", "seleção.digital", "jobconvo.com", "gupy.com.br",
];

export function isExternalATS(url) {
  try { return KNOWN_ATS.some(ats => url.includes(ats)); }
  catch { return false; }
}

// ── Garante qwen2-vl disponível (baixa se necessário) ────────────────────────

export async function ensureVisionModel(emit) {
  try {
    const res  = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    const has  = (data.models ?? []).some(m => m.name?.startsWith("qwen2-vl"));
    if (!has) {
      emit("progress", { message: "Baixando qwen2-vl:7b (primeira vez — pode demorar alguns minutos)..." });
      await fetch(`${OLLAMA_URL}/api/pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: VISION_MODEL, stream: false }),
        signal: AbortSignal.timeout(900_000),
      });
      emit("progress", { message: "qwen2-vl:7b pronto para uso." });
    }
  } catch (e) {
    emit("progress", { message: `Aviso: não foi possível verificar qwen2-vl:7b — ${e.message}` });
  }
}

// ── Screenshot → base64 ───────────────────────────────────────────────────────

async function screenshot(page) {
  try {
    const buf = await page.screenshot({ type: "jpeg", quality: 55, fullPage: false });
    return buf.toString("base64");
  } catch { return null; }
}

// ── Pergunta ao modelo o próximo passo ───────────────────────────────────────

async function askModel(imageBase64, pageText, candidateInfo, step) {
  const prompt = `Você está preenchendo uma candidatura de emprego online. Analise a tela e decida a próxima ação.

DADOS DO CANDIDATO:
${candidateInfo}

REGRAS:
- Responda SOMENTE com JSON, sem texto antes ou depois
- Preencha campos com os dados reais do candidato acima
- Para upload de currículo/CV/resume, use action "upload"
- Se a candidatura foi concluída com sucesso, use action "done"
- Se for impossível continuar (ex: exige cadastro obrigatório não automatizável), use action "failed"
- Use seletores CSS precisos: #id, [name="x"], [data-testid="x"], [placeholder="x"]
- Passo atual: ${step}/${MAX_STEPS}

TEXTO VISÍVEL NA PÁGINA:
${pageText.slice(0, 2000)}

JSON DE RESPOSTA:
{
  "action": "click" | "fill" | "select" | "upload" | "scroll" | "wait" | "done" | "failed",
  "selector": "seletor CSS ou texto do botão",
  "value": "valor a preencher (apenas para fill/select)",
  "reason": "explicação em uma linha"
}`;

  const messages = [{
    role: "user",
    content: imageBase64
      ? [
          { type: "text",      text: prompt },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
        ]
      : prompt,
  }];

  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: VISION_MODEL,
      messages,
      stream: false,
      options: { temperature: 0.1, num_predict: 400 },
    }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  const data = await res.json();
  const raw  = (data?.message?.content ?? "").trim();
  const m    = raw.match(/\{[\s\S]*?\}/);
  if (!m) throw new Error(`JSON inválido: ${raw.slice(0, 150)}`);
  return JSON.parse(m[0]);
}

// ── Executa a ação decidida pelo modelo ──────────────────────────────────────

async function execute(page, action, pdfPath) {
  const sel = action.selector ?? "";
  const val = action.value ?? "";

  // Resolve elemento pelo seletor, com fallback por texto
  async function find() {
    if (!sel) return null;
    let el = await page.$(sel).catch(() => null);
    if (el) return el;
    // Tenta como texto de botão/link
    el = await page.$(`button:has-text("${sel}"), a:has-text("${sel}"), [aria-label="${sel}"]`).catch(() => null);
    return el;
  }

  switch (action.action) {
    case "click": {
      const el = await find();
      if (!el) throw new Error(`Elemento não encontrado: ${sel}`);
      await el.scrollIntoViewIfNeeded().catch(() => {});
      await el.click({ timeout: 8000 });
      await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
      break;
    }
    case "fill": {
      const el = await find();
      if (!el) throw new Error(`Campo não encontrado: ${sel}`);
      await el.scrollIntoViewIfNeeded().catch(() => {});
      await el.fill(val);
      break;
    }
    case "select": {
      const el = await find();
      if (!el) throw new Error(`Select não encontrado: ${sel}`);
      await el.selectOption(val).catch(() => {});
      break;
    }
    case "upload": {
      if (!pdfPath || !existsSync(pdfPath)) throw new Error("PDF não disponível");
      const input = await page.$('input[type="file"]').catch(() => null);
      if (!input) throw new Error("Input de arquivo não encontrado");
      await input.setInputFiles(pdfPath);
      break;
    }
    case "scroll":
      await page.evaluate(() => window.scrollBy(0, 500));
      break;
    case "wait":
      await new Promise(r => setTimeout(r, 2500));
      break;
    default:
      throw new Error(`Ação desconhecida: ${action.action}`);
  }
}

// ── Agente principal ──────────────────────────────────────────────────────────

export async function runATSAgent({ page, pdfPath, candidateInfo, emit, jobTitle, company }) {
  const host = (() => { try { return new URL(page.url()).hostname; } catch { return "ATS"; } })();
  emit("progress", { message: `ATS Agent: iniciando em ${host} para "${jobTitle}"` });

  for (let step = 1; step <= MAX_STEPS; step++) {
    await new Promise(r => setTimeout(r, STEP_DELAY));

    const url      = page.url();
    const img      = await screenshot(page);
    const pageText = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");

    emit("progress", { message: `ATS Agent [${step}/${MAX_STEPS}]: ${url.slice(0, 70)}` });

    let action;
    try {
      action = await askModel(img, pageText, candidateInfo, step);
    } catch (e) {
      emit("progress", { message: `ATS Agent erro no modelo: ${e.message}` });
      return { success: false, reason: `Erro no modelo: ${e.message}` };
    }

    emit("progress", { message: `ATS Agent → ${action.action}: ${action.reason ?? action.selector ?? ""}` });

    if (action.action === "done")   return { success: true };
    if (action.action === "failed") return { success: false, reason: action.reason ?? "Agente não conseguiu completar" };

    try {
      await execute(page, action, pdfPath);
    } catch (e) {
      // Não aborta — o modelo vai ver o mesmo estado e tentar diferente no próximo passo
      emit("progress", { message: `ATS Agent aviso: ${e.message}` });
    }
  }

  return { success: false, reason: `ATS Agent: limite de ${MAX_STEPS} passos atingido` };
}
