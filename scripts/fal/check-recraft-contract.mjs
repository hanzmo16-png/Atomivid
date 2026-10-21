// Free, keyless contract check of the fal.ai Recraft V4 Styles endpoint used by src/lib/providers/image/recraft.ts.
// Reads fal's PUBLIC OpenAPI document (no FAL_KEY, no generation, no cost) and fails if any field the adapter relies on
// is missing: inputs prompt / image_size (portrait_16_9, landscape_16_9) / style_id / image_urls / style_match and
// outputs images[].url / style_id. Usage: node scripts/fal/check-recraft-contract.mjs [--file saved.json]
import fs from "node:fs";
const ENDPOINT = "recraft/v4/style/text-to-image";
const URL_ = `https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=${encodeURIComponent(ENDPOINT)}`;
const fileArg = process.argv.indexOf("--file");
const doc = fileArg > 0 ? JSON.parse(fs.readFileSync(process.argv[fileArg + 1], "utf8"))
  : await (async () => { const r = await fetch(URL_, { redirect: "follow" }); if (!r.ok) throw new Error(`OpenAPI HTTP ${r.status} for ${URL_}`); return r.json(); })();
const schemas = doc?.components?.schemas ?? {};
const deref = (s) => { let cur = s; for (let i = 0; cur && cur.$ref && i < 10; i++) cur = schemas[cur.$ref.split("/").pop()]; return cur; };
const flat = (s) => { s = deref(s); if (!s) return null; if (s.allOf) return Object.assign({}, ...s.allOf.map(flat)); return s; };
const candidates = Object.entries(schemas);
const input = candidates.find(([n, s]) => /Input$/.test(n) && deref(s)?.properties?.prompt);
const output = candidates.find(([n, s]) => /Output$/.test(n) && deref(s)?.properties?.images);
const problems = [];
if (!input) problems.push("input schema with `prompt` not found");
if (!output) problems.push("output schema with `images` not found");
const inP = input ? flat(input[1]).properties : {};
const outP = output ? flat(output[1]).properties : {};
const enumOf = (p) => { const v = flat(p) ?? {}; return [...(v.enum ?? []), ...((v.anyOf ?? v.oneOf ?? []).flatMap((x) => flat(x)?.enum ?? []))]; };
for (const k of ["prompt", "image_size", "style_id", "image_urls", "style_match"]) if (!inP[k]) problems.push(`input.${k} missing`);
const sizes = inP.image_size ? enumOf(inP.image_size) : [];
for (const v of ["portrait_16_9", "landscape_16_9"]) if (!sizes.includes(v)) problems.push(`input.image_size lacks ${v} (has: ${sizes.join(",") || "none"})`);
if (!outP.images) problems.push("output.images missing");
if (!outP.style_id) problems.push("output.style_id missing (adapter refuses a created image without it)");
const summary = { endpoint: ENDPOINT, source: fileArg > 0 ? "file" : URL_, inputSchema: input?.[0] ?? null, outputSchema: output?.[0] ?? null,
  inputFields: Object.keys(inP).sort(), outputFields: Object.keys(outP).sort(), imageSizes: sizes, problems };
console.log(JSON.stringify(summary, null, 2));
if (problems.length) { console.error(`CONTRACT MISMATCH: ${problems.join("; ")}`); process.exit(1); }
console.log("CONTRACT OK");
