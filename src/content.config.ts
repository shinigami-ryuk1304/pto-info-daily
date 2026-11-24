
import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const articles = defineCollection({
  loader: glob({
    pattern: "**/*.md",
    base: "./src/content/articles",
  }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    category: z.enum([
      "news",
      "politics",
      "entertainment",
      "celebrity-news",
      "trending",
      "sports",
      "business",
      "lifestyle",
      "technology",
    ]),
    author: z.string(),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    heroImage: z.string().optional(),
    imageAlt: z.string().optional(),
    draft: z.boolean().default(true),
  }),
});

export const collections = { articles };
