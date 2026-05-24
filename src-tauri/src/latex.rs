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

/// Lista todos os pacotes de template salvos (subpastas com main.tex ou .tex solto).
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

/// Lê o conteúdo de um template.
pub fn read_template(name: &str) -> Result<String> {
    let path = templates_dir().join(name);
    std::fs::read_to_string(&path)
        .map_err(|e| anyhow!("Erro ao ler template '{}': {}", name, e))
}

/// Compila um .tex em PDF.
/// `app` recebe eventos de progresso durante a instalação do TinyTeX
/// (ocorre apenas na primeira compilação, quando o TinyTeX ainda não está instalado).
pub async fn compile(tex_content: &str, job_id: &str, app: Option<&AppHandle>) -> Result<String> {
    texlive::ensure_tinytex(app).await?;

    let out_dir = output_dir().join(job_id);
    std::fs::create_dir_all(&out_dir)?;

    let tex_path = out_dir.join("curriculo.tex");
    let pdf_path = out_dir.join("curriculo.pdf");

    // Copia assets antes de patchear — assim sabemos o que realmente chegou no disco
    copy_assets_to_output(&out_dir)?;

    // Substitui imagens faltantes (placeholder ou simplesmente ausentes) por
    // \phantom{\includegraphics{...}} para que o pdflatex não quebre
    let patched = patch_missing_images(tex_content, &out_dir);
    std::fs::write(&tex_path, &patched)?;

    // latexmk é preferível (resolve referências cruzadas automaticamente);
    // fallback para pdflatex com duas passagens manuais.
    let ok = try_latexmk(&out_dir).or_else(|_| try_pdflatex(&out_dir))?;

    if !ok {
        return Err(anyhow!("Compilação LaTeX falhou sem mensagem de erro específica."));
    }

    if !pdf_path.exists() {
        return Err(anyhow!("Compilação concluída mas PDF não foi gerado em {:?}.", pdf_path));
    }

    Ok(pdf_path.to_string_lossy().to_string())
}

fn try_latexmk(out_dir: &PathBuf) -> Result<bool> {
    let output = Command::new(texlive::tex_command("latexmk"))
        .args(["-pdf", "-interaction=nonstopmode", "-halt-on-error", "curriculo.tex"])
        .current_dir(out_dir)
        .output()
        .map_err(|e| anyhow!("latexmk não disponível: {}", e))?;

    if !output.status.success() {
        log::warn!("latexmk falhou:\n{}", String::from_utf8_lossy(&output.stdout));
    }

    Ok(output.status.success())
}

fn try_pdflatex(out_dir: &PathBuf) -> Result<bool> {
    for pass in 0..2 {
        let output = Command::new(texlive::tex_command("pdflatex"))
            .args(["-interaction=nonstopmode", "-halt-on-error", "curriculo.tex"])
            .current_dir(out_dir)
            .output()
            .map_err(|_| anyhow!("pdflatex não encontrado. Verifique se o TinyTeX foi instalado corretamente."))?;

        if !output.status.success() {
            let detail = {
                let stdout = String::from_utf8_lossy(&output.stdout);
                let stderr = String::from_utf8_lossy(&output.stderr);
                if !stdout.is_empty() { stdout.to_string() } else { stderr.to_string() }
            };

            log::error!("pdflatex (pass {}) falhou:\n{}", pass + 1, detail);

            let error_lines: Vec<&str> = detail
                .lines()
                .filter(|l| l.starts_with('!') || l.contains("Error") || l.contains("Fatal"))
                .take(5)
                .collect();

            let summary = if error_lines.is_empty() {
                detail[..detail.len().min(500)].to_string()
            } else {
                error_lines.join("\n")
            };

            return Err(anyhow!("Erro na compilação LaTeX:\n{}", summary));
        }
    }

    Ok(true)
}

/// Copia .cls, .sty, imagens e fontes de todos os pacotes salvos
/// para o diretório de saída, onde o pdflatex vai procurá-los.
/// Arquivos marcados como placeholder NÃO são copiados — assim o
/// patchMissingImages os detecta como ausentes e os envolve em \phantom.
fn copy_assets_to_output(out_dir: &PathBuf) -> Result<()> {
    let tpl_dir = templates_dir();
    if !tpl_dir.exists() {
        return Ok(());
    }

    let placeholder_set = load_placeholder_set();
    let asset_exts = ["png", "jpg", "jpeg", "pdf", "eps", "svg", "cls", "sty", "ttf", "otf"];
    let mut copied = 0usize;

    for entry in std::fs::read_dir(&tpl_dir)?.flatten() {
        let src = entry.path();
        let sources: Box<dyn Iterator<Item = PathBuf>> = if src.is_dir() {
            Box::new(
                std::fs::read_dir(&src)
                    .ok()
                    .into_iter()
                    .flatten()
                    .flatten()
                    .map(|e| e.path()),
            )
        } else {
            Box::new(std::iter::once(src))
        };

        for ap in sources {
            let ext = ap.extension().and_then(|e| e.to_str()).unwrap_or("");
            if asset_exts.contains(&ext) {
                let dest = out_dir.join(ap.file_name().unwrap());
                let fname = ap.file_name().unwrap().to_string_lossy().to_string();
                if placeholder_set.contains(&fname) {
                    log::info!("copy_assets: pulando placeholder '{}'", fname);
                    continue;
                }
                match std::fs::copy(&ap, &dest) {
                    Ok(_) => copied += 1,
                    Err(e) => log::warn!("Falha ao copiar {:?}: {}", ap, e),
                }
            }
        }
    }

    log::info!("{} assets copiados para {:?}", copied, out_dir);
    Ok(())
}


/// Substitui referências a imagens ausentes por string vazia ou \phantom.
///
/// Padrões tratados:
///   \includegraphics[opts]{file}          → \phantom{\includegraphics[opts]{file}}
///   \roundpic{file}                       → \roundpic{}
///   \cvevent{}{}{}{}{desc}{file}          → \cvevent{}{}{}{}{desc}{}
///   \cvdegree{}{}{}{}{}{file}             → \cvdegree{}{}{}{}{}{}
///
/// Regra: se o arquivo não existe no out_dir (com tamanho > 100 bytes)
/// ou está marcado como placeholder, a referência é removida.
fn patch_missing_images(tex: &str, out_dir: &PathBuf) -> String {
    let placeholder_set = load_placeholder_set();

    // Retorna true se o arquivo existe e é válido no out_dir
    let valid = |filename: &str| -> bool {
        if filename.is_empty() { return true; }
        if placeholder_set.contains(filename) { return false; }
        [
            out_dir.join(filename),
            out_dir.join(format!("{}.png", filename)),
            out_dir.join(format!("{}.jpg", filename)),
            out_dir.join(format!("{}.pdf", filename)),
        ].iter().any(|p| p.metadata().map(|m| m.len() > 100).unwrap_or(false))
    };

    let mut out = String::with_capacity(tex.len());

    for line in tex.split('\n') {
        let patched = patch_line(line, &valid);
        out.push_str(&patched);
        out.push('\n');
    }

    if !tex.ends_with('\n') && out.ends_with('\n') {
        out.pop();
    }
    out
}

fn patch_line(line: &str, valid: &dyn Fn(&str) -> bool) -> String {
    // Extrai o último argumento {X} de um comando LaTeX na linha
    fn last_brace_content(line: &str, cmd: &str) -> Option<(usize, usize, String)> {
        let start = line.find(cmd)?;
        let after_cmd = start + cmd.len();
        // Percorre todos os grupos {} para chegar no último
        let mut i = after_cmd;
        let bytes = line.as_bytes();
        let mut last_open = None;
        let mut last_close = None;
        while i < bytes.len() {
            match bytes[i] {
                b'{' => {
                    last_open = Some(i);
                    let mut depth = 1usize;
                    i += 1;
                    while i < bytes.len() && depth > 0 {
                        match bytes[i] {
                            b'{' => depth += 1,
                            b'}' => { depth -= 1; if depth == 0 { last_close = Some(i); } }
                            _ => {}
                        }
                        i += 1;
                    }
                }
                b'[' => {
                    // Pula [opções]
                    let mut depth = 1usize;
                    i += 1;
                    while i < bytes.len() && depth > 0 {
                        match bytes[i] { b'[' => depth += 1, b']' => depth -= 1, _ => {} }
                        i += 1;
                    }
                }
                b' ' | b'\t' => { i += 1; }
                _ => break,
            }
        }
        match (last_open, last_close) {
            (Some(o), Some(c)) => {
                let content = line[o+1..c].trim().to_string();
                Some((o, c, content))
            }
            _ => None,
        }
    }

    let mut result = line.to_string();

    // ── \includegraphics ─────────────────────────────────────────────────────
    if let Some(pos) = result.find("\\includegraphics") {
        if let Some((_, _, filename)) = last_brace_content(&result, "\\includegraphics") {
            if !valid(&filename) {
                log::info!("patch: phantom includegraphics '{}'", filename);
                // Envolve o \includegraphics... inteiro em \phantom{}
                // Encontra fim do comando (após o último })
                let after = result[pos..].find('}').map(|i| pos + i + 1).unwrap_or(result.len());
                let cmd_str = result[pos..after].to_string();
                result = format!("{}\\phantom{{{}}}{}",
                    &result[..pos], cmd_str, &result[after..]);
            }
        }
    }

    // ── \roundpic ────────────────────────────────────────────────────────────
    if let Some((open, close, filename)) = last_brace_content(&result, "\\roundpic") {
        if !valid(&filename) {
            log::info!("patch: empty roundpic '{}'", filename);
            result = format!("{}{}{}",
                &result[..open+1], &result[close..]);
            // Torna \roundpic{filename} → \roundpic{}
            result = result.replacen(&format!("{{{}}}", filename), "{}", 1);
        }
    }

    // ── \cvevent e \cvdegree — último {} é a imagem ──────────────────────────
    for cmd in &["\\cvevent", "\\cvdegree", "\\cvpub", "\\cvproject"] {
        if !result.contains(cmd) { continue; }
        if let Some((open, close, filename)) = last_brace_content(&result, cmd) {
            if !filename.is_empty() && !valid(&filename) {
                log::info!("patch: empty {} image arg '{}'", cmd, filename);
                result = format!("{}{}{}",
                    &result[..open+1],
                    &result[close..]);
                // Remove o conteúdo: {filename} → {}
                result = result.replacen(&format!("{{{}}}", filename), "{}", 1);
            }
        }
    }

    result
}

/// Parseia \includegraphics[opções]{arquivo} e retorna (match_completo, filename).
fn parse_includegraphics(s: &str) -> Option<(&str, String)> {
    let mut idx = "\\includegraphics".len();
    if idx >= s.len() { return None; }

    // Pula espaços
    while idx < s.len() && s.as_bytes()[idx].is_ascii_whitespace() { idx += 1; }

    // Pula [opções] se presente
    if s.as_bytes().get(idx) == Some(&b'[') {
        idx += 1;
        let mut depth = 1usize;
        while idx < s.len() && depth > 0 {
            match s.as_bytes()[idx] {
                b'[' => depth += 1,
                b']' => depth -= 1,
                _ => {}
            }
            idx += 1;
        }
    }

    // Pula espaços
    while idx < s.len() && s.as_bytes()[idx].is_ascii_whitespace() { idx += 1; }

    // Extrai {filename}
    if s.as_bytes().get(idx) != Some(&b'{') { return None; }
    idx += 1;
    let name_start = idx;
    let mut depth = 1usize;
    while idx < s.len() && depth > 0 {
        match s.as_bytes()[idx] {
            b'{' => depth += 1,
            b'}' => depth -= 1,
            _ => {}
        }
        idx += 1;
    }
    if depth != 0 { return None; }

    let filename = s[name_start..idx - 1].trim().to_string();
    if filename.is_empty() { return None; }

    Some((&s[..idx], filename))
}

/// Carrega o conjunto de filenames marcados como placeholder em qualquer template.
fn load_placeholder_set() -> std::collections::HashSet<String> {
    let mut set = std::collections::HashSet::new();
    let tpl_dir = templates_dir();
    if !tpl_dir.exists() { return set; }

    for entry in std::fs::read_dir(&tpl_dir).into_iter().flatten().flatten() {
        let meta_path = entry.path().join("assets-meta.json");
        if let Ok(content) = std::fs::read_to_string(&meta_path) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
                for item in v["placeholder_assets"].as_array().unwrap_or(&vec![]) {
                    if let Some(s) = item.as_str() {
                        set.insert(s.to_string());
                    }
                }
            }
        }
    }

    set
}
