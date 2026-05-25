// src-tauri/src/resume.rs
// Persiste o pacote de currículo (tex + assets) no diretório de dados do app.
// O sidecar Playwright lê diretamente desse diretório.

use anyhow::{anyhow, Result};
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

// ── Commands Tauri ────────────────────────────────────────────────────────────

/// Salva o .tex e os assets (base64 dataUrl) enviados pelo frontend.
/// Chamado automaticamente após importar um zip ou editar um template.
#[tauri::command]
pub fn save_resume_package(
    name: String,
    tex_content: String,
    assets: HashMap<String, String>,
    placeholder_assets: Option<Vec<String>>,
) -> Result<(), String> {
    save_inner(&name, &tex_content, &assets, &placeholder_assets.unwrap_or_default())
        .map_err(|e| e.to_string())
}

/// Carrega todos os pacotes salvos com seus assets para o frontend.
/// Chamado uma única vez na montagem do App para popular o store global.
#[tauri::command]
pub fn load_saved_resume_packages() -> Result<Vec<SavedResumePackage>, String> {
    load_packages().map_err(|e| e.to_string())
}

/// Exclui um pacote de currículo e todos seus assets.
#[tauri::command]
pub fn delete_resume_package(name: String) -> Result<(), String> {
    let dir = templates_dir().join(sanitize(&name));
    if !dir.exists() {
        return Err(format!("Pacote '{}' não encontrado.", name));
    }
    std::fs::remove_dir_all(&dir)
        .map_err(|e| format!("Erro ao excluir '{}': {}", name, e))?;
    log::info!("Pacote '{}' excluído.", name);
    Ok(())
}

// ── Tipos ─────────────────────────────────────────────────────────────────────

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

// ── Implementação interna ─────────────────────────────────────────────────────

fn save_inner(
    name: &str,
    tex_content: &str,
    assets: &HashMap<String, String>,
    placeholder_assets: &[String],
) -> Result<()> {
    let dir = templates_dir().join(sanitize(name));
    std::fs::create_dir_all(&dir)?;

    std::fs::write(dir.join("main.tex"), tex_content)?;

    for (filename, data_url) in assets {
        let safe = sanitize(filename);
        if safe.is_empty() { continue; }
        let b64 = data_url
            .splitn(2, ',')
            .nth(1)
            .ok_or_else(|| anyhow!("dataUrl inválida para {}", filename))?;
        let bytes = B64.decode(b64.trim())
            .map_err(|e| anyhow!("Erro ao decodificar {}: {}", filename, e))?;
        std::fs::write(dir.join(&safe), bytes)?;
    }

    let meta = serde_json::json!({ "placeholder_assets": placeholder_assets });
    std::fs::write(dir.join("assets-meta.json"), serde_json::to_string_pretty(&meta)?)?;

    let refs = extract_image_refs(tex_content);
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

fn load_packages() -> Result<Vec<SavedResumePackage>> {
    let base = templates_dir();
    if !base.exists() { return Ok(vec![]); }

    let mut packages = vec![];

    for entry in std::fs::read_dir(&base)?.flatten() {
        let path = entry.path();
        if !path.is_dir() { continue; }

        let manifest_path = path.join("manifest.json");
        let tex_path = path.join("main.tex");
        if !manifest_path.exists() || !tex_path.exists() { continue; }

        let manifest: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&manifest_path)?)?;

        let name     = manifest["name"].as_str().unwrap_or("Unnamed").to_string();
        let saved_at = manifest["saved_at"].as_str().unwrap_or("").to_string();
        let tex_content = std::fs::read_to_string(&tex_path)?;

        let placeholder_set: HashSet<String> = std::fs::read_to_string(path.join("assets-meta.json"))
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .and_then(|v| v["placeholder_assets"].as_array().cloned())
            .unwrap_or_default()
            .iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect();

        // Lê assets salvos em disco
        let mut asset_data: HashMap<String, String> = HashMap::new();
        for asset in std::fs::read_dir(&path)?.flatten() {
            let p = asset.path();
            if !p.is_file() { continue; }
            let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("").to_lowercase();
            if matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "svg" | "pdf" | "eps" | "cls" | "sty" | "ttf" | "otf") {
                let filename = p.file_name().unwrap().to_string_lossy().to_string();
                if let Ok(data_url) = read_as_data_url(&p) {
                    asset_data.insert(filename, data_url);
                }
            }
        }

        let refs = extract_image_refs(&tex_content);
        let assets = refs.into_iter().map(|filename| {
            let present = asset_data.contains_key(&filename);
            ResumeAsset {
                data_url: asset_data.get(&filename).cloned(),
                present,
                placeholder: placeholder_set.contains(&filename),
                filename,
            }
        }).collect();

        packages.push(SavedResumePackage { name, tex_content, assets, saved_at });
    }

    Ok(packages)
}

fn read_as_data_url(path: &PathBuf) -> Result<String> {
    let bytes = std::fs::read(path)?;
    let mime = match path.extension().and_then(|x| x.to_str()).map(|x| x.to_lowercase()).as_deref() {
        Some("png")  => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif")  => "image/gif",
        Some("svg")  => "image/svg+xml",
        Some("pdf")  => "application/pdf",
        Some("cls") | Some("sty") | Some("ttf") | Some("otf") => "application/octet-stream",
        _            => "application/octet-stream",
    };
    Ok(format!("data:{};base64,{}", mime, B64.encode(&bytes)))
}

fn extract_image_refs(tex: &str) -> Vec<String> {
    let mut refs = Vec::new();
    let mut push = |path: &str| {
        let s = path.trim().to_string();
        if !s.is_empty() && !s.starts_with('\\') && !refs.contains(&s) {
            refs.push(s);
        }
    };

    for pattern in ["\\includegraphics", "\\roundpic"] {
        let mut offset = 0;
        while let Some(pos) = tex[offset..].find(pattern) {
            offset += pos + pattern.len();
            let rest = &tex[offset..];
            let mut idx = 0;
            while idx < rest.len() && rest.as_bytes()[idx].is_ascii_whitespace() { idx += 1; }
            if pattern == "\\includegraphics" && rest[idx..].starts_with('[') {
                idx += 1;
                let mut d = 1;
                while idx < rest.len() && d > 0 {
                    match rest.as_bytes()[idx] { b'[' => d += 1, b']' => d -= 1, _ => {} }
                    idx += 1;
                }
            }
            if idx < rest.len() && rest.as_bytes()[idx] == b'{' {
                idx += 1;
                let start = idx;
                let mut d = 1;
                while idx < rest.len() && d > 0 {
                    match rest.as_bytes()[idx] { b'{' => d += 1, b'}' => d -= 1, _ => {} }
                    idx += 1;
                }
                if d == 0 { push(&rest[start..idx - 1]); }
            }
        }
    }

    for ext in [".png", ".jpg", ".jpeg", ".gif", ".svg", ".pdf", ".eps"] {
        let mut offset = 0;
        while let Some(pos) = tex[offset..].find(ext) {
            let end = offset + pos + ext.len();
            if let Some(open) = tex[..end].rfind('{') {
                push(&tex[open + 1..end]);
            }
            offset = end;
        }
    }

    refs
}

fn sanitize(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
        .collect::<String>()
        .trim_start_matches('.')
        .to_string()
}
