/* ===========================================================================
   Canonical serialisation and content hashes.

   canonicalJson: object keys sorted by code point, no whitespace, arrays in
   order, -0 written as 0, and anything JSON cannot represent exactly
   (NaN, Infinity, undefined inside arrays, functions, bigint) REFUSED rather
   than silently dropped. Two inputs that hash the same are the same input.
   =========================================================================== */
import { createHash } from 'node:crypto';

export function canonicalJson(value: unknown): string {
  return ser(value, '$');
}

function ser(v: unknown, path: string): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean': return v ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(v)) throw new Error('canonicalJson: non-finite number at ' + path);
      return Object.is(v, -0) ? '0' : JSON.stringify(v);
    case 'string': return JSON.stringify(v);
    case 'object': {
      if (Array.isArray(v)) return '[' + v.map((x, i) => ser(x === undefined ? fail(path + '[' + i + ']') : x, path + '[' + i + ']')).join(',') + ']';
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
      return '{' + keys.map((k) => JSON.stringify(k) + ':' + ser(o[k], path + '.' + k)).join(',') + '}';
    }
    default:
      throw new Error('canonicalJson: unsupported ' + typeof v + ' at ' + path);
  }
}
function fail(path: string): never { throw new Error('canonicalJson: undefined at ' + path); }

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hashCanonical(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
