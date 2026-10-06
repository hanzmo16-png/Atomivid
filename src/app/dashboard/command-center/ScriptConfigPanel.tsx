import type { scriptConfigSummary } from "@/lib/supply/script-config";

export function ScriptConfigPanel({ config }: { config: ReturnType<typeof scriptConfigSummary> }) {
  return <section aria-labelledby="script-config-title" className="mx-auto my-6 max-w-7xl rounded-2xl border border-white/10 bg-zinc-950 p-5">
    <h2 id="script-config-title" className="text-lg font-semibold">Configuración de guion</h2>
    <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
      <div><dt className="text-zinc-400">Reels</dt><dd>{config.shortModel}</dd></div>
      <div><dt className="text-zinc-400">Documentales</dt><dd>{config.longModel} · {config.longSource}</dd></div>
      <div><dt className="text-zinc-400">Entrada por millón de tokens</dt><dd>{config.input.usd} USD · {config.input.source}</dd></div>
      <div><dt className="text-zinc-400">Salida por millón de tokens</dt><dd>{config.output.usd} USD · {config.output.source}</dd></div>
    </dl>
    <p className="mt-3 text-sm text-zinc-400">Configuración de esta aplicación. Las tarifas deben contrastarse con el modelo y la cuenta del proveedor; esta vista no certifica saldo ni autoriza gasto.</p>
  </section>;
}
