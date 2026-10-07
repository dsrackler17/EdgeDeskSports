/* Node loader hook for the Edge Function tests: Deno's npm: specifiers have
   no meaning to Node, so the SDK import resolves to a local stand-in. */
export async function resolve(specifier, context, next) {
  if (specifier === 'npm:@anthropic-ai/sdk') return { url: new URL('./anthropic_sdk.mjs', import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
