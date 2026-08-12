// supabase/tests/_deno-hooks.mjs
// Module-resolution hooks: map remote (https/jsr/npm) specifiers used by the
// Deno Edge Functions onto an inert local stub so Node can load the source.
// TEST INFRASTRUCTURE ONLY — the deployed source is unchanged.

const STUB = "data:text/javascript," + encodeURIComponent(`
  // Inert stand-ins. The pure-logic tests never touch the database, and
  // anything that DID touch it must fail loudly rather than silently returning
  // plausible data — that is the default below.
  //
  // A test that needs to assert on WHAT capture writes (which columns phase B
  // sends, whether the flag update is guarded) can set globalThis.__MOCK_DB__
  // to a recording client before importing the function. Opt-in, so the
  // fail-loudly default still applies everywhere else.
  export function createClient() {
    if (globalThis.__MOCK_DB__) return globalThis.__MOCK_DB__;
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
