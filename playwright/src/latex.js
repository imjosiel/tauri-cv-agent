// playwright/src/latex.js
import { mkdirSync, writeFileSync, copyFileSync, readdirSync, existsSync } from "fs";
import { join, extname, delimiter } from "path";
import { execSync } from "child_process";

const DATA_DIR = `${process.env.APPDATA ?? "."}/cv-agent`;
const OUT_DIR  = join(DATA_DIR, "curriculo", "output");

function findTexLiveBin() {
  const candidates = [];
  if (process.platform === "win32") {
    if (process.env.TEXLIVE) candidates.push(join(process.env.TEXLIVE, "bin", "win32"));
    if (process.env.TEXLIVE_ROOT) candidates.push(join(process.env.TEXLIVE_ROOT, "bin", "win32"));
    if (process.env.TEXLIVE_HOME) candidates.push(join(process.env.TEXLIVE_HOME, "bin", "win32"));
    candidates.push(join("C:", "texlive", "2026", "bin", "win32"));
    candidates.push(join("C:", "texlive", "2025", "bin", "win32"));
    candidates.push(join("C:", "texlive", "2024", "bin", "win32"));
  } else {
    if (process.env.TEXLIVE) candidates.push(join(process.env.TEXLIVE, "bin", "x86_64-linux"));
    if (process.env.TEXLIVE_ROOT) candidates.push(join(process.env.TEXLIVE_ROOT, "bin", "x86_64-linux"));
    candidates.push("/usr/local/texlive/2026/bin/x86_64-linux");
    candidates.push("/usr/local/texlive/2025/bin/x86_64-linux");
  }

  return candidates.find((bin) => existsSync(join(bin, process.platform === "win32" ? "pdflatex.exe" : "pdflatex"))) ?? null;
}

function prepareTexEnv() {
  const env = { ...process.env };
  const texBin = findTexLiveBin();
  if (texBin) {
    env.PATH = `${texBin}${delimiter}${env.PATH ?? ""}`;
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

  // Tenta latexmk primeiro (mais rápido), fallback para pdflatex
  try {
    execSync(
      `latexmk -pdf -interaction=nonstopmode -halt-on-error -outdir="${jobDir}" "${texPath}"`,
      { timeout: 60000, stdio: "pipe", env: prepareTexEnv() }
    );
  } catch {
    try {
      execSync(
        `pdflatex -interaction=nonstopmode -halt-on-error -output-directory="${jobDir}" "${texPath}"`,
        { timeout: 60000, stdio: "pipe", env: prepareTexEnv() }
      );
      // Segunda passagem para referências
      try {
        execSync(
          `pdflatex -interaction=nonstopmode -output-directory="${jobDir}" "${texPath}"`,
          { timeout: 60000, stdio: "pipe", env: prepareTexEnv() }
        );
      } catch (e3) {
        const stderr3 = e3.stderr?.toString?.() ?? "";
        const stdout3 = e3.stdout?.toString?.() ?? "";
        const detail3 = stderr3 || stdout3 || String(e3);
        throw new Error(
          "Erro na segunda passagem pdflatex:\n" +
          detail3.slice(0, 20000)
        );
      }
    } catch (e2) {
      const stderr = e2.stderr?.toString?.() ?? "";
      const stdout = e2.stdout?.toString?.() ?? "";
      const detail = stderr || stdout || String(e2);
      throw new Error(
        "TeX Live não encontrado ou erro de compilação. " +
        "Instale em: https://tug.org/texlive/windows.html\n" +
        detail.slice(0, 20000)
      );
    }
  }

  return pdfPath;
}

function copyAssetsToOutput(jobDir) {
  const templatesDir = join(process.env.APPDATA ?? ".", "cv-agent", "curriculo", "templates");
  if (!existsSync(templatesDir)) {
    console.warn(`Templates dir não existe: ${templatesDir}`);
    return;
  }

  const supported = [".png", ".jpg", ".jpeg", ".pdf", ".eps", ".svg", ".cls", ".sty"];
  let copiedCount = 0;

  try {
    for (const entry of readdirSync(templatesDir, { withFileTypes: true })) {
      const srcPath = join(templatesDir, entry.name);
      if (entry.isDirectory()) {
        for (const asset of readdirSync(srcPath, { withFileTypes: true })) {
          if (!asset.isFile()) continue;
          const ext = extname(asset.name).toLowerCase();
          if (!supported.includes(ext)) continue;
          try {
            const srcFile = join(srcPath, asset.name);
            const destFile = join(jobDir, asset.name);
            copyFileSync(srcFile, destFile);
            copiedCount++;
            if (ext === ".cls" || ext === ".sty") {
              console.log(`Copiado: ${asset.name} → ${destFile}`);
            }
          } catch (err) {
            console.warn(`Erro ao copiar ${asset.name}: ${err.message}`);
          }
        }
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (!supported.includes(ext)) continue;
        try {
          const destFile = join(jobDir, entry.name);
          copyFileSync(srcPath, destFile);
          copiedCount++;
          if (ext === ".cls" || ext === ".sty") {
            console.log(`Copiado: ${entry.name} → ${destFile}`);
          }
        } catch (err) {
          console.warn(`Erro ao copiar ${entry.name}: ${err.message}`);
        }
      }
    }
    console.log(`Assets copiados: ${copiedCount} arquivos para ${jobDir}`);
  } catch (err) {
    console.error(`Erro geral em copyAssetsToOutput: ${err.message}`);
  }
}
