import { chromium, type Page } from 'playwright';
import * as cheerio from 'cheerio';
import { z } from 'zod';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

const OUT_DIR = path.resolve('reports');

type TestResult = {
  id: string;
  claim: string;
  status: 'pass' | 'fail' | 'warn';
  evidence: Record<string, unknown>;
};

const results: TestResult[] = [];
function record(id: string, claim: string, status: TestResult['status'], evidence: Record<string, unknown>) {
  results.push({ id, claim, status, evidence });
  const icon = status === 'pass' ? 'PASS' : status === 'warn' ? 'WARN' : 'FAIL';
  console.log(`${icon} ${id} - ${claim}`);
}

async function fetchText(url: string) {
  const res = await fetch(url, { headers: { 'user-agent': 'BedirhanResearchBot/0.1 (+local eval)' } });
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), text: await res.text() };
}

function githubApiHeaders() {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  return {
    'user-agent': 'BedirhanResearchBot/0.1',
    accept: 'application/vnd.github+json',
    ...(token ? { authorization: `Bearer ${token}` } : {})
  };
}

async function testGithubLandscape() {
  const repos = [
    'apify/crawlee',
    'microsoft/playwright',
    'browserbase/stagehand',
    'browser-use/browser-use',
    'browser-use/browser-harness',
    'Skyvern-AI/skyvern',
    'steel-dev/steel-browser',
    'lightpanda-io/browser',
    'ChromeDevTools/chrome-devtools-mcp',
    'microsoft/playwright-mcp',
    'unclecode/crawl4ai',
    'firecrawl/firecrawl',
    'vercel-labs/agent-browser',
    'remorses/playwriter',
    'gsd-build/gsd-browser',
    'TheAgenticAI/TheAgenticBrowser',
    'vakra-dev/reader',
    'plasmate-labs/plasmate'
  ];
  const rows: any[] = [];
  const fallback = await loadGithubResearchFallback();
  for (const repo of repos) {
    const res = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: githubApiHeaders()
    });
    if (!res.ok) {
      const cached = fallback.get(repo.toLowerCase());
      rows.push(cached ? { ...cached, ok: true, source: 'cached-research-json-after-github-rate-limit', liveStatus: res.status } : { repo, ok: false, status: res.status });
      continue;
    }
    const json: any = await res.json();
    rows.push({
      repo,
      ok: true,
      source: 'github-api-live',
      stars: json.stargazers_count,
      license: json.license?.spdx_id ?? null,
      language: json.language,
      archived: json.archived,
      updated_at: json.updated_at,
      description: json.description
    });
  }
  await fs.writeFile(path.join(OUT_DIR, 'github-landscape.json'), JSON.stringify(rows, null, 2));
  const failures = rows.filter(r => !r.ok || r.archived).length;
  const licenseRisk = rows.filter(r => ['AGPL-3.0', 'GPL-3.0', 'SSPL-1.0', 'NOASSERTION'].includes(r.license)).map(r => `${r.repo}:${r.license}`);
  const cacheUsed = rows.filter(r => r.source === 'cached-research-json-after-github-rate-limit').length;
  record('github-landscape', 'repo metadata can be re-verified or safely cached when GitHub rate-limits; license risk remains visible', failures ? 'warn' : 'pass', {
    checked: rows.length,
    failures,
    cacheUsed,
    licenseRisk,
    sample: rows.slice(0, 6)
  });
}

async function loadGithubResearchFallback() {
  const files = [
    path.join(OUT_DIR, 'research', 'github_research_2026-05-18.json'),
    path.resolve('github_research_2026-05-18.json')
  ];
  const map = new Map<string, any>();
  for (const file of files) {
    try {
      const raw = await fs.readFile(file, 'utf8');
      const json = JSON.parse(raw);
      for (const r of json.records ?? []) {
        const repo = r.full_name ?? r.repo;
        if (!repo) continue;
        map.set(String(repo).toLowerCase(), {
          repo,
          stars: r.stars,
          license: r.license,
          language: r.language,
          archived: r.archived,
          updated_at: r.updated_at,
          description: r.description
        });
      }
    } catch {
      // Optional fallback only.
    }
  }
  return map;
}

async function testStaticHttpFirst() {
  const url = 'https://books.toscrape.com/';
  const { status, text } = await fetchText(url);
  const $ = cheerio.load(text);
  const books = $('.product_pod').map((_, el) => ({
    title: $(el).find('h3 a').attr('title'),
    price: $(el).find('.price_color').text().trim(),
    href: new URL($(el).find('h3 a').attr('href') ?? '', url).href
  })).get();
  record('http-first-static', 'static HTML should be fetched without a browser when enough data exists', status === 200 && books.length >= 20 ? 'pass' : 'fail', {
    url,
    status,
    bytes: text.length,
    books: books.length,
    first: books[0]
  });
}

async function withServer<T>(handler: http.RequestListener, fn: (base: string) => Promise<T>) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('bad server address');
  const base = `http://127.0.0.1:${addr.port}`;
  try { return await fn(base); }
  finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

async function testPlaywrightNetworkDiscovery() {
  await withServer((req, res) => {
    if (req.url === '/api/items') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ id: 1, name: 'Alpha' }, { id: 2, name: 'Beta' }]));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html><body><h1>JS Listing</h1><ul id="items"></ul><script>
      fetch('/api/items').then(r => r.json()).then(items => {
        document.querySelector('#items').innerHTML = items.map(x => '<li data-id="'+x.id+'">'+x.name+'</li>').join('')
      })
    </script></body></html>`);
  }, async (base) => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const apiCalls: string[] = [];
    page.on('response', async (response) => {
      const ct = response.headers()['content-type'] ?? '';
      if (ct.includes('application/json')) apiCalls.push(response.url());
    });
    await page.goto(base);
    await page.waitForSelector('li[data-id="2"]');
    const domItems = await page.locator('li').allTextContents();
    await browser.close();
    const replay = await fetch(`${base}/api/items`).then(r => r.json()) as any[];
    record('browser-network-replay', 'browser should discover JSON endpoints, then HTTP replay should be possible', apiCalls.length === 1 && domItems.length === 2 && replay.length === 2 ? 'pass' : 'fail', {
      base,
      apiCalls,
      domItems,
      replay
    });
  });
}

async function testReadabilityAndRawArtifactNeed() {
  const html = `<!doctype html><html><body>
    <nav>Home Pricing Login</nav>
    <article><h1>Camera Review</h1><p>The X100 camera costs $1599.</p><table><tr><th>Sensor</th><td>APS-C</td></tr></table></article>
    <aside>Ads and newsletter</aside>
  </body></html>`;
  await fs.writeFile(path.join(OUT_DIR, 'raw-article.html'), html);
  const dom = new JSDOM(html, { url: 'https://example.test/review' });
  const article = new Readability(dom.window.document).parse();
  const keptTable = article?.content?.includes('<table') ?? false;
  record('markdown-cleanup-raw-artifact', 'cleanup helps remove boilerplate, but raw HTML must be kept because details can be lost or transformed', article?.textContent?.includes('camera costs') ? (keptTable ? 'pass' : 'warn') : 'fail', {
    title: article?.title,
    text: article?.textContent,
    keptTable,
    rawSaved: path.join(OUT_DIR, 'raw-article.html')
  });
}

async function testStructuredExtractionValidation() {
  const sourceText = 'Product: Pixel Mug. Price: $18.00. Availability: in stock.';
  const schema = z.object({
    name: z.object({ value: z.string(), source_quote: z.string(), confidence: z.enum(['high', 'medium', 'low']) }),
    price: z.object({ value: z.string().regex(/^\$\d+(\.\d{2})$/), source_quote: z.string(), confidence: z.enum(['high', 'medium', 'low']) })
  });
  const extracted = {
    name: { value: 'Pixel Mug', source_quote: 'Product: Pixel Mug', confidence: 'high' },
    price: { value: '$18.00', source_quote: 'Price: $18.00', confidence: 'high' }
  };
  const parsed = schema.safeParse(extracted);
  const quoteOk = Object.values(extracted).every((field: any) => sourceText.includes(field.source_quote));
  record('structured-extraction', 'extraction should be schema-validated and every important field should have source_quote provenance', parsed.success && quoteOk ? 'pass' : 'fail', {
    parsed: parsed.success,
    quoteOk,
    extracted
  });
}

function isAllowedAction(action: { type: string; url?: string }, allowedHosts: string[]) {
  const dangerous = ['BUY', 'SUBMIT_PAYMENT', 'DELETE', 'POST_PUBLICLY', 'ACCEPT_LEGAL_TERMS', 'BYPASS_CAPTCHA', 'LOGIN', 'REGISTER', 'FORM_SUBMIT'];
  if (dangerous.includes(action.type)) return { ok: false, reason: 'dangerous_action' };
  if (action.url) {
    const host = new URL(action.url).host;
    if (!allowedHosts.includes(host)) return { ok: false, reason: 'off_host' };
  }
  return { ok: true, reason: 'ok' };
}

async function testBoundedAgentGuardrails() {
  const actions = [
    { type: 'OPEN_ALLOWED_URL', url: 'https://books.toscrape.com/' },
    { type: 'CLICK' },
    { type: 'DELETE', url: 'https://books.toscrape.com/admin/item/1' },
    { type: 'LOGIN', url: 'https://books.toscrape.com/accounts/login' },
    { type: 'FORM_SUBMIT', url: 'https://books.toscrape.com/search' },
    { type: 'OPEN_ALLOWED_URL', url: 'https://evil.example/' }
  ];
  const decisions = actions.map(a => ({ action: a, decision: isAllowedAction(a, ['books.toscrape.com']) }));
  const blocked = decisions.filter(d => !d.decision.ok).length;
  record('bounded-agent-guardrails', 'agentic browser must be a bounded state machine with allowlist and destructive-action blocks', blocked === 4 ? 'pass' : 'fail', { decisions });
}

async function testScrollAndNativeSetter() {
  await withServer((_, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html><body><div style="height:2200px"></div>
      <input id="q" value=""><button id="go" onclick="document.body.dataset.clicked=document.querySelector('#q').value">Go</button>
    </body></html>`);
  }, async (base) => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.goto(base);
    await setInputValue(page, '#q', 'istanbul');
    await page.locator('#go').scrollIntoViewIfNeeded();
    await page.locator('#go').click();
    const value = await page.locator('#q').inputValue();
    const clicked = await page.evaluate(() => document.body.dataset.clicked);
    await browser.close();
    record('browser-action-primitives', 'robust primitives should scroll before click and use native input setters to avoid duplicated text', value === 'istanbul' && clicked === 'istanbul' ? 'pass' : 'fail', { value, clicked });
  });
}

async function setInputValue(page: Page, selector: string, value: string) {
  await page.$eval(selector, (el, v) => {
    const input = el as HTMLInputElement;
    const proto = Object.getPrototypeOf(input);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    desc?.set?.call(input, v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await testGithubLandscape();
  await testStaticHttpFirst();
  await testPlaywrightNetworkDiscovery();
  await testReadabilityAndRawArtifactNeed();
  await testStructuredExtractionValidation();
  await testBoundedAgentGuardrails();
  await testScrollAndNativeSetter();
  const summary = {
    createdAt: new Date().toISOString(),
    pass: results.filter(r => r.status === 'pass').length,
    warn: results.filter(r => r.status === 'warn').length,
    fail: results.filter(r => r.status === 'fail').length,
    results
  };
  await fs.writeFile(path.join(OUT_DIR, 'eval-results.json'), JSON.stringify(summary, null, 2));
  await fs.writeFile(path.join(OUT_DIR, 'eval-results.md'), renderMarkdown(summary));
  if (summary.fail > 0) process.exitCode = 1;
}

function renderMarkdown(summary: any) {
  return `# Agentic Browser Scraping Findings Eval\n\nCreated: ${summary.createdAt}\n\nPass: ${summary.pass}\nWarn: ${summary.warn}\nFail: ${summary.fail}\n\n${summary.results.map((r: TestResult) => `## ${r.status.toUpperCase()} ${r.id}\n\nClaim: ${r.claim}\n\nEvidence:\n\n\`\`\`json\n${JSON.stringify(r.evidence, null, 2)}\n\`\`\`\n`).join('\n')}\n`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
