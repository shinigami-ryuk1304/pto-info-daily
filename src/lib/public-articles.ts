// PTO Info Daily — public article source.
//
// Single place the public website (homepage, article pages, category
// pages, search index) gets its articles from.
//
// Sources, merged together:
//   1. Cloudflare D1  — articles written in the writers' portal.
//                       ONLY rows with status = 'published' are returned.
//   2. Markdown files — src/content/articles/*.md with draft: false.
//
// If a D1 article and a Markdown file share the same slug, D1 wins.
// If D1 is unreachable, the site falls back to Markdown only instead
// of crashing.

import { getCollection, type CollectionEntry } from "astro:content";
import { env } from "cloudflare:workers";
import sanitizeHtml from "sanitize-html";
import { isMediaKey, mediaUrl } from "./media-store";

export type PublicArticleData = {
  title: string;
  description: string;
  category: string;
  author: string;
  pubDate: Date;
  updatedDate?: Date;
  heroImage?: string;
  imageAlt?: string;
};

// Same shape as a content-collection entry (`id` + `data`) so existing
// page markup keeps working unchanged.
export type PublicArticle =
  | {
      source: "d1";
      id: string; // the slug
      data: PublicArticleData;
      html: string; // sanitised article body
      plainText: string;
    }
  | {
      source: "markdown";
      id: string; // the slug
      data: PublicArticleData;
      entry: CollectionEntry<"articles">;
      plainText: string;
    };

type PublishedRow = {
  slug: string;
  title: string;
  description: string;
  category: string;
  body: string;
  hero_image_key: string | null;
  image_alt: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
  author_name: string | null;
};

const PUBLISHED_COLUMNS = `
  a.slug, a.title, a.description, a.category, a.body,
  a.hero_image_key, a.image_alt,
  a.published_at, a.created_at, a.updated_at,
  au.display_name AS author_name
`;

// Defence in depth: bodies are sanitised when saved, and again here
// before they are shown publicly. Rules match the article API.
export function sanitiseArticleHtml(input: string): string {
  return sanitizeHtml(input, {
    allowedTags: [
      "p", "br", "strong", "b", "em", "i", "u", "s",
      "h2", "h3", "ul", "ol", "li", "blockquote",
      "a", "img",
    ],
    allowedAttributes: {
      a: ["href", "name", "target", "rel"],
      img: ["src", "alt", "title", "width", "height", "loading"],
      p: ["style"],
      h2: ["style"],
      h3: ["style"],
    },
    allowedStyles: {
      "*": {
        "text-align": [/^(left|right|center|justify)$/],
      },
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: {
      img: ["http", "https"],
    },
    allowProtocolRelative: false,
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", {
        rel: "noopener noreferrer nofollow",
        target: "_blank",
      }),
    },
  });
}

function htmlToPlainText(html: string): string {
  // Space before each tag so "</p><p>" doesn't glue words together.
  return sanitizeHtml(html.replace(/</g, " <"), { allowedTags: [], allowedAttributes: {} })
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// Turns the stored hero_image_key into a URL the page can use:
// an uploaded image key ("img/2026/11/<uuid>.webp") becomes /media/<key>;
// absolute http(s) URLs and site-relative paths are also accepted.
export function heroImageUrl(key: string | null | undefined): string | undefined {
  if (!key) return undefined;
  const value = key.trim();
  if (isMediaKey(value as unknown)) return mediaUrl(value);
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || url.protocol === "http:") return url.href;
  } catch {
    // Not a URL — ignore.
  }
  return undefined;
}

function toDate(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  // D1 CURRENT_TIMESTAMP gives "YYYY-MM-DD HH:MM:SS" (UTC, no zone).
  const normalised = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const date = new Date(normalised);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function fromRow(row: PublishedRow): PublicArticle {
  const html = sanitiseArticleHtml(row.body ?? "");
  const pubDate =
    toDate(row.published_at) ?? toDate(row.created_at) ?? new Date(0);
  const updated = toDate(row.updated_at);

  return {
    source: "d1",
    id: row.slug,
    html,
    plainText: htmlToPlainText(html),
    data: {
      title: row.title,
      description: row.description,
      category: row.category,
      author: row.author_name?.trim() || "PTO Info Daily",
      pubDate,
      // Only show "Updated" when it was edited at least an hour after publishing.
      updatedDate:
        updated && updated.getTime() - pubDate.getTime() > 60 * 60 * 1000
          ? updated
          : undefined,
      heroImage: heroImageUrl(row.hero_image_key),
      imageAlt: row.image_alt ?? undefined,
    },
  };
}

function fromEntry(entry: CollectionEntry<"articles">): PublicArticle {
  return {
    source: "markdown",
    id: entry.id.replace(/\.md$/, ""),
    entry,
    plainText: entry.body ?? "",
    data: {
      title: entry.data.title,
      description: entry.data.description,
      category: entry.data.category,
      author: entry.data.author,
      pubDate: entry.data.pubDate,
      updatedDate: entry.data.updatedDate,
      heroImage: entry.data.heroImage,
      imageAlt: entry.data.imageAlt,
    },
  };
}

async function getMarkdownArticles(): Promise<PublicArticle[]> {
  const entries = await getCollection("articles", ({ data }) => data.draft !== true);
  return entries.map(fromEntry);
}

async function getD1Articles(category?: string): Promise<PublicArticle[]> {
  const db = env.DB;
  if (!db) return [];

  try {
    const statement = category
      ? db
          .prepare(
            `SELECT ${PUBLISHED_COLUMNS}
             FROM articles a
             LEFT JOIN authors au ON au.id = a.author_id
             WHERE a.status = 'published' AND a.category = ?
             ORDER BY a.published_at DESC
             LIMIT 200`,
          )
          .bind(category)
      : db.prepare(
          `SELECT ${PUBLISHED_COLUMNS}
           FROM articles a
           LEFT JOIN authors au ON au.id = a.author_id
           WHERE a.status = 'published'
           ORDER BY a.published_at DESC
           LIMIT 200`,
        );

    const result = await statement.all<PublishedRow>();
    return (result.results ?? []).map(fromRow);
  } catch (error) {
    console.error("Loading published articles from D1 failed:", error);
    return [];
  }
}

function mergeAndSort(d1: PublicArticle[], markdown: PublicArticle[]): PublicArticle[] {
  const seen = new Set(d1.map((article) => article.id));
  return [...d1, ...markdown.filter((article) => !seen.has(article.id))].sort(
    (a, b) => b.data.pubDate.getTime() - a.data.pubDate.getTime(),
  );
}

/** All publicly visible articles, newest first. */
export async function getPublishedArticles(): Promise<PublicArticle[]> {
  const [d1, markdown] = await Promise.all([getD1Articles(), getMarkdownArticles()]);
  return mergeAndSort(d1, markdown);
}

/** Publicly visible articles in one category, newest first. */
export async function getPublishedArticlesByCategory(
  category: string,
): Promise<PublicArticle[]> {
  const [d1, markdown] = await Promise.all([
    getD1Articles(category),
    getMarkdownArticles(),
  ]);
  return mergeAndSort(
    d1,
    markdown.filter((article) => article.data.category === category),
  );
}

/** One publicly visible article by slug, or null (drafts and unknown slugs). */
export async function getPublishedArticleBySlug(
  slug: string | undefined,
): Promise<PublicArticle | null> {
  if (!slug || slug.length > 200) return null;

  const db = env.DB;
  if (db) {
    try {
      const row = await db
        .prepare(
          `SELECT ${PUBLISHED_COLUMNS}
           FROM articles a
           LEFT JOIN authors au ON au.id = a.author_id
           WHERE a.slug = ? AND a.status = 'published'
           LIMIT 1`,
        )
        .bind(slug)
        .first<PublishedRow>();

      if (row) return fromRow(row);
    } catch (error) {
      console.error("Loading article from D1 failed:", error);
    }
  }

  const markdown = await getMarkdownArticles();
  return markdown.find((article) => article.id === slug) ?? null;
}
