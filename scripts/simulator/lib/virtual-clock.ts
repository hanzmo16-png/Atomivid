/**
 * Reloj virtual para los sondeos de avatar: HeyGen espera 10 s entre sondeos
 * con un plazo de 600 s; D-ID, 3-20 s con un plazo de 300 s. Para recorrer
 * esos plazos reales sin esperar, mientras dura `withVirtualTime` cada
 * setTimeout de ≥ 250 ms se dispara de inmediato y adelanta Date.now() en lo
 * mismo. El código del adaptador no cambia; solo el paso del tiempo.
 */
export async function withVirtualTime<T>(fn: () => Promise<T>): Promise<{ result?: T; error?: unknown; virtualMs: number }> {
  const realSetTimeout = globalThis.setTimeout;
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  globalThis.setTimeout = ((cb: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const delay = Number(ms ?? 0);
    if (delay >= 250) {
      offset += delay;
      return realSetTimeout(cb, 0, ...args);
    }
    return realSetTimeout(cb, delay, ...args);
  }) as typeof setTimeout;
  try {
    const result = await fn();
    return { result, virtualMs: offset };
  } catch (error) {
    return { error, virtualMs: offset };
  } finally {
    globalThis.setTimeout = realSetTimeout;
    Date.now = realNow;
  }
}
