// playwright/src/sites/infojobs.js
import { humanDelay, waitForVisible } from "../utils.js";
import { checkCaptcha, handleCaptcha } from "../captcha.js";

export async function searchInfoJobs(page, query, emit, stopOnCaptcha = false) {
  const jobs = [];
  const encoded = encodeURIComponent(query);
  try {
    await page.goto(`https://www.infojobs.com.br/empregos.aspx?palabra=${encoded}`, {
      waitUntil: "domcontentloaded", timeout: 30000
    });
    await humanDelay(1500, 2500);

    if (await checkCaptcha(page)) {
      emit("captcha_detected", { site: "infojobs" });
      if (!stopOnCaptcha || !await handleCaptcha(page, stopOnCaptcha)) {
        return jobs;
      }
    }

    const cards = await page.$$('.ij-OfferList-item, .offer-list-item, [class*="OfferCard"]');
    for (const card of cards.slice(0, 15)) {
      try {
        const title    = await card.$eval('h2 a, .ij-OfferList-item-title a, [class*="title"] a', el => el.innerText.trim()).catch(() => "");
        const company  = await card.$eval('.ij-OfferList-item-company, .company, [class*="company"]', el => el.innerText.trim()).catch(() => "");
        const link     = await card.$eval('h2 a, a.title, [class*="title"] a', el => el.href).catch(() => "");
        const location = await card.$eval('[class*="location"], .location', el => el.innerText.trim()).catch(() => "");
        if (!title || !link) continue;

        let description = "";
        const det = await page.context().newPage();
        try {
          await det.goto(link, { waitUntil: "domcontentloaded", timeout: 15000 });
          description = await det.$eval('.ij-OfferDetail-description, #offerBody, [class*="description"]', el => el.innerText.trim()).catch(() => "");
        } finally { await det.close(); }

        jobs.push({
          id: `ij-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
          title, company, location, url: link, apply_url: link,
          site: "infojobs",
          description: description.slice(0, 3000)
        });
        emit("job_found", { title, company, site: "infojobs", location });
      } catch {}
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

  const btn = await page.$('.ij-Button--apply, #candidatar-btn, button[data-action="apply"]');
  if (!btn) return { success: false, reason: "Botão candidatar não encontrado no InfoJobs" };

  await btn.click();
  await humanDelay(2000, 3000);

  const confirmed = await waitForVisible(page, '.ij-application-success, .candidatura-enviada', 8000);
  return { success: confirmed, reason: confirmed ? undefined : "Confirmação InfoJobs não detectada" };
}
