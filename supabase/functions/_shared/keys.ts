// Shared key and token primitives. Submission keys are
// mck_live_{8 base62}{32 base62} or mck_test_{8 base62}{32 base62}.
// Invite tokens are mci_{24 base62}. Only the sha256 hex of the full raw
// string is ever stored; the prefix is stored for lookup and display.

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// Unbiased base62 string via rejection sampling over crypto.getRandomValues.
// 248 is the largest multiple of 62 that fits in a byte, so bytes at or above
// it are discarded instead of skewing the distribution.
export function randBase62(n: number): string {
  const out: string[] = [];
  const buf = new Uint8Array(n * 2);
  while (out.length < n) {
    crypto.getRandomValues(buf);
    for (let i = 0; i < buf.length && out.length < n; i++) {
      const b = buf[i];
      if (b < 248) {
        out.push(BASE62[b % 62]);
      }
    }
  }
  return out.join("");
}

export async function sha256hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const KEY_RE = /^mck_(live|test)_([0-9A-Za-z]{8})[0-9A-Za-z]{32}$/;

// Validates shape mck_live_<8+32 base62> or mck_test_<8+32 base62>.
// prefix is the 8 chars after mck_live_ or mck_test_.
export function parseCollectiveKey(
  raw: string,
): { prefix: string; kind: "live" | "test" } | null {
  const m = KEY_RE.exec(raw);
  if (!m) return null;
  return { prefix: m[2], kind: m[1] as "live" | "test" };
}

// New submission key. The raw string is shown once; hash is sha256hex of the
// FULL raw key string.
export async function newApiKey(
  kind: "live" | "test",
): Promise<{ raw: string; prefix: string; hash: string }> {
  const prefix = randBase62(8);
  const secret = randBase62(32);
  const raw = `mck_${kind}_${prefix}${secret}`;
  const hash = await sha256hex(raw);
  return { raw, prefix, hash };
}

// New invite token mci_<24 base62>; prefix is the first 8 of the 24; hash is
// sha256hex of the full raw token.
export async function newInviteToken(): Promise<{
  raw: string;
  prefix: string;
  hash: string;
}> {
  const body = randBase62(24);
  const raw = `mci_${body}`;
  const hash = await sha256hex(raw);
  return { raw, prefix: body.slice(0, 8), hash };
}

// Length-independent, value-independent comparison for secret digests. Both
// inputs here are fixed-length lowercase hex, but comparing with === would
// still leak position of the first differing byte through timing; this does
// not, and costs nothing at 64 characters.
export function timingSafeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
