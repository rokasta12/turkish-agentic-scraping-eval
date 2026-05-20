import * as cheerio from 'cheerio';
import robotsParserModule from 'robots-parser';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TURKISH_SEEDS, type SeedSite } from './seeds.tr.js';
import { DiscoveryRecordSchema, type DiscoveryRecord } from './schema.js';

const USER_AGENT = 'BedirhanResearchBot/0.1 (+metadata-only; respects robots.txt)';
const OUT_DIR = path.resolve('reports/discovery');
const MAX_SEEDS = Number(process.env.TR_DISCOVERY_MAX_SEEDS ?? '5');
const REQUEST_DELAY_MS = Number(process.env.TR_DISCOVERY_DELAY_MS ?? '1500');
const MAX_FRONTIER_CANDIDATES = Number(process.env.TR_DISCOVERY_MAX_FRONTIER ?? '12');

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url: string, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5' }
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get('content-type'),
      text
    };
  } finally {
    clearTimeout(timer);
  }
}

function describeFetchError(error: unknown, timeoutMs: number) {
  if (error instanceof Error && error.name === 'AbortError') return `timeout_after_${timeoutMs}ms`;
  return String(error).slice(0, 160);
}

function normalizeUrl(url: string) {
  const u = new URL(url);
  u.hash = '';
  if (u.pathname !== '/' && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
  return u.href;
}

function hasUnresolvedTemplateToken(url: string) {
  const lower = url.toLowerCase();
  return lower.includes('%7b') || lower.includes('%7d') || lower.includes('{{') || lower.includes('}}') || lower.includes('${');
}

type FrontierSource = 'internal' | 'rss' | 'sitemap' | 'canonical';
type FrontierCandidate = { url: string; source: FrontierSource; priority: number; reason: string };
type DomainBudget = { max_pages: number; fetched_pages: number; remaining_pages: number };
type FetchAttempt = { url: string; ok: boolean; status: number | null; content_type: string | null; error: string | null };
const FALLBACK_PATHS = ['/sitemap.xml', '/sitemap_index.xml', '/rss.xml', '/feed.xml'];
const BLOCKED_ACTIONS = new Set([
  'BUY',
  'SUBMIT_PAYMENT',
  'DELETE',
  'POST_PUBLICLY',
  'ACCEPT_LEGAL_TERMS',
  'BYPASS_CAPTCHA',
  'LOGIN',
  'REGISTER',
  'FORM_SUBMIT'
]);

function budgetForSeed(seed: SeedSite): DomainBudget {
  const configuredLimit = Number(process.env.TR_DISCOVERY_MAX_PAGES_PER_DOMAIN ?? String(seed.maxPages));
  const maxPages = Math.max(1, Math.min(seed.maxPages, configuredLimit));
  return { max_pages: maxPages, fetched_pages: 1, remaining_pages: Math.max(0, maxPages - 1) };
}

function buildFrontierCandidates(input: {
  seedUrl: string;
  canonical: string | null;
  rssLinks: string[];
  sitemapLinks: string[];
  internalLinks: string[];
  budget: DomainBudget;
}): FrontierCandidate[] {
  if (input.budget.remaining_pages <= 0) return [];
  const seedHost = new URL(input.seedUrl).host;
  const candidates: FrontierCandidate[] = [];
  const add = (url: string | null, source: FrontierSource, priority: number, reason: string) => {
    if (!url) return;
    const parsed = new URL(url);
    if (parsed.host !== seedHost) return;
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return;
    const normalized = normalizeUrl(parsed.href);
    if (hasUnresolvedTemplateToken(normalized)) return;
    candidates.push({ url: normalized, source, priority, reason });
  };

  add(input.canonical, 'canonical', 90, 'canonical URL on same host');
  for (const url of input.sitemapLinks) add(url, 'sitemap', 80, 'sitemap hint on same host');
  for (const url of input.rssLinks) add(url, 'rss', 70, 'rss/atom hint on same host');
  for (const url of input.internalLinks) add(url, 'internal', 40, 'internal link on same host');

  const seen = new Set<string>();
  return candidates
    .filter((candidate) => {
      if (seen.has(candidate.url)) return false;
      seen.add(candidate.url);
      return candidate.url !== normalizeUrl(input.seedUrl);
    })
    .sort((a, b) => b.priority - a.priority || a.url.localeCompare(b.url))
    .slice(0, Math.min(MAX_FRONTIER_CANDIDATES, input.budget.remaining_pages * 10));
}

function scoreAgent(input: { robotsAllowed: boolean; fetchMode: 'http' | 'browser' | 'skipped'; blockedActions: string[]; frontierCandidates: FrontierCandidate[] }) {
  const signals = {
    robots_respected: input.robotsAllowed,
    used_http_first: input.fetchMode === 'http' || input.fetchMode === 'skipped',
    metadata_only: true,
    avoided_blocked_actions: input.blockedActions.every((action) => !BLOCKED_ACTIONS.has(action)),
    useful_frontier: input.frontierCandidates.length > 0
  };
  const score = (signals.robots_respected ? 0.3 : 0) + (signals.used_http_first ? 0.2 : 0) + (signals.metadata_only ? 0.2 : 0) + (signals.avoided_blocked_actions ? 0.2 : 0) + (signals.useful_frontier ? 0.1 : 0);
  return { score: Number(score.toFixed(2)), signals };
}

async function robotsDecision(targetUrl: string) {
  const u = new URL(targetUrl);
  const robotsUrl = `${u.origin}/robots.txt`;
  try {
    const robots = await fetchText(robotsUrl, 10000);
    if (robots.status >= 400) {
      return { checked: true, allowed: true, robots_url: robotsUrl, reason: `robots_status_${robots.status}` };
    }
    const robotsParser = (robotsParserModule as unknown as (url: string, robotstxt: string) => { isAllowed(url: string, ua?: string): boolean | undefined });
    const parser = robotsParser(robotsUrl, robots.text);
    const allowed = parser.isAllowed(targetUrl, USER_AGENT) !== false;
    return { checked: true, allowed, robots_url: robotsUrl, reason: allowed ? null : 'robots_disallow' };
  } catch (error) {
    return { checked: true, allowed: true, robots_url: robotsUrl, reason: `robots_fetch_error:${describeFetchError(error, 10000)}` };
  }
}

function extractMetadata(seed: SeedSite, html: string, status: number | null, contentType: string | null, robots: Awaited<ReturnType<typeof robotsDecision>>, errors: string[], fetchedUrl: string | null = null, fetchAttempts: FetchAttempt[] = []): DiscoveryRecord {
  const budget = budgetForSeed(seed);
  const $ = cheerio.load(html);
  const base = new URL(seed.url);
  const title = $('title').first().text().replace(/\s+/g, ' ').trim() || null;
  const description = $('meta[name="description"]').attr('content')?.trim() || $('meta[property="og:description"]').attr('content')?.trim() || null;
  const canonicalRaw = $('link[rel="canonical"]').attr('href') || null;
  const canonical = canonicalRaw ? safeUrl(canonicalRaw, seed.url) : null;
  const lang = $('html').attr('lang') || null;
  const headings = $('h1,h2').slice(0, 12).map((_, el) => $(el).text().replace(/\s+/g, ' ').trim()).get().filter(Boolean);
  const schemaTypes = $('[type="application/ld+json"]').map((_, el) => parseSchemaTypes($(el).text())).get().flat().slice(0, 20);
  const rssLinks = $('link[type="application/rss+xml"],link[type="application/atom+xml"]').map((_, el) => safeUrl($(el).attr('href') || '', seed.url)).get().filter(Boolean).slice(0, 10);
  const xmlLocLinks = $('loc').map((_, el) => safeUrl($(el).text().trim(), seed.url)).get().filter(Boolean);
  const sitemapLinks = [
    ...$('a[href*="sitemap"],link[href*="sitemap"]').map((_, el) => safeUrl($(el).attr('href') || '', seed.url)).get().filter(Boolean),
    ...xmlLocLinks
  ].slice(0, 10);
  const internalLinks = $('a[href]').map((_, el) => safeUrl($(el).attr('href') || '', seed.url)).get()
    .filter((href): href is string => Boolean(href))
    .filter((href) => new URL(href).host === base.host)
    .map(normalizeUrl);
  const dedupedInternal = [...new Set(internalLinks)];
  const formsIgnored = $('form').length;
  const textSample = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 4000);
  const turkish = scoreTurkish({ url: seed.url, lang, title, description, text: textSample });
  const loginDetected = detectLogin($, textSample);
  // Presence of forms/login text is reported, but it is not a blocked action unless the agent attempts it.
  const blockedActions: string[] = [];
  const quality = qualityScore({ title, description, headings, internalCount: dedupedInternal.length, turkishScore: turkish.score, robotsAllowed: robots.allowed });
  const fetchMode = robots.allowed ? 'http' : 'skipped';
  const frontierCandidates = buildFrontierCandidates({ seedUrl: seed.url, canonical, rssLinks, sitemapLinks, internalLinks: dedupedInternal, budget });
  const agentScore = scoreAgent({ robotsAllowed: robots.allowed, fetchMode, blockedActions, frontierCandidates });

  const record: DiscoveryRecord = {
    run_id: process.env.RUN_ID ?? new Date().toISOString(),
    agent_id: process.env.AGENT_ID ?? 'local-safe-discovery-agent',
    url: seed.url,
    normalized_url: normalizeUrl(seed.url),
    domain: base.host,
    label: seed.label,
    category: seed.category,
    fetched_at: new Date().toISOString(),
    fetch_mode: fetchMode,
    http_status: status,
    content_type: contentType,
    robots: robots,
    metadata: { title, description, canonical, lang, headings, schema_types: schemaTypes, rss_links: rssLinks, sitemap_links: sitemapLinks },
    discovery: { fetched_url: fetchedUrl, fetch_attempts: fetchAttempts, internal_links_found: dedupedInternal.length, sample_internal_links: dedupedInternal.slice(0, 10), frontier_candidates: frontierCandidates, page_type_guess: guessPageType(seed, schemaTypes, headings, dedupedInternal.length) },
    domain_budget: budget,
    turkish_score: turkish,
    quality_score: quality,
    agent_score: agentScore,
    safety: { login_detected: loginDetected, forms_ignored: formsIgnored, blocked_actions: blockedActions, pii_extraction_attempted: false },
    errors
  };
  return DiscoveryRecordSchema.parse(record);
}

function safeUrl(value: string, base: string) {
  try {
    const normalized = normalizeUrl(new URL(value, base).href);
    return hasUnresolvedTemplateToken(normalized) ? null : normalized;
  } catch { return null; }
}

function parseSchemaTypes(text: string): string[] {
  try {
    const json = JSON.parse(text);
    const list = Array.isArray(json) ? json : [json];
    return list.map((item) => item?.['@type']).flat().filter((x): x is string => typeof x === 'string');
  } catch {
    return [];
  }
}

function scoreTurkish(input: { url: string; lang: string | null; title: string | null; description: string | null; text: string }) {
  const joined = `${input.title ?? ''} ${input.description ?? ''} ${input.text}`.toLocaleLowerCase('tr-TR');
  const stopwords = [' ve ', ' bir ', ' için ', ' ile ', ' olarak ', ' haber ', ' türkiye ', ' son ', ' daha ', ' kamu ', ' resmi '];
  const stopHits = stopwords.filter((w) => joined.includes(w)).length;
  const turkishChars = /[çğıöşüİ]/.test(joined);
  const tldTr = new URL(input.url).host.endsWith('.tr');
  const htmlLangTr = Boolean(input.lang?.toLocaleLowerCase('tr-TR').startsWith('tr'));
  const score = Math.min(1, (tldTr ? 0.25 : 0) + (htmlLangTr ? 0.35 : 0) + (turkishChars ? 0.2 : 0) + Math.min(0.2, stopHits * 0.04));
  return { score: Number(score.toFixed(2)), signals: { tld_tr: tldTr, html_lang_tr: htmlLangTr, turkish_chars: turkishChars, stopword_hits: stopHits } };
}

function detectLogin($: cheerio.CheerioAPI, text: string) {
  const hasPassword = $('input[type="password"]').length > 0;
  const loginWords = /giriş yap|oturum aç|üye girişi|login|sign in/i.test(text);
  return hasPassword || loginWords;
}

function qualityScore(input: { title: string | null; description: string | null; headings: string[]; internalCount: number; turkishScore: number; robotsAllowed: boolean }) {
  if (!input.robotsAllowed) return 0;
  const score = (input.title ? 0.2 : 0) + (input.description ? 0.2 : 0) + (input.headings.length ? 0.15 : 0) + Math.min(0.2, input.internalCount / 100) + input.turkishScore * 0.25;
  return Number(Math.min(1, score).toFixed(2));
}

function guessPageType(seed: SeedSite, schemaTypes: string[], headings: string[], internalCount: number) {
  const schema = schemaTypes.join(' ').toLowerCase();
  const text = headings.join(' ').toLocaleLowerCase('tr-TR');
  if (schema.includes('newsarticle') || seed.category === 'news') return 'news_or_article';
  if (schema.includes('product') || seed.category === 'commerce-smoke') return 'product_or_commerce';
  if (seed.category === 'public') return 'public_institution';
  if (seed.category === 'education') return 'education_or_research';
  if (text.includes('duyuru') || text.includes('haber')) return 'news_or_announcement';
  if (internalCount > 50) return 'index_or_listing';
  return 'unknown';
}

function fallbackUrls(seedUrl: string) {
  const origin = new URL(seedUrl).origin;
  return FALLBACK_PATHS.map((p) => normalizeUrl(new URL(p, origin).href));
}

async function tryFetch(url: string, timeoutMs: number): Promise<{ fetched: Awaited<ReturnType<typeof fetchText>> | null; attempt: FetchAttempt }> {
  try {
    const fetched = await fetchText(url, timeoutMs);
    return {
      fetched,
      attempt: { url, ok: fetched.ok, status: fetched.status, content_type: fetched.contentType, error: null }
    };
  } catch (error) {
    return {
      fetched: null,
      attempt: { url, ok: false, status: null, content_type: null, error: describeFetchError(error, timeoutMs) }
    };
  }
}

async function fetchWithSafeFallback(seed: SeedSite, primaryRobots: Awaited<ReturnType<typeof robotsDecision>>) {
  const attempts: FetchAttempt[] = [];
  const primary = await tryFetch(seed.url, 15000);
  attempts.push(primary.attempt);
  if (primary.fetched?.ok) {
    return { fetched: primary.fetched, fetchedUrl: seed.url, attempts, errors: [] as string[] };
  }

  for (const url of fallbackUrls(seed.url)) {
    const fallbackRobots = await robotsDecision(url);
    if (!fallbackRobots.allowed) {
      attempts.push({ url, ok: false, status: null, content_type: null, error: 'skipped_by_robots' });
      continue;
    }
    const result = await tryFetch(url, 8000);
    attempts.push(result.attempt);
    if (result.fetched?.ok) {
      return { fetched: result.fetched, fetchedUrl: url, attempts, errors: [] as string[] };
    }
  }

  const finalError = primary.attempt.error ?? `http_status:${primary.attempt.status ?? 'unknown'}`;
  const robotsReason = primaryRobots.reason ? [`robots:${primaryRobots.reason}`] : [];
  return { fetched: null, fetchedUrl: null, attempts, errors: [...robotsReason, finalError] };
}

async function discoverSeed(seed: SeedSite): Promise<DiscoveryRecord> {
  const robots = await robotsDecision(seed.url);
  if (!robots.allowed) {
    return extractMetadata(seed, '', null, null, robots, ['skipped_by_robots'], null, []);
  }

  const result = await fetchWithSafeFallback(seed, robots);
  if (!result.fetched) {
    return extractMetadata(seed, '', null, null, robots, result.errors, null, result.attempts);
  }

  const errors: string[] = [...result.errors];
  if (!result.fetched.contentType?.includes('html') && !result.fetched.contentType?.includes('text') && !result.fetched.contentType?.includes('xml')) {
    errors.push(`unexpected_content_type:${result.fetched.contentType}`);
  }
  return extractMetadata(seed, result.fetched.text.slice(0, 2_000_000), result.fetched.status, result.fetched.contentType, robots, errors, result.fetchedUrl, result.attempts);
}

function formatFailedAttempt(attempt: FetchAttempt) {
  const status = attempt.status === null ? 'status_unavailable' : `status_${attempt.status}`;
  const reason = attempt.error ?? (attempt.status !== null && attempt.status >= 400 ? 'http_status' : 'unknown_error');
  return `${status} ${reason} ${attempt.url}`;
}

function renderSummary(records: DiscoveryRecord[]) {
  const pass = records.filter((r) => r.robots.allowed && r.errors.length === 0).length;
  const skipped = records.filter((r) => !r.robots.allowed).length;
  const recordsWithErrors = records.filter((r) => r.errors.length > 0).length;
  const networkErrorRecords = records.filter((r) => r.discovery.fetch_attempts.some((attempt) => attempt.error !== null)).length;
  const robotsFetchErrorRecords = records.filter((r) => r.robots.reason?.startsWith('robots_fetch_error:')).length;
  const fetchAttemptTotal = records.reduce((sum, r) => sum + r.discovery.fetch_attempts.length, 0);
  const avgFetchAttempts = records.length ? fetchAttemptTotal / records.length : 0;
  const timeoutAttemptTotal = records.reduce((sum, r) => sum + r.discovery.fetch_attempts.filter((attempt) => attempt.error?.startsWith('timeout_after_')).length, 0);
  const httpErrorAttemptTotal = records.reduce((sum, r) => sum + r.discovery.fetch_attempts.filter((attempt) => attempt.status !== null && attempt.status >= 400).length, 0);
  const frontierTotal = records.reduce((sum, r) => sum + r.discovery.frontier_candidates.length, 0);
  const avgTurkish = records.length ? records.reduce((sum, r) => sum + r.turkish_score.score, 0) / records.length : 0;
  const avgQuality = records.length ? records.reduce((sum, r) => sum + r.quality_score, 0) / records.length : 0;
  const avgAgent = records.length ? records.reduce((sum, r) => sum + r.agent_score.score, 0) / records.length : 0;
  const fallbackAttemptRecords = records.filter((r) => r.discovery.fetch_attempts.length > 1).length;
  const fallbackSuccess = records.filter((r) => r.discovery.fetched_url && r.discovery.fetched_url !== r.url).length;
  const loginDetectedRecords = records.filter((r) => r.safety.login_detected).length;
  const formsIgnoredTotal = records.reduce((sum, r) => sum + r.safety.forms_ignored, 0);
  const blockedActionRecords = records.filter((r) => r.safety.blocked_actions.length > 0).length;
  const errorSummary = records
    .filter((r) => r.errors.length > 0 || r.discovery.fetch_attempts.some((attempt) => attempt.error !== null))
    .map((r) => {
      const attemptSummary = r.discovery.fetch_attempts
        .filter((attempt) => attempt.error !== null || attempt.status === null || attempt.status >= 400)
        .slice(0, 3)
        .map(formatFailedAttempt)
        .join('; ');
      return `- ${r.label} (${r.domain}) — errors ${r.errors.join(', ') || 'n/a'}; attempts ${attemptSummary || 'n/a'}`;
    });
  return `# Turkish Discovery Summary\n\nCreated: ${new Date().toISOString()}\n\nChecked: ${records.length}\nPass: ${pass}\nSkipped by robots: ${skipped}\nRecords with errors: ${recordsWithErrors}\nNetwork error records: ${networkErrorRecords}\nRobots fetch error records: ${robotsFetchErrorRecords}\nFetch attempts: ${fetchAttemptTotal}\nAverage fetch attempts per record: ${avgFetchAttempts.toFixed(2)}\nTimeout attempts: ${timeoutAttemptTotal}\nHTTP error attempts: ${httpErrorAttemptTotal}\nFallback attempted records: ${fallbackAttemptRecords}\nFallback successes: ${fallbackSuccess}\nFrontier candidates: ${frontierTotal}\nAverage Turkish score: ${avgTurkish.toFixed(2)}\nAverage quality score: ${avgQuality.toFixed(2)}\nAverage agent score: ${avgAgent.toFixed(2)}\nLogin detected records: ${loginDetectedRecords}\nForms ignored: ${formsIgnoredTotal}\nBlocked action records: ${blockedActionRecords}\n\n## Records\n\n${records.map((r) => `- ${r.label} (${r.domain}) — status ${r.http_status ?? 'n/a'}, robots ${r.robots.allowed ? 'allowed' : 'blocked'}, robots reason ${r.robots.reason ?? 'none'}, tr ${r.turkish_score.score}, quality ${r.quality_score}, agent ${r.agent_score.score}, attempts ${r.discovery.fetch_attempts.length}, fetched ${r.discovery.fetched_url ?? 'n/a'}, links ${r.discovery.internal_links_found}, frontier candidates ${r.discovery.frontier_candidates.length}, budget remaining ${r.domain_budget.remaining_pages}, errors ${r.errors.length}, title: ${r.metadata.title ?? 'n/a'}`).join('\n')}\n\n${errorSummary.length ? `## Error summary\n\n${errorSummary.join('\n')}\n` : ''}`;
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const records: DiscoveryRecord[] = [];
  for (const seed of TURKISH_SEEDS.slice(0, MAX_SEEDS)) {
    console.log(`discover ${seed.label} ${seed.url}`);
    records.push(await discoverSeed(seed));
    await sleep(REQUEST_DELAY_MS);
  }
  const jsonl = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  await fs.writeFile(path.join(OUT_DIR, 'tr-discovery-results.jsonl'), jsonl);
  await fs.writeFile(path.join(OUT_DIR, 'tr-discovery-summary.md'), renderSummary(records));
  console.log(`wrote ${records.length} records to ${OUT_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
