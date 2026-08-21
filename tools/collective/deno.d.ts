// Ambient declarations for type checking the edge functions outside Deno.
// Development aid only: never imported by function source and never bundled.
declare namespace Deno {
  export const env: { get(key: string): string | undefined };
  export function serve(handler: (req: Request) => Response | Promise<Response>): unknown;
}
