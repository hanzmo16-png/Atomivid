/** Bounded private diagnostics, without stacks, URLs, credentials, query strings or financial amounts. */
export function privateFailure(error, sensitiveValues = []) {
  let message = String(error?.message ?? 'Unknown browser failure');
  for (const value of sensitiveValues) if (typeof value === 'string' && value.length >= 4) message=message.split(value).join('[REDACTED]');
  message=message.replace(/^.*(?:authorization|cookie|set-cookie|password|service_role|api[_-]?key).*$/gim,'[SENSITIVE_LINE_REDACTED]')
    .replace(/https?:\/\/[^\s"'<>]+/gi,'[URL_REDACTED]')
    .replace(/\?[^\s"'<>)]*/g,'?[QUERY_REDACTED]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g,'[EMAIL_REDACTED]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'[TOKEN_REDACTED]')
    .replace(/\bUSD\s*[\d,.]+/gi,'[AMOUNT_REDACTED]')
    .slice(0,1200);
  return {name:['Error','TimeoutError','TypeError'].includes(error?.name)?error.name:'Error',message};
}
export function privatePathname(raw, origin) {
  try {const u=new URL(raw);return u.origin===origin && /^\/(dashboard|login)(\/|$)/.test(u.pathname)?u.pathname:'[UNAVAILABLE]';}catch{return '[UNAVAILABLE]';}
}
