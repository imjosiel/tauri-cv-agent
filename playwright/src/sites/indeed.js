// playwright/src/sites/indeed.js
import { humanDelay, waitForVisible, uploadFile } from "../utils.js";
import { checkCaptcha, handleCaptcha } from "../captcha.js";

export async function searchIndeed(page, query, emit, stopOnCaptcha = false) {
  const jobs = [];
  const encoded = encodeURIComponent(query);
  try {
    await page.goto(`https://br.indeed.com/jobs?q=${encoded}&l=Brasil&fromage=3`, {
      waitUntil: "domcontentloaded", timeout: 30000
    });
    await humanDelay(2000, 3500);

    if (await checkCaptcha(page)) {
      emit("captcha_detected", { site: "indeed" });
      if (!stopOnCaptcha || !await handleCaptcha(page, stopOnCaptcha)) return jobs;
    }

    await page.waitForSelector(
      '.job_seen_beacon, .resultContent, [data-testid="slider_item"], td.resultContent',
      { timeout: 20000 }
    ).catch(() => {});

    const cards = await page.$$(
      '.job_seen_beacon, [data-testid="slider_item"], td.resultContent'
    );
    emit("progress", { message: `Indeed: ${cards.length} cards encontrados` });

    // Diagnóstico: loga o HTML do primeiro card para identificar seletores reais
    if (cards.length > 0) {
      const firstHtml = await cards[0].evaluate(el => el.outerHTML).catch(() => "");
      emit("progress", { message: `Indeed DEBUG primeiro card (500 chars): ${firstHtml.slice(0, 500)}` });
    }

    for (const card of cards.slice(0, 15)) {
      try {
        // Tenta vários seletores de título progressivamente
        const title = await card.evaluate(el => {
          const selectors = [
            'h2.jobTitle span[title]',
            'h2.jobTitle span',
            'h2 span[title]',
            'h2 a span',
            '[data-testid="jobsearch-JobInfoHeader-title"] span',
            '[class*="jobTitle"] span',
            '[class*="JobTitle"] span',
            'h2',
          ];
          for (const sel of selectors) {
            const node = el.querySelector(sel);
            if (node && node.innerText.trim()) return node.innerText.trim();
          }
          return "";
        }).catch(() => "");

        const company = await card.evaluate(el => {
          const selectors = [
            '[data-testid="company-name"]',
            '.companyName',
            'span.companyName',
            '[class*="companyName"]',
            '[class*="company"]',
          ];
          for (const sel of selectors) {
            const node = el.querySelector(sel);
            if (node && node.innerText.trim()) return node.innerText.trim();
          }
          return "";
        }).catch(() => "");

        const location = await card.evaluate(el => {
          const selectors = [
            '[data-testid="text-location"]',
            '.companyLocation',
            '[class*="companyLocation"]',
            '[class*="location"]',
          ];
          for (const sel of selectors) {
            const node = el.querySelector(sel);
            if (node && node.innerText.trim()) return node.innerText.trim();
          }
          return "";
        }).catch(() => "");

        // Tenta vários seletores de link
        const link = await card.evaluate(el => {
          const selectors = [
            'h2.jobTitle a',
            'a.jcs-JobTitle',
            'h2 a',
            '[class*="jobTitle"] a',
            'a[data-jk]',
            'a[id^="job_"]',
            'a[href*="/rc/clk"]',
            'a[href*="/pagead"]',
            'a',
          ];
          for (const sel of selectors) {
            const node = el.querySelector(sel);
            if (node && node.href) return node.href;
          }
          return "";
        }).catch(() => "");

        if (!title && !link) {
          emit("progress", { message: `Indeed: card sem título e sem link, pulando` });
          continue;
        }
        if (!title) { emit("progress", { message: `Indeed: sem título (link=${link.slice(0,60)})` }); continue; }
        if (!link)  { emit("progress", { message: `Indeed: sem link (título=${title})` }); continue; }

        const fullLink = link.startsWith("http") ? link : `https://br.indeed.com${link}`;

        let description = "";
        const det = await page.context().newPage();
        try {
          await det.goto(fullLink, { waitUntil: "domcontentloaded", timeout: 20000 });
          await humanDelay(800, 1500);
          description = await det.$eval(
            '#jobDescriptionText, [data-testid="jobsearch-JobComponent-description"], [class*="jobDescription"]',
            (el) => el.innerText.trim()
          ).catch(() => "");
        } finally { await det.close(); }

        const jobId = `in-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        jobs.push({ id: jobId, title, company, location, url: fullLink, apply_url: fullLink, site: "indeed", description: description.slice(0, 3000) });
        emit("job_found", { id: jobId, title, company, site: "indeed", location, url: fullLink, description: description.slice(0, 300) });
      } catch (err) {
        emit("progress", { message: `Indeed: erro no card — ${err.message}` });
      }
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
