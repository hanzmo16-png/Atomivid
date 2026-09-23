import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildFixtureDiagramSpec,
  buildFixtureMapSpec,
  buildFixtureTextCardSpec,
  projectMarker,
  validateDiagramSpec,
  validateMapSpec,
} from "./diagram-map";

test("projectMarker ubica un marcador en el centro del bounding box en (0.5, 0.5)", () => {
  const bounds = { minLat: 0, maxLat: 10, minLon: 0, maxLon: 10 };
  const { xNorm, yNorm } = projectMarker({ id: "x", label: "centro", latitude: 5, longitude: 5 }, bounds);
  assert.ok(Math.abs(xNorm - 0.5) < 1e-9);
  assert.ok(Math.abs(yNorm - 0.5) < 1e-9);
});

test("projectMarker: la latitud mayor queda arriba (yNorm menor)", () => {
  const bounds = { minLat: 0, maxLat: 10, minLon: 0, maxLon: 10 };
  const north = projectMarker({ id: "n", label: "norte", latitude: 9, longitude: 5 }, bounds);
  const south = projectMarker({ id: "s", label: "sur", latitude: 1, longitude: 5 }, bounds);
  assert.ok(north.yNorm < south.yNorm);
});

test("projectMarker recorta (clamp) marcadores fuera del bounding box en vez de devolver valores fuera de [0,1]", () => {
  const bounds = { minLat: 0, maxLat: 10, minLon: 0, maxLon: 10 };
  const { xNorm, yNorm } = projectMarker({ id: "far", label: "lejos", latitude: 999, longitude: -999 }, bounds);
  assert.ok(xNorm >= 0 && xNorm <= 1);
  assert.ok(yNorm >= 0 && yNorm <= 1);
});

test("projectMarker lanza con bounds mal formados (min >= max)", () => {
  assert.throws(() =>
    projectMarker({ id: "x", label: "x", latitude: 1, longitude: 1 }, { minLat: 5, maxLat: 5, minLon: 0, maxLon: 10 }),
  );
});

test("validateDiagramSpec lanza si un edge referencia un nodo inexistente", () => {
  assert.throws(() =>
    validateDiagramSpec({
      kind: "diagram",
      title: "t",
      nodes: [{ id: "a", label: "A", x: 0, y: 0 }],
      edges: [{ from: "a", to: "no-existe" }],
      isFixture: true,
    }),
  );
});

test("validateMapSpec lanza si no hay marcadores", () => {
  assert.throws(() =>
    validateMapSpec({
      kind: "map",
      title: "t",
      bounds: { minLat: 0, maxLat: 1, minLon: 0, maxLon: 1 },
      markers: [],
      isFixture: true,
    }),
  );
});

test("buildFixtureDiagramSpec/buildFixtureMapSpec/buildFixtureTextCardSpec están marcados explícitamente como fixture", () => {
  assert.equal(buildFixtureDiagramSpec("shot-1").isFixture, true);
  assert.equal(buildFixtureMapSpec("shot-1").isFixture, true);
  assert.equal(buildFixtureTextCardSpec("shot-1", "narración de prueba").isFixture, true);
  assert.match(buildFixtureDiagramSpec("shot-1").title, /fixture/i);
  assert.match(buildFixtureMapSpec("shot-1").title, /fixture/i);
});

test("buildFixtureDiagramSpec/buildFixtureMapSpec producen specs válidas por construcción", () => {
  assert.doesNotThrow(() => validateDiagramSpec(buildFixtureDiagramSpec("s")));
  assert.doesNotThrow(() => validateMapSpec(buildFixtureMapSpec("s")));
});
