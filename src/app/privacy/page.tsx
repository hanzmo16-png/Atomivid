import type { Metadata } from "next";
import { LegalLayout } from "@/components/legal/LegalLayout";

export const metadata: Metadata = { title: "Privacidad" };

export default function PrivacyPage() {
  return (
    <LegalLayout title="Privacidad" updated="Última actualización: beta">
      <p>
        Atomivid está en fase beta. Este documento describe, de forma clara y sin
        tecnicismos, qué datos maneja el producto hoy.
      </p>

      <h2>Qué datos guardamos</h2>
      <ul>
        <li>Tu correo electrónico, para el inicio de sesión.</li>
        <li>
          El contenido de tus solicitudes de video (tema, idioma, estilo, duración) y
          el guion generado para cada una.
        </li>
        <li>El video final generado, almacenado de forma privada y accesible solo por ti.</li>
        <li>
          Si te suscribes, datos de facturación gestionados directamente por Stripe —
          Atomivid no almacena números de tarjeta.
        </li>
      </ul>

      <h2>Cómo se usa</h2>
      <p>
        Tu tema y guion se envían a proveedores de IA de terceros (para generar texto,
        voz y seleccionar recursos visuales) únicamente para producir tu video. No
        vendemos tus datos ni los usamos para entrenar modelos propios.
      </p>

      <h2>Quién puede ver tus videos</h2>
      <p>
        Solo tú. Los videos se guardan en almacenamiento privado y el acceso se otorga
        mediante enlaces temporales generados únicamente para tu sesión autenticada.
      </p>

      <h2>Eliminación de tu cuenta</h2>
      <p>
        Esta beta todavía no tiene un flujo de autoservicio para eliminar la cuenta.
        Si quieres que eliminemos tu cuenta y tus datos, contáctanos por el canal de
        soporte que se habilite antes del lanzamiento público.
      </p>
    </LegalLayout>
  );
}
