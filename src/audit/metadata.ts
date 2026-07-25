import * as cheerio from "cheerio";
import type { PageMetadata } from "./types.js";

/**
 * Single pass over the DOM producing everything the SEO/metadata checks need.
 * Parsing is the expensive part of an audit, so it happens once and the checks
 * read from this snapshot.
 */

function textOf(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed === "" ? null : collapsed;
}

/** Minimal structural view of a parsed DOM node, to avoid depending on domhandler directly. */
interface DomNode {
  type: string;
  data?: string;
  children?: DomNode[];
}

/**
 * Concatenating `.text()` glues adjacent elements together, so `<h1>A</h1><p>B</p>`
 * reads as one word "AB". That is invisible on pretty-printed HTML, which has
 * whitespace between tags, but badly undercounts minified pages. Joining the
 * text nodes with a space keeps word boundaries intact either way.
 */
function visibleText(root: DomNode | undefined): string {
  if (!root) return "";
  const parts: string[] = [];
  const walk = (node: DomNode): void => {
    if (node.type === "text") {
      if (node.data) parts.push(node.data);
      return;
    }
    node.children?.forEach(walk);
  };
  walk(root);
  return parts.join(" ");
}

export function extractMetadata(html: string, finalUrl: string): PageMetadata {
  const $ = cheerio.load(html);
  const base = new URL(finalUrl);

  const openGraph: Record<string, string> = {};
  const twitter: Record<string, string> = {};
  let description: string | null = null;
  let robots: string | null = null;
  let viewport: string | null = null;
  let charset: string | null = $("meta[charset]").first().attr("charset") ?? null;

  $("meta").each((_, element) => {
    const meta = $(element);
    const content = textOf(meta.attr("content"));
    const name = meta.attr("name")?.toLowerCase().trim();
    const property = meta.attr("property")?.toLowerCase().trim();
    const httpEquiv = meta.attr("http-equiv")?.toLowerCase().trim();

    if (httpEquiv === "content-type" && !charset) {
      charset = content?.match(/charset\s*=\s*([\w-]+)/i)?.[1] ?? null;
    }
    if (!content) return;

    if (name === "description" && !description) description = content;
    if (name === "robots" && !robots) robots = content;
    if (name === "viewport" && !viewport) viewport = content;
    if (property?.startsWith("og:")) openGraph[property] = content;
    // Twitter tags appear under both `name` and `property` in the wild.
    if (name?.startsWith("twitter:")) twitter[name] = content;
    else if (property?.startsWith("twitter:")) twitter[property] = content;
  });

  const headingCounts: Record<string, number> = {};
  for (const level of ["h1", "h2", "h3", "h4", "h5", "h6"]) {
    headingCounts[level] = $(level).length;
  }

  const h1s = $("h1")
    .map((_, element) => textOf($(element).text()) ?? "")
    .get()
    .filter((value) => value !== "");

  const images = $("img");
  let missingAlt = 0;
  images.each((_, element) => {
    const alt = $(element).attr("alt");
    // A present-but-empty alt is the correct markup for decorative images.
    if (alt === undefined) missingAlt += 1;
  });

  let internal = 0;
  let external = 0;
  let nofollow = 0;
  const anchors = $("a[href]");
  anchors.each((_, element) => {
    const href = $(element).attr("href");
    if (!href) return;
    if (/^(mailto:|tel:|javascript:|#)/i.test(href.trim())) return;
    try {
      const resolved = new URL(href, base);
      if (resolved.hostname === base.hostname) internal += 1;
      else external += 1;
    } catch {
      return;
    }
    if (/\bnofollow\b/i.test($(element).attr("rel") ?? "")) nofollow += 1;
  });

  const structuredDataTypes = new Set<string>();
  $('script[type="application/ld+json"]').each((_, element) => {
    const raw = $(element).text();
    if (!raw.trim()) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      const collect = (node: unknown): void => {
        if (Array.isArray(node)) {
          node.forEach(collect);
          return;
        }
        if (node && typeof node === "object") {
          const type = (node as Record<string, unknown>)["@type"];
          if (typeof type === "string") structuredDataTypes.add(type);
          else if (Array.isArray(type)) {
            type.filter((t): t is string => typeof t === "string").forEach((t) => structuredDataTypes.add(t));
          }
          const graph = (node as Record<string, unknown>)["@graph"];
          if (graph) collect(graph);
        }
      };
      collect(parsed);
    } catch {
      // Malformed JSON-LD is reported as absent structured data rather than
      // failing the whole audit.
    }
  });

  const canonicalHref = $('link[rel="canonical"]').first().attr("href");
  let canonical: string | null = null;
  if (canonicalHref) {
    try {
      canonical = new URL(canonicalHref, base).toString();
    } catch {
      canonical = textOf(canonicalHref);
    }
  }

  const faviconHref = $('link[rel~="icon"]').first().attr("href");
  let favicon: string | null = null;
  if (faviconHref) {
    try {
      favicon = new URL(faviconHref, base).toString();
    } catch {
      favicon = textOf(faviconHref);
    }
  }

  const bodyClone = $("body").clone();
  bodyClone.find("script, style, noscript, template").remove();
  const bodyText = textOf(visibleText(bodyClone.get(0))) ?? "";
  const wordCount = bodyText === "" ? 0 : bodyText.split(/\s+/).length;

  const title = textOf($("title").first().text());

  return {
    title,
    titleLength: title?.length ?? 0,
    description,
    descriptionLength: description ? (description as string).length : 0,
    canonical,
    robots,
    viewport,
    lang: textOf($("html").attr("lang")),
    charset: charset ? charset.toLowerCase() : null,
    favicon,
    h1s,
    headingCounts,
    images: { total: images.length, missingAlt },
    links: { total: anchors.length, internal, external, nofollow },
    openGraph,
    twitter,
    structuredDataTypes: [...structuredDataTypes],
    wordCount,
  };
}
