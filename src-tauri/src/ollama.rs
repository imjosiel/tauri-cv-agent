// src-tauri/src/ollama.rs
use anyhow::{Result, anyhow};
use serde_json::{json, Value};
use crate::OllamaStatus;

const OLLAMA_URL: &str = "http://localhost:11434";

// Marcadores que delimitam o bloco LaTeX na resposta do modelo.
// Escolhidos para serem improvável de aparecer no próprio LaTeX.
const TEX_START: &str = "<<<TEX_START>>>";
const TEX_END: &str = "<<<TEX_END>>>";

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

            let preferred = [
                "qwen2.5:14b", "qwen2.5:7b", "qwen2.5:3b",
                "llama3.2:3b", "llama3:8b",
            ];
            let model = preferred
                .iter()
                .find(|&&p| models.iter().any(|m| m.starts_with(p)))
                .map(|s| s.to_string())
                .or_else(|| models.first().cloned());

            Ok(OllamaStatus { connected: true, model, models_available: models })
        }
        _ => Ok(OllamaStatus {
            connected: false,
            model: None,
            models_available: vec![],
        }),
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
    // ─────────────────────────────────────────────────────────────────────────
    // ESTRATÉGIA: o LaTeX editado NÃO fica dentro do JSON.
    //
    // Por que? JSON exige que barras invertidas sejam escapadas (\ → \\).
    // LLMs frequentemente "sobre-escapam" (\ → \\\\), corrompendo o LaTeX.
    // A solução é pedir ao modelo um formato misto:
    //   - metadados em JSON (changes, cover_letter)
    //   - o .tex delimitado por marcadores fora do JSON
    // Depois extraímos cada parte de forma independente.
    // ─────────────────────────────────────────────────────────────────────────
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
{TEX_START}
<currículo LaTeX completo editado — copie e adapte o original>
{TEX_END}

CURRÍCULO ORIGINAL (LaTeX):
{}

DESCRIÇÃO DA VAGA:
{}

Responda agora seguindo exatamente o formato acima."#,
        TEX_START, TEX_END,
        resume_tex, job_description
    );

    let raw = chat(model, &prompt).await?;

    // Extrai o bloco LaTeX pelos marcadores
    let edited_tex = extract_between(&raw, TEX_START, TEX_END)
        .ok_or_else(|| anyhow!(
            "Modelo não retornou o bloco LaTeX com os marcadores esperados.\n\
             Resposta recebida (primeiros 500 chars):\n{}",
            &raw[..raw.len().min(500)]
        ))?
        .trim()
        .to_string();

    // Sanidade básica: o LaTeX deve conter \documentclass
    if !edited_tex.contains(r"\documentclass") {
        return Err(anyhow!(
            "Bloco LaTeX retornado parece inválido (sem \\documentclass).\n\
             Conteúdo recebido:\n{}",
            &edited_tex[..edited_tex.len().min(400)]
        ));
    }

    // Extrai os metadados JSON
    let meta_json = extract_between(&raw, "JSON_META_START", "JSON_META_END")
        .map(|s| strip_markdown_fences(s.trim()))
        .unwrap_or_else(|| r#"{"changes":[],"cover_letter":""}"#.to_string());

    let mut meta: Value = serde_json::from_str(&meta_json)
        .unwrap_or_else(|_| json!({"changes": [], "cover_letter": ""}));

    // Injeta o LaTeX no objeto de retorno
    meta["edited_tex"] = Value::String(edited_tex);

    Ok(meta)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Remove fences de markdown (```json ... ``` ou ``` ... ```) de uma string.
fn strip_markdown_fences(s: &str) -> String {
    let s = s.trim();
    let s = if s.starts_with("```") {
        let after_fence = s.trim_start_matches('`').trim_start_matches("json").trim();
        if let Some(end) = after_fence.rfind("```") {
            after_fence[..end].trim()
        } else {
            after_fence
        }
    } else {
        s
    };
    s.to_string()
}

/// Extrai o conteúdo entre dois marcadores textuais.
fn extract_between<'a>(text: &'a str, start_marker: &str, end_marker: &str) -> Option<&'a str> {
    let start = text.find(start_marker)? + start_marker.len();
    let end = text[start..].find(end_marker)? + start;
    Some(&text[start..end])
}

async fn chat(model: &str, prompt: &str) -> Result<String> {
    let client = reqwest::Client::new();
    let body = json!({
        "model": model,
        "messages": [{ "role": "user", "content": prompt }],
        "stream": false,
        "options": {
            "temperature": 0.2,  // mais baixo = mais fiel ao formato pedido
            "num_predict": 8192  // currículo completo pode ser longo
        }
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
