import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PILOT_SEARCHES, readPilotConfig, searchPilot, pilotHtml } from './lib/storyblocks-pilot.mjs';

try {
  const config = readPilotConfig();
  const searches = [];
  // At most six searches, no automatic retry and no licensing/download calls.
  for (const search of PILOT_SEARCHES) searches.push(await searchPilot(config, search));
  const report = { createdAt: new Date().toISOString(), mode: 'INTERNAL_PREVIEW_ONLY', realProvider: true, productionReady: false, searches };
  const directory = resolve('.atomivid-state/storyblocks-pilot');
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, 'catalogue.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  await writeFile(resolve(directory, 'review.html'), pilotHtml(report), { mode: 0o600 });
  console.log(`Storyblocks: ${searches.reduce((count, item) => count + item.candidates.length, 0)} previews. Review: ${directory}/review.html`);
  console.log('No licensing/download endpoints called. Visual review and production contract are still pending.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Storyblocks pilot failed');
  process.exitCode = 1;
}
