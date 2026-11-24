// PTO Info Daily — security headers on every response.
//
// - Stops other websites from loading our pages inside a frame
//   (protects the admin and writer dashboards from "clickjacking").
// - Tells browsers not to guess file types, and limits what the
//   Referer header reveals to other sites.
// - Private areas (/admin, /writers, /api) are never cached.

import { defineMiddleware } from "astro:middleware";

const PRIVATE_PREFIXES = ["/admin", "/writers", "/api"];

const BASE_HEADERS: Record<string, string> = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
};

// Kept deliberately narrow so it can't break Astro's scripts, Tiptap or
// Google Fonts: it only blocks framing, plugins, <base> tricks and
// forms that post to other websites.
const CONTENT_SECURITY_POLICY =
  "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'";

function withHeaders(response: Response, pathname: string, isHttps: boolean): Response {
  let target = response;

  try {
    target.headers.set("X-Content-Type-Options", "nosniff");
  } catch {
    // Some responses (e.g. from the cache) have read-only headers.
    target = new Response(response.body, response);
  }

  for (const [name, value] of Object.entries(BASE_HEADERS)) {
    target.headers.set(name, value);
  }

  // Routes such as /media set their own stricter policy; keep it.
  if (!target.headers.has("Content-Security-Policy")) {
    target.headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  }

  if (isHttps) {
    target.headers.set("Strict-Transport-Security", "max-age=31536000");
  }

  const isPrivate = PRIVATE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );

  if (isPrivate) {
    target.headers.set("Cache-Control", "no-store");
  }

  return target;
}

export const onRequest = defineMiddleware(async (context, next) => {
  const response = await next();
  return withHeaders(
    response,
    context.url.pathname,
    context.url.protocol === "https:",
  );
});
