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

    if (cards.length > 0) {
      const firstHtml = await cards[0].evaluate(el => el.outerHTML).catch(() => "");
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
          continue;
        }
        if (!title) continue;
        if (!link)  continue;

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

  // Indeed tem dois fluxos: Easy Apply (iframe apply.indeed.com) e redirecionamento externo
  // Tenta clicar no botão de candidatura com seletores atualizados
  const applySelectors = [
    // Seletores atuais do Indeed BR (2025/2026)
    'button[data-testid="IndeedApplyButton"]',
    'button[data-testid="indeedApplyButton"]',
    'a[data-testid="IndeedApplyButton"]',
    '#indeedApplyButton',
    '.jobsearch-IndeedApplyButton-newDesign',
    'button[class*="IndeedApply"]',
    'a[class*="IndeedApply"]',
    // Fallback: qualquer botão/link com texto de candidatura
    'button:has-text("Candidatar")',
    'button:has-text("Aplicar")',
    'a:has-text("Candidatar")',
    'a:has-text("Aplicar agora")',
  ];

  let btn = null;
  for (const sel of applySelectors) {
    btn = await page.$(sel).catch(() => null);
    if (btn) break;
  }

  // Fallback: procura botão por texto
  if (!btn) {
    const buttons = await page.$$("button, a");
    for (const b of buttons) {
      const txt = (await b.innerText().catch(() => "")).toLowerCase();
      if (txt.includes("candidatar") || txt.includes("aplicar") || txt.includes("apply")) {
        btn = b; break;
      }
    }
  }

  if (!btn) return { success: false, reason: "Botão Indeed não encontrado" };

  await btn.click();
  await humanDelay(2000, 3000);

  // Verifica se abriu iframe do Indeed Apply
  const frame = page.frames().find(f => f.url().includes("apply.indeed.com")) ?? page;

  const uploadInput = await frame.$('input[type="file"]').catch(() => null);
  if (uploadInput) await uploadFile(frame, 'input[type="file"]', pdfPath);
  await humanDelay(800, 1500);

  for (let i = 0; i < 10; i++) {
    if (await checkCaptcha(page)) return { success: false, captcha: true };

    const nextBtn = await frame.$(
      'button[type="submit"], button.ia-continueButton, button.ia-submitButton, ' +
      'button[data-testid="submit-button"], button[data-testid="continue-button"]'
    ).catch(() => null);
    if (!nextBtn) break;

    const txt = (await nextBtn.innerText().catch(() => "")).toLowerCase();
    await nextBtn.click();
    await humanDelay(1200, 2000);
    if (txt.includes("submit") || txt.includes("enviar") || txt.includes("confirmar")) {
      return { success: true };
    }
  }

  // Verifica confirmação na página
  const confirmed = await page.$('[data-testid="post-apply"], .ia-PostApply, [class*="PostApply"]')
    .catch(() => null);
  return confirmed
    ? { success: true }
    : { success: false, reason: "Fluxo Indeed não completado" };
}
