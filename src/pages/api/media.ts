import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import {
  MAX_UPLOAD_BYTES,
  detectImageType,
  mediaStoreAvailable,
  mediaUrl,
  putMedia,
} from '../../lib/media-store';

export const prerender = false;

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

function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) return false;

  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

// Upload one image. Signed-in writers, editors and admins only.
// Body: multipart/form-data with a single "file" field.
export const POST: APIRoute = async ({ request, session }) => {
  if (!isSameOrigin(request)) {
    return json({ message: 'Request origin could not be verified.' }, 403);
  }

  if (!request.headers.get('Content-Type')?.toLowerCase().includes('multipart/form-data')) {
    return json({ message: 'Upload the image as multipart/form-data.' }, 415);
  }

  // Reject oversized requests before reading them.
  const declaredLength = Number(request.headers.get('Content-Length') ?? '0');
  if (declaredLength > MAX_UPLOAD_BYTES + 64 * 1024) {
    return json({ message: 'The image is too large. The limit is 2 MB.' }, 413);
  }

  if (!session) return json({ message: 'Please sign in again.' }, 401);

  const authorId = await session.get<string>('authorId');
  if (!authorId) return json({ message: 'Please sign in again.' }, 401);

  if (!env.DB) return json({ message: 'The database is unavailable.' }, 503);

  if (!mediaStoreAvailable()) {
    return json({ message: 'Image storage is not configured yet.' }, 503);
  }

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
    await session.destroy();
    return json({ message: 'Your account is not authorised to upload images.' }, 403);
  }

  let file: FormDataEntryValue | null;

  try {
    const formData = await request.formData();
    file = formData.get('file');
  } catch {
    return json({ message: 'The upload could not be read.' }, 400);
  }

  if (!file || typeof file === 'string') {
    return json({ message: 'Choose an image to upload.' }, 400);
  }

  if (file.size === 0) {
    return json({ message: 'The selected file is empty.' }, 400);
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return json({ message: 'The image is too large. The limit is 2 MB.' }, 413);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = detectImageType(bytes);

  if (!type) {
    return json(
      { message: 'Only JPEG, PNG or WebP images can be uploaded.' },
      415,
    );
  }

  try {
    const key = await putMedia(bytes, type, author.id);

    return json(
      {
        message: 'Image uploaded.',
        key,
        url: mediaUrl(key),
        size: bytes.byteLength,
        contentType: type,
      },
      201,
    );
  } catch (error) {
    console.error('Image upload failed:', error);
    return json(
      {
        message:
          'The image could not be stored. If this keeps happening, the free daily upload limit may have been reached — try again tomorrow.',
      },
      503,
    );
  }
};
