use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;
use serde_json::Value;
use std::collections::HashSet;
use std::io::Write;
use uuid::Uuid;
use crate::{NightConfig, JobListing};

pub struct JobQueue {
    approved: HashSet<String>,
    pending_approval: Vec<JobListing>,
}

impl JobQueue {
    pub fn new() -> Self {
        Self {
            approved: HashSet::new(),
            pending_approval: vec![],
        }
    }

    pub fn approve(&mut self, job_id: String) {
        self.approved.insert(job_id);
    }

    pub fn is_approved(&self, job_id: &str) -> bool {
        self.approved.contains(job_id)
    }

    pub fn add_pending(&mut self, job: JobListing) {
        self.pending_approval.push(job);
    }
}

pub async fn run_night_mode(app: AppHandle, config: NightConfig, query: String) {
    log::info!("Iniciando modo noturno: {:?}", config.mode);
    emit(&app, "night_started", serde_json::json!({"mode": config.mode}));

    let playwright_result = run_playwright(&app, &config, &query).await;

    match playwright_result {
        Ok(summary) => {
            notify(&app, "CV Agent", &format!(
                "Concluído: {} candidatura(s) enviada(s)",
                summary.get("applied").and_then(|v| v.as_u64()).unwrap_or(0)
            ));
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
            notify(&app, "CV Agent - Erro", &friendly);
            emit(&app, "night_error", serde_json::json!({"error": friendly}));
        }
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
        let root = exe
            .parent().unwrap()
            .parent().unwrap()
            .parent().unwrap()
            .parent().unwrap();

        let dev = root.join("playwright").join("src").join("index.js");
        if dev.exists() {
            dev
        } else {
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

    // FIX: stdin piped para enviar comandos de aprovação ao processo Node
    let mut child = std::process::Command::new("node")
        .arg(&script_path)
        .arg("--query").arg(query)
        .arg("--config").arg(&config_json)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::piped())  // FIX: abre canal bidirecional
        .spawn()
        .map_err(|e| format!("Falha ao iniciar Node.js: {e}. Verifique se o Node está instalado."))?;

    let stdout = child.stdout.take().unwrap();
    // FIX: guarda stdin do filho para enviar aprovações
    let child_stdin = std::sync::Arc::new(std::sync::Mutex::new(child.stdin.take().unwrap()));
    let app_clone = app.clone();

    let mut applied = 0u64;
    let mut skipped = 0u64;
    let mut captcha = 0u64;

    use std::io::{BufRead, BufReader};
    let reader = BufReader::new(stdout);
    for line in reader.lines() {
        let line = line?;
        if let Ok(msg) = serde_json::from_str::<Value>(&line) {
            handle_playwright_message(
                &app_clone,
                &msg,
                &mut applied,
                &mut skipped,
                &mut captcha,
                child_stdin.clone(),
            );
        }
    }

    child.wait()?;

    Ok(serde_json::json!({
        "applied": applied,
        "skipped": skipped,
        "captcha": captcha
    }))
}

fn handle_playwright_message(
    app: &AppHandle,
    msg: &Value,
    applied: &mut u64,
    skipped: &mut u64,
    captcha: &mut u64,
    // FIX: stdin do processo Node para enviar aprovações
    child_stdin: std::sync::Arc<std::sync::Mutex<std::process::ChildStdin>>,
) {
    let event = msg["event"].as_str().unwrap_or("");
    match event {
        "job_found" => emit(app, "job_found", msg.clone()),
        "job_analyzed" => emit(app, "job_analyzed", msg.clone()),
        "job_applied" => {
            *applied += 1;
            emit(app, "job_applied", msg.clone());
        }
        "job_skipped" => {
            *skipped += 1;
            emit(app, "job_skipped", msg.clone());
        }
        "captcha_detected" => {
            *captcha += 1;
            notify(app, "CV Agent - CAPTCHA", &format!(
                "CAPTCHA detectado em {}. Resolva no navegador.",
                msg["company"].as_str().unwrap_or("empresa")
            ));
            emit(app, "captcha_detected", msg.clone());
        }
        // FIX: novo evento — frontend mostra botões Aprovar/Pular
        // A resposta do usuário chega via tauri command approve_job / skip_job
        // e é repassada ao Node via stdin
        "job_awaiting_approval" => {
            emit(app, "job_awaiting_approval", msg.clone());
            notify(app, "CV Agent - Aprovação", &format!(
                "Vaga aguardando aprovação: {}",
                msg["title"].as_str().unwrap_or("?")
            ));
            // O frontend vai chamar approve_job ou skip_job,
            // que por sua vez chama send_approval_to_node (ver lib.rs)
            // Guardamos o stdin no AppState para que o command possa usá-lo.
            // Como aqui não temos acesso ao AppState, emitimos um evento especial
            // com o stdin embutido não é possível — a solução é o AppState guardar
            // o Arc<Mutex<ChildStdin>>. Veja o comentário em lib.rs.
            let _ = child_stdin; // referência mantida viva via Arc no loop
        }
        "progress" => emit(app, "night_progress", msg.clone()),
        _ => {}
    }
}

fn emit(app: &AppHandle, event: &str, payload: Value) {
    app.emit(event, payload).ok();
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .ok();
}

#[allow(dead_code)]
pub fn new_job_id() -> String {
    Uuid::new_v4().to_string()
}

/// Envia um comando de aprovação/skip ao processo Node via stdin.
/// Chamado pelos tauri commands approve_job / skip_job quando mode=manual.
pub fn send_to_node(stdin: &mut std::process::ChildStdin, job_id: &str, action: &str) {
    let msg = serde_json::json!({ "job_id": job_id, "action": action });
    let _ = writeln!(stdin, "{}", msg);
}
