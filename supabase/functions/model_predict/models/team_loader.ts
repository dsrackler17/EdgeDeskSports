// ============================================================================
// EdgeDesk : model_predict / models / team_loader
//
// Team-strength inputs for NFL and WNBA, and the honest answer about whether
// they exist.
//
// WHAT EDGEDESK ACTUALLY OWNS TODAY. The repository's owned feature tables are
// MLB's (games, pitcher_features, offense_features, weather_features,
// mlb_pitcher_usage) plus the isolated tennis, ufc and cfb research schemas.
// There is no NFL efficiency table and no WNBA four-factors table. `game_stats`
// holds win/loss records and a run differential for the MLB board, and
// `stats_players` holds leaderboard stat lines, neither of which is an
// opponent-adjusted team rating.
//
// So this loader does not invent one. It looks for a declared contract table,
// falls back to a points-based rating ONLY if the columns it needs are
// literally present, and otherwise reports insufficient_data with the exact
// list of what is missing. The models built on top of it are complete and
// tested against fixtures, so the day the table is populated they run — and
// until that day they write nothing rather than writing a plausible number.
// ============================================================================

import type { DataContractEntry, ModelDeps } from "../core/types.ts";
import { nrm } from "../core/names.ts";

export type TeamSourceKind = "contract_table" | "points_fallback" | "none";

export interface TeamRow {
  team_norm: string;
  [k: string]: unknown;
}

export interface TeamFeatureSet {
  kind: TeamSourceKind;
  byTeam: Map<string, TeamRow>;
  /** columns actually present on the rows that were read */
  columns: string[];
  /** contract columns the model wanted and did not get */
  missingColumns: string[];
  table: string;
  dataAsOf: string | null;
  detail?: string;
}

/** Read a table if it exists; a missing table is a fact, not a crash. */
async function tryRead(deps: ModelDeps, path: string): Promise<any[] | null> {
  try {
    return await deps.sbGet(path);
  } catch (_) {
    return null;
  }
}

function newestTimestamp(rows: any[]): string | null {
  let best: string | null = null;
  for (const r of rows) {
    for (const k of ["updated_at", "as_of", "computed_at", "created_at"]) {
      const v = r?.[k];
      if (typeof v === "string" && (best == null || v > best)) best = v;
    }
  }
  return best;
}

/**
 * Load team features for one sport.
 *
 * `contractTable` is the table this model is designed around. `requiredColumns`
 * are the columns without which the primary model cannot run. `pointsColumns`
 * name the (points scored, points allowed, games) triple that the degraded
 * fallback needs — the fallback engages only when all three are genuinely on
 * the rows, never on an assumption about what an existing column means.
 */
export async function loadTeamFeatures(
  deps: ModelDeps,
  opts: {
    contractTable: string;
    requiredColumns: string[];
    fallbackTable?: string;
    fallbackFilter?: string;
    pointsColumns?: { scored: string; allowed: string; games: string };
  },
): Promise<TeamFeatureSet> {
  const primary = await tryRead(deps, `${opts.contractTable}?select=*&limit=2000`);
  if (primary && primary.length) {
    const columns = Object.keys(primary[0] ?? {});
    const missingColumns = opts.requiredColumns.filter((c) => columns.indexOf(c) < 0);
    const byTeam = new Map<string, TeamRow>();
    for (const r of primary) {
      const key = r?.team_norm ? String(r.team_norm) : nrm(r?.team ?? r?.team_name ?? "");
      if (!key) continue;
      byTeam.set(key, { ...r, team_norm: key });
    }
    if (!missingColumns.length && byTeam.size) {
      return {
        kind: "contract_table",
        byTeam,
        columns,
        missingColumns,
        table: opts.contractTable,
        dataAsOf: newestTimestamp(primary),
      };
    }
    return {
      kind: "none",
      byTeam,
      columns,
      missingColumns,
      table: opts.contractTable,
      dataAsOf: newestTimestamp(primary),
      detail: `${opts.contractTable} exists but is missing required columns: ${missingColumns.join(", ")}`,
    };
  }

  /* Degraded path. Point differential is the strongest single predictor either
     of these sports has, so it is worth using — but only if the columns are
     really there. A column called run_diff on an MLB board is not a football
     point differential and is not treated as one. */
  if (opts.fallbackTable && opts.pointsColumns) {
    const path = `${opts.fallbackTable}?select=*${opts.fallbackFilter ? "&" + opts.fallbackFilter : ""}&limit=2000`;
    const fb = await tryRead(deps, path);
    if (fb && fb.length) {
      const columns = Object.keys(fb[0] ?? {});
      const need = [opts.pointsColumns.scored, opts.pointsColumns.allowed, opts.pointsColumns.games];
      const absent = need.filter((c) => columns.indexOf(c) < 0);
      if (!absent.length) {
        const byTeam = new Map<string, TeamRow>();
        for (const r of fb) {
          const key = r?.team_norm ? String(r.team_norm) : nrm(r?.team ?? r?.team_name ?? "");
          if (!key) continue;
          byTeam.set(key, { ...r, team_norm: key });
        }
        if (byTeam.size) {
          return {
            kind: "points_fallback",
            byTeam,
            columns,
            missingColumns: opts.requiredColumns,
            table: opts.fallbackTable,
            dataAsOf: newestTimestamp(fb),
            detail: `${opts.contractTable} not present; using points scored/allowed from ${opts.fallbackTable}. Opponent-adjusted efficiency is unavailable.`,
          };
        }
      }
      return {
        kind: "none",
        byTeam: new Map(),
        columns,
        missingColumns: opts.requiredColumns,
        table: opts.contractTable,
        dataAsOf: null,
        detail: `${opts.contractTable} not present, and ${opts.fallbackTable} lacks ${absent.join(", ")}.`,
      };
    }
  }

  return {
    kind: "none",
    byTeam: new Map(),
    columns: [],
    missingColumns: opts.requiredColumns,
    table: opts.contractTable,
    dataAsOf: null,
    detail: `${opts.contractTable} is not present in this project (or returns no rows), and no usable fallback was found.`,
  };
}

export function numOr(row: TeamRow | undefined, key: string, fallback: number | null): number | null {
  if (!row) return fallback;
  const v = row[key];
  if (v == null) return fallback;
  const n = +(v as number);
  return Number.isFinite(n) ? n : fallback;
}

/** Mean of a column across every loaded team — the league baseline the model
 *  measures a team against. Computed from the same rows the prediction uses, so
 *  it can never drift from them. */
export function leagueMean(set: TeamFeatureSet, key: string): number | null {
  let s = 0, n = 0;
  for (const [, row] of set.byTeam) {
    const v = numOr(row, key, null);
    if (v != null) { s += v; n++; }
  }
  return n ? s / n : null;
}

export function unavailableContract(entries: DataContractEntry[]): DataContractEntry[] {
  return entries;
}
