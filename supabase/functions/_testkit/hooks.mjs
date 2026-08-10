// Redirect Deno-style remote specifiers to the local stub so `node
// --experimental-strip-types` can import the real function sources unmodified.
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("https://esm.sh/") || specifier.startsWith("jsr:")) {
    return { url: new URL("./stub-supabase.mjs", import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
