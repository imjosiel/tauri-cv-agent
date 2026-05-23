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

    // Aguarda carregamento real — importante para o Cloudflare
    await humanDelay(3000, 5000);

    // Verifica se caiu no Cloudflare ou precisa de login
    const currentUrl = page.url();
    if (currentUrl.includes("checkpoint") || currentUrl.includes("challenge")) {
      emit("captcha_detected", { site: "linkedin", url: currentUrl });
      if (!stopOnCaptcha || !await handleCaptcha(page, stopOnCaptcha)) {
        return jobs;
      }
      emit("progress", { message: "LinkedIn: CAPTCHA resolvido. Retomando busca..." });
    }

    if (currentUrl.includes("login") || currentUrl.includes("authwall")) {
      emit("progress", { message: "LinkedIn: faça login manualmente no navegador que abriu" });
      await page.waitForURL(/linkedin\.com\/jobs/, { timeout: 120000 }).catch(() => {});
    }

    if (await checkCaptcha(page)) {
      emit("captcha_detected", { site: "linkedin" });
      if (!stopOnCaptcha || !await handleCaptcha(page, stopOnCaptcha)) {
        return jobs;
      }
      emit("progress", { message: "LinkedIn: CAPTCHA resolvido. Retomando busca..." });
    }

    await page.waitForSelector(
      ".jobs-search-results__list, .jobs-search-results__list-item, .job-search-card, [data-occludable-job-id]",
      { timeout: 45000 }
    ).catch(() => {});

    // Tenta extrair a lista de vagas diretamente do DOM
    const rawJobs = await page.$$eval(
      'li.jobs-search-results__list-item, .job-search-card, [data-occludable-job-id]',
      (cards) => cards.slice(0, 15).map((card) => {
        const title = (card.querySelector('.job-search-card__title, .job-card-list__title, h3')?.textContent || "").trim();
        const company = (card.querySelector('.job-search-card__company-name, .job-card-container__company-name, .job-card__company-name')?.textContent || "").trim();
        const location = (card.querySelector('.job-search-card__location, .job-card-container__metadata-item, .job-card-list__location')?.textContent || "").trim();
        const linkEl = card.querySelector('a.job-search-card__title-link, a.job-card-list__title--link, a[href*="/jobs/view/"]');
        const link = linkEl instanceof HTMLAnchorElement ? linkEl.href : "";
        return { title, company, location, link };
      })
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

      jobs.push({
        id: `li-${uid()}`,
        title,
        company,
        location,
        url: link,
        apply_url: link,
        site: "linkedin",
        description: description.slice(0, 3000),
      });

      emit("job_found", { title, company, site: "linkedin", location, id: jobs[jobs.length - 1].id, url: link, description });
      await humanDelay(800, 1500);
    }
  } catch (err) {
    emit("progress", { message: `Erro LinkedIn: ${err.message}` });
  }

  return jobs;
}

export async function applyLinkedIn(page, pdfPath, coverLetter) {
  await humanDelay(1000, 2000);

  // Botão "Candidatura simplificada" (Easy Apply)
  const easyApplyBtn = await page.$('[data-control-name="jobdetails_topcard_inapply"], .jobs-apply-button--top-card button');
  if (!easyApplyBtn) {
    return { success: false, reason: "Botão Easy Apply não encontrado — vaga redireciona para site externo" };
  }

  await humanClick(page, '[data-control-name="jobdetails_topcard_inapply"], .jobs-apply-button--top-card button');
  await humanDelay(1500, 2500);

  if (await checkCaptcha(page)) {
    return { success: false, captcha: true };
  }

  // Fluxo multi-step do Easy Apply
  let step = 0;
  while (step < 10) {
    step++;
    await humanDelay(800, 1500);

    // Upload de currículo se houver campo
    const uploadInput = await page.$('input[type="file"]');
    if (uploadInput) {
      await uploadFile(page, 'input[type="file"]', pdfPath);
      await humanDelay(1000, 2000);
    }

    // Cover letter se houver textarea
    if (coverLetter) {
      const textareas = await page.$$('textarea');
      for (const ta of textareas) {
        const placeholder = await ta.getAttribute("placeholder") ?? "";
        if (placeholder.toLowerCase().includes("cover") ||
            placeholder.toLowerCase().includes("carta") ||
            placeholder.toLowerCase().includes("apresenta")) {
          await ta.click();
          await humanDelay(200, 400);
          await ta.fill(coverLetter);
          await humanDelay(400, 800);
        }
      }
    }

    // Verifica CAPTCHA em cada passo
    if (await checkCaptcha(page)) {
      return { success: false, captcha: true };
    }

    // Botão de próximo passo ou submissão
    const nextBtn = await page.$(
      'button[aria-label="Continue to next step"], ' +
      'button[aria-label="Submit application"], ' +
      'button[aria-label="Review your application"], ' +
      '.artdeco-button--primary'
    );

    if (!nextBtn) break;

    const btnText = (await nextBtn.innerText()).toLowerCase();
    await humanClick(page, '.artdeco-button--primary');
    await humanDelay(1000, 2000);

    if (btnText.includes("submit") || btnText.includes("enviar")) {
      // Candidatura enviada!
      await humanDelay(2000, 3000);
      return { success: true };
    }
  }

  // Verifica se chegamos na tela de confirmação
  const confirmed = await waitForVisible(page, '.jobs-post-apply-confirmation, [data-test-id="confirmation"]', 5000);
  return { success: confirmed, reason: confirmed ? undefined : "Fluxo de candidatura incompleto" };
}
