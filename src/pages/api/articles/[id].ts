import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import sanitizeHtml from 'sanitize-html';
import { deleteMedia, readHeroImageInput } from '../../../lib/media-store';

export const prerender = false;

const ALLOWED_CATEGORIES = [
  'news',
  'politics',
  'entertainment',
  'celebrity-news',
  'trending',
  'sports',
  'business',
  'lifestyle',
  'technology',
] as const;

type Category = (typeof ALLOWED_CATEGORIES)[number];

type AuthorRow = {
  id: string;
  role: string;
  active: number;
};

type ArticleRow = {
  id: string;
  slug: string;
  title: string;
  description: string;
  category: string;
  author_id: string;
  body: string;
  status: string;
  review_status: string;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  hero_image_key: string | null;
  image_alt: string | null;
};

function json(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) return false;

  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

function sanitiseArticleHtml(input: string): string {
  return sanitizeHtml(input, {
    allowedTags: [
      'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's',
      'h2', 'h3', 'ul', 'ol', 'li', 'blockquote',
      'a', 'img',
    ],
    allowedAttributes: {
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
      p: ['style'],
      h2: ['style'],
      h3: ['style'],
    },
    allowedStyles: {
      '*': {
        'text-align': [/^(left|right|center|justify)$/],
      },
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: {
      img: ['http', 'https'],
    },
    allowProtocolRelative: false,
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', {
        rel: 'noopener noreferrer nofollow',
        target: '_blank',
      }),
    },
  });
}

function extractPlainText(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [],
    allowedAttributes: {},
  })
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function getAuthor(
  authorId: string,
  destroySession: () => void | Promise<void>,
): Promise<AuthorRow | null> {
  const author = await env.DB
    .prepare(
      `SELECT id, role, active
       FROM authors
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(authorId)
    .first<AuthorRow>();

  if (
    !author ||
    author.active !== 1 ||
    !['writer', 'editor', 'admin'].includes(author.role)
  ) {
    await destroySession();
    return null;
  }

  return author;
}

function canManageArticle(author: AuthorRow, article: ArticleRow): boolean {
  if (author.role === 'admin' || author.role === 'editor') {
    return true;
  }

  return (
    author.role === 'writer' &&
    article.author_id === author.id &&
    article.status === 'draft' &&
    ['draft', 'changes_requested'].includes(article.review_status)
  );
}

export const GET: APIRoute = async ({ params, session }) => {
  if (!session) return json({ message: 'Please sign in again.' }, 401);

  const authorId = await session.get<string>('authorId');
  if (!authorId) return json({ message: 'Please sign in again.' }, 401);

  if (!env.DB) {
    return json({ message: 'The article database is unavailable.' }, 503);
  }

  const author = await getAuthor(authorId, () => session.destroy());

  if (!author) {
    return json({ message: 'Your account is not authorised.' }, 403);
  }

  const articleId = params.id;
  if (!articleId) return json({ message: 'Article ID is required.' }, 400);

  try {
    const article = await env.DB
      .prepare(
        `SELECT id, slug, title, description, category, author_id,
                body, status, review_status, created_at, updated_at,
                published_at, hero_image_key, image_alt
         FROM articles
         WHERE id = ?
         LIMIT 1`,
      )
      .bind(articleId)
      .first<ArticleRow>();

    if (!article) {
      return json({ message: 'Article not found.' }, 404);
    }

    if (!canManageArticle(author, article)) {
      return json(
        { message: 'You do not have permission to open this article for editing.' },
        403,
      );
    }

    return json({ article });
  } catch (error) {
    console.error('Article retrieval failed:', error);
    return json({ message: 'Unable to open this article.' }, 500);
  }
};

export const PATCH: APIRoute = async ({ request, params, session }) => {
  if (!isSameOrigin(request)) {
    return json({ message: 'Request origin could not be verified.' }, 403);
  }

  if (!request.headers.get('Content-Type')?.toLowerCase().includes('application/json')) {
    return json({ message: 'Content-Type must be application/json.' }, 415);
  }

  if (!session) return json({ message: 'Please sign in again.' }, 401);

  const authorId = await session.get<string>('authorId');
  if (!authorId) return json({ message: 'Please sign in again.' }, 401);

  if (!env.DB) {
    return json({ message: 'The article database is unavailable.' }, 503);
  }

  const author = await getAuthor(authorId, () => session.destroy());

  if (!author) {
    return json({ message: 'Your account is not authorised.' }, 403);
  }

  const articleId = params.id;
  if (!articleId) return json({ message: 'Article ID is required.' }, 400);

  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return json({ message: 'The request body must contain valid JSON.' }, 400);
  }

  if (!isRecord(payload)) {
    return json({ message: 'Invalid article data.' }, 400);
  }

  try {
    const article = await env.DB
      .prepare(
        `SELECT id, slug, title, description, category, author_id,
                body, status, review_status, created_at, updated_at,
                published_at, hero_image_key, image_alt
         FROM articles
         WHERE id = ?
         LIMIT 1`,
      )
      .bind(articleId)
      .first<ArticleRow>();

    if (!article) {
      return json({ message: 'Article not found.' }, 404);
    }

    if (!canManageArticle(author, article)) {
      return json(
        { message: 'You do not have permission to manage this article.' },
        403,
      );
    }

    const now = new Date().toISOString();
    const action = typeof payload.action === 'string' ? payload.action : '';

    // Writer action: submit a draft (or a returned article) for editorial review.
    // canManageArticle() above already confirmed the writer owns it and that it
    // is an unpublished draft / changes_requested article. After this the
    // article is locked against writer edits until an editor returns it.
    if (action === 'submit') {
      if (
        article.status !== 'draft' ||
        !['draft', 'changes_requested'].includes(article.review_status)
      ) {
        return json(
          { message: 'Only drafts or returned articles can be submitted for review.' },
          409,
        );
      }

      const plainText = extractPlainText(article.body ?? '');

      if (plainText.length < 50) {
        return json(
          { message: 'Add at least 50 characters of article text before submitting.' },
          400,
        );
      }

      const result = await env.DB
        .prepare(
          `UPDATE articles
           SET review_status = 'submitted',
               submitted_at = ?,
               updated_at = ?
           WHERE id = ?
             AND status = 'draft'
             AND review_status IN ('draft', 'changes_requested')`,
        )
        .bind(now, now, articleId)
        .run();

      if (!result.meta.changes) {
        return json({ message: 'The article could not be submitted. Refresh and try again.' }, 409);
      }

      return json({
        message: 'Article submitted for review. It is now locked until an editor reviews it.',
        action,
      });
    }

    // Editorial and publication actions are restricted to administrators and editors.
    // Each UPDATE also checks the current state in its WHERE clause, so steps
    // cannot be skipped (e.g. publishing an article that was never approved).
    if (action) {
      if (!['admin', 'editor'].includes(author.role)) {
        return json(
          { message: 'Only an administrator or editor can perform this action.' },
          403,
        );
      }

      let result: D1Result;

      switch (action) {
        case 'approve':
          if (article.status !== 'draft' || article.review_status !== 'submitted') {
            return json(
              { message: 'Only articles submitted for review can be approved.' },
              409,
            );
          }

          result = await env.DB
            .prepare(
              `UPDATE articles
               SET review_status = 'approved',
                   reviewed_at = ?,
                   reviewer_id = ?,
                   updated_at = ?
               WHERE id = ?
                 AND status = 'draft'
                 AND review_status = 'submitted'`,
            )
            .bind(now, author.id, now, articleId)
            .run();
          break;

        case 'request_changes':
          if (article.status === 'published') {
            return json(
              { message: 'Unpublish this article before requesting corrections.' },
              409,
            );
          }

          if (!['submitted', 'approved'].includes(article.review_status)) {
            return json(
              { message: 'Changes can only be requested on submitted or approved articles.' },
              409,
            );
          }

          result = await env.DB
            .prepare(
              `UPDATE articles
               SET review_status = 'changes_requested',
                   reviewed_at = ?,
                   reviewer_id = ?,
                   updated_at = ?
               WHERE id = ?
                 AND status = 'draft'
                 AND review_status IN ('submitted', 'approved')`,
            )
            .bind(now, author.id, now, articleId)
            .run();
          break;

        case 'publish':
          // Approval is a separate, required step before publication.
          if (article.status === 'published') {
            return json({ message: 'This article is already published.' }, 409);
          }

          if (article.review_status !== 'approved') {
            return json(
              { message: 'Approve this article before publishing it.' },
              409,
            );
          }

          result = await env.DB
            .prepare(
              `UPDATE articles
               SET status = 'published',
                   published_at = COALESCE(published_at, ?),
                   updated_at = ?
               WHERE id = ?
                 AND status = 'draft'
                 AND review_status = 'approved'`,
            )
            .bind(now, now, articleId)
            .run();
          break;

        case 'unpublish':
          // The article stays approved, so it can be republished later
          // or returned to its writer with "Request changes".
          if (article.status !== 'published') {
            return json({ message: 'This article is not published.' }, 409);
          }

          result = await env.DB
            .prepare(
              `UPDATE articles
               SET status = 'draft',
                   published_at = NULL,
                   updated_at = ?
               WHERE id = ?
                 AND status = 'published'`,
            )
            .bind(now, articleId)
            .run();
          break;

        default:
          return json({ message: 'Unknown article action.' }, 400);
      }

      if (!result.meta.changes) {
        return json({ message: 'The article could not be updated.' }, 409);
      }

      return json({
        message:
          action === 'approve'
            ? 'Article approved successfully.'
            : action === 'request_changes'
              ? 'Corrections requested successfully.'
              : action === 'publish'
                ? 'Article published successfully.'
                : 'Article unpublished successfully.',
        action,
      });
    }

    // Normal article content editing.
    const title = typeof payload.title === 'string' ? payload.title.trim() : '';
    const description =
      typeof payload.description === 'string' ? payload.description.trim() : '';
    const categoryValue =
      typeof payload.category === 'string' ? payload.category : '';
    const rawBody = typeof payload.body === 'string' ? payload.body : '';

    if (title.length < 5 || title.length > 180) {
      return json({ message: 'The title must contain 5-180 characters.' }, 400);
    }

    if (description.length < 20 || description.length > 320) {
      return json({ message: 'The description must contain 20-320 characters.' }, 400);
    }

    if (!ALLOWED_CATEGORIES.includes(categoryValue as Category)) {
      return json({ message: 'Select a valid article category.' }, 400);
    }

    if (rawBody.length > 150_000) {
      return json({ message: 'The article body is too large.' }, 400);
    }

    const body = sanitiseArticleHtml(rawBody);
    const plainText = extractPlainText(body);

    if (plainText.length < 50 || plainText.length > 100_000) {
      return json(
        { message: 'The article body must contain 50-100,000 characters of text.' },
        400,
      );
    }

    // Featured image: not sent = keep current; null = remove; key = replace.
    const heroImage = await readHeroImageInput(payload);

    if (!heroImage.ok) {
      return json({ message: heroImage.message }, 400);
    }

    const heroImageKey =
      heroImage.key === undefined ? article.hero_image_key : heroImage.key;
    const imageAlt = heroImageKey
      ? heroImage.alt === undefined
        ? article.image_alt
        : heroImage.alt
      : null;

    const result = await env.DB
      .prepare(
        `UPDATE articles
         SET title = ?,
             description = ?,
             category = ?,
             body = ?,
             hero_image_key = ?,
             image_alt = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        title,
        description,
        categoryValue,
        body,
        heroImageKey,
        imageAlt,
        now,
        articleId,
      )
      .run();

    if (!result.meta.changes) {
      return json({ message: 'The article could not be updated.' }, 409);
    }

    // The old featured image is no longer used: remove it from storage.
    if (article.hero_image_key && article.hero_image_key !== heroImageKey) {
      await deleteMedia(article.hero_image_key);
    }

    return json({
      message: 'Article changes saved successfully.',
      article: {
        id: article.id,
        title,
        description,
        category: categoryValue,
        updated_at: now,
      },
    });
  } catch (error) {
    console.error('Article update failed:', error);
    return json(
      { message: 'Unable to update this article. Please try again.' },
      500,
    );
  }
};

export const DELETE: APIRoute = async ({ request, params, session }) => {
  if (!isSameOrigin(request)) {
    return json({ message: 'Request origin could not be verified.' }, 403);
  }

  if (!session) return json({ message: 'Please sign in again.' }, 401);

  const authorId = await session.get<string>('authorId');
  if (!authorId) return json({ message: 'Please sign in again.' }, 401);

  if (!env.DB) {
    return json({ message: 'The article database is unavailable.' }, 503);
  }

  const author = await getAuthor(authorId, () => session.destroy());

  if (!author) {
    return json({ message: 'Your account is not authorised.' }, 403);
  }

  const articleId = params.id;
  if (!articleId) return json({ message: 'Article ID is required.' }, 400);

  try {
    const article = await env.DB
      .prepare(
        `SELECT id, slug, title, description, category, author_id,
                body, status, review_status, created_at, updated_at,
                published_at, hero_image_key, image_alt
         FROM articles
         WHERE id = ?
         LIMIT 1`,
      )
      .bind(articleId)
      .first<ArticleRow>();

    if (!article) {
      return json({ message: 'Article not found.' }, 404);
    }

    if (!canManageArticle(author, article)) {
      return json(
        { message: 'You do not have permission to delete this article.' },
        403,
      );
    }

    const result = await env.DB
      .prepare('DELETE FROM articles WHERE id = ?')
      .bind(articleId)
      .run();

    if (!result.meta.changes) {
      return json({ message: 'The article could not be deleted.' }, 409);
    }

    await deleteMedia(article.hero_image_key);

    return json({ message: 'Article deleted successfully.' });
  } catch (error) {
    console.error('Article deletion failed:', error);
    return json({ message: 'Unable to delete this article. Please try again.' }, 500);
  }
};