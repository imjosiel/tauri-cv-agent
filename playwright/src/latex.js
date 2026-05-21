// playwright/src/latex.js
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const DATA_DIR = `${process.env.APPDATA ?? "."}/cv-agent`;
const OUT_DIR  = join(DATA_DIR, "curriculo", "output");

export async function compileLaTeX(texContent, jobId) {
  const jobDir = join(OUT_DIR, jobId);
  mkdirSync(jobDir, { recursive: true });

  const texPath = join(jobDir, "curriculo.tex");
  const pdfPath = join(jobDir, "curriculo.pdf");

  writeFileSync(texPath, texContent, "utf8");

  // Tenta latexmk primeiro (mais rápido), fallback para pdflatex
  try {
    execSync(
      `latexmk -pdf -interaction=nonstopmode -halt-on-error -outdir="${jobDir}" "${texPath}"`,
      { timeout: 60000, stdio: "pipe" }
    );
  } catch {
    try {
      execSync(
        `pdflatex -interaction=nonstopmode -halt-on-error -output-directory="${jobDir}" "${texPath}"`,
        { timeout: 60000, stdio: "pipe" }
      );
      // Segunda passagem para referências
      execSync(
        `pdflatex -interaction=nonstopmode -output-directory="${jobDir}" "${texPath}"`,
        { timeout: 60000, stdio: "pipe" }
      );
    } catch (e2) {
      throw new Error(
        "TeX Live não encontrado ou erro de compilação. " +
        "Instale em: https://tug.org/texlive/windows.html\n" +
        e2.message.slice(0, 300)
      );
    }
  }

  return pdfPath;
}
