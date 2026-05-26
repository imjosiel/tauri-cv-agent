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

// ── Compilação ────────────────────────────────────────────────────────────────

export async function compileLaTeX(texContent, jobId) {
  const jobDir = join(OUT_DIR, jobId);
  mkdirSync(jobDir, { recursive: true });

  const texPath = join(jobDir, "curriculo.tex");
  const pdfPath = join(jobDir, "curriculo.pdf");

  // Copia assets e escreve o .tex original sem modificações
  copyAssetsToOutput(jobDir);
  writeFileSync(texPath, texContent, "utf8");

  // Cria PNGs dummy (1x1 transparente) para imagens ausentes — funciona com qualquer template
  createDummyImages(texContent, jobDir);

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

// PNG 1x1 transparente — mínimo válido que o pdflatex aceita
const DUMMY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGIAAQAABQABDQottAAAAAAASUVORK5CYII=",
  "base64"
);

// Cria arquivos PNG dummy para toda imagem referenciada no .tex que não existe.
// Funciona com qualquer template LaTeX — não depende de comandos específicos.
function createDummyImages(tex, jobDir) {
  const placeholders = loadPlaceholderSet();
  const imageExts = new Set(["png", "jpg", "jpeg", "pdf", "eps", "svg", "gif"]);

  // Extrai {arquivo.ext} de qualquer lugar no .tex
  const found = new Set();
  let i = 0;
  while (i < tex.length) {
    if (tex[i] === "{") {
      const start = i + 1;
      let j = start;
      while (j < tex.length && tex[j] !== "}" && tex[j] !== "{" && tex[j] !== "\n") j++;
      if (tex[j] === "}") {
        const name = tex.slice(start, j).trim();
        const ext  = name.split(".").pop()?.toLowerCase() ?? "";
        if (imageExts.has(ext) && !name.includes("\\")) {
          found.add(name);
        }
      }
      i = j + 1;
    } else {
      i++;
    }
  }

  for (const name of found) {
    // Cria dummy mesmo para placeholders — o pdflatex precisa do arquivo no disco
    // O "placeholder" significa apenas que o usuário não tem a imagem real,
    // mas o dummy 1x1 garante que o pdflatex não quebre
    const dest = join(jobDir, name);
    if (!existsSync(dest)) {
      try {
        writeFileSync(dest, DUMMY_PNG);
        console.log(`[latex] dummy criado: ${name}`);
      } catch (e) {
        console.warn(`[latex] não foi possível criar dummy para '${name}': ${e.message}`);
      }
    }
  }
}


function copyAssetsToOutput(jobDir) {
  if (!existsSync(TPL_DIR)) return;

  const supported = new Set([".png", ".jpg", ".jpeg", ".pdf", ".eps", ".svg", ".cls", ".sty", ".ttf", ".otf"]);
  const placeholders = loadPlaceholderSet();
  let count = 0;

  function tryCopy(src, name) {
    // Não copia placeholders — deixa o arquivo ausente para patchMissingImages agir
    if (placeholders.has(name)) {
      console.log(`[latex] Pulando placeholder: ${name}`);
      return;
    }
    try {
      copyFileSync(src, join(jobDir, name));
      count++;
    } catch (e) { console.warn(`[latex] Falha ao copiar ${name}: ${e.message}`); }
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
