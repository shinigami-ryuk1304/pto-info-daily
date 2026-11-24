
import type { APIRoute } from 'astro';

export const prerender = false;

export const POST: APIRoute = async ({ session, redirect }) => {
  if (!session) {
    return redirect('/writers/login/', 303);
  }

  await session.destroy();

  return redirect('/writers/login/', 303);
};

export const GET: APIRoute = async () => {
  return new Response('Method Not Allowed', {
    status: 405,
    headers: {
      Allow: 'POST',
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
};
