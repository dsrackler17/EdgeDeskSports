// ============================================================================
// EdgeDesk : model_predict / core / names
//
// The Odds API and every stats provider EdgeDesk owns live in different id
// spaces, so a name join has to happen somewhere. This is that somewhere, and
// it is deliberately narrow: a name resolves to exactly one entity or it
// resolves to nothing. A "closest match" is how a model ends up predicting the
// wrong player's match, so there is no fuzzy fallback and no edit distance.
//
// Ambiguity is a reportable state (missing_participant), not a coin flip.
// ============================================================================

/** v1.2's nrm(), unchanged — used by MLB team matching and the park table. */
export function nrm(s: unknown): string {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** v1.2's matchKey(), unchanged. Collapses the Athletics naming mess so
 *  StatsAPI and the Odds API agree. */
export function matchKey(s: unknown): string {
  const n = nrm(s);
  return n.includes("athletics") ? "athletics" : n;
}

/** The bucket a game's market can live in. NOT an identity — see identity.ts. */
export function pairKey(home: unknown, away: unknown): string {
  return matchKey(home) + "|" + matchKey(away);
}

/**
 * Strip diacritics. NFD decomposition plus combining-mark removal handles the
 * accented Latin the tennis and MMA feeds carry (é, ć, ñ, ü).
 *
 * A handful of letters do NOT decompose and have more than one accepted
 * romanisation — Đoković is written "Djokovic" by one feed and "Dokovic" by
 * another, and both are correct. Picking one silently loses the other, so
 * ambiguous letters expand into VARIANTS and a name is indexed under all of
 * them. Matching then succeeds whichever convention each side used.
 */
const AMBIGUOUS: Record<string, string[]> = {
  "đ": ["dj", "d"], "ð": ["d", "dh"],
  "ø": ["o", "oe"], "œ": ["oe", "o"],
  "ł": ["l", "w"], "æ": ["ae", "a"],
  "ß": ["ss", "s"], "þ": ["th", "t"],
};
const AMBIGUOUS_RE = /[đðøœłæßþ]/;

/** NFD-fold only. Leaves the ambiguous letters alone for variantKeys(). */
export function deaccent(s: unknown): string {
  const out = String(s ?? "");
  return typeof out.normalize === "function"
    ? out.normalize("NFD").replace(/[̀-ͯ]/g, "")
    : out;
}

/** Canonical person key: accent-folded, lowercased, alphanumeric only.
 *  "Félix Auger-Aliassime" -> "felixaugeraliassime" */
export function personKey(s: unknown): string {
  return variantKeys(s)[0] ?? "";
}

/** Every canonical spelling of a name. The first is the primary. */
export function variantKeys(s: unknown): string[] {
  const folded = deaccent(s).toLowerCase();
  let forms = [folded];
  if (AMBIGUOUS_RE.test(folded)) {
    for (const letter of Object.keys(AMBIGUOUS)) {
      if (folded.indexOf(letter) < 0) continue;
      const next: string[] = [];
      for (const f of forms) {
        for (const rep of AMBIGUOUS[letter]) {
          next.push(f.split(letter).join(rep));
          if (next.length >= 8) break;
        }
        if (next.length >= 8) break;
      }
      forms = next;
    }
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of forms) {
    const k = f.replace(/[^a-z0-9]/g, "");
    if (k && !seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}

/** Tokens of a person name, accent-folded and lowercased, suffixes dropped.
 *  Suffixes are dropped because the Odds API and the stats feeds disagree about
 *  whether to carry them at all. */
const NAME_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

export function nameTokens(s: unknown): string[] {
  return deaccent(s)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !NAME_SUFFIXES.has(t));
}

/** "C. Alcaraz" / "Alcaraz C." style. Returns null when the name is not in an
 *  initial-plus-surname shape. */
function initialSurnameKey(tokens: string[]): string | null {
  if (tokens.length !== 2) return null;
  const [a, b] = tokens;
  if (a.length === 1 && b.length > 1) return a + "|" + b;
  if (b.length === 1 && a.length > 1) return b + "|" + a;
  return null;
}

export interface NamedEntity {
  id: string;
  name: string;
}

export interface NameIndex {
  /** exact canonical key -> ids */
  exact: Map<string, string[]>;
  /** first-initial + surname -> ids */
  initial: Map<string, string[]>;
  /** surname alone -> ids */
  surname: Map<string, string[]>;
  size: number;
}

export function buildNameIndex(entities: NamedEntity[]): NameIndex {
  const exact = new Map<string, string[]>();
  const initial = new Map<string, string[]>();
  const surname = new Map<string, string[]>();
  const push = (m: Map<string, string[]>, k: string, id: string) => {
    const cur = m.get(k);
    if (cur) {
      if (cur.indexOf(id) < 0) cur.push(id);
    } else m.set(k, [id]);
  };
  for (const e of entities) {
    if (!e || !e.id || !e.name) continue;
    const toks = nameTokens(e.name);
    if (!toks.length) continue;
    for (const k of variantKeys(e.name)) push(exact, k, e.id);
    const last = toks[toks.length - 1];
    const first = toks[0];
    for (const k of variantKeys(last)) push(surname, k, e.id);
    if (first.length >= 1) {
      for (const k of variantKeys(last)) push(initial, first[0] + "|" + k, e.id);
    }
    // Some feeds invert to "Surname Firstname". Index that reading too, but
    // only as an initial/surname candidate so it can never beat an exact hit.
    if (toks.length >= 2) {
      for (const k of variantKeys(toks[0])) push(initial, last[0] + "|" + k, e.id);
    }
  }
  return { exact, initial, surname, size: entities.length };
}

export type ResolveOutcome =
  | { ok: true; id: string; how: "exact" | "initial" | "surname" }
  | { ok: false; reason: "not_found" | "ambiguous"; candidates?: string[] };

/**
 * Resolve one participant name to one entity id.
 *
 * Tiers are tried in order and a tier that produces more than one candidate
 * stops the search: two players sharing a surname is exactly the case where
 * guessing is worst, so it reports `ambiguous` and the event is skipped with
 * missing_participant rather than predicted against a coin flip.
 */
export function resolveName(index: NameIndex, raw: unknown): ResolveOutcome {
  const keys = variantKeys(raw);
  if (!keys.length) return { ok: false, reason: "not_found" };

  /* Every tier collects across all spellings of the name before deciding, so a
     hit under one romanisation and a different hit under another is reported as
     ambiguous rather than resolved by whichever was tried first. */
  const lookup = (map: Map<string, string[]>, ks: string[]): string[] => {
    const out: string[] = [];
    for (const k of ks) {
      for (const id of map.get(k) ?? []) if (out.indexOf(id) < 0) out.push(id);
    }
    return out;
  };

  const hitExact = lookup(index.exact, keys);
  if (hitExact.length === 1) return { ok: true, id: hitExact[0], how: "exact" };
  if (hitExact.length > 1) return { ok: false, reason: "ambiguous", candidates: hitExact };

  const toks = nameTokens(raw);
  if (!toks.length) return { ok: false, reason: "not_found" };

  const pair = initialSurnameKey(toks);
  const first = pair ? pair.split("|")[0] : toks[0][0];
  const lastRaw = pair ? pair.split("|")[1] : toks[toks.length - 1];
  const lastKeys = variantKeys(lastRaw);

  const hitInit = lookup(index.initial, lastKeys.map((k) => first + "|" + k));
  if (hitInit.length === 1) return { ok: true, id: hitInit[0], how: "initial" };
  if (hitInit.length > 1) return { ok: false, reason: "ambiguous", candidates: hitInit };

  // Surname alone is the last resort and only when it is globally unique.
  const hitSur = lookup(index.surname, lastKeys);
  if (hitSur.length === 1) return { ok: true, id: hitSur[0], how: "surname" };
  if (hitSur.length > 1) return { ok: false, reason: "ambiguous", candidates: hitSur };

  return { ok: false, reason: "not_found" };
}
