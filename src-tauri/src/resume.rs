// src-tauri/src/resume.rs
// Persiste o pacote de currículo (tex + assets) no diretório de dados do app.
// O sidecar Playwright lê diretamente desse diretório.

use anyhow::{Result, anyhow};
use std::collections::HashMap;
use std::path::PathBuf;
use base64::{Engine as _, engine::general_purpose::STANDARD as B64};

fn templates_dir() -> PathBuf {
    dirs_next::data_dir()
        .unwrap_or_default()
        .join("cv-agent")
        .join("curriculo")
        .join("templates")
}

/// Command Tauri — salva o .tex e os assets (base64 dataUrl) enviados pelo frontend.
/// Chamado automaticamente após importar um zip.
#[tauri::command]
pub fn save_resume_package(
    name: String,
    tex_content: String,
    assets: HashMap<String, String>, // filename → dataUrl (data:image/png;base64,...)
) -> Result<(), String> {
    save_package_inner(&name, &tex_content, &assets).map_err(|e| e.to_string())
}

fn save_package_inner(
    name: &str,
    tex_content: &str,
    assets: &HashMap<String, String>,
) -> Result<()> {
    let dir = templates_dir().join(sanitize(name));
    std::fs::create_dir_all(&dir)?;

    // Salva o .tex principal
    std::fs::write(dir.join("main.tex"), tex_content)?;

    // Salva cada asset decodificando o dataUrl base64
    for (filename, data_url) in assets {
        let safe_name = sanitize(filename);
        if safe_name.is_empty() { continue; }

        // dataUrl format: "data:image/png;base64,<base64data>"
        let b64 = data_url
            .splitn(2, ',')
            .nth(1)
            .ok_or_else(|| anyhow!("dataUrl inválida para {}", filename))?;

        let bytes = B64.decode(b64.trim())
            .map_err(|e| anyhow!("Erro ao decodificar {}: {}", filename, e))?;

        std::fs::write(dir.join(&safe_name), bytes)?;
    }

    // Cria um manifest.json com metadados do pacote
    let manifest = serde_json::json!({
        "name": name,
        "tex_file": "main.tex",
        "assets": assets.keys().collect::<Vec<_>>(),
        "saved_at": chrono::Local::now().to_rfc3339(),
    });
    std::fs::write(dir.join("manifest.json"), serde_json::to_string_pretty(&manifest)?)?;

    log::info!("Pacote '{}' salvo em {:?}", name, dir);
    Ok(())
}

/// Remove caracteres inseguros de nomes de arquivo
fn sanitize(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
        .collect::<String>()
        .trim_start_matches('.')
        .to_string()
}

/// Lista todos os pacotes salvos com seus assets
#[allow(dead_code)]
pub fn list_packages() -> Result<Vec<PackageInfo>> {
    let base = templates_dir();
    if !base.exists() { return Ok(vec![]); }

    let mut packages = vec![];
    for entry in std::fs::read_dir(&base)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_dir() { continue; }

        let manifest_path = path.join("manifest.json");
        if !manifest_path.exists() { continue; }

        let manifest: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&manifest_path)?)?;

        packages.push(PackageInfo {
            name: manifest["name"].as_str().unwrap_or("").to_string(),
            dir: path.to_string_lossy().to_string(),
            tex_path: path.join("main.tex").to_string_lossy().to_string(),
            assets: manifest["assets"]
                .as_array()
                .unwrap_or(&vec![])
                .iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect(),
        });
    }
    Ok(packages)
}

#[derive(serde::Serialize, serde::Deserialize, Debug)]
pub struct PackageInfo {
    pub name: String,
    pub dir: String,
    pub tex_path: String,
    pub assets: Vec<String>,
}
