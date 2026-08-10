// A minimal `Deno` global so Deno-targeted Edge Function sources can be
// imported under Node.
//
// This exists so the tests can run against index.single.ts — the MERGED file
// that is actually pasted into Supabase — and not only against _lib.ts. The
// merged file reads Deno.env at module scope, so without this it throws
// "Deno is not defined" on import and the deployed artifact goes untested
// while the sources look green.
//
// EDGEDESK_AI_NO_SERVE is set here because the merged file calls Deno.serve at
// module scope in production; under test we want the module's exports, not a
// listening socket.

if (typeof globalThis.Deno === "undefined") {
  const env = { ...process.env, EDGEDESK_AI_NO_SERVE: "1" };
  globalThis.Deno = {
    env: {
      get: (k) => env[k],
      set: (k, v) => { env[k] = v; },
      has: (k) => k in env,
      toObject: () => ({ ...env }),
    },
    // Present but inert: a test importing the handler must not bind a port.
    serve: () => ({ finished: Promise.resolve(), shutdown: () => {} }),
    exit: (code) => process.exit(code ?? 0),
  };
}
