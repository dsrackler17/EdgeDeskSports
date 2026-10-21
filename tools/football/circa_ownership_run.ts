// @ts-nocheck — run with Deno, the edge function's own runtime.
/* ===========================================================================
   CIRCA OWNERSHIP, RUN ONCE — supabase/functions/circa_ownership_sync/index.ts
   executed in this process instead of on Supabase.

     deno run --node-modules-dir=none --allow-net --allow-env --allow-read --allow-write \
       tools/football/circa_ownership_run.ts

   (--node-modules-dir=none: run from the repo, Deno would otherwise see its
   package.json and look for npm:unpdf in node_modules, not in its own cache)

   WHY. The deployed function cannot finish a real week. Reading the
   selections PDF (every entry's five picks, thousands of entries) needs more
   compute than an edge worker has, and Supabase answers 546
   WORKER_RESOURCE_LIMIT (2026-10-21, Week 6 of Million VIII). A GitHub runner
   has no such limit, so .github/workflows/circa-ownership.yml runs the same
   file here. Nothing is copied or rewritten: the function file is imported as
   it is deployed, with Deno.serve captured, and called once. It writes through
   contest_ownership_ingest() / contest_ownership_fail() with the service role,
   exactly as the deployed function would.

   ENV  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   required (the workflow maps
                                                  SB_URL / SB_SERVICE_ROLE)
        CIRCA_WEEK, CIRCA_DRY, CIRCA_FORCE, CIRCA_URL
                                                  optional: the POST body's
                                                  week / dry / force / url
        GITHUB_STEP_SUMMARY                       optional: a one-row summary

   EXIT 0  recorded; skipped (already complete, unchanged, outside the contest
           weeks); a dry run that read; or no PDF yet, which the function has
           recorded as a WARNING (a FAILURE after Sunday 13:00 ET) and which
           this run annotates as a warning
        1  anything else: the run failed, or the function could not be called
   =========================================================================== */

const FN = new URL("../../supabase/functions/circa_ownership_sync/index.ts", import.meta.url).href;

function fail(msg: string): never {
  console.log("::error::" + msg);
  Deno.exit(1);
}

const need = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].filter((k) => !Deno.env.get(k));
if (need.length) fail(need.join(" and ") + " not set: nothing was run");

const body: Record<string, unknown> = { source: "github_actions" };
const week = (Deno.env.get("CIRCA_WEEK") ?? "").trim();
if (week) {
  if (!/^\d{1,2}$/.test(week)) fail("CIRCA_WEEK must be a week number, not " + JSON.stringify(week));
  body.week = Number(week);
}
const flag = (k: string) => /^(1|true|yes)$/i.test((Deno.env.get(k) ?? "").trim());
if (flag("CIRCA_DRY")) body.dry = true;
if (flag("CIRCA_FORCE")) body.force = true;
const url = (Deno.env.get("CIRCA_URL") ?? "").trim();
if (url) body.url = url;

// this process is both caller and function, so the secret is made here and never leaves it
const secret = crypto.randomUUID();
Deno.env.set("CIRCA_CRON_SECRET", secret);
let handler: ((req: Request) => Promise<Response>) | null = null;
(Deno as any).serve = (a: any, b?: any) => {
  handler = typeof a === "function" ? a : b;
  return { finished: Promise.resolve(), shutdown: async () => {}, addr: null };
};
await import(FN);
if (!handler) fail("the function registered no handler");

let res: Response, out: any;
try {
  res = await handler(new Request("http://localhost/", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cron-secret": secret },
    body: JSON.stringify(body),
  }));
  out = await res.json();
} catch (e) {
  fail("the function threw: " + String((e as Error)?.message ?? e).slice(0, 300));
}

const noPdf = out?.ok === false && out?.code === "pdf_not_found";
const good = res.ok && out?.ok === true;
const wk = out?.week ?? body.week ?? "current";
const outcome = good
  ? (out.skipped ? "skipped: " + out.skipped
    : out.dry ? "dry run read " + (out.run?.entries_parsed ?? "?") + " entries (" + (out.run?.status ?? "?") + "), " + (out.sides?.length ?? 0) + " sides; nothing written"
    : "recorded " + out.status + ": " + out.entries + " entries, " + out.sides + " sides")
  : (out?.code ?? "HTTP " + res.status) + ": " + (out?.message ?? out?.error ?? "no message");

console.log(JSON.stringify(out, null, 1));
console.log((good ? "OK" : noPdf ? "NO PDF YET" : "FAILED") + " | Circa Million week " + wk + " | " + outcome);
if (noPdf) console.log("::warning::Circa Million week " + wk + ": " + out.message + (body.dry ? " (dry run)" : " (recorded by contest_ownership_fail)"));
else if (!good) console.log("::error::Circa Million week " + wk + ": " + outcome);

const summary = Deno.env.get("GITHUB_STEP_SUMMARY");
if (summary) {
  const md = "| Circa Million week | result | source |\n|---|---|---|\n| " + wk + " | " + outcome.replace(/\|/g, "/") + " | " + (out?.url ?? out?.run?.source_url ?? "—") + " |\n";
  await Deno.writeTextFile(summary, md, { append: true });
}
Deno.exit(good || noPdf ? 0 : 1);
