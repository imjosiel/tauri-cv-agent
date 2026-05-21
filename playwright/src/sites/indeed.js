// playwright/src/sites/indeed.js
import { humanDelay, waitForVisible, uploadFile } from "../utils.js";
import { checkCaptcha } from "../captcha.js";

export async function searchIndeed(page, query, emit) {
  const jobs = [];
  const encoded = encodeURIComponent(query);
  try {
    await page.goto(`https://br.indeed.com/jobs?q=${encoded}&fromage=3`, {
      waitUntil: "domcontentloaded", timeout: 30000
    });
    await humanDelay(1500, 2500);

    if (await checkCaptcha(page)) {
      emit("captcha_detected", { site: "indeed" });
      return jobs;
    }

    const cards = await page.$$('.job_seen_beacon, .resultContent');
    for (const card of cards.slice(0, 15)) {
      try {
        const title   = await card.$eval('h2.jobTitle span, .jobTitle a span', el => el.innerText.trim()).catch(() => "");
        const company = await card.$eval('.companyName, [data-testid="company-name"]', el => el.innerText.trim()).catch(() => "");
        const link    = await card.$eval('h2.jobTitle a', el => el.href).catch(() => "");
        const location = await card.$eval('.companyLocation', el => el.innerText.trim()).catch(() => "");
        if (!title || !link) continue;

        let description = "";
        const det = await page.context().newPage();
        try {
          await det.goto(link, { waitUntil: "domcontentloaded", timeout: 15000 });
          await humanDelay(600, 1200);
          description = await det.$eval('#jobDescriptionText', el => el.innerText.trim()).catch(() => "");
        } finally { await det.close(); }

        jobs.push({
          id: `in-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
          title, company, location, url: link, apply_url: link,
          site: "indeed",
          description: description.slice(0, 3000)
        });
        emit("job_found", { title, company, site: "indeed", location });
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

  const btn = await page.$('#indeedApplyButton, .jobsearch-IndeedApplyButton-newDesign');
  if (!btn) return { success: false, reason: "Botão de candidatura não encontrado no Indeed" };

  await btn.click();
  await humanDelay(2000, 3000);

  const frame = page.frames().find(f => f.url().includes("apply.indeed.com")) ?? page;
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
