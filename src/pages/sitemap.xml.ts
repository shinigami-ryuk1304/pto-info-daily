import type { APIRoute } from "astro";
import { getPublishedArticles } from "../lib/public-articles";
import { SITE, STANDARDS_PAGES } from "../lib/site";

export const prerender = false;

const CATEGORY_SLUGS = [
  "news",
  "politics",
  "entertainment",
  "celebrity-news",
  "trending",
  "sports",
  "business",
  "lifestyle",
  "technology",
];

const STATIC_PATHS = [
  "/",
  "/leadership/",
  "/sponsorship/",
  ...STANDARDS_PAGES.map((page) => page.href),
];

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function urlEntry(path: string, lastmod?: Date): string {
  const loc = escapeXml(new URL(path, SITE.url).href);
  return lastmod
    ? `  <url><loc>${loc}</loc><lastmod>${lastmod.toISOString()}</lastmod></url>`
    : `  <url><loc>${loc}</loc></url>`;
}

// Lists every public page and every published article for search engines.
// Drafts, submitted and approved-but-unpublished articles never appear.
export const GET: APIRoute = async () => {
  const articles = await getPublishedArticles();
  const newest = articles[0]?.data.pubDate;

  const entries = [
    ...STATIC_PATHS.map((path) => urlEntry(path, path === "/" ? newest : undefined)),
    ...CATEGORY_SLUGS.map((slug) => {
      const latest = articles.find((article) => article.data.category === slug);
      return urlEntry(`/category/${slug}/`, latest?.data.pubDate);
    }),
    ...articles.map((article) =>
      urlEntry(
        `/news/${article.id}/`,
        article.data.updatedDate ?? article.data.pubDate,
      ),
    ),
  ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.join("\n")}
</urlset>
`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=900",
    },
  });
};
