// playwright/src/sites/catho.js
import { humanDelay, waitForVisible } from "../utils.js";
import { checkCaptcha } from "../captcha.js";

export async function searchCatho(page, query, emit) {
  const jobs = [];
  const encoded = encodeURIComponent(query);
  try {
    await page.goto(`https://www.catho.com.br/vagas/${encoded}/`, {
      waitUntil: "domcontentloaded", timeout: 30000
    });
    await humanDelay(1500, 2500);

    if (await checkCaptcha(page)) {
      emit("captcha_detected", { site: "catho" });
      return jobs;
    }

    const cards = await page.$$('[data-testid="job-card"], .sc-jqUVSM, [class*="JobCard"]');
    for (const card of cards.slice(0, 15)) {
      try {
        const title    = await card.$eval('h2, [data-testid="job-title"], [class*="title"]', el => el.innerText.trim()).catch(() => "");
        const company  = await card.$eval('[data-testid="company-name"], [class*="company"]', el => el.innerText.trim()).catch(() => "");
        const link     = await card.$eval('a', el => el.href).catch(() => "");
        const location = await card.$eval('[class*="location"], [data-testid="location"]', el => el.innerText.trim()).catch(() => "");
        if (!title || !link) continue;

        let description = "";
        const det = await page.context().newPage();
        try {
          await det.goto(link, { waitUntil: "domcontentloaded", timeout: 15000 });
          description = await det.$eval('[data-testid="job-description"], .job-description, [class*="Description"]', el => el.innerText.trim()).catch(() => "");
        } finally { await det.close(); }

        jobs.push({
          id: `ca-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
          title, company, location, url: link, apply_url: link,
          site: "catho",
          description: description.slice(0, 3000)
        });
        emit("job_found", { title, company, site: "catho", location });
      } catch {}
      await humanDelay(400, 800);
    }
  } catch (err) {
    emit("progress", { message: `Erro Catho: ${err.message}` });
  }
  return jobs;
}

export async function applyCatho(page, pdfPath, _coverLetter) {
  await humanDelay(1000, 2000);
  if (await checkCaptcha(page)) return { success: false, captcha: true };

  const btn = await page.$('[data-testid="apply-button"], button.apply-btn, [class*="apply"]');
  if (!btn) return { success: false, reason: "Botão candidatar não encontrado na Catho" };

  await btn.click();
  await humanDelay(2000, 3000);

  const confirmed = await waitForVisible(page, '[data-testid="apply-success"], .application-success', 8000);
  return { success: confirmed, reason: confirmed ? undefined : "Confirmação Catho não detectada" };
}
