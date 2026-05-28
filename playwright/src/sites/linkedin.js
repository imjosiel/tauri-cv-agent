// playwright/src/sites/linkedin.js
import { humanDelay, humanClick, waitForVisible, uploadFile, randomBetween } from "../utils.js";
import { checkCaptcha, handleCaptcha } from "../captcha.js";

const uid = () => crypto.randomUUID().slice(0, 8);
const BASE_URL = "https://www.linkedin.com";

export async function searchLinkedIn(page, query, emit, stopOnCaptcha = false) {
  const jobs = [];
  const encoded = encodeURIComponent(query);
  const url = `${BASE_URL}/jobs/search/?keywords=${encoded}&location=Brasil&f_TPR=r86400&sortBy=DD`;

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 40000 });
    await humanDelay(3000, 5000);

    const currentUrl = page.url();

    // Authwall — pede login mas não é CAPTCHA; aguarda o usuário logar
    if (currentUrl.includes("authwall") || currentUrl.includes("login") || currentUrl.includes("uas/login")) {
      emit("progress", { message: "LinkedIn: faça login no navegador que abriu (aguardando até 3 min)..." });
      try {
        await page.waitForURL((u) => u.includes("linkedin.com/jobs"), { timeout: 180000 });
        await humanDelay(2000, 3000);
      } catch {
        emit("progress", { message: "LinkedIn: login não detectado, pulando." });
        return jobs;
      }
    }

    // Checkpoint / challenge real (CAPTCHA)
    if (page.url().includes("checkpoint") || page.url().includes("challenge")) {
      emit("captcha_detected", { site: "linkedin", url: page.url() });
      if (!stopOnCaptcha || !await handleCaptcha(page, stopOnCaptcha)) return jobs;
      emit("progress", { message: "LinkedIn: CAPTCHA resolvido. Retomando busca..." });
    }

    if (await checkCaptcha(page)) {
      emit("captcha_detected", { site: "linkedin" });
      if (!stopOnCaptcha || !await handleCaptcha(page, stopOnCaptcha)) return jobs;
    }

    // Aguarda lista de vagas — seletores para usuário logado e guest
    await page.waitForSelector(
      [
        ".jobs-search-results__list-item",
        ".job-search-card",
        "[data-occludable-job-id]",
        ".base-card",
        ".base-search-card",
      ].join(", "),
      { timeout: 45000 }
    ).catch(() => {});

    // Extrai cards — suporta DOM logado e DOM público
    const rawJobs = await page.$$eval(
      [
        "li.jobs-search-results__list-item",
        ".job-search-card",
        "[data-occludable-job-id]",
        ".base-card--link",
      ].join(", "),
      (cards) => {
        const seen = new Set();
        return cards.slice(0, 20).reduce((acc, card) => {
          const title = (
            card.querySelector(".job-search-card__title, .job-card-list__title, .base-search-card__title, h3") || {}
          ).textContent?.trim() ?? "";
          const company = (
            card.querySelector(".job-search-card__company-name, .job-card-container__company-name, .base-search-card__subtitle, h4") || {}
          ).textContent?.trim() ?? "";
          const location = (
            card.querySelector(".job-search-card__location, .job-card-container__metadata-item, .job-search-card__location") || {}
          ).textContent?.trim() ?? "";
          const linkEl = card.querySelector("a.job-search-card__title-link, a.job-card-list__title--link, a[href*='/jobs/view/'], a.base-card__full-link");
          const link = linkEl?.href ?? "";
          if (!title || !link || seen.has(link)) return acc;
          seen.add(link);
          acc.push({ title, company, location, link });
          return acc;
        }, []);
      }
    ).catch(() => []);

    emit("progress", { message: `LinkedIn: ${rawJobs.length} cards extraídos` });

    for (const rawJob of rawJobs) {
      const { title, company, location, link } = rawJob;
      if (!title || !link) continue;

      let description = "";
      const detail = await page.context().newPage();
      try {
        await detail.goto(link, { waitUntil: "domcontentloaded", timeout: 30000 });
        await humanDelay(1200, 2000);
        if (await checkCaptcha(detail)) {
          emit("captcha_detected", { site: "linkedin" });
          if (!stopOnCaptcha || !await handleCaptcha(detail, stopOnCaptcha)) {
            await detail.close();
            continue;
          }
        }
        description = await detail.$eval(
          ".jobs-description__content, .description__text, #job-details, .show-more-less-html__markup",
          (el) => el.innerText.trim()
        ).catch(() => "");
      } catch {
      } finally {
        await detail.close();
      }

      const id = `li-${uid()}`;
      jobs.push({ id, title, company, location, url: link, apply_url: link, site: "linkedin", description: description.slice(0, 3000) });
      emit("job_found", { id, title, company, site: "linkedin", location, url: link, description: description.slice(0, 300) });
      await humanDelay(800, 1500);
    }
  } catch (err) {
    emit("progress", { message: `Erro LinkedIn: ${err.message}` });
  }

  return jobs;
}

export async function applyLinkedIn(page, pdfPath, coverLetter) {
  await humanDelay(1000, 2000);
  const easyApplyBtn = await page.$('[data-control-name="jobdetails_topcard_inapply"], .jobs-apply-button--top-card button');
  if (!easyApplyBtn) return { success: false, reason: "Botão Easy Apply não encontrado" };

  await humanClick(page, '[data-control-name="jobdetails_topcard_inapply"], .jobs-apply-button--top-card button');
  await humanDelay(1500, 2500);
  if (await checkCaptcha(page)) return { success: false, captcha: true };

  let step = 0;
  while (step < 10) {
    step++;
    await humanDelay(800, 1500);
    const uploadInput = await page.$('input[type="file"]');
    if (uploadInput) { await uploadFile(page, 'input[type="file"]', pdfPath); await humanDelay(1000, 2000); }

    if (coverLetter) {
      for (const ta of await page.$$("textarea")) {
        const ph = (await ta.getAttribute("placeholder") ?? "").toLowerCase();
        if (ph.includes("cover") || ph.includes("carta") || ph.includes("apresenta")) {
          await ta.click(); await humanDelay(200, 400); await ta.fill(coverLetter); await humanDelay(400, 800);
        }
      }
    }
    if (await checkCaptcha(page)) return { success: false, captcha: true };

    const nextBtn = await page.$('button[aria-label="Continue to next step"], button[aria-label="Submit application"], button[aria-label="Review your application"], .artdeco-button--primary');
    if (!nextBtn) break;
    const btnText = (await nextBtn.innerText()).toLowerCase();
    await humanClick(page, ".artdeco-button--primary");
    await humanDelay(1000, 2000);
    if (btnText.includes("submit") || btnText.includes("enviar")) { await humanDelay(2000, 3000); return { success: true }; }
  }

  const confirmed = await waitForVisible(page, ".jobs-post-apply-confirmation, [data-test-id=\"confirmation\"]", 5000);
  return { success: confirmed, reason: confirmed ? undefined : "Fluxo incompleto" };
}
