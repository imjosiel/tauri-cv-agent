use anyhow::{Result, anyhow};
use std::path::PathBuf;
use std::process::Command;

fn data_dir() -> PathBuf {
    dirs_next::data_dir()
        .unwrap_or_else(|| std::env::temp_dir())
        .join("cv-agent")
}

fn templates_dir() -> PathBuf { data_dir().join("curriculo").join("templates") }
fn output_dir()   -> PathBuf { data_dir().join("curriculo").join("output") }

/// Lista todos os pacotes de template salvos (subpastas com main.tex)
pub fn list_templates() -> Result<Vec<String>> {
    let dir = templates_dir();
    std::fs::create_dir_all(&dir)?;

    // Cada pacote é uma subpasta; também aceita .tex solto na raiz
    let mut names = vec![];

    for entry in std::fs::read_dir(&dir)?.flatten() {
        let path = entry.path();
        if path.is_dir() {
            // Pacote zip importado — pasta com main.tex
            if path.join("main.tex").exists() {
                if let Some(n) = path.file_name().and_then(|n| n.to_str()) {
                    names.push(format!("{}/main.tex", n));
                }
            }
        } else if path.extension().map_or(false, |x| x == "tex") {
            // .tex solto na raiz (importação simples)
            if let Some(n) = path.file_name().and_then(|n| n.to_str()) {
                names.push(n.to_string());
            }
        }
    }

    Ok(names)
}

/// Lê o conteúdo de um template pelo nome retornado por list_templates()
pub fn read_template(name: &str) -> Result<String> {
    let path = templates_dir().join(name);
    std::fs::read_to_string(&path)
        .map_err(|e| anyhow!("Erro ao ler template '{}': {}", name, e))
}

/// Compila um .tex em PDF, copiando os assets da pasta do pacote para o diretório de saída.
/// Retorna o caminho absoluto do PDF gerado.
pub async fn compile(tex_content: &str, job_id: &str) -> Result<String> {
    let out_dir = output_dir().join(job_id);
    std::fs::create_dir_all(&out_dir)?;

    let tex_path = out_dir.join("curriculo.tex");
    let pdf_path = out_dir.join("curriculo.pdf");

    std::fs::write(&tex_path, tex_content)?;

    // Copia assets de todos os pacotes para o diretório de saída
    // (o pdflatex precisa encontrar as imagens no mesmo diretório)
    copy_assets_to_output(&out_dir)?;

    // Tenta latexmk primeiro (mais rápido com cache .aux), fallback pdflatex
    let compiled = try_latexmk(&out_dir).or_else(|_| try_pdflatex(&out_dir))?;

    if !compiled {
        return Err(anyhow!("Compilação LaTeX falhou. Verifique se o TeX Live está instalado."));
    }

    if !pdf_path.exists() {
        return Err(anyhow!("PDF não gerado após compilação."));
    }

    Ok(pdf_path.to_string_lossy().to_string())
}

fn try_latexmk(out_dir: &PathBuf) -> Result<bool> {
    let output = Command::new("latexmk")
        .args(["-pdf", "-interaction=nonstopmode", "-halt-on-error", "curriculo.tex"])
        .current_dir(out_dir)
        .output()
        .map_err(|e| anyhow!("latexmk não encontrado: {}", e))?;
    Ok(output.status.success())
}

fn try_pdflatex(out_dir: &PathBuf) -> Result<bool> {
    // Duas passagens para resolver referências cruzadas
    for _ in 0..2 {
        let output = Command::new("pdflatex")
            .args(["-interaction=nonstopmode", "-halt-on-error", "curriculo.tex"])
            .current_dir(out_dir)
            .output()
            .map_err(|_| anyhow!(
                "pdflatex não encontrado. Instale o TeX Live: https://tug.org/texlive/windows.html"
            ))?;
        if !output.status.success() {
            let log = String::from_utf8_lossy(&output.stdout);
            return Err(anyhow!("Erro pdflatex:\n{}", &log[..log.len().min(500)]));
        }
    }
    Ok(true)
}

/// Copia imagens de todos os pacotes salvos para o diretório de saída,
/// para que o pdflatex encontre os assets referenciados no .tex.
fn copy_assets_to_output(out_dir: &PathBuf) -> Result<()> {
    let tpl_dir = templates_dir();
    if !tpl_dir.exists() { return Ok(()); }

    for entry in std::fs::read_dir(&tpl_dir)?.flatten() {
        let src = entry.path();
        if src.is_dir() {
            // Copia todos os assets de cada subpasta de pacote
            for asset in std::fs::read_dir(&src)?.flatten() {
                let ap = asset.path();
                if let Some(ext) = ap.extension() {
                    if matches!(ext.to_str(), Some("png"|"jpg"|"jpeg"|"pdf"|"eps"|"svg"|"cls"|"sty")) {
                        let dest = out_dir.join(ap.file_name().unwrap());
                        std::fs::copy(&ap, &dest).ok();
                    }
                }
            }
        } else if let Some(ext) = src.extension() {
            if matches!(ext.to_str(), Some("png"|"jpg"|"jpeg"|"cls"|"sty")) {
                let dest = out_dir.join(src.file_name().unwrap());
                std::fs::copy(&src, &dest).ok();
            }
        }
    }
    Ok(())
}
