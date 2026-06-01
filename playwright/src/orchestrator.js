// playwright/src/orchestrator.js
import { humanDelay, randomBetween } from "./utils.js";
import { searchLinkedIn } from "./sites/linkedin.js";
import { searchIndeed } from "./sites/indeed.js";
import { searchCatho } from "./sites/catho.js";
import { searchInfoJobs } from "./sites/infojobs.js";
import { callOllama } from "./ollama.js";
import { compileLaTeX } from "./latex.js";
import { checkCaptcha, handleCaptcha } from "./captcha.js";
import { isExternalATS, ensureVisionModel, runATSAgent } from "./ats-agent.js";

const SITE_SEARCHERS = {
  linkedin: searchLinkedIn,
  indeed:   searchIndeed,
  catho:    searchCatho,
  infojobs: searchInfoJobs,
};

export async function runSearch({ context, query, config, emit, log }) {
  await ensureVisionModel(emit).catch(() => {});
  const { mode, min_score, max_per_night, delay_minutes, sites, blacklist,
          stop_on_captcha = false, modality = "any", locations = [] } = config;

  let applied = 0;
  const allJobs = [];

  const locationSuffix = locations.length > 0 ? ` ${locations[0]}` : " Brasil";

  // 1. Coleta vagas em todos os sites configurados
  for (const site of sites) {
    const searcher = SITE_SEARCHERS[site];
    if (!searcher) continue;

    emit("progress", { message: `Buscando vagas no ${site}...` });
    log(`Iniciando busca no ${site}`);

    try {
      const page = await context.newPage();
      const jobs = await searcher(page, query + locationSuffix, emit);
      await page.close();

      const filtered = modality === "any"
        ? jobs
        : jobs.filter(j => matchesModality(j, modality));

      allJobs.push(...filtered.map((j) => ({ ...j, site })));
      emit("progress", { message: `${filtered.length} vagas encontradas no ${site}` });
      log(`${filtered.length} vagas no ${site}`);
    } catch (err) {
      log(`Erro no ${site}: ${err.message}`);
      emit("progress", { message: `Erro ao buscar no ${site}: ${err.message}` });
    }
  }

  emit("progress", { message: `Total: ${allJobs.length} vagas. Iniciando análise...` });
  log(`Total: ${allJobs.length} vagas`);

  // 2. Processa cada vaga
  for (const job of allJobs) {
    if (applied >= max_per_night) {
      emit("progress", { message: `Limite de ${max_per_night} candidaturas atingido. Encerrando.` });
      break;
    }

    // Blacklist
    if (blacklist.some((b) => job.company?.toLowerCase().includes(b.toLowerCase()))) {
      emit("job_skipped", { ...job, skip_reason: "Empresa na blacklist" });
      continue;
    }

    emit("job_found", job);

    // 3. Analisa fit com Ollama
    let analysis;
    try {
      analysis = await callOllama("analyze", {
        job_description: job.description,
        job_title: job.title,
        company: job.company,
      });
    } catch (err) {
      emit("job_skipped", { ...job, skip_reason: `Erro na análise: ${err.message}` });
      continue;
    }

    const score = analysis.score ?? 0;
    job.score = score;
    emit("job_analyzed", { ...job, score, recommendation: analysis.recommendation });

    // Score abaixo do mínimo
    if (score < min_score) {
      emit("job_skipped", { ...job, skip_reason: `Score ${score}% abaixo do mínimo ${min_score}%` });
      continue;
    }

    // Modo dry-run: não submete, só registra
    if (mode === "dry_run") {
      emit("job_skipped", { ...job, skip_reason: "Modo dry-run: não enviado" });
      continue;
    }

    // Modo manual: aguarda aprovação via IPC Tauri (evento bidirecional)
    if (mode === "manual") {
      emit("job_awaiting_approval", job);
      const approved = await waitForApproval(job.id, 5 * 60 * 1000, emit);
      if (!approved) {
        emit("job_skipped", { ...job, skip_reason: "Aprovação manual não recebida" });
        continue;
      }
    }

    // 4. Edita currículo com Ollama
    let resumeResult;
    try {
      resumeResult = await callOllama("edit_resume", {
        job_description: job.description,
        job_title: job.title,
      });
    } catch (err) {
      emit("job_skipped", { ...job, skip_reason: `Erro ao editar currículo: ${err.message}` });
      continue;
    }

    // 5. Compila PDF
    let pdfPath;
    try {
      pdfPath = await compileLaTeX(resumeResult.edited_tex, job.id);
    } catch (err) {
      emit("job_skipped", { ...job, skip_reason: `Erro ao compilar PDF: ${err.message}` });
      continue;
    }

    // 6. Submete candidatura via Playwright
    const page = await context.newPage();
    try {
      const result = await submitApplication({
        page, job, pdfPath,
        coverLetter: config.cover_letter ? resumeResult.cover_letter : null,
        stopOnCaptcha: stop_on_captcha,
        emit,
        log,
      });

      if (result.success) {
        applied++;
        emit("job_applied", { ...job, resume_path: pdfPath, applied_at: new Date().toISOString() });
      } else if (result.captcha) {
        emit("captcha_detected", {
          ...job,
          screenshot_path: result.screenshot,
          skip_reason: "CAPTCHA detectado — não resolvido dentro do tempo limite",
        });
      } else {
        emit("job_skipped", { ...job, skip_reason: result.reason ?? "Erro desconhecido no envio" });
      }
    } catch (err) {
      emit("job_skipped", { ...job, skip_reason: `Exceção no envio: ${err.message}` });
    } finally {
      await page.close();
    }

    // 7. Delay humanizado entre candidaturas
    const delayMs = randomBetween(
      delay_minutes * 60 * 1000 * 0.6,
      delay_minutes * 60 * 1000 * 1.4
    );
    emit("progress", { message: `Aguardando ${Math.round(delayMs / 60000)} min antes da próxima...` });
    await humanDelay(delayMs);
  }

  emit("progress", { message: `Concluído: ${applied} candidatura(s) enviada(s)` });
  log(`Concluído: ${applied} enviadas`);

  process.stdout.write(JSON.stringify({
    event: "night_finished",
    applied,
    skipped: allJobs.length - applied,
    captcha: 0,
  }) + "\n");
}

// Detecta modalidade pelo texto da vaga
function buildCandidateInfo(job) {
  // Retorna informações básicas do candidato para o ATS agent
  // O agente vai usar isso para preencher formulários
  return [
    `Vaga pretendida: ${job.title}`,
    `Empresa: ${job.company}`,
    `Localização: ${job.location ?? ""}`,
    `Site de origem: ${job.site ?? ""}`,
  ].filter(Boolean).join("\n");
}

function matchesModality(job, modality) {
  const text = `${job.title} ${job.description}`.toLowerCase();
  const remoteTerms  = ["remoto", "remote", "home office", "100% remoto", "trabalho remoto"];
  const hybridTerms  = ["híbrido", "hybrid", "presencial e remoto", "flexível"];
  const onsiteTerms  = ["presencial", "on-site", "onsite"];

  const isRemote  = remoteTerms.some(t => text.includes(t));
  const isHybrid  = hybridTerms.some(t => text.includes(t));
  const isOnsite  = onsiteTerms.some(t => text.includes(t)) && !isRemote;

  if (modality === "remote")  return isRemote;
  if (modality === "hybrid")  return isHybrid;
  if (modality === "onsite")  return isOnsite || (!isRemote && !isHybrid);
  return true;
}

async function submitApplication({ page, job, pdfPath, coverLetter, stopOnCaptcha, emit, log }) {
  emit("progress", { message: `Abrindo candidatura: ${job.title} @ ${job.company}` });

  await page.goto(job.apply_url ?? job.url, { waitUntil: "networkidle", timeout: 30000 });
  await humanDelay(1500, 2500);

  // FIX: verifica CAPTCHA e aguarda resolução se stop_on_captcha=true
  const hasCaptcha = await checkCaptcha(page);
  if (hasCaptcha) {
    emit("progress", { message: `CAPTCHA detectado em ${job.company}. ${stopOnCaptcha ? "Aguardando resolução manual (3 min)..." : "Pulando vaga."}` });

    if (stopOnCaptcha) {
      const resolved = await handleCaptcha(page, true);
      if (!resolved) {
        const screenshotPath = await takeScreenshot(page, job.id).catch(() => null);
        return { success: false, captcha: true, screenshot: screenshotPath };
      }
      // CAPTCHA resolvido pelo usuário — continua
      emit("progress", { message: `CAPTCHA resolvido! Continuando candidatura em ${job.company}...` });
    } else {
      const screenshotPath = await takeScreenshot(page, job.id).catch(() => null);
      return { success: false, captcha: true, screenshot: screenshotPath };
    }
  }

  // Cada site tem seu próprio handler de submissão
  const url = page.url();
  try {
    if (url.includes("linkedin.com")) {
      return await submitLinkedIn(page, pdfPath, coverLetter);
    } else if (url.includes("indeed.com")) {
      return await submitIndeed(page, pdfPath, coverLetter);
    } else if (url.includes("catho.com")) {
      return await submitCatho(page, pdfPath, coverLetter);
    } else if (url.includes("infojobs.com")) {
      return await submitInfoJobs(page, pdfPath, coverLetter);
    } else if (isExternalATS(url)) {
      emit("progress", { message: `ATS externo detectado (${new URL(url).hostname}) — agente de visão` });
      return runATSAgent({ page, pdfPath, candidateInfo: buildCandidateInfo(job), emit, jobTitle: job.title, company: job.company });
    } else {
      return { success: false, reason: `Site não suportado: ${url}` };
    }
  } catch (err) {
    const screenshotPath = await takeScreenshot(page, job.id).catch(() => null);
    return { success: false, reason: err.message, screenshot: screenshotPath };
  }
}

async function takeScreenshot(page, jobId) {
  const dir = `${process.env.APPDATA ?? "."}/cv-agent/screenshots`;
  const { mkdirSync } = await import("fs");
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/${jobId}-${Date.now()}.png`;
  await page.screenshot({ path, fullPage: false });
  return path;
}

// FIX: IPC via stdin em vez de polling de arquivo
// O Rust envia linhas JSON no stdin do processo Node quando o usuário aprova/pula
async function waitForApproval(jobId, timeoutMs, emit) {
  emit("progress", { message: `Aguardando aprovação manual para job ${jobId}...` });

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);

    let buffer = "";

    function onData(chunk) {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop(); // mantém linha incompleta

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          if (msg.job_id !== jobId) continue;
          if (msg.action === "approve") {
            cleanup();
            resolve(true);
          } else if (msg.action === "skip") {
            cleanup();
            resolve(false);
          }
        } catch {}
      }
    }

    function cleanup() {
      clearTimeout(timer);
      process.stdin.off("data", onData);
    }

    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

// Stubs de submissão por site
async function submitLinkedIn(page, pdfPath, coverLetter) {
  const { applyLinkedIn } = await import("./sites/linkedin.js");
  return applyLinkedIn(page, pdfPath, coverLetter);
}
async function submitIndeed(page, pdfPath, coverLetter) {
  const { applyIndeed } = await import("./sites/indeed.js");
  return applyIndeed(page, pdfPath, coverLetter);
}
async function submitCatho(page, pdfPath, coverLetter) {
  const { applyCatho } = await import("./sites/catho.js");
  return applyCatho(page, pdfPath, coverLetter);
}
async function submitInfoJobs(page, pdfPath, coverLetter) {
  const { applyInfoJobs } = await import("./sites/infojobs.js");
  return applyInfoJobs(page, pdfPath, coverLetter);
}
