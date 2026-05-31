// playwright/src/sites/infojobs.js
import { humanDelay, waitForVisible } from "../utils.js";
import { checkCaptcha, handleCaptcha } from "../captcha.js";

export async function searchInfoJobs(page, query, emit, stopOnCaptcha = false) {
  const jobs = [];
  const encoded = encodeURIComponent(query);
  try {
    await page.goto(`https://www.infojobs.com.br/empregos.aspx?palabra=${encoded}&publicadaEn=1`, {
      waitUntil: "domcontentloaded", timeout: 30000
    });
    await humanDelay(2000, 3500);

    if (await checkCaptcha(page)) {
      emit("captcha_detected", { site: "infojobs" });
      if (!stopOnCaptcha || !await handleCaptcha(page, stopOnCaptcha)) return jobs;
    }

    const pageTitle = await page.title().catch(() => "");
    const bodySnippet = await page.$eval("body", el => el.innerText.slice(0, 400)).catch(() => "");

    await page.waitForSelector(
      '.ij-OfferList-item, [class*="offer-card"], [class*="OfferCard"], article.offer, [class*="offerItem"]',
      { timeout: 20000 }
    ).catch(() => {});

    const cards = await page.$$(
      '.ij-OfferList-item, [class*="offer-card"], [class*="OfferCard"], article.offer, [class*="offerItem"]'
    );
    emit("progress", { message: `InfoJobs: ${cards.length} cards encontrados` });

    if (cards.length > 0) {
      const firstHtml = await cards[0].evaluate(el => el.outerHTML).catch(() => "");
    }

    for (const card of cards.slice(0, 15)) {
      try {
        const title = await card.evaluate(el => {
          const sels = ['h2 a', 'h3 a', 'a[class*="title" i]', 'a[class*="Title"]', '.ij-OfferList-item-title a', 'h2', 'h3'];
          for (const s of sels) { const n = el.querySelector(s); if (n?.innerText?.trim()) return n.innerText.trim(); }
          return "";
        }).catch(() => "");

        const company = await card.evaluate(el => {
          const sels = ['[class*="company" i]', '[class*="Company"]', '.ij-OfferList-item-company'];
          for (const s of sels) { const n = el.querySelector(s); if (n?.innerText?.trim()) return n.innerText.trim(); }
          return "";
        }).catch(() => "");

        const location = await card.evaluate(el => {
          const sels = ['[class*="location" i]', '[class*="Location"]', '[class*="city" i]'];
          for (const s of sels) { const n = el.querySelector(s); if (n?.innerText?.trim()) return n.innerText.trim(); }
          return "";
        }).catch(() => "");

        const link = await card.evaluate(el => {
          const a = el.querySelector("h2 a, h3 a, a[href*='vaga'], a[class*='title' i], a");
          return a?.href ?? "";
        }).catch(() => "");

        if (!title || !link) { emit("progress", { message: `InfoJobs: card sem título="${title}" link="${link.slice(0,60)}"` }); continue; }

        let description = "";
        const det = await page.context().newPage();
        try {
          await det.goto(link, { waitUntil: "domcontentloaded", timeout: 20000 });
          await humanDelay(800, 1500);
          description = await det.$eval(
            '.ij-OfferDetail-description, #offerBody, [class*="description" i], [class*="Description"]',
            (el) => el.innerText.trim()
          ).catch(() => "");
        } finally { await det.close(); }

        const jobId = `ij-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        jobs.push({ id: jobId, title, company, location, url: link, apply_url: link, site: "infojobs", description: description.slice(0, 3000) });
        emit("job_found", { id: jobId, title, company, site: "infojobs", location, url: link, description: description.slice(0, 300) });
      } catch (err) {
        emit("progress", { message: `InfoJobs: erro no card — ${err.message}` });
      }
      await humanDelay(400, 800);
    }
  } catch (err) {
    emit("progress", { message: `Erro InfoJobs: ${err.message}` });
  }
  return jobs;
}

export async function applyInfoJobs(page, pdfPath, _coverLetter) {
  await humanDelay(1000, 2000);
  if (await checkCaptcha(page)) return { success: false, captcha: true };
  const btn = await page.$('.ij-Button--apply, #candidatar-btn, [data-action="apply"], [class*="ApplyButton"]');
  if (!btn) return { success: false, reason: "Botão candidatar não encontrado no InfoJobs" };
  await btn.click();
  await humanDelay(2000, 3000);
  const confirmed = await waitForVisible(page, '.ij-application-success, .candidatura-enviada, [class*="success"]', 8000);
  return { success: confirmed, reason: confirmed ? undefined : "Confirmação InfoJobs não detectada" };
}
