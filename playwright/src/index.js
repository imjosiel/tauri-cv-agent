// playwright/src/index.js
// Abre o Edge real do usuário via CDP — sem fingerprints de automação
import { chromium } from "playwright";
import { parseArgs } from "./args.js";
import { runSearch } from "./orchestrator.js";
import { mkdirSync, existsSync } from "fs";
import { join } from "path";
import { spawn } from "child_process";

const { query, config } = parseArgs(process.argv.slice(2));

function emit(event, data = {}) {
  process.stdout.write(JSON.stringify({ event, ...data }) + "\n");
}

function log(msg) {
  process.stderr.write(`[playwright] ${msg}\n`);
}

// Encontra o executável do Edge no Windows
function findEdge() {
  const paths = [
    join(process.env["ProgramFiles(x86)"] ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
    join(process.env["ProgramFiles"] ?? "",      "Microsoft", "Edge", "Application", "msedge.exe"),
    join(process.env.LOCALAPPDATA ?? "",          "Microsoft", "Edge", "Application", "msedge.exe"),
  ];
  return paths.find(p => existsSync(p)) ?? null;
}

async function isCdpRunning(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForCdp(port, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isCdpRunning(port)) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

const CDP_PORT = 9222;

async function main() {
  emit("progress", { message: "Iniciando Edge..." });
  log("Iniciando com CDP...");

  const edgePath = findEdge();
  if (!edgePath) {
    const msg = "Microsoft Edge não encontrado. Instale o Edge e tente novamente.";
    emit("night_error", { error: msg });
    process.exit(1);
  }
  log(`Edge encontrado: ${edgePath}`);

  const profileDir = join(
    process.env.APPDATA ?? ".",
    "cv-agent", "browser-profile"
  );
  mkdirSync(profileDir, { recursive: true });

  let edgeProcess = null;
  const alreadyRunning = await isCdpRunning(CDP_PORT);

  if (!alreadyRunning) {
    log(`Abrindo Edge com CDP na porta ${CDP_PORT}...`);

    edgeProcess = spawn(edgePath, [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profileDir}`,
      "--start-maximized",
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ], {
      detached: false,
      stdio: "ignore",
    });

    // FIX: não mata o Edge se o processo sair inesperadamente
    edgeProcess.on("exit", (code) => {
      log(`Edge encerrou com código ${code}`);
    });

    log("Aguardando CDP ficar disponível...");
    const ready = await waitForCdp(CDP_PORT, 20000);
    if (!ready) {
      const msg = "Edge não respondeu no CDP. Tente fechar todas as janelas do Edge e tente novamente.";
      log(msg);
      emit("night_error", { error: msg });
      process.exit(1);
    }
    log("CDP pronto.");
  } else {
    log("CDP já estava rodando, conectando...");
  }

  emit("progress", { message: "Edge aberto, conectando..." });

  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    log("Conectado via CDP.");
  } catch (err) {
    const msg = `Falha ao conectar no Edge via CDP: ${err.message}`;
    log(msg);
    emit("night_error", { error: msg });
    if (edgeProcess) edgeProcess.kill();
    process.exit(1);
  }

  const context = browser.contexts()[0] ?? await browser.newContext();

  emit("progress", { message: "Conectado. Iniciando busca..." });
  await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));

  try {
    await runSearch({ context, query, config, emit, log });
  } catch (err) {
    log(`Erro na busca: ${err.message}\n${err.stack}`);
    emit("night_error", { error: err.message });
  } finally {
    // FIX: desconecta o Playwright mas NÃO mata o Edge.
    // O usuário pode ainda estar vendo a tela ou resolvendo um CAPTCHA.
    // O Edge ficará aberto até o usuário fechar manualmente.
    await browser.close().catch(() => {});
    log("Playwright desconectado. Edge continua aberto para uso do usuário.");

    // Só mata o processo Edge se ele foi iniciado por NÓS e
    // stop_on_captcha=false (sem necessidade de interação manual)
    if (edgeProcess && !config.stop_on_captcha) {
      // Aguarda 3s para garantir que a última screenshot foi tirada
      await new Promise(r => setTimeout(r, 3000));
      edgeProcess.kill();
    }
  }
}

main().catch((e) => {
  process.stderr.write(`[playwright] Erro fatal: ${e.message}\n${e.stack}\n`);
  process.stdout.write(JSON.stringify({ event: "night_error", error: e.message }) + "\n");
  process.exit(1);
});
