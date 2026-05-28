// playwright/src/sites/catho.js
import { humanDelay, waitForVisible } from "../utils.js";
import { checkCaptcha, handleCaptcha } from "../captcha.js";

export async function searchCatho(page, query, emit, stopOnCaptcha = false) {
  const jobs = [];
  const encoded = encodeURIComponent(query);
  try {
    // URL correta da Catho: query param "q", não path segment
    await page.goto(`https://www.catho.com.br/vagas/?q=${encoded}&periodo=1`, {
      waitUntil: "domcontentloaded", timeout: 30000
    });
    await humanDelay(2000, 3500);

    if (await checkCaptcha(page)) {
      emit("captcha_detected", { site: "catho" });
      if (!stopOnCaptcha || !await handleCaptcha(page, stopOnCaptcha)) return jobs;
    }

    // Aguarda cards
    await page.waitForSelector(
      '[data-testid="job-card"], article[data-id], [class*="JobCard_jobCard"]',
      { timeout: 20000 }
    ).catch(() => {});

    const cards = await page.$$(
      '[data-testid="job-card"], article[data-id], [class*="JobCard_jobCard"], [class*="jobCard"]'
    );
    emit("progress", { message: `Catho: ${cards.length} cards encontrados` });

    for (const card of cards.slice(0, 15)) {
      try {
        const title = await card.$eval(
          'h2, [data-testid="job-title"], [class*="JobTitle"], [class*="title"]',
          (el) => el.innerText.trim()
        ).catch(() => "");
        const company = await card.$eval(
          '[data-testid="company-name"], [class*="CompanyName"], [class*="company"]',
          (el) => el.innerText.trim()
        ).catch(() => "");
        const location = await card.$eval(
          '[data-testid="location"], [class*="Location"], [class*="location"]',
          (el) => el.innerText.trim()
        ).catch(() => "");
        const link = await card.$eval("a", (el) => el.href).catch(() => "");
        if (!title || !link) continue;

        let description = "";
        const det = await page.context().newPage();
        try {
          await det.goto(link, { waitUntil: "domcontentloaded", timeout: 20000 });
          await humanDelay(800, 1500);
          description = await det.$eval(
            '[data-testid="job-description"], [class*="Description"], [class*="description"], .job-description',
            (el) => el.innerText.trim()
          ).catch(() => "");
        } finally { await det.close(); }

        const jobId = `ca-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        jobs.push({ id: jobId, title, company, location, url: link, apply_url: link, site: "catho", description: description.slice(0, 3000) });
        emit("job_found", { id: jobId, title, company, site: "catho", location, url: link, description: description.slice(0, 300) });
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
  const btn = await page.$('[data-testid="apply-button"], [class*="ApplyButton"], button[class*="apply"]');
  if (!btn) return { success: false, reason: "Botão candidatar não encontrado na Catho" };
  await btn.click();
  await humanDelay(2000, 3000);
  const confirmed = await waitForVisible(page, '[data-testid="apply-success"], [class*="success"], .application-success', 8000);
  return { success: confirmed, reason: confirmed ? undefined : "Confirmação Catho não detectada" };
}
