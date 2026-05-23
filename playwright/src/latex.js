// playwright/src/latex.js
//
// Compila um .tex em PDF usando o TeX Live disponível no sistema.
// Prioridade:
//   1. TinyTeX instalado pelo cv-agent (%APPDATA%/cv-agent/tinytex)
//   2. TeX Live do sistema (C:\texlive\*, /usr/local/texlive/*)
//   3. pdflatex no PATH

import { mkdirSync, writeFileSync, copyFileSync, readdirSync, existsSync } from "fs";
import { join, extname, delimiter } from "path";
import { execSync } from "child_process";

const DATA_DIR = join(process.env.APPDATA ?? process.env.HOME ?? ".", "cv-agent");
const OUT_DIR  = join(DATA_DIR, "curriculo", "output");

// Diretórios de binários TinyTeX conhecidos (mesmo mapeamento do texlive.rs)
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
    // TeX Live do sistema — testa anos de 2030 até 2020
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

  const pdflatexExe = process.platform === "win32" ? "pdflatex.exe" : "pdflatex";
  return candidates.find((bin) => existsSync(join(bin, pdflatexExe))) ?? null;
}

function buildEnv() {
  const env = { ...process.env };
  const texBin = findTexBin();
  if (texBin) {
    env.PATH = `${texBin}${delimiter}${env.PATH ?? ""}`;
    console.log(`[latex] Usando TeX de: ${texBin}`);
  } else {
    console.warn("[latex] TeX Live não encontrado no PATH nem nos diretórios conhecidos.");
  }
  return env;
}

export async function compileLaTeX(texContent, jobId) {
  const jobDir = join(OUT_DIR, jobId);
  mkdirSync(jobDir, { recursive: true });

  const texPath = join(jobDir, "curriculo.tex");
  const pdfPath = join(jobDir, "curriculo.pdf");

  writeFileSync(texPath, texContent, "utf8");
  copyAssetsToOutput(jobDir);

  const env = buildEnv();
  const opts = { timeout: 120_000, stdio: "pipe", env };

  // Tenta latexmk (melhor para múltiplas passagens automáticas)
  let compiled = false;
  try {
    execSync(
      `latexmk -pdf -interaction=nonstopmode -halt-on-error -outdir="${jobDir}" "${texPath}"`,
      opts,
    );
    compiled = true;
  } catch {
    // latexmk não disponível ou falhou — tenta pdflatex direto
  }

  if (!compiled) {
    // Duas passagens para resolver referências cruzadas
    for (let pass = 1; pass <= 2; pass++) {
      try {
        execSync(
          `pdflatex -interaction=nonstopmode -halt-on-error -output-directory="${jobDir}" "${texPath}"`,
          opts,
        );
      } catch (err) {
        const raw = (err.stdout?.toString() ?? "") + (err.stderr?.toString() ?? "") || String(err);

        // Extrai linhas de erro LaTeX para mensagem limpa
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
        // Na segunda passagem, alguns erros de referência são esperados — ignora
        console.warn(`[latex] Aviso na passagem 2 (pode ser inofensivo): ${summary.slice(0, 200)}`);
      }
    }
  }

  if (!existsSync(pdfPath)) {
    throw new Error(`PDF não gerado em ${pdfPath}. Verifique o log em ${jobDir}/curriculo.log`);
  }

  return pdfPath;
}

function copyAssetsToOutput(jobDir) {
  const templatesDir = join(DATA_DIR, "curriculo", "templates");
  if (!existsSync(templatesDir)) return;

  const supported = new Set([".png", ".jpg", ".jpeg", ".pdf", ".eps", ".svg", ".cls", ".sty", ".ttf", ".otf"]);
  let count = 0;

  function copyFile(src, name) {
    try {
      copyFileSync(src, join(jobDir, name));
      count++;
    } catch (e) {
      console.warn(`[latex] Falha ao copiar ${name}: ${e.message}`);
    }
  }

  for (const entry of readdirSync(templatesDir, { withFileTypes: true })) {
    const srcPath = join(templatesDir, entry.name);
    if (entry.isDirectory()) {
      for (const asset of readdirSync(srcPath, { withFileTypes: true })) {
        if (asset.isFile() && supported.has(extname(asset.name).toLowerCase())) {
          copyFile(join(srcPath, asset.name), asset.name);
        }
      }
    } else if (entry.isFile() && supported.has(extname(entry.name).toLowerCase())) {
      copyFile(srcPath, entry.name);
    }
  }

  console.log(`[latex] ${count} assets copiados para ${jobDir}`);
}
