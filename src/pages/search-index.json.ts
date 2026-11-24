import { getPublishedArticles } from "../lib/public-articles";

export const prerender = false;

// Public search index: published articles only (D1 + non-draft Markdown).
export async function GET() {
  const articles = await getPublishedArticles();

  const searchIndex = articles.map((article) => ({
    title: article.data.title,
    description: article.data.description,
    category: article.data.category,
    author: article.data.author,
    pubDate: article.data.pubDate.toISOString(),
    heroImage: article.data.heroImage ?? "",
    imageAlt: article.data.imageAlt ?? "",
    url: `/news/${article.id}/`,
    body: article.plainText,
  }));

  return new Response(JSON.stringify(searchIndex), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=60",
    },
  });
}
