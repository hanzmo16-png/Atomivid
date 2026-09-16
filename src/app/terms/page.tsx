import type { Metadata } from "next";
import { LegalLayout } from "@/components/legal/LegalLayout";

export const metadata: Metadata = { title: "Términos" };

export default function TermsPage() {
  return (
    <LegalLayout title="Términos de uso" updated="Última actualización: beta">
      <p>
        Atomivid es un producto en fase beta. Al usarlo, aceptas estas condiciones,
        que pueden ajustarse antes del lanzamiento público.
      </p>

      <h2>Qué es el servicio</h2>
      <p>
        Atomivid genera videos verticales a partir de un tema que tú proporcionas,
        combinando guion, narración, recursos visuales, música y subtítulos generados
        o seleccionados mediante inteligencia artificial.
      </p>

      <h2>Tu responsabilidad sobre el contenido</h2>
      <p>
        Eres responsable del tema y las instrucciones que envías, y del uso que le das
        al video generado. No uses Atomivid para producir contenido ilegal, difamatorio
        o que infrinja derechos de terceros.
      </p>

      <h2>Suscripción y pagos</h2>
      <p>
        Los pagos se procesan a través de Stripe. Puedes cancelar tu suscripción en
        cualquier momento desde el panel de facturación; la cancelación aplica al
        final del período ya pagado.
      </p>

      <h2>Disponibilidad durante la beta</h2>
      <p>
        Por ser una beta, el servicio puede tener interrupciones, límites de uso o
        cambios sin aviso previo extenso. Haremos lo posible por comunicar cambios
        importantes con anticipación.
      </p>

      <h2>Límites de responsabilidad</h2>
      <p>
        Atomivid se ofrece &quot;tal cual&quot; durante esta fase. No garantizamos que el
        servicio esté libre de errores en todo momento.
      </p>
    </LegalLayout>
  );
}
