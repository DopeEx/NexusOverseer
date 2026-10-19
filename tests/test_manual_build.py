import hashlib
import json
from pathlib import Path
import runpy
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile


ROOT = Path(__file__).resolve().parents[1]
BUILD = runpy.run_path(str(ROOT / 'nexus-addon' / 'build.py'))


class ManualBuildTests(unittest.TestCase):
    def test_store_payloads_stay_separate_and_manual_hashes_cover_every_file(self):
        build = BUILD['build']
        version = BUILD['read_version']()
        with tempfile.TemporaryDirectory() as output:
            with patch.dict(build.__globals__, ROOT=output):
                build(version)
            directory = Path(output)
            self.assertEqual(len(list(directory.iterdir())), 3)
            with zipfile.ZipFile(directory / f'nexus-overseer-{version}.zip') as chrome:
                self.assertEqual(set(chrome.namelist()), set(BUILD['FILES']))
                self.assertNotIn('scripts', json.loads(chrome.read('manifest.json'))['background'])
                addon = {name: chrome.read(name) for name in chrome.namelist()}
                self.assertEqual(json.loads(addon['.nexus-install.json'])['channel'], 'store')
            with zipfile.ZipFile(directory / f'nexus-overseer-{version}.xpi') as firefox:
                self.assertEqual(set(firefox.namelist()), set(BUILD['FILES']))
                background = json.loads(firefox.read('manifest.json'))['background']
                self.assertEqual(background['scripts'], ['background-sw.js'])
                self.assertEqual(json.loads(firefox.read('.nexus-install.json'))['channel'], 'store')
            with zipfile.ZipFile(directory / f'nexus-overseer-{version}-windows-manual.zip') as manual:
                metadata = json.loads(manual.read('manual-package.json'))
                self.assertEqual(metadata['format'], 1)
                self.assertEqual(metadata['launcherProtocol'], 1)
                self.assertEqual(metadata['addonVersion'], version)
                self.assertRegex(metadata['updaterVersion'], r'^\d+\.\d+\.\d+$')
                self.assertEqual(set(manual.namelist()), set(metadata['files']) | {'manual-package.json'})
                for name, digest in metadata['files'].items():
                    self.assertEqual(hashlib.sha256(manual.read(name)).hexdigest(), digest, name)
                for name, content in addon.items():
                    if name == '.nexus-install.json':
                        state = json.loads(manual.read(f'addon/{name}'))
                        self.assertEqual(state['channel'], 'release')
                        self.assertEqual(state['revision'], f'v{version}')
                        self.assertEqual(state['version'], version)
                        continue
                    self.assertEqual(manual.read(f'addon/{name}'), content)
                starter = manual.read('Update-Nexus.bat')
                self.assertIn(b'\r\n', starter)
                self.assertNotIn(b'\n', starter.replace(b'\r\n', b''))

    def test_manual_cli_does_not_rebuild_or_remove_store_packages(self):
        main = BUILD['main']
        version = BUILD['read_version']()
        with tempfile.TemporaryDirectory() as output:
            store = Path(output) / f'nexus-overseer-{version}.zip'
            store.write_bytes(b'existing store artifact')
            with patch.dict(main.__globals__, ROOT=output):
                with patch.object(sys, 'argv', ['build.py', '--manual']):
                    main()
                with patch.object(sys, 'argv', ['build.py', '--manual', '--sign']):
                    with self.assertRaises(SystemExit):
                        main()
            self.assertEqual(store.read_bytes(), b'existing store artifact')
            self.assertTrue((Path(output) / f'nexus-overseer-{version}-windows-manual.zip').is_file())


if __name__ == '__main__':
    unittest.main()
