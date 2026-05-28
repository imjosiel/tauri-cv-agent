// playwright/src/sites/indeed.js
import { humanDelay, waitForVisible, uploadFile } from "../utils.js";
import { checkCaptcha, handleCaptcha } from "../captcha.js";

export async function searchIndeed(page, query, emit, stopOnCaptcha = false) {
  const jobs = [];
  const encoded = encodeURIComponent(query);
  try {
    // fromage=3 → últimos 3 dias; l=Brasil filtra localidade
    await page.goto(`https://br.indeed.com/jobs?q=${encoded}&l=Brasil&fromage=3`, {
      waitUntil: "domcontentloaded", timeout: 30000
    });
    await humanDelay(2000, 3500);

    if (await checkCaptcha(page)) {
      emit("captcha_detected", { site: "indeed" });
      if (!stopOnCaptcha || !await handleCaptcha(page, stopOnCaptcha)) return jobs;
    }

    // Aguarda qualquer card aparecer
    await page.waitForSelector(
      '.job_seen_beacon, .resultContent, [data-testid="slider_item"], td.resultContent',
      { timeout: 20000 }
    ).catch(() => {});

    const cards = await page.$$(
      '.job_seen_beacon, [data-testid="slider_item"], td.resultContent'
    );
    emit("progress", { message: `Indeed: ${cards.length} cards encontrados` });

    for (const card of cards.slice(0, 15)) {
      try {
        const title = await card.$eval(
          'h2.jobTitle span[title], h2.jobTitle span, [data-testid="jobsearch-JobInfoHeader-title"] span',
          (el) => el.innerText.trim()
        ).catch(() => "");
        const company = await card.$eval(
          '[data-testid="company-name"], .companyName, span.companyName',
          (el) => el.innerText.trim()
        ).catch(() => "");
        const location = await card.$eval(
          '[data-testid="text-location"], .companyLocation',
          (el) => el.innerText.trim()
        ).catch(() => "");
        const link = await card.$eval(
          'h2.jobTitle a, a.jcs-JobTitle',
          (el) => el.href
        ).catch(() => "");

        if (!title || !link) continue;

        // Normaliza URL do Indeed
        const fullLink = link.startsWith("http") ? link : `https://br.indeed.com${link}`;

        let description = "";
        const det = await page.context().newPage();
        try {
          await det.goto(fullLink, { waitUntil: "domcontentloaded", timeout: 20000 });
          await humanDelay(800, 1500);
          description = await det.$eval(
            '#jobDescriptionText, [data-testid="jobsearch-JobComponent-description"]',
            (el) => el.innerText.trim()
          ).catch(() => "");
        } finally { await det.close(); }

        const jobId = `in-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        jobs.push({ id: jobId, title, company, location, url: fullLink, apply_url: fullLink, site: "indeed", description: description.slice(0, 3000) });
        emit("job_found", { id: jobId, title, company, site: "indeed", location, url: fullLink, description: description.slice(0, 300) });
      } catch {}
      await humanDelay(300, 700);
    }
  } catch (err) {
    emit("progress", { message: `Erro Indeed: ${err.message}` });
  }
  return jobs;
}

export async function applyIndeed(page, pdfPath, coverLetter) {
  await humanDelay(1000, 2000);
  if (await checkCaptcha(page)) return { success: false, captcha: true };
  const btn = await page.$("#indeedApplyButton, .jobsearch-IndeedApplyButton-newDesign, [data-testid='indeedApplyButton']");
  if (!btn) return { success: false, reason: "Botão Indeed não encontrado" };
  await btn.click();
  await humanDelay(2000, 3000);
  const frame = page.frames().find((f) => f.url().includes("apply.indeed.com")) ?? page;
  const uploadInput = await frame.$('input[type="file"]');
  if (uploadInput) await uploadFile(frame, 'input[type="file"]', pdfPath);
  await humanDelay(800, 1500);
  for (let i = 0; i < 8; i++) {
    if (await checkCaptcha(page)) return { success: false, captcha: true };
    const btn2 = await frame.$('button[type="submit"], button.ia-continueButton, button.ia-submitButton');
    if (!btn2) break;
    const txt = (await btn2.innerText()).toLowerCase();
    await btn2.click();
    await humanDelay(1200, 2000);
    if (txt.includes("submit") || txt.includes("enviar")) return { success: true };
  }
  return { success: false, reason: "Fluxo Indeed não completado" };
}
