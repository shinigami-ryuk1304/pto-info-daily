
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { hashPassword } from '../../../lib/auth';

export const prerender = false;

function respond(message: string, status: number) {
  return Response.json(
    { message },
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    },
  );
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(token),
  );

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export const POST: APIRoute = async ({ request }) => {
  const origin = request.headers.get('Origin');

  if (!origin || origin !== new URL(request.url).origin) {
    return respond('Request rejected.', 403);
  }

  if (
    !(request.headers.get('Content-Type') ?? '')
      .toLowerCase()
      .includes('application/json')
  ) {
    return respond('Send the form as JSON.', 415);
  }

  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return respond('Invalid request body.', 400);
  }

  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return respond('Invalid request body.', 400);
  }

  const data = payload as Record<string, unknown>;

  const token =
    typeof data.token === 'string' ? data.token : '';

  const password =
    typeof data.password === 'string' ? data.password : '';

  const confirmation =
    typeof data.confirmPassword === 'string'
      ? data.confirmPassword
      : '';

  if (!/^[a-f0-9]{64}$/.test(token)) {
    return respond(
      'This invitation is invalid or has expired.',
      400,
    );
  }

  if (password.length < 12 || password.length > 256) {
    return respond(
      'Use a password between 12 and 256 characters.',
      400,
    );
  }

  if (password !== confirmation) {
    return respond('The passwords do not match.', 400);
  }

  const db = env.DB;

  if (!db) {
    return respond('Service temporarily unavailable.', 503);
  }

  try {
    const tokenHash = await hashToken(token);
    const passwordHash = await hashPassword(password);
    const now = Math.floor(Date.now() / 1000);

    /*
     * D1 batch executes statements transactionally.
     *
     * First, consume the invitation only if it is valid,
     * unused, unexpired, and belongs to an eligible writer.
     *
     * Then, activate the account only if the invitation
     * was consumed and the account is still eligible.
     *
     * A zero-row update does not automatically roll back
     * the batch, so both results must be checked.
     */
    const results = await db.batch([
      db
        .prepare(
          `UPDATE writer_invitations
           SET used_at = ?
           WHERE token_hash = ?
             AND used_at IS NULL
             AND expires_at > ?
             AND EXISTS (
               SELECT 1
               FROM authors
               WHERE authors.id = writer_invitations.author_id
                 AND authors.role = 'writer'
                 AND authors.active = 0
                 AND authors.password_hash IS NULL
             )`,
        )
        .bind(now, tokenHash, now),

      db
        .prepare(
          `UPDATE authors
           SET password_hash = ?,
               active = 1
           WHERE id = (
             SELECT author_id
             FROM writer_invitations
             WHERE token_hash = ?
               AND used_at = ?
           )
             AND role = 'writer'
             AND active = 0
             AND password_hash IS NULL`,
        )
        .bind(passwordHash, tokenHash, now),
    ]);

    const invitationConsumed =
      (results[0]?.meta?.changes ?? 0) === 1;

    const accountActivated =
      (results[1]?.meta?.changes ?? 0) === 1;

    if (!invitationConsumed || !accountActivated) {
      console.warn(
        'Invitation acceptance did not complete successfully.',
        {
          invitationConsumed,
          accountActivated,
        },
      );

      return respond(
        'This invitation is invalid, expired, or already used. Contact the administrator if you need a new invitation.',
        400,
      );
    }

    return respond(
      'Your account is ready. You can now sign in.',
      200,
    );
  } catch (error) {
    console.error('Invitation acceptance failed:', error);

    return respond(
      'Unable to complete the invitation. Please try again or contact the administrator.',
      500,
    );
  }
};
