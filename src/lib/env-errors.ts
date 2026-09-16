/**
 * Error tipado y reconocible para "falta una variable de entorno del
 * servidor" — compartido entre Supabase y Stripe para que el código que
 * llama a estas funciones pueda distinguir este caso (con el nombre exacto
 * de la variable) de cualquier otro fallo, en vez de recibir un Error
 * genérico indistinguible.
 */
export class MissingEnvVarError extends Error {
  constructor(public readonly varName: string) {
    super(
      `Falta la variable de entorno "${varName}" (o está vacía). Configúrala en Vercel → Settings → Environment Variables para el entorno Production y vuelve a desplegar.`,
    );
    this.name = "MissingEnvVarError";
  }
}
