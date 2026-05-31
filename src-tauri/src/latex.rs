// src-tauri/src/latex.rs
use anyhow::{anyhow, Result};
use std::path::PathBuf;
use std::process::Command;
use tauri::AppHandle;
use crate::texlive;

fn data_dir() -> PathBuf {
    dirs_next::data_dir()
        .unwrap_or_else(|| std::env::temp_dir())
        .join("cv-agent")
}

fn templates_dir() -> PathBuf {
    data_dir().join("curriculo").join("templates")
}

fn output_dir() -> PathBuf {
    data_dir().join("curriculo").join("output")
}

/// Lista todos os pacotes de template salvos (subpastas com main.tex ou .tex solto).
pub fn list_templates() -> Result<Vec<String>> {
    let dir = templates_dir();
    std::fs::create_dir_all(&dir)?;

    let mut names = vec![];
    for entry in std::fs::read_dir(&dir)?.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if path.join("main.tex").exists() {
                if let Some(n) = path.file_name().and_then(|n| n.to_str()) {
                    names.push(format!("{}/main.tex", n));
                }
            }
        } else if path.extension().map_or(false, |x| x == "tex") {
            if let Some(n) = path.file_name().and_then(|n| n.to_str()) {
                names.push(n.to_string());
            }
        }
    }

    Ok(names)
}

/// Lê o conteúdo de um template.
pub fn read_template(name: &str) -> Result<String> {
    let path = templates_dir().join(name);
    std::fs::read_to_string(&path)
        .map_err(|e| anyhow!("Erro ao ler template '{}': {}", name, e))
}


/// Detecta usos de \cvevent ou \cvdegree fora de ambiente tabular e os envolve
/// em \begin{tabular}{...} ... \end{tabular}.
fn fix_cvevent_outside_tabular(tex: &str) -> String {
    let cmds: &[(&str, &str)] = &[
        ("\\cvevent",  "r|p{0.68\\textwidth}c"),
        ("\\cvdegree", "r p{0.68\\textwidth} c"),
    ];

    fn in_tabular(tex: &str, pos: usize) -> bool {
        let slice = &tex[..pos];
        let opens  = slice.matches("\\begin{tabular}").count();
        let closes = slice.matches("\\end{tabular}").count();
        opens > closes
    }

    fn cmd_end(tex: &str, start: usize) -> usize {
        let bytes = tex.as_bytes();
        let mut i = start;
        loop {
            while i < bytes.len() && matches!(bytes[i], b' ' | b'\t' | b'\n' | b'\r') { i += 1; }
            if i < bytes.len() && bytes[i] == b'[' {
                while i < bytes.len() && bytes[i] != b']' { i += 1; }
                i += 1; continue;
            }
            if i >= bytes.len() || bytes[i] != b'{' { break; }
            let mut depth = 0usize; i += 1;
            while i < bytes.len() {
                match bytes[i] {
                    b'{' => depth += 1,
                    b'}' => { if depth == 0 { i += 1; break; } depth -= 1; }
                    _ => {}
                }
                i += 1;
            }
        }
        i
    }

    let mut result = tex.to_string();
    for (cmd, fmt) in cmds {
        let mut offset = 0usize;
        loop {
            let Some(rel) = result[offset..].find(cmd) else { break };
            let pos = offset + rel;
            let after = pos + cmd.len();
            let next = result[after..].chars().next();
            if !matches!(next, Some('{') | Some('[') | Some(' ') | Some('\n') | Some('\t')) {
                offset = pos + 1; continue;
            }
            if in_tabular(&result, pos) { offset = pos + 1; continue; }
            let end = cmd_end(&result, after);
            let inner = result[pos..end].to_string();
            let wrapped = format!("\\begin{{tabular}}{{{fmt}}}\n    {inner}\n\\end{{tabular}}");
            result.replace_range(pos..end, &wrapped);
            log::info!("fix_cvevent_outside_tabular: {} envolto em tabular", cmd);
            offset = pos + wrapped.len();
        }
    }
    result
}

/// Mapa de comandos customizados e número esperado de argumentos.
const CUSTOM_CMD_ARGS: &[(&str, usize)] = &[
    ("cvevent",   6),
    ("cvdegree",  6),
    ("cvskill",   2),
    ("cvproject", 5),
];

/// Detecta usos de comandos customizados com menos argumentos que o esperado
/// e preenche os args faltantes com {} vazio.
/// Evita erros fatais como "File '\end' not found" causados por LLMs que omitem args.
fn fix_custom_command_args(tex: &str) -> String {
    let mut result = tex.to_string();

    for (cmd_name, expected) in CUSTOM_CMD_ARGS {
        let needle = format!("\\{}", cmd_name);
        let mut search_from = 0;

        loop {
            let Some(pos) = result[search_from..].find(&needle) else { break };
            let abs_pos = search_from + pos;
            let after_cmd = abs_pos + needle.len();

            // Verifica que é início de comando (não parte de outro nome)
            let next = result[after_cmd..].chars().next();
            if !matches!(next, Some('{') | Some('[') | Some(' ') | Some('\n') | Some('\t')) {
                search_from = abs_pos + 1;
                continue;
            }

            // Conta os grupos de argumentos
            let mut groups: Vec<(usize, usize)> = vec![]; // (start, end) de cada grupo
            let mut i = after_cmd;
            let bytes = result.as_bytes();

            loop {
                // Pula espaços e newlines
                while i < bytes.len() && matches!(bytes[i], b' ' | b'\t' | b'\n' | b'\r') {
                    i += 1;
                }
                // Pula opções [...]
                if i < bytes.len() && bytes[i] == b'[' {
                    while i < bytes.len() && bytes[i] != b']' { i += 1; }
                    i += 1;
                    continue;
                }
                if i >= bytes.len() || bytes[i] != b'{' { break; }

                let g_start = i;
                let mut depth = 0usize;
                i += 1;
                while i < bytes.len() {
                    match bytes[i] {
                        b'{' => depth += 1,
                        b'}' => {
                            if depth == 0 { i += 1; break; }
                            depth -= 1;
                        }
                        _ => {}
                    }
                    i += 1;
                }
                groups.push((g_start, i));
            }

            let missing = expected.saturating_sub(groups.len());
            if missing > 0 && missing <= 3 {
                let insert_at = groups.last().map(|g| g.1).unwrap_or(after_cmd);
                let padding = "{}".repeat(missing);
                result.insert_str(insert_at, &padding);
                log::info!(
                    "fix_custom_command_args: \\{} tinha {} args, esperava {} — inseridos {} arg(s) vazio(s)",
                    cmd_name, groups.len(), expected, missing
                );
                search_from = insert_at + padding.len();
            } else {
                search_from = abs_pos + 1;
            }
        }
    }

    result
}

/// Compila um .tex em PDF.
/// `app` recebe eventos de progresso durante a instalação do TinyTeX
/// (ocorre apenas na primeira compilação, quando o TinyTeX ainda não está instalado).
pub async fn compile(tex_content: &str, job_id: &str, app: Option<&AppHandle>) -> Result<String> {
    texlive::ensure_tinytex(app).await?;

    let out_dir = output_dir().join(job_id);
    std::fs::create_dir_all(&out_dir)?;

    let tex_path = out_dir.join("curriculo.tex");
    let pdf_path = out_dir.join("curriculo.pdf");

    // 1. Copia assets reais dos templates para o diretório de saída
    copy_assets_to_output(&out_dir)?;

    // 2. Escreve o .tex
    std::fs::write(&tex_path, tex_content)?;

    // 3a. Envolve \cvevent/\cvdegree soltos em tabular
    let fixed_tabular = fix_cvevent_outside_tabular(tex_content);
    // 3b. Corrige argumentos faltantes
    let fixed_tex = fix_custom_command_args(&fixed_tabular);
    let tex_to_compile = if fixed_tex != tex_content {
        log::info!("tex corrigido — args faltantes preenchidos em comandos customizados");
        std::fs::write(&tex_path, &fixed_tex)?;
        fixed_tex
    } else {
        tex_content.to_string()
    };

    // 4. Para cada referência de asset no .tex, garante que existe algo no out_dir:
    //    - imagem: cria PNG dummy 1×1 (não quebra o pdflatex, só fica em branco)
    //    - .cls/.sty: cria stub mínimo (evita "File not found" fatal)
    //    Também resolve referências com subpasta e extensão alternativa.
    ensure_assets(&tex_to_compile, &out_dir);

    // Tenta latexmk primeiro; se falhar, usa pdflatex com retry para arquivos faltantes
    let ok = try_latexmk(&out_dir).unwrap_or(false)
        || try_pdflatex_with_retry(&out_dir)?;

    if !ok {
        return Err(anyhow!("Compilação LaTeX falhou sem mensagem de erro específica."));
    }

    if !pdf_path.exists() {
        return Err(anyhow!("Compilação concluída mas PDF não foi gerado em {:?}.", pdf_path));
    }

    Ok(pdf_path.to_string_lossy().to_string())
}

fn try_latexmk(out_dir: &PathBuf) -> Result<bool> {
    let output = Command::new(texlive::tex_command("latexmk"))
        .args(["-pdf", "-interaction=nonstopmode", "-halt-on-error", "curriculo.tex"])
        .current_dir(out_dir)
        .output()
        .map_err(|e| anyhow!("latexmk não disponível: {}", e))?;

    if !output.status.success() {
        log::warn!("latexmk falhou:\n{}", String::from_utf8_lossy(&output.stdout));
    }

    Ok(output.status.success())
}

/// Extrai nomes de arquivo faltantes do log do pdflatex.
/// Ex: "! LaTeX Error: File `phantom' not found." → ["phantom"]
fn extract_missing_files(log: &str) -> Vec<String> {
    let mut missing = vec![];
    // Captura dois padrões do pdflatex:
    // 1. ! LaTeX Error: File `nome' not found.
    // 2. ! Package pdftex.def Error: File `nome' not found: using draft setting.
    // 3. LaTeX Warning: File `nome' not found on input line N.
    for line in log.lines() {
        if !line.contains("not found") { continue; }
        if !line.contains("File") && !line.contains("file") { continue; }

        // Extrai entre backtick (`) e aspas simples (')
        let chars: Vec<char> = line.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            if chars[i] == '`' || chars[i] == '\u{2018}' {
                let start = i + 1;
                let mut j = start;
                while j < chars.len() && chars[j] != '\'' && chars[j] != '\u{2019}' && chars[j] != '`' {
                    j += 1;
                }
                if j > start && j < chars.len() {
                    let name: String = chars[start..j].iter().collect();
                    let name = name.trim().to_string();
                    // Ignora nomes vazios ou que começam com \ (comandos LaTeX)
                    if !name.is_empty() && !name.starts_with('\\') && !missing.contains(&name) {
                        missing.push(name);
                    }
                }
                i = j + 1;
            } else {
                i += 1;
            }
        }
    }
    missing
}

/// Cria dummies para arquivos faltantes reportados pelo pdflatex.
fn create_dummies_from_log(log: &str, out_dir: &PathBuf) -> usize {
    let missing = extract_missing_files(log);
    let mut created = 0;

    for name in &missing {
        let ext = std::path::Path::new(name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();

        // Sem extensão → cria .png (imagem) e .sty (pacote) — pdflatex tenta os dois
        let targets: Vec<(String, &str)> = if ext.is_empty() {
            vec![
                (format!("{}.png", name), "image"),
                (format!("{}.sty", name), "sty"),
            ]
        } else if ["png","jpg","jpeg","pdf","eps","svg","gif"].contains(&ext.as_str()) {
            vec![(name.clone(), "image")]
        } else if ext == "cls" {
            vec![(name.clone(), "cls")]
        } else {
            vec![(name.clone(), "sty")]
        };

        for (file, kind) in targets {
            let dest = out_dir.join(&file);
            if dest.exists() { continue; }
            if let Some(parent) = dest.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let result = match kind {
                "image" => std::fs::write(&dest, DUMMY_PNG),
                "cls"   => std::fs::write(&dest,
                    "\\NeedsTeXFormat{LaTeX2e}\n\\ProvidesClass{stub}[2024/01/01]\n\\LoadClass{article}\n"),
                _       => std::fs::write(&dest, "% auto-generated stub\n"),
            };
            match result {
                Ok(_) => {
                    log::info!("dummy criado para arquivo faltante: {}", file);
                    created += 1;
                }
                Err(e) => log::warn!("falha ao criar dummy para {}: {}", file, e),
            }
        }
    }

    created
}

fn run_pdflatex(out_dir: &PathBuf) -> std::result::Result<std::process::Output, std::io::Error> {
    Command::new(texlive::tex_command("pdflatex"))
        .args(["-interaction=nonstopmode", "-halt-on-error", "curriculo.tex"])
        .current_dir(out_dir)
        .output()
}

/// Compila com pdflatex; se houver arquivos faltantes, cria dummies e recompila.
fn try_pdflatex_with_retry(out_dir: &PathBuf) -> Result<bool> {
    // Passagem 1
    let out1 = run_pdflatex(out_dir)
        .map_err(|_| anyhow!("pdflatex não encontrado. Verifique se o TinyTeX foi instalado."))?;

    if out1.status.success() {
        // Segunda passagem para resolver referências cruzadas
        let _ = run_pdflatex(out_dir);
        return Ok(true);
    }

    let log1 = String::from_utf8_lossy(&out1.stdout).to_string()
        + &String::from_utf8_lossy(&out1.stderr);

    let missing = extract_missing_files(&log1);
    if missing.is_empty() {
        // Erro não relacionado a arquivo faltante — reporta
        let lines: Vec<&str> = log1.lines()
            .filter(|l| l.starts_with('!') || l.contains("Error") || l.contains("Fatal"))
            .take(5)
            .collect();
        let summary = if lines.is_empty() { log1[..log1.len().min(500)].to_string() } else { lines.join("\n") };
        return Err(anyhow!("Erro na compilação LaTeX:\n{}", summary));
    }

    // Cria dummies e recompila
    let n = create_dummies_from_log(&log1, out_dir);
    log::info!("{} dummies criados — recompilando...", n);

    let out2 = run_pdflatex(out_dir)
        .map_err(|_| anyhow!("pdflatex não encontrado."))?;

    if out2.status.success() {
        let _ = run_pdflatex(out_dir);
        return Ok(true);
    }

    // Passagem 3: última tentativa
    let log2 = String::from_utf8_lossy(&out2.stdout).to_string()
        + &String::from_utf8_lossy(&out2.stderr);
    create_dummies_from_log(&log2, out_dir);

    let out3 = run_pdflatex(out_dir)
        .map_err(|_| anyhow!("pdflatex não encontrado."))?;

    if out3.status.success() {
        return Ok(true);
    }

    let log3 = String::from_utf8_lossy(&out3.stdout).to_string()
        + &String::from_utf8_lossy(&out3.stderr);
    let lines: Vec<&str> = log3.lines()
        .filter(|l| l.starts_with('!') || l.contains("Error") || l.contains("Fatal"))
        .take(5)
        .collect();
    let summary = if lines.is_empty() { log3[..log3.len().min(500)].to_string() } else { lines.join("\n") };
    Err(anyhow!("Erro na compilação LaTeX após retry:\n{}", summary))
}



// ── PNG 1×1 transparente ──────────────────────────────────────────────────────
const DUMMY_PNG: &[u8] = &[
    0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A,
    0x00,0x00,0x00,0x0D,0x49,0x48,0x44,0x52,
    0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x01,
    0x08,0x06,0x00,0x00,0x00,0x1F,0x15,0xC4,
    0x89,0x00,0x00,0x00,0x0A,0x49,0x44,0x41,
    0x54,0x78,0x9C,0x62,0x00,0x01,0x00,0x00,
    0x05,0x00,0x01,0x0D,0x0A,0x2D,0xB4,0x00,
    0x00,0x00,0x00,0x00,0x49,0x45,0x4E,0x44,
    0xAE,0x42,0x60,0x82,
];

// Extensões de imagem e de estilo LaTeX que tratamos
const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "pdf", "eps", "svg", "gif"];
const STYLE_EXTS: &[&str] = &["cls", "sty"];

/// Garante que todo asset referenciado no .tex existe no out_dir antes da compilação.
///
/// Três situações cobertas:
/// 1. **Subpasta** — `\includegraphics{img/foto.png}`: cria `out_dir/img/` e o dummy lá dentro.
/// 2. **Extensão alternativa** — referência é `foto.png` mas existe `foto.jpg` no out_dir:
///    copia o arquivo existente com o nome esperado pelo .tex.
/// 3. **.cls/.sty ausente** — cria um stub LaTeX mínimo para evitar "File not found" fatal.
fn ensure_assets(tex: &str, out_dir: &PathBuf) {
    let refs = collect_asset_refs(tex);

    for ref_path in refs {
        let dest = out_dir.join(&ref_path);

        // Já existe — nada a fazer
        if dest.exists() {
            continue;
        }

        let ext = std::path::Path::new(&ref_path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();

        // Garante que o diretório pai existe (cobre referências com subpasta)
        if let Some(parent) = dest.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                log::warn!("ensure_assets: não foi possível criar diretório {:?}: {}", parent, e);
                continue;
            }
        }

        let stem = std::path::Path::new(&ref_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();

        if IMAGE_EXTS.contains(&ext.as_str()) {
            // FIX 2: tenta extensão alternativa já copiada para out_dir (flat)
            let alt = find_alt_ext(out_dir, &stem, IMAGE_EXTS);
            if let Some(src) = alt {
                log::info!("ensure_assets: usando '{}' como substituto para '{}'", src.display(), ref_path);
                if let Err(e) = std::fs::copy(&src, &dest) {
                    log::warn!("ensure_assets: falha ao copiar alternativo {:?}: {}", src, e);
                    // Fallback: cria dummy mesmo assim
                    write_dummy_image(&dest, &ref_path);
                }
            } else {
                // FIX 1: cria PNG dummy (subpasta já foi criada acima)
                write_dummy_image(&dest, &ref_path);
            }
        } else if STYLE_EXTS.contains(&ext.as_str()) {
            // FIX 3: cria stub mínimo de .cls/.sty para evitar erro fatal
            write_style_stub(&dest, &ref_path, &ext);
        }
    }
}

fn write_dummy_image(dest: &PathBuf, name: &str) {
    if let Err(e) = std::fs::write(dest, DUMMY_PNG) {
        log::warn!("ensure_assets: não foi possível criar dummy para '{}': {}", name, e);
    } else {
        log::info!("ensure_assets: dummy PNG criado para '{}'", name);
    }
}

fn write_style_stub(dest: &PathBuf, name: &str, ext: &str) {
    // Stub mínimo válido: apenas um comentário. O pdflatex não falha ao carregar,
    // mas o layout pode ficar incorreto caso o .cls/sty seja essencial.
    let stub = if ext == "cls" {
        "\\NeedsTeXFormat{LaTeX2e}\n\\ProvidesClass{stub}[2024/01/01 auto-generated stub]\n\\LoadClass{article}\n"
    } else {
        "% auto-generated stub\n"
    };
    if let Err(e) = std::fs::write(dest, stub) {
        log::warn!("ensure_assets: não foi possível criar stub para '{}': {}", name, e);
    } else {
        log::info!("ensure_assets: stub {} criado para '{}'", ext, name);
    }
}

/// Procura no out_dir um arquivo com o mesmo stem mas extensão diferente.
fn find_alt_ext(out_dir: &PathBuf, stem: &str, exts: &[&str]) -> Option<PathBuf> {
    for ext in exts {
        let candidate = out_dir.join(format!("{}.{}", stem, ext));
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

/// Extrai os nomes de asset referenciados no .tex.
///
/// Em vez de varredura genérica (que confundia argumentos de comandos como
/// `\phantom{X}` com nomes de arquivo), agora usamos apenas comandos explícitos
/// que de fato referenciam arquivos:
///   \includegraphics[opts]{arquivo}
///   \includepdf[opts]{arquivo}
///   \input{arquivo}  \include{arquivo}
///   \documentclass[opts]{classe}
///   \usepackage[opts]{pacote}        → pacote.sty
///   \roundpic{w}{h}{arquivo}         (custom em alguns templates)
fn collect_asset_refs(tex: &str) -> Vec<String> {
    let mut refs = std::collections::HashSet::new();

    // Comandos cujo argumento obrigatório final é um arquivo de imagem
    for cmd in &[
        "\\includegraphics",
        "\\includepdf",
        "\\roundpic",
        "\\pgfdeclareimage",
    ] {
        let mut offset = 0;
        while let Some(pos) = tex[offset..].find(cmd) {
            offset += pos + cmd.len();
            let rest = &tex[offset..];
            // Pula opções opcionais [...] e argumentos extras {...} antes do arquivo
            // Para \roundpic{w}{h}{arquivo} precisamos do último argumento
            let mut _search_from = 0;
            // Conta chaves abertas para pegar o último argumento
            let mut depth = 0_usize;
            let mut last_arg = String::new();
            let chars: Vec<char> = rest.chars().collect();
            let mut ci = 0;
            // Pula espaços e [...]
            while ci < chars.len() && (chars[ci].is_whitespace() || chars[ci] == '[') {
                if chars[ci] == '[' {
                    while ci < chars.len() && chars[ci] != ']' { ci += 1; }
                }
                ci += 1;
            }
            // Lê todos os grupos {...}
            while ci < chars.len() {
                if chars[ci] == '{' {
                    depth += 1;
                    let start = ci + 1;
                    ci += 1;
                    while ci < chars.len() && !(chars[ci] == '}' && depth == 1) {
                        if chars[ci] == '{' { depth += 1; }
                        else if chars[ci] == '}' { depth -= 1; }
                        ci += 1;
                    }
                    let arg: String = chars[start..ci].iter().collect();
                    last_arg = arg.trim().to_string();
                    depth = depth.saturating_sub(1);
                    ci += 1;
                    // Para \includegraphics o único grupo é o arquivo
                    if *cmd != "\\roundpic" && *cmd != "\\pgfdeclareimage" {
                        break;
                    }
                } else if chars[ci].is_whitespace() || chars[ci] == '[' {
                    if chars[ci] == '[' {
                        while ci < chars.len() && chars[ci] != ']' { ci += 1; }
                    }
                    ci += 1;
                } else {
                    break;
                }
            }
            let name = last_arg;
            if !name.is_empty() && !name.contains('\\') && !name.contains(' ') {
                // Garante extensão — se omitida, tenta .png (pdflatex default para \includegraphics)
                if name.contains('.') {
                    refs.insert(name);
                } else {
                    refs.insert(format!("{}.png", name));
                }
            }
        }
    }

    // \documentclass[opts]{classe} → classe.cls
    let mut offset = 0;
    while let Some(pos) = tex[offset..].find("\\documentclass") {
        offset += pos + "\\documentclass".len();
        let rest = &tex[offset..];
        let mut idx = 0;
        if rest.trim_start().starts_with('[') {
            idx = rest.find("]{").map(|p| p + 1).unwrap_or(0);
        }
        if let Some(open) = rest[idx..].find('{') {
            let after = idx + open + 1;
            if let Some(close) = rest[after..].find('}') {
                let cls = rest[after..after + close].trim();
                if !cls.is_empty() && !cls.contains('\\') && !cls.contains(',') {
                    refs.insert(format!("{}.cls", cls));
                }
            }
        }
    }

    // \usepackage[opts]{pacote} → pacote.sty  (só para pacotes não-padrão)
    // Ignora pacotes do TeX Live que sempre existem
    const BUILTIN: &[&str] = &[
        "inputenc","fontenc","babel","geometry","graphicx","xcolor","hyperref",
        "amsmath","amssymb","amsfonts","tikz","pgf","listings","verbatim",
        "enumitem","fancyhdr","titlesec","parskip","microtype","booktabs",
        "array","longtable","multirow","multicol","float","caption","subcaption",
        "natbib","biblatex","csquotes","setspace","ragged2e","soul","ulem",
        "fontawesome","fontawesome5","academicons","calc","etoolbox","ifthen",
        "xparse","expl3","l3packages","lmodern","times","palatino","helvet",
        "avant","courier","mathptmx","mathpazo","fourier","utopia","charter",
        "libertine","sourcesanspro","sourcecodepro","raleway","roboto",
        "opensans","cabin","lato","inconsolata","DejaVuSans","DejaVuSerif",
    ];
    let mut offset = 0;
    while let Some(pos) = tex[offset..].find("\\usepackage") {
        offset += pos + "\\usepackage".len();
        let rest = &tex[offset..];
        let mut idx = 0;
        if rest.trim_start().starts_with('[') {
            idx = rest.find("]{").map(|p| p + 1).unwrap_or(0);
        }
        if let Some(open) = rest[idx..].find('{') {
            let after = idx + open + 1;
            if let Some(close) = rest[after..].find('}') {
                let pkg = rest[after..after + close].trim();
                if !pkg.is_empty() && !pkg.contains('\\') && !pkg.contains(',')
                    && !BUILTIN.contains(&pkg)
                {
                    refs.insert(format!("{}.sty", pkg));
                }
            }
        }
    }

    refs.into_iter().collect()
}

/// Copia .cls, .sty, imagens e fontes de todos os pacotes salvos
/// para o diretório de saída, onde o pdflatex vai procurá-los.
/// Arquivos marcados como placeholder NÃO são copiados — o ensure_assets
/// depois cria um dummy para eles.
fn copy_assets_to_output(out_dir: &PathBuf) -> Result<()> {
    let tpl_dir = templates_dir();
    if !tpl_dir.exists() {
        return Ok(());
    }

    let placeholder_set = load_placeholder_set();
    let asset_exts = ["png", "jpg", "jpeg", "pdf", "eps", "svg", "cls", "sty", "ttf", "otf"];
    let mut copied = 0usize;

    for entry in std::fs::read_dir(&tpl_dir)?.flatten() {
        let src = entry.path();
        let sources: Box<dyn Iterator<Item = PathBuf>> = if src.is_dir() {
            Box::new(
                std::fs::read_dir(&src)
                    .ok()
                    .into_iter()
                    .flatten()
                    .flatten()
                    .map(|e| e.path()),
            )
        } else {
            Box::new(std::iter::once(src))
        };

        for ap in sources {
            let ext = ap.extension().and_then(|e| e.to_str()).unwrap_or("");
            if asset_exts.contains(&ext) {
                let dest = out_dir.join(ap.file_name().unwrap());
                let fname = ap.file_name().unwrap().to_string_lossy().to_string();
                if placeholder_set.contains(&fname) {
                    log::info!("copy_assets: pulando placeholder '{}'", fname);
                    continue;
                }
                match std::fs::copy(&ap, &dest) {
                    Ok(_) => copied += 1,
                    Err(e) => log::warn!("Falha ao copiar {:?}: {}", ap, e),
                }
            }
        }
    }

    log::info!("{} assets copiados para {:?}", copied, out_dir);
    Ok(())
}

/// Carrega o conjunto de filenames marcados como placeholder em qualquer template.
fn load_placeholder_set() -> std::collections::HashSet<String> {
    let mut set = std::collections::HashSet::new();
    let tpl_dir = templates_dir();
    if !tpl_dir.exists() { return set; }

    for entry in std::fs::read_dir(&tpl_dir).into_iter().flatten().flatten() {
        let meta_path = entry.path().join("assets-meta.json");
        if let Ok(content) = std::fs::read_to_string(&meta_path) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
                for item in v["placeholder_assets"].as_array().unwrap_or(&vec![]) {
                    if let Some(s) = item.as_str() {
                        set.insert(s.to_string());
                    }
                }
            }
        }
    }

    set
}
