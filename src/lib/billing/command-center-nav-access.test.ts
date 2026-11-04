/**
 * T-20261030-1514 — Command Center and Dry Run Long Form are owner/admin gates.
 * A Stripe subscription (active, canceled, expired, or absent) never opens them.
 * Lives under src/lib/billing so `npm run test:saas` runs it (`src/lib/billing/*.test.ts`)
 * without editing package.json.
 * USD 0: in-memory sources and local preflight only. No network, no Stripe, no Supabase.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCommandCenterAdmin, requireCommandCenterAdmin, CommandCenterAccessError, type AuthUser } from "@/lib/command-center/access";
import { CommandCenterService } from "@/lib/command-center/service";
import { memorySource } from "@/lib/command-center/sources";
import { isInternalProductionOwner } from "@/lib/billing/internal-production";
import { isSubscriptionActive, STATUS_LABEL } from "@/lib/billing/subscription";
import { evaluateVisualTestV2Request } from "@/lib/video/long-form/visual-test-v2-runtime";
import { evaluateVisualTestV2RealRequest } from "@/lib/video/long-form/visual-test-v2-spend-auth";

const NOW = "2026-10-30T12:00:00.000Z";
const INTERNAL_ID = "12345678-1234-4234-8234-123456789abc";

/** Closed server config: empty allowlists deny everyone, including a confirmed address. */
const CLOSED = {
  AVATAR_PREPARATION_OWNER_EMAIL: "",
  COMMAND_CENTER_ADMIN_EMAILS: "",
  INTERNAL_PRODUCTION_OWNER_USER_ID: "",
};

const OWNER_ENV = { ...CLOSED, AVATAR_PREPARATION_OWNER_EMAIL: " owner@atomivid.test " };
const ADMIN_ENV = { ...CLOSED, COMMAND_CENTER_ADMIN_EMAILS: " ops@atomivid.test , ," };
const INTERNAL_ENV = { ...CLOSED, INTERNAL_PRODUCTION_OWNER_USER_ID: INTERNAL_ID.toUpperCase() };

type Persona = AuthUser & { retailSubscription: string };

const ordinary = (retailSubscription: string): Persona => ({
  id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  email: "client@example.test",
  email_confirmed_at: NOW,
  retailSubscription,
});

const owner = (retailSubscription: string): Persona => ({
  id: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
  email: "Owner@atomivid.test",
  email_confirmed_at: NOW,
  retailSubscription,
});

const admin = (retailSubscription: string): Persona => ({
  id: "cccccccc-dddd-4eee-8fff-000000000001",
  email: "OPS@atomivid.test",
  email_confirmed_at: NOW,
  retailSubscription,
});

const internalOwner = (retailSubscription: string): Persona => ({
  id: INTERNAL_ID,
  email: "internal@atomivid.test",
  email_confirmed_at: NOW,
  retailSubscription,
});

/** Same decision the dashboard header uses: both internal links follow isCommandCenterAdmin. */
function internalNav(user: AuthUser, env: Record<string, string | undefined>) {
  const allowed = isCommandCenterAdmin(user, env);
  return { commandCenter: allowed, dryRun: allowed };
}

function assertDenied(user: AuthUser, env: Record<string, string | undefined>, label: string) {
  const nav = internalNav(user, env);
  assert.equal(nav.commandCenter, false, `${label} nav Command Center`);
  assert.equal(nav.dryRun, false, `${label} nav Dry Run`);
  assert.equal(isCommandCenterAdmin(user, env), false, `${label} admin gate`);
  assert.throws(() => requireCommandCenterAdmin(user, env), (e: CommandCenterAccessError) => e.status === (user ? 403 : 401), label);
}

async function apiStatus(user: AuthUser, env: Record<string, string | undefined>): Promise<number> {
  const service = new CommandCenterService({ source: memorySource({}), env, now: () => NOW });
  try {
    const body = await service.section(user, "overview", "7D");
    assert.equal(body.readOnly, true);
    return 200;
  } catch (e) {
    if (e instanceof CommandCenterAccessError) return e.status;
    throw e;
  }
}

test("ordinary clients never get Command Center or Dry Run, at every retail subscription status", async () => {
  const statuses = Object.keys(STATUS_LABEL);
  assert.deepEqual(statuses.sort(), ["active", "canceled", "incomplete", "incomplete_expired", "none", "past_due", "trialing", "unpaid"]);
  for (const status of [...statuses, "expired"]) {
    const user = ordinary(status);
    assert.equal(isSubscriptionActive(status), status === "active" || status === "trialing", status);
    assertDenied(user, CLOSED, `ordinary/${status}`);
    assertDenied(user, OWNER_ENV, `ordinary vs owner email/${status}`);
    assertDenied(user, ADMIN_ENV, `ordinary vs admin list/${status}`);
    assertDenied(user, INTERNAL_ENV, `ordinary vs internal uuid/${status}`);
    assert.equal(await apiStatus(user, CLOSED), 403, `API ordinary/${status}`);
    assert.equal(evaluateVisualTestV2Request(user, { mode: "dry_run" }, { env: CLOSED }).status, 403);
    const real = evaluateVisualTestV2RealRequest(user, { confirm: "client-confirm" }, { env: CLOSED });
    assert.equal(real.ok, false);
    if (!real.ok) assert.equal(real.status, 403);
    if (!real.ok) assert.equal(real.body.error, "No autorizado");
  }
});

test("owner, admin allowlist, and internal production owner may see the nav and pass page and API gates without a subscription", async () => {
  const cases = [
    { user: owner("none"), env: OWNER_ENV, label: "avatar owner, no Stripe subscription" },
    { user: owner("canceled"), env: OWNER_ENV, label: "avatar owner, canceled" },
    { user: owner("incomplete_expired"), env: OWNER_ENV, label: "avatar owner, expired" },
    { user: admin("none"), env: ADMIN_ENV, label: "command center admin, no Stripe subscription" },
    { user: admin("canceled"), env: ADMIN_ENV, label: "command center admin, canceled" },
    { user: internalOwner("none"), env: INTERNAL_ENV, label: "internal production owner, no Stripe subscription" },
    { user: internalOwner("incomplete_expired"), env: INTERNAL_ENV, label: "internal production owner, expired" },
    { user: { ...internalOwner("active"), email: "someone-else@example.test" }, env: INTERNAL_ENV, label: "internal uuid, active retail plan" },
  ];
  for (const { user, env, label } of cases) {
    const nav = internalNav(user, env);
    assert.equal(nav.commandCenter, true, label);
    assert.equal(nav.dryRun, true, label);
    assert.doesNotThrow(() => requireCommandCenterAdmin(user, env), label);
    assert.equal(await apiStatus(user, env), 200, label);
  }

  const dir = mkdtempSync(join(tmpdir(), "atomivid-cc-nav-"));
  const dry = evaluateVisualTestV2Request(owner("none"), { mode: "dry_run" }, {
    env: OWNER_ENV,
    outputDir: join(dir, "out"),
    ledgerPath: join(dir, "ledger.json"),
  });
  assert.equal(dry.status, 200);
  assert.equal(dry.body.paidApisCalled, false);
  assert.equal(dry.body.realModeLocked, true);

  const pastAdminGate = evaluateVisualTestV2RealRequest(owner("none"), { confirm: "not-a-server-token" }, { env: OWNER_ENV });
  assert.equal(pastAdminGate.ok, false);
  if (!pastAdminGate.ok) {
    assert.notEqual(pastAdminGate.body.error, "No autorizado");
    assert.equal(pastAdminGate.status, 403);
  }
});

test("empty config, unconfirmed email, and lookalike allowlists stay closed", () => {
  assertDenied(null, OWNER_ENV, "signed out");
  assertDenied({ ...owner("none"), email_confirmed_at: undefined }, OWNER_ENV, "unconfirmed owner email");
  assertDenied({ ...admin("none"), email_confirmed_at: undefined }, ADMIN_ENV, "unconfirmed admin");
  assertDenied({ ...internalOwner("none"), email_confirmed_at: undefined }, INTERNAL_ENV, "unconfirmed internal owner");
  assert.equal(isInternalProductionOwner({ id: INTERNAL_ID, email_confirmed_at: NOW }, INTERNAL_ENV), true);
  assert.equal(isCommandCenterAdmin({ id: INTERNAL_ID, email_confirmed_at: NOW }, INTERNAL_ENV), false, "uuid match without an email stays closed");
  assertDenied(owner("none"), CLOSED, "owner address with empty configuration");
  assertDenied(internalOwner("none"), CLOSED, "internal uuid with empty configuration");
  assertDenied(ordinary("active"), { ...CLOSED, COMMAND_CENTER_ADMIN_EMAILS: "example.test,*@example.test,*,client" }, "substring and wildcard lists are not emails");
  assertDenied(ordinary("active"), { ...CLOSED, AVATAR_PREPARATION_OWNER_EMAIL: "client@example.test.evil" }, "owner email is exact");
  assertDenied(ordinary("active"), { ...CLOSED, INTERNAL_PRODUCTION_OWNER_USER_ID: `${INTERNAL_ID},aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee` }, "uuid list is not a single id");
});

test("header, page, and API keep the owner gate and do not consult Stripe", () => {
  const layout = readFileSync("src/app/dashboard/layout.tsx", "utf8");
  const page = readFileSync("src/app/dashboard/command-center/page.tsx", "utf8");
  const dryPage = readFileSync("src/app/dashboard/long-form/visual-test-v2/page.tsx", "utf8");
  const route = readFileSync("src/app/api/admin/command-center/route.ts", "utf8");
  const billing = readFileSync("src/app/dashboard/billing/page.tsx", "utf8");

  assert.match(layout, /if \(!user\) \{\s*redirect\("\/login"\);/);
  assert.match(layout, /showLongFormDryRun = isCommandCenterAdmin\(user\)/);
  assert.match(layout, /showCommandCenter = isCommandCenterAdmin\(user\)/);
  assert.equal((layout.match(/showCommandCenter &&/g) ?? []).length, 2);
  assert.equal((layout.match(/showLongFormDryRun &&/g) ?? []).length, 2);
  assertLinksOnlyAfterFlag(layout, "/dashboard/command-center", "showCommandCenter");
  assertLinksOnlyAfterFlag(layout, "/dashboard/long-form/visual-test-v2", "showLongFormDryRun");
  for (const src of [layout, page, dryPage, route]) {
    assert.equal(src.includes("isSubscriptionActive"), false);
    assert.equal(/stripe/i.test(src), false);
  }

  const pageGate = page.indexOf("if (!isCommandCenterAdmin(user)) notFound();");
  const pageData = page.indexOf("new CommandCenterService");
  assert.ok(pageGate !== -1 && pageData !== -1 && pageGate < pageData);

  const dryFn = dryPage.indexOf("export default async function VisualTestV2DryRunPage");
  const dryBody = dryFn === -1 ? "" : dryPage.slice(dryFn);
  const dryGate = dryBody.indexOf("if (!user || !isCommandCenterAdmin(user))");
  const dryGallery = dryBody.indexOf("buildVisualTestV2Gallery");
  assert.ok(dryGate !== -1 && dryGallery !== -1 && dryGate < dryGallery);
  assert.match(dryBody, /notFound\(\)/);

  assert.match(route, /service\.section\(user, section, window\)/);
  assert.match(route, /if \(e instanceof CommandCenterAccessError\) return NextResponse\.json\(\{ error: e\.message \}, \{ status: e\.status/);
  assert.match(route, /private, no-store/);

  const ownerStart = billing.indexOf("if (isInternalProductionOwner(user))");
  const retailStart = billing.indexOf('from("subscriptions")');
  const ccLink = billing.indexOf('href="/dashboard/command-center"');
  assert.ok(ownerStart !== -1 && ccLink > ownerStart && ccLink < retailStart, "billing Command Center link stays inside the internal-owner plan");
});

function assertLinksOnlyAfterFlag(source: string, href: string, flag: string) {
  const needle = `href="${href}"`;
  let from = 0;
  let count = 0;
  while (true) {
    const at = source.indexOf(needle, from);
    if (at === -1) break;
    count += 1;
    const before = source.slice(Math.max(0, at - 400), at);
    assert.ok(before.includes(flag), `${href} must sit inside ${flag}`);
    from = at + needle.length;
  }
  assert.equal(count, 2, href);
}
