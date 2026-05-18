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
  http_status: z.number().nullable(),
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
    canonical: z.string().nullable(),
    lang: z.string().nullable(),
    headings: z.array(z.string()),
    schema_types: z.array(z.string()),
    rss_links: z.array(z.string()),
    sitemap_links: z.array(z.string())
  }),
  discovery: z.object({
    internal_links_found: z.number(),
    sample_internal_links: z.array(z.string()),
    page_type_guess: z.string()
  }),
  turkish_score: z.object({
    score: z.number(),
    signals: z.record(z.string(), z.boolean().or(z.number()).or(z.string()))
  }),
  quality_score: z.number(),
  safety: z.object({
    login_detected: z.boolean(),
    forms_ignored: z.number(),
    blocked_actions: z.array(z.string()),
    pii_extraction_attempted: z.literal(false)
  }),
  errors: z.array(z.string())
});

export type DiscoveryRecord = z.infer<typeof DiscoveryRecordSchema>;
