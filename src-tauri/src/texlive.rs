// src-tauri/src/texlive.rs
//
// Responsável por garantir que pdflatex esteja disponível.
//
// Estratégia:
//   1. Verifica se já temos TinyTeX instalado em %APPDATA%/cv-agent/tinytex
//   2. Verifica se há TeX Live instalado no sistema (C:\texlive\*, /usr/...)
//   3. Baixa e instala TinyTeX automaticamente, emitindo eventos de progresso
//      para o frontend mostrar uma barra de progresso
//
// Após instalar, garante que os pacotes necessários para o simplehipstercv
// estão instalados via tlmgr.

use anyhow::{anyhow, Result};
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Emitter};

// Pacotes necessários para o simplehipstercv e templates comuns de CV
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

// URL da release "latest" do TinyTeX — redireciona sempre para a versão atual
// sem precisar hardcodar uma data ou tag específica.
#[cfg(target_os = "windows")]
const TINYTEX_URL: &str =
    "https://github.com/rstudio/tinytex-releases/releases/latest/download/TinyTeX-1.zip";

#[cfg(not(target_os = "windows"))]
const TINYTEX_URL: &str =
    "https://github.com/rstudio/tinytex-releases/releases/latest/download/TinyTeX-1.tar.gz";

fn data_dir() -> PathBuf {
    dirs_next::data_dir()
        .unwrap_or_else(|| std::env::temp_dir())
        .join("cv-agent")
}

fn tinytex_dir() -> PathBuf {
    data_dir().join("tinytex")
}

/// Retorna o diretório de binários do TinyTeX instalado localmente.
/// O layout interno do TinyTeX muda entre versões; testamos os caminhos
/// conhecidos em ordem e retornamos o primeiro que existir.
fn tinytex_bin_dir() -> Option<PathBuf> {
    let root = tinytex_dir();

    #[cfg(target_os = "windows")]
    let candidates = [
        root.join("bin").join("windows"),
        root.join("bin").join("win32"),
        // TinyTeX extrai com uma subpasta extra às vezes
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

    candidates.into_iter().find(|p| {
        let exe = if cfg!(target_os = "windows") {
            p.join("pdflatex.exe")
        } else {
            p.join("pdflatex")
        };
        exe.exists()
    })
}

/// Procura TeX Live instalado no sistema (não pelo cv-agent).
fn system_texlive_bin() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    let roots: Vec<PathBuf> = (2020u32..=2030)
        .flat_map(|year| {
            vec![
                PathBuf::from(format!("C:\\texlive\\{}\\bin\\windows", year)),
                PathBuf::from(format!("C:\\texlive\\{}\\bin\\win32", year)),
            ]
        })
        .collect();

    #[cfg(not(target_os = "windows"))]
    let roots: Vec<PathBuf> = (2020u32..=2030)
        .flat_map(|year| {
            vec![
                PathBuf::from(format!("/usr/local/texlive/{}/bin/x86_64-linux", year)),
                PathBuf::from(format!("/usr/local/texlive/{}/bin/aarch64-linux", year)),
                PathBuf::from(format!(
                    "/usr/local/texlive/{}/bin/universal-darwin",
                    year
                )),
            ]
        })
        .chain([PathBuf::from("/usr/bin"), PathBuf::from("/usr/local/bin")])
        .collect();

    roots.into_iter().find(|p| {
        let exe = if cfg!(target_os = "windows") {
            p.join("pdflatex.exe")
        } else {
            p.join("pdflatex")
        };
        exe.exists()
    })
}

/// Retorna o caminho completo para um comando TeX (pdflatex, tlmgr, latexmk…).
/// Prioridade: TinyTeX local > TeX Live do sistema > PATH.
pub fn tex_command(cmd: &str) -> PathBuf {
    let exe_name = if cfg!(target_os = "windows") {
        format!("{}.exe", cmd)
    } else {
        cmd.to_string()
    };

    if let Some(bin) = tinytex_bin_dir() {
        let p = bin.join(&exe_name);
        if p.exists() {
            return p;
        }
    }

    if let Some(bin) = system_texlive_bin() {
        let p = bin.join(&exe_name);
        if p.exists() {
            return p;
        }
    }

    PathBuf::from(cmd)
}

/// Ponto de entrada: garante que pdflatex está disponível.
/// Se não estiver, baixa e instala o TinyTeX emitindo eventos de progresso.
pub async fn ensure_texlive(app: Option<&AppHandle>) -> Result<()> {
    // 1. TinyTeX local já instalado?
    if tinytex_bin_dir().is_some() {
        log::info!("TinyTeX local encontrado.");
        return Ok(());
    }

    // 2. TeX Live do sistema?
    if system_texlive_bin().is_some() {
        log::info!("TeX Live do sistema encontrado.");
        return Ok(());
    }

    // 3. Precisa instalar — emite progresso ao frontend
    log::info!("TeX Live não encontrado. Iniciando download do TinyTeX...");
    emit_progress(app, 0, "Iniciando download do TinyTeX...");

    download_tinytex(app).await?;
    install_required_packages(app)?;

    emit_progress(app, 100, "TinyTeX pronto!");
    Ok(())
}

async fn download_tinytex(app: Option<&AppHandle>) -> Result<()> {
    let tinytex_path = tinytex_dir();
    std::fs::create_dir_all(&tinytex_path)?;

    let archive_name = if cfg!(target_os = "windows") {
        "tinytex.zip"
    } else {
        "tinytex.tar.gz"
    };
    let archive_path = tinytex_path.join(archive_name);

    emit_progress(app, 5, "Conectando ao servidor...");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()?;

    // Faz HEAD para pegar o Content-Length (após redirect)
    let response = client
        .get(TINYTEX_URL)
        .send()
        .await
        .map_err(|e| anyhow!("Falha ao conectar para baixar TinyTeX: {}", e))?;

    if !response.status().is_success() {
        return Err(anyhow!(
            "Servidor retornou {} ao baixar TinyTeX.",
            response.status()
        ));
    }

    let total = response.content_length().unwrap_or(0);
    log::info!("Baixando TinyTeX: {} bytes de {}", total, TINYTEX_URL);
    emit_progress(app, 8, &format!("Baixando TinyTeX ({} MB)...", total / 1_000_000 + 1));

    // Stream com progresso
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
            // Mapeia 8%–70% para o progresso do download
            let pct = (8 + (downloaded * 62 / total)) as u8;
            if pct > last_pct {
                last_pct = pct;
                emit_progress(
                    app,
                    pct,
                    &format!(
                        "Baixando TinyTeX... {}/{} MB",
                        downloaded / 1_000_000,
                        total / 1_000_000
                    ),
                );
            }
        }
    }
    drop(file);

    log::info!("Download concluído: {:?}", archive_path);
    emit_progress(app, 70, "Extraindo TinyTeX...");

    extract_archive(&archive_path, &tinytex_path)?;
    std::fs::remove_file(&archive_path).ok();

    // Valida que pdflatex está acessível após extração
    if tinytex_bin_dir().is_none() {
        // Tenta listar o que foi extraído para debug
        let listing: Vec<_> = std::fs::read_dir(&tinytex_path)
            .ok()
            .map(|d| d.flatten().map(|e| e.path()).collect())
            .unwrap_or_default();
        return Err(anyhow!(
            "TinyTeX extraído mas pdflatex não encontrado. \
             Conteúdo de {:?}: {:?}",
            tinytex_path,
            listing
        ));
    }

    emit_progress(app, 80, "TinyTeX extraído. Instalando pacotes...");
    log::info!("TinyTeX instalado em {:?}", tinytex_dir());
    Ok(())
}

fn install_required_packages(app: Option<&AppHandle>) -> Result<()> {
    let tlmgr = tex_command("tlmgr");
    if !tlmgr.exists() {
        log::warn!("tlmgr não encontrado, pulando instalação de pacotes.");
        return Ok(());
    }

    emit_progress(app, 82, "Atualizando tlmgr...");

    // Atualiza o próprio tlmgr primeiro
    let _ = Command::new(&tlmgr)
        .args(["update", "--self", "--no-auto-install"])
        .output();

    let total = REQUIRED_PACKAGES.len();
    for (i, pkg) in REQUIRED_PACKAGES.iter().enumerate() {
        let pct = 83u8 + ((i as u8 * 15) / total as u8);
        emit_progress(app, pct, &format!("Instalando pacote LaTeX: {}...", pkg));
        log::info!("tlmgr install {}", pkg);

        let out = Command::new(&tlmgr)
            .args(["install", pkg])
            .output();

        match out {
            Ok(o) if o.status.success() => log::info!("Pacote {} instalado.", pkg),
            Ok(o) => log::warn!(
                "tlmgr install {} retornou erro: {}",
                pkg,
                String::from_utf8_lossy(&o.stderr)
            ),
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
            archive.display(),
            dest.display()
        );
        let out = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &ps_cmd])
            .output()?;
        if !out.status.success() {
            return Err(anyhow!(
                "Erro ao extrair ZIP: {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let out = Command::new("tar")
            .args([
                "-xzf",
                archive.to_str().unwrap(),
                "-C",
                dest.to_str().unwrap(),
            ])
            .output()?;
        if !out.status.success() {
            return Err(anyhow!(
                "Erro ao extrair tar.gz: {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }
    }

    Ok(())
}

fn emit_progress(app: Option<&AppHandle>, pct: u8, message: &str) {
    log::info!("[texlive {}%] {}", pct, message);
    if let Some(app) = app {
        app.emit(
            "texlive_progress",
            serde_json::json!({ "pct": pct, "message": message }),
        )
        .ok();
    }
}
