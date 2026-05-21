// playwright/src/args.js
export function parseArgs(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i !== -1 ? argv[i + 1] : null;
  };

  const query = get("--query") ?? "desenvolvedor";
  const configRaw = get("--config") ?? "{}";

  let config;
  try {
    config = JSON.parse(configRaw);
  } catch {
    config = {};
  }

  return {
    query,
    config: {
      mode: config.mode ?? "autonomous",
      min_score: config.min_score ?? 70,
      max_per_night: config.max_per_night ?? 12,
      delay_minutes: config.delay_minutes ?? 7,
      cover_letter: config.cover_letter ?? true,
      stop_on_captcha: config.stop_on_captcha ?? false,
      blacklist: config.blacklist ?? [],
      sites: config.sites ?? ["linkedin", "indeed", "catho", "infojobs"],
    },
  };
}
