import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

test('Windows manual updater: offline transactions, channels and starter recovery', {
  skip: process.platform !== 'win32',
  timeout: 120_000,
}, () => {
  const script = fileURLToPath(new URL('./windows-updater.ps1', import.meta.url));
  // CI's PowerShell 7 module path must not shadow Windows PowerShell 5.1 modules.
  const env = {
    ...process.env,
    PSModulePath: [
      path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
      path.join(process.env.ProgramFiles, 'WindowsPowerShell', 'Modules'),
    ].join(path.delimiter),
  };
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
  ], { encoding: 'utf8', timeout: 110_000, windowsHide: true, env });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /All updater checks passed/);
});
