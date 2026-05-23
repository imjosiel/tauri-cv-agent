import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { unzipSync } from "fflate";
import { useAppStore } from "../store/appStore";
import type { ResumePackage, ResumeAsset } from "../store/appStore";
import styles from "./PageResumes.module.css";

// ── Utilitários ───────────────────────────────────────────────────────────────

function extractImageRefs(tex: string): string[] {
  const refs = new Set<string>();

  const classPattern = /\\documentclass(?:\[[^\]]*\])?\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = classPattern.exec(tex)) !== null) {
    const cls = m[1].trim().split(",")[0];
    if (cls) refs.add(`${cls}.cls`);
  }

  const patterns = [
    /\\includegraphics(?:\[.*?\])?\{([^}]+)\}/g,
    /\\roundpic\{([^}]+)\}/g,
    /\}\{([^}]+\.(?:png|jpg|jpeg|pdf|eps|svg))\}/gi,
  ];
  for (const re of patterns) {
    let m2: RegExpExecArray | null;
    while ((m2 = re.exec(tex)) !== null) {
      const f = m2[1].trim();
      if (f && !f.startsWith("\\")) refs.add(f);
    }
  }
  return [...refs];
}

async function readZipLocally(file: File) {
  const buf = await file.arrayBuffer();
  const entries = unzipSync(new Uint8Array(buf));
  return Object.entries(entries).map(([name, data]) => {
    const bytes = data as Uint8Array;
    return {
      name,
      content: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    };
  });
}

function bufToDataUrl(buf: ArrayBuffer, filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const mime: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", svg: "image/svg+xml", pdf: "application/pdf",
    eps: "application/postscript", cls: "text/plain", sty: "text/plain",
    ttf: "font/ttf", otf: "font/otf",
  };
  let bin = "";
  new Uint8Array(buf).forEach((b) => (bin += String.fromCharCode(b)));
  return `data:${mime[ext] ?? "application/octet-stream"};base64,${btoa(bin)}`;
}

// ── Componente principal ──────────────────────────────────────────────────────

export default function PageResumes() {
  const {
    resumePackages,
    addResumePackage,
    updateResumePackage,
    deleteResumePackage,
  } = useAppStore();

  const [selected, setSelected] = useState<string | null>(
    resumePackages[0]?.name ?? null
  );
  const [dragging, setDragging]   = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError]         = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const pkg = resumePackages.find((p) => p.name === selected) ?? null;

  async function handleImport(file: File) {
    if (!file.name.endsWith(".zip") && !file.name.endsWith(".tex")) {
      setError("Aceita apenas .zip (Overleaf) ou .tex");
      return;
    }
    setImporting(true);
    setError("");

    try {
      let texContent = "";
      const assetMap = new Map<string, string>();

      if (file.name.endsWith(".tex")) {
        texContent = await file.text();
      } else {
        const entries = await readZipLocally(file);
        for (const entry of entries) {
          const shortName = entry.name.split("/").pop()!;
          if (shortName.endsWith(".tex") && !texContent) {
            texContent = new TextDecoder().decode(entry.content);
          } else if (/\.(png|jpg|jpeg|gif|svg|cls|sty|pdf|eps|ttf|otf)$/i.test(shortName)) {
            assetMap.set(shortName, bufToDataUrl(entry.content, shortName));
          }
        }
      }

      if (!texContent) { setError("Nenhum arquivo .tex encontrado no zip"); return; }

      const refs = extractImageRefs(texContent);
      const assets: ResumeAsset[] = refs.map((filename) => {
        const data_url = assetMap.get(filename);
        return { filename, present: !!data_url, placeholder: !data_url, data_url };
      });

      const name = file.name.replace(/\.(zip|tex)$/, "");
      const newPkg: ResumePackage = {
        name,
        tex_content: texContent,
        assets,
        saved_at: new Date().toLocaleString("pt-BR"),
      };

      addResumePackage(newPkg);
      setSelected(name);

      // Persiste no disco
      await invoke("save_resume_package", {
        name,
        texContent,
        assets: Object.fromEntries(assetMap),
        placeholderAssets: assets.filter((a) => a.placeholder).map((a) => a.filename),
      });
    } catch (e: any) {
      setError(`Erro ao importar: ${e.message ?? e}`);
    } finally {
      setImporting(false);
    }
  }

  function handleReplaceAsset(assetIdx: number, file: File) {
    if (!pkg) return;
    const reader = new FileReader();
    reader.onload = () => {
      const newAssets = pkg.assets.map((a, i) =>
        i === assetIdx
          ? { ...a, present: true, placeholder: false, data_url: reader.result as string }
          : a
      );
      updateResumePackage(pkg.name, { assets: newAssets });
      persistAssets(pkg.name, pkg.tex_content, newAssets);
    };
    reader.readAsDataURL(file);
  }

  function togglePlaceholder(assetIdx: number) {
    if (!pkg) return;
    const newAssets = pkg.assets.map((a, i) =>
      i === assetIdx ? { ...a, placeholder: !a.placeholder } : a
    );
    updateResumePackage(pkg.name, { assets: newAssets });
    persistAssets(pkg.name, pkg.tex_content, newAssets);
  }

  function updateTex(val: string) {
    if (!pkg) return;
    updateResumePackage(pkg.name, { tex_content: val });
    // Debounce — persiste 1s após parar de digitar
    clearTimeout((updateTex as any)._t);
    (updateTex as any)._t = setTimeout(() => {
      persistAssets(pkg.name, val, pkg.assets);
    }, 1000);
  }

  async function handleDelete() {
    if (!pkg) return;
    if (!confirm(`Excluir "${pkg.name}"? Esta ação não pode ser desfeita.`)) return;
    try {
      await invoke("delete_resume_package", { name: pkg.name });
      deleteResumePackage(pkg.name);
      setSelected(resumePackages.find((p) => p.name !== pkg.name)?.name ?? null);
      setError("");
    } catch (e: any) {
      setError(`Erro ao excluir: ${e.message ?? e}`);
    }
  }

  const missingCount     = pkg?.assets.filter((a) => !a.present && !a.placeholder).length ?? 0;
  const presentCount     = pkg?.assets.filter((a) => a.present).length ?? 0;
  const placeholderCount = pkg?.assets.filter((a) => !a.present && a.placeholder).length ?? 0;

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Currículos</h1>
          <p className={styles.subtitle}>
            Importe o zip do Overleaf — assets, imagens e templates gerenciados aqui
          </p>
        </div>
        {resumePackages.length > 0 && (
          <button className={styles.btnImport} onClick={() => fileInputRef.current?.click()}>
            + Importar outro
          </button>
        )}
      </div>

      <input
        ref={fileInputRef} type="file" accept=".zip,.tex"
        style={{ display: "none" }}
        onChange={(e) => e.target.files?.[0] && handleImport(e.target.files[0])}
      />

      {error && <div className={styles.error}>{error}</div>}

      {resumePackages.length === 0 ? (
        <DropZone
          dragging={dragging} importing={importing}
          onDragOver={() => setDragging(true)}
          onDragLeave={() => setDragging(false)}
          onDrop={(f) => { setDragging(false); handleImport(f); }}
          onClick={() => fileInputRef.current?.click()}
        />
      ) : (
        <div className={styles.workspace}>

          {/* Sidebar */}
          <div className={styles.sidebar}>
            <div className={styles.sidebarLabel}>Templates</div>
            {resumePackages.map((p) => {
              const miss = p.assets.filter((a) => !a.present && !a.placeholder).length;
              return (
                <button
                  key={p.name}
                  className={`${styles.templateBtn} ${selected === p.name ? styles.templateActive : ""}`}
                  onClick={() => setSelected(p.name)}
                >
                  <span className={styles.templateName}>{p.name}</span>
                  {miss > 0 && <span className={styles.warnBadge}>{miss}</span>}
                </button>
              );
            })}
            <button className={styles.addTemplateBtn} onClick={() => fileInputRef.current?.click()}>
              + Importar
            </button>
          </div>

          {/* Detalhe */}
          {pkg && (
            <div className={styles.detail}>
              <div className={styles.detailHeader}>
                <div>
                  <div className={styles.detailName}>{pkg.name}</div>
                  <div className={styles.detailMeta}>Importado em {pkg.saved_at}</div>
                </div>
                <div style={{ display: "flex", gap: "1rem", alignItems: "center" }}>
                  <div className={styles.statRow}>
                    {presentCount > 0     && <StatPill color="green" label="presentes"   value={presentCount} />}
                    {placeholderCount > 0 && <StatPill color="amber" label="placeholder" value={placeholderCount} />}
                    {missingCount > 0     && <StatPill color="red"   label="faltando"    value={missingCount} />}
                  </div>
                  <button
                    onClick={handleDelete}
                    style={{
                      padding: "0.5rem 1rem", backgroundColor: "#dc2626", color: "white",
                      border: "none", borderRadius: "4px", cursor: "pointer",
                      fontSize: "0.9rem", fontWeight: "500",
                    }}
                  >
                    🗑 Excluir
                  </button>
                </div>
              </div>

              {missingCount > 0 && (
                <div className={styles.warnBanner}>
                  <span className={styles.warnIcon}>⚠</span>
                  <span>
                    <strong>{missingCount} imagem(ns)</strong> sem arquivo e sem placeholder.
                    Adicione os arquivos ou ative o placeholder para compilar sem erros.
                  </span>
                </div>
              )}

              {pkg.assets.length > 0 && (
                <section className={styles.section}>
                  <div className={styles.sectionLabel}>
                    Imagens referenciadas no .tex
                    <span className={styles.sectionSub}> · clique em qualquer imagem para substituir</span>
                  </div>
                  <div className={styles.assetsGrid}>
                    {pkg.assets.map((asset, i) => (
                      <AssetCard
                        key={asset.filename}
                        asset={asset}
                        onReplace={(f) => handleReplaceAsset(i, f)}
                        onTogglePlaceholder={() => togglePlaceholder(i)}
                      />
                    ))}
                  </div>
                </section>
              )}

              <section className={styles.section}>
                <div className={styles.sectionLabel}>
                  Conteúdo do main.tex
                  {missingCount > 0 && (
                    <span className={styles.patchNote}>
                      · imagens faltando viram \phantom{"{}"} na compilação
                    </span>
                  )}
                </div>
                <textarea
                  className={styles.texEditor}
                  value={pkg.tex_content}
                  onChange={(e) => updateTex(e.target.value)}
                  spellCheck={false}
                />
              </section>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function persistAssets(name: string, texContent: string, assets: ResumeAsset[]) {
  const assetMap: Record<string, string> = {};
  const placeholderAssets: string[] = [];
  for (const a of assets) {
    if (a.data_url) assetMap[a.filename] = a.data_url;
    if (a.placeholder) placeholderAssets.push(a.filename);
  }
  invoke("save_resume_package", { name, texContent, assets: assetMap, placeholderAssets })
    .catch(console.error);
}

// ── Sub-componentes ───────────────────────────────────────────────────────────

function DropZone({ dragging, importing, onDragOver, onDragLeave, onDrop, onClick }: {
  dragging: boolean; importing: boolean;
  onDragOver: () => void; onDragLeave: () => void;
  onDrop: (f: File) => void; onClick: () => void;
}) {
  return (
    <div
      className={`${styles.dropZone} ${dragging ? styles.dropActive : ""}`}
      onDragOver={(e) => { e.preventDefault(); onDragOver(); }}
      onDragLeave={onDragLeave}
      onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) onDrop(f); }}
      onClick={onClick}
    >
      {importing ? (
        <>
          <span className={styles.dropSpinner} />
          <span className={styles.dropTitle}>Importando...</span>
        </>
      ) : (
        <>
          <span className={styles.dropIcon}>⊞</span>
          <span className={styles.dropTitle}>Arraste o zip do Overleaf aqui</span>
          <span className={styles.dropSub}>ou clique para selecionar · .zip ou .tex</span>
          <div className={styles.dropHints}>
            <span className={styles.dropHint}>✓ Extrai .tex e imagens automaticamente</span>
            <span className={styles.dropHint}>✓ Imagens faltando viram placeholders</span>
            <span className={styles.dropHint}>✓ Substitua assets individualmente</span>
          </div>
        </>
      )}
    </div>
  );
}

function AssetCard({ asset, onReplace, onTogglePlaceholder }: {
  asset: ResumeAsset;
  onReplace: (f: File) => void;
  onTogglePlaceholder: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [hover, setHover] = useState(false);
  const status = asset.present ? "present" : asset.placeholder ? "placeholder" : "missing";
  const statusLabel = { present: "OK", placeholder: "Placeholder", missing: "Faltando" };
  const statusColor = { present: styles.pillGreen, placeholder: styles.pillAmber, missing: styles.pillRed };

  return (
    <div className={`${styles.assetCard} ${styles[`asset_${status}`]}`}>
      <input ref={inputRef} type="file" accept="image/*" style={{ display: "none" }}
        onChange={(e) => e.target.files?.[0] && onReplace(e.target.files[0])} />

      <div
        className={styles.assetPreview}
        onClick={() => inputRef.current?.click()}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        {asset.data_url ? (
          <img src={asset.data_url} alt={asset.filename} className={styles.assetImg} />
        ) : asset.placeholder ? (
          <div className={styles.assetPhBox}><span>⬚</span></div>
        ) : (
          <div className={styles.assetMissBox}><span>?</span></div>
        )}
        {hover && <div className={styles.assetOverlay}>substituir</div>}
      </div>

      <div className={styles.assetInfo}>
        <div className={styles.assetName} title={asset.filename}>{asset.filename}</div>
        <div className={styles.assetActions}>
          <span className={`${styles.pill} ${statusColor[status]}`}>{statusLabel[status]}</span>
          {!asset.present && (
            <button
              className={`${styles.phBtn} ${asset.placeholder ? styles.phBtnOn : ""}`}
              onClick={onTogglePlaceholder}
              title="Usar espaço vazio no lugar da imagem"
            >
              {asset.placeholder ? "⬚ ativo" : "⬚ placeholder"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function StatPill({ color, label, value }: { color: string; label: string; value: number }) {
  const cls = { green: styles.statGreen, amber: styles.statAmber, red: styles.statRed }[color];
  return (
    <div className={`${styles.statPill} ${cls}`}>
      <strong>{value}</strong> {label}
    </div>
  );
}
