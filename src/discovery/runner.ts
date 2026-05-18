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

function normalizeUrl(url: string) {
  const u = new URL(url);
  u.hash = '';
  if (u.pathname !== '/' && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
  return u.href;
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
    return { checked: true, allowed: true, robots_url: robotsUrl, reason: `robots_fetch_error:${String(error).slice(0, 120)}` };
  }
}

function extractMetadata(seed: SeedSite, html: string, status: number | null, contentType: string | null, robots: Awaited<ReturnType<typeof robotsDecision>>, errors: string[]): DiscoveryRecord {
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
  const sitemapLinks = $('a[href*="sitemap"],link[href*="sitemap"]').map((_, el) => safeUrl($(el).attr('href') || '', seed.url)).get().filter(Boolean).slice(0, 10);
  const internalLinks = $('a[href]').map((_, el) => safeUrl($(el).attr('href') || '', seed.url)).get()
    .filter((href): href is string => Boolean(href))
    .filter((href) => new URL(href).host === base.host)
    .map(normalizeUrl);
  const dedupedInternal = [...new Set(internalLinks)];
  const formsIgnored = $('form').length;
  const textSample = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 4000);
  const turkish = scoreTurkish({ url: seed.url, lang, title, description, text: textSample });
  const loginDetected = detectLogin($, textSample);
  const blockedActions = formsIgnored > 0 ? ['FORM_SUBMIT'] : [];
  if (loginDetected) blockedActions.push('LOGIN');
  const quality = qualityScore({ title, description, headings, internalCount: dedupedInternal.length, turkishScore: turkish.score, robotsAllowed: robots.allowed });

  const record: DiscoveryRecord = {
    run_id: process.env.RUN_ID ?? new Date().toISOString(),
    agent_id: process.env.AGENT_ID ?? 'local-safe-discovery-agent',
    url: seed.url,
    normalized_url: normalizeUrl(seed.url),
    domain: base.host,
    label: seed.label,
    category: seed.category,
    fetched_at: new Date().toISOString(),
    fetch_mode: robots.allowed ? 'http' : 'skipped',
    http_status: status,
    content_type: contentType,
    robots: robots,
    metadata: { title, description, canonical, lang, headings, schema_types: schemaTypes, rss_links: rssLinks, sitemap_links: sitemapLinks },
    discovery: { internal_links_found: dedupedInternal.length, sample_internal_links: dedupedInternal.slice(0, 10), page_type_guess: guessPageType(seed, schemaTypes, headings, dedupedInternal.length) },
    turkish_score: turkish,
    quality_score: quality,
    safety: { login_detected: loginDetected, forms_ignored: formsIgnored, blocked_actions: blockedActions, pii_extraction_attempted: false },
    errors
  };
  return DiscoveryRecordSchema.parse(record);
}

function safeUrl(value: string, base: string) {
  try { return normalizeUrl(new URL(value, base).href); } catch { return null; }
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

async function discoverSeed(seed: SeedSite): Promise<DiscoveryRecord> {
  const errors: string[] = [];
  const robots = await robotsDecision(seed.url);
  if (!robots.allowed) {
    return extractMetadata(seed, '', null, null, robots, ['skipped_by_robots']);
  }
  try {
    const fetched = await fetchText(seed.url);
    if (!fetched.contentType?.includes('html') && !fetched.contentType?.includes('text')) {
      errors.push(`unexpected_content_type:${fetched.contentType}`);
    }
    return extractMetadata(seed, fetched.text.slice(0, 2_000_000), fetched.status, fetched.contentType, robots, errors);
  } catch (error) {
    errors.push(String(error).slice(0, 200));
    return extractMetadata(seed, '', null, null, robots, errors);
  }
}

function renderSummary(records: DiscoveryRecord[]) {
  const pass = records.filter((r) => r.robots.allowed && r.errors.length === 0).length;
  const skipped = records.filter((r) => !r.robots.allowed).length;
  const avgTurkish = records.length ? records.reduce((sum, r) => sum + r.turkish_score.score, 0) / records.length : 0;
  const avgQuality = records.length ? records.reduce((sum, r) => sum + r.quality_score, 0) / records.length : 0;
  return `# Turkish Discovery Summary\n\nCreated: ${new Date().toISOString()}\n\nChecked: ${records.length}\nPass: ${pass}\nSkipped by robots: ${skipped}\nAverage Turkish score: ${avgTurkish.toFixed(2)}\nAverage quality score: ${avgQuality.toFixed(2)}\n\n## Records\n\n${records.map((r) => `- ${r.label} (${r.domain}) — status ${r.http_status ?? 'n/a'}, robots ${r.robots.allowed ? 'allowed' : 'blocked'}, tr ${r.turkish_score.score}, quality ${r.quality_score}, links ${r.discovery.internal_links_found}, title: ${r.metadata.title ?? 'n/a'}`).join('\n')}\n`;
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
