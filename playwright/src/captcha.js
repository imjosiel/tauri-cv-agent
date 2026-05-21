// playwright/src/captcha.js

// Seletores e textos típicos de CAPTCHA nos principais sites
const CAPTCHA_SIGNALS = [
  // iframes de CAPTCHA
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  'iframe[src*="challenge"]',
  'iframe[src*="captcha"]',
  // divs comuns
  '.g-recaptcha',
  '#captcha',
  '[data-sitekey]',
  '.h-captcha',
  // Cloudflare challenge
  '#challenge-form',
  '#challenge-running',
  '.cf-browser-verification',
  // LinkedIn específico
  '.challenge-dialog',
  // Indeed específico
  '#challenge-page',
];

const CAPTCHA_TEXT_SIGNALS = [
  "prove you're not a robot",
  "prove you are human",
  "verificação de segurança",
  "security check",
  "verify you are human",
  "confirm you are not a bot",
  "i'm not a robot",
  "não sou um robô",
];

export async function checkCaptcha(page) {
  // 1. Verifica seletores visuais
  for (const sel of CAPTCHA_SIGNALS) {
    try {
      const el = await page.$(sel);
      if (el) return true;
    } catch {}
  }

  // 2. Verifica texto na página
  try {
    const bodyText = await page.evaluate(() =>
      document.body.innerText.toLowerCase()
    );
    if (CAPTCHA_TEXT_SIGNALS.some((t) => bodyText.includes(t))) return true;
  } catch {}

  // 3. Verifica URL de challenge
  const url = page.url().toLowerCase();
  if (
    url.includes("challenge") ||
    url.includes("captcha") ||
    url.includes("security-check") ||
    url.includes("checkpoint")
  ) {
    return true;
  }

  return false;
}

/**
 * Tenta esperar resolução manual do CAPTCHA por até 3 minutos.
 * Se stop_on_captcha=false, apenas registra e pula.
 */
export async function handleCaptcha(page, stopOnCaptcha) {
  if (stopOnCaptcha) {
    // Para tudo e aguarda resolução manual
    let resolved = false;
    for (let i = 0; i < 36; i++) {
      // 36 × 5s = 3 min
      await new Promise((r) => setTimeout(r, 5000));
      const stillHasCaptcha = await checkCaptcha(page);
      if (!stillHasCaptcha) {
        resolved = true;
        break;
      }
    }
    return resolved;
  }

  // Se não para, só retorna false para pular a vaga
  return false;
}
