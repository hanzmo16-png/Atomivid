import { test } from "node:test";
import assert from "node:assert/strict";
import { InvalidEnvVarError, MissingEnvVarError } from "@/lib/env-errors";
import { LongFormRealModeNotConfirmedError, LongFormRealProviderMissingError } from "./long-form/mode";
import { isServiceConfigurationError, scrubInternalNames, SERVICE_CONFIGURATION_MESSAGE } from "./customer-error";

// Local run (chatgpt-08): the Long Form video page showed «Define LONG_FORM_REAL_RUN_CONFIRM=YES_SPEND_REAL_MONEY…».
test("server configuration errors are recognised and their customer text names nothing internal", () => {
  for (const e of [new MissingEnvVarError("ELEVENLABS_API_KEY"), new InvalidEnvVarError("GH_WORKER_REPO", "owner/repo"),
    new LongFormRealModeNotConfirmedError(), new LongFormRealProviderMissingError("voz", "ELEVENLABS_API_KEY")]) {
    assert.equal(isServiceConfigurationError(e), true, e.name);
  }
  assert.equal(isServiceConfigurationError(new Error("Pexels 500")), false);
  assert.doesNotMatch(SERVICE_CONFIGURATION_MESSAGE, /[A-Z]+_[A-Z]+/);
  assert.match(SERVICE_CONFIGURATION_MESSAGE, /no por tu guion/);
  assert.doesNotMatch(SERVICE_CONFIGURATION_MESSAGE, /gratis|sin costo|no se cobr/i, "never promises a free retry");
});

test("raw worker text loses environment-variable names but keeps the rest", () => {
  const raw = new LongFormRealModeNotConfirmedError().message;
  const clean = scrubInternalNames(raw);
  assert.doesNotMatch(clean, /LONG_FORM_REAL_RUN_CONFIRM|YES_SPEND_REAL_MONEY/);
  assert.equal(scrubInternalNames("Pexels devolvió 500 al buscar clips"), "Pexels devolvió 500 al buscar clips");
});

test("the render-start classifier gives the same configuration explanation for an inline worker", async () => {
  const { classifyRenderError } = await import("./render-error");
  const msg = classifyRenderError(new LongFormRealModeNotConfirmedError(), "abc12345");
  assert.ok(msg.startsWith(SERVICE_CONFIGURATION_MESSAGE));
  assert.doesNotMatch(msg, /LONG_FORM|YES_SPEND/);
});
