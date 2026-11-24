// PTO Info Daily — image storage.
//
// This is the ONLY file that knows where uploaded images are stored.
// Today: Cloudflare KV (binding "MEDIA", free plan, no billing).
// To move to Cloudflare R2 later, replace the three functions below
// (putMedia / getMedia / deleteMedia) with R2 versions and copy the
// existing keys across. Pages, APIs and the editor do not need to change.

import { env } from "cloudflare:workers";

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024; // 2 MB after in-browser resizing

export type MediaType = "image/webp" | "image/jpeg" | "image/png";

const EXTENSIONS: Record<MediaType, string> = {
  "image/webp": "webp",
  "image/jpeg": "jpg",
  "image/png": "png",
};

// Keys look like: img/2026/11/3f1c...-uuid.webp
const KEY_PATTERN =
  /^img\/\d{4}\/\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(webp|jpg|png)$/;

export function isMediaKey(value: unknown): value is string {
  return typeof value === "string" && KEY_PATTERN.test(value);
}

/** Public URL for a stored image key. */
export function mediaUrl(key: string): string {
  return `/media/${key}`;
}

/**
 * Works out the real file type from the first bytes of the file.
 * The browser-supplied type and file name are never trusted.
 */
export function detectImageType(bytes: Uint8Array): MediaType | null {
  if (bytes.length < 12) return null;

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }

  // WebP: "RIFF" .... "WEBP"
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }

  return null;
}

function newKey(type: MediaType): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `img/${year}/${month}/${crypto.randomUUID()}.${EXTENSIONS[type]}`;
}

type MediaMetadata = {
  contentType: MediaType;
  size: number;
  uploadedBy: string;
  uploadedAt: string;
};

function store(): KVNamespace {
  const kv = (env as unknown as { MEDIA?: KVNamespace }).MEDIA;
  if (!kv) throw new Error("Image storage (MEDIA binding) is not configured.");
  return kv;
}

export function mediaStoreAvailable(): boolean {
  return Boolean((env as unknown as { MEDIA?: KVNamespace }).MEDIA);
}

/** Saves an already-validated image and returns its new key. */
export async function putMedia(
  bytes: Uint8Array,
  type: MediaType,
  uploadedBy: string,
): Promise<string> {
  const key = newKey(type);
  const metadata: MediaMetadata = {
    contentType: type,
    size: bytes.byteLength,
    uploadedBy,
    uploadedAt: new Date().toISOString(),
  };

  await store().put(key, bytes, { metadata });
  return key;
}

/** Reads an image. Returns null when the key does not exist. */
export async function getMedia(
  key: string,
): Promise<{ body: ArrayBuffer; contentType: MediaType } | null> {
  if (!isMediaKey(key)) return null;

  const result = await store().getWithMetadata<MediaMetadata>(key, {
    type: "arrayBuffer",
    cacheTtl: 86400, // let Cloudflare keep hot images near readers
  });

  if (!result.value) return null;

  const contentType = result.metadata?.contentType;
  return {
    body: result.value,
    contentType:
      contentType && contentType in EXTENSIONS ? contentType : "application/octet-stream" as MediaType,
  };
}

/** True when the key exists (used to check a featured image before saving). */
export async function mediaExists(key: string): Promise<boolean> {
  if (!isMediaKey(key)) return false;
  const { value } = await store().getWithMetadata(key, { type: "stream" });
  if (value) await value.cancel();
  return value !== null;
}

export type HeroImageInput =
  | { ok: true; key: string | null | undefined; alt: string | null | undefined }
  | { ok: false; message: string };

/**
 * Reads and validates `heroImageKey` / `imageAlt` from an article payload.
 * `undefined` means "not sent — leave unchanged"; `null` means "remove".
 */
export async function readHeroImageInput(
  payload: Record<string, unknown>,
): Promise<HeroImageInput> {
  let key: string | null | undefined;
  let alt: string | null | undefined;

  if ("heroImageKey" in payload) {
    const value = payload.heroImageKey;

    if (value === null || value === "") {
      key = null;
    } else if (isMediaKey(value)) {
      if (!(await mediaExists(value))) {
        return { ok: false, message: "The featured image could not be found. Upload it again." };
      }
      key = value;
    } else {
      return { ok: false, message: "The featured image is not valid. Upload it again." };
    }
  }

  if ("imageAlt" in payload) {
    const value = payload.imageAlt;

    if (value === null || value === "") {
      alt = null;
    } else if (typeof value === "string") {
      const trimmed = value.replace(/\s+/g, " ").trim();
      if (trimmed.length > 200) {
        return { ok: false, message: "The image description must be 200 characters or fewer." };
      }
      alt = trimmed || null;
    } else {
      return { ok: false, message: "The image description is not valid." };
    }
  }

  return { ok: true, key, alt };
}

/** Deletes an image. Never throws — a failed cleanup must not break a save. */
export async function deleteMedia(key: string | null | undefined): Promise<void> {
  if (!isMediaKey(key)) return;
  try {
    await store().delete(key);
  } catch (error) {
    console.error("Image cleanup failed:", key, error);
  }
}
