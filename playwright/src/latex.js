// playwright/src/latex.js
import { mkdirSync, writeFileSync, copyFileSync, readdirSync, existsSync, readFileSync } from "fs";
import { join, extname, delimiter, dirname, basename, parse as parsePath } from "path";
import { execSync } from "child_process";

const DATA_DIR = join(process.env.APPDATA ?? process.env.HOME ?? ".", "cv-agent");
const OUT_DIR  = join(DATA_DIR, "curriculo", "output");
const TPL_DIR  = join(DATA_DIR, "curriculo", "templates");

// ── TinyTeX ───────────────────────────────────────────────────────────────────

function findTexBin() {
  const candidates = [];
  if (process.platform === "win32") {
    const tinytex = join(DATA_DIR, "tinytex");
    candidates.push(
      join(tinytex, "bin", "windows"), join(tinytex, "bin", "win32"),
      join(tinytex, "TinyTeX", "bin", "windows"), join(tinytex, "TinyTeX", "bin", "win32"),
    );
    for (let y = 2030; y >= 2020; y--) {
      candidates.push(`C:\\texlive\\${y}\\bin\\windows`, `C:\\texlive\\${y}\\bin\\win32`);
    }
  } else {
    const tinytex = join(DATA_DIR, "tinytex");
    candidates.push(
      join(tinytex, "bin", "x86_64-linux"), join(tinytex, "bin", "aarch64-linux"),
      join(tinytex, "bin", "universal-darwin"),
      join(tinytex, "TinyTeX", "bin", "x86_64-linux"),
    );
    for (let y = 2030; y >= 2020; y--) {
      candidates.push(`/usr/local/texlive/${y}/bin/x86_64-linux`);
    }
    candidates.push("/usr/bin", "/usr/local/bin");
  }
  const exe = process.platform === "win32" ? "pdflatex.exe" : "pdflatex";
  return candidates.find(bin => existsSync(join(bin, exe))) ?? null;
}

function buildEnv() {
  const env = { ...process.env };
  const texBin = findTexBin();
  if (texBin) {
    env.PATH = `${texBin}${delimiter}${env.PATH ?? ""}`;
    console.log(`[latex] TeX de: ${texBin}`);
  } else {
    console.warn("[latex] TeX Live não encontrado.");
  }
  return env;
}

// ── PNG 1×1 transparente ──────────────────────────────────────────────────────

const DUMMY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGIAAQAABQABDQottAAAAAAASUVORK5CYII=",
  "base64"
);

const IMAGE_EXTS = new Set(["png","jpg","jpeg","pdf","eps","svg","gif"]);
const STYLE_EXTS = new Set(["cls","sty"]);

// Pacotes padrão — não criamos stub para eles
const BUILTIN_PKGS = new Set([
  "inputenc","fontenc","babel","geometry","graphicx","xcolor","hyperref",
  "amsmath","amssymb","amsfonts","tikz","pgf","listings","verbatim","enumitem",
  "fancyhdr","titlesec","parskip","microtype","booktabs","array","longtable",
  "multirow","multicol","float","caption","subcaption","natbib","biblatex",
  "csquotes","setspace","ragged2e","soul","ulem","fontawesome","fontawesome5",
  "academicons","calc","etoolbox","ifthen","xparse","expl3","l3packages",
  "lmodern","times","palatino","helvet","avant","courier","mathptmx","mathpazo",
  "fourier","utopia","charter","libertine","sourcesanspro","sourcecodepro",
  "raleway","roboto","opensans","cabin","lato","inconsolata",
]);

// ── Pré-processamento ─────────────────────────────────────────────────────────

const CUSTOM_CMD_ARGS = { cvevent: 6, cvdegree: 6, cvskill: 2, cvproject: 5 };

function fixCveventOutsideTabular(tex) {
  const cmds = [
    { name: "cvevent",  fmt: "r|p{0.68\\textwidth}c" },
    { name: "cvdegree", fmt: "r p{0.68\\textwidth} c" },
  ];
  let result = tex;

  function inTabular(t, pos) {
    const sl = t.slice(0, pos);
    return (sl.match(/\\begin\{tabular\}/g)||[]).length > (sl.match(/\\end\{tabular\}/g)||[]).length;
  }

  function getCmdEnd(t, i) {
    while (i < t.length) {
      while (i < t.length && " \t\n\r".includes(t[i])) i++;
      if (t[i] === "[") { while (i < t.length && t[i] !== "]") i++; i++; continue; }
      if (t[i] !== "{") break;
      let depth = 0; i++;
      while (i < t.length) {
        if (t[i] === "{") depth++;
        else if (t[i] === "}") { if (depth === 0) { i++; break; } depth--; }
        i++;
      }
    }
    return i;
  }

  for (const { name, fmt } of cmds) {
    const needle = `\\${name}`;
    let offset = 0;
    while (true) {
      const pos = result.indexOf(needle, offset);
      if (pos === -1) break;
      const after = pos + needle.length;
      if (!/[{\[ \t\n]/.test(result[after] ?? "")) { offset = pos + 1; continue; }
      if (inTabular(result, pos)) { offset = pos + 1; continue; }
      const end = getCmdEnd(result, after);
      const inner = result.slice(pos, end);
      const wrapped = `\\begin{tabular}{${fmt}}\n    ${inner}\n\\end{tabular}`;
      result = result.slice(0, pos) + wrapped + result.slice(end);
      offset = pos + wrapped.length;
    }
  }
  return result;
}

function fixCustomCommandArgs(tex) {
  let result = tex;
  for (const [cmdName, expected] of Object.entries(CUSTOM_CMD_ARGS)) {
    const needle = `\\${cmdName}`;
    let offset = 0;
    while (true) {
      const pos = result.indexOf(needle, offset);
      if (pos === -1) break;
      const after = pos + needle.length;
      if (!/[{\[ \t\n]/.test(result[after] ?? "")) { offset = pos + 1; continue; }
      let i = after, groups = 0;
      while (i < result.length) {
        while (i < result.length && " \t\n\r".includes(result[i])) i++;
        if (result[i] === "[") { while (i < result.length && result[i] !== "]") i++; i++; continue; }
        if (result[i] !== "{") break;
        let depth = 0; i++;
        while (i < result.length) {
          if (result[i] === "{") depth++;
          else if (result[i] === "}") { if (depth === 0) { i++; break; } depth--; }
          i++;
        }
        groups++;
      }
      const missing = expected - groups;
      if (missing > 0 && missing <= 3) {
        result = result.slice(0, i) + "{}".repeat(missing) + result.slice(i);
        offset = i + "{}".length * missing;
      } else {
        offset = pos + 1;
      }
    }
  }
  return result;
}

// ── Coleta de assets referenciados ───────────────────────────────────────────

function collectAssetRefs(tex) {
  const refs = new Set();

  // Lê o último argumento {...} de um comando
  function lastArg(str, offset) {
    let i = offset, last = "";
    while (i < str.length) {
      while (i < str.length && " \t\n\r".includes(str[i])) i++;
      if (str[i] === "[") { while (i < str.length && str[i] !== "]") i++; i++; continue; }
      if (str[i] !== "{") break;
      i++; const start = i;
      let depth = 0;
      while (i < str.length) {
        if (str[i] === "{") depth++;
        else if (str[i] === "}") { if (depth === 0) break; depth--; }
        i++;
      }
      last = str.slice(start, i).trim();
      i++;
    }
    return last;
  }

  // Comandos cujo último arg é arquivo de imagem
  const imgCmds = [
    "\\includegraphics", "\\includepdf", "\\roundpic", "\\pgfdeclareimage",
    "\\cvevent", "\\cvdegree",
  ];
  for (const cmd of imgCmds) {
    let offset = 0;
    while (true) {
      const pos = tex.indexOf(cmd, offset);
      if (pos === -1) break;
      offset = pos + cmd.length;
      if (!/[{\[ \t\n]/.test(tex[offset] ?? "")) continue;
      const name = lastArg(tex, offset);
      if (name && !name.startsWith("\\") && !name.includes(" ")) {
        refs.add(name.includes(".") ? name : `${name}.png`);
      }
    }
  }

  // \documentclass → .cls
  for (const m of tex.matchAll(/\\documentclass(?:\[[^\]]*\])?\{([^}]+)\}/g)) {
    const cls = m[1].trim().split(",")[0].trim();
    if (cls && !cls.includes("\\")) refs.add(`${cls}.cls`);
  }

  // \usepackage → .sty (não-padrão)
  for (const m of tex.matchAll(/\\usepackage(?:\[[^\]]*\])?\{([^}]+)\}/g)) {
    const pkg = m[1].trim().split(",")[0].trim();
    if (pkg && !pkg.includes("\\") && !BUILTIN_PKGS.has(pkg)) refs.add(`${pkg}.sty`);
  }

  return refs;
}

// ── ensure_assets: cria dummies para tudo que falta, ANTES de compilar ────────

function ensureAssets(tex, jobDir) {
  const refs = collectAssetRefs(tex);

  // Mapa stem → caminho real no jobDir (extensão alternativa)
  const byStem = new Map();
  try {
    for (const f of readdirSync(jobDir)) {
      const { name, ext } = parsePath(f);
      if (IMAGE_EXTS.has(ext.slice(1).toLowerCase())) byStem.set(name.toLowerCase(), join(jobDir, f));
    }
  } catch {}

  for (const refPath of refs) {
    const dest = join(jobDir, refPath);
    if (existsSync(dest)) continue;

    const ext  = extname(refPath).slice(1).toLowerCase();
    const stem = parsePath(refPath).name.toLowerCase();

    // Garante que o diretório pai existe (para refs com subpasta)
    try { mkdirSync(dirname(dest), { recursive: true }); } catch {}

    if (IMAGE_EXTS.has(ext)) {
      // Extensão alternativa disponível
      const alt = byStem.get(stem);
      if (alt) {
        try { copyFileSync(alt, dest); console.log(`[latex] '${basename(alt)}' copiado como '${refPath}'`); continue; }
        catch {}
      }
      // PNG dummy
      try { writeFileSync(dest, DUMMY_PNG); console.log(`[latex] dummy PNG: ${refPath}`); }
      catch (e) { console.warn(`[latex] falha ao criar dummy '${refPath}': ${e.message}`); }
    } else if (STYLE_EXTS.has(ext)) {
      const stub = ext === "cls"
        ? "\\NeedsTeXFormat{LaTeX2e}\n\\ProvidesClass{stub}[2024/01/01]\n\\LoadClass{article}\n"
        : "% auto-generated stub\n";
      try { writeFileSync(dest, stub, "utf8"); console.log(`[latex] stub .${ext}: ${refPath}`); }
      catch (e) { console.warn(`[latex] falha ao criar stub '${refPath}': ${e.message}`); }
    }
  }
}

// ── patchStyForEmptyLogo ──────────────────────────────────────────────────────

function patchStyForEmptyLogo(sty) {
  return sty.replace(
    /\\raisebox\{-0\.7\\height\}\{\\includegraphics\[height=([^\]]+)\]\{#6\}\}/g,
    (_, h) => `\\raisebox{-0.7\\height}{\\ifx\\relax#6\\relax\\else\\includegraphics[height=${h}]{#6}\\fi}`
  );
}

// ── copyAssetsToOutput ────────────────────────────────────────────────────────

function loadPlaceholderSet() {
  const set = new Set();
  if (!existsSync(TPL_DIR)) return set;
  for (const e of readdirSync(TPL_DIR, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const meta = join(TPL_DIR, e.name, "assets-meta.json");
    if (!existsSync(meta)) continue;
    try {
      for (const f of (JSON.parse(readFileSync(meta, "utf8")).placeholder_assets ?? [])) set.add(f);
    } catch {}
  }
  return set;
}

function copyAssetsToOutput(jobDir) {
  if (!existsSync(TPL_DIR)) return;
  const supported = new Set([".png",".jpg",".jpeg",".pdf",".eps",".svg",".cls",".sty",".ttf",".otf"]);
  const placeholders = loadPlaceholderSet();
  let count = 0;

  function tryCopy(src, name) {
    if (placeholders.has(name)) return;
    const dest = join(jobDir, name);
    const ext = extname(name).toLowerCase();
    try {
      if (ext === ".sty") {
        writeFileSync(dest, patchStyForEmptyLogo(readFileSync(src, "utf8")), "utf8");
      } else {
        copyFileSync(src, dest);
      }
      count++;
    } catch (e) { console.warn(`[latex] falha ao copiar ${name}: ${e.message}`); }
  }

  for (const e of readdirSync(TPL_DIR, { withFileTypes: true })) {
    const srcPath = join(TPL_DIR, e.name);
    if (e.isDirectory()) {
      for (const a of readdirSync(srcPath, { withFileTypes: true })) {
        if (a.isFile() && supported.has(extname(a.name).toLowerCase())) tryCopy(join(srcPath, a.name), a.name);
      }
    } else if (e.isFile() && supported.has(extname(e.name).toLowerCase())) {
      tryCopy(srcPath, e.name);
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
  const env  = buildEnv();
  const opts = { timeout: 120_000, stdio: "pipe", env };

  // 1. Copia assets reais (e patcha .sty)
  copyAssetsToOutput(jobDir);

  // 2. Pré-processa o .tex
  const processed = fixCveventOutsideTabular(fixCustomCommandArgs(texContent));
  writeFileSync(texPath, processed, "utf8");

  // 3. Cria dummies para TODO asset referenciado que não existe — uma vez, antes de compilar
  ensureAssets(processed, jobDir);

  // 4. Compila (latexmk com fallback pdflatex, sem retry)
  let compiled = false;
  try {
    execSync(`latexmk -pdf -interaction=nonstopmode -halt-on-error -outdir="${jobDir}" "${texPath}"`, opts);
    compiled = true;
  } catch {
    console.warn("[latex] latexmk falhou — tentando pdflatex direto");
  }

  if (!compiled) {
    for (let pass = 1; pass <= 2; pass++) {
      try {
        execSync(`pdflatex -interaction=nonstopmode -halt-on-error -output-directory="${jobDir}" "${texPath}"`, opts);
        compiled = true;
      } catch (err) {
        const raw = (err.stdout?.toString() ?? "") + (err.stderr?.toString() ?? "");
        const errors = raw.split("\n").filter(l => l.startsWith("!") || l.includes("Fatal")).slice(0, 5).join("\n");
        if (pass === 2) {
          throw new Error(
            `Erro na compilação LaTeX:\n${errors || raw.slice(0, 500)}\n\n` +
            `Se o pdflatex não foi encontrado, aguarde o cv-agent instalar o TinyTeX na primeira compilação via interface.`
          );
        }
      }
    }
  }

  if (!existsSync(pdfPath)) throw new Error(`PDF não gerado em ${pdfPath}`);
  return pdfPath;
}
