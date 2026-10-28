/** Solo lectura: qué funciones de suministro siguen sumando greatest(reserved, committed) o leen dailySpend/monthlySpend. */
import { connectResolved } from "../../lib/supabase-db";
async function main() {
  const { client } = await connectResolved();
  await client.query("begin transaction read only");
  try {
    const { rows } = await client.query("select p.proname, p.prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (p.proname like 'pi\\_supply%' or p.proname like 'pi\\_submit%' or p.proname like 'pi\\_reserve%' or p.proname like 'pi\\_documentary%' or p.proname like 'pi\\_%budget%') order by 1");
    for (const r of rows) {
      const s = String(r.prosrc);
      const f = { greatestReserved: (s.match(/greatest\(\s*reserved_usd/g) || []).length, readsDailySpend: /'dailySpend'|"dailySpend"|->>'dailySpend'/.test(s) && /->>\s*'dailySpend'/.test(s), readsMonthlySpend: /->>\s*'monthlySpend'/.test(s), callsSupplySpend: (s.match(/pi_supply_spend\(/g) || []).length, callsState: (s.match(/pi_supply_state[a-z_]*\(/g) || []).join(" ") };
      console.log("FN", r.proname, JSON.stringify(f));
      if (process.env.SHOW && r.proname === process.env.SHOW) console.log(s);
    }
  } finally { await client.query("rollback"); await client.end(); }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : "error"); process.exitCode = 1; });
