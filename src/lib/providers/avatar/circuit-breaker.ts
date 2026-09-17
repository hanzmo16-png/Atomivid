/**
 * Circuit breaker simple, en memoria, por proceso — protege contra fallos
 * repetidos del proveedor de avatar dentro de UNA misma ejecución del
 * worker (que hace varias llamadas: crear avatar, sondear estado, crear
 * video, sondear estado de nuevo). No persiste entre ejecuciones (cada
 * render corre en su propio proceso de GitHub Actions) — su propósito es
 * dejar de insistir contra un proveedor que ya demostró estar caído en
 * esta misma solicitud, no reemplazar un sistema de monitoreo global.
 */
export type CircuitBreakerState = "closed" | "open";

export class CircuitBreaker {
  private consecutiveFailures = 0;
  private state: CircuitBreakerState = "closed";

  constructor(private readonly failureThreshold: number = 3) {}

  getState(): CircuitBreakerState {
    return this.state;
  }

  /** Lanza si el circuito ya está abierto — llamar ANTES de intentar la operación. */
  assertClosed(): void {
    if (this.state === "open") {
      throw new Error(
        `Circuito abierto tras ${this.consecutiveFailures} fallos consecutivos — no se reintenta más en esta ejecución.`,
      );
    }
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = "closed";
  }

  recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.state = "open";
    }
  }
}
