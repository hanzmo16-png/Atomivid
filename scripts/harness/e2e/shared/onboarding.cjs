/** Real UI dismissal, not a localStorage injection or forced click. No swallowed timeout.
 * First-visit effects may mount after navigation/SSR; isVisible() is only a snapshot.
 * Call only on dashboard routes where the product auto-opens the tour (not Audio Studio).
 */
const KEY = "atomivid_onboarding_completed_v1";
async function dismissFirstVisitTour(page, { timeout = 30000 } = {}) {
  const dialog = page.locator('[role="dialog"][aria-labelledby="onboarding-title"]');
  if (!(await page.evaluate((key) => localStorage.getItem(key) === "1", KEY))) {
    await dialog.waitFor({ state: "visible", timeout });
    await dialog.getByRole("button", { name: "Omitir", exact: true }).click({ timeout });
  }
  await dialog.waitFor({ state: "hidden", timeout });
  if (!(await page.evaluate((key) => localStorage.getItem(key) === "1", KEY))) {
    throw new Error("Onboarding dismissal was not persisted; download/navigation is not ready");
  }
}
module.exports = { dismissFirstVisitTour };
