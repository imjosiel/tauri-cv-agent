import { humanDelay, humanClick, uploadFile, waitForVisible } from "../utils.js";
import { callOllama } from "../ollama.js";

// Heurísticas simples + mapeamento via Ollama
export async function applyGeneric(page, pdfPath, coverLetter, contact, emit, log) {
  log("Tentando fallback genérico (AI-driven) para envio...");

  // Coleta campos (name/id/placeholder/labels) e botões
  const fields = await page.$$eval('input,textarea,select,button', (els) =>
    els.map((el, i) => {
      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute('type') || '';
      const name = el.getAttribute('name') || '';
      const id = el.id || '';
      const placeholder = el.getAttribute('placeholder') || '';
      let label = '';
      try {
        if (id) {
          const l = document.querySelector(`label[for="${id}"]`);
          if (l) label = l.innerText.trim();
        }
      } catch {}
      if (!label) {
        const p = el.closest('label');
        if (p) label = p.innerText.trim();
      }
      const text = el.innerText || '';
      // Prefer selectors by id or name
      let selector = id ? `#${id}` : (name ? `${tag}[name="${name}"]` : `${tag}`);
      return { selector, tag, type, name, id, placeholder, label: label.trim(), text: text.trim() };
    })
  );

  // Include some context
  const context = {
    job_title: (await page.title()).slice(0, 200),
    fields: fields.slice(0, 120),
  };

  // Ask Ollama to map fields to common form roles
  let mapping = null;
  try {
    const prompt = `Você é um assistente que mapeia campos de formulários HTML para valores de candidatura.\n\nDADOS: ${JSON.stringify(context)}\n\nRetorne apenas JSON com as chaves: {"name": "<selector>", "email": "<selector>", "phone": "<selector>", "resume": "<selector>", "cover_letter": "<selector>", "submit": "<selector>"}. Use null quando não souber.`;
    const raw = await callOllama('map_form', { prompt });
    mapping = JSON.parse(raw);
  } catch (e) {
    log('Falha ao pedir mapeamento ao Ollama: ' + e.message);
  }

  // Fallback heuristics if mapping missing
  function chooseSelector(list) {
    if (!list) return null;
    const candidates = list.filter(f => f.selector && f.selector.length);
    return candidates.length ? candidates[0].selector : null;
  }

  let nameSel = mapping?.name ?? null;
  let emailSel = mapping?.email ?? null;
  let phoneSel = mapping?.phone ?? null;
  let resumeSel = mapping?.resume ?? null;
  let coverSel = mapping?.cover_letter ?? null;
  let submitSel = mapping?.submit ?? null;

  // Heuristics: try to find common fields if not provided
  if (!emailSel) {
    const e = await page.$('input[type="email"]') || await page.$('input[name*=email]') || await page.$('input[placeholder*=email]');
    if (e) emailSel = await page.evaluate((el) => el.tagName.toLowerCase() + (el.name ? `[name="${el.name}"]` : el.id ? `#${el.id}` : ``), e);
  }
  if (!nameSel) {
    const e = await page.$('input[name*=name], input[placeholder*=name], input[id*=name]');
    if (e) nameSel = await page.evaluate((el) => el.tagName.toLowerCase() + (el.name ? `[name="${el.name}"]` : el.id ? `#${el.id}` : ``), e);
  }
  if (!phoneSel) {
    const e = await page.$('input[name*=phone], input[name*=telefone], input[placeholder*=phone]');
    if (e) phoneSel = await page.evaluate((el) => el.tagName.toLowerCase() + (el.name ? `[name="${el.name}"]` : el.id ? `#${el.id}` : ``), e);
  }
  if (!resumeSel) {
    const e = await page.$('input[type="file"]');
    if (e) resumeSel = await page.evaluate((el) => el.tagName.toLowerCase() + (el.name ? `[name="${el.name}"]` : el.id ? `#${el.id}` : ``), e);
  }
  if (!submitSel) {
    const btn = await page.$('button[type="submit"], input[type="submit"], button:has-text("enviar"), button:has-text("Enviar"), button:has-text("Candidatar"), button:has-text("Submit")');
    if (btn) submitSel = await page.evaluate((el) => {
      if (el.id) return `#${el.id}`;
      if (el.name) return `${el.tagName.toLowerCase()}[name="${el.name}"]`;
      return el.tagName.toLowerCase();
    }, btn);
  }

  // Fill values using provided contact or placeholders
  try {
    if (nameSel && contact?.name) {
      await page.fill(nameSel, contact.name).catch(() => {});
      await humanDelay(300, 700);
    }
    if (emailSel && contact?.email) {
      await page.fill(emailSel, contact.email).catch(() => {});
      await humanDelay(200, 500);
    }
    if (phoneSel && contact?.phone) {
      await page.fill(phoneSel, contact.phone).catch(() => {});
      await humanDelay(200, 500);
    }
    if (resumeSel && pdfPath) {
      await uploadFile(page, resumeSel, pdfPath).catch(() => {});
      await humanDelay(800, 1500);
    }
    if (coverSel && coverLetter) {
      await page.fill(coverSel, coverLetter).catch(() => {});
      await humanDelay(400, 900);
    } else if (coverLetter) {
      // try to find any textarea
      const ta = await page.$('textarea');
      if (ta) {
        await ta.fill(coverLetter).catch(() => {});
        await humanDelay(400, 900);
      }
    }

    // Click submit
    if (submitSel) {
      await humanClick(page, submitSel).catch(async () => {
        const btn = await page.$(submitSel);
        if (btn) await btn.click().catch(() => {});
      });
    } else {
      // try to click first button with candidate text
      const btn = await page.$('button,input[type="submit"],button[role="button"]');
      if (btn) await btn.click().catch(() => {});
    }

    await humanDelay(1500, 2600);

    // Check for confirmation
    const confirmed = await waitForVisible(page, '.application-success, .apply-success, .candidatura-enviada, .applied, .thanks, [data-test-id="confirmation"]', 8000);
    return { success: confirmed, reason: confirmed ? undefined : 'Fluxo genérico não confirmou envio' };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}
