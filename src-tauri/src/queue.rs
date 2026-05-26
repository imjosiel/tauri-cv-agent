// src-tauri/src/queue.rs
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;
use serde_json::Value;
use std::io::Write;
use crate::NightConfig;

pub struct JobQueue {
    approved: std::collections::HashSet<String>,
}

impl JobQueue {
    pub fn new() -> Self {
        Self { approved: std::collections::HashSet::new() }
    }

    pub fn approve(&mut self, job_id: String) {
        self.approved.insert(job_id);
    }
}

pub async fn run_night_mode(app: AppHandle, config: NightConfig, query: String) {
    log::info!("Iniciando modo noturno: {}", config.mode);
    emit(&app, "night_started", serde_json::json!({ "mode": config.mode }));

    match run_playwright(&app, &config, &query).await {
        Ok(summary) => {
            let count = summary.get("applied").and_then(|v| v.as_u64()).unwrap_or(0);
            notify(&app, "CV Agent", &format!("Concluído: {} candidatura(s) enviada(s)", count));
            emit(&app, "night_finished", summary);
        }
        Err(e) => {
            log::error!("Erro no modo noturno: {}", e);
            let msg = e.to_string();
            let friendly = if msg.contains("node") || msg.contains("Node") {
                "Node.js não encontrado. Instale em https://nodejs.org e certifique-se que está no PATH.".to_string()
            } else if msg.contains("playwright") || msg.contains("index.js") {
                format!("Script Playwright não encontrado. Rode: cd playwright && npm install\n\n{}", msg)
            } else {
                msg
            };
            notify(&app, "CV Agent — Erro", &friendly);
            emit(&app, "night_error", serde_json::json!({ "error": friendly }));
        }
    }
    // Reseta o flag — permite iniciar um novo ciclo noturno sem reiniciar o app
    if let Ok(state) = app.try_state::<crate::AppState>() {
        *state.running.lock().unwrap() = false;
    }
}

async fn run_playwright(
    app: &AppHandle,
    config: &NightConfig,
    query: &str,
) -> Result<Value, Box<dyn std::error::Error + Send + Sync>> {
    let config_json = serde_json::to_string(config)?;

    let script_path = {
        let exe = std::env::current_exe()?;
        let root = exe.parent().unwrap()
            .parent().unwrap()
            .parent().unwrap()
            .parent().unwrap();

        let dev = root.join("playwright").join("src").join("index.js");
        if dev.exists() { dev } else {
            exe.parent().unwrap().join("playwright").join("src").join("index.js")
        }
    };

    if !script_path.exists() {
        return Err(format!(
            "Script Playwright não encontrado em {:?}. Rode 'cd playwright && npm install'.",
            script_path
        ).into());
    }

    log::info!("Lançando node {:?}", script_path);

    let mut child = std::process::Command::new("node")
        .arg(&script_path)
        .arg("--query").arg(query)
        .arg("--config").arg(&config_json)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Falha ao iniciar Node.js: {e}. Verifique se o Node está instalado."))?;

    let stdout = child.stdout.take().unwrap();
    let child_stdin = std::sync::Arc::new(std::sync::Mutex::new(child.stdin.take().unwrap()));

    let mut applied = 0u64;
    let mut skipped = 0u64;
    let mut captcha = 0u64;

    use std::io::{BufRead, BufReader};
    for line in BufReader::new(stdout).lines() {
        let line = line?;
        if let Ok(msg) = serde_json::from_str::<Value>(&line) {
            handle_message(app, &msg, &mut applied, &mut skipped, &mut captcha, child_stdin.clone());
        }
    }

    child.wait()?;

    Ok(serde_json::json!({ "applied": applied, "skipped": skipped, "captcha": captcha }))
}

fn handle_message(
    app: &AppHandle,
    msg: &Value,
    applied: &mut u64,
    skipped: &mut u64,
    captcha: &mut u64,
    child_stdin: std::sync::Arc<std::sync::Mutex<std::process::ChildStdin>>,
) {
    match msg["event"].as_str().unwrap_or("") {
        "job_found"    => emit(app, "job_found", msg.clone()),
        "job_analyzed" => emit(app, "job_analyzed", msg.clone()),
        "job_applied"  => { *applied += 1; emit(app, "job_applied", msg.clone()); }
        "job_skipped"  => { *skipped += 1; emit(app, "job_skipped", msg.clone()); }
        "captcha_detected" => {
            *captcha += 1;
            notify(app, "CV Agent — CAPTCHA", &format!(
                "CAPTCHA detectado em {}. Resolva no navegador.",
                msg["company"].as_str().unwrap_or("empresa")
            ));
            emit(app, "captcha_detected", msg.clone());
        }
        "job_awaiting_approval" => {
            emit(app, "job_awaiting_approval", msg.clone());
            notify(app, "CV Agent — Aprovação", &format!(
                "Vaga aguardando aprovação: {}",
                msg["title"].as_str().unwrap_or("?")
            ));
            let _ = child_stdin; // mantém o Arc vivo durante o loop
        }
        "progress" => emit(app, "night_progress", msg.clone()),
        _ => {}
    }
}

fn emit(app: &AppHandle, event: &str, payload: Value) {
    app.emit(event, payload).ok();
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    app.notification().builder().title(title).body(body).show().ok();
}

/// Envia um comando de aprovação/skip ao processo Node via stdin (modo manual).
pub fn send_to_node(stdin: &mut std::process::ChildStdin, job_id: &str, action: &str) {
    let _ = writeln!(stdin, "{}", serde_json::json!({ "job_id": job_id, "action": action }));
}
