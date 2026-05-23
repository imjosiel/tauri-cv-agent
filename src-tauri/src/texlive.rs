use anyhow::{Result, anyhow};
use std::path::{Path, PathBuf};
use std::process::Command;

const TINYTEX_VERSION: &str = "2026-01-15";
const TINYTEX_URL: &str = "https://github.com/yihui/tinytex-releases/releases/download/v2026.01/TinyTeX-1.zip";

fn data_dir() -> PathBuf {
    dirs_next::data_dir()
        .unwrap_or_else(|| std::env::temp_dir())
        .join("cv-agent")
}

fn texlive_dir() -> PathBuf {
    data_dir().join("texlive")
}

fn texlive_bin_path() -> PathBuf {
    if cfg!(target_os = "windows") {
        texlive_dir().join("bin").join("win32")
    } else {
        texlive_dir().join("bin").join("x86_64-linux")
    }
}

pub fn tex_command(cmd: &str) -> PathBuf {
    let bin_dir = texlive_bin_path();
    if bin_dir.exists() {
        let exe_name = if cfg!(target_os = "windows") {
            format!("{}.exe", cmd)
        } else {
            cmd.to_string()
        };
        let path = bin_dir.join(exe_name);
        if path.exists() {
            return path;
        }
    }
    PathBuf::from(cmd)
}

pub async fn ensure_texlive() -> Result<()> {
    let bin_path = texlive_bin_path();
    
    // Verifica se já tem TinyTeX instalado localmente
    if bin_path.join("pdflatex").exists() || bin_path.join("pdflatex.exe").exists() {
        log::info!("TinyTeX já instalado em {:?}", bin_path);
        return Ok(());
    }

    // Tenta usar TeX Live do sistema
    if check_system_texlive() {
        log::info!("Usando TeX Live do sistema");
        return Ok(());
    }

    // Baixa e instala TinyTeX
    log::info!("TinyTeX não encontrado. Baixando...");
    download_and_install_tinytex().await?;
    
    Ok(())
}

fn check_system_texlive() -> bool {
    let candidates = if cfg!(target_os = "windows") {
        vec![
            PathBuf::from("C:\\texlive\\2026\\bin\\win32"),
            PathBuf::from("C:\\texlive\\2025\\bin\\win32"),
        ]
    } else {
        vec![
            PathBuf::from("/usr/local/texlive/2026/bin/x86_64-linux"),
            PathBuf::from("/usr/local/texlive/2025/bin/x86_64-linux"),
        ]
    };

    for candidate in candidates {
        let pdflatex = if cfg!(target_os = "windows") {
            candidate.join("pdflatex.exe")
        } else {
            candidate.join("pdflatex")
        };
        if pdflatex.exists() {
            return true;
        }
    }
    false
}

async fn download_and_install_tinytex() -> Result<()> {
    let texlive_path = texlive_dir();
    std::fs::create_dir_all(&texlive_path)?;

    let zip_path = texlive_path.join("tinytex.zip");

    // Download (inclui a versão para evitar aviso de dead_code)
    log::info!("Baixando TinyTeX {} de {}", TINYTEX_VERSION, TINYTEX_URL);
    let bytes = reqwest::Client::new()
        .get(TINYTEX_URL)
        .send()
        .await?
        .bytes()
        .await?;

    std::fs::write(&zip_path, bytes)?;
    log::info!("TinyTeX baixado: {}", zip_path.display());

    // Extração
    extract_zip(&zip_path, &texlive_path)?;
    std::fs::remove_file(&zip_path)?;

    // Valida
    let pdflatex = if cfg!(target_os = "windows") {
        texlive_bin_path().join("pdflatex.exe")
    } else {
        texlive_bin_path().join("pdflatex")
    };

    if !pdflatex.exists() {
        return Err(anyhow!(
            "TinyTeX extraído mas pdflatex não encontrado em {:?}",
            pdflatex
        ));
    }

    log::info!("TinyTeX instalado com sucesso em {:?}", texlive_path);
    Ok(())
}

fn extract_zip(zip_path: &Path, extract_to: &Path) -> Result<()> {
    #[cfg(target_os = "windows")]
    {
        // Usa PowerShell para extrair no Windows
        let ps_cmd = format!(
            r#"Expand-Archive -Path "{}" -DestinationPath "{}" -Force"#,
            zip_path.display(),
            extract_to.display()
        );
        let output = Command::new("powershell")
            .args(["-NoProfile", "-Command", &ps_cmd])
            .output()?;

        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            return Err(anyhow!("Erro ao extrair ZIP: {}", err));
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let output = Command::new("unzip")
            .args(["-o", zip_path.to_str().unwrap(), "-d", extract_to.to_str().unwrap()])
            .output()?;

        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            return Err(anyhow!("Erro ao extrair ZIP: {}", err));
        }
    }

    Ok(())
}
