import { test } from "node:test";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { MissingEnvVarError } from "@/lib/env-errors";
import {
  SupabaseQueryError,
  CheckoutUrlMissingError,
  classifyBillingError,
  logBillingError,
} from "./checkout-error";

// No usa el prefijo real de Stripe (sk_test_/sk_live_ + ~24 caracteres
// base62): estas pruebas no verifican detección de prefijo (eso lo cubre
// config-check.test.ts) sino que ningún valor "secreto" incrustado en un
// mensaje de error crudo se filtre — y una cadena con forma real de clave
// dispara el escáner de secretos de GitHub incluso siendo un fixture falso.
const FAKE_SECRET = "super-secret-value-should-never-leak-9f8a7b";

test("classifyBillingError menciona el nombre exacto de la variable ausente", () => {
  const message = classifyBillingError(new MissingEnvVarError("STRIPE_PRICE_ID"));
  assert.ok(message.includes("STRIPE_PRICE_ID"));
});

test("classifyBillingError da un mensaje seguro para clave de Stripe inválida, sin exponer la clave", () => {
  const error = new Stripe.errors.StripeAuthenticationError({
    message: `Invalid API Key provided: ${FAKE_SECRET}`,
    type: "invalid_request_error",
    statusCode: 401,
  });
  const message = classifyBillingError(error);
  assert.ok(message.includes("StripeAuthenticationError"));
  assert.ok(!message.includes(FAKE_SECRET));
});

test("classifyBillingError distingue un Price ID inexistente/incompatible con la clave", () => {
  const error = new Stripe.errors.StripeInvalidRequestError({
    message: "No such price: 'price_fake'",
    code: "resource_missing",
    param: "line_items[0][price]",
    type: "invalid_request_error",
    statusCode: 404,
  });
  const message = classifyBillingError(error);
  assert.ok(message.toLowerCase().includes("precio"));
});

test("classifyBillingError distingue un problema de configuración de URL", () => {
  const error = new Stripe.errors.StripeInvalidRequestError({
    message: "Invalid success_url",
    code: "url_invalid",
    param: "success_url",
    type: "invalid_request_error",
    statusCode: 400,
  });
  const message = classifyBillingError(error);
  assert.ok(message.toLowerCase().includes("url"));
});

test("classifyBillingError da un mensaje seguro y genérico para otros errores de Stripe", () => {
  const error = new Stripe.errors.StripeAPIError({
    message: "Internal error",
    type: "api_error",
    statusCode: 500,
  });
  const message = classifyBillingError(error);
  assert.ok(message.includes("Stripe"));
});

test("classifyBillingError da un mensaje seguro para errores de Supabase", () => {
  const message = classifyBillingError(new SupabaseQueryError("PGRST301"));
  assert.ok(message.toLowerCase().includes("facturación") || message.toLowerCase().includes("cuenta"));
});

test("classifyBillingError da un mensaje seguro cuando Stripe no devuelve session.url", () => {
  const message = classifyBillingError(new CheckoutUrlMissingError());
  assert.ok(message.toLowerCase().includes("enlace"));
});

test("classifyBillingError tiene un mensaje de reserva para errores desconocidos", () => {
  const message = classifyBillingError(new Error("algo inesperado"));
  assert.ok(message.length > 0);
});

test("classifyBillingError nunca expone la clave secreta en ningún caso probado", () => {
  const cases: unknown[] = [
    new MissingEnvVarError("STRIPE_SECRET_KEY"),
    new Stripe.errors.StripeAuthenticationError({
      message: `Invalid API Key provided: ${FAKE_SECRET}`,
      type: "invalid_request_error",
      statusCode: 401,
    }),
    new Stripe.errors.StripeInvalidRequestError({
      message: `bad key ${FAKE_SECRET}`,
      code: "resource_missing",
      param: "line_items[0][price]",
      type: "invalid_request_error",
      statusCode: 404,
    }),
    new SupabaseQueryError("42501"),
    new CheckoutUrlMissingError(),
    new Error(`unexpected ${FAKE_SECRET}`),
  ];

  for (const err of cases) {
    assert.ok(!classifyBillingError(err).includes(FAKE_SECRET));
  }
});

test("logBillingError nunca imprime la clave secreta ni el mensaje crudo de Stripe", () => {
  const calls: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    calls.push(args);
  };

  try {
    logBillingError("createCheckoutSession", new MissingEnvVarError("STRIPE_SECRET_KEY"));
    logBillingError(
      "createCheckoutSession",
      new Stripe.errors.StripeAuthenticationError({
        message: `Invalid API Key provided: ${FAKE_SECRET}`,
        type: "invalid_request_error",
        statusCode: 401,
      }),
    );
    logBillingError("createCheckoutSession", new SupabaseQueryError("42501"));
    logBillingError("createCheckoutSession", new Error(`unexpected ${FAKE_SECRET}`));
  } finally {
    console.error = original;
  }

  const serialized = JSON.stringify(calls);
  assert.ok(!serialized.includes(FAKE_SECRET));
  assert.ok(calls.length === 4);
});
