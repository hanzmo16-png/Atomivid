/** Versioned recipe catalog (content/cinematic-director/recipes.v2.json), validated with the contract. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { RecipeCatalogSchema, type Recipe, type RecipeCatalog } from "./contract";

export const RECIPE_CATALOG_PATH = path.join(process.cwd(), "content", "cinematic-director", "recipes.v2.json");

export function loadRecipeCatalog(file = RECIPE_CATALOG_PATH): RecipeCatalog {
  return RecipeCatalogSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

export const recipesFor = (catalog: RecipeCatalog, genre: Recipe["genre"]) => catalog.recipes.filter(r => r.genre === genre);

/**
 * Same catalog, bundled as a module import: a server component (the Reels review page) must not depend on
 * `process.cwd()` file tracing on the hosting platform. Parsed and validated on first use only.
 */
import bundledCatalogJson from "../../../../content/cinematic-director/recipes.v2.json";
let bundled: RecipeCatalog | null = null;
export function bundledRecipeCatalog(): RecipeCatalog {
  return (bundled ??= RecipeCatalogSchema.parse(bundledCatalogJson));
}
