import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { LinkButton } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Logo } from "@/components/ui/Logo";
import { HeroVisual } from "@/components/ui/HeroVisual";
import { LandingView, TrackCta } from "@/components/marketing/Tracking";
import { PLAN_CONFIGS, PLAN_ORDER } from "@/lib/billing/plans";
import { salesOpen } from "@/lib/billing/sales";

const FLOW_STEPS = [
  { label: "Idea", detail: "Escribes el tema en una frase" },
  { label: "Guion", detail: "IA escribe la narración" },
  { label: "Voz", detail: "Narración con voz natural" },
  { label: "Clips", detail: "Video real por escena" },
  { label: "Edición", detail: "Música, ritmo y subtítulos" },
  { label: "Video final", detail: "Vertical 9:16, para descargar" },
];

const BENEFITS = [
  {
    title: "De idea a video sin editar",
    body: "Sin cámara ni edición manual. Escribes el tema, revisas el guion y Atomivid arma narración, clips, música y subtítulos.",
    icon: IconBolt,
  },
  {
    title: "Narración con IA",
    body: "Voz sintética en español o inglés; eliges el idioma al crear cada video.",
    icon: IconWave,
  },
  {
    title: "Formato listo para redes",
    body: "Video vertical 9:16 de 30, 60 o 90 segundos, con subtítulos incrustados y clips o imágenes por escena.",
    icon: IconPhone,
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
  { title: "Narración con IA", body: "Voz sintética en español o inglés, a tu elección en cada video." },
  { title: "Subtítulos incluidos", body: "Se incrustan automáticamente en cada video, cortados por frase natural." },
  { title: "Recursos visuales", body: "Clips e imágenes de archivo elegidos para cada escena." },
  { title: "Música de fondo", body: "Una pista de fondo elegida según el tono del video." },
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
    q: "¿Hay prueba gratis?",
    a: "No. Crear la cuenta no tiene costo y no pide tarjeta, pero generar guiones y videos requiere un plan de pago activo. Puedes cancelar cuando quieras desde tu cuenta.",
  },
  {
    q: "¿Hacen videos horizontales para YouTube?",
    a: "Los documentales 16:9 están en acceso anticipado para un grupo reducido. Puedes apuntarte a la lista; no tienen precio ni fecha de apertura todavía.",
  },
  {
    q: "¿Atomivid está en beta?",
    a: "Sí. Seguimos mejorando el producto y la calidad de los videos; si algo falla, tu solicitud queda guardada y lo ya generado no se cobra dos veces.",
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
        <Pricing />
        <Roadmap />
        <Faq />
        <FinalCta />
      </main>

      <SiteFooter />
      <LandingView />
    </div>
  );
}

function SiteHeader() {
  return (
    <header className="sticky top-0 z-20 border-b border-border bg-canvas/85 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4">
        <Logo />
        <nav className="flex items-center gap-2 sm:gap-3">
          <Link href="#planes" className="rounded-md px-3 py-2 text-sm font-medium text-ink-muted transition-colors hover:text-ink">
            Planes
          </Link>
          <TrackCta cta="header_login">
            <Link
              href="/login"
              className="rounded-md px-3 py-2 text-sm font-medium text-ink-muted transition-colors hover:text-ink"
            >
              Iniciar sesión
            </Link>
          </TrackCta>
          {salesOpen() ? (
            <TrackCta cta="header_register">
              <LinkButton href="/register" size="sm">
                Crear cuenta
              </LinkButton>
            </TrackCta>
          ) : (
            <TrackCta cta="header_waitlist">
              <LinkButton href="/avisame" size="sm">
                Avisarme
              </LinkButton>
            </TrackCta>
          )}
        </nav>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="bg-atomivid-glow relative overflow-hidden border-b border-border px-5 py-16 sm:py-24">
      <div
        className="pointer-events-none absolute -bottom-32 -right-24 size-[26rem] rounded-full bg-[#3b82f6] opacity-[0.16] blur-[90px]"
        aria-hidden="true"
      />
      <div className="relative mx-auto grid max-w-6xl items-center gap-14 lg:grid-cols-[1.1fr_0.9fr] lg:gap-10">
        <div className="flex flex-col items-center gap-7 text-center lg:items-start lg:text-left">
          <span className="rounded-full border border-accent-border bg-accent-soft px-3 py-1 text-xs font-medium text-accent">
            Beta pública
          </span>
          <h1 className="max-w-xl text-4xl font-bold tracking-tight text-ink sm:text-5xl lg:text-6xl">
            De una idea a un video vertical, sin cámara ni edición
          </h1>
          <p className="max-w-lg text-balance text-base text-ink-muted sm:text-lg">
            Atomivid convierte un tema en un reel vertical completo — guion, narración,
            clips, música y subtítulos — que revisas antes de producir y descargas en
            1080×1920. Para creadores y marcas que necesitan contenido constante.
          </p>
          <div className="flex flex-col items-center gap-3 sm:flex-row">
            {salesOpen() ? (
              <TrackCta cta="hero_register">
                <LinkButton href="/register" size="lg">
                  Crear cuenta
                </LinkButton>
              </TrackCta>
            ) : (
              <TrackCta cta="hero_waitlist">
                <LinkButton href="/avisame" size="lg">
                  Avisarme cuando abran los pagos
                </LinkButton>
              </TrackCta>
            )}
            <TrackCta cta="hero_pricing">
              <LinkButton href="#planes" size="lg" variant="secondary">
                Ver planes
              </LinkButton>
            </TrackCta>
          </div>
          <p className="text-xs text-ink-faint">
            {salesOpen()
              ? `Crear la cuenta no pide tarjeta. Para generar videos necesitas un plan de pago (desde ${PLAN_CONFIGS.starter.priceUsdPerMonth} USD al mes).`
              : `Todavía no aceptamos pagos. Los planes empezarán en ${PLAN_CONFIGS.starter.priceUsdPerMonth} USD al mes; apúntate y te avisamos cuando puedas contratar.`}
          </p>
        </div>
        <HeroVisual />
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
            <Card key={b.title} className="p-6 transition-colors hover:border-accent-border">
              <span className="flex size-10 items-center justify-center rounded-lg bg-accent-soft text-accent">
                <b.icon />
              </span>
              <h3 className="mt-4 text-base font-semibold text-ink">{b.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-muted">{b.body}</p>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}

function IconBolt() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M10 1.5 3 10.5h4.5L8 16.5l7-9.5h-4.5L10 1.5z" fill="currentColor" />
    </svg>
  );
}

function IconWave() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <path d="M2 9h1.5" />
        <path d="M5 5.5v7" />
        <path d="M8 3v12" />
        <path d="M11 6v6" />
        <path d="M14 4.5v9" />
        <path d="M16.5 9H17" />
      </g>
    </svg>
  );
}

function IconPhone() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="4.5" y="1.5" width="9" height="15" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 14.5h2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
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
        <SectionHeading eyebrow="Qué incluye" title="Qué trae cada Reel" />
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
        {salesOpen() ? (
          <>
            <h2 className="text-2xl font-bold text-ink sm:text-3xl">Empieza con tu primer Reel</h2>
            <p className="max-w-md text-sm text-ink-muted">
              Crea tu cuenta, elige un plan y genera tu primer guion. Lo revisas antes de que se produzca el video final.
            </p>
            <TrackCta cta="final_register">
              <LinkButton href="/register" size="lg">
                Crear cuenta
              </LinkButton>
            </TrackCta>
          </>
        ) : (
          <>
            <h2 className="text-2xl font-bold text-ink sm:text-3xl">Te avisamos cuando abran los planes</h2>
            <p className="max-w-md text-sm text-ink-muted">
              Todavía no aceptamos pagos. Deja tu correo y te escribimos cuando puedas contratar tu plan de Reels/Shorts.
            </p>
            <TrackCta cta="final_waitlist">
              <LinkButton href="/avisame" size="lg">
                Avisarme
              </LinkButton>
            </TrackCta>
          </>
        )}
      </Card>
    </section>
  );
}

function Pricing() {
  return (
    <section id="planes" className="scroll-mt-20 border-b border-border px-5 py-16 sm:py-20">
      <div className="mx-auto max-w-6xl">
        <SectionHeading eyebrow="Planes" title="Precios de Reels/Shorts" />
        <p className="mt-3 max-w-2xl text-sm text-ink-muted">
          Precios en USD por mes, cobrados con Stripe. Sin prueba gratuita: crear la cuenta no tiene costo y generar
          videos requiere un plan activo. Cancelas cuando quieras desde tu cuenta.
        </p>
        {!salesOpen() && (
          <p className="mt-3 max-w-2xl rounded-md border border-border bg-surface px-4 py-3 text-sm text-ink">
            Todavía no aceptamos pagos, así que aún no se pueden contratar estos planes ni generar videos. No se te cobrará nada.
          </p>
        )}
        <div className="mt-8 grid gap-4 sm:grid-cols-3">
          {PLAN_ORDER.map((id) => {
            const plan = PLAN_CONFIGS[id];
            return (
              <Card key={id} className="flex flex-col p-6">
                <p className="text-sm font-semibold uppercase tracking-wide text-ink-faint">{plan.name}</p>
                <p className="mt-1 text-3xl font-bold text-ink">
                  ${plan.priceUsdPerMonth}
                  <span className="text-sm font-normal text-ink-muted">/mes</span>
                </p>
                <ul className="mt-4 flex-1 space-y-2 text-sm text-ink-muted">
                  {plan.includes.map((item) => (
                    <li key={item}>· {item}</li>
                  ))}
                </ul>
              </Card>
            );
          })}
        </div>
        <div className="mt-6">
          {salesOpen() ? (
            <TrackCta cta="pricing_register">
              <LinkButton href="/register">Crear cuenta y elegir plan</LinkButton>
            </TrackCta>
          ) : (
            <TrackCta cta="pricing_waitlist">
              <LinkButton href="/avisame">Avisarme cuando abran los pagos</LinkButton>
            </TrackCta>
          )}
        </div>
      </div>
    </section>
  );
}

function Roadmap() {
  return (
    <section className="border-b border-border px-5 py-16 sm:py-20">
      <div className="mx-auto max-w-6xl">
        <SectionHeading eyebrow="Disponibilidad" title="Qué puedes usar hoy y qué viene" />
        <div className="mt-8 grid gap-4 sm:grid-cols-3">
          <Card className="p-6">
            <p className="text-xs font-semibold uppercase tracking-wider text-accent">{salesOpen() ? "Disponible" : "Apertura de pagos pendiente"}</p>
            <p className="mt-2 text-base font-semibold text-ink">Reels/Shorts verticales</p>
            <p className="mt-1.5 text-sm text-ink-muted">
              {salesOpen() ? "Con cualquiera de los planes de arriba." : "Requiere un plan de pago y todavía no aceptamos pagos. Puedes apuntarte para que te avisemos."}
            </p>
          </Card>
          <Card className="p-6">
            <p className="text-xs font-semibold uppercase tracking-wider text-ink-faint">Acceso anticipado</p>
            <p className="mt-2 text-base font-semibold text-ink">Documentales para YouTube (16:9)</p>
            <p className="mt-1.5 text-sm text-ink-muted">Para un grupo reducido, sin precio ni fecha de apertura todavía.</p>
            <div className="mt-4">
              <TrackCta cta="early_access_open">
                <LinkButton href="/acceso-anticipado" size="sm" variant="secondary">Apuntarme a la lista</LinkButton>
              </TrackCta>
            </div>
          </Card>
          <Card className="p-6">
            <p className="text-xs font-semibold uppercase tracking-wider text-ink-faint">Próximamente</p>
            <p className="mt-2 text-base font-semibold text-ink">Podcast Creator</p>
            <p className="mt-1.5 text-sm text-ink-muted">En desarrollo. Todavía no está disponible.</p>
          </Card>
        </div>
      </div>
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
