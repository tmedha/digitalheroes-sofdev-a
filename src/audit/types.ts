export type CheckStatus = "pass" | "warn" | "fail";
export type CheckCategory = "security" | "seo" | "metadata" | "accessibility" | "performance";

export interface Check {
  /** Stable machine-readable identifier; safe to switch on. */
  id: string;
  category: CheckCategory;
  title: string;
  status: CheckStatus;
  /** Human-readable explanation of why the check landed where it did. */
  detail: string;
  /** The observed value, when there is one worth returning. */
  value?: string | number | boolean | null;
  /** Weight in the category score. Higher means more consequential. */
  weight: number;
}

export interface CategoryScore {
  category: CheckCategory;
  score: number;
  passed: number;
  warnings: number;
  failed: number;
}

export interface AuditSummary {
  /** Weighted 0-100 across every check. */
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  passed: number;
  warnings: number;
  failed: number;
  categories: CategoryScore[];
}

export interface AuditResult {
  url: {
    requested: string;
    final: string;
    redirected: boolean;
    redirects: Array<{ from: string; to: string; status: number }>;
  };
  fetch: {
    status: number;
    statusText: string;
    contentType: string | null;
    bytes: number;
    durationMs: number;
    redirectCount: number;
  };
  summary: AuditSummary;
  checks: Check[];
  metadata: PageMetadata;
  security: SecuritySnapshot;
  /** ISO timestamp of when the audit was computed (not when it was served). */
  auditedAt: string;
}

export interface PageMetadata {
  title: string | null;
  titleLength: number;
  description: string | null;
  descriptionLength: number;
  canonical: string | null;
  robots: string | null;
  viewport: string | null;
  lang: string | null;
  charset: string | null;
  favicon: string | null;
  h1s: string[];
  headingCounts: Record<string, number>;
  images: { total: number; missingAlt: number };
  links: { total: number; internal: number; external: number; nofollow: number };
  openGraph: Record<string, string>;
  twitter: Record<string, string>;
  structuredDataTypes: string[];
  wordCount: number;
}

export interface SecuritySnapshot {
  https: boolean;
  headers: Record<string, string | null>;
}
