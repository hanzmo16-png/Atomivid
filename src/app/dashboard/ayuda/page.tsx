import Link from "next/link";
import { Card } from "@/components/ui/Card";

const STEPS = [
  { title: "1. Elige qué crear", body: "En el inicio, toca Reel, Podcast o Video de YouTube." },
  { title: "2. Escribe tu idea", body: "Una frase basta. Puedes cambiarla en el siguiente paso." },
  { title: "3. Revisa antes de pagar", body: "Verás qué se va a generar y el costo máximo. Nada se cobra sin tu autorización." },
  { title: "4. Sigue el progreso", body: "En «Mis proyectos» ves en qué etapa va. Puedes cerrar la página: sigue avanzando." },
  { title: "5. Descarga", body: "Cuando esté listo, reprodúcelo y descárgalo desde «Mis proyectos»." },
];
const FAQ = [
  { q: "¿Cuánto cuesta?", a: "Antes de producir te mostramos el costo estimado y el máximo que autorizas. Nunca se cobra más de ese máximo." },
  { q: "¿Qué pasa si algo falla?", a: "Lo verás en «Mis proyectos» con una explicación y, cuando se puede, la opción de reintentar." },
  { q: "¿Dónde están mis pruebas antiguas?", a: "Las que no terminaron hace más de 7 días quedan plegadas en «Proyectos antiguos sin terminar». No se borra nada." },
];

/** Ayuda (Simple UX 1.0): cómo crear, en cinco pasos, y respuestas cortas. Describe solo lo que el producto hace hoy. */
export default function HelpPage() {
  return (
    <div className="mx-auto w-full min-w-0 max-w-2xl">
      <h1 className="text-2xl font-bold text-ink">Ayuda</h1>
      <Card className="mt-4 p-4">
        <h2 className="text-sm font-semibold text-ink">Cómo crear</h2>
        <ol className="mt-2 grid gap-3">
          {STEPS.map((s) => <li key={s.title}><p className="font-medium text-ink">{s.title}</p><p className="text-sm text-ink-muted">{s.body}</p></li>)}
        </ol>
        <Link href="/dashboard#crear" className="mt-4 inline-block text-sm font-medium text-accent underline">Empezar ahora</Link>
      </Card>
      <Card className="mt-4 p-4">
        <h2 className="text-sm font-semibold text-ink">Preguntas frecuentes</h2>
        <dl className="mt-2 grid gap-3">
          {FAQ.map((f) => <div key={f.q}><dt className="font-medium text-ink">{f.q}</dt><dd className="text-sm text-ink-muted">{f.a}</dd></div>)}
        </dl>
      </Card>
    </div>
  );
}
