import { test } from "node:test";
import assert from "node:assert/strict";
import { humanizeAuthError, safeRedirectTarget } from "./errors";

test("humanizeAuthError traduce credenciales inválidas", () => {
  assert.equal(
    humanizeAuthError("Invalid login credentials"),
    "Correo o contraseña incorrectos.",
  );
});

test("humanizeAuthError traduce correo no confirmado", () => {
  assert.match(humanizeAuthError("Email not confirmed"), /confirma tu correo/i);
});

test("humanizeAuthError traduce usuario ya registrado", () => {
  assert.match(humanizeAuthError("User already registered"), /ya existe una cuenta/i);
});

test("humanizeAuthError cae a un mensaje genérico para errores no reconocidos", () => {
  const result = humanizeAuthError("some_internal_provider_code_xyz");
  assert.ok(result.length > 0);
  assert.doesNotMatch(result, /some_internal_provider_code_xyz/);
});

test("humanizeAuthError maneja undefined/null sin lanzar", () => {
  assert.equal(humanizeAuthError(undefined), "Ocurrió un error inesperado. Intenta de nuevo.");
  assert.equal(humanizeAuthError(null), "Ocurrió un error inesperado. Intenta de nuevo.");
});

test("safeRedirectTarget acepta una ruta interna válida", () => {
  assert.equal(safeRedirectTarget("/dashboard/new"), "/dashboard/new");
});

test("safeRedirectTarget rechaza una URL externa (open redirect)", () => {
  assert.equal(safeRedirectTarget("https://evil.example/phish"), null);
});

test("safeRedirectTarget rechaza una URL protocol-relative (//host)", () => {
  assert.equal(safeRedirectTarget("//evil.example/phish"), null);
});

test("safeRedirectTarget rechaza volver a /login o /register (evita loop)", () => {
  assert.equal(safeRedirectTarget("/login"), null);
  assert.equal(safeRedirectTarget("/register?x=1"), null);
});

test("safeRedirectTarget rechaza valores que no son string o vacíos", () => {
  assert.equal(safeRedirectTarget(null), null);
  assert.equal(safeRedirectTarget(""), null);
});
