# Turkish Agentic Scraping Eval

Executable TypeScript eval harness for safe agentic browser scraping research.

This repo tests a simple idea:

Do not let an agent click random web pages forever.
Use a safe, layered system:

1. Check robots.txt.
2. Try HTTP/static HTML first.
3. Use browser only when needed.
4. Extract metadata into a schema.
5. Keep provenance and raw artifacts.
6. Block login, payment, delete, posting, CAPTCHA bypass, and off-host jumps.
7. Score each run and improve the runner from failures.

## Status

Research/evaluation harness.
Not a production crawler.

## What it does

Current checks:

- Verifies open-source browser/scraping repo metadata from GitHub.
- Tests HTTP-first static extraction.
- Tests Playwright network discovery and HTTP replay.
- Tests raw artifact preservation with Readability cleanup.
- Tests structured extraction with Zod and source quotes.
- Tests bounded browser-agent guardrails.
- Tests robust browser primitives: scroll before click, native input setter.
- Runs a conservative Turkish website metadata discovery pass.
- Builds a bounded same-domain frontier queue without fetching extra pages by default.
- Records fetch attempts and tries safe sitemap/RSS fallback URLs when the homepage times out.
- Tracks per-domain page budget and a simple safe-agent score.

## Requirements

- Node.js 20+
- npm
- Playwright Chromium

## Install

```bash
npm ci
npx playwright install chromium
```

Linux CI:

```bash
npx playwright install --with-deps chromium
```

## Run

```bash
npm run typecheck
npm run eval
npm run discover:tr
npm run db:check
```

Full local check:

```bash
npm test
```

## Scripts

- `npm run typecheck` — TypeScript type check.
- `npm run eval` — run executable research evals.
- `npm run discover:tr` — run safe Turkish website metadata discovery.
- `npm run db:check` — ingest latest reports into a local SQLite health database, print run health metrics including average quality/safe-agent scores, and fail on unsafe/failing state.
- `npm test` — typecheck + eval + discovery + database check.

## Generated outputs

The scripts write generated files under `reports/`.
Those files are ignored by git by default.

Important files after a run:

```text
reports/eval-results.md
reports/eval-results.json
reports/github-landscape.json
reports/discovery/tr-discovery-summary.md
reports/discovery/tr-discovery-results.jsonl
reports/state/eval.sqlite
```

## Safety policy

Default rules:

- Respect robots.txt.
- No login.
- No account creation.
- No form submit.
- No payment.
- No buy/cart actions.
- No delete/post/public mutation actions.
- No CAPTCHA bypass.
- No authenticated sessions.
- No personal data extraction.
- Conservative rate limits.
- Metadata-only by default.

Allowed action shape:

```text
GET robots.txt
GET sitemap.xml
GET public page
passive metadata extract
browser goto only when needed
passive scroll only when needed
```

Blocked action shape:

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

## Turkish discovery mode

The first Turkish discovery runner is deliberately small and conservative.
It checks a seed list of public Turkish/Turkey-oriented sites, then extracts only public metadata:

- title
- description
- canonical URL
- lang
- headings
- internal link count
- bounded same-domain frontier candidates
- fetch attempt diagnostics and safe sitemap/RSS fallback attempts
- total fetch-attempt count in the human summary
- robots fetch error count in the human summary
- per-domain crawl budget
- safe-agent score
- RSS/sitemap hints
- schema.org type hints
- Turkish relevance score
- robots decision
- safety flags

It does not collect user data.
It does not use login.
It does not submit forms.

## Network access

The eval uses live network requests to public URLs such as:

- GitHub API
- books.toscrape.com
- selected Turkish public websites in the seed list

Live results may change because upstream websites change.

## Hermes skill

A draft Hermes skill is included in:

```text
skills/turkish-agentic-scraping-eval/SKILL.md
```

It describes how Hermes should run this project as a repeatable autonomous workflow.

## License

MIT
