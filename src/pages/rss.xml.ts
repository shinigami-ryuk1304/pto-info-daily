import type { APIRoute } from "astro";
import { getPublishedArticles } from "../lib/public-articles";
import { SITE } from "../lib/site";

export const prerender = false;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function titleCase(slug: string): string {
  return slug
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// RSS feed of the 30 most recent published stories (headline + summary).
export const GET: APIRoute = async () => {
  const articles = (await getPublishedArticles()).slice(0, 30);
  const feedUrl = new URL("/rss.xml", SITE.url).href;

  const items = articles
    .map((article) => {
      const link = new URL(`/news/${article.id}/`, SITE.url).href;
      const image = article.data.heroImage
        ? new URL(article.data.heroImage, SITE.url).href
        : undefined;

      return `    <item>
      <title>${escapeXml(article.data.title)}</title>
      <link>${escapeXml(link)}</link>
      <guid isPermaLink="true">${escapeXml(link)}</guid>
      <description>${escapeXml(article.data.description)}</description>
      <pubDate>${article.data.pubDate.toUTCString()}</pubDate>
      <category>${escapeXml(titleCase(article.data.category))}</category>
      <dc:creator>${escapeXml(article.data.author)}</dc:creator>${
        image
          ? `
      <media:content url="${escapeXml(image)}" medium="image" />`
          : ""
      }
    </item>`;
    })
    .join("\n");

  const lastBuild = articles[0]?.data.pubDate ?? new Date();

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:atom="http://www.w3.org/2005/Atom"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>${escapeXml(SITE.name)}</title>
    <link>${escapeXml(SITE.url)}/</link>
    <description>${escapeXml(`${SITE.tagline} Nigerian news, politics, entertainment, business, sports, lifestyle and technology.`)}</description>
    <language>en-ng</language>
    <lastBuildDate>${lastBuild.toUTCString()}</lastBuildDate>
    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>
`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=900",
    },
  });
};
