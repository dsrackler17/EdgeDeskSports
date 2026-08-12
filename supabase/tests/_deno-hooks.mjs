// supabase/tests/_deno-hooks.mjs
// Module-resolution hooks: map remote (https/jsr/npm) specifiers used by the
// Deno Edge Functions onto an inert local stub so Node can load the source.
// TEST INFRASTRUCTURE ONLY — the deployed source is unchanged.

const STUB = "data:text/javascript," + encodeURIComponent(`
  // Inert stand-ins. The tests here exercise pure pricing logic and never touch
  // the database; anything that DID touch it would fail loudly rather than
  // silently returning plausible data, which is the behaviour we want.
  export function createClient() {
    const die = () => { throw new Error("database access is not available in the pure-logic test harness"); };
    const chain = { upsert: die, insert: die, update: die, select: die, eq: die, is: die, from: die };
    return { from: () => chain };
  }
  export default { createClient };
`);

export async function resolve(specifier, context, next) {
  if (/^(https?|jsr|npm):/.test(specifier)) {
    return { url: STUB, shortCircuit: true, format: "module" };
  }
  return next(specifier, context);
}
