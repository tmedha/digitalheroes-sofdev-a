import type { Check, PageMetadata } from "./types.js";
import type { FetchedPage } from "../lib/fetch-page.js";

/**
 * SEO, metadata and accessibility checks derived from the parsed page. Length
 * thresholds follow common search-result truncation points rather than any
 * single vendor's rules, and anything borderline is a warning, not a failure.
 */

const TITLE_MIN = 15;
const TITLE_MAX = 60;
const DESCRIPTION_MIN = 70;
const DESCRIPTION_MAX = 160;

export function runSeoChecks(page: FetchedPage, metadata: PageMetadata): Check[] {
  const checks: Check[] = [];

  checks.push({
    id: "fetch.status",
    category: "seo",
    title: "HTTP status",
    status: page.status === 200 ? "pass" : page.status < 400 ? "warn" : "fail",
    detail: `The page responded with ${page.status} ${page.statusText}.`.trim(),
    value: page.status,
    weight: 3,
  });

  if (page.redirects.length > 0) {
    checks.push({
      id: "fetch.redirects",
      category: "performance",
      title: "Redirect chain",
      status: page.redirects.length <= 1 ? "warn" : "fail",
      detail: `The request passed through ${page.redirects.length} redirect${page.redirects.length === 1 ? "" : "s"} before reaching the final URL, adding latency to every visit.`,
      value: page.redirects.length,
      weight: 1,
    });
  }

  const { title, titleLength } = metadata;
  checks.push({
    id: "seo.title",
    category: "seo",
    title: "Title tag",
    status: !title ? "fail" : titleLength >= TITLE_MIN && titleLength <= TITLE_MAX ? "pass" : "warn",
    detail: !title
      ? "The page has no <title>, which search engines and browser tabs both rely on."
      : titleLength > TITLE_MAX
        ? `The title is ${titleLength} characters and will likely be truncated in search results (aim for ${TITLE_MIN}-${TITLE_MAX}).`
        : titleLength < TITLE_MIN
          ? `The title is only ${titleLength} characters; a more descriptive title (${TITLE_MIN}-${TITLE_MAX}) ranks better.`
          : `The title is ${titleLength} characters.`,
    value: title,
    weight: 3,
  });

  const { description, descriptionLength } = metadata;
  checks.push({
    id: "seo.meta_description",
    category: "seo",
    title: "Meta description",
    status: !description
      ? "fail"
      : descriptionLength >= DESCRIPTION_MIN && descriptionLength <= DESCRIPTION_MAX
        ? "pass"
        : "warn",
    detail: !description
      ? "No meta description, so search engines will synthesise their own snippet."
      : descriptionLength > DESCRIPTION_MAX
        ? `The meta description is ${descriptionLength} characters and will be truncated (aim for ${DESCRIPTION_MIN}-${DESCRIPTION_MAX}).`
        : descriptionLength < DESCRIPTION_MIN
          ? `The meta description is only ${descriptionLength} characters; there is room for a fuller summary.`
          : `The meta description is ${descriptionLength} characters.`,
    value: description,
    weight: 2,
  });

  const h1Count = metadata.h1s.length;
  checks.push({
    id: "seo.h1",
    category: "seo",
    title: "H1 heading",
    status: h1Count === 1 ? "pass" : h1Count === 0 ? "fail" : "warn",
    detail:
      h1Count === 1
        ? `Exactly one H1: "${metadata.h1s[0]}".`
        : h1Count === 0
          ? "The page has no H1 heading, so its primary topic is ambiguous."
          : `The page has ${h1Count} H1 headings; a single H1 states the topic more clearly.`,
    value: h1Count,
    weight: 2,
  });

  checks.push({
    id: "seo.canonical",
    category: "seo",
    title: "Canonical URL",
    status: metadata.canonical ? "pass" : "warn",
    detail: metadata.canonical
      ? `Canonical URL is ${metadata.canonical}.`
      : "No canonical link; duplicate URLs for this page may compete with each other in search results.",
    value: metadata.canonical,
    weight: 2,
  });

  const robots = metadata.robots;
  const blocksIndexing = robots ? /\bnoindex\b/i.test(robots) : false;
  checks.push({
    id: "seo.robots",
    category: "seo",
    title: "Indexability",
    status: blocksIndexing ? "fail" : "pass",
    detail: blocksIndexing
      ? `The robots meta tag contains 'noindex' (${robots}), so this page will be excluded from search results.`
      : robots
        ? `The robots meta tag allows indexing (${robots}).`
        : "No robots meta tag, so the page is indexable by default.",
    value: robots,
    weight: 3,
  });

  checks.push({
    id: "seo.open_graph",
    category: "metadata",
    title: "Open Graph tags",
    status: (() => {
      const present = ["og:title", "og:description", "og:image"].filter((key) => metadata.openGraph[key]);
      return present.length === 3 ? "pass" : present.length === 0 ? "fail" : "warn";
    })(),
    detail: (() => {
      const missing = ["og:title", "og:description", "og:image"].filter((key) => !metadata.openGraph[key]);
      return missing.length === 0
        ? "og:title, og:description and og:image are all present."
        : `Missing Open Graph tags: ${missing.join(", ")}. Links shared on social platforms will preview poorly.`;
    })(),
    value: Object.keys(metadata.openGraph).length,
    weight: 1,
  });

  checks.push({
    id: "seo.twitter_card",
    category: "metadata",
    title: "Twitter card",
    status: metadata.twitter["twitter:card"] ? "pass" : "warn",
    detail: metadata.twitter["twitter:card"]
      ? `Twitter card type is '${metadata.twitter["twitter:card"]}'.`
      : "No twitter:card tag; link previews fall back to Open Graph or plain text.",
    value: metadata.twitter["twitter:card"] ?? null,
    weight: 1,
  });

  checks.push({
    id: "seo.structured_data",
    category: "metadata",
    title: "Structured data",
    status: metadata.structuredDataTypes.length > 0 ? "pass" : "warn",
    detail:
      metadata.structuredDataTypes.length > 0
        ? `JSON-LD structured data found: ${metadata.structuredDataTypes.join(", ")}.`
        : "No JSON-LD structured data, so rich results are unlikely.",
    value: metadata.structuredDataTypes.join(", ") || null,
    weight: 1,
  });

  checks.push({
    id: "meta.viewport",
    category: "metadata",
    title: "Mobile viewport",
    status: metadata.viewport ? "pass" : "fail",
    detail: metadata.viewport
      ? `Viewport is configured (${metadata.viewport}).`
      : "No viewport meta tag, so the page will not scale correctly on mobile devices.",
    value: metadata.viewport,
    weight: 2,
  });

  checks.push({
    id: "meta.lang",
    category: "accessibility",
    title: "Document language",
    status: metadata.lang ? "pass" : "warn",
    detail: metadata.lang
      ? `The document language is declared as '${metadata.lang}'.`
      : "The <html> element has no lang attribute, which screen readers use to pick a voice.",
    value: metadata.lang,
    weight: 1,
  });

  checks.push({
    id: "meta.charset",
    category: "metadata",
    title: "Character encoding",
    status: metadata.charset ? "pass" : "warn",
    detail: metadata.charset
      ? `Character encoding is declared as ${metadata.charset}.`
      : "No character encoding declared; browsers will have to guess.",
    value: metadata.charset,
    weight: 1,
  });

  const { total, missingAlt } = metadata.images;
  checks.push({
    id: "a11y.image_alt",
    category: "accessibility",
    title: "Image alt text",
    status: total === 0 || missingAlt === 0 ? "pass" : missingAlt / total > 0.25 ? "fail" : "warn",
    detail:
      total === 0
        ? "The page has no images."
        : missingAlt === 0
          ? `All ${total} images have an alt attribute.`
          : `${missingAlt} of ${total} images are missing an alt attribute.`,
    value: total === 0 ? 0 : Math.round(((total - missingAlt) / total) * 100),
    weight: 2,
  });

  checks.push({
    id: "seo.content_length",
    category: "seo",
    title: "Content volume",
    status: metadata.wordCount >= 300 ? "pass" : metadata.wordCount >= 100 ? "warn" : "fail",
    detail: `The page body contains roughly ${metadata.wordCount} words${
      metadata.wordCount < 300 ? "; thin pages tend to rank poorly" : ""
    }.`,
    value: metadata.wordCount,
    weight: 1,
  });

  checks.push({
    id: "perf.page_weight",
    category: "performance",
    title: "HTML document size",
    status: page.bytes <= 100_000 ? "pass" : page.bytes <= 500_000 ? "warn" : "fail",
    detail: `The HTML document is ${(page.bytes / 1024).toFixed(1)} KB${
      page.bytes > 100_000 ? "; large documents delay first render" : ""
    }.`,
    value: page.bytes,
    weight: 1,
  });

  checks.push({
    id: "perf.ttfb",
    category: "performance",
    title: "Response time",
    status: page.durationMs <= 600 ? "pass" : page.durationMs <= 2_000 ? "warn" : "fail",
    detail: `The document took ${page.durationMs}ms to fetch from this server's network location.`,
    value: page.durationMs,
    weight: 1,
  });

  return checks;
}
