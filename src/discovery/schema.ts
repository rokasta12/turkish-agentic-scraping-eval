import { z } from 'zod';

export const DiscoveryRecordSchema = z.object({
  run_id: z.string(),
  agent_id: z.string(),
  url: z.string().url(),
  normalized_url: z.string().url(),
  domain: z.string(),
  label: z.string(),
  category: z.string(),
  fetched_at: z.string(),
  fetch_mode: z.enum(['http', 'browser', 'skipped']),
  http_status: z.number().int().min(100).max(599).nullable(),
  content_type: z.string().nullable(),
  robots: z.object({
    checked: z.boolean(),
    allowed: z.boolean(),
    robots_url: z.string().url(),
    reason: z.string().nullable()
  }),
  metadata: z.object({
    title: z.string().nullable(),
    description: z.string().nullable(),
    canonical: z.string().url().nullable(),
    lang: z.string().nullable(),
    headings: z.array(z.string()),
    schema_types: z.array(z.string()),
    rss_links: z.array(z.string().url()),
    sitemap_links: z.array(z.string().url())
  }),
  discovery: z.object({
    fetched_url: z.string().url().nullable(),
    fetch_attempts: z.array(z.object({
      url: z.string().url(),
      ok: z.boolean(),
      status: z.number().int().min(100).max(599).nullable(),
      content_type: z.string().nullable(),
      error: z.string().nullable()
    })),
    internal_links_found: z.number().int().nonnegative(),
    sample_internal_links: z.array(z.string().url()),
    frontier_candidates: z.array(z.object({
      url: z.string().url(),
      source: z.enum(['internal', 'rss', 'sitemap', 'canonical']),
      priority: z.number(),
      reason: z.string()
    })),
    page_type_guess: z.string()
  }),
  domain_budget: z.object({
    max_pages: z.number().int().positive(),
    fetched_pages: z.number().int().nonnegative(),
    remaining_pages: z.number().int().nonnegative()
  }),
  turkish_score: z.object({
    score: z.number().min(0).max(1),
    signals: z.record(z.string(), z.boolean().or(z.number()).or(z.string()))
  }),
  quality_score: z.number().min(0).max(1),
  agent_score: z.object({
    score: z.number().min(0).max(1),
    signals: z.object({
      robots_respected: z.boolean(),
      used_http_first: z.boolean(),
      metadata_only: z.boolean(),
      avoided_blocked_actions: z.boolean(),
      useful_frontier: z.boolean()
    })
  }),
  safety: z.object({
    login_detected: z.boolean(),
    forms_ignored: z.number().int().nonnegative(),
    blocked_actions: z.array(z.string()),
    pii_extraction_attempted: z.literal(false)
  }),
  errors: z.array(z.string())
});

export type DiscoveryRecord = z.infer<typeof DiscoveryRecordSchema>;
