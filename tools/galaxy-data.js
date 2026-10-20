import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { emptyPublicGalaxy, validatePublicGalaxy, validatePublicManifest, mergePublicGalaxies, PUBLIC_MAX_BYTES } from '../nexus-addon/galaxy-public.js';

const root = fileURLToPath(new URL('../data/galaxy/', import.meta.url));
const bytes = data => `${JSON.stringify(data, null, 2)}\n`;

export async function mergeContribution(input, directory = root, dryRun = false) {
  let content;
  try { content = await readFile(input, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(
      `Contribution file not found: ${input}\nExport public data from Options > Data first, then pass the actual downloaded JSON path (in quotes if it contains spaces).`,
      { cause: error });
    throw error;
  }
  const incoming = validatePublicGalaxy(JSON.parse(content));
  const path = resolve(directory, `${incoming.serverKey}.json`);
  let previous = emptyPublicGalaxy(incoming.serverKey);
  try { previous = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const result = mergePublicGalaxies(previous, incoming);
  if (result.conflicts.length || dryRun) return result;
  const manifestPath = resolve(directory, 'manifest.json');
  const manifest = validatePublicManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
  const published = bytes(result.data);
  if (Buffer.byteLength(published) > PUBLIC_MAX_BYTES) throw new Error('Published galaxy file exceeds the addon download limit of 25 MB.');
  const sha256 = createHash('sha256').update(published).digest('hex');
  manifest.servers[incoming.serverKey] = { file: `${incoming.serverKey}.json`, sha256 };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, published);
  await writeFile(manifestPath, bytes(manifest));
  return result;
}

export async function validateRepository(directory = root) {
  const manifest = validatePublicManifest(JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8')));
  for (const [server, entry] of Object.entries(manifest.servers)) {
    const content = await readFile(resolve(directory, entry.file), 'utf8');
    if (Buffer.byteLength(content) > PUBLIC_MAX_BYTES) throw new Error(`Published galaxy file exceeds 25 MB: ${server}`);
    validatePublicGalaxy(JSON.parse(content), server);
    if (createHash('sha256').update(content).digest('hex') !== entry.sha256) throw new Error(`Checksum mismatch: ${server}`);
  }
}

export async function guidedContribution(input, { directory = root, confirm, log = console.log } = {}) {
  await validateRepository(directory);
  const preview = await mergeContribution(input, directory, true);
  const fingerprint = createHash('sha256').update(await readFile(input)).digest('hex');
  const manifestBefore = await readFile(resolve(directory, 'manifest.json'), 'utf8');
  const incoming = validatePublicGalaxy(JSON.parse(await readFile(input, 'utf8')));
  const target = resolve(directory, `${incoming.serverKey}.json`);
  let targetBefore = null;
  try { targetBefore = await readFile(target, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const count = group => incoming.systems.reduce((total, system) => total + (system[group]?.length || 0), 0);
  log(`\nUniverse: ${incoming.serverKey}`);
  log(`Input: ${input}`);
  log(`${incoming.systems.length} systems, ${count('planets')} planets, ${count('moons')} moons, ` +
    `${incoming.stations.length} stations, ${incoming.hubs.length} hubs`);
  log(`Preview: ${preview.added} new records, ${preview.filled} missing fields filled, ${preview.conflicts.length} conflicts.`);
  if (preview.conflicts.length) {
    for (const conflict of preview.conflicts) log(`  ${conflict}`);
    throw new Error('Conflicts found. Nothing was written. Review and resolve these values before importing again.');
  }
  if (!preview.added && !preview.filled) {
    log('No additions. The published dataset already contains these values. Nothing was changed.');
    return { ...preview, applied: false };
  }
  log(`Target: ${target}`);
  log('Only local dataset files will change. This tool never uploads, commits or pushes.');
  if ((await confirm('Type MERGE to apply these additions, or press Enter to cancel: ')).trim() !== 'MERGE') {
    log('Cancelled. Nothing was changed.');
    return { ...preview, applied: false };
  }
  let targetNow = null;
  try { targetNow = await readFile(target, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (fingerprint !== createHash('sha256').update(await readFile(input)).digest('hex') ||
      manifestBefore !== await readFile(resolve(directory, 'manifest.json'), 'utf8') || targetBefore !== targetNow) {
    throw new Error('Input or published data changed during confirmation. Nothing was written; start again to review a new preview.');
  }
  const result = await mergeContribution(input, directory);
  if (result.conflicts.length) throw new Error('Data changed during import. Conflicts found; no merge was applied.');
  await validateRepository(directory);
  log('\nImport complete. Dataset and checksums are valid.');
  log('Review data\\galaxy in VS Code Source Control, then commit/push manually when ready.');
  return { ...result, applied: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === 'check') {
      await validateRepository();
      console.log('Galaxy datasets and checksums are valid.');
    } else if (process.argv[2] === 'guided' && process.argv[3]) {
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      try {
        await guidedContribution(resolve(process.argv[3]), { confirm: question => prompt.question(question) });
      } finally { prompt.close(); }
    } else if (['merge', 'preview'].includes(process.argv[2]) && process.argv[3]) {
      const result = await mergeContribution(resolve(process.argv[3]), root, process.argv[2] === 'preview');
      console.log(JSON.stringify({ added: result.added, filled: result.filled, conflicts: result.conflicts }, null, 2));
      if (result.conflicts.length) process.exitCode = 1;
    } else throw new Error('Double-click tools\\Import-Galaxy-Data.bat, or use: node tools\\galaxy-data.js check|preview <export.json>|merge <export.json>|guided <export.json>');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
