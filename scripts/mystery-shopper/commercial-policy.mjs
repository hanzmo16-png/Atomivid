export const ORIGIN = 'https://atomivid.vercel.app';

export function allowedCommercialRequest(raw, method, phase, storageOrigin) {
  let url;
  try { url = new URL(raw); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  if (url.origin === storageOrigin) {
    return method === 'GET' && /^\/storage\/v1\/object\/(sign|authenticated)\//.test(url.pathname);
  }
  if (url.origin !== ORIGIN || url.pathname.startsWith('/api/')) return false;
  if (method === 'GET') return true;
  return phase === 'login' && method === 'POST' && url.pathname === '/login';
}

export function commercialVisibility(text) {
  return {
    currentPlanVisible: /Plan actual|Tu plan de producción/.test(text),
    subscriptionStatusVisible: /\bActiva\b|\bActivo\b|En prueba|Sin suscripción|Pago pendiente|Cancelada/.test(text),
    planOptionsVisible: /Starter/.test(text) && /Business/.test(text),
    paymentUnavailableVisible: /Pagos aún no habilitados/.test(text),
    creditUsageVisible: /(?:créditos?\s+(?:disponibles|restantes|usados)|(?:saldo|uso)\s+de\s+créditos|\d+\s*(?:de|\/)\s*\d+\s*(?:videos|reels|créditos))/i.test(text),
  };
}
