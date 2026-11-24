
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  output: 'server',
  // 'passthrough' serves images as they are and does NOT enable the
  // Cloudflare Images (IMAGES) binding, which can be a paid service.
  // Uploaded photos are already resized in the browser before upload.
  adapter: cloudflare({ imageService: 'passthrough' }),
  site: 'https://ptoinfodaily.com',

  session: {
    ttl: 60 * 60 * 8,
    cookie: {
      name: 'pto-writer-session',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
    },
  },
});
