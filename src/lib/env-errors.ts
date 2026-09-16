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

/**
 * Igual que MissingEnvVarError pero para el caso en que la variable SÍ
 * está configurada, con un formato reconociblemente incorrecto (p. ej.
 * "GH_WORKER_REPO" sin la forma "owner/repo") — nunca incluye el valor
 * real en el mensaje, solo el nombre de la variable y qué formato se
 * esperaba, para no arriesgar exponer algo sensible.
 */
export class InvalidEnvVarError extends Error {
  constructor(
    public readonly varName: string,
    expectedFormat: string,
  ) {
    super(
      `La variable de entorno "${varName}" tiene un formato inválido (se esperaba ${expectedFormat}). Configúrala en Vercel → Settings → Environment Variables para el entorno Production y vuelve a desplegar.`,
    );
    this.name = "InvalidEnvVarError";
  }
}
