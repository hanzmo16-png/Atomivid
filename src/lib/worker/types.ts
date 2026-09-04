/**
 * Abstracción del worker que procesa el render en segundo plano — mismo
 * patrón que los proveedores de guion/voz/footage/música (una interfaz
 * común, varias implementaciones intercambiables por env var). Permite
 * sustituir GitHub Actions por Remotion Lambda u otro worker de pago más
 * adelante sin tocar la ruta API ni el pipeline de render.
 */
export interface RenderWorker {
  readonly name: string;
  /**
   * Encola/dispara el trabajo de render para `requestId`. La solicitud ya
   * está marcada como "processing" cuando se llama esto — cada
   * implementación decide si corre el pipeline ella misma (worker
   * "inline") o solo notifica a un sistema externo que lo hará (worker de
   * GitHub Actions, que dispara el workflow y retorna de inmediato).
   */
  trigger(input: { requestId: string }): Promise<void>;
}
