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

// Pacotes padrão do TeX Live — não criamos stub para eles
const BUILTIN_PKGS = new Set([
  "inputenc","fontenc","babel","geometry","graphicx","xcolor","hyperref",
  "amsmath","amssymb","amsfonts","tikz","pgf","listings","verbatim",
  "enumitem","fancyhdr","titlesec","parskip","microtype","booktabs",
  "array","longtable","multirow","multicol","float","caption","subcaption",
  "natbib","biblatex","csquotes","setspace","ragged2e","soul","ulem",
  "fontawesome","fontawesome5","academicons","calc","etoolbox","ifthen",
  "xparse","expl3","l3packages","lmodern","times","palatino","helvet",
  "avant","courier","mathptmx","mathpazo","fourier","utopia","charter",
  "libertine","sourcesanspro","sourcecodepro","raleway","roboto",
  "opensans","cabin","lato","inconsolata",
]);

function collectAssetRefs(tex) {
  const refs = new Set();

  // Extrai o último argumento obrigatório {...} de um comando,
  // pulando opções [...] e argumentos extras antes do arquivo
  function extractLastArg(str) {
    let i = 0;
    // Pula espaços e [...]
    while (i < str.length && (str[i] === " " || str[i] === "\t" || str[i] === "[")) {
      if (str[i] === "[") { while (i < str.length && str[i] !== "]") i++; }
      i++;
    }
    let last = "";
    while (i < str.length && str[i] === "{") {
      i++; // pula {
      const start = i;
      let depth = 1;
      while (i < str.length && depth > 0) {
        if (str[i] === "{") depth++;
        else if (str[i] === "}") depth--;
        if (depth > 0) i++;
      }
      last = str.slice(start, i).trim();
      i++; // pula }
      // Pula espaços entre grupos
      while (i < str.length && (str[i] === " " || str[i] === "\t")) i++;
    }
    return last;
  }

  // Comandos que referenciam arquivos de imagem
  for (const cmd of ["\\includegraphics", "\\includepdf", "\\roundpic", "\\pgfdeclareimage"]) {
    let offset = 0;
    while (true) {
      const pos = tex.indexOf(cmd, offset);
      if (pos === -1) break;
      offset = pos + cmd.length;
      const name = extractLastArg(tex.slice(offset));
      if (name && !name.includes("\\") && !name.includes(" ")) {
        // Se não tem extensão, assume .png (padrão do pdflatex)
        refs.add(name.includes(".") ? name : `${name}.png`);
      }
    }
  }

  // \documentclass[opts]{classe} → classe.cls
  for (const m of tex.matchAll(/\\documentclass(?:\[[^\]]*\])?\{([^}]+)\}/g)) {
    const cls = m[1].trim().split(",")[0].trim();
    if (cls && !cls.includes("\\")) refs.add(`${cls}.cls`);
  }

  // \usepackage[opts]{pacote} → pacote.sty (só pacotes não-padrão)
  for (const m of tex.matchAll(/\\usepackage(?:\[[^\]]*\])?\{([^}]+)\}/g)) {
    const pkg = m[1].trim().split(",")[0].trim();
    if (pkg && !pkg.includes("\\") && !BUILTIN_PKGS.has(pkg)) {
      refs.add(`${pkg}.sty`);
    }
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

// ── patchSty: torna \cvevent e \cvdegree tolerantes a logo vazio ─────────────
// Substitui \includegraphics[h]{#6} por uma versão condicional que não
// tenta carregar arquivo quando o argumento está vazio.

function patchStyForEmptyLogo(styContent) {
  // Padrão a substituir no \cvevent e \cvdegree:
  //   \raisebox{-0.7\height}{\includegraphics[height=1cm]{#6}}
  //   \raisebox{-0.7\height}{\includegraphics[height=0.5cm]{#6}}
  // Substitui por versão com \ifx check
  return styContent
    .replace(
      /\\raisebox\{-0\.7\\height\}\{\\includegraphics\[height=([^\]]+)\]\{#6\}\}/g,
      (_, h) =>
        `\\raisebox{-0.7\\height}{\\ifx\\relax#6\\relax\\else\\includegraphics[height=${h}]{#6}\\fi}`
    );
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
          // .sty: aplica patch para logo vazio antes de copiar
          if (extname(asset.name).toLowerCase() === ".sty") {
            try {
              const patched = patchStyForEmptyLogo(readFileSync(join(srcPath, asset.name), "utf8"));
              writeFileSync(join(jobDir, asset.name), patched, "utf8");
              count++;
            } catch { tryCopy(join(srcPath, asset.name), asset.name); }
          } else {
            tryCopy(join(srcPath, asset.name), asset.name);
          }
        }
      }
    } else if (entry.isFile() && supported.has(extname(entry.name).toLowerCase())) {
      if (extname(entry.name).toLowerCase() === ".sty") {
        try {
          const patched = patchStyForEmptyLogo(readFileSync(srcPath, "utf8"));
          writeFileSync(join(jobDir, entry.name), patched, "utf8");
          count++;
        } catch { tryCopy(srcPath, entry.name); }
      } else {
        tryCopy(srcPath, entry.name);
      }
    }
  }

  console.log(`[latex] ${count} assets copiados para ${jobDir}`);
}

// ── fixCustomCommandArgs ─────────────────────────────────────────────────────
// O LLM às vezes gera \cvevent ou \cvdegree com menos argumentos que o esperado.
// Isso causa erros fatais como "File '\end' not found" porque o pdflatex
// tenta consumir o próximo token como argumento faltante.
//
// Esta função varre o .tex, detecta usos de comandos conhecidos com args faltando,
// e preenche os args ausentes com {} vazio.

const KNOWN_ARG_COUNTS = {
  cvevent: 6,
  cvdegree: 6,
  cvskill: 2,
  cvproject: 5,
};

function fixCustomCommandArgs(tex) {
  let result = tex;

  for (const [cmdName, expectedArgs] of Object.entries(KNOWN_ARG_COUNTS)) {
    const re = new RegExp(`\\\\${cmdName}(?=[\\s{\\[])`, "g");
    let match;
    let offset = 0;

    while ((match = re.exec(result)) !== null) {
      const cmdStart = match.index;
      let i = cmdStart + match[0].length;

      // Coleta os grupos {...} que seguem o comando
      const groups = [];
      while (i < result.length) {
        // Pula espaços e newlines entre argumentos
        while (i < result.length && /[ \t\n]/.test(result[i])) i++;

        // Pula opções [...]
        if (result[i] === "[") {
          while (i < result.length && result[i] !== "]") i++;
          i++; // pula ]
          continue;
        }

        if (result[i] !== "{") break;

        // Lê o grupo {...} completo
        const gStart = i;
        let depth = 0;
        i++;
        while (i < result.length) {
          if (result[i] === "{") depth++;
          else if (result[i] === "}") {
            if (depth === 0) { i++; break; }
            depth--;
          }
          i++;
        }
        groups.push({ start: gStart, end: i, content: result.slice(gStart, i) });
      }

      const missing = expectedArgs - groups.length;
      if (missing > 0 && missing <= 3) {
        // Insere {} vazios no ponto onde os argumentos terminaram
        const insertAt = groups.length > 0 ? groups[groups.length - 1].end : cmdStart + match[0].length;
        const padding = "{}".repeat(missing);
        result = result.slice(0, insertAt) + padding + result.slice(insertAt);
        console.log(`[latex] ${cmdName}: ${groups.length} args encontrados, esperava ${expectedArgs} — inseridos ${missing} arg(s) vazio(s)`);
        // Reseta o regex para a posição após a correção
        re.lastIndex = insertAt + padding.length;
      }
    }
  }

  return result;
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

  // 3. Corrige args faltando em comandos customizados (LLM às vezes omite o 6º arg)
  const fixedTex = fixCustomCommandArgs(texContent);
  if (fixedTex !== texContent) {
    writeFileSync(texPath, fixedTex, "utf8");
    console.log("[latex] tex corrigido — args faltantes preenchidos");
  }

  // 4. Garante que todo asset referenciado existe no jobDir
  ensureAssets(fixedTex, jobDir);

  const env  = buildEnv();
  const opts = { timeout: 120_000, stdio: "pipe", env };

  // Extrai nomes de arquivo faltantes do log do pdflatex
  // Ex: "! LaTeX Error: File `phantom' not found." → "phantom"
  function extractMissingFiles(log) {
    const missing = new Set();
    for (const line of log.split("\n")) {
      if (!line.includes("not found")) continue;
      // Padrão: File `nome' not found  (nome pode estar vazio)
      const m = line.match(/File [`'\u2018]([^`'\u2018\u2019]*)['\u2019]/);
      if (!m) continue;
      const name = m[1].trim();
      if (name.length > 0) missing.add(name); // ignora nome vazio
    }
    return missing;
  }

  function createDummiesFromLog(log, dir) {
    const missing = extractMissingFiles(log);
    let created = 0;
    for (const name of missing) {
      // Determina extensão: sem extensão → tenta .png (imagem) e .sty (pacote)
      const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
      const targets = [];
      if (!ext) {
        // Pode ser imagem ou pacote — cria PNG dummy (pdflatex tenta como imagem primeiro)
        targets.push({ file: `${name}.png`, type: "image" });
        targets.push({ file: `${name}.sty`, type: "sty" });
      } else if (["png","jpg","jpeg","pdf","eps","svg","gif"].includes(ext)) {
        targets.push({ file: name, type: "image" });
      } else if (["cls","sty"].includes(ext)) {
        targets.push({ file: name, type: ext });
      } else {
        targets.push({ file: name, type: "image" });
      }
      for (const { file, type } of targets) {
        const dest = join(dir, file);
        if (existsSync(dest)) continue;
        try {
          mkdirSync(dirname(dest), { recursive: true });
          if (type === "image") {
            writeFileSync(dest, DUMMY_PNG);
          } else if (type === "cls") {
            writeFileSync(dest, "\\NeedsTeXFormat{LaTeX2e}\n\\ProvidesClass{stub}[2024/01/01]\n\\LoadClass{article}\n", "utf8");
          } else {
            writeFileSync(dest, "% auto-generated stub\n", "utf8");
          }
          console.log(`[latex] dummy criado para arquivo faltante: ${file}`);
          created++;
        } catch (e) {
          console.warn(`[latex] falha ao criar dummy para ${file}: ${e.message}`);
        }
      }
    }
    return created;
  }

  function runPdflatex() {
    return execSync(
      `pdflatex -interaction=nonstopmode -halt-on-error -output-directory="${jobDir}" "${texPath}"`,
      opts,
    );
  }

  // 5. Compila: latexmk → fallback pdflatex com retry automático para arquivos faltantes
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
    // Passagem 1: compila e captura erros de arquivo faltante
    let pass1Log = "";
    try {
      runPdflatex();
      compiled = true;
    } catch (err) {
      pass1Log = (err.stdout?.toString() ?? "") + (err.stderr?.toString() ?? "");
      const missing = extractMissingFiles(pass1Log);
      if (missing.size > 0) {
        // Cria dummies para todos os arquivos faltantes e recompila
        const created = createDummiesFromLog(pass1Log, jobDir);
        console.log(`[latex] ${created} dummies criados — recompilando...`);
        try {
          runPdflatex();
          compiled = true;
        } catch (err2) {
          // Passagem 3: última tentativa
          const log2 = (err2.stdout?.toString() ?? "") + (err2.stderr?.toString() ?? "");
          createDummiesFromLog(log2, jobDir);
          try { runPdflatex(); compiled = true; } catch {}
        }
      }
    }

    if (!compiled) {
      // Relata o erro original
      const raw = pass1Log || "";
      const errorLines = raw
        .split("\n")
        .filter((l) => l.startsWith("!") || l.includes("Error") || l.includes("Fatal"))
        .slice(0, 6)
        .join("\n");
      const summary = errorLines || raw.slice(0, 1000);
      throw new Error(
        `Erro na compilação LaTeX:\n${summary}\n\n` +
        `Se o pdflatex não foi encontrado, aguarde o cv-agent instalar o TinyTeX ` +
        `na primeira compilação via interface.`,
      );
    }
  }

  if (!existsSync(pdfPath)) {
    throw new Error(`PDF não gerado em ${pdfPath}. Verifique o log em ${jobDir}/curriculo.log`);
  }

  return pdfPath;
}
