// src-tauri/src/resume.rs
// Persiste o pacote de currículo (tex + assets) no diretório de dados do app.
// O sidecar Playwright lê diretamente desse diretório.

use anyhow::{Result, anyhow};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use base64::{Engine as _, engine::general_purpose::STANDARD as B64};

fn templates_dir() -> PathBuf {
    dirs_next::data_dir()
        .unwrap_or_default()
        .join("cv-agent")
        .join("curriculo")
        .join("templates")
}

/// Comando Tauri — salva o .tex e os assets (base64 dataUrl) enviados pelo frontend.
/// Chamado automaticamente após importar um zip.
#[tauri::command]
pub fn save_resume_package(
    name: String,
    tex_content: String,
    assets: HashMap<String, String>, // filename → dataUrl (data:image/png;base64,...)
    placeholder_assets: Option<Vec<String>>, // lista de filenames que são placeholders
) -> Result<(), String> {
    save_package_inner(&name, &tex_content, &assets, placeholder_assets.unwrap_or_default().as_slice()).map_err(|e| e.to_string())
}

/// Comando Tauri — exclui um pacote de currículo e todos seus assets
#[tauri::command]
pub fn delete_resume_package(name: String) -> Result<(), String> {
    let dir = templates_dir().join(sanitize(&name));
    if !dir.exists() {
        return Err(format!("Pacote '{}' não encontrado", name));
    }
    std::fs::remove_dir_all(&dir)
        .map_err(|e| format!("Erro ao excluir pacote '{}': {}", name, e))?;
    log::info!("Pacote '{}' excluído", name);
    Ok(())
}

fn save_package_inner(
    name: &str,
    tex_content: &str,
    assets: &HashMap<String, String>,
    placeholder_assets: &[String],
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

    // Recolhe todas as referências de imagem no TEX, incluindo arquivos faltantes
    let refs = extract_image_refs(tex_content);

    // Salva metadados de placeholders em assets-meta.json, mesmo que vazio
    let meta = serde_json::json!({
        "placeholder_assets": placeholder_assets,
    });
    std::fs::write(dir.join("assets-meta.json"), serde_json::to_string_pretty(&meta)?)?;

    // Cria um manifest.json com metadados do pacote
    let manifest = serde_json::json!({
        "name": name,
        "tex_file": "main.tex",
        "assets": refs,
        "saved_at": chrono::Local::now().to_rfc3339(),
    });
    std::fs::write(dir.join("manifest.json"), serde_json::to_string_pretty(&manifest)?)?;

    log::info!("Pacote '{}' salvo em {:?}", name, dir);
    Ok(())
}

fn normalize_ref(path: &str) -> String {
    let candidate = path.trim();
    if candidate.is_empty() || candidate.starts_with('\\') {
        return String::new();
    }
    candidate.to_string()
}

fn extract_image_refs(tex: &str) -> Vec<String> {
    let mut refs = Vec::new();
    let mut collect = |path: &str| {
        let normalized = normalize_ref(path);
        if !normalized.is_empty() && !refs.contains(&normalized) {
            refs.push(normalized);
        }
    };

    let patterns = ["\\includegraphics", "\\roundpic"];
    for pattern in patterns {
        let mut offset = 0;
        while let Some(pos) = tex[offset..].find(pattern) {
            offset += pos + pattern.len();
            let rest = &tex[offset..];
            let mut idx = 0;
            while idx < rest.len() && rest.as_bytes()[idx].is_ascii_whitespace() {
                idx += 1;
            }

            if pattern == "\\includegraphics" && rest[idx..].starts_with('[') {
                idx += 1;
                let mut depth = 1;
                while idx < rest.len() && depth > 0 {
                    match rest.as_bytes()[idx] {
                        b'[' => depth += 1,
                        b']' => depth -= 1,
                        _ => {}
                    }
                    idx += 1;
                }
            }

            if idx < rest.len() && rest.as_bytes()[idx] == b'{' {
                idx += 1;
                let start = idx;
                let mut depth = 1;
                while idx < rest.len() && depth > 0 {
                    match rest.as_bytes()[idx] {
                        b'{' => depth += 1,
                        b'}' => depth -= 1,
                        _ => {}
                    }
                    idx += 1;
                }
                if depth == 0 {
                    collect(&rest[start..idx - 1]);
                }
            }
        }
    }

    let extensions = [".png", ".jpg", ".jpeg", ".gif", ".svg", ".pdf", ".eps"];
    for ext in extensions {
        let mut offset = 0;
        while let Some(pos) = tex[offset..].find(ext) {
            let end = offset + pos + ext.len();
            if let Some(open_brace) = tex[..end].rfind('{') {
                let candidate = &tex[open_brace + 1..end];
                collect(candidate);
            }
            offset = end;
        }
    }

    refs
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
#[derive(Serialize, Deserialize, Debug)]
pub struct ResumeAsset {
    pub filename: String,
    pub data_url: Option<String>,
    pub present: bool,
    #[serde(default)]
    pub placeholder: bool,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SavedResumePackage {
    pub name: String,
    pub tex_content: String,
    pub assets: Vec<ResumeAsset>,
    pub saved_at: String,
}

fn asset_data_url(path: &PathBuf) -> Result<String> {
    let bytes = std::fs::read(path)?;
    let ext = path.extension().and_then(|x| x.to_str()).map(|x| x.to_ascii_lowercase());
    let mime = match ext.as_deref() {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("svg") => "image/svg+xml",
        Some("pdf") => "application/pdf",
        _ => "application/octet-stream",
    };
    Ok(format!("data:{};base64,{}", mime, B64.encode(&bytes)))
}

pub fn load_saved_packages() -> Result<Vec<SavedResumePackage>> {
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

        let name = manifest["name"].as_str().unwrap_or("Unnamed").to_string();
        let saved_at = manifest["saved_at"].as_str().unwrap_or("").to_string();
        let tex_path = path.join("main.tex");
        if !tex_path.exists() { continue; }

        let tex_content = std::fs::read_to_string(&tex_path)?;
        
        // Carrega placeholders se existir arquivo de metadados
        let placeholder_set: HashSet<String> = {
            let meta_path = path.join("assets-meta.json");
            if let Ok(meta_content) = std::fs::read_to_string(&meta_path) {
                if let Ok(meta) = serde_json::from_str::<serde_json::Value>(&meta_content) {
                    meta["placeholder_assets"]
                        .as_array()
                        .unwrap_or(&vec![])
                        .iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect::<HashSet<_>>()
                } else {
                    HashSet::new()
                }
            } else {
                HashSet::new()
            }
        };

        let refs = extract_image_refs(&tex_content);
        let mut asset_data = HashMap::new();
        for asset in std::fs::read_dir(&path)? {
            let asset = asset?;
            let asset_path = asset.path();
            if asset_path.is_file() {
                if let Some(ext) = asset_path.extension().and_then(|x| x.to_str()) {
                    if matches!(ext.to_lowercase().as_str(), "png" | "jpg" | "jpeg" | "gif" | "svg" | "pdf" | "eps") {
                        let filename = asset_path.file_name().unwrap().to_string_lossy().to_string();
                        if let Ok(data_url) = asset_data_url(&asset_path) {
                            asset_data.insert(filename, data_url);
                        }
                    }
                }
            }
        }

        let assets = refs.into_iter().map(|filename| {
            let present = asset_data.contains_key(&filename);
            ResumeAsset {
                filename: filename.clone(),
                data_url: asset_data.get(&filename).cloned(),
                present,
                placeholder: placeholder_set.contains(&filename),
            }
        }).collect::<Vec<_>>();

        packages.push(SavedResumePackage {
            name,
            tex_content,
            assets,
            saved_at,
        });
    }

    Ok(packages)
}

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
