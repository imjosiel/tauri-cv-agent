// src-tauri/src/ollama.rs
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use crate::OllamaStatus;

const OLLAMA_URL: &str = "http://localhost:11434";

const TEX_START: &str = "<<<TEX_START>>>";
const TEX_END:   &str = "<<<TEX_END>>>";

pub async fn check_status() -> Result<OllamaStatus> {
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{}/api/tags", OLLAMA_URL))
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await;

    match resp {
        Ok(r) if r.status().is_success() => {
            let data: Value = r.json().await?;
            let models: Vec<String> = data["models"]
                .as_array()
                .unwrap_or(&vec![])
                .iter()
                .filter_map(|m| m["name"].as_str().map(String::from))
                .collect();

            let preferred = ["qwen2.5:14b", "qwen2.5:7b", "qwen2.5:3b", "llama3.2:3b", "llama3:8b"];
            let model = preferred
                .iter()
                .find(|&&p| models.iter().any(|m| m.starts_with(p)))
                .map(|s| s.to_string())
                .or_else(|| models.first().cloned());

            Ok(OllamaStatus { connected: true, model, models_available: models })
        }
        _ => Ok(OllamaStatus { connected: false, model: None, models_available: vec![] }),
    }
}

pub async fn analyze_job(
    job_description: &str,
    resume_tex: &str,
    model: &str,
) -> Result<Value> {
    let prompt = format!(
        r#"Você é um especialista em recrutamento. Analise a compatibilidade entre o currículo e a vaga.

CURRÍCULO (LaTeX):
{}

DESCRIÇÃO DA VAGA:
{}

Responda APENAS com JSON válido, sem markdown, sem texto extra:
{{
  "score": <número 0-100>,
  "reasons": ["razão 1", "razão 2"],
  "missing_skills": ["skill ausente 1"],
  "strong_points": ["ponto forte 1"],
  "recommendation": "aplicar" | "pular"
}}"#,
        resume_tex, job_description
    );

    let raw = chat(model, &prompt).await?;
    let clean = strip_markdown_fences(&raw);
    serde_json::from_str(&clean)
        .map_err(|e| anyhow!("JSON inválido na análise de vaga: {e}\n---\n{clean}"))
}

pub async fn edit_resume(
    job_description: &str,
    resume_tex: &str,
    model: &str,
    _job_id: &str,
) -> Result<Value> {
    // O LaTeX editado NÃO entra dentro do JSON para evitar o problema de
    // over-escaping de barras invertidas por LLMs (\\ → \\\\).
    // O modelo responde com metadados JSON + bloco LaTeX delimitado por marcadores.
    let prompt = format!(
        r#"Você é especialista em currículos LaTeX. Edite o currículo para a vaga abaixo.

REGRAS OBRIGATÓRIAS:
- Mantenha TODA a formatação LaTeX intacta (comandos, ambientes, classes, pacotes)
- Adapte apenas: resumo/objetivo, ordem de habilidades, palavras-chave relevantes
- NÃO invente experiências ou habilidades inexistentes
- NÃO altere datas, empresas, cargos ou conquistas reais

FORMATO DA RESPOSTA — siga exatamente esta estrutura:

JSON_META_START
{{
  "changes": ["mudança 1", "mudança 2"],
  "cover_letter": "<carta de apresentação em português, 3 parágrafos>"
}}
JSON_META_END
{tex_start}
<currículo LaTeX completo editado — copie e adapte o original>
{tex_end}

CURRÍCULO ORIGINAL (LaTeX):
{resume}

DESCRIÇÃO DA VAGA:
{job}

Responda agora seguindo exatamente o formato acima."#,
        tex_start = TEX_START,
        tex_end   = TEX_END,
        resume    = resume_tex,
        job       = job_description,
    );

    let raw = chat(model, &prompt).await?;

    let edited_tex = extract_between(&raw, TEX_START, TEX_END)
        .ok_or_else(|| anyhow!(
            "Modelo não retornou o bloco LaTeX com os marcadores esperados.\n\
             Resposta (primeiros 500 chars):\n{}",
            &raw[..raw.len().min(500)]
        ))?
        .trim()
        .to_string();

    if !edited_tex.contains(r"\documentclass") {
        return Err(anyhow!(
            "Bloco LaTeX inválido (sem \\documentclass):\n{}",
            &edited_tex[..edited_tex.len().min(400)]
        ));
    }

    let meta_json = extract_between(&raw, "JSON_META_START", "JSON_META_END")
        .map(|s| strip_markdown_fences(s.trim()))
        .unwrap_or_else(|| r#"{"changes":[],"cover_letter":""}"#.to_string());

    let mut meta: Value = serde_json::from_str(&meta_json)
        .unwrap_or_else(|_| json!({"changes": [], "cover_letter": ""}));

    meta["edited_tex"] = Value::String(sanitize_latex(&edited_tex));
    Ok(meta)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Escapa caracteres especiais LaTeX que LLMs frequentemente inserem
/// em texto livre sem escape (#, &).
/// Não toca em sequências já escapadas (\#, \&) nem em linhas de tabular
/// (onde & é separador de coluna — detectado pela presença de múltiplos &).
fn sanitize_latex(tex: &str) -> String {
    let mut result = String::with_capacity(tex.len() + 32);
    for line in tex.split('\n') {
        // Conta & não escapados na linha — se > 1, é linha de tabular, não mexe
        let raw_amps = line.chars()
            .zip(std::iter::once(' ').chain(line.chars()))
            .filter(|&(c, prev)| c == '&' && prev != '\\')
            .count();
        let is_tabular_line = raw_amps > 1;

        let mut out = String::with_capacity(line.len() + 4);
        let mut chars = line.chars().peekable();
        while let Some(c) = chars.next() {
            match c {
                '\\' => {
                    // Comando LaTeX — copia a barra e o próximo char sem modificar
                    out.push('\\');
                    if let Some(next) = chars.next() { out.push(next); }
                }
                '#' => { out.push_str("\\#"); }
                '&' if !is_tabular_line => { out.push_str("\\&"); }
                other => { out.push(other); }
            }
        }
        result.push_str(&out);
        result.push('\n');
    }
    // Remove o \n extra do final se o original não tinha
    if !tex.ends_with('\n') && result.ends_with('\n') {
        result.pop();
    }
    result
}

fn strip_markdown_fences(s: &str) -> String {
    let s = s.trim();
    if s.starts_with("```") {
        let inner = s.trim_start_matches('`').trim_start_matches("json").trim();
        if let Some(end) = inner.rfind("```") {
            return inner[..end].trim().to_string();
        }
        return inner.to_string();
    }
    s.to_string()
}

fn extract_between<'a>(text: &'a str, start_marker: &str, end_marker: &str) -> Option<&'a str> {
    let start = text.find(start_marker)? + start_marker.len();
    let end   = text[start..].find(end_marker)? + start;
    Some(&text[start..end])
}

async fn chat(model: &str, prompt: &str) -> Result<String> {
    let client = reqwest::Client::new();
    let body = json!({
        "model": model,
        "messages": [{ "role": "user", "content": prompt }],
        "stream": false,
        "options": { "temperature": 0.2, "num_predict": 8192 }
    });

    let resp = client
        .post(format!("{}/api/chat", OLLAMA_URL))
        .json(&body)
        .timeout(std::time::Duration::from_secs(180))
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!("Ollama retornou erro {}: {}", status, body));
    }

    let data: Value = resp.json().await?;
    data["message"]["content"]
        .as_str()
        .map(String::from)
        .ok_or_else(|| anyhow!("Resposta inesperada do Ollama: campo message.content ausente"))
}
