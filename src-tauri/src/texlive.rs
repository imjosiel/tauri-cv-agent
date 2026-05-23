// src-tauri/src/texlive.rs
//
// Garante que pdflatex esteja disponível, instalando o TinyTeX se necessário.
//
// Ordem de preferência:
//   1. TinyTeX gerenciado pelo cv-agent  (%APPDATA%/cv-agent/tinytex)
//   2. TeX Live instalado pelo usuário   (C:\texlive\*, /usr/local/texlive/*)
//   3. Download automático do TinyTeX    (apenas se nenhum dos anteriores existir)
//
// Após instalar, garante que os pacotes necessários para o simplehipstercv
// estão disponíveis via tlmgr.

use anyhow::{anyhow, Result};
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Emitter};

const REQUIRED_PACKAGES: &[&str] = &[
    "fontawesome",
    "paracol",
    "smartdiagram",
    "tikz-3dplot",
    "raleway",
    "hyperref",
    "geometry",
    "titlesec",
    "xcolor",
    "float",
    "inputenc",
    "fontenc",
];

#[cfg(target_os = "windows")]
const TINYTEX_URL: &str =
    "https://github.com/rstudio/tinytex-releases/releases/latest/download/TinyTeX-1.zip";

#[cfg(not(target_os = "windows"))]
const TINYTEX_URL: &str =
    "https://github.com/rstudio/tinytex-releases/releases/latest/download/TinyTeX-1.tar.gz";

// ── Caminhos ──────────────────────────────────────────────────────────────────

fn data_dir() -> PathBuf {
    dirs_next::data_dir()
        .unwrap_or_else(|| std::env::temp_dir())
        .join("cv-agent")
}

fn tinytex_root() -> PathBuf {
    data_dir().join("tinytex")
}

/// Retorna o diretório de binários do TinyTeX local, se instalado.
/// Testa múltiplos layouts porque o caminho interno muda entre versões.
fn tinytex_bin_dir() -> Option<PathBuf> {
    let root = tinytex_root();

    #[cfg(target_os = "windows")]
    let candidates = [
        root.join("bin").join("windows"),
        root.join("bin").join("win32"),
        root.join("TinyTeX").join("bin").join("windows"),
        root.join("TinyTeX").join("bin").join("win32"),
    ];

    #[cfg(target_os = "macos")]
    let candidates = [
        root.join("bin").join("universal-darwin"),
        root.join("bin").join("x86_64-darwin"),
        root.join("TinyTeX").join("bin").join("universal-darwin"),
        root.join("TinyTeX").join("bin").join("x86_64-darwin"),
    ];

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let candidates = [
        root.join("bin").join("x86_64-linux"),
        root.join("bin").join("aarch64-linux"),
        root.join("TinyTeX").join("bin").join("x86_64-linux"),
        root.join("TinyTeX").join("bin").join("aarch64-linux"),
    ];

    candidates.into_iter().find(|p| pdflatex_exe(p).exists())
}

/// Retorna o diretório de binários do TeX Live instalado pelo usuário, se existir.
fn system_texlive_bin() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    let candidates: Vec<PathBuf> = (2020u32..=2030)
        .flat_map(|y| {
            vec![
                PathBuf::from(format!("C:\\texlive\\{}\\bin\\windows", y)),
                PathBuf::from(format!("C:\\texlive\\{}\\bin\\win32", y)),
            ]
        })
        .collect();

    #[cfg(not(target_os = "windows"))]
    let candidates: Vec<PathBuf> = (2020u32..=2030)
        .flat_map(|y| {
            vec![
                PathBuf::from(format!("/usr/local/texlive/{}/bin/x86_64-linux", y)),
                PathBuf::from(format!("/usr/local/texlive/{}/bin/aarch64-linux", y)),
                PathBuf::from(format!("/usr/local/texlive/{}/bin/universal-darwin", y)),
            ]
        })
        .chain([PathBuf::from("/usr/bin"), PathBuf::from("/usr/local/bin")])
        .collect();

    candidates.into_iter().find(|p| pdflatex_exe(p).exists())
}

fn pdflatex_exe(bin_dir: &Path) -> PathBuf {
    if cfg!(target_os = "windows") {
        bin_dir.join("pdflatex.exe")
    } else {
        bin_dir.join("pdflatex")
    }
}

// ── API pública ───────────────────────────────────────────────────────────────

/// Retorna o caminho completo para um executável TeX (pdflatex, tlmgr, latexmk…).
/// Prioridade: TinyTeX local → TeX Live do sistema → PATH.
pub fn tex_command(cmd: &str) -> PathBuf {
    let exe = if cfg!(target_os = "windows") {
        format!("{}.exe", cmd)
    } else {
        cmd.to_string()
    };

    for bin_dir in [tinytex_bin_dir(), system_texlive_bin()].into_iter().flatten() {
        let p = bin_dir.join(&exe);
        if p.exists() {
            return p;
        }
    }

    PathBuf::from(cmd)
}

/// Garante que pdflatex está disponível.
/// Na primeira execução sem TeX instalado, baixa e instala o TinyTeX
/// emitindo eventos `texlive_progress` para o frontend exibir progresso.
pub async fn ensure_tinytex(app: Option<&AppHandle>) -> Result<()> {
    if tinytex_bin_dir().is_some() {
        log::info!("TinyTeX local encontrado.");
        return Ok(());
    }

    if system_texlive_bin().is_some() {
        log::info!("TeX Live do sistema encontrado.");
        return Ok(());
    }

    log::info!("Nenhum TeX encontrado. Iniciando download do TinyTeX...");
    emit_progress(app, 0, "Iniciando download do TinyTeX...");

    download_tinytex(app).await?;
    install_required_packages(app)?;

    emit_progress(app, 100, "TinyTeX pronto!");
    Ok(())
}

// ── Instalação ────────────────────────────────────────────────────────────────

async fn download_tinytex(app: Option<&AppHandle>) -> Result<()> {
    let root = tinytex_root();
    std::fs::create_dir_all(&root)?;

    let archive_ext = if cfg!(target_os = "windows") { "zip" } else { "tar.gz" };
    let archive_path = root.join(format!("tinytex.{}", archive_ext));

    emit_progress(app, 5, "Conectando ao servidor...");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()?;

    let response = client
        .get(TINYTEX_URL)
        .send()
        .await
        .map_err(|e| anyhow!("Falha ao conectar para baixar TinyTeX: {}", e))?;

    if !response.status().is_success() {
        return Err(anyhow!("Servidor retornou {} ao baixar TinyTeX.", response.status()));
    }

    let total = response.content_length().unwrap_or(0);
    emit_progress(app, 8, &format!("Baixando TinyTeX ({} MB)...", total / 1_000_000 + 1));

    use futures_util::StreamExt;
    let mut stream = response.bytes_stream();
    let mut file = std::fs::File::create(&archive_path)
        .map_err(|e| anyhow!("Não foi possível criar arquivo temporário: {}", e))?;

    let mut downloaded: u64 = 0;
    let mut last_pct = 0u8;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| anyhow!("Erro durante download: {}", e))?;
        use std::io::Write;
        file.write_all(&chunk)?;
        downloaded += chunk.len() as u64;

        if total > 0 {
            let pct = (8 + (downloaded * 62 / total)) as u8;
            if pct > last_pct {
                last_pct = pct;
                emit_progress(
                    app,
                    pct,
                    &format!("Baixando TinyTeX... {}/{} MB", downloaded / 1_000_000, total / 1_000_000),
                );
            }
        }
    }
    drop(file);

    emit_progress(app, 70, "Extraindo TinyTeX...");
    extract_archive(&archive_path, &root)?;
    std::fs::remove_file(&archive_path).ok();

    if tinytex_bin_dir().is_none() {
        let listing: Vec<_> = std::fs::read_dir(&root)
            .ok()
            .map(|d| d.flatten().map(|e| e.path()).collect())
            .unwrap_or_default();
        return Err(anyhow!(
            "TinyTeX extraído mas pdflatex não encontrado em {:?}.\nConteúdo: {:?}",
            root, listing
        ));
    }

    emit_progress(app, 80, "TinyTeX extraído. Instalando pacotes...");
    Ok(())
}

fn install_required_packages(app: Option<&AppHandle>) -> Result<()> {
    let tlmgr = tex_command("tlmgr");
    if !tlmgr.exists() {
        log::warn!("tlmgr não encontrado — pulando instalação de pacotes.");
        return Ok(());
    }

    emit_progress(app, 82, "Atualizando tlmgr...");
    let _ = Command::new(&tlmgr).args(["update", "--self", "--no-auto-install"]).output();

    let total = REQUIRED_PACKAGES.len();
    for (i, pkg) in REQUIRED_PACKAGES.iter().enumerate() {
        let pct = 83u8 + ((i as u8 * 15) / total as u8);
        emit_progress(app, pct, &format!("Instalando pacote LaTeX: {}...", pkg));

        match Command::new(&tlmgr).args(["install", pkg]).output() {
            Ok(o) if o.status.success() => log::info!("Pacote {} instalado.", pkg),
            Ok(o) => log::warn!("tlmgr install {}: {}", pkg, String::from_utf8_lossy(&o.stderr)),
            Err(e) => log::warn!("Falha ao executar tlmgr para {}: {}", pkg, e),
        }
    }

    emit_progress(app, 98, "Pacotes instalados.");
    Ok(())
}

fn extract_archive(archive: &Path, dest: &Path) -> Result<()> {
    #[cfg(target_os = "windows")]
    {
        let ps_cmd = format!(
            r#"Expand-Archive -Path "{}" -DestinationPath "{}" -Force"#,
            archive.display(), dest.display()
        );
        let out = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &ps_cmd])
            .output()?;
        if !out.status.success() {
            return Err(anyhow!("Erro ao extrair ZIP: {}", String::from_utf8_lossy(&out.stderr)));
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let out = Command::new("tar")
            .args(["-xzf", archive.to_str().unwrap(), "-C", dest.to_str().unwrap()])
            .output()?;
        if !out.status.success() {
            return Err(anyhow!("Erro ao extrair tar.gz: {}", String::from_utf8_lossy(&out.stderr)));
        }
    }

    Ok(())
}

fn emit_progress(app: Option<&AppHandle>, pct: u8, message: &str) {
    log::info!("[tinytex {}%] {}", pct, message);
    if let Some(app) = app {
        app.emit("texlive_progress", serde_json::json!({ "pct": pct, "message": message })).ok();
    }
}
