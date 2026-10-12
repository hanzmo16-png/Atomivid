/** Versioned recipe catalog (content/cinematic-director/recipes.v2.json), validated with the contract. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { RecipeCatalogSchema, type Recipe, type RecipeCatalog } from "./contract";

export const RECIPE_CATALOG_PATH = path.join(process.cwd(), "content", "cinematic-director", "recipes.v2.json");

export function loadRecipeCatalog(file = RECIPE_CATALOG_PATH): RecipeCatalog {
  return RecipeCatalogSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

export const recipesFor = (catalog: RecipeCatalog, genre: Recipe["genre"]) => catalog.recipes.filter(r => r.genre === genre);
