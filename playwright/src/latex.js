// playwright/src/latex.js
import { mkdirSync, writeFileSync, copyFileSync, readdirSync, existsSync, readFileSync } from "fs";
import { join, extname, delimiter, dirname, basename, parse as parsePath } from "path";
import { execSync } from "child_process";

const DATA_DIR = join(process.env.APPDATA ?? process.env.HOME ?? ".", "cv-agent");
const OUT_DIR  = join(DATA_DIR, "curriculo", "output");
const TPL_DIR  = join(DATA_DIR, "curriculo", "templates");

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

// ── Constantes ────────────────────────────────────────────────────────────────

// PNG 1×1 transparente — mínimo válido que o pdflatex aceita
const DUMMY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGIAAQAABQABDQottAAAAAAASUVORK5CYII=",
  "base64"
);

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "pdf", "eps", "svg", "gif"]);
const STYLE_EXTS = new Set(["cls", "sty"]);

// ── Placeholder set ───────────────────────────────────────────────────────────

function loadPlaceholderSet() {
  const placeholders = new Set();
  if (!existsSync(TPL_DIR)) return placeholders;
  for (const entry of readdirSync(TPL_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const metaPath = join(TPL_DIR, entry.name, "assets-meta.json");
    if (!existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf8"));
      for (const f of meta.placeholder_assets ?? []) placeholders.add(f);
    } catch {}
  }
  return placeholders;
}

// ── Extração de referências de assets no .tex ─────────────────────────────────

function collectAssetRefs(tex) {
  const refs = new Set();
  const allExts = new Set([...IMAGE_EXTS, ...STYLE_EXTS]);

  // Varredura genérica: qualquer {nome.ext} com extensão conhecida
  let i = 0;
  while (i < tex.length) {
    if (tex[i] === "{") {
      const start = i + 1;
      let j = start;
      while (j < tex.length && tex[j] !== "}" && tex[j] !== "{" && tex[j] !== "\n") j++;
      if (tex[j] === "}") {
        const name = tex.slice(start, j).trim();
        const ext  = name.split(".").pop()?.toLowerCase() ?? "";
        if (allExts.has(ext) && !name.includes("\\") && name.length > 0) {
          refs.add(name);
        }
      }
      i = j + 1;
    } else {
      i++;
    }
  }

  // \documentclass[opts]{nome} → nome.cls
  const dcRe = /\\documentclass(?:\[[^\]]*\])?\{([^}]+)\}/g;
  for (const m of tex.matchAll(dcRe)) {
    const cls = m[1].trim().split(",")[0].trim();
    if (cls && !cls.includes("\\")) refs.add(`${cls}.cls`);
  }

  return refs;
}

// ── ensure_assets ─────────────────────────────────────────────────────────────
// Garante que todo asset referenciado no .tex existe no jobDir antes da compilação.
//
// Três casos:
// 1. Subpasta  — cria o diretório pai e o dummy dentro dele
// 2. Extensão alternativa — se foto.png não existe mas foto.jpg sim, copia com o nome esperado
// 3. .cls/.sty — cria stub mínimo em vez de dummy PNG

function ensureAssets(tex, jobDir) {
  const refs = collectAssetRefs(tex);

  // Mapa stem → caminho real em jobDir (para resolução de extensão alternativa)
  const existingByStem = new Map();
  try {
    for (const f of readdirSync(jobDir)) {
      const { name, ext } = parsePath(f);
      if (IMAGE_EXTS.has(ext.slice(1).toLowerCase())) {
        existingByStem.set(name.toLowerCase(), join(jobDir, f));
      }
    }
  } catch {}

  for (const refPath of refs) {
    const dest = join(jobDir, refPath);

    // Já existe — ok
    if (existsSync(dest)) continue;

    const ext  = extname(refPath).slice(1).toLowerCase();
    const stem = parsePath(refPath).name.toLowerCase();

    // FIX 1: garante que o diretório pai existe (subpastas)
    const parentDir = dirname(dest);
    if (parentDir !== jobDir) {
      try { mkdirSync(parentDir, { recursive: true }); } catch {}
    }

    if (IMAGE_EXTS.has(ext)) {
      // FIX 2: extensão alternativa já disponível no jobDir
      const alt = existingByStem.get(stem);
      if (alt) {
        console.log(`[latex] usando '${basename(alt)}' como substituto para '${refPath}'`);
        try {
          copyFileSync(alt, dest);
          continue;
        } catch (e) {
          console.warn(`[latex] falha ao copiar alternativo: ${e.message}`);
        }
      }
      // Cria dummy PNG (FIX 1 já criou o diretório pai)
      try {
        writeFileSync(dest, DUMMY_PNG);
        console.log(`[latex] dummy PNG criado: ${refPath}`);
      } catch (e) {
        console.warn(`[latex] não foi possível criar dummy para '${refPath}': ${e.message}`);
      }
    } else if (STYLE_EXTS.has(ext)) {
      // FIX 3: stub mínimo de .cls/.sty
      const stub = ext === "cls"
        ? "\\NeedsTeXFormat{LaTeX2e}\n\\ProvidesClass{stub}[2024/01/01 auto-generated stub]\n\\LoadClass{article}\n"
        : "% auto-generated stub\n";
      try {
        writeFileSync(dest, stub, "utf8");
        console.log(`[latex] stub .${ext} criado: ${refPath}`);
      } catch (e) {
        console.warn(`[latex] não foi possível criar stub para '${refPath}': ${e.message}`);
      }
    }
  }
}

// ── copyAssetsToOutput ────────────────────────────────────────────────────────

function copyAssetsToOutput(jobDir) {
  if (!existsSync(TPL_DIR)) return;

  const supported = new Set([".png", ".jpg", ".jpeg", ".pdf", ".eps", ".svg", ".cls", ".sty", ".ttf", ".otf"]);
  const placeholders = loadPlaceholderSet();
  let count = 0;

  function tryCopy(src, name) {
    if (placeholders.has(name)) {
      console.log(`[latex] pulando placeholder: ${name}`);
      return;
    }
    try {
      copyFileSync(src, join(jobDir, name));
      count++;
    } catch (e) {
      console.warn(`[latex] falha ao copiar ${name}: ${e.message}`);
    }
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

// ── compileLaTeX ──────────────────────────────────────────────────────────────

export async function compileLaTeX(texContent, jobId) {
  const jobDir = join(OUT_DIR, jobId);
  mkdirSync(jobDir, { recursive: true });

  const texPath = join(jobDir, "curriculo.tex");
  const pdfPath = join(jobDir, "curriculo.pdf");

  // 1. Copia assets reais dos templates
  copyAssetsToOutput(jobDir);

  // 2. Escreve o .tex
  writeFileSync(texPath, texContent, "utf8");

  // 3. Garante que todo asset referenciado existe no jobDir
  ensureAssets(texContent, jobDir);

  const env  = buildEnv();
  const opts = { timeout: 120_000, stdio: "pipe", env };

  // 4. Compila: latexmk → fallback pdflatex
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
        console.warn(`[latex] aviso na passagem 2: ${summary.slice(0, 200)}`);
      }
    }
  }

  if (!existsSync(pdfPath)) {
    throw new Error(`PDF não gerado em ${pdfPath}. Verifique o log em ${jobDir}/curriculo.log`);
  }

  return pdfPath;
}
