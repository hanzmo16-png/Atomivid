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

      <h2 id="avatar-consent">Modo avatar y consentimiento sobre tu fotografía</h2>
      <p>
        El modo avatar (cuando está disponible) genera un video en el que una fotografía
        que tú proporcionas narra el guion con voz y labios sincronizados. Al subir una
        fotografía y marcar la casilla de consentimiento, declaras y garantizas que:
      </p>
      <ul>
        <li>
          Eres la persona que aparece en la fotografía, o cuentas con autorización
          expresa y verificable de esa persona para crear un avatar animado a partir de
          su rostro.
        </li>
        <li>
          La fotografía no corresponde a una persona menor de edad.
        </li>
        <li>
          No usarás este modo para suplantar, engañar o difamar a nadie, ni para crear
          contenido que sugiera que una persona real dijo o hizo algo que no dijo ni
          hizo.
        </li>
        <li>
          No subirás fotografías de terceros (incluidas figuras públicas) sin su
          autorización expresa, aunque la fotografía sea de acceso público.
        </li>
      </ul>
      <p>
        Este consentimiento es una condición de producto de Atomivid, exigida siempre
        que uses el modo avatar. Es independiente de cualquier mecanismo de
        verificación de identidad que el proveedor externo que procesa el avatar
        (actualmente HeyGen) exija por su cuenta — un avatar personalizado creado a
        partir de una fotografía cargada por ti no sustituye ni satisface, por sí solo,
        los requisitos de verificación de identidad que ese proveedor pueda exigir para
        ciertos tipos de avatar antes de permitir su uso en producción. Consulta
        <code>docs/AVATAR_MODE.md</code> en el repositorio para el detalle técnico
        actualizado sobre qué está confirmado y qué no.
      </p>
      <p>
        Puedes solicitar la eliminación de la fotografía fuente y del avatar creado a
        partir de ella en cualquier momento; el borrado en nuestro almacenamiento se
        confirma de forma inmediata, y el borrado en el proveedor externo se intenta
        pero no siempre puede confirmarse (ver documentación técnica citada arriba).
      </p>
    </LegalLayout>
  );
}
