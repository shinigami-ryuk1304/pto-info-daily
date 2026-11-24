
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import sanitizeHtml from 'sanitize-html';
import { readHeroImageInput } from '../../lib/media-store';

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

function makeSlug(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
    .replace(/-+$/g, '');
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

export const POST: APIRoute = async ({ request, session }) => {
  if (!isSameOrigin(request)) {
    return json({ message: 'Request origin could not be verified.' }, 403);
  }

  if (!request.headers.get('Content-Type')?.toLowerCase().includes('application/json')) {
    return json({ message: 'Content-Type must be application/json.' }, 415);
  }

  if (!session) {
    return json({ message: 'Please sign in again.' }, 401);
  }

  const authorId = await session.get<string>('authorId');
  if (!authorId) return json({ message: 'Please sign in again.' }, 401);

  const db = env.DB;
  if (!db) return json({ message: 'The article database is unavailable.' }, 503);

  const author = await db
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
    await session.destroy();
    return json({ message: 'Your account is not authorised to create articles.' }, 403);
  }

  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return json({ message: 'The request body must contain valid JSON.' }, 400);
  }

  if (!isRecord(payload)) {
    return json({ message: 'Invalid article data.' }, 400);
  }

  const title = typeof payload.title === 'string' ? payload.title.trim() : '';
  const description =
    typeof payload.description === 'string' ? payload.description.trim() : '';
  const categoryValue =
    typeof payload.category === 'string' ? payload.category : '';
  const rawBody = typeof payload.body === 'string' ? payload.body : '';

  if (title.length < 5 || title.length > 180) {
    return json({ message: 'The title must contain 5–180 characters.' }, 400);
  }

  if (description.length < 20 || description.length > 320) {
    return json({ message: 'The description must contain 20–320 characters.' }, 400);
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
      { message: 'The article body must contain 50–100,000 characters of text.' },
      400,
    );
  }

  const heroImage = await readHeroImageInput(payload);

  if (!heroImage.ok) {
    return json({ message: heroImage.message }, 400);
  }

  const heroImageKey = heroImage.key ?? null;
  const imageAlt = heroImageKey ? heroImage.alt ?? null : null;

  const baseSlug = makeSlug(title);

  if (!baseSlug) {
    return json({ message: 'The title cannot be converted into a valid URL slug.' }, 400);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  try {
    let slug = baseSlug;
    let inserted = false;

    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        slug = `${baseSlug}-${crypto.randomUUID().slice(0, 8)}`;
      }

      try {
        await db
          .prepare(
            `INSERT INTO articles
              (id, slug, title, description, category, author_id, body,
               hero_image_key, image_alt,
               status, published_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', NULL, ?, ?)`,
          )
          .bind(
            id,
            slug,
            title,
            description,
            categoryValue,
            author.id,
            body,
            heroImageKey,
            imageAlt,
            now,
            now,
          )
          .run();

        inserted = true;
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (!message.toLowerCase().includes('unique')) throw error;
      }
    }

    if (!inserted) {
      return json({ message: 'Could not generate a unique article URL. Try again.' }, 409);
    }

    return json(
      {
        message: 'Draft saved successfully.',
        article: {
          id,
          slug,
          title,
          description,
          category: categoryValue,
          status: 'draft',
          updatedAt: now,
        },
      },
      201,
    );
  } catch (error) {
    console.error('Article creation failed:', error);
    return json({ message: 'Unable to save the draft. Please try again.' }, 500);
  }
};

export const GET: APIRoute = async ({ session }) => {
  if (!session) return json({ message: 'Please sign in again.' }, 401);

  const authorId = await session.get<string>('authorId');
  if (!authorId) return json({ message: 'Please sign in again.' }, 401);

  const db = env.DB;
  if (!db) return json({ message: 'The article database is unavailable.' }, 503);

  const author = await db
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
    await session.destroy();
    return json({ message: 'Your account is not authorised.' }, 403);
  }

  try {
    const query =
      author.role === 'writer'
        ? `SELECT id, slug, title, description, category, status,
                  review_status, created_at, updated_at, published_at
           FROM articles
           WHERE author_id = ?
           ORDER BY updated_at DESC
           LIMIT 100`
        : `SELECT id, slug, title, description, category, status,
                  review_status, created_at, updated_at, published_at
           FROM articles
           ORDER BY updated_at DESC
           LIMIT 100`;

    const result = await db
      .prepare(query)
      .bind(...(author.role === 'writer' ? [author.id] : []))
      .all();

    return json({ articles: result.results ?? [] });
  } catch (error) {
    console.error('Article listing failed:', error);
    return json({ message: 'Unable to load articles.' }, 500);
  }
};
