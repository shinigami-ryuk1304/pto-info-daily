
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const prerender = false;

const MAX_WRITER_ACCOUNTS = 3;
const INVITATION_LIFETIME_SECONDS = 24 * 60 * 60;

function jsonResponse(
  message: string,
  status: number,
  extra: Record<string, unknown> = {},
) {
  return Response.json(
    { message, ...extra },
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}

function createInvitationToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));

  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function hashInvitationToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', bytes);

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export const POST: APIRoute = async ({ request, session }) => {
  // Require a same-origin browser request to reduce CSRF risk.
  const origin = request.headers.get('Origin');

  if (!origin || origin !== new URL(request.url).origin) {
    return jsonResponse('Request rejected.', 403);
  }

  if (!session) {
    return jsonResponse('Please sign in again.', 401);
  }

  const authorId = await session.get('authorId');

  if (typeof authorId !== 'string' || !authorId) {
    return jsonResponse('Administrator access required.', 403);
  }

  const db = env.DB;

  if (!db) {
    console.error('D1 database binding is unavailable.');
    return jsonResponse('Service temporarily unavailable.', 503);
  }

  try {
    // Always check the current database role, not just the session.
    const administrator = await db
      .prepare(
        `SELECT id
         FROM authors
         WHERE id = ?
           AND role = 'admin'
           AND active = 1
         LIMIT 1`,
      )
      .bind(authorId)
      .first<{ id: string }>();

    if (!administrator) {
      await session.destroy();
      return jsonResponse('Administrator access required.', 403);
    }

    const contentType = request.headers.get('Content-Type') ?? '';

    if (!contentType.toLowerCase().includes('application/json')) {
      return jsonResponse('Send the form as JSON.', 415);
    }

    let payload: unknown;

    try {
      payload = await request.json();
    } catch {
      return jsonResponse('Invalid request body.', 400);
    }

    if (!isRecord(payload)) {
      return jsonResponse('Invalid writer details.', 400);
    }

    const displayName =
      typeof payload.displayName === 'string'
        ? payload.displayName.trim()
        : '';

    const email =
      typeof payload.email === 'string'
        ? payload.email.trim().toLowerCase()
        : '';

    if (
      displayName.length < 2 ||
      displayName.length > 100 ||
      email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      return jsonResponse(
        'Enter a valid writer name and email address.',
        400,
      );
    }

    // Provide clear feedback before attempting the atomic insert.
    const existing = await db
      .prepare(
        `SELECT id
         FROM authors
         WHERE email = ?
         LIMIT 1`,
      )
      .bind(email)
      .first<{ id: string }>();

    if (existing) {
      return jsonResponse(
        'An account already exists for this email address.',
        409,
      );
    }

    const counts = await db
      .prepare(
        `SELECT COUNT(*) AS total
         FROM authors
         WHERE role = 'writer'`,
      )
      .first<{ total: number }>();

    if ((counts?.total ?? 0) >= MAX_WRITER_ACCOUNTS) {
      return jsonResponse(
        'The maximum of three writer accounts has been reached.',
        409,
      );
    }

    const newAuthorId = crypto.randomUUID();
    const invitationId = crypto.randomUUID();
    const token = createInvitationToken();
    const tokenHash = await hashInvitationToken(token);
    const expiresAt =
      Math.floor(Date.now() / 1000) + INVITATION_LIFETIME_SECONDS;

    /*
     * D1 batch executes these statements transactionally.
     *
     * The conditional author insert rechecks the writer cap and email
     * uniqueness inside the transaction, preventing two concurrent
     * requests from bypassing the account limit.
     *
     * The invitation is inserted only if the author was created.
     * A failure in the batch rolls back the transaction.
     */
    const results = await db.batch([
      db
        .prepare(
          `INSERT INTO authors (
             id,
             display_name,
             email,
             role,
             active,
             password_hash
           )
           SELECT ?, ?, ?, 'writer', 0, NULL
           WHERE
             (SELECT COUNT(*)
              FROM authors
              WHERE role = 'writer') < ?
             AND NOT EXISTS (
               SELECT 1
               FROM authors
               WHERE email = ?
             )`,
        )
        .bind(
          newAuthorId,
          displayName,
          email,
          MAX_WRITER_ACCOUNTS,
          email,
        ),

      db
        .prepare(
          `INSERT INTO writer_invitations (
             id,
             author_id,
             token_hash,
             expires_at
           )
           SELECT ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1
             FROM authors
             WHERE id = ?
               AND role = 'writer'
               AND active = 0
           )`,
        )
        .bind(
          invitationId,
          newAuthorId,
          tokenHash,
          expiresAt,
          newAuthorId,
        ),
    ]);

    const authorCreated = (results[0]?.meta?.changes ?? 0) === 1;
    const invitationCreated = (results[1]?.meta?.changes ?? 0) === 1;

    if (!authorCreated || !invitationCreated) {
      return jsonResponse(
        'The writer account could not be created. The account limit may have been reached, or the email may already be registered.',
        409,
      );
    }

    const invitationUrl = new URL(
      '/writers/accept-invitation/',
      request.url,
    );

    invitationUrl.searchParams.set('token', token);

    return jsonResponse(
      'Writer account created. The invitation expires in 24 hours.',
      201,
      {
        writer: {
          id: newAuthorId,
          displayName,
          email,
          role: 'writer',
          active: false,
        },
        invitationUrl: invitationUrl.toString(),
        expiresAt,
      },
    );
  } catch (error) {
    console.error('Admin writer creation failed:', error);

    return jsonResponse(
      'The writer account could not be created. Please try again.',
      500,
    );
  }
};
