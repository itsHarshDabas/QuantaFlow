const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** Short, sortable-enough, URL-safe ids such as `job_k3x9...`. Works in Node and browsers. */
export function newId(prefix: string, length = 12): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return `${prefix}_${out}`;
}
