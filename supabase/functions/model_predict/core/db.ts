// ============================================================================
// EdgeDesk : model_predict / core / db
//
// Supabase REST access and the runtime shim that keeps the rest of this
// function portable. Everything below `env()` is the only code in the tree
// allowed to touch Deno or fetch, which is what lets the models and the shared
// pipeline run under `node --test` unchanged.
// ============================================================================

/** Read an environment variable under Deno (production) or Node (tests). */
export function env(key: string, fallback = ""): string {
  const g = globalThis as {
    Deno?: { env?: { get?: (k: string) => string | undefined } };
    process?: { env?: Record<string, string | undefined> };
  };
  const fromDeno = g.Deno?.env?.get?.(key);
  if (fromDeno != null) return fromDeno;
  const fromNode = g.process?.env?.[key];
  if (fromNode != null) return fromNode;
  return fallback;
}

export function envNum(key: string, fallback: number): number {
  const raw = env(key, "");
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export interface Db {
  sbGet: (path: string) => Promise<any[]>;
  sbGetSchema: (schema: string, path: string) => Promise<any[]>;
  jget: (url: string) => Promise<any>;
  upsertPredictions: (rows: unknown[]) => Promise<number>;
  /** Generic upsert. Used by calibration to store fitted parameters, which —
   *  unlike a prediction snapshot — are meant to be replaced. */
  upsert: (table: string, rows: unknown[], onConflict: string, resolution?: "merge-duplicates" | "ignore-duplicates") => Promise<number>;
}

export interface DbConfig {
  url: string;
  serviceKey: string;
  /** hard cap on rows per upsert request */
  batchSize?: number;
}

export function makeDb(cfg: DbConfig): Db {
  const base = cfg.url.replace(/\/+$/, "");
  const batch = cfg.batchSize ?? 500;
  const auth = () => ({ apikey: cfg.serviceKey, authorization: "Bearer " + cfg.serviceKey });

  async function sbGet(path: string): Promise<any[]> {
    const r = await fetch(base + "/rest/v1/" + path, { headers: auth() });
    if (!r.ok) throw new Error("sbGet " + r.status + " " + (await r.text()).slice(0, 400));
    return r.json();
  }

  /* Isolated schemas (`tennis`, `ufc`, `wta`, `cfb`) are reached with the same
     accept-profile header the app uses. A 404 here usually means the schema is
     not in Supabase > API settings > Exposed schemas, which is a configuration
     fact worth reporting rather than an outage. */
  async function sbGetSchema(schema: string, path: string): Promise<any[]> {
    const r = await fetch(base + "/rest/v1/" + path, {
      headers: { ...auth(), "accept-profile": schema },
    });
    if (!r.ok) {
      throw new Error(
        "sbGet[" + schema + "] " + r.status + " " + (await r.text()).slice(0, 400),
      );
    }
    return r.json();
  }

  async function jget(url: string): Promise<any> {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error("GET " + r.status + " " + url);
    return r.json();
  }

  /**
   * Write predictions.
   *
   * `resolution=ignore-duplicates` is load-bearing, not an optimisation: the
   * FIRST prediction for (model_version, event_id, market, selection) is the
   * CLV baseline and re-running this function must never overwrite the entry
   * snapshot. Removing it — or switching to merge-duplicates — destroys the
   * ability to measure pre-game CLV, calibration or ROI after the fact.
   */
  async function upsertPredictions(rows: unknown[]): Promise<number> {
    if (!rows.length) return 0;
    let written = 0;
    for (let i = 0; i < rows.length; i += batch) {
      const slice = rows.slice(i, i + batch);
      const r = await fetch(
        base + "/rest/v1/model_predictions?on_conflict=model_version,event_id,market,selection",
        {
          method: "POST",
          headers: {
            ...auth(),
            "Content-Type": "application/json",
            Prefer: "resolution=ignore-duplicates,return=minimal",
          },
          body: JSON.stringify(slice),
        },
      );
      if (!r.ok && r.status !== 409) {
        throw new Error("upsert " + r.status + " " + (await r.text()).slice(0, 400));
      }
      written += slice.length;
    }
    return written;
  }

  async function upsert(
    table: string,
    rows: unknown[],
    onConflict: string,
    resolution: "merge-duplicates" | "ignore-duplicates" = "merge-duplicates",
  ): Promise<number> {
    if (!rows.length) return 0;
    const r = await fetch(`${base}/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
      method: "POST",
      headers: {
        ...auth(),
        "Content-Type": "application/json",
        Prefer: `resolution=${resolution},return=minimal`,
      },
      body: JSON.stringify(rows),
    });
    if (!r.ok && r.status !== 409) {
      throw new Error(`upsert ${table} ${r.status} ${(await r.text()).slice(0, 400)}`);
    }
    return rows.length;
  }

  return { sbGet, sbGetSchema, jget, upsertPredictions, upsert };
}

/** Bounded-concurrency map. Keeps a full-slate run from turning into an API
 *  request storm against StatsAPI or PostgREST (spec §31). */
export async function pmap<T>(arr: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < arr.length; i += n) {
    await Promise.all(arr.slice(i, i + n).map(fn));
  }
}

/** PostgREST `in.(...)` list, quoted so names with commas survive. */
export function inList(values: Array<string | number>): string {
  return "(" + values.map((v) => '"' + String(v).replace(/"/g, "") + '"').join(",") + ")";
}
