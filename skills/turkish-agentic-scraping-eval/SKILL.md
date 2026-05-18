---
name: turkish-agentic-scraping-eval
description: Run safe autonomous Turkish web discovery and agentic scraping evals.
version: 0.1.0
author: Bedirhan Celayir + Hermes Agent
license: MIT
platforms: [macos, linux]
metadata:
  hermes:
    tags: [scraping, browser-automation, agentic-browser, turkish-web, evaluation]
---

# Turkish Agentic Scraping Eval

Use this skill when Bedirhan wants to test or improve the Turkish Agentic Scraping Eval repo, discover Turkish websites, compare browser-agent scraping approaches, or run a safe nonstop scraping evaluation loop.

Default project path:

```text
/Users/blafkfungus/browser-agentic-scraping-eval
```

## Core idea

Do not let a browser agent freely roam.

Use this order:

1. robots.txt check
2. sitemap/RSS discovery
3. HTTP/static HTML fetch
4. Cheerio/JSDOM metadata extraction
5. Playwright only if HTTP is insufficient
6. network JSON endpoint discovery
7. HTTP replay when safe
8. Zod schema validation
9. provenance and raw artifact storage
10. safety report and improvement suggestions

## Commands

```bash
cd /Users/blafkfungus/browser-agentic-scraping-eval
npm ci
npx playwright install chromium
npm run typecheck
npm run eval
npm run discover:tr
```

Full check:

```bash
npm test
```

Outputs:

```text
reports/eval-results.md
reports/eval-results.json
reports/github-landscape.json
reports/discovery/tr-discovery-summary.md
reports/discovery/tr-discovery-results.jsonl
```

## Safety rules

Always enforce:

- public unauthenticated pages only
- robots.txt respected
- host allowlist respected
- conservative rate limits
- metadata-only by default
- no personal data extraction
- no login
- no account creation
- no form submit
- no payment
- no cart/buy action
- no delete/post/public mutation action
- no CAPTCHA bypass
- no stealth/bot-defense bypass
- no authenticated browser profiles

Blocked actions:

```text
BUY
SUBMIT_PAYMENT
DELETE
POST_PUBLICLY
ACCEPT_LEGAL_TERMS
BYPASS_CAPTCHA
LOGIN
REGISTER
FORM_SUBMIT
```

If any blocked action appears, stop that domain/path and report it.

## Nonstop loop behavior

For a scheduled or repeated run:

1. Run `npm run typecheck`.
2. Run `npm run eval`.
3. Run `npm run discover:tr`.
4. Read JSON/Markdown reports.
5. If fail > 0, inspect root cause before changing code.
6. If warn > 0, classify as license, safety, network, schema, or data quality risk.
7. Suggest a small patch or new test.
8. Do not widen crawl scope automatically.
9. Do not add aggressive targets automatically.
10. Keep reports concise.

## Turkish web discovery scoring

Useful signals:

- `.tr` domain
- `html lang=tr` or `tr-TR`
- Turkish characters: ç, ğ, ı, İ, ö, ş, ü
- Turkish stopwords
- sitemap/RSS availability
- public institutional/news/education content
- schema.org metadata
- internal link richness

Agent score should reward:

- robots compliance
- low request count per useful discovery
- low duplicate URL ratio
- high Turkish relevance
- high schema/provenance completeness
- low browser usage ratio
- low error rate

Agent score should punish:

- robots violation
- forbidden action attempt
- login/captcha/paywall touch
- high 403/429 rate
- repeated duplicate crawling
- collecting unnecessary raw/private data

## When improving code

Use tiny patches.

Good improvements:

- add a fixture
- add a Zod field
- improve robots handling
- improve URL normalization
- improve Turkish scoring
- improve report clarity
- add a safer seed
- add a better stop condition

Bad improvements:

- stealth mode
- residential proxy mode
- CAPTCHA solving
- login/session reuse
- high concurrency
- unbounded BFS
- broad form submission
- collecting full pages without reason

## Final response format

Keep it plain:

```text
Done.
Pass: N
Warn: N
Fail: N
Discovery records: N
Files:
- path
- path
Main finding:
- short bullets
Next best step:
- one concrete command or patch
```
