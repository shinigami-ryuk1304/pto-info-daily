import type { APIRoute } from 'astro';
import { getMedia, isMediaKey } from '../../lib/media-store';

export const prerender = false;

const NOT_FOUND = () =>
  new Response('Image not found', {
    status: 404,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });

// Serves uploaded images: /media/img/2026/11/<uuid>.webp
// Keys never change (a new upload always gets a new key), so images are
// cached for a year. That keeps storage reads, and costs, near zero.
export const GET: APIRoute = async ({ params, request }) => {
  const key = params.key;

  if (!isMediaKey(key)) return NOT_FOUND();

  // Cloudflare edge cache (active on the custom domain; skipped elsewhere).
  const cache = (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default;
  const cacheKey = new Request(new URL(request.url).toString(), { method: 'GET' });

  if (cache) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  let media: Awaited<ReturnType<typeof getMedia>>;

  try {
    media = await getMedia(key);
  } catch (error) {
    console.error('Image read failed:', key, error);
    return new Response('Image temporarily unavailable', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  if (!media) return NOT_FOUND();

  const response = new Response(media.body, {
    status: 200,
    headers: {
      'Content-Type': media.contentType,
      'Content-Length': String(media.body.byteLength),
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });

  if (cache) {
    try {
      await cache.put(cacheKey, response.clone());
    } catch {
      // Caching is best-effort.
    }
  }

  return response;
};
