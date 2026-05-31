// src-tauri/src/latex.rs
use anyhow::{anyhow, Result};
use std::path::PathBuf;
use std::process::Command;
use tauri::AppHandle;
use crate::texlive;

fn data_dir() -> PathBuf {
    dirs_next::data_dir()
        .unwrap_or_else(|| std::env::temp_dir())
        .join("cv-agent")
}

fn templates_dir() -> PathBuf {
    data_dir().join("curriculo").join("templates")
}

fn output_dir() -> PathBuf {
    data_dir().join("curriculo").join("output")
}

pub fn list_templates() -> Result<Vec<String>> {
    let dir = templates_dir();
    std::fs::create_dir_all(&dir)?;
    let mut names = vec![];
    for entry in std::fs::read_dir(&dir)?.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if path.join("main.tex").exists() {
                if let Some(n) = path.file_name().and_then(|n| n.to_str()) {
                    names.push(format!("{}/main.tex", n));
                }
            }
        } else if path.extension().map_or(false, |x| x == "tex") {
            if let Some(n) = path.file_name().and_then(|n| n.to_str()) {
                names.push(n.to_string());
            }
        }
    }
    Ok(names)
}

pub fn read_template(name: &str) -> Result<String> {
    let path = templates_dir().join(name);
    std::fs::read_to_string(&path)
        .map_err(|e| anyhow!("Erro ao ler template '{}': {}", name, e))
}

// ── PNG 1×1 transparente ─────────────────────────────────────────────────────
const DUMMY_PNG: &[u8] = &[
    0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A,
    0x00,0x00,0x00,0x0D,0x49,0x48,0x44,0x52,
    0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x01,
    0x08,0x06,0x00,0x00,0x00,0x1F,0x15,0xC4,
    0x89,0x00,0x00,0x00,0x0A,0x49,0x44,0x41,
    0x54,0x78,0x9C,0x62,0x00,0x01,0x00,0x00,
    0x05,0x00,0x01,0x0D,0x0A,0x2D,0xB4,0x00,
    0x00,0x00,0x00,0x00,0x49,0x45,0x4E,0x44,
    0xAE,0x42,0x60,0x82,
];

const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "pdf", "eps", "svg", "gif"];
const STYLE_EXTS: &[&str] = &["cls", "sty"];

// ── Comandos customizados: número esperado de args ───────────────────────────
const CUSTOM_CMD_ARGS: &[(&str, usize)] = &[
    ("cvevent",   6),
    ("cvdegree",  6),
    ("cvskill",   2),
    ("cvproject", 5),
];

// ── Pré-processamento do .tex ─────────────────────────────────────────────────

/// Envolve \cvevent/\cvdegree que estejam fora de tabular em \begin{tabular}...\end{tabular}.
fn fix_cvevent_outside_tabular(tex: &str) -> String {
    let cmds: &[(&str, &str)] = &[
        ("\\cvevent",  "r|p{0.68\\textwidth}c"),
        ("\\cvdegree", "r p{0.68\\textwidth} c"),
    ];

    fn in_tabular(tex: &str, pos: usize) -> bool {
        let slice = &tex[..pos];
        slice.matches("\\begin{tabular}").count() > slice.matches("\\end{tabular}").count()
    }

    fn cmd_end(tex: &str, start: usize) -> usize {
        let bytes = tex.as_bytes();
        let mut i = start;
        loop {
            while i < bytes.len() && matches!(bytes[i], b' '|b'\t'|b'\n'|b'\r') { i += 1; }
            if i < bytes.len() && bytes[i] == b'[' {
                while i < bytes.len() && bytes[i] != b']' { i += 1; }
                i += 1; continue;
            }
            if i >= bytes.len() || bytes[i] != b'{' { break; }
            let mut depth = 0usize; i += 1;
            while i < bytes.len() {
                match bytes[i] {
                    b'{' => depth += 1,
                    b'}' => { if depth == 0 { i += 1; break; } depth -= 1; }
                    _ => {}
                }
                i += 1;
            }
        }
        i
    }

    let mut result = tex.to_string();
    for (cmd, fmt) in cmds {
        let mut offset = 0usize;
        loop {
            let Some(rel) = result[offset..].find(cmd) else { break };
            let pos = offset + rel;
            let after = pos + cmd.len();
            let next = result[after..].chars().next();
            if !matches!(next, Some('{')|Some('[')|Some(' ')|Some('\n')|Some('\t')) {
                offset = pos + 1; continue;
            }
            if in_tabular(&result, pos) { offset = pos + 1; continue; }
            let end = cmd_end(&result, after);
            let inner = result[pos..end].to_string();
            let wrapped = format!("\\begin{{tabular}}{{{fmt}}}\n    {inner}\n\\end{{tabular}}");
            result.replace_range(pos..end, &wrapped);
            log::info!("fix_cvevent_outside_tabular: {} envolto em tabular", cmd);
            offset = pos + wrapped.len();
        }
    }
    result
}

/// Preenche argumentos faltantes em comandos customizados com {} vazio.
fn fix_custom_command_args(tex: &str) -> String {
    let mut result = tex.to_string();
    for (cmd_name, expected) in CUSTOM_CMD_ARGS {
        let needle = format!("\\{}", cmd_name);
        let mut offset = 0usize;
        loop {
            let Some(rel) = result[offset..].find(&needle) else { break };
            let abs_pos = offset + rel;
            let after_cmd = abs_pos + needle.len();
            let next = result[after_cmd..].chars().next();
            if !matches!(next, Some('{')|Some('[')|Some(' ')|Some('\n')|Some('\t')) {
                offset = abs_pos + 1; continue;
            }
            let mut groups: Vec<(usize, usize)> = vec![];
            let mut i = after_cmd;
            let bytes = result.as_bytes();
            loop {
                while i < bytes.len() && matches!(bytes[i], b' '|b'\t'|b'\n'|b'\r') { i += 1; }
                if i < bytes.len() && bytes[i] == b'[' {
                    while i < bytes.len() && bytes[i] != b']' { i += 1; }
                    i += 1; continue;
                }
                if i >= bytes.len() || bytes[i] != b'{' { break; }
                let g_start = i;
                let mut depth = 0usize; i += 1;
                while i < bytes.len() {
                    match bytes[i] {
                        b'{' => depth += 1,
                        b'}' => { if depth == 0 { i += 1; break; } depth -= 1; }
                        _ => {}
                    }
                    i += 1;
                }
                groups.push((g_start, i));
            }
            let missing = expected.saturating_sub(groups.len());
            if missing > 0 && missing <= 3 {
                let insert_at = groups.last().map(|g| g.1).unwrap_or(after_cmd);
                let padding = "{}".repeat(missing);
                result.insert_str(insert_at, &padding);
                log::info!("fix_custom_command_args: \\{} tinha {} args, inseridos {}", cmd_name, groups.len(), missing);
                offset = insert_at + padding.len();
            } else {
                offset = abs_pos + 1;
            }
        }
    }
    result
}

// ── Coleta de assets referenciados no .tex ───────────────────────────────────

/// Extrai todos os nomes de arquivo que o .tex vai tentar carregar:
/// \includegraphics, \includepdf, \roundpic, \pgfdeclareimage,
/// o último argumento de \cvevent e \cvdegree,
/// \documentclass → .cls, \usepackage (não-padrão) → .sty.
fn collect_asset_refs(tex: &str) -> Vec<String> {
    let mut refs = std::collections::HashSet::new();

    // Lê o último grupo {...} de um comando a partir de `start`
    fn last_arg(tex: &str, start: usize) -> Option<String> {
        let bytes = tex.as_bytes();
        let mut i = start;
        let mut last = None;
        loop {
            while i < bytes.len() && matches!(bytes[i], b' '|b'\t'|b'\n'|b'\r') { i += 1; }
            if i < bytes.len() && bytes[i] == b'[' {
                while i < bytes.len() && bytes[i] != b']' { i += 1; }
                i += 1; continue;
            }
            if i >= bytes.len() || bytes[i] != b'{' { break; }
            let s = i + 1;
            let mut depth = 0usize; i += 1;
            while i < bytes.len() {
                match bytes[i] {
                    b'{' => depth += 1,
                    b'}' => { if depth == 0 { i += 1; break; } depth -= 1; }
                    _ => {}
                }
                i += 1;
            }
            last = Some(tex[s..i-1].trim().to_string());
        }
        last
    }

    // Comandos cujo último argumento é um arquivo de imagem
    let image_cmds = [
        "\\includegraphics", "\\includepdf",
        "\\roundpic", "\\pgfdeclareimage",
        "\\cvevent", "\\cvdegree",  // 6º arg = logo
    ];
    for cmd in &image_cmds {
        let mut offset = 0;
        while let Some(pos) = tex[offset..].find(cmd) {
            let abs = offset + pos;
            offset = abs + cmd.len();
            let next = tex[offset..].chars().next();
            if !matches!(next, Some('{')|Some('[')|Some(' ')|Some('\n')|Some('\t')) { continue; }
            if let Some(name) = last_arg(tex, offset) {
                if !name.is_empty() && !name.starts_with('\\') && !name.contains(' ') {
                    let name = if name.contains('.') { name } else { format!("{}.png", name) };
                    refs.insert(name);
                }
            }
        }
    }

    // \documentclass → .cls
    let mut offset = 0;
    while let Some(pos) = tex[offset..].find("\\documentclass") {
        offset += pos + "\\documentclass".len();
        let rest = &tex[offset..];
        let idx = if rest.trim_start().starts_with('[') {
            rest.find("]{").map(|p| p + 1).unwrap_or(0)
        } else { 0 };
        if let Some(open) = rest[idx..].find('{') {
            let after = idx + open + 1;
            if let Some(close) = rest[after..].find('}') {
                let cls = rest[after..after+close].trim();
                if !cls.is_empty() && !cls.contains('\\') && !cls.contains(',') {
                    refs.insert(format!("{}.cls", cls));
                }
            }
        }
    }

    // \usepackage → .sty (ignora pacotes padrão do TeX Live)
    const BUILTIN: &[&str] = &[
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
    ];
    let mut offset = 0;
    while let Some(pos) = tex[offset..].find("\\usepackage") {
        offset += pos + "\\usepackage".len();
        let rest = &tex[offset..];
        let idx = if rest.trim_start().starts_with('[') {
            rest.find("]{").map(|p| p + 1).unwrap_or(0)
        } else { 0 };
        if let Some(open) = rest[idx..].find('{') {
            let after = idx + open + 1;
            if let Some(close) = rest[after..].find('}') {
                let pkg = rest[after..after+close].trim();
                if !pkg.is_empty() && !pkg.contains('\\') && !pkg.contains(',')
                    && !BUILTIN.contains(&pkg) {
                    refs.insert(format!("{}.sty", pkg));
                }
            }
        }
    }

    refs.into_iter().collect()
}

// ── ensure_assets: cria dummies para tudo que falta ANTES de compilar ────────

/// Para cada asset referenciado no .tex que não existe no out_dir,
/// cria um dummy (PNG 1×1 para imagens, stub mínimo para .cls/.sty).
/// Também resolve extensão alternativa (foto.png → foto.jpg existente).
fn ensure_assets(tex: &str, out_dir: &PathBuf) {
    let refs = collect_asset_refs(tex);
    let existing_by_stem = {
        let mut map = std::collections::HashMap::new();
        if let Ok(rd) = std::fs::read_dir(out_dir) {
            for e in rd.flatten() {
                let p = e.path();
                let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("").to_lowercase();
                if IMAGE_EXTS.contains(&ext.as_str()) {
                    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
                    map.insert(stem, p);
                }
            }
        }
        map
    };

    for ref_path in refs {
        let dest = out_dir.join(&ref_path);
        if dest.exists() { continue; }

        let ext = std::path::Path::new(&ref_path)
            .extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
        let stem = std::path::Path::new(&ref_path)
            .file_stem().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();

        if let Some(parent) = dest.parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        if IMAGE_EXTS.contains(&ext.as_str()) {
            // Tenta extensão alternativa já presente no out_dir
            if let Some(alt) = existing_by_stem.get(&stem) {
                if std::fs::copy(alt, &dest).is_ok() {
                    log::info!("ensure_assets: '{}' copiado como substituto para '{}'", alt.display(), ref_path);
                    continue;
                }
            }
            // Cria PNG 1×1 dummy
            if let Err(e) = std::fs::write(&dest, DUMMY_PNG) {
                log::warn!("ensure_assets: falha ao criar dummy para '{}': {}", ref_path, e);
            } else {
                log::info!("ensure_assets: dummy PNG criado para '{}'", ref_path);
            }
        } else if STYLE_EXTS.contains(&ext.as_str()) {
            let stub = if ext == "cls" {
                "\\NeedsTeXFormat{LaTeX2e}\n\\ProvidesClass{stub}[2024/01/01]\n\\LoadClass{article}\n"
            } else { "% auto-generated stub\n" };
            if std::fs::write(&dest, stub).is_ok() {
                log::info!("ensure_assets: stub .{} criado para '{}'", ext, ref_path);
            }
        }
    }
}

// ── copy_assets_to_output ────────────────────────────────────────────────────

fn copy_assets_to_output(out_dir: &PathBuf) -> Result<()> {
    let tpl_dir = templates_dir();
    if !tpl_dir.exists() { return Ok(()); }

    let placeholder_set = load_placeholder_set();
    let asset_exts = ["png","jpg","jpeg","pdf","eps","svg","cls","sty","ttf","otf"];
    let mut copied = 0usize;

    for entry in std::fs::read_dir(&tpl_dir)?.flatten() {
        let src = entry.path();
        let sources: Box<dyn Iterator<Item = PathBuf>> = if src.is_dir() {
            Box::new(std::fs::read_dir(&src).ok().into_iter().flatten().flatten().map(|e| e.path()))
        } else {
            Box::new(std::iter::once(src))
        };
        for ap in sources {
            let ext = ap.extension().and_then(|e| e.to_str()).unwrap_or("");
            if !asset_exts.contains(&ext) { continue; }
            let fname = ap.file_name().unwrap().to_string_lossy().to_string();
            if placeholder_set.contains(&fname) { continue; }

            // .sty: aplica patch para logo vazio antes de copiar
            if ext == "sty" {
                if let Ok(content) = std::fs::read_to_string(&ap) {
                    let patched = patch_sty_for_empty_logo(&content);
                    let dest = out_dir.join(&fname);
                    let _ = std::fs::write(&dest, patched);
                    copied += 1;
                    continue;
                }
            }

            let dest = out_dir.join(&fname);
            if std::fs::copy(&ap, &dest).is_ok() { copied += 1; }
        }
    }
    log::info!("{} assets copiados para {:?}", copied, out_dir);
    Ok(())
}

/// Substitui \includegraphics{#6} por versão condicional que não falha com arg vazio.
fn patch_sty_for_empty_logo(sty: &str) -> String {
    // \raisebox{-0.7\height}{\includegraphics[height=Xcm]{#6}}
    // →  \raisebox{-0.7\height}{\ifx\relax#6\relax\else\includegraphics[height=Xcm]{#6}\fi}
    let re = regex_lite::Regex::new(
        r"\\raisebox\{-0\.7\\height\}\{\\includegraphics\[height=([^\]]+)\]\{#6\}\}"
    );
    match re {
        Ok(r) => r.replace_all(sty, |caps: &regex_lite::Captures| {
            let h = &caps[1];
            format!(r"\raisebox{{-0.7\height}}{{\ifx\relax#6\relax\else\includegraphics[height={h}]{{#6}}\fi}}")
        }).to_string(),
        Err(_) => {
            // Fallback sem regex
            sty.replace(
                r"\raisebox{-0.7\height}{\includegraphics[height=1cm]{#6}}",
                r"\raisebox{-0.7\height}{\ifx\relax#6\relax\else\includegraphics[height=1cm]{#6}\fi}",
            ).replace(
                r"\raisebox{-0.7\height}{\includegraphics[height=0.5cm]{#6}}",
                r"\raisebox{-0.7\height}{\ifx\relax#6\relax\else\includegraphics[height=0.5cm]{#6}\fi}",
            )
        }
    }
}

fn load_placeholder_set() -> std::collections::HashSet<String> {
    let mut set = std::collections::HashSet::new();
    let tpl_dir = templates_dir();
    if !tpl_dir.exists() { return set; }
    for entry in std::fs::read_dir(&tpl_dir).into_iter().flatten().flatten() {
        let meta_path = entry.path().join("assets-meta.json");
        if let Ok(content) = std::fs::read_to_string(&meta_path) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
                for item in v["placeholder_assets"].as_array().unwrap_or(&vec![]) {
                    if let Some(s) = item.as_str() { set.insert(s.to_string()); }
                }
            }
        }
    }
    set
}

// ── Compilação ───────────────────────────────────────────────────────────────

pub async fn compile(tex_content: &str, job_id: &str, app: Option<&AppHandle>) -> Result<String> {
    texlive::ensure_tinytex(app).await?;

    let out_dir = output_dir().join(job_id);
    std::fs::create_dir_all(&out_dir)?;

    let tex_path = out_dir.join("curriculo.tex");
    let pdf_path = out_dir.join("curriculo.pdf");

    // 1. Copia assets reais (e patcha .sty para logo vazio)
    copy_assets_to_output(&out_dir)?;

    // 2. Pré-processa o .tex: corrige estrutura antes de analisar assets
    let preprocessed = fix_cvevent_outside_tabular(
        &fix_custom_command_args(tex_content)
    );
    std::fs::write(&tex_path, &preprocessed)?;

    // 3. Cria dummies para TODO asset referenciado que não existe — uma vez só, antes de compilar
    ensure_assets(&preprocessed, &out_dir);

    // 4. Compila (latexmk com fallback para pdflatex, sem retry)
    let ok = run_latex(&out_dir)?;
    if !ok {
        return Err(anyhow!("Compilação LaTeX falhou."));
    }

    if !pdf_path.exists() {
        return Err(anyhow!("PDF não gerado em {:?}", pdf_path));
    }
    Ok(pdf_path.to_string_lossy().to_string())
}

fn run_latex(out_dir: &PathBuf) -> Result<bool> {
    let pdf_path = out_dir.join("curriculo.pdf");

    // Tenta latexmk primeiro
    if let Ok(out) = Command::new(texlive::tex_command("latexmk"))
        .args(["-pdf", "-interaction=nonstopmode", "-halt-on-error", "curriculo.tex"])
        .current_dir(out_dir)
        .output()
    {
        if out.status.success() || pdf_path.exists() {
            // PDF gerado — sucesso mesmo que latexmk reporte warnings como erro
            return Ok(true);
        }
        log::warn!("latexmk falhou e PDF não gerado — tentando pdflatex direto");
    }

    // Fallback: pdflatex (duas passagens para referências cruzadas)
    for pass in 1..=2 {
        let out = Command::new(texlive::tex_command("pdflatex"))
            .args(["-interaction=nonstopmode", "-halt-on-error", "curriculo.tex"])
            .current_dir(out_dir)
            .output()
            .map_err(|_| anyhow!("pdflatex não encontrado. Verifique se o TinyTeX foi instalado."))?;

        // Verifica o PDF — mais confiável que o código de saída
        if pdf_path.exists() { return Ok(true); }

        if !out.status.success() {
            let log_text = String::from_utf8_lossy(&out.stdout).to_string()
                + &String::from_utf8_lossy(&out.stderr);
            let errors: Vec<&str> = log_text.lines()
                .filter(|l| l.starts_with('!') || l.contains("Fatal"))
                .take(5).collect();
            let summary = if errors.is_empty() {
                log_text[..log_text.len().min(500)].to_string()
            } else {
                errors.join("\n")
            };
            if pass == 2 {
                return Err(anyhow!(
                    "Erro na compilação LaTeX:\n{}\n\nSe o pdflatex não foi encontrado, aguarde o cv-agent instalar o TinyTeX na primeira compilação via interface.",
                    summary
                ));
            }
            log::warn!("pdflatex passagem {} falhou:\n{}", pass, summary);
        }
    }
    Ok(true)
}
