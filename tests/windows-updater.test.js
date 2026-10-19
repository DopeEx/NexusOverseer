import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('Windows manual updater: offline transactions, channels and starter recovery', {
  skip: process.platform !== 'win32',
  timeout: 120_000,
}, () => {
  const script = fileURLToPath(new URL('./windows-updater.ps1', import.meta.url));
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
  ], { encoding: 'utf8', timeout: 110_000, windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /All updater checks passed/);
});
