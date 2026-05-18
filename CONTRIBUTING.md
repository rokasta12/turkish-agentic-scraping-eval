# Contributing

Keep this project boring and safe.

Before a PR:

```bash
npm ci
npx playwright install chromium
npm run typecheck
npm run eval
npm run discover:tr
```

Rules:

- Add tests for new discovery logic.
- Keep examples on public/test websites.
- Do not add private data, credentials, cookies, tokens, or authenticated sessions.
- Do not add CAPTCHA bypass, stealth bypass, paywall bypass, or aggressive scraping code.
- Keep output schema validated with Zod.
- Keep provenance fields for extracted facts.
