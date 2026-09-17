import { test } from "node:test";
import assert from "node:assert/strict";
import { ipv6InPrefix, classifyPgError, isNetworkReachabilityError } from "./discover-pooler";

// La dirección real observada en ejecución (log sanitizado de la
// migración de Supabase) al resolver db.<ref>.supabase.co — usada aquí
// como caso de prueba real, no inventado.
const REAL_OBSERVED_ADDR = "2600:1f14:359d:9303:6e34:a0d7:789a:fdd";

test("ipv6InPrefix: reconoce la dirección real observada dentro de su prefijo real de AWS (us-west-2)", () => {
  assert.equal(ipv6InPrefix(REAL_OBSERVED_ADDR, "2600:1f14::/34"), true);
});

test("ipv6InPrefix: rechaza un prefijo vecino que NO contiene la dirección", () => {
  assert.equal(ipv6InPrefix(REAL_OBSERVED_ADDR, "2600:1f15::/34"), false);
});

test("ipv6InPrefix: exacto con /128 solo coincide con la misma dirección", () => {
  assert.equal(ipv6InPrefix(REAL_OBSERVED_ADDR, `${REAL_OBSERVED_ADDR}/128`), true);
  assert.equal(ipv6InPrefix("2600:1f14:359d:9303:6e34:a0d7:789a:fde", `${REAL_OBSERVED_ADDR}/128`), false);
});

test("ipv6InPrefix: /0 coincide con cualquier dirección (todo el espacio IPv6)", () => {
  assert.equal(ipv6InPrefix(REAL_OBSERVED_ADDR, "::/0"), true);
  assert.equal(ipv6InPrefix("::1", "::/0"), true);
});

test("ipv6InPrefix: expande correctamente '::' en distintas posiciones", () => {
  // "::1" (loopback) — compresión al inicio.
  assert.equal(ipv6InPrefix("::1", "::/126"), true);
  // "2001:db8::" — compresión al final.
  assert.equal(ipv6InPrefix("2001:db8::", "2001:db8::/32"), true);
});

test("classifyPgError: un código SQLSTATE de 5 caracteres se clasifica como 'rejected_by_server'", () => {
  assert.equal(classifyPgError({ code: "28P01" }), "rejected_by_server");
  assert.equal(classifyPgError({ code: "3D000" }), "rejected_by_server");
});

test("classifyPgError: un código de red de node (ENOTFOUND, etc.) se clasifica como 'unreachable'", () => {
  assert.equal(classifyPgError({ code: "ENOTFOUND" }), "unreachable");
  assert.equal(classifyPgError({}), "unreachable");
  assert.equal(classifyPgError(undefined), "unreachable");
});

test("isNetworkReachabilityError: reconoce los códigos de red que disparan el descubrimiento autónomo", () => {
  for (const code of ["ENETUNREACH", "ENOTFOUND", "EHOSTUNREACH", "ETIMEDOUT", "ECONNREFUSED"]) {
    assert.equal(isNetworkReachabilityError({ code }), true, code);
  }
});

test("isNetworkReachabilityError: NUNCA confunde un fallo de autenticación (SQLSTATE) con un problema de red", () => {
  assert.equal(isNetworkReachabilityError({ code: "28P01" }), false);
  assert.equal(isNetworkReachabilityError(undefined), false);
});
