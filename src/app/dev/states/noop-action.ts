"use server";

/**
 * Server action que no hace nada — solo para que <NewVideoForm> se pueda
 * montar en /dev/states (QA visual local, nunca en producción) sin
 * necesitar la action real de /dashboard/new/actions.ts. Nunca se llama
 * de verdad porque esta página nunca se envía.
 */
export async function noopAction() {}
