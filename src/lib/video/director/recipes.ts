/** Versioned recipe catalog (content/cinematic-director/recipes.v2.json), validated with the contract. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { RecipeCatalogSchema, type Recipe, type RecipeCatalog } from "./contract";

export const RECIPE_CATALOG_PATH = path.join(process.cwd(), "content", "cinematic-director", "recipes.v2.json");

export function loadRecipeCatalog(file = RECIPE_CATALOG_PATH): RecipeCatalog {
  return RecipeCatalogSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

/** Recipes of a genre and recipe set: the fiction set only for a fiction input, the historic sets otherwise. */
export const recipesFor = (catalog: RecipeCatalog, genre: Recipe["genre"], style?: "fiction") =>
  catalog.recipes.filter(r => r.genre === genre && (r.select.style ?? null) === (style ?? null));

/**
 * Same catalog, bundled as a module import: a server component (the Reels review page) must not depend on
 * `process.cwd()` file tracing on the hosting platform. Parsed and validated on first use only.
 */
import bundledCatalogJson from "../../../../content/cinematic-director/recipes.v2.json";
let bundled: RecipeCatalog | null = null;
export function bundledRecipeCatalog(): RecipeCatalog {
  return (bundled ??= RecipeCatalogSchema.parse(bundledCatalogJson));
}
