# CV Agent

Agente autônomo de candidaturas de emprego com IA local (Ollama), automação de navegador (Playwright + Edge) e edição de currículo LaTeX.

---

## Pré-requisitos (instalar antes)

### 1. Node.js 18+
https://nodejs.org/en/download

### 2. Rust + Tauri CLI
```powershell
# Instala Rust
winget install Rustlang.Rustup

# Reinicie o terminal, depois:
cargo install tauri-cli --version "^2"
```

### 3. Ollama (IA local)
```powershell
winget install Ollama.Ollama

# Depois de instalar, baixe os modelos:
ollama pull qwen2.5:3b    # triagem rápida de vagas (~2GB)
ollama pull qwen2.5:7b    # edição de currículo (~4GB)
```

### 4. TeX Live (compilação LaTeX)
Baixe e instale: https://tug.org/texlive/windows.html
Instalação básica (~2GB) é suficiente — inclui `pdflatex` e `latexmk`.

### 5. Microsoft Edge
Já vem instalado no Windows 10/11. Certifique-se de estar atualizado.

---

## Instalação do projeto

```powershell
# Clone ou extraia o projeto
cd tauri-cv-agent

# Instala dependências do frontend
npm install

# Instala dependências do Playwright sidecar
cd playwright
npm install
npx playwright install chromium
cd ..
```

---

## Configuração do currículo

### Importando do Overleaf (recomendado)
1. No Overleaf, vá em **Menu → Download → Source** — isso baixa um `.zip` com o `.tex` + todas as imagens
2. No app, vá em **Currículos** e arraste o `.zip` para a área de drop
3. O app extrai automaticamente o `.tex` e todos os assets
4. Imagens faltando aparecem marcadas em vermelho — você pode:
   - **Adicionar o arquivo**: clique na imagem e selecione o arquivo correto
   - **Ativar placeholder**: o currículo compila sem a imagem (espaço vazio no lugar)

### Importando só o .tex
Se não tiver o zip, importe só o `.tex`. Imagens referenciadas aparecerão como "Faltando" e precisam ser adicionadas manualmente ou ativadas como placeholder.

---

## Rodando em desenvolvimento

```powershell
# Terminal 1 — Ollama deve estar rodando
ollama serve

# Terminal 2 — App Tauri
npm run tauri dev
```

---

## Build para produção

```powershell
# Compila o sidecar Playwright
cd playwright
npm run build
cd ..

# Build do app Tauri
npm run tauri build
```

O instalador `.exe` estará em `src-tauri/target/release/bundle/nsis/`.

---

## Uso

1. **Abra o app** — o indicador no canto inferior esquerdo mostra se o Ollama está conectado
2. **Coloque seu .tex** na pasta de templates (veja acima)
3. **Vá em "Modo noturno"** e configure:
   - O que buscar (cargo, nível, tecnologias)
   - Modo de operação (autônomo recomendado)
   - Score mínimo de fit (72% é um bom ponto de partida)
   - Limite de candidaturas por noite
   - Sites desejados
4. **Clique em "Iniciar"** e deixe rodando
5. **De manhã**, veja o relatório em "Relatório"

---

## Estrutura do projeto

```
tauri-cv-agent/
├── src/                    ← React + TypeScript (UI)
│   ├── pages/              ← Telas do app
│   ├── store/              ← Estado global (Zustand)
│   └── index.css           ← Design system
├── src-tauri/              ← Backend Rust
│   └── src/
│       ├── lib.rs          ← Commands Tauri
│       ├── db.rs           ← SQLite (histórico)
│       ├── ollama.rs       ← Integração Ollama
│       ├── latex.rs        ← Compilação PDF
│       └── queue.rs        ← Orquestrador modo noturno
├── playwright/             ← Sidecar Node.js
│   └── src/
│       ├── index.js        ← Entrada + browser
│       ├── orchestrator.js ← Fluxo completo
│       ├── ollama.js       ← Cliente Ollama
│       ├── latex.js        ← Compilação LaTeX
│       ├── captcha.js      ← Detecção de CAPTCHA
│       ├── utils.js        ← Humanização (delays, mouse)
│       └── sites/          ← Automação por site
│           ├── linkedin.js
│           ├── indeed.js
│           ├── catho.js
│           └── infojobs.js
└── %APPDATA%/cv-agent/     ← Dados em tempo de execução
    ├── curriculo/
    │   ├── templates/      ← Seus .tex aqui
    │   └── output/         ← PDFs gerados por vaga
    ├── screenshots/        ← CAPTCHAs capturados
    ├── browser-profile/    ← Sessão/cookies do Edge
    └── cvagent.db          ← Histórico SQLite
```

---

## Dicas

- **LinkedIn Easy Apply**: o sistema só candidata em vagas com Easy Apply (candidatura no próprio LinkedIn). Vagas que redirecionam para sites externos são puladas com aviso.
- **Primeira vez**: faça login manualmente no LinkedIn, Indeed, Catho e InfoJobs com o Edge aberto pelo app — a sessão fica salva e não precisa logar de novo.
- **Score 70–80%**: bom equilíbrio entre quantidade e qualidade. Acima de 85% = muito restritivo.
- **CAPTCHA frequente**: reduza a velocidade (aumente o delay entre envios) e certifique-se de ter feito login manualmente antes.
- **Modelos Ollama**: `qwen2.5:3b` é muito rápido para triagem. Se quiser mais qualidade na edição de currículo, use `qwen2.5:14b` (requer ~8GB RAM).
