// playwright/src/utils.js

/** Delay com variação aleatória para simular comportamento humano */
export function humanDelay(minMs = 300, maxMs) {
  const ms = maxMs != null ? randomBetween(minMs, maxMs) : minMs;
  return new Promise((r) => setTimeout(r, ms));
}

export function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Digita texto letra por letra com velocidade variável
 * (simula digitação humana — erros ocasionais podem ser adicionados)
 */
export async function humanType(page, selector, text) {
  await page.click(selector);
  await humanDelay(200, 500);

  for (const char of text) {
    await page.keyboard.type(char, { delay: randomBetween(40, 140) });
    // Pausa ocasional (como se o usuário pensasse)
    if (Math.random() < 0.05) await humanDelay(300, 800);
  }
}

/**
 * Clica com movimento de mouse curvilíneo antes do clique
 */
export async function humanClick(page, selector) {
  const el = await page.$(selector);
  if (!el) throw new Error(`Elemento não encontrado: ${selector}`);

  const box = await el.boundingBox();
  if (!box) throw new Error(`Elemento sem bounding box: ${selector}`);

  // Ponto alvo com leve offset aleatório dentro do elemento
  const targetX = box.x + box.width * randomBetween(30, 70) / 100;
  const targetY = box.y + box.height * randomBetween(30, 70) / 100;

  // Movimento suave em múltiplos steps
  const steps = randomBetween(8, 20);
  await page.mouse.move(targetX, targetY, { steps });
  await humanDelay(80, 200);
  await page.mouse.click(targetX, targetY);
}

/**
 * Scroll suave para um elemento, garantindo que está visível
 */
export async function scrollIntoView(page, selector) {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, selector);
  await humanDelay(400, 800);
}

/**
 * Aguarda elemento aparecer com timeout customizado
 */
export async function waitForVisible(page, selector, timeout = 10000) {
  try {
    await page.waitForSelector(selector, { state: "visible", timeout });
    return true;
  } catch {
    return false;
  }
}

/**
 * Tenta múltiplos seletores e retorna o primeiro que existir
 */
export async function findFirst(page, selectors) {
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) return { el, selector: sel };
    } catch {}
  }
  return null;
}

/**
 * Upload de arquivo de forma segura
 */
export async function uploadFile(page, inputSelector, filePath) {
  const fileInput = await page.$(inputSelector);
  if (!fileInput) throw new Error(`Input de arquivo não encontrado: ${inputSelector}`);
  await fileInput.setInputFiles(filePath);
  await humanDelay(500, 1200);
}
