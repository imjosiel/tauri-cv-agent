import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import styles from "./PageResumes.module.css";

// ── Tipos ─────────────────────────────────────────────────────────────────────

interface TexAsset {
  filename: string;
  present: boolean;
  placeholder: boolean;
  dataUrl?: string;
}

interface ResumePackage {
  name: string;
  texContent: string;
  assets: TexAsset[];
  importedAt: string;
}

// ── Extrai referências de imagem do .tex ──────────────────────────────────────

function extractImageRefs(tex: string): string[] {
  const refs = new Set<string>();
  const patterns = [
    /\\includegraphics(?:\[.*?\])?\{([^}]+)\}/g,
    /\\roundpic\{([^}]+)\}/g,
    /\}\{([^}]+\.(?:png|jpg|jpeg|pdf|eps|svg))\}/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(tex)) !== null) {
      const f = m[1].trim();
      if (f && !f.startsWith("\\")) refs.add(f);
    }
  }
  return [...refs];
}

// ── Leitura local de zip via DecompressionStream ───────────────────────────────

async function readZipLocally(file: File): Promise<{ name: string; content: ArrayBuffer }[]> {
  const buf = await file.arrayBuffer();
  const view = new DataView(buf);
  const results: { name: string; content: ArrayBuffer }[] = [];
  let offset = 0;

  while (offset < buf.byteLength - 4) {
    const sig = view.getUint32(offset, true);
    if (sig !== 0x04034b50) break;

    const compression = view.getUint16(offset + 8,  true);
    const compSize    = view.getUint32(offset + 18, true);
    const uncompSize  = view.getUint32(offset + 22, true);
    const nameLen     = view.getUint16(offset + 26, true);
    const extraLen    = view.getUint16(offset + 28, true);
    const name        = new TextDecoder().decode(new Uint8Array(buf, offset + 30, nameLen));
    const dataOffset  = offset + 30 + nameLen + extraLen;

    if (!name.endsWith("/")) {
      const compData = new Uint8Array(buf, dataOffset, compSize);
      let content: ArrayBuffer;

      if (compression === 0) {
        content = buf.slice(dataOffset, dataOffset + compSize);
      } else if (compression === 8) {
        try {
          const ds = new (window as any).DecompressionStream("deflate-raw");
          const writer = ds.writable.getWriter();
          const reader = ds.readable.getReader();
          writer.write(compData);
          writer.close();
          const chunks: Uint8Array[] = [];
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
          }
          const out = new Uint8Array(uncompSize);
          let pos = 0;
          for (const c of chunks) { out.set(c, pos); pos += c.length; }
          content = out.buffer;
        } catch { content = compData.buffer; }
      } else {
        content = compData.buffer;
      }
      results.push({ name, content });
    }
    offset = dataOffset + compSize;
  }
  return results;
}

function bufToDataUrl(buf: ArrayBuffer, filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const mime: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", svg: "image/svg+xml",
  };
  let bin = "";
  new Uint8Array(buf).forEach((b) => (bin += String.fromCharCode(b)));
  return `data:${mime[ext] ?? "image/png"};base64,${btoa(bin)}`;
}

// ── Componente principal ──────────────────────────────────────────────────────

export default function PageResumes() {
  const [packages, setPackages] = useState<ResumePackage[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const pkg = selected !== null ? packages[selected] : null;

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
          } else if (/\.(png|jpg|jpeg|gif|svg)$/i.test(shortName)) {
            assetMap.set(shortName, bufToDataUrl(entry.content, shortName));
          }
        }
      }

      if (!texContent) { setError("Nenhum arquivo .tex encontrado no zip"); return; }

      const refs = extractImageRefs(texContent);
      const assets: TexAsset[] = refs.map((filename) => ({
        filename,
        present: assetMap.has(filename),
        placeholder: false,
        dataUrl: assetMap.get(filename),
      }));

      const newPkg: ResumePackage = {
        name: file.name.replace(/\.(zip|tex)$/, ""),
        texContent,
        assets,
        importedAt: new Date().toLocaleString("pt-BR"),
      };

      setPackages((prev) => {
        const next = [...prev, newPkg];
        setSelected(next.length - 1);
        return next;
      });

      // Persiste no backend para o Playwright usar
      invoke("save_resume_package", {
        name: newPkg.name,
        texContent,
        assets: Object.fromEntries(assetMap),
      }).catch(() => {});
    } catch (e: any) {
      setError(`Erro ao importar: ${e.message ?? e}`);
    } finally {
      setImporting(false);
    }
  }

  function handleReplaceAsset(assetIdx: number, file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      setPackages((prev) => {
        const next = [...prev];
        if (selected === null) return next;
        const p = { ...next[selected], assets: [...next[selected].assets] };
        p.assets[assetIdx] = {
          ...p.assets[assetIdx],
          present: true,
          placeholder: false,
          dataUrl: reader.result as string,
        };
        next[selected] = p;
        return next;
      });
    };
    reader.readAsDataURL(file);
  }

  function togglePlaceholder(assetIdx: number) {
    setPackages((prev) => {
      const next = [...prev];
      if (selected === null) return next;
      const p = { ...next[selected], assets: [...next[selected].assets] };
      p.assets[assetIdx] = { ...p.assets[assetIdx], placeholder: !p.assets[assetIdx].placeholder };
      next[selected] = p;
      return next;
    });
  }

  function updateTex(val: string) {
    setPackages((prev) => {
      const next = [...prev];
      if (selected === null) return next;
      next[selected] = { ...next[selected], texContent: val };
      return next;
    });
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
        {packages.length > 0 && (
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

      {packages.length === 0 ? (
        <DropZone
          dragging={dragging} importing={importing}
          onDragOver={() => setDragging(true)}
          onDragLeave={() => setDragging(false)}
          onDrop={(f) => { setDragging(false); handleImport(f); }}
          onClick={() => fileInputRef.current?.click()}
        />
      ) : (
        <div className={styles.workspace}>

          {/* ── Sidebar de templates ──────────────────────────────────── */}
          <div className={styles.sidebar}>
            <div className={styles.sidebarLabel}>Templates</div>
            {packages.map((p, i) => {
              const miss = p.assets.filter((a) => !a.present && !a.placeholder).length;
              return (
                <button
                  key={i}
                  className={`${styles.templateBtn} ${selected === i ? styles.templateActive : ""}`}
                  onClick={() => setSelected(i)}
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

          {/* ── Detalhe do template ───────────────────────────────────── */}
          {pkg && (
            <div className={styles.detail}>

              {/* Cabeçalho */}
              <div className={styles.detailHeader}>
                <div>
                  <div className={styles.detailName}>{pkg.name}</div>
                  <div className={styles.detailMeta}>Importado em {pkg.importedAt}</div>
                </div>
                <div className={styles.statRow}>
                  {presentCount > 0     && <StatPill color="green"  label="presentes"   value={presentCount} />}
                  {placeholderCount > 0 && <StatPill color="amber"  label="placeholder" value={placeholderCount} />}
                  {missingCount > 0     && <StatPill color="red"    label="faltando"    value={missingCount} />}
                </div>
              </div>

              {/* Banner de aviso */}
              {missingCount > 0 && (
                <div className={styles.warnBanner}>
                  <span className={styles.warnIcon}>⚠</span>
                  <span>
                    <strong>{missingCount} imagem(ns)</strong> sem arquivo e sem placeholder.
                    Adicione os arquivos ou ative o placeholder para compilar sem erros.
                  </span>
                </div>
              )}

              {/* Grid de assets */}
              {pkg.assets.length > 0 && (
                <section className={styles.section}>
                  <div className={styles.sectionLabel}>
                    Imagens referenciadas no .tex
                    <span className={styles.sectionSub}>
                      · clique em qualquer imagem para substituir
                    </span>
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

              {/* Editor do .tex */}
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
                  value={pkg.texContent}
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

// ── DropZone ──────────────────────────────────────────────────────────────────

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
          <span className={styles.dropSub}>ou clique para selecionar &nbsp;·&nbsp; .zip ou .tex</span>
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

// ── AssetCard ─────────────────────────────────────────────────────────────────

function AssetCard({ asset, onReplace, onTogglePlaceholder }: {
  asset: TexAsset;
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
        {asset.dataUrl ? (
          <img src={asset.dataUrl} alt={asset.filename} className={styles.assetImg} />
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
              title="Usar espaço vazio no lugar da imagem — permite compilar sem erros"
            >
              {asset.placeholder ? "⬚ ativo" : "⬚ placeholder"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── StatPill ──────────────────────────────────────────────────────────────────

function StatPill({ color, label, value }: { color: string; label: string; value: number }) {
  const cls = { green: styles.statGreen, amber: styles.statAmber, red: styles.statRed }[color];
  return (
    <div className={`${styles.statPill} ${cls}`}>
      <strong>{value}</strong> {label}
    </div>
  );
}
