import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { changelogForVersion } from '../nexus-addon/common.js';

const markdown = '# Changelog\n\n## [Unreleased]\n\n## [2.2.0] - 2026-10-19\n\n### Added\n- New release.\n\n## [2.1.0]\n\n### Fixed\n- Previous release.\n';

test('release notes select the installed version after an empty Unreleased section', () => {
  assert.deepEqual(changelogForVersion(markdown, '2.2.0'), [{ version: '2.2.0', notes: '### Added\n- New release.' }]);
  assert.deepEqual(changelogForVersion(markdown, '2.1.0'), [{ version: '2.1.0', notes: '### Fixed\n- Previous release.' }]);
});

test('unreleased content never replaces the installed release notes', () => {
  const pending = markdown.replace('## [Unreleased]\n', '## [Unreleased]\n\n### Added\n- Future change.\n');
  assert.deepEqual(changelogForVersion(pending, '2.2.0'), [{ version: '2.2.0', notes: '### Added\n- New release.' }]);
});

test('missing and empty release notes retain the dialog fallback', () => {
  assert.deepEqual(changelogForVersion(markdown, '2.3.0'), []);
  assert.deepEqual(changelogForVersion('## [2.2.0]\n\n## [2.1.0]\nOld', '2.2.0'), []);
});

test('release selection supports Windows line endings, EOF and demo versions', () => {
  assert.equal(changelogForVersion(markdown.replaceAll('\n', '\r\n'), '2.2.0-demo')[0].notes, '### Added\r\n- New release.');
  assert.equal(changelogForVersion('## [2.2.0]\n### Fixed\n- At EOF', '2.2.0')[0].notes, '### Fixed\n- At EOF');
});

test('patch releases include only their minor series up to the installed patch, newest first', () => {
  const input = ['Unreleased', '2.3.0', '2.2.10', '2.2.0', '2.2.2', '2.2.1', '1.2.2', '2.1.9']
    .map(version => `## [${version}]\n### Added\n- ${version}`).join('\n');
  assert.deepEqual(changelogForVersion(input, '2.2.2').map(entry => entry.version), ['2.2.2', '2.2.1', '2.2.0']);
  assert.deepEqual(changelogForVersion(input, '2.2.10').map(entry => entry.version), ['2.2.10', '2.2.2', '2.2.1', '2.2.0']);
  assert.deepEqual(changelogForVersion(input, '2.3.0').map(entry => entry.version), ['2.3.0']);
});

test('the bundled release notes include all sections for the manifest version', async () => {
  const manifest = JSON.parse(await readFile(new URL('../nexus-addon/manifest.json', import.meta.url), 'utf8'));
  const changelog = await readFile(new URL('../nexus-addon/CHANGELOG.md', import.meta.url), 'utf8');
  const notes = changelogForVersion(changelog, manifest.version);
  assert.equal(notes[0].version, manifest.version);
  assert.match(notes[0].notes, /^### (Added|Changed|Fixed|Documentation)\b/m);
  const previous = changelogForVersion(changelog, '2.2.0')[0].notes;
  for (const heading of ['Added', 'Changed', 'Fixed', 'Documentation']) {
    assert.ok(previous.includes(`### ${heading}`), heading);
  }
  assert.deepEqual(notes.map(entry => entry.version), ['2.2.2', '2.2.1', '2.2.0']);
});
