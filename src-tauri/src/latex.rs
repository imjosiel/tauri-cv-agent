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

    // Copia assets e escreve o .tex original sem modificações
    copy_assets_to_output(&out_dir)?;
    std::fs::write(&tex_path, tex_content)?;

    // Cria arquivos dummy (PNG 1x1 transparente) para toda imagem referenciada
    // no .tex que não existe no out_dir — funciona com qualquer template.
    create_dummy_images(tex_content, &out_dir);

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

/// Cria arquivos PNG dummy (1x1 pixel transparente) para toda imagem
/// referenciada no .tex que não existe no diretório de saída.
/// Funciona com qualquer template LaTeX — não depende de comandos específicos.
fn create_dummy_images(tex: &str, out_dir: &PathBuf) {
    // PNG 1x1 transparente — mínimo válido que o pdflatex aceita
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

    let placeholder_set = load_placeholder_set();

    // Extrai todos os nomes de arquivo referenciados no .tex
    // usando uma heurística simples: qualquer {palavra.ext} onde ext é imagem
    let image_exts = ["png", "jpg", "jpeg", "pdf", "eps", "svg", "gif"];
    let mut found = std::collections::HashSet::new();

    let mut i = 0;
    let bytes = tex.as_bytes();
    while i < bytes.len() {
        if bytes[i] == b'{' {
            i += 1;
            let start = i;
            while i < bytes.len() && bytes[i] != b'}' && bytes[i] != b'{' && bytes[i] != b'\n' {
                i += 1;
            }
            if i < bytes.len() && bytes[i] == b'}' {
                let name = tex[start..i].trim();
                let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
                if image_exts.contains(&ext.as_str()) && !name.contains('\\') {
                    found.insert(name.to_string());
                }
            }
        } else {
            i += 1;
        }
    }

    for name in found {
        // Pula se está marcado como placeholder (já não existe no out_dir intencionalmente)
        if placeholder_set.contains(&name) {
            continue;
        }

        let dest = out_dir.join(&name);
        if !dest.exists() {
            // Tenta criar com a extensão original
            if let Err(e) = std::fs::write(&dest, DUMMY_PNG) {
                log::warn!("Não foi possível criar dummy para '{}': {}", name, e);
            } else {
                log::info!("Dummy criado: {:?}", dest);
            }
        }
    }
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
                if ext == "sty" || ext == "cls" {
                    // Copia arquivos de estilo aplicando patch de comandos unsafe
                    match std::fs::read_to_string(&ap) {
                        Ok(src) => {
                            let patched_sty = patch_sty(&src);
                            if let Err(e) = std::fs::write(&dest, patched_sty) {
                                log::warn!("Falha ao escrever {:?}: {}", dest, e);
                            } else {
                                copied += 1;
                            }
                        }
                        Err(_) => {
                            // Fallback: copia binário se não conseguir ler como texto
                            match std::fs::copy(&ap, &dest) {
                                Ok(_) => copied += 1,
                                Err(e) => log::warn!("Falha ao copiar {:?}: {}", ap, e),
                            }
                        }
                    }
                } else {
                    match std::fs::copy(&ap, &dest) {
                        Ok(_) => copied += 1,
                        Err(e) => log::warn!("Falha ao copiar {:?}: {}", ap, e),
                    }
                }
            }
        }
    }

    log::info!("{} assets copiados para {:?}", copied, out_dir);
    Ok(())
}


/// Injeta redefinições de \cvevent, \cvdegree e \roundpic que verificam
/// se o argumento de imagem está vazio antes de chamar \includegraphics.
/// Isso evita "File '' not found" quando o placeholder está ativo.
/// Substitui referências a imagens ausentes por \phantom{} ou argumento vazio.
///
/// Padrões tratados no simplehipstercv:
///   \includegraphics[opts]{file}      → \phantom{\includegraphics[opts]{file}}
///   \roundpic{file}                   → \roundpic{}
///   \cvevent{}{}{}{}{texto}{file}     → \cvevent{}{}{}{}{texto}{}
///   \cvdegree{}{}{}{}{}{file}         → \cvdegree{}{}{}{}{}{}
///
/// A regra: arquivo ausente no out_dir (tamanho <= 100 bytes) ou marcado
/// Encontra o último argumento {conteudo} de um comando LaTeX na string.
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

/// Aplica substituições seguras no .sty do simplehipstercv:
/// \cvevent, \cvdegree e \roundpic passam a verificar se o argumento
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
