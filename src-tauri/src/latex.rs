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

    std::fs::write(&tex_path, tex_content)?;
    copy_assets_to_output(&out_dir)?;

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
fn copy_assets_to_output(out_dir: &PathBuf) -> Result<()> {
    let tpl_dir = templates_dir();
    if !tpl_dir.exists() {
        return Ok(());
    }

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
