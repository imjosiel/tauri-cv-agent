// playwright/src/latex.js
import { mkdirSync, writeFileSync, copyFileSync, readdirSync, existsSync, readFileSync } from "fs";
import { join, extname, delimiter } from "path";
import { execSync } from "child_process";

const DATA_DIR    = join(process.env.APPDATA ?? process.env.HOME ?? ".", "cv-agent");
const OUT_DIR     = join(DATA_DIR, "curriculo", "output");
const TPL_DIR     = join(DATA_DIR, "curriculo", "templates");

// ── Detecção do TinyTeX ───────────────────────────────────────────────────────

function findTexBin() {
  const candidates = [];

  if (process.platform === "win32") {
    const tinytex = join(DATA_DIR, "tinytex");
    candidates.push(
      join(tinytex, "bin", "windows"),
      join(tinytex, "bin", "win32"),
      join(tinytex, "TinyTeX", "bin", "windows"),
      join(tinytex, "TinyTeX", "bin", "win32"),
    );
    for (let y = 2030; y >= 2020; y--) {
      candidates.push(
        join("C:", "texlive", String(y), "bin", "windows"),
        join("C:", "texlive", String(y), "bin", "win32"),
      );
    }
  } else {
    const tinytex = join(DATA_DIR, "tinytex");
    candidates.push(
      join(tinytex, "bin", "x86_64-linux"),
      join(tinytex, "bin", "aarch64-linux"),
      join(tinytex, "bin", "universal-darwin"),
      join(tinytex, "TinyTeX", "bin", "x86_64-linux"),
      join(tinytex, "TinyTeX", "bin", "universal-darwin"),
    );
    for (let y = 2030; y >= 2020; y--) {
      candidates.push(
        `/usr/local/texlive/${y}/bin/x86_64-linux`,
        `/usr/local/texlive/${y}/bin/aarch64-linux`,
        `/usr/local/texlive/${y}/bin/universal-darwin`,
      );
    }
    candidates.push("/usr/bin", "/usr/local/bin");
  }

  const exe = process.platform === "win32" ? "pdflatex.exe" : "pdflatex";
  return candidates.find((bin) => existsSync(join(bin, exe))) ?? null;
}

function buildEnv() {
  const env = { ...process.env };
  const texBin = findTexBin();
  if (texBin) {
    env.PATH = `${texBin}${delimiter}${env.PATH ?? ""}`;
    console.log(`[latex] Usando TeX de: ${texBin}`);
  } else {
    console.warn("[latex] TeX Live não encontrado.");
  }
  return env;
}

// ── Patch de imagens faltantes ────────────────────────────────────────────────
// Espelha a função patch_missing_images do latex.rs.
// Substitui \includegraphics{arquivo} por \phantom{\includegraphics{arquivo}}
// quando o arquivo não existe no diretório de saída ou está marcado como placeholder.

function loadPlaceholderSet() {
  const placeholders = new Set();
  if (!existsSync(TPL_DIR)) return placeholders;

  for (const entry of readdirSync(TPL_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const metaPath = join(TPL_DIR, entry.name, "assets-meta.json");
    if (!existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf8"));
      for (const f of meta.placeholder_assets ?? []) {
        placeholders.add(f);
      }
    } catch {}
  }
  return placeholders;
}

function parseIncludeGraphics(s) {
  // s começa em \includegraphics
  let idx = "\\includegraphics".length;
  if (idx >= s.length) return null;

  // Pula espaços
  while (idx < s.length && /\s/.test(s[idx])) idx++;

  // Pula [opções] se presente
  if (s[idx] === "[") {
    idx++;
    let depth = 1;
    while (idx < s.length && depth > 0) {
      if (s[idx] === "[") depth++;
      else if (s[idx] === "]") depth--;
      idx++;
    }
  }

  // Pula espaços
  while (idx < s.length && /\s/.test(s[idx])) idx++;

  // Extrai {filename}
  if (s[idx] !== "{") return null;
  idx++;
  const nameStart = idx;
  let depth = 1;
  while (idx < s.length && depth > 0) {
    if (s[idx] === "{") depth++;
    else if (s[idx] === "}") depth--;
    idx++;
  }
  if (depth !== 0) return null;

  const filename = s.slice(nameStart, idx - 1).trim();
  if (!filename) return null;

  return { fullMatch: s.slice(0, idx), filename };
}

function patchMissingImages(tex, jobDir) {
  const placeholders = loadPlaceholderSet();
  let result = "";
  let remaining = tex;
  const marker = "\\includegraphics";

  while (true) {
    const pos = remaining.indexOf(marker);
    if (pos === -1) { result += remaining; break; }

    result += remaining.slice(0, pos);
    remaining = remaining.slice(pos);

    const parsed = parseIncludeGraphics(remaining);
    if (!parsed) {
      // Não conseguiu parsear — avança um caractere para não travar
      result += marker;
      remaining = remaining.slice(marker.length);
      continue;
    }

    const { fullMatch, filename } = parsed;

    // Verifica se o arquivo existe (com ou sem extensão explícita)
    const fileExists =
      existsSync(join(jobDir, filename)) ||
      existsSync(join(jobDir, filename + ".png")) ||
      existsSync(join(jobDir, filename + ".jpg")) ||
      existsSync(join(jobDir, filename + ".pdf"));

    const isPlaceholder = placeholders.has(filename);

    if (!fileExists || isPlaceholder) {
      console.log(`[latex] phantom: '${filename}' (exists=${fileExists}, placeholder=${isPlaceholder})`);
      result += `\\phantom{${fullMatch}}`;
    } else {
      result += fullMatch;
    }

    remaining = remaining.slice(fullMatch.length);
  }

  return result;
}

// ── Compilação ────────────────────────────────────────────────────────────────

export async function compileLaTeX(texContent, jobId) {
  const jobDir = join(OUT_DIR, jobId);
  mkdirSync(jobDir, { recursive: true });

  const texPath = join(jobDir, "curriculo.tex");
  const pdfPath = join(jobDir, "curriculo.pdf");

  // 1. Copia assets primeiro — assim patchMissingImages sabe o que existe
  copyAssetsToOutput(jobDir);

  // 2. Aplica patch de imagens faltantes antes de escrever o .tex
  const patched = patchMissingImages(texContent, jobDir);
  writeFileSync(texPath, patched, "utf8");

  const env  = buildEnv();
  const opts = { timeout: 120_000, stdio: "pipe", env };

  // 3. Tenta latexmk, fallback para pdflatex
  let compiled = false;
  try {
    execSync(
      `latexmk -pdf -interaction=nonstopmode -halt-on-error -outdir="${jobDir}" "${texPath}"`,
      opts,
    );
    compiled = true;
  } catch {
    // latexmk não disponível ou falhou
  }

  if (!compiled) {
    for (let pass = 1; pass <= 2; pass++) {
      try {
        execSync(
          `pdflatex -interaction=nonstopmode -halt-on-error -output-directory="${jobDir}" "${texPath}"`,
          opts,
        );
      } catch (err) {
        const raw = (err.stdout?.toString() ?? "") + (err.stderr?.toString() ?? "") || String(err);
        const errorLines = raw
          .split("\n")
          .filter((l) => l.startsWith("!") || l.includes("Error") || l.includes("Fatal"))
          .slice(0, 6)
          .join("\n");
        const summary = errorLines || raw.slice(0, 1000);

        if (pass === 1) {
          throw new Error(
            `Erro na compilação LaTeX (passagem ${pass}):\n${summary}\n\n` +
            `Se o pdflatex não foi encontrado, aguarde o cv-agent instalar o TinyTeX ` +
            `na primeira compilação via interface.`,
          );
        }
        console.warn(`[latex] Aviso na passagem 2: ${summary.slice(0, 200)}`);
      }
    }
  }

  if (!existsSync(pdfPath)) {
    throw new Error(`PDF não gerado em ${pdfPath}. Verifique o log em ${jobDir}/curriculo.log`);
  }

  return pdfPath;
}

function copyAssetsToOutput(jobDir) {
  if (!existsSync(TPL_DIR)) return;

  const supported = new Set([".png", ".jpg", ".jpeg", ".pdf", ".eps", ".svg", ".cls", ".sty", ".ttf", ".otf"]);
  let count = 0;

  function tryCopy(src, name) {
    try { copyFileSync(src, join(jobDir, name)); count++; }
    catch (e) { console.warn(`[latex] Falha ao copiar ${name}: ${e.message}`); }
  }

  for (const entry of readdirSync(TPL_DIR, { withFileTypes: true })) {
    const srcPath = join(TPL_DIR, entry.name);
    if (entry.isDirectory()) {
      for (const asset of readdirSync(srcPath, { withFileTypes: true })) {
        if (asset.isFile() && supported.has(extname(asset.name).toLowerCase())) {
          tryCopy(join(srcPath, asset.name), asset.name);
        }
      }
    } else if (entry.isFile() && supported.has(extname(entry.name).toLowerCase())) {
      tryCopy(srcPath, entry.name);
    }
  }

  console.log(`[latex] ${count} assets copiados para ${jobDir}`);
}
