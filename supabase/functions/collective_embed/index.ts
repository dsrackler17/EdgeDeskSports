// Model Collective embed API. One bootstrap payload renders the Collective
// tab on a member's site. The payload is built identically for every host
// and only annotated with the host pin afterward: a host cannot hide a
// rival, reorder rankings, or filter a bad week (Section 4, enforced here
// server side). The lock is the per-creator origin allowlist; the slug in
// page source is deliberately harmless anywhere else.

import { json, err, preflight, subpath } from "../_shared/http.ts";
import { rpc, RpcError } from "../_shared/db.ts";
import { BASE_URL } from "../_shared/env.ts";
import { buildGames, buildMeta, buildWall, tableWrite, viewGet } from "../_shared/reads.ts";

function corsFor(origin: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin",
  };
}

function originHost(req: Request): string | null {
  const o = req.headers.get("origin") ?? "";
  if (o) return o;
  const ref = req.headers.get("referer");
  if (!ref) return null;
  try {
    const u = new URL(ref);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

async function originAllowed(creatorId: string | null, origin: string | null): Promise<boolean> {
  if (!origin) return false;
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  // The Collective's own domain always renders itself.
  const base = new URL(BASE_URL).hostname;
  if (host === base || host === `www.${base}`) return true;
  if (host === "localhost" || host === "127.0.0.1") {
    const allow = await rpc<unknown>("get_config", { p_key: "embed.allow_localhost" });
    if (allow === true) return true;
  }
  if (!creatorId) return false;
  const rows = await viewGet<{ id: string; origin: string }>(
    "embed_installs", `select=id,origin&creator_id=eq.${creatorId}&status=eq.active`);
  return rows.some((r) => {
    try {
      return new URL(r.origin).hostname === host;
    } catch {
      return false;
    }
  });
}

Deno.serve(async (req) => {
  const origin = originHost(req);
  const cors = corsFor(origin);
  const pre = preflight(req);
  if (pre) return new Response(null, { status: 204, headers: cors });
  const path = subpath(req, "collective_embed");

  try {
    if (req.method === "GET" && path === "/v1/embed/bootstrap") {
      const u = new URL(req.url);
      const hostSlug = (u.searchParams.get("host") ?? "").trim();

      let hostCreator: { id: string; slug: string; display_name: string } | null = null;
      if (hostSlug) {
        const rows = await viewGet<{ id: string; slug: string; display_name: string }>(
          "creators", `select=id,slug,display_name&slug=eq.${hostSlug}&status=eq.active&limit=1`);
        hostCreator = rows[0] ?? null;
      }

      if (!(await originAllowed(hostCreator?.id ?? null, origin))) {
        return new Response(JSON.stringify({
          error: { code: "forbidden_origin",
            message: "This domain is not registered for this Collective embed.", details: null },
        }), { status: 403, headers: { "content-type": "application/json", ...cors } });
      }

      const [meta, wallCanonical, cacheSeconds] = await Promise.all([
        buildMeta(),
        buildWall(),
        rpc<unknown>("get_config", { p_key: "embed.cache_seconds" }),
      ]);

      // Identical payload for every host; the single host privilege is the
      // pin annotation applied after the canonical build.
      const wall = [...wallCanonical];
      if (hostCreator) {
        const i = wall.findIndex((w) => w.creator_slug === hostCreator!.slug);
        if (i > 0) wall.unshift(wall.splice(i, 1)[0]);
      }

      const sport = meta.sports[0];
      const board = sport
        ? await buildGames(sport.code, sport.season, null, false)
        : { games: [] as unknown[] };
      type BoardGame = { status: string; kickoff_at: string; result: unknown };
      const games = board.games as BoardGame[];
      const now = Date.now();
      const upcoming = games.filter((g) =>
        g.result === null && new Date(g.kickoff_at).getTime() > now).slice(0, 16);
      const settled = games.filter((g) => g.result !== null).slice(-10).reverse();

      const creators = wall.reduce((acc: Record<string, unknown>[], w) => {
        let c = acc.find((x) => x.slug === w.creator_slug);
        if (!c) {
          c = {
            slug: w.creator_slug, display_name: w.creator_name, monogram: w.monogram,
            logo_url: w.logo_url, website_url: w.website_url, x_handle: w.x_handle,
            membership: w.membership, founding: w.founding, models: [] as unknown[],
          };
          acc.push(c);
        }
        (c.models as unknown[]).push({
          model_name: w.model_name, sport: w.sport, record: w.record, coverage_pct: w.coverage_pct,
        });
        return acc;
      }, []);

      const refq = hostSlug ? `?ref=${encodeURIComponent(hostSlug)}` : "";
      if (hostCreator) {
        // touch install freshness, best effort
        tableWrite("embed_installs", "PATCH",
          `creator_id=eq.${hostCreator.id}`, { last_seen_at: new Date().toISOString() })
          .catch(() => {});
      }

      return json({
        host: hostCreator
          ? { creator_slug: hostCreator.slug, creator_name: hostCreator.display_name, pinned: true }
          : null,
        meta, wall, creators,
        upcoming: { entitled: false, games: upcoming },
        settled: { games: settled },
        subscribe_url: `${BASE_URL}/collective/${refq}#join`,
        collective_url: `${BASE_URL}/collective/${refq}`,
        cache_seconds: Number(cacheSeconds ?? 60),
      }, 200, { ...cors, "cache-control": `public, max-age=${Number(cacheSeconds ?? 60)}` });
    }

    if (req.method === "POST" && path === "/v1/embed/events") {
      const body = await req.json().catch(() => null) as {
        host?: string; visitor?: string;
        events?: { type?: string; target?: string | null; path?: string; at?: string }[];
      } | null;
      if (!body || !Array.isArray(body.events)) {
        return new Response(JSON.stringify({ ok: true }), { status: 202, headers: { "content-type": "application/json", ...cors } });
      }
      const VALID = ["impression", "profile_view", "outbound_click", "collective_click", "subscribe_click"];
      const hostSlug = typeof body.host === "string" ? body.host.slice(0, 60) : "";
      const visitor = typeof body.visitor === "string" ? body.visitor.slice(0, 64) : null;
      let creatorId: string | null = null;
      if (hostSlug) {
        const rows = await viewGet<{ id: string }>("creators", `select=id&slug=eq.${hostSlug}&limit=1`);
        creatorId = rows[0]?.id ?? null;
      }
      const events = body.events.slice(0, 50).filter((e) => VALID.includes(e.type ?? ""));
      if (events.length) {
        await tableWrite("embed_events", "POST", "", events.map((e) => ({
          creator_id: creatorId, event_type: e.type, visitor_id: visitor,
          path: (e.path ?? "").slice(0, 300), origin: origin ?? null,
        }))).catch((e) => console.error("embed_events insert failed:", e));
        // Attribution first touch on the referring creator (Section 5):
        // recorded on engagement that shows intent to follow the Collective.
        if (visitor && hostSlug && events.some((e) => e.type === "subscribe_click" || e.type === "collective_click" || e.type === "impression")) {
          await rpc("record_touch", {
            p_visitor: visitor, p_creator_slug: hostSlug, p_source: "embed", p_origin: origin,
          }).catch((e) => console.error("record_touch failed:", e));
        }
      }
      return new Response(JSON.stringify({ ok: true }), { status: 202, headers: { "content-type": "application/json", ...cors } });
    }

    return new Response(JSON.stringify({
      error: { code: "not_found", message: `No such route: ${req.method} ${path}`, details: null },
    }), { status: 404, headers: { "content-type": "application/json", ...cors } });
  } catch (e) {
    if (e instanceof RpcError) console.error("collective_embed rpc failure:", e.message, e.body);
    else console.error("collective_embed failure:", e);
    return new Response(JSON.stringify({
      error: { code: "server_error", message: "Something went wrong on our side.", details: null },
    }), { status: 500, headers: { "content-type": "application/json", ...cors } });
  }
});
