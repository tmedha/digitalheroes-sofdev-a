import { extractMetadata } from "./metadata.js";
import { runSecurityChecks, snapshotSecurity } from "./security.js";
import { runSeoChecks } from "./seo.js";
import type { AuditResult, AuditSummary, CategoryScore, Check, CheckCategory } from "./types.js";
import { fetchPage, type FetchPageOptions } from "../lib/fetch-page.js";

export type { AuditResult } from "./types.js";

/** A warning is half credit; a failure is none. */
const STATUS_CREDIT = { pass: 1, warn: 0.5, fail: 0 } as const;

export function scoreChecks(checks: Check[]): AuditSummary {
  const byCategory = new Map<CheckCategory, Check[]>();
  for (const check of checks) {
    const bucket = byCategory.get(check.category);
    if (bucket) bucket.push(check);
    else byCategory.set(check.category, [check]);
  }

  const scoreOf = (group: Check[]): number => {
    const totalWeight = group.reduce((sum, check) => sum + check.weight, 0);
    if (totalWeight === 0) return 100;
    const earned = group.reduce((sum, check) => sum + check.weight * STATUS_CREDIT[check.status], 0);
    return Math.round((earned / totalWeight) * 100);
  };

  const categories: CategoryScore[] = [...byCategory.entries()]
    .map(([category, group]) => ({
      category,
      score: scoreOf(group),
      passed: group.filter((check) => check.status === "pass").length,
      warnings: group.filter((check) => check.status === "warn").length,
      failed: group.filter((check) => check.status === "fail").length,
    }))
    .sort((a, b) => a.category.localeCompare(b.category));

  const score = scoreOf(checks);

  return {
    score,
    grade: score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F",
    passed: checks.filter((check) => check.status === "pass").length,
    warnings: checks.filter((check) => check.status === "warn").length,
    failed: checks.filter((check) => check.status === "fail").length,
    categories,
  };
}

/** Failures first, then warnings — the response reads as a to-do list. */
const STATUS_ORDER = { fail: 0, warn: 1, pass: 2 } as const;

function sortChecks(checks: Check[]): Check[] {
  return [...checks].sort((a, b) => {
    const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (byStatus !== 0) return byStatus;
    const byWeight = b.weight - a.weight;
    if (byWeight !== 0) return byWeight;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Fetches the URL and runs every check against it. Pure with respect to
 * caching and rate limiting — those live in the route so this stays testable
 * on its own.
 */
export async function runAudit(url: string, options: FetchPageOptions): Promise<AuditResult> {
  const page = await fetchPage(url, options);
  const metadata = extractMetadata(page.body, page.finalUrl);
  const checks = sortChecks([...runSecurityChecks(page), ...runSeoChecks(page, metadata)]);

  return {
    url: {
      requested: page.requestedUrl,
      final: page.finalUrl,
      redirected: page.redirects.length > 0,
      redirects: page.redirects,
    },
    fetch: {
      status: page.status,
      statusText: page.statusText,
      contentType: page.contentType,
      bytes: page.bytes,
      durationMs: page.durationMs,
      redirectCount: page.redirects.length,
    },
    summary: scoreChecks(checks),
    checks,
    metadata,
    security: snapshotSecurity(page),
    auditedAt: new Date().toISOString(),
  };
}
