// src-tauri/src/lib.rs
use tauri::{AppHandle, State};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

mod db;
mod ollama;
mod latex;
mod queue;
mod resume;
pub mod texlive;

pub use db::Database;
pub use queue::JobQueue;

// ── Tipos ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NightConfig {
    pub mode: String,
    pub min_score: u8,
    pub max_per_night: u8,
    pub delay_minutes: u8,
    pub cover_letter: bool,
    pub stop_on_captcha: bool,
    pub blacklist: Vec<String>,
    pub sites: Vec<String>,
    #[serde(default)]
    pub modality: String,
    #[serde(default)]
    pub locations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobListing {
    pub id: String,
    pub title: String,
    pub company: String,
    pub url: String,
    pub site: String,
    pub description: String,
    pub score: Option<u8>,
    pub status: String,
    pub applied_at: Option<String>,
    pub resume_path: Option<String>,
    pub skip_reason: Option<String>,
    pub screenshot_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OllamaStatus {
    pub connected: bool,
    pub model: Option<String>,
    pub models_available: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NightReport {
    pub date: String,
    pub found: usize,
    pub analyzed: usize,
    pub applied: usize,
    pub skipped_score: usize,
    pub skipped_captcha: usize,
    pub skipped_error: usize,
    pub jobs: Vec<JobListing>,
}

pub struct AppState {
    pub db: Mutex<Database>,
    pub queue: Mutex<JobQueue>,
    pub running: Mutex<bool>,
    /// Stdin do processo Node em execução — usado para aprovação manual (mode=manual).
    /// None quando nenhum processo está rodando.
    pub node_stdin: Mutex<Option<std::process::ChildStdin>>,
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
async fn check_ollama(_state: State<'_, AppState>) -> Result<OllamaStatus, String> {
    ollama::check_status().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn analyze_job(
    job_description: String,
    resume_tex: String,
    model: String,
) -> Result<serde_json::Value, String> {
    ollama::analyze_job(&job_description, &resume_tex, &model)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn edit_resume(
    job_description: String,
    resume_tex: String,
    model: String,
    job_id: String,
) -> Result<serde_json::Value, String> {
    ollama::edit_resume(&job_description, &resume_tex, &model, &job_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn compile_latex(
    tex_content: String,
    job_id: String,
    app: AppHandle,
) -> Result<String, String> {
    latex::compile(&tex_content, &job_id, Some(&app))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn start_night_mode(
    config: NightConfig,
    query: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    {
        let mut running = state.running.lock().unwrap();
        if *running {
            return Err("Modo noturno já está em execução.".into());
        }
        *running = true;
    }
    tokio::spawn(async move {
        queue::run_night_mode(app, config, query).await;
    });
    Ok(())
}

#[tauri::command]
async fn stop_night_mode(state: State<'_, AppState>) -> Result<(), String> {
    *state.running.lock().unwrap() = false;
    Ok(())
}

#[tauri::command]
async fn get_jobs(
    limit: Option<i64>,
    status: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<JobListing>, String> {
    // db.get_jobs espera Option<Vec<String>>; o frontend envia Option<String>
    // (filtro único). Converte aqui para não mudar a assinatura do DB.
    let status_vec = status.map(|s| vec![s]);
    state.db.lock().unwrap()
        .get_jobs(limit, status_vec)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_night_report(
    date: Option<String>,
    state: State<'_, AppState>,
) -> Result<NightReport, String> {
    state.db.lock().unwrap().get_report(date).map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_resume_templates() -> Result<Vec<String>, String> {
    latex::list_templates().map_err(|e| e.to_string())
}

#[tauri::command]
async fn read_resume_template(name: String) -> Result<String, String> {
    latex::read_template(&name).map_err(|e| e.to_string())
}

#[tauri::command]
async fn search_jobs(
    query: String,
    sites: Vec<String>,
    modality: String,
    locations: Vec<String>,
    app: AppHandle,
) -> Result<(), String> {
    let config = NightConfig {
        mode: "dry_run".into(),
        min_score: 0,
        max_per_night: 30,
        delay_minutes: 1,
        cover_letter: false,
        stop_on_captcha: false,
        blacklist: vec![],
        sites,
        modality,
        locations,
    };
    tokio::spawn(async move {
        queue::run_night_mode(app, config, query).await;
    });
    Ok(())
}

#[tauri::command]
async fn approve_job(job_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.queue.lock().unwrap().approve(job_id.clone());
    if let Some(ref mut stdin) = *state.node_stdin.lock().unwrap() {
        queue::send_to_node(stdin, &job_id, "approve");
    }
    Ok(())
}

#[tauri::command]
async fn skip_job(
    job_id: String,
    reason: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.db.lock().unwrap()
        .update_job_status(&job_id, "skipped", Some(&reason), None, None)
        .map_err(|e| e.to_string())?;
    if let Some(ref mut stdin) = *state.node_stdin.lock().unwrap() {
        queue::send_to_node(stdin, &job_id, "skip");
    }
    Ok(())
}

// ── Setup ─────────────────────────────────────────────────────────────────────

pub fn run() {
    env_logger::init();

    let db = Database::new().expect("Falha ao inicializar banco de dados");
    db.migrate().expect("Falha ao executar migrações");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .manage(AppState {
            db: Mutex::new(db),
            queue: Mutex::new(JobQueue::new()),
            running: Mutex::new(false),
            node_stdin: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            check_ollama,
            analyze_job,
            edit_resume,
            compile_latex,
            start_night_mode,
            stop_night_mode,
            search_jobs,
            get_jobs,
            get_night_report,
            get_resume_templates,
            read_resume_template,
            approve_job,
            skip_job,
            resume::save_resume_package,
            resume::load_saved_resume_packages,
            resume::delete_resume_package,
            save_job,
            clear_history,
        ])
        .run(tauri::generate_context!())
        .expect("Erro ao iniciar aplicação");
}

// Esses dois commands são chamados pelo frontend (App.tsx) para persistir
// eventos do modo noturno no banco e limpar o histórico.

#[tauri::command]
async fn save_job(raw: serde_json::Value, state: State<'_, AppState>) -> Result<(), String> {
    // Aceita Value em vez de JobListing para ser tolerante a campos extras ou
    // tipos ligeiramente diferentes vindos do frontend (ex: score como float).
    let job = JobListing {
        id:              raw["id"].as_str().unwrap_or("").to_string(),
        title:           raw["title"].as_str().unwrap_or("").to_string(),
        company:         raw["company"].as_str().unwrap_or("").to_string(),
        url:             raw["url"].as_str().unwrap_or("").to_string(),
        site:            raw["site"].as_str().unwrap_or("").to_string(),
        description:     raw["description"].as_str().unwrap_or("").to_string(),
        score:           raw["score"].as_f64().map(|v| v as u8),
        status:          raw["status"].as_str().unwrap_or("found").to_string(),
        applied_at:      raw["applied_at"].as_str().map(String::from),
        resume_path:     raw["resume_path"].as_str().map(String::from),
        skip_reason:     raw["skip_reason"].as_str().map(String::from),
        screenshot_path: raw["screenshot_path"].as_str().map(String::from),
    };

    if job.id.is_empty() {
        log::warn!("save_job: id vazio, ignorando. payload: {:?}", raw);
        return Ok(());
    }

    log::info!("save_job: {} — {} ({})", job.status, job.title, job.id);
    state.db.lock().unwrap().upsert_job(&job).map_err(|e| e.to_string())
}

#[tauri::command]
async fn clear_history(state: State<'_, AppState>) -> Result<(), String> {
    state.db.lock().unwrap().clear_history().map_err(|e| e.to_string())
}

