/**
 * Mystery Shopper 3.0 — libro de gasto real ACUMULADO (autorización t899u: tope USD 8.50 incluidos reintentos).
 *
 * Archivos inmutables en el bucket privado existente (`videos`), prefijo `mystery-shopper/v3/ledger/`:
 *   reserve-<key>.json  {key, module, jobId, reservedUsd, at}    — antes de pulsar «Generar» (upsert:false = atómico)
 *   settle-<key>.json   {key, spentUsd, source, at}               — después, con el gasto que muestra la app
 * Acumulado = Σ gastos liquidados + Σ reservas sin liquidar (una reserva abierta cuenta por su tope completo).
 * Una reserva nunca se borra: si el worker muere, su tope sigue contando hasta que alguien la liquide con el gasto real.
 */
import type { StorageApi } from "../jobs";

export const REAL_CUMULATIVE_CAP_USD = 8.5;
/** Topes por módulo dentro del acumulado (suman 8.50). */
export const MODULE_CAP_USD = { "audio-podcast": 2, youtube: 2, reels: 1.5, "video-podcast": 3 } as const;
export type RealModule = keyof typeof MODULE_CAP_USD;
export const LEDGER_PREFIX = "mystery-shopper/v3/ledger";

export type Reservation = { key: string; module: RealModule; jobId: string; reservedUsd: number; at: string };
export type Settlement = { key: string; spentUsd: number; source: string; at: string };
export type LedgerState = { reservations: Reservation[]; settlements: Settlement[] };

const r2 = (x: number) => Math.round(x * 100) / 100;

export function totals(s: LedgerState) {
  const settled = new Map(s.settlements.map((x) => [x.key, x]));
  let spent = 0, open = 0;
  const byModule: Record<string, number> = {};
  for (const r of s.reservations) {
    const st = settled.get(r.key);
    const v = st ? st.spentUsd : r.reservedUsd;
    if (st) spent += st.spentUsd; else open += r.reservedUsd;
    byModule[r.module] = r2((byModule[r.module] ?? 0) + v);
  }
  return { spentUsd: r2(spent), openReservedUsd: r2(open), committedUsd: r2(spent + open), byModule };
}

/** Decide si se puede reservar `usd` para `module` sin pasar el tope acumulado ni el del módulo. Pura. */
export function canReserve(s: LedgerState, module: RealModule, usd: number, cap = REAL_CUMULATIVE_CAP_USD): { ok: boolean; reason: string } {
  if (!(usd > 0)) return { ok: false, reason: "Reserva inválida (USD ≤ 0)." };
  const t = totals(s);
  if (t.committedUsd + usd > cap + 1e-9) return { ok: false, reason: `Superaría el tope acumulado: USD ${(t.committedUsd + usd).toFixed(2)} > ${cap.toFixed(2)} (comprometido ${t.committedUsd.toFixed(2)}).` };
  const m = (t.byModule[module] ?? 0) + usd;
  if (m > MODULE_CAP_USD[module] + 1e-9) return { ok: false, reason: `Superaría el tope de ${module}: USD ${m.toFixed(2)} > ${MODULE_CAP_USD[module].toFixed(2)}.` };
  return { ok: true, reason: `Dentro del tope (comprometido tras reservar: USD ${(t.committedUsd + usd).toFixed(2)} de ${cap.toFixed(2)}).` };
}

export function ledgerStore(bucket: StorageApi) {
  const read = async (name: string) => { const { data } = await bucket.download(`${LEDGER_PREFIX}/${name}`); return data ? JSON.parse(await data.text()) : null; };
  return {
    async state(): Promise<LedgerState> {
      const { data, error } = await bucket.list(LEDGER_PREFIX, { limit: 1000 });
      if (error) throw new Error(`No se pudo leer el libro de gasto: ${error.message}`);
      const names = (data ?? []).map((d) => d.name);
      const reservations = (await Promise.all(names.filter((n) => n.startsWith("reserve-")).map(read))).filter(Boolean) as Reservation[];
      const settlements = (await Promise.all(names.filter((n) => n.startsWith("settle-")).map(read))).filter(Boolean) as Settlement[];
      return { reservations, settlements };
    },
    /** Reserva atómica: upsert:false; si la clave ya existe, no se crea otra (reintento idempotente). */
    async reserve(r: Reservation): Promise<{ ok: boolean; reason: string }> {
      const s = await this.state();
      if (s.reservations.some((x) => x.key === r.key)) return { ok: false, reason: "Esa reserva ya existe (reintento): no se vuelve a gastar." };
      const can = canReserve(s, r.module, r.reservedUsd);
      if (!can.ok) return can;
      const { error } = await bucket.upload(`${LEDGER_PREFIX}/reserve-${r.key}.json`, JSON.stringify(r), { contentType: "application/json", upsert: false });
      if (error) return { ok: false, reason: `No se pudo reservar: ${error.message}` };
      return can;
    },
    async settle(x: Settlement): Promise<void> {
      const { error } = await bucket.upload(`${LEDGER_PREFIX}/settle-${x.key}.json`, JSON.stringify(x), { contentType: "application/json", upsert: false });
      if (error && !/exists|duplicate|409/i.test(error.message)) throw new Error(`No se pudo liquidar: ${error.message}`);
    },
  };
}
