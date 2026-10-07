import { test } from "node:test";
import assert from "node:assert/strict";
import type { FootageCandidate, FootageProvider } from "@/lib/providers/types";
import { proposalFromCommonsPage, type CommonsPage } from "@/lib/providers/footage/commons";
import { DocumentAssetRegistry } from "./asset-identity";
import { selectStockForShot } from "./stock-selection";
import { planShotsFromScript } from "./production-plan";
import { MAX_TEXT_FALLBACK_RATIO } from "./produce";
import { LongFormVisualQualityError } from "./visual-report";
import { normalizeDeclaredVisuals, type BeatVisual } from "./visual-intents";
import * as curationModule from "./asset-curation";
import {
  activeApprovals,
  canCurateAssets,
  contractSentence,
  decideLink,
  emptyCurationFile,
  isAuthorizedCurator,
  nextReview,
  pendingReviews,
  proposeAsset,
  revokeDecision,
} from "./asset-curation";
import { assetFingerprint, assetFromProposal, contractForVisual, contractKey, heroCoverage, VerifiedAssetRegistry, type CuratableAsset, type CurationFile } from "./verified-assets";
import {
  FIXTURE_CURATOR,
  FIXTURE_REQUEST_ID,
  GUCCI_TOPIC,
  MAURIZIO,
  MAURIZIO_KEY,
  WRONG_NEWSPAPER,
  curateFixture,
  fixturePolicy,
  gucciAdversarial,
  gucciBeats,
  gucciRequested,
  gucciVerifiedAssets,
  identify,
  planFor,
  poolProvider,
  produceOffline,
  rehydrateFixture,
  requestedFor,
  simulate,
} from "./cinematic-simulation";

/**
 * Curated Trust Boundary: un JSON, un proveedor, Commons, un modelo, el alt
 * text, el nombre de archivo o la similitud NO son confianza. Solo la
 * validación del servidor + la curaduría humana + el vínculo EXACTO recurso ↔
 * identidad/proposición producen un registro de confianza en memoria.
 * Todo offline: la red real está bloqueada.
 */

let networkCalls = 0;
globalThis.fetch = (async () => {
  networkCalls++;
  throw new Error("curaduría: red prohibida en las pruebas");
}) as typeof fetch;

const NOW = "2026-10-07T12:00:00Z";
const visual = (v: Record<string, unknown>) => normalizeDeclaredVisuals([{ motion: false, ...v } as never], { identity: true })[0];
const MAURIZIO_VISUAL = visual({ description: "Maurizio Gucci at his wedding", subject: "Maurizio Gucci", era: "1972", beatClass: "IDENTITY", identity: MAURIZIO });
const PATRIZIA_VISUAL = visual({ description: "Patrizia Reggiani", beatClass: "IDENTITY", identity: { name: "Patrizia Reggiani", kind: "person" } });
const DEBT_VISUAL = visual({ description: "financial newspaper headlines about corporate debt", quote: "the company was deep in debt", subject: "newspaper", era: "1990s", beatClass: "EVIDENCE", evidence: { sourceIds: ["web-5"] } });
const MURDER_VISUAL = visual({ description: "Italian newspaper front page reporting a shooting", quote: "Moments later four shots rang out in the stairwell", subject: "newspaper", era: "1995", beatClass: "EVIDENCE", evidence: { sourceIds: ["web-2"] } });
const TRIAL_VISUAL = visual({ description: "court ruling documents of the 1998 murder trial", quote: "In 1998 a court in Milan convicted his former wife", subject: "court documents", era: "1998", beatClass: "EVIDENCE", evidence: { sourceIds: ["web-6"] } });
const INHERIT_VISUAL = visual({ description: "company share register recording the inheritance", quote: "He had inherited half of the company from his father", subject: "share register", era: "1980s", beatClass: "EVIDENCE", evidence: { sourceIds: ["web-3"] } });
const ALL = [MAURIZIO_VISUAL, PATRIZIA_VISUAL, DEBT_VISUAL, MURDER_VISUAL, TRIAL_VISUAL, INHERIT_VISUAL];
const REQUESTED = requestedFor(ALL);
const keyOf = (v: BeatVisual) => contractKey(contractForVisual(v)!);

function commonsPage(over: { title?: string; width?: number; height?: number; license?: string; artist?: string; attribution?: string; description?: string }): CommonsPage {
  const meta: Record<string, { value: string }> = {};
  if (over.license !== undefined) meta.License = { value: over.license };
  meta.Artist = { value: over.artist ?? "<a href='x'>Foto Studio</a>" };
  if (over.attribution) meta.Attribution = { value: over.attribution };
  meta.ImageDescription = { value: over.description ?? "Maurizio Gucci and Patrizia Reggiani at their wedding" };
  meta.Categories = { value: "Maurizio Gucci|Weddings in Italy" };
  return {
    title: over.title ?? "File:Maurizio Gucci wedding 1972.jpg",
    imageinfo: [{ url: `https://upload.wikimedia.org/${encodeURIComponent(over.title ?? "wedding")}.jpg`, descriptionurl: "https://commons.wikimedia.org/wiki/File:Wedding.jpg", width: over.width ?? 2400, height: over.height ?? 1600, mime: "image/jpeg", extmetadata: meta }],
  };
}

/** Commons → filtro → recurso curable (o el motivo por el que nunca llega al curador). */
function fromCommons(page: CommonsPage): { asset: CuratableAsset } | { rejected: string } {
  const out = proposalFromCommonsPage(page);
  return "proposal" in out ? assetFromProposal(out.proposal) : out;
}
function commonsAsset(page: CommonsPage): CuratableAsset {
  const out = fromCommons(page);
  assert.ok("asset" in out, JSON.stringify(out));
  return out.asset;
}
const WEDDING = commonsAsset(commonsPage({ license: "cc-by-4.0" }));
const asset = (id: string) => gucciVerifiedAssets.find((a) => a.asset.id === id)!.asset;
const roundTrip = <T>(x: T): T => JSON.parse(JSON.stringify(x));

/** El curador: proponer → ver EL par → aprobar/rechazar ESE par. */
function propose(file: CurationFile, a: CuratableAsset, v: BeatVisual) {
  const out = proposeAsset(file, { asset: a, contractKey: keyOf(v), origin: a.source === "commons" ? "commons" : "manual", now: NOW }, REQUESTED);
  assert.ok("file" in out, JSON.stringify(out));
  return out.file;
}
function decide(file: CurationFile, verdict: "APPROVED" | "REJECTED", creditText?: string) {
  const review = nextReview(file, REQUESTED);
  assert.ok(review, "hay un par pendiente");
  return decideLink(file, { proposalId: review.proposal.id, verdict, curator: FIXTURE_CURATOR, now: NOW, expectedFingerprint: review.fingerprint, creditText }, REQUESTED);
}
function approved(file: CurationFile, creditText?: string): CurationFile {
  const out = decide(file, "APPROVED", creditText);
  assert.ok("file" in out, JSON.stringify(out));
  return out.file;
}
const reload = (file: unknown) => VerifiedAssetRegistry.rehydrate(roundTrip(file), fixturePolicy());

async function select(v: BeatVisual, registry: VerifiedAssetRegistry, base: FootageProvider = poolProvider([]).provider, doc = new DocumentAssetRegistry(), shotId = "s1") {
  return selectStockForShot(
    { shotId, visual: v, preferVideo: false, minDurationSec: 4 },
    { footageProvider: registry.providerFor(v, base), registry: doc, identify, verifyEntityLink: registry.verifyEntityLink, verifyEvidenceLink: registry.verifyEvidenceLink, verifyContent: registry.verifyContent },
  );
}

/** Boda ↔ Maurizio aprobado por el curador y persistido. */
function weddingApproved(): CurationFile {
  return approved(propose(emptyCurationFile(FIXTURE_REQUEST_ID), WEDDING, MAURIZIO_VISUAL));
}

// --------------------------------------------------------------------------
// 1–5: Commons propone; la aprobación de identidad no prueba nada más
// --------------------------------------------------------------------------

test("1: la boda de Commons es una PROPUESTA, no confianza (ni en el archivo ni ante el selector)", async () => {
  const file = propose(emptyCurationFile(FIXTURE_REQUEST_ID), WEDDING, MAURIZIO_VISUAL);
  assert.equal(reload(file).size, 0, "propuesta sin decisión → 0 registros");
  assert.equal((await select(MAURIZIO_VISUAL, reload(file))).status, "gap");
});

test("2: aprobar boda ↔ Maurizio y recargar (JSON plano) → de confianza para ESA identidad", async () => {
  const registry = reload(weddingApproved());
  assert.equal(registry.size, 1);
  const out = await select(MAURIZIO_VISUAL, registry);
  assert.equal(out.status, "selected");
  if (out.status === "selected") {
    assert.deepEqual(out.entityLink, { name: "Maurizio Gucci" });
    assert.equal(out.candidate.url, WEDDING.mediaUrl);
  }
});

test("3-4: el retrato aprobado para Maurizio NO prueba la deuda ni el asesinato (ni el juicio, la herencia, entrar, subir)", async () => {
  const registry = reload(weddingApproved());
  for (const v of [DEBT_VISUAL, MURDER_VISUAL, TRIAL_VISUAL, INHERIT_VISUAL]) {
    assert.equal(registry.covers(v), false, v.description);
    assert.equal((await select(v, registry)).status, "gap", v.description);
  }
  // "Maurizio entrando/subiendo": la acción no la prueba un retrato — la escena es IDENTITY de Maurizio (se representa a la persona),
  // nunca EVIDENCE de la acción; un retrato aprobado no aparece como prueba de ninguna proposición.
  assert.ok(registry.recordsFor(MAURIZIO_VISUAL).every((r) => r.entityLink && !r.evidenceLink));
});

test("5: el retrato aprobado para Maurizio NO sirve para otra persona", async () => {
  const registry = reload(weddingApproved());
  assert.equal(registry.covers(PATRIZIA_VISUAL), false);
  assert.equal((await select(PATRIZIA_VISUAL, registry)).status, "gap");
  // Ni ofreciendo el objeto emitido para Maurizio a la escena de Patrizia.
  const issued = await registry.providerFor(MAURIZIO_VISUAL, poolProvider([]).provider).searchImageCandidates!("x");
  const passthrough: FootageProvider = { ...poolProvider([]).provider, searchImageCandidates: async () => issued };
  const out = await selectStockForShot({ shotId: "p", visual: PATRIZIA_VISUAL, preferVideo: false, minDurationSec: 4 }, { footageProvider: passthrough, registry: new DocumentAssetRegistry(), identify, verifyEntityLink: registry.verifyEntityLink });
  assert.equal(out.status, "gap");
});

// --------------------------------------------------------------------------
// 6–10: lo que ve el curador; lo que nunca llega a aprobación
// --------------------------------------------------------------------------

test("6: unas escaleras de licencia libre llegan al curador con el contrato EXACTO a la vista; no se autoconfían; el curador rechaza", async () => {
  const stairs = commonsAsset(commonsPage({ title: "File:Stairs Via Palestro.jpg", license: "pd", description: "Staircase of an office building in Milan" }));
  const file = propose(emptyCurationFile(FIXTURE_REQUEST_ID), stairs, MAURIZIO_VISUAL);
  const review = nextReview(file, REQUESTED)!;
  assert.equal(review.sentence, "This asset is being approved to represent: Maurizio Gucci");
  assert.equal(review.asset.description, "Staircase of an office building in Milan", "la imagen y el contrato aparecen juntos: el desajuste es visible");
  assert.equal(review.asset.rights.kind, "PD");
  assert.equal(reload(file).size, 0, "no se autoconfía");
  const rejected = decide(file, "REJECTED");
  assert.ok("file" in rejected);
  assert.equal(reload(rejected.file).size, 0);
  assert.equal(nextReview(rejected.file, REQUESTED), null, "el par decidido no vuelve a la cola");
  // El contrato de prueba se muestra con su proposición exacta.
  assert.equal(contractSentence(contractForVisual(DEBT_VISUAL)!), "This asset is being approved to support: «the company was deep in debt» (sources: web-5)");
});

test("7-9: NC, BY-SA, 442 px (y licencia desconocida) nunca llegan a aprobación — ni por Commons, ni a mano, ni forzando el archivo", () => {
  for (const [label, page] of [
    ["NC", commonsPage({ license: "cc-by-nc-4.0" })],
    ["BY-SA", commonsPage({ license: "cc-by-sa-4.0" })],
    ["442 px", commonsPage({ license: "cc-by-4.0", width: 442, height: 590 })],
    ["desconocida", commonsPage({ license: "weird-license" })],
  ] as const) {
    assert.ok("rejected" in fromCommons(page), `${label}: filtrado antes del curador`);
  }
  const forced: CuratableAsset[] = [
    { ...WEDDING, id: "nc", rights: { kind: "CC_BY" }, licenseEvidence: { code: "cc-by-nc-4.0" } },
    { ...WEDDING, id: "sa", rights: { kind: "CC_BY_SA" as never }, licenseEvidence: { code: "cc-by-sa-4.0" } },
    { ...WEDDING, id: "small", width: 442, height: 590 },
    { ...asset("ver-portrait"), id: "manual-small", width: 442, height: 590 },
  ];
  for (const a of forced) {
    const out = proposeAsset(emptyCurationFile(FIXTURE_REQUEST_ID), { asset: a, contractKey: MAURIZIO_KEY, origin: "manual", now: NOW }, REQUESTED);
    assert.ok("error" in out, `${a.id}: no entra al archivo`);
    // Escrito a mano en el archivo, con una "aprobación": el servidor lo revalida y lo niega.
    const file: CurationFile = {
      ...emptyCurationFile(FIXTURE_REQUEST_ID),
      assets: [a],
      proposals: [{ id: "p-1", assetId: a.id, contract: { kind: "IDENTITY", name: "Maurizio Gucci" }, origin: "manual", proposedAt: NOW }],
      decisions: [{ id: "d-1", proposalId: "p-1", assetId: a.id, assetFingerprint: assetFingerprint(a), contractKey: MAURIZIO_KEY, contract: { kind: "IDENTITY", name: "Maurizio Gucci" }, requestId: FIXTURE_REQUEST_ID, verdict: "APPROVED", status: "ACTIVE", decidedBy: FIXTURE_CURATOR, decidedAt: NOW, version: 1, approved: { creditText: "x" } }],
    };
    assert.equal(pendingReviews(file, REQUESTED).length, 0, `${a.id}: nunca aparece al curador`);
    assert.equal(reload(file).size, 0, `${a.id}: nunca se rehidrata`);
  }
});

test("10: CC BY sin atribución no se puede aprobar; con la atribución que fija el curador, sí (y llega al registro)", () => {
  const anonymous = commonsAsset(commonsPage({ title: "File:anon.jpg", license: "cc-by-4.0", artist: "" }));
  assert.equal(anonymous.creditText, undefined);
  const file = propose(emptyCurationFile(FIXTURE_REQUEST_ID), anonymous, MAURIZIO_VISUAL);
  assert.ok(nextReview(file, REQUESTED)!.approvalBlockers.some((r) => /CC BY exige/.test(r)), "el curador ve por qué no puede aprobar");
  const denied = decide(file, "APPROVED");
  assert.ok("error" in denied && /CC BY exige/.test(denied.error));
  const ok = approved(file, "Foto Studio · CC BY 4.0 · Wikimedia Commons");
  const [record] = reload(ok).recordsFor(MAURIZIO_VISUAL);
  assert.equal(record.creditText, "Foto Studio · CC BY 4.0 · Wikimedia Commons");
});

// --------------------------------------------------------------------------
// 11–16: nada persistido ni externo concede confianza
// --------------------------------------------------------------------------

test("11: la autodeclaración de un proveedor falla (entityReference, id 'verified:', misma URL, trusted:true)", async () => {
  const registry = reload(weddingApproved());
  const spoof = { url: WEDDING.mediaUrl, sourceId: `verified:${WEDDING.id}`, description: "Maurizio Gucci wedding", entityReference: { name: "Maurizio Gucci" }, trusted: true, mediaType: "image", mimeType: "image/jpeg", extension: "jpg" } as FootageCandidate;
  assert.equal(registry.verifyEntityLink(spoof), null);
  assert.equal(registry.verifyEvidenceLink(spoof), null);
  assert.equal(registry.recordOf(spoof), null);
  const provider: FootageProvider = { ...poolProvider([]).provider, searchImageCandidates: async () => [spoof] };
  assert.equal((await select(MAURIZIO_VISUAL, VerifiedAssetRegistry.empty(), provider)).status, "gap");
});

test("12: un JSON plano con trusted:true (o curation/verified) no concede nada", () => {
  const forged = {
    ...emptyCurationFile(FIXTURE_REQUEST_ID),
    trusted: true,
    assets: [{ ...asset("ver-portrait"), trusted: true, verified: true, entityLink: { name: "Maurizio Gucci" }, curation: { curatedBy: FIXTURE_CURATOR, basis: "yo" } }],
    records: [{ ...asset("ver-portrait"), trusted: true, entityLink: { name: "Maurizio Gucci" } }],
  };
  const registry = reload(forged);
  assert.equal(registry.size, 0);
  assert.equal(registry.covers(MAURIZIO_VISUAL), false);
  // Ni un "registro verificado" suelto, ni una lista de ellos.
  assert.equal(VerifiedAssetRegistry.rehydrate([{ ...asset("ver-portrait"), trusted: true }], fixturePolicy()).size, 0);
  // Una decisión firmada por alguien que el servidor no autoriza hoy tampoco.
  const file = weddingApproved();
  const other = roundTrip(file);
  other.decisions[0].decidedBy = "intruder@example.com";
  assert.equal(reload(other).size, 0);
  assert.equal(VerifiedAssetRegistry.rehydrate(roundTrip(file), { requestId: FIXTURE_REQUEST_ID, isAuthorizedCurator: () => false }).size, 0, "la autoridad es del servidor, no del archivo");
});

test("13: un registro de confianza serializado vuelve a ser un dato: se revalida entero y sin decisión vigente no vale", () => {
  const file = weddingApproved();
  const registry = reload(file);
  const [record] = registry.recordsFor(MAURIZIO_VISUAL);
  assert.ok(Object.isFrozen(record) && Object.isFrozen(record.entityLink), "en memoria: congelado");
  assert.throws(() => ((record as { entityLink: { name: string } }).entityLink.name = "Patrizia Reggiani"));
  const serialized = roundTrip(record);
  // Como recurso, con trusted:true, sin decisión: nada.
  assert.equal(reload({ ...emptyCurationFile(FIXTURE_REQUEST_ID), assets: [{ ...serialized, trusted: true }] }).size, 0);
  // Con la decisión REVOCADA, el registro serializado no la resucita.
  const revoked = revokeDecision(file, { decisionId: file.decisions[0].id, curator: FIXTURE_CURATOR, now: NOW });
  assert.ok("file" in revoked);
  assert.equal(reload({ ...revoked.file, assets: [...revoked.file.assets, { ...serialized, trusted: true }] }).size, 0);
  // Otra solicitud: el mismo archivo no vale.
  assert.equal(VerifiedAssetRegistry.rehydrate(roundTrip(file), fixturePolicy("otra-solicitud")).size, 0);
});

test("14: una licencia manipulada tras la aprobación se niega (huella + revalidación)", () => {
  const file = weddingApproved();
  for (const tamper of [
    (f: CurationFile) => ((f.assets[0].licenseEvidence = { code: "cc-by-sa-4.0" }), f),
    (f: CurationFile) => ((f.assets[0].rights = { kind: "CC0" }), (f.assets[0].licenseEvidence = { code: "cc0" }), f),
    (f: CurationFile) => ((f.assets[0].width = 442), (f.assets[0].height = 590), f),
    (f: CurationFile) => ((f.assets[0].creditText = undefined), f),
  ]) {
    const registry = reload(tamper(roundTrip(file)));
    assert.equal(registry.size, 0);
    assert.ok(registry.rejected.length > 0);
  }
});

test("15: un vínculo manipulado se niega; solo vale el par EXACTO aprobado", () => {
  const file = weddingApproved();
  // La decisión ahora dice "Patrizia" o "prueba de la deuda": no coincide con el contrato que pidió el recurso.
  const toPatrizia = roundTrip(file);
  toPatrizia.decisions[0].contract = { kind: "IDENTITY", name: "Patrizia Reggiani" };
  toPatrizia.decisions[0].contractKey = keyOf(PATRIZIA_VISUAL);
  assert.equal(reload(toPatrizia).size, 0);
  const toDebt = roundTrip(file);
  toDebt.decisions[0].contract = contractForVisual(DEBT_VISUAL)!;
  toDebt.decisions[0].contractKey = keyOf(DEBT_VISUAL);
  assert.equal(reload(toDebt).covers(DEBT_VISUAL), false);
  // Un contrato que el plan no pide no se rehidrata aunque el archivo sea coherente.
  assert.equal(VerifiedAssetRegistry.rehydrate(roundTrip(file), { ...fixturePolicy(), requestedContracts: new Set([keyOf(DEBT_VISUAL)]) }).size, 0);
  // Prueba X ≠ prueba Y: la portada del asesinato aprobada para web-2 no prueba la deuda (web-5).
  const murder = reload(approved(propose(emptyCurationFile(FIXTURE_REQUEST_ID), asset("ev-murder-1"), MURDER_VISUAL)));
  assert.equal(murder.covers(MURDER_VISUAL), true);
  assert.equal(murder.covers(DEBT_VISUAL), false);
  assert.equal(murder.covers(TRIAL_VISUAL), false);
  // Y el par exacto, aprobado por el curador, sí vale.
  const patriziaApproved = reload(approved(propose(emptyCurationFile(FIXTURE_REQUEST_ID), WEDDING, PATRIZIA_VISUAL)));
  assert.equal(patriziaApproved.covers(PATRIZIA_VISUAL), true);
  assert.equal(patriziaApproved.covers(MAURIZIO_VISUAL), false, "aprobado para Patrizia ≠ aprobado para Maurizio");
});

test("16: una aprobación revocada no se rehidrata (ACTIVE → REVOKED) y el par vuelve a la cola del curador", () => {
  const file = weddingApproved();
  assert.equal(activeApprovals(file).length, 1);
  const out = revokeDecision(file, { decisionId: file.decisions[0].id, curator: FIXTURE_CURATOR, now: NOW });
  assert.ok("file" in out);
  assert.equal(out.file.decisions[0].status, "REVOKED");
  assert.equal(reload(out.file).size, 0);
  assert.equal(activeApprovals(out.file).length, 0);
  assert.ok(nextReview(out.file, REQUESTED), "puede volver a decidirse");
  // Quitar al curador de la configuración del servidor también retira sus aprobaciones.
  assert.equal(isAuthorizedCurator(FIXTURE_CURATOR, { ASSET_CURATOR_EMAILS: "otra@atomivid.test" }), false);
  assert.equal(isAuthorizedCurator(FIXTURE_CURATOR, {}), false, "sin configurar: nadie (falla cerrada)");
  assert.equal(canCurateAssets({ email: FIXTURE_CURATOR }, { ASSET_CURATOR_EMAILS: FIXTURE_CURATOR }), false, "correo sin confirmar");
  assert.equal(canCurateAssets({ email: FIXTURE_CURATOR, email_confirmed_at: NOW }, { ASSET_CURATOR_EMAILS: FIXTURE_CURATOR }), true);
});

test("mutación: si el recurso cambia (URL, contenido), la confianza no se conserva", async () => {
  const withSha = { ...asset("ver-portrait"), contentSha256: (await identify(Buffer.from(`bytes:${asset("ver-portrait").mediaUrl}`))).sha256 };
  const file = approved(propose(emptyCurationFile(FIXTURE_REQUEST_ID), withSha, MAURIZIO_VISUAL));
  assert.equal((await select(MAURIZIO_VISUAL, reload(file))).status, "selected", "contenido idéntico al aprobado");
  // La fuente sirve OTRO contenido en la misma URL: se rechaza tras la descarga.
  const swapped: FootageProvider = { ...poolProvider([]).provider, downloadFootage: async () => Buffer.from("otro contenido") };
  const out = await select(MAURIZIO_VISUAL, reload(file), swapped);
  assert.equal(out.status, "gap");
  assert.match(out.rejected.map((r) => r.reason).join(" "), /no coincide con el aprobado/);
  // La URL del medio cambia en el archivo: huella distinta.
  const moved = roundTrip(file);
  moved.assets[0].mediaUrl = "https://archive.example/media/otra.jpg";
  assert.equal(reload(moved).size, 0);
  // El curador decide sobre lo que vio: si cambió entretanto, su decisión no se registra.
  const pending = propose(emptyCurationFile(FIXTURE_REQUEST_ID), asset("ver-press"), MAURIZIO_VISUAL);
  const review = nextReview(pending, REQUESTED)!;
  const changed = roundTrip(pending);
  changed.assets[0].mediaUrl = "https://archive.example/media/cambiada.jpg";
  const decided = decideLink(changed, { proposalId: review.proposal.id, verdict: "APPROVED", curator: FIXTURE_CURATOR, now: NOW, expectedFingerprint: review.fingerprint }, REQUESTED);
  assert.ok("error" in decided && /cambió/.test(decided.error));
  // Mismo id con otro contenido: no se acepta como la misma propuesta.
  const dup = proposeAsset(pending, { asset: { ...asset("ver-press"), width: 3000 }, contractKey: MAURIZIO_KEY, origin: "manual", now: NOW }, REQUESTED);
  assert.ok("error" in dup);
});

test("sin aprobación en bloque: un par por decisión; el contrato lo trae la escena (no hay lista libre de afirmaciones)", () => {
  assert.deepEqual(Object.keys(curationModule).filter((k) => /all|bulk|batch|many/i.test(k)), []);
  let file = propose(emptyCurationFile(FIXTURE_REQUEST_ID), asset("ver-portrait"), MAURIZIO_VISUAL);
  file = propose(file, asset("ver-press"), MAURIZIO_VISUAL);
  file = approved(file);
  assert.equal(activeApprovals(file).length, 1, "una decisión aprueba UN par");
  assert.equal(pendingReviews(file, REQUESTED).length, 1);
  // Un contrato que la escena no pidió no se puede proponer.
  const free = proposeAsset(file, { asset: asset("ev-debt-1"), contractKey: "EVIDENCE:web-99", origin: "manual", now: NOW }, REQUESTED);
  assert.ok("error" in free && /no pide/.test(free.error));
});

test("vía manual/licenciada: MISMO curador, mismo contrato de confianza, sin atajo en el selector", async () => {
  const manual = asset("ev-debt-1");
  const file = propose(emptyCurationFile(FIXTURE_REQUEST_ID), manual, DEBT_VISUAL);
  const review = nextReview(file, REQUESTED)!;
  assert.equal(review.asset.source, "licensed_archive");
  assert.ok(review.asset.rights.kind === "LICENSED" && review.asset.rights.rightsReference);
  assert.ok(review.asset.creator && review.asset.creditText && review.asset.width && review.asset.height);
  assert.equal(reload(file).size, 0, "licenciado ≠ confiable sin decisión");
  const registry = reload(approved(file));
  const out = await select(DEBT_VISUAL, registry);
  assert.equal(out.status, "selected");
  if (out.status === "selected") assert.deepEqual(out.evidenceLink, { sourceIds: ["web-5"] });
});

// --------------------------------------------------------------------------
// 17–20: reutilización verificada, periódico equivocado, bloqueo sin render
// --------------------------------------------------------------------------

test("17: la reutilización verificada de identidad funciona (con su justificación)", async () => {
  const registry = reload(approved(propose(emptyCurationFile(FIXTURE_REQUEST_ID), asset("ver-portrait"), MAURIZIO_VISUAL)));
  const doc = new DocumentAssetRegistry();
  const first = await select(MAURIZIO_VISUAL, registry, undefined, doc, "s1");
  assert.equal(first.status, "selected");
  if (first.status === "selected") doc.register("s1", first.identity);
  const second = await select(MAURIZIO_VISUAL, registry, undefined, doc, "s2");
  assert.equal(second.status, "selected");
  if (second.status === "selected") assert.deepEqual(second.reuse, { of: "s1", justification: "verified_identity_reuse" });
});

test("18: la reutilización verificada de prueba funciona (misma proposición exacta)", async () => {
  const registry = reload(approved(propose(emptyCurationFile(FIXTURE_REQUEST_ID), asset("ev-trial-1"), TRIAL_VISUAL)));
  const doc = new DocumentAssetRegistry();
  const first = await select(TRIAL_VISUAL, registry, undefined, doc, "e1");
  assert.equal(first.status, "selected");
  if (first.status === "selected") doc.register("e1", first.identity);
  const second = await select({ ...TRIAL_VISUAL, description: "stack of Italian newspapers about a famous trial" }, registry, undefined, doc, "e2");
  assert.equal(second.status, "selected");
  if (second.status === "selected") assert.deepEqual(second.reuse, { of: "e1", justification: "verified_evidence_reuse" });
});

test("19: el periódico equivocado (0.94) se rechaza; la prueba aprobada de la deuda ocupa la escena", async () => {
  const registry = reload(approved(propose(emptyCurationFile(FIXTURE_REQUEST_ID), asset("ev-debt-1"), DEBT_VISUAL)));
  const out = await select(DEBT_VISUAL, registry, poolProvider([WRONG_NEWSPAPER]).provider);
  assert.equal(out.status, "selected");
  if (out.status === "selected") {
    assert.equal(out.candidate.url, asset("ev-debt-1").mediaUrl);
    assert.match(out.rejected.find((r) => r.sourceId === WRONG_NEWSPAPER.id)?.reason ?? "", /^FALSE_FRIEND/);
  }
});

test("20: un bloqueante de QA deja renderMedia sin llamar — produce() rehidrata el archivo persistido y se detiene antes de gastar", async () => {
  const prev = process.env.ASSET_CURATOR_EMAILS;
  process.env.ASSET_CURATOR_EMAILS = FIXTURE_CURATOR;
  try {
    // Escenario C persistido: un retrato aprobado, ninguna prueba.
    const c = curateFixture([{ asset: WEDDING, key: MAURIZIO_KEY }], gucciRequested());
    const run = await produceOffline(gucciBeats, planFor(gucciBeats), { curationFile: roundTrip(c) });
    assert.ok(run.error instanceof LongFormVisualQualityError, String(run.error));
    assert.match((run.error as Error).message, /HERO_EVIDENCE_COVERAGE_MISSING/);
    assert.deepEqual(run.events, [], "0 voz, 0 stock, 0 imagen, 0 música, 0 render");
    // Un archivo con trusted:true y sin decisiones: igual que sin archivo.
    const forged = await produceOffline(gucciBeats, planFor(gucciBeats), { curationFile: { ...emptyCurationFile(FIXTURE_REQUEST_ID), trusted: true, assets: gucciVerifiedAssets.map((a) => ({ ...a.asset, trusted: true })) } });
    assert.match(String(forged.error), /HERO_COVERAGE/);
    assert.deepEqual(forged.events, []);
  } finally {
    if (prev === undefined) delete process.env.ASSET_CURATOR_EMAILS;
    else process.env.ASSET_CURATOR_EMAILS = prev;
  }
});

// --------------------------------------------------------------------------
// HERO preflight — escenarios Gucci A/B/C/D (sin cambiar los recursos del fixture)
// --------------------------------------------------------------------------

function heroOf(label: string, registry?: VerifiedAssetRegistry) {
  const { shots } = planShotsFromScript(gucciBeats, GUCCI_TOPIC, "cinematic");
  const c = heroCoverage(shots, registry, MAX_TEXT_FALLBACK_RATIO);
  console.log(
    `HERO ${label}`,
    JSON.stringify({
      heroDuration: c.heroDuration,
      heroIdentitySeconds: c.heroIdentitySeconds,
      heroEvidenceSeconds: c.heroEvidenceSeconds,
      heroContextSeconds: c.heroContextSeconds,
      heroTruthfulAbstentionSeconds: c.heroTruthfulAbstentionSeconds,
      heroUnresolvedSeconds: c.heroUnresolvedSeconds,
      heroTextCardSeconds: c.heroTextCardSeconds,
      heroTextCardRatio: c.heroTextCardRatio,
      heroTextCardCount: c.heroTextCardCount,
      heroMissingRequiredIdentities: c.heroMissingRequiredIdentities,
      heroMissingRequiredEvidence: c.heroMissingRequiredEvidence,
      blockers: c.blockers,
    }),
  );
  return c;
}

const GUCCI_HERO_EVIDENCE = ["EVIDENCE:web-2", "EVIDENCE:web-3", "EVIDENCE:web-4", "EVIDENCE:web-5", "EVIDENCE:web-6"];

test("HERO A: sin registro → BLOQUEO PRE-GASTO (ninguna identidad ni prueba de HERO cubierta)", async () => {
  const a = heroOf("A");
  assert.ok(a.blockers.some((b) => b.startsWith("HERO_EVIDENCE_COVERAGE_MISSING")));
  assert.ok(a.blockers.some((b) => b.startsWith("HERO_IDENTITY_COVERAGE_MISSING")));
  assert.deepEqual(a.heroMissingRequiredIdentities, ["Maurizio Gucci"]);
  assert.deepEqual(a.heroMissingRequiredEvidence.map((e) => e.split(" — ")[0]).sort(), GUCCI_HERO_EVIDENCE);
  const run = await produceOffline(gucciBeats, planFor(gucciBeats));
  assert.match(String(run.error), /HERO_EVIDENCE_COVERAGE_MISSING/);
  assert.deepEqual(run.events, []);
});

test("HERO C: un retrato, cero pruebas → BLOQUEO PRE-GASTO (HERO_EVIDENCE_COVERAGE_MISSING); el retrato no es cobertura de prueba", async () => {
  const registry = rehydrateFixture(curateFixture([{ asset: WEDDING, key: MAURIZIO_KEY }], gucciRequested()));
  const c = heroOf("C", registry);
  assert.deepEqual(c.heroMissingRequiredIdentities, []);
  assert.ok(c.heroIdentitySeconds > 0);
  assert.equal(c.heroEvidenceSeconds, 0);
  assert.ok(c.blockers.some((b) => b.startsWith("HERO_EVIDENCE_COVERAGE_MISSING")), JSON.stringify(c.blockers));
  assert.equal(c.heroMissingRequiredEvidence.length, GUCCI_HERO_EVIDENCE.length);
  assert.ok(c.heroTextCardCount >= 10 && c.heroTextCardRatio > 0.25, `${c.heroTextCardCount} tarjetas, ${c.heroTextCardRatio}`);
  const run = await produceOffline(gucciBeats, planFor(gucciBeats), { verifiedAssets: registry });
  assert.match(String(run.error), /HERO_EVIDENCE_COVERAGE_MISSING/);
  assert.deepEqual(run.events, [], "0 llamadas");
  const sim = await simulate(gucciBeats, GUCCI_TOPIC, gucciAdversarial, "cinematic", { registry });
  assert.ok(sim.gateError instanceof LongFormVisualQualityError);
});

test("HERO B: identidad + pruebas curadas de verdad → PUEDE PASAR; la proposición sin material se informa con exactitud", async () => {
  const registry = rehydrateFixture(curateFixture(gucciVerifiedAssets, gucciRequested()));
  const b = heroOf("B", registry);
  assert.deepEqual(b.blockers, []);
  assert.deepEqual(b.heroMissingRequiredIdentities, []);
  assert.deepEqual(b.heroMissingRequiredEvidence, ["EVIDENCE:web-3 — «He had inherited half of the company from his father»"]);
  const sim = await simulate(gucciBeats, GUCCI_TOPIC, gucciAdversarial, "cinematic", { registry });
  assert.equal(sim.gateError, null, String(sim.gateError));
});

test("HERO D: identidad cubierta y UNA prueba más sin material → se informa la proposición exacta y no bloquea por sí sola", async () => {
  const registry = rehydrateFixture(curateFixture(gucciVerifiedAssets.filter((a) => a.key !== "EVIDENCE:web-4"), gucciRequested()));
  const d = heroOf("D", registry);
  assert.deepEqual(d.heroMissingRequiredIdentities, []);
  assert.deepEqual(d.heroMissingRequiredEvidence.map((e) => e.split(" — ")[0]).sort(), ["EVIDENCE:web-3", "EVIDENCE:web-4"]);
  assert.ok(d.heroMissingRequiredEvidence.includes("EVIDENCE:web-4 — «Licences put the name on hundreds of products»"));
  assert.ok(!d.blockers.some((b) => b.startsWith("HERO_EVIDENCE_COVERAGE_MISSING")), "faltar UNA prueba entre varias no es el bloqueo de cobertura total");
  const sim = await simulate(gucciBeats, GUCCI_TOPIC, gucciAdversarial, "cinematic", { registry });
  console.log("HERO D gate", sim.gateError ? String(sim.gateError).slice(0, 200) : "deliverable");
  assert.equal(networkCalls, 0);
});
