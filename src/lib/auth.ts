
const ITERATIONS = 600_000;
const SALT_LENGTH = 16;
const KEY_LENGTH = 256;

function toBase64(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function derivePasswordHash(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const encoder = new TextEncoder();

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  // Copy the salt into a definite ArrayBuffer to satisfy TypeScript.
  const saltBuffer = new ArrayBuffer(salt.length);
  new Uint8Array(saltBuffer).set(salt);

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: saltBuffer,
      iterations,
      hash: "SHA-256",
    },
    keyMaterial,
    KEY_LENGTH,
  );

  return new Uint8Array(derivedBits);
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12) {
    throw new Error("Password must contain at least 12 characters.");
  }

  if (password.length > 256) {
    throw new Error("Password is too long.");
  }

  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));

  const derived = await derivePasswordHash(
    password,
    salt,
    ITERATIONS,
  );

  return [
    "pbkdf2",
    "sha256",
    String(ITERATIONS),
    toBase64(salt),
    toBase64(derived),
  ].join("$");
}

export async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<boolean> {
  try {
    const parts = storedHash.split("$");

    if (parts.length !== 5) {
      return false;
    }

    const [algorithm, digest, iterationsText, saltText, hashText] = parts;
    const iterations = Number(iterationsText);

    if (
      algorithm !== "pbkdf2" ||
      digest !== "sha256" ||
      !Number.isSafeInteger(iterations) ||
      iterations < 100_000 ||
      iterations > 1_000_000
    ) {
      return false;
    }

    const salt = fromBase64(saltText);
    const expected = fromBase64(hashText);

    if (
      salt.length !== SALT_LENGTH ||
      expected.length !== KEY_LENGTH / 8
    ) {
      return false;
    }

    const actual = await derivePasswordHash(
      password,
      salt,
      iterations,
    );

    let difference = 0;

    for (let i = 0; i < actual.length; i++) {
      difference |= actual[i] ^ expected[i];
    }

    return difference === 0;
  } catch {
    return false;
  }
}
