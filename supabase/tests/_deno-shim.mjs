// supabase/tests/_deno-shim.mjs
// ============================================================================
// Lets Node run Deno-targeted Edge Function sources for TESTING ONLY.
//
// The functions are deployed to Deno, so they legitimately import over https
// and call Deno.env / Deno.serve. Node's ESM loader refuses an https specifier,
// which would otherwise make the pure pricing logic untestable outside a
// deployed environment — and that logic is exactly where the flag-discipline
// bug lived.
//
// This resolves remote specifiers to an inert local stub. It changes NOTHING
// about the deployed function: the source imported by Deno is byte-identical.
//
// Usage: node --experimental-strip-types --import ./supabase/tests/_deno-shim.mjs <test>
// ============================================================================
import { register } from "node:module";
import { pathToFileURL } from "node:url";

globalThis.Deno = globalThis.Deno ?? {};
globalThis.Deno.env = globalThis.Deno.env ?? { get: (k) => process.env[k] };
// Never start a server during a test run.
globalThis.Deno.serve = globalThis.Deno.serve ?? (() => {});

register(pathToFileURL(new URL("./_deno-hooks.mjs", import.meta.url).pathname));
