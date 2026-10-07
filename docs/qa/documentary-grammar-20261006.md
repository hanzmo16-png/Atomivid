# Documentary JSON transport

## Failure and fix

An expanded documentary contract can exceed Anthropic's compiled-grammar budget
and return HTTP 400 `invalid_request_error`: "The compiled grammar is too large".
Mocked writer/critic responses do not prove that the provider can compile a schema.

The writer and critic now request ordinary JSON text, with the complete JSON
Schema in the system prompt. Neither sends output_config.format or strict tools.
All local Zod constraints and existing evidence, duration, creative and critic
acceptance gates remain in force. Raw responses and usage are committed before
parsing and validation. Invalid documents are retained, never blindly regenerated.
No automatic parse repair or retry was added.

Only the explicit SDK BadRequestError with this compiler-rejection prefix is
classified as rejected_final. Generic 400, 429, 500 and timeouts stay uncertain.
The form reports a Spanish message and diagnostic ID, logs details server-side,
and preserves submitted fields. Existing uncertain operations require separate
evidence-based reconciliation; this patch does not migrate or clear them.

Research parameters, editorial/research versions, history and owner scope remain
unchanged. The same form with the same history reuses committed research; changing
fields/history may define a new request. No financial limits, quotas or provider
configuration changed. Operational reconciliation evidence remains private.

## Verification and limits

- TypeScript passes; 58 editorial and 74 spending tests pass.
- Both real SDK request shapes are tested through an intercepted HTTP transport:
  no compiled grammar, complete creative contract and mandatory critic.
- Truncation, refusal, malformed JSON, missing creative angles/visuals and invalid
  critic structure are rejected. Raw SDK errors are hidden from the form.
- Tests use synthetic model responses, not live API calls. They do not demonstrate
  live writing quality or a completed video. No media generation was launched.

Reference: https://platform.claude.com/docs/en/build-with-claude/structured-outputs
