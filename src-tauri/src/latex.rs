use anyhow::{Result, anyhow};
use std::path::PathBuf;
use std::process::Command;
use crate::texlive;

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
    // Garante que TeX Live está disponível (baixa TinyTeX se necessário)
    texlive::ensure_texlive().await?;

    // Verifica se há .cls/.sty referenciados que não existem nos templates salvos
    let missing = find_missing_latex_support(tex_content);
    if !missing.is_empty() {
        return Err(anyhow!(
            "Arquivos LaTeX ausentes: {}. Importe os arquivos .cls/.sty correspondentes no pacote.",
            missing.join(", ")
        ));
    }

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
    let cmd = texlive::tex_command("latexmk");
    log::info!("Executando latexmk: {:?} (cwd={:?})", cmd, out_dir);
    let output = Command::new(&cmd)
        .args(["-pdf", "-interaction=nonstopmode", "-halt-on-error", "curriculo.tex"])
        .current_dir(out_dir)
        .output()
        .map_err(|e| anyhow!("latexmk não encontrado: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        log::error!("latexmk stdout:\n{}", stdout);
        log::error!("latexmk stderr:\n{}", stderr);
    }
    Ok(output.status.success())
}

fn try_pdflatex(out_dir: &PathBuf) -> Result<bool> {
    // Duas passagens para resolver referências cruzadas
    for pass in 0..2 {
        let cmd = texlive::tex_command("pdflatex");
        log::info!("Executando pdflatex (pass {}) em: {:?}", pass+1, cmd);
        let output = Command::new(&cmd)
            .args(["-interaction=nonstopmode", "-halt-on-error", "curriculo.tex"])
            .current_dir(out_dir)
            .output()
            .map_err(|_| anyhow!(
                "pdflatex não encontrado. Instale o TeX Live: https://tug.org/texlive/windows.html"
            ))?;

        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        if !output.status.success() {
            log::error!("pdflatex stdout:\n{}", stdout);
            log::error!("pdflatex stderr:\n{}", stderr);
            let detail = if !stdout.is_empty() { stdout.to_string() } else { stderr.to_string() };
            return Err(anyhow!(
                "Erro pdflatex (passagem {}): {}", 
                pass + 1,
                &detail[..detail.len().min(20000)]
            ));
        }
    }
    Ok(true)
}

/// Copia imagens de todos os pacotes salvos para o diretório de saída,
/// para que o pdflatex encontre os assets referenciados no .tex.
fn copy_assets_to_output(out_dir: &PathBuf) -> Result<()> {
    let tpl_dir = templates_dir();
    if !tpl_dir.exists() { 
        log::warn!("Templates dir não existe: {:?}", tpl_dir);
        return Ok(()); 
    }

    let mut copied = 0;
    for entry in std::fs::read_dir(&tpl_dir)?.flatten() {
        let src = entry.path();
        if src.is_dir() {
            // Copia todos os assets de cada subpasta de pacote
            for asset in std::fs::read_dir(&src)?.flatten() {
                let ap = asset.path();
                if let Some(ext) = ap.extension() {
                    if matches!(ext.to_str(), Some("png"|"jpg"|"jpeg"|"pdf"|"eps"|"svg"|"cls"|"sty")) {
                        let dest = out_dir.join(ap.file_name().unwrap());
                        match std::fs::copy(&ap, &dest) {
                            Ok(_) => {
                                copied += 1;
                                if matches!(ext.to_str(), Some("cls"|"sty")) {
                                    log::info!("Copiado: {:?} → {:?}", ap.file_name(), dest);
                                }
                            }
                            Err(e) => {
                                log::warn!("Erro ao copiar {:?}: {}", ap, e);
                            }
                        }
                    }
                }
            }
        } else if let Some(ext) = src.extension() {
            if matches!(ext.to_str(), Some("png"|"jpg"|"jpeg"|"cls"|"sty")) {
                let dest = out_dir.join(src.file_name().unwrap());
                match std::fs::copy(&src, &dest) {
                    Ok(_) => {
                        copied += 1;
                        if matches!(ext.to_str(), Some("cls"|"sty")) {
                            log::info!("Copiado: {:?} → {:?}", src.file_name(), dest);
                        }
                    }
                    Err(e) => {
                        log::warn!("Erro ao copiar {:?}: {}", src, e);
                    }
                }
            }
        }
    }
    log::info!("Assets copiados: {} arquivos para {:?}", copied, out_dir);
    Ok(())
}

fn asset_exists_in_templates(filename: &str) -> bool {
    let dir = templates_dir();
    if !dir.exists() {
        return false;
    }

    let mut stack = vec![dir];
    while let Some(p) = stack.pop() {
        if let Ok(entries) = std::fs::read_dir(&p) {
            for e in entries.flatten() {
                let path = e.path();
                if path.is_dir() {
                    stack.push(path);
                } else if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    if name.eq_ignore_ascii_case(filename) {
                        return true;
                    }
                }
            }
        }
    }

    false
}

fn find_missing_latex_support(tex: &str) -> Vec<String> {
    let mut needed = vec![];

    for line in tex.lines() {
        if let Some(idx) = line.find("\\documentclass") {
            if let Some(start) = line[idx..].find('{') {
                if let Some(end) = line[idx+start+1..].find('}') {
                    let cls = &line[idx+start+1..idx+start+1+end];
                    let name = cls.split(',').next().unwrap_or("").trim();
                    if !name.is_empty() {
                        let file = format!("{}.cls", name);
                        if !asset_exists_in_templates(&file) {
                            needed.push(file);
                        }
                    }
                }
            }
        }

        if let Some(idx) = line.find("\\usepackage") {
            if let Some(start) = line[idx..].find('{') {
                if let Some(end) = line[idx+start+1..].find('}') {
                    let pkgs = &line[idx+start+1..idx+start+1+end];
                    for p in pkgs.split(',') {
                        let name = p.trim();
                        if !name.is_empty() {
                            let file = format!("{}.sty", name);
                            if !asset_exists_in_templates(&file) {
                                needed.push(file.clone());
                            }
                        }
                    }
                }
            }
        }
    }

    needed.sort();
    needed.dedup();
    needed
}
