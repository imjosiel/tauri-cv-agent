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

// Encontra o último argumento {conteudo} de um comando LaTeX.
// Retorna { open, close, content } onde open/close são índices do { e }.
function lastBraceArg(s, cmd) {
  const cmdPos = s.indexOf(cmd);
  if (cmdPos === -1) return null;
  let i = cmdPos + cmd.length;
  let last = null;

  while (i < s.length) {
    const ch = s[i];
    if (ch === " " || ch === "\t") { i++; continue; }
    if (ch === "[") {
      i++;
      let d = 1;
      while (i < s.length && d > 0) {
        if (s[i] === "[") d++;
        else if (s[i] === "]") d--;
        i++;
      }
      continue;
    }
    if (ch === "{") {
      const open = i;
      i++;
      let d = 1;
      while (i < s.length && d > 0) {
        if (s[i] === "{") d++;
        else if (s[i] === "}") d--;
        i++;
      }
      last = { open, close: i - 1 };
      continue;
    }
    break;
  }

  if (!last) return null;
  const content = s.slice(last.open + 1, last.close).trim();
  return { open: last.open, close: last.close, content };
}

// Injeta redefinições LaTeX de \cvevent, \cvdegree e \roundpic que usam
// \ifthenelse para ignorar o argumento de imagem quando estiver vazio.
function injectSafeCommands(tex) {
  if (tex.includes("% cv-agent: safe image commands")) return tex;

  const safeDefs = `
% cv-agent: safe image commands — redefine para ignorar imagem ausente
\\makeatletter
\\renewcommand{\\cvevent}[6]{%
  {#1} & \\textbf{#2}\\newline\\textsc{#3} $\\cdot$ {#4 ~\\faMapMarker}\\newline%
  {\\color{black!70}\\footnotesize #5}\\vspace{1.5em} &
  \\raisebox{-0.7\\height}{%
    \\ifthenelse{\\equal{#6}{}}{}{\\includegraphics[height=1cm]{#6}}%
  }%
}
\\renewcommand{\\cvdegree}[6]{%
  {#1} & \\textbf{#2}\\newline\\textsc{#3} $\\cdot$ {#4 {\\phantom{i}\\footnotesize ~\\faUniversity}}\\newline%
  {\\color{black!70}\\scriptsize #5}\\vspace{0.5em} &
  \\raisebox{-0.7\\height}{%
    \\ifthenelse{\\equal{#6}{}}{}{\\includegraphics[height=0.5cm]{#6}}%
  }%
}
\\renewcommand{\\roundpic}[1]{%
  \\ifthenelse{\\equal{#1}{}}{}{%
    \\begin{figure}[H]\\tikz\\draw[path picture={\\node at (path picture bounding box.center)%
      {\\includegraphics[height=3.5cm]{#1}};}] (0,2) circle (1.7);\\end{figure}}%
}
\\makeatother
`;

  const pos = tex.indexOf("\\begin{document}");
  if (pos !== -1) {
    return tex.slice(0, pos) + safeDefs + tex.slice(pos);
  }
  return tex + safeDefs;
}


function patchLine(line, valid) {
  let s = line;

  // \includegraphics
  if (s.includes("\\includegraphics")) {
    const r = lastBraceArg(s, "\\includegraphics");
    if (r && !valid(r.content)) {
      const cmdStart = s.indexOf("\\includegraphics");
      const cmdEnd   = r.close + 1;
      const inner    = s.slice(cmdStart, cmdEnd);
      s = s.slice(0, cmdStart) + `\\phantom{${inner}}` + s.slice(cmdEnd);
    }
  }

  // \roundpic
  if (s.includes("\\roundpic")) {
    const r = lastBraceArg(s, "\\roundpic");
    if (r && !valid(r.content)) {
      s = s.slice(0, r.open) + "{}" + s.slice(r.close + 1);
    }
  }

  // \cvevent, \cvdegree, etc — último {} é a imagem
  for (const cmd of ["\\cvevent", "\\cvdegree", "\\cvpub", "\\cvproject"]) {
    if (!s.includes(cmd)) continue;
    const r = lastBraceArg(s, cmd);
    if (r && r.content && !valid(r.content)) {
      console.log(`[latex] patch ${cmd} image: '${r.content}'`);
      s = s.slice(0, r.open) + "{}" + s.slice(r.close + 1);
    }
    break;
  }

  return s;
}

function patchMissingImages(tex, jobDir) {

  const placeholders = loadPlaceholderSet();

  function valid(filename) {
    if (!filename) return true;
    if (placeholders.has(filename)) return false;
    const candidates = [
      join(jobDir, filename),
      join(jobDir, filename + ".png"),
      join(jobDir, filename + ".jpg"),
      join(jobDir, filename + ".pdf"),
    ];
    return candidates.some((p) => {
      try { return require("fs").statSync(p).size > 100; } catch { return false; }
    });
  }

  const lines = tex.split("\n");
  return lines.map((line) => patchLine(line, valid)).join("\n");
}

// ── Compilação ────────────────────────────────────────────────────────────────

export async function compileLaTeX(texContent, jobId) {
  const jobDir = join(OUT_DIR, jobId);
  mkdirSync(jobDir, { recursive: true });

  const texPath = join(jobDir, "curriculo.tex");
  const pdfPath = join(jobDir, "curriculo.pdf");

  // 1. Copia assets primeiro — assim patchMissingImages sabe o que existe
  copyAssetsToOutput(jobDir);

  // 2. Injeta redefinições seguras de \cvevent, \cvdegree, \roundpic
  const withSafeCmds = injectSafeCommands(texContent);

  // 3. Substitui imagens faltantes por argumento vazio (tratado pelas redefinições)
  const patched = patchMissingImages(withSafeCmds, jobDir);
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
  const placeholders = loadPlaceholderSet();
  let count = 0;

  function tryCopy(src, name) {
    // Não copia placeholders — deixa o arquivo ausente para patchMissingImages agir
    if (placeholders.has(name)) {
      console.log(`[latex] Pulando placeholder: ${name}`);
      return;
    }
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
