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
  if (await checkCaptcha(page).catch(() => false)) return { success: false, captcha: true };

  // Wrapper seguro: ignora erros de página fechada
  async function safe(fn) {
    try { return await fn(); } catch { return null; }
  }

  // Tenta clicar no botão de candidatura com seletores do Indeed BR 2025/2026
  const applySelectors = [
    'button[data-testid="IndeedApplyButton"]',
    'button[data-testid="indeedApplyButton"]',
    'a[data-testid="IndeedApplyButton"]',
    '#indeedApplyButton',
    '.jobsearch-IndeedApplyButton-newDesign',
    'button[class*="IndeedApply"]',
    'a[class*="IndeedApply"]',
    // Playwright locator por texto (mais robusto que seletor CSS)
    'button:has-text("Candidatar-se")',
    'button:has-text("Candidatar")',
    'button:has-text("Aplicar agora")',
    'a:has-text("Candidatar-se")',
    'a:has-text("Candidatar")',
  ];

  let btn = null;
  for (const sel of applySelectors) {
    btn = await safe(() => page.$(sel));
    if (btn) break;
  }

  if (!btn) return { success: false, reason: "Botão Indeed não encontrado" };

  await safe(() => btn.click());
  await humanDelay(2000, 3000);

  // Após clicar, o Indeed pode:
  // 1. Abrir um iframe apply.indeed.com na mesma página
  // 2. Redirecionar para apply.indeed.com
  // 3. Abrir uma nova aba
  // Tenta detectar qual fluxo foi aberto
  let applyPage = page;

  // Aguarda possível nova aba
  const newPagePromise = page.context().waitForEvent("page", { timeout: 3000 }).catch(() => null);
  const newTab = await newPagePromise;
  if (newTab) {
    await newTab.waitForLoadState("domcontentloaded").catch(() => {});
    applyPage = newTab;
  }

  // Verifica iframe
  const frame = applyPage.frames().find(f => f.url().includes("apply.indeed.com"))
    ?? (applyPage.url().includes("apply.indeed.com") ? applyPage.mainFrame() : null)
    ?? applyPage;

  const uploadInput = await safe(() => frame.$('input[type="file"]'));
  if (uploadInput) {
    await safe(() => uploadFile(frame, 'input[type="file"]', pdfPath));
    await humanDelay(800, 1500);
  }

  // Navega pelos passos do formulário
  for (let i = 0; i < 10; i++) {
    if (await safe(() => checkCaptcha(applyPage))) return { success: false, captcha: true };

    const nextBtn = await safe(() => frame.$(
      'button[type="submit"], button.ia-continueButton, button.ia-submitButton, ' +
      'button[data-testid="submit-button"], button[data-testid="continue-button"], ' +
      'button:has-text("Continuar"), button:has-text("Enviar"), button:has-text("Submit")'
    ));
    if (!nextBtn) break;

    const txt = (await safe(() => nextBtn.innerText()) ?? "").toLowerCase();
    await safe(() => nextBtn.click());
    await humanDelay(1200, 2000);
    if (txt.includes("submit") || txt.includes("enviar") || txt.includes("confirmar")) {
      return { success: true };
    }
  }

  // Verifica confirmação
  const confirmed = await safe(() => applyPage.$(
    '[data-testid="post-apply"], .ia-PostApply, [class*="PostApply"], ' +
    '[class*="confirmation"], [class*="success"]'
  ));
  return confirmed
    ? { success: true }
    : { success: false, reason: "Fluxo Indeed não completado" };
}
