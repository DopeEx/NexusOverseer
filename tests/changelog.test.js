import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { changelogForVersion } from '../nexus-addon/common.js';

const markdown = '# Changelog\n\n## [Unreleased]\n\n## [2.2.0] - 2026-10-19\n\n### Added\n- New release.\n\n## [2.1.0]\n\n### Fixed\n- Previous release.\n';

test('release notes select the installed version after an empty Unreleased section', () => {
  assert.equal(changelogForVersion(markdown, '2.2.0'), '### Added\n- New release.');
  assert.equal(changelogForVersion(markdown, '2.1.0'), '### Fixed\n- Previous release.');
});

test('unreleased content never replaces the installed release notes', () => {
  const pending = markdown.replace('## [Unreleased]\n', '## [Unreleased]\n\n### Added\n- Future change.\n');
  assert.equal(changelogForVersion(pending, '2.2.0'), '### Added\n- New release.');
});

test('missing and empty release notes retain the dialog fallback', () => {
  assert.equal(changelogForVersion(markdown, '2.3.0'), null);
  assert.equal(changelogForVersion('## [2.2.0]\n\n## [2.1.0]\nOld', '2.2.0'), null);
});

test('release selection supports Windows line endings, EOF and demo versions', () => {
  assert.equal(changelogForVersion(markdown.replaceAll('\n', '\r\n'), '2.2.0-demo'), '### Added\r\n- New release.');
  assert.equal(changelogForVersion('## [2.2.0]\n### Fixed\n- At EOF', '2.2.0'), '### Fixed\n- At EOF');
});

test('the bundled release notes include all sections for the manifest version', async () => {
  const manifest = JSON.parse(await readFile(new URL('../nexus-addon/manifest.json', import.meta.url), 'utf8'));
  const changelog = await readFile(new URL('../nexus-addon/CHANGELOG.md', import.meta.url), 'utf8');
  const notes = changelogForVersion(changelog, manifest.version);
  assert.ok(notes, 'Installed version has release notes');
  assert.ok(notes.includes('### Fixed'));
  const previous = changelogForVersion(changelog, '2.2.0');
  for (const heading of ['Added', 'Changed', 'Fixed', 'Documentation']) {
    assert.ok(previous.includes(`### ${heading}`), heading);
  }
  assert.ok(!notes.includes('## [2.1.0]'));
});
