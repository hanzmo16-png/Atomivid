import { test } from "node:test";
import assert from "node:assert/strict";
import { selectIfOwned, type OwnedRequestRow } from "./access";

const BASE_ROW: OwnedRequestRow = {
  id: "req-1",
  user_id: "user-a",
  topic: "Tema de prueba",
  style: "Motivacional",
  duration_seconds: 30,
  language: "es",
  status: "completed",
  video_path: "req-1/final.mp4",
  error_message: null,
  script_json: null,
  progress_stage: null,
  render_attempts: 0,
  render_started_at: null,
  created_at: new Date().toISOString(),
};

test("selectIfOwned devuelve la solicitud cuando el usuario es el dueño", () => {
  const result = selectIfOwned(BASE_ROW, "user-a");
  assert.ok(result);
  assert.equal(result?.id, "req-1");
  // user_id nunca se expone en el resumen que llega a la UI.
  assert.ok(!("user_id" in (result as object)));
});

test("selectIfOwned rechaza el acceso cruzado entre usuarios (mismo id, otro dueño)", () => {
  const result = selectIfOwned(BASE_ROW, "user-b");
  assert.equal(result, null);
});

test("selectIfOwned trata una fila inexistente igual que 'no encontrado'", () => {
  assert.equal(selectIfOwned(null, "user-a"), null);
  assert.equal(selectIfOwned(undefined, "user-a"), null);
});

test("selectIfOwned rechaza si no hay userId (sesión no resuelta)", () => {
  const result = selectIfOwned(BASE_ROW, "");
  assert.equal(result, null);
});
