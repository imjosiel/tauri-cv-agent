use anyhow::{Result, anyhow};
use serde_json::{json, Value};
use crate::OllamaStatus;

const OLLAMA_URL: &str = "http://localhost:11434";

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

            let preferred = ["qwen2.5:14b", "qwen2.5:7b", "qwen2.5:3b",
                             "llama3.2:3b", "llama3:8b"];
            let model = preferred.iter()
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

Responda APENAS com JSON válido, sem markdown:
{{
  "score": <número 0-100>,
  "reasons": ["razão 1", "razão 2"],
  "missing_skills": ["skill ausente 1"],
  "strong_points": ["ponto forte 1"],
  "recommendation": "aplicar" | "pular"
}}"#,
        resume_tex, job_description
    );

    let result = chat(model, &prompt).await?;
    let clean = result.trim().trim_start_matches("```json").trim_end_matches("```").trim();
    serde_json::from_str(clean).map_err(|e| anyhow!("JSON inválido do Ollama: {e}\n{clean}"))
}

pub async fn edit_resume(
    job_description: &str,
    resume_tex: &str,
    model: &str,
    _job_id: &str,
) -> Result<Value> {
    let prompt = format!(
        r#"Você é especialista em currículos LaTeX. Edite o currículo para a vaga abaixo.

REGRAS:
- Mantenha TODA a formatação LaTeX intacta
- Adapte apenas: resumo/objetivo, ordem de habilidades, palavras-chave relevantes
- NÃO invente experiências ou habilidades que não existem
- NÃO altere datas, empresas, cargos ou conquistas
- Responda APENAS com JSON válido, sem markdown
- Use \\n para quebras de linha dentro do LaTeX; não use quebras literais
- Escape corretamente todas as aspas e barras invertidas; cada barra invertida LaTeX deve aparecer como \\\\ no JSON

CURRÍCULO ORIGINAL (LaTeX):
{}

DESCRIÇÃO DA VAGA:
{}

Responda com:
{{
  "edited_tex": "<currículo LaTeX completo editado>",
  "changes": ["mudança 1", "mudança 2"],
  "cover_letter": "<carta de apresentação em português, 3 parágrafos>"
}}"#,
        resume_tex, job_description
    );

    let result = chat(model, &prompt).await?;
    let clean = result.trim().trim_start_matches("```json").trim_end_matches("```").trim();
    serde_json::from_str(clean).map_err(|e| anyhow!("JSON inválido: {e}"))
}

async fn chat(model: &str, prompt: &str) -> Result<String> {
    let client = reqwest::Client::new();
    let body = json!({
        "model": model,
        "messages": [{ "role": "user", "content": prompt }],
        "stream": false,
        "options": { "temperature": 0.3, "num_predict": 4096 }
    });

    let resp = client
        .post(format!("{}/api/chat", OLLAMA_URL))
        .json(&body)
        .timeout(std::time::Duration::from_secs(120))
        .send()
        .await?;

    if !resp.status().is_success() {
        return Err(anyhow!("Ollama retornou erro: {}", resp.status()));
    }

    let data: Value = resp.json().await?;
    data["message"]["content"]
        .as_str()
        .map(String::from)
        .ok_or_else(|| anyhow!("Resposta inválida do Ollama"))
}
