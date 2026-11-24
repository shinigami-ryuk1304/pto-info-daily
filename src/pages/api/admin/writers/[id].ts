
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const prerender = false;

function jsonResponse(message: string, status: number, extra: Record<string, unknown> = {}) {
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

function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('Origin');

  if (!origin) return false;

  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

type SessionLike = {
  get<T>(key: string): Promise<T | undefined>;
  destroy(): void;
};

async function getAdministrator(session: SessionLike | undefined) {
  if (!session) return null;

  const authorId = await session.get('authorId');

  if (typeof authorId !== 'string' || !authorId) return null;

  const administrator = await env.DB.prepare(
    `SELECT id
     FROM authors
     WHERE id = ?
       AND role = 'admin'
       AND active = 1
     LIMIT 1`,
  )
    .bind(authorId)
    .first<{ id: string }>();

  return administrator ?? null;
}

export const PATCH: APIRoute = async ({ request, session, params }) => {
  if (!isSameOrigin(request)) {
    return jsonResponse('Request rejected.', 403);
  }

  if (!session) {
    return jsonResponse('Please sign in again.', 401);
  }

  const db = env.DB;

  if (!db) {
    return jsonResponse('Database unavailable.', 503);
  }

  try {
    const administrator = await getAdministrator(session);

    if (!administrator) {
      await session.destroy();
      return jsonResponse('Administrator access required.', 403);
    }

    const writerId = params.id;

    if (!writerId || writerId === administrator.id) {
      return jsonResponse('Invalid writer account.', 400);
    }

    if (!request.headers.get('Content-Type')?.toLowerCase().includes('application/json')) {
      return jsonResponse('Send the request as JSON.', 415);
    }

    let payload: unknown;

    try {
      payload = await request.json();
    } catch {
      return jsonResponse('Invalid request body.', 400);
    }

    if (
      typeof payload !== 'object' ||
      payload === null ||
      !('action' in payload) ||
      !['suspend', 'reactivate'].includes(String(payload.action))
    ) {
      return jsonResponse('Choose a valid account action.', 400);
    }

    const active = payload.action === 'reactivate' ? 1 : 0;

    const result = await db.prepare(
      `UPDATE authors
       SET active = ?
       WHERE id = ?
         AND role = 'writer'
         AND id != ?`,
    )
      .bind(active, writerId, administrator.id)
      .run();

    if ((result.meta?.changes ?? 0) !== 1) {
      return jsonResponse('Writer account not found or already unavailable.', 404);
    }

    return jsonResponse(
      active === 1
        ? 'Writer account reactivated successfully.'
        : 'Writer account suspended successfully.',
      200,
      { active: active === 1 },
    );
  } catch (error) {
    console.error('Writer account update failed:', error);
    return jsonResponse('Unable to update the writer account.', 500);
  }
};

export const DELETE: APIRoute = async ({ request, session, params }) => {
  if (!isSameOrigin(request)) {
    return jsonResponse('Request rejected.', 403);
  }

  if (!session) {
    return jsonResponse('Please sign in again.', 401);
  }

  const db = env.DB;

  if (!db) {
    return jsonResponse('Database unavailable.', 503);
  }

  try {
    const administrator = await getAdministrator(session);

    if (!administrator) {
      await session.destroy();
      return jsonResponse('Administrator access required.', 403);
    }

    const writerId = params.id;

    if (!writerId || writerId === administrator.id) {
      return jsonResponse('Invalid writer account.', 400);
    }

    const writer = await db.prepare(
      `SELECT id, display_name
       FROM authors
       WHERE id = ?
         AND role = 'writer'
       LIMIT 1`,
    )
      .bind(writerId)
      .first<{ id: string; display_name: string }>();

    if (!writer) {
      return jsonResponse('Writer account not found.', 404);
    }

    /*
     * D1 batch runs transactionally:
     * 1. Transfer the writer's articles to the administrator.
     * 2. Remove the writer's invitation records.
     * 3. Delete the writer account.
     *
     * The articles themselves are preserved.
     */
    const results = await db.batch([
      db.prepare(
        `UPDATE articles
         SET author_id = ?,
             updated_at = ?
         WHERE author_id = ?
           AND EXISTS (
             SELECT 1
             FROM authors
             WHERE id = ?
               AND role = 'admin'
               AND active = 1
           )`,
      ).bind(administrator.id, new Date().toISOString(), writerId, administrator.id),

      db.prepare(
        `DELETE FROM writer_invitations
         WHERE author_id = ?`,
      ).bind(writerId),

      db.prepare(
        `DELETE FROM authors
         WHERE id = ?
           AND role = 'writer'
           AND EXISTS (
             SELECT 1
             FROM authors
             WHERE id = ?
               AND role = 'admin'
               AND active = 1
           )`,
      ).bind(writerId, administrator.id),
    ]);

    if ((results[2]?.meta?.changes ?? 0) !== 1) {
      return jsonResponse('The writer account could not be removed.', 409);
    }

    return jsonResponse(
      `Writer account "${writer.display_name}" was removed. Their articles have been transferred to the administrator.`,
      200,
    );
  } catch (error) {
    console.error('Writer account removal failed:', error);
    return jsonResponse('Unable to remove the writer account. No changes should be assumed.', 500);
  }
};
