import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { LinkButton } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Logo } from "@/components/ui/Logo";

const FLOW_STEPS = [
  { label: "Idea", detail: "Escribes el tema en una frase" },
  { label: "Guion", detail: "IA escribe la narración" },
  { label: "Voz", detail: "Narración con voz natural" },
  { label: "Clips", detail: "Video real por escena" },
  { label: "Edición", detail: "Música, ritmo y subtítulos" },
  { label: "Video final", detail: "Vertical, listo para publicar" },
];

const BENEFITS = [
  {
    title: "De idea a video en minutos",
    body: "Sin cámara, sin edición manual, sin equipo de producción. Escribes el tema y el resto del proceso lo hace la IA.",
  },
  {
    title: "Narración con voz natural",
    body: "Voz en español latinoamericano con ritmo y calidez pensados para retener la atención, no una síntesis robótica.",
  },
  {
    title: "Formato listo para redes",
    body: "Video vertical 9:16, subtítulos incrustados y recursos visuales reales — pensado para publicarse tal cual.",
  },
];

const USE_CASES = [
  { title: "Contenido motivacional", body: "Reflexiones y mensajes cortos con narración cálida y segura." },
  { title: "Ventas y producto", body: "Explica una oferta o un producto en un formato que se ve nativo en redes." },
  { title: "Educación", body: "Convierte un dato o concepto en una pieza corta, clara y fácil de seguir." },
  { title: "Historias", body: "Narrativa con ritmo, ideal para relatos breves y storytelling personal." },
  { title: "Redes sociales", body: "Contenido diario sin depender de grabar, filmar o editar cada vez." },
];

const QUALITY_ITEMS = [
  { title: "Video vertical", body: "1080×1920 — el formato nativo de Reels, TikTok y Shorts." },
  { title: "Narración con IA", body: "Voz elegida y calibrada específicamente para narración comercial en español." },
  { title: "Subtítulos incluidos", body: "Se incrustan automáticamente en cada video, cortados por frase natural." },
  { title: "Recursos visuales reales", body: "Clips e imágenes reales por escena, no plantillas genéricas repetidas." },
  { title: "Música con licencia", body: "Música de fondo con licencia de uso comercial, elegida por el tono del video." },
];

const FAQ = [
  {
    q: "¿Necesito experiencia editando video?",
    a: "No. Describes el tema, revisas el guion generado y Atomivid arma el video completo — narración, clips, música y subtítulos.",
  },
  {
    q: "¿En qué formato se genera el video?",
    a: "Vertical 1080×1920 (9:16), el formato nativo de Reels, TikTok Shorts y YouTube Shorts.",
  },
  {
    q: "¿Puedo revisar el guion antes de generar el video final?",
    a: "Sí. Después de generar el guion puedes revisarlo y regenerar escenas puntuales antes de pasar al render final.",
  },
  {
    q: "¿En qué idiomas narra?",
    a: "Español e inglés. Tú eliges el idioma de la narración al crear la solicitud.",
  },
  {
    q: "¿Atomivid está en beta?",
    a: "Sí. El pipeline de generación (guion, voz, clips, música, subtítulos y render) ya es real y funcional, y seguimos puliendo la experiencia.",
  },
];

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    redirect("/dashboard");
  }

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />

      <main className="flex-1">
        <Hero />
        <FlowDemo />
        <Benefits />
        <UseCases />
        <Quality />
        <Faq />
        <FinalCta />
      </main>

      <SiteFooter />
    </div>
  );
}

function SiteHeader() {
  return (
    <header className="sticky top-0 z-20 border-b border-border bg-canvas/85 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4">
        <Logo />
        <nav className="flex items-center gap-2 sm:gap-3">
          <Link
            href="/login"
            className="rounded-md px-3 py-2 text-sm font-medium text-ink-muted transition-colors hover:text-ink"
          >
            Iniciar sesión
          </Link>
          <LinkButton href="/register" size="sm">
            Crear cuenta
          </LinkButton>
        </nav>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="bg-atomivid-glow border-b border-border px-5 py-16 sm:py-24">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-10 text-center">
        <span className="rounded-full border border-accent-border bg-accent-soft px-3 py-1 text-xs font-medium text-accent">
          Beta pública
        </span>
        <h1 className="max-w-3xl text-4xl font-bold tracking-tight text-ink sm:text-5xl md:text-6xl">
          De una idea a un video vertical, sin cámara ni edición
        </h1>
        <p className="max-w-xl text-balance text-base text-ink-muted sm:text-lg">
          Atomivid convierte un tema en un reel vertical completo — guion, narración,
          clips, música y subtítulos — listo para publicar en minutos. Pensado para
          creadores y marcas que necesitan contenido constante sin producción manual.
        </p>
        <div className="flex flex-col items-center gap-3 sm:flex-row">
          <LinkButton href="/register" size="lg">
            Crear mi primer video
          </LinkButton>
          <LinkButton href="/login" size="lg" variant="secondary">
            Ya tengo cuenta
          </LinkButton>
        </div>
        <p className="text-xs text-ink-faint">Sin tarjeta para explorar la cuenta. Cancela cuando quieras.</p>
      </div>
    </section>
  );
}

function FlowDemo() {
  return (
    <section className="border-b border-border px-5 py-16 sm:py-20">
      <div className="mx-auto max-w-6xl">
        <SectionHeading eyebrow="Cómo funciona" title="Un proceso, seis pasos automáticos" />
        <ol className="mt-10 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          {FLOW_STEPS.map((step, i) => (
            <li key={step.label}>
              <Card className="h-full p-4">
                <span className="text-xs font-semibold text-accent">{String(i + 1).padStart(2, "0")}</span>
                <p className="mt-2 text-sm font-medium text-ink">{step.label}</p>
                <p className="mt-1 text-xs leading-snug text-ink-muted">{step.detail}</p>
              </Card>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Benefits() {
  return (
    <section className="border-b border-border px-5 py-16 sm:py-20">
      <div className="mx-auto max-w-6xl">
        <SectionHeading eyebrow="Por qué Atomivid" title="Construido para publicar rápido, sin verse improvisado" />
        <div className="mt-10 grid gap-5 sm:grid-cols-3">
          {BENEFITS.map((b) => (
            <Card key={b.title} className="p-6">
              <h3 className="text-base font-semibold text-ink">{b.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-muted">{b.body}</p>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}

function UseCases() {
  return (
    <section className="border-b border-border px-5 py-16 sm:py-20">
      <div className="mx-auto max-w-6xl">
        <SectionHeading eyebrow="Casos de uso" title="Para cualquier canal que viva de contenido corto" />
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {USE_CASES.map((u) => (
            <Card key={u.title} className="p-5">
              <p className="text-sm font-semibold text-ink">{u.title}</p>
              <p className="mt-1.5 text-sm text-ink-muted">{u.body}</p>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}

function Quality() {
  return (
    <section className="border-b border-border px-5 py-16 sm:py-20">
      <div className="mx-auto max-w-6xl">
        <SectionHeading eyebrow="Calidad" title="Cada video incluye lo mismo, sin excepciones" />
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {QUALITY_ITEMS.map((q) => (
            <div key={q.title} className="rounded-lg border border-border bg-surface p-5">
              <p className="text-sm font-semibold text-ink">{q.title}</p>
              <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">{q.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Faq() {
  return (
    <section className="border-b border-border px-5 py-16 sm:py-20">
      <div className="mx-auto max-w-3xl">
        <SectionHeading eyebrow="Preguntas frecuentes" title="Lo que la gente suele preguntar" align="center" />
        <div className="mt-8 space-y-3">
          {FAQ.map((item) => (
            <details
              key={item.q}
              className="group rounded-lg border border-border bg-surface px-5 py-4 open:border-accent-border"
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-sm font-medium text-ink marker:content-none">
                {item.q}
                <span className="shrink-0 text-ink-faint transition-transform group-open:rotate-45" aria-hidden="true">
                  +
                </span>
              </summary>
              <p className="mt-3 text-sm leading-relaxed text-ink-muted">{item.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section className="px-5 py-16 sm:py-20">
      <Card className="mx-auto flex max-w-4xl flex-col items-center gap-5 p-10 text-center">
        <h2 className="text-2xl font-bold text-ink sm:text-3xl">Tu primer video puede estar listo hoy</h2>
        <p className="max-w-md text-sm text-ink-muted">
          Crea una cuenta y genera tu primera solicitud — revisas el guion antes de que se produzca el video final.
        </p>
        <LinkButton href="/register" size="lg">
          Crear cuenta gratis
        </LinkButton>
      </Card>
    </section>
  );
}

function SectionHeading({
  eyebrow,
  title,
  align = "left",
}: {
  eyebrow: string;
  title: string;
  align?: "left" | "center";
}) {
  return (
    <div className={align === "center" ? "text-center" : ""}>
      <p className="text-xs font-semibold uppercase tracking-wider text-accent">{eyebrow}</p>
      <h2 className="mt-2 text-2xl font-bold tracking-tight text-ink sm:text-3xl">{title}</h2>
    </div>
  );
}

function SiteFooter() {
  return (
    <footer className="border-t border-border px-5 py-10">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <Logo />
          <p className="mt-3 max-w-xs text-xs text-ink-faint">
            Producto en fase beta. El pipeline de generación de video es real; la
            experiencia sigue en desarrollo activo.
          </p>
        </div>
        <div className="flex flex-wrap gap-x-8 gap-y-3 text-sm">
          <Link href="/privacy" className="text-ink-muted hover:text-ink">
            Privacidad
          </Link>
          <Link href="/terms" className="text-ink-muted hover:text-ink">
            Términos
          </Link>
        </div>
      </div>
      <p className="mx-auto mt-8 max-w-6xl text-xs text-ink-faint">
        © {new Date().getFullYear()} Atomivid. Todos los videos se generan con
        proveedores de IA de terceros bajo licencias de uso comercial.
      </p>
    </footer>
  );
}
