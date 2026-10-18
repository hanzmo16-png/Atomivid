/**
 * Module hook: every import of the Supabase service client (`@/lib/supabase/service` or a relative
 * `…/lib/supabase/service`) resolves to the in-memory test database (fake-service.ts). Everything else is untouched.
 */
const FAKE = new URL("./fake-service.ts", import.meta.url).href;
const TARGET = /(^@\/lib\/supabase\/service(\.ts)?$)|(\/lib\/supabase\/service(\.ts)?$)/;

export async function resolve(specifier, context, next) {
  if (TARGET.test(specifier) && !context.parentURL?.includes("/scripts/qa/director/")) {
    return { url: FAKE, shortCircuit: true };
  }
  return next(specifier, context);
}
