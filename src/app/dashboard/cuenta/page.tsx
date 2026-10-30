import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { signOut } from "@/app/auth/actions";
import { Card } from "@/components/ui/Card";
import { isSubscriptionActive } from "@/lib/billing/subscription";
import { isInternalProductionOwner } from "@/lib/billing/internal-production";
import { isLongFormEnabled, isLongFormAllowlisted } from "@/lib/video/long-form/access";
import { isCommandCenterAdmin } from "@/lib/command-center/access";

/**
 * Mi cuenta (Simple UX 1.0): correo, plan, cerrar sesión y, solo para quien tiene acceso, las herramientas internas que
 * antes estaban en el menú principal (pruebas Long Form, centro de mando). Mismos permisos que sus páginas.
 */
export default async function AccountPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { data: sub } = await supabase.from("subscriptions").select("status").eq("user_id", user.id).maybeSingle();
  const subscribed = isSubscriptionActive((sub as { status: string } | null)?.status);
  const owner = isInternalProductionOwner(user);
  const tools = [
    ...(isLongFormEnabled() && isLongFormAllowlisted(user) ? [{ href: "/dashboard/long-form/visual-test-v2", label: "Pruebas de video largo (sin costo)" }] : []),
    ...(isCommandCenterAdmin(user) ? [{ href: "/dashboard/command-center", label: "Centro de mando" }] : []),
  ];
  return (
    <div className="mx-auto w-full min-w-0 max-w-2xl">
      <h1 className="text-2xl font-bold text-ink">Mi cuenta</h1>
      <Card className="mt-4 p-4">
        <p className="text-sm text-ink-muted">Correo</p>
        <p className="break-words font-medium text-ink" data-testid="cuenta-correo">{user.email}</p>
        <p className="mt-4 text-sm text-ink-muted">Plan</p>
        <p className="font-medium text-ink" data-testid="cuenta-plan">
          {owner ? "Plan Propietario: producción al costo de proveedores, con los topes de gasto configurados." : subscribed ? "Suscripción activa." : "Sin suscripción activa."}
        </p>
        <Link href="/dashboard/billing" className="mt-2 inline-block text-sm text-accent underline">{subscribed || owner ? "Ver facturación" : "Suscribirme"}</Link>
        <form action={signOut} className="mt-6">
          <button type="submit" className="min-h-11 rounded-md border border-border px-4 text-sm font-medium text-ink">Cerrar sesión</button>
        </form>
      </Card>
      {tools.length > 0 && (
        <Card className="mt-4 p-4" data-testid="herramientas-internas">
          <h2 className="text-sm font-semibold text-ink">Herramientas internas</h2>
          <p className="mt-1 text-xs text-ink-muted">Solo visibles para tu cuenta. No forman parte del flujo de tus clientes.</p>
          <ul className="mt-2 grid gap-1">
            {tools.map((t) => <li key={t.href}><Link href={t.href} className="text-sm text-accent underline">{t.label}</Link></li>)}
          </ul>
        </Card>
      )}
    </div>
  );
}
