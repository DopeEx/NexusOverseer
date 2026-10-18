#!/usr/bin/env python3
"""Build (and optionally submit) the addon.

Usage, from nexus-addon/:
    python3 build.py            build the unsigned xpi at the repo root
    python3 build.py --sign     submit the version to AMO (LISTED channel)
                                for review and public distribution

Submission needs AMO credentials in the environment or in ../.env

Listed versions are reviewed by Mozilla humans and distributed/updated by
AMO itself — there is no self-hosted update channel. Track review status at
https://addons.mozilla.org/developers/addons.
"""
import glob
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ARTIFACT_BASENAME = 'nexus-overseer'

FILES = [
    'manifest.json',
    'package.json',
    'CHANGELOG.md',
    'background-sw.js', 'server-storage.js', 'server-switch.js', 'background.js', 'sidebar-inject.js',
    'galaxy-fetch-hook.js', 'game-api-bridge.js', 'galaxy-fields.js', 'empire-view.js', 'guide-content.js', 'guide-view.js', 'logistics-view.js', 'upgrade-queue.js', 'building-upgrade.js', 'tech-upgrade.js', 'ship-upgrade.js',
    'dashboard.html', 'theme.css', 'dashboard.css', 'dashboard.js', 'automation-scheduler.js', 'common.js', 'settings.js', 'tabs/options.js', 'pirate-planner.js', 'pirate-plan-cache.js', 'human-verification.js',
    'tabs/global.js', 'tabs/dashboard.js', 'tabs/surveys.js', 'tabs/pirates.js', 'tabs/mining.js',
    'tabs/battles.js', 'tabs/debris.js', 'tabs/expeditions.js', 'tabs/wormholes.js', 'tabs/finder.js', 'tabs/asteroids.js', 'tabs/fleets.js', 'tabs/scouting.js', 'tabs/xeno.js', 'tabs/market.js', 'tabs/techtree.js',
    'tabs/simulator.js', 'tabs/guide.js', 'simulator-intel.js',
    'chart.umd.js', 'browser-polyfill.js',
    'icons/icon128.png',
]


def read_version():
    with open(os.path.join(HERE, 'manifest.json')) as f:
        return json.load(f)['version']


def firefox_manifest():
    """Firefox ignores background.service_worker, so its package gets a
    background.scripts fallback. Chrome rejects that key in MV3, so the repo
    manifest (and the Chrome zip) keep service_worker only."""
    with open(os.path.join(HERE, 'manifest.json'), encoding='utf-8') as f:
        manifest = json.load(f)
    manifest['background']['scripts'] = [manifest['background']['service_worker']]
    return json.dumps(manifest, indent=2, ensure_ascii=False) + '\n'


def build(version):
    """Write the package as .xpi (Firefox/AMO, with the scripts fallback in
    its manifest) and .zip (Chrome Web Store)."""
    import zipfile
    targets = []
    for ext in ('xpi', 'zip'):
        target = os.path.join(ROOT, f'{ARTIFACT_BASENAME}-{version}.{ext}')
        for old in glob.glob(os.path.join(ROOT, f'{ARTIFACT_BASENAME}-*.{ext}')):
            if old != target:
                os.remove(old)
                print(f'removed {os.path.basename(old)}')
        with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as z:
            for name in FILES:
                if name == 'manifest.json' and ext == 'xpi':
                    z.writestr(name, firefox_manifest())
                else:
                    z.write(os.path.join(HERE, name), name)
        size = os.path.getsize(target) // 1024
        print(f'built {os.path.basename(target)} ({size} KB, {len(FILES)} files)')
        targets.append(target)
    return targets[0]


def load_env():
    """Fill os.environ from ../.env (KEY=value lines), without overriding."""
    path = os.path.join(ROOT, '.env')
    if not os.path.exists(path):
        return
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, _, v = line.partition('=')
                os.environ.setdefault(k.strip(), v.strip())


def sign(version):
    load_env()
    key = os.environ.get('WEB_EXT_API_KEY')
    secret = os.environ.get('WEB_EXT_API_SECRET')
    if not key or not secret:
        sys.exit('Missing WEB_EXT_API_KEY / WEB_EXT_API_SECRET (env or ../.env).')

    artifacts = os.path.join(ROOT, 'web-ext-artifacts')
    # Sign from a staged copy so the submitted manifest has the Firefox fallback.
    stage = os.path.join(ROOT, 'web-ext-source')
    shutil.rmtree(stage, ignore_errors=True)
    for name in FILES:
        dest = os.path.join(stage, name)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        if name == 'manifest.json':
            with open(dest, 'w', encoding='utf-8') as f:
                f.write(firefox_manifest())
        else:
            shutil.copy2(os.path.join(HERE, name), dest)
    cmd = [
        'npx', '--yes', 'web-ext', 'sign',
        '--source-dir', stage,
        '--artifacts-dir', artifacts,
        '--channel', 'listed',
        '--api-key', key,
        '--api-secret', secret,
        # web-ext refuses files it doesn't recognize unless ignored explicitly
        '--ignore-files', 'build.py', 'web-ext-artifacts', '.amo-upload-uuid',
    ]
    print(f'submitting {version} to AMO (listed channel, human review)…')
    result = subprocess.run(cmd)

    signed = sorted(glob.glob(os.path.join(artifacts, '*.xpi')), key=os.path.getmtime)
    if signed and f'-{version}.xpi' in signed[-1]:
        # Only happens if the version was approved while we waited.
        shutil.copy2(signed[-1], os.path.join(ROOT, os.path.basename(signed[-1])))
        print(f'approved and signed: {os.path.basename(signed[-1])}')
    else:
        print()
        print('Submitted for review. AMO distributes and auto-updates the addon')
        print('once approved — track status at')
        print('https://addons.mozilla.org/developers/addons')
        if result.returncode != 0:
            print('(web-ext exited non-zero: usual for listed submissions that')
            print(' end while the review is still pending — check the page above.)')


def publish_chrome(version):
    load_env()
    needed = ['CWS_EXTENSION_ID', 'CWS_CLIENT_ID', 'CWS_CLIENT_SECRET', 'CWS_REFRESH_TOKEN']
    missing = [k for k in needed if not os.environ.get(k)]
    if missing:
        sys.exit('Missing ' + ', '.join(missing) + ' (env or ../.env).')

    zip_path = os.path.join(ROOT, f'{ARTIFACT_BASENAME}-{version}.zip')
    if not os.path.exists(zip_path):
        build(version)

    cmd = [
        'npx', '--yes', 'chrome-webstore-upload-cli@3', 'upload',
        '--source', zip_path,
        '--extension-id', os.environ['CWS_EXTENSION_ID'],
        '--client-id', os.environ['CWS_CLIENT_ID'],
        '--client-secret', os.environ['CWS_CLIENT_SECRET'],
        '--refresh-token', os.environ['CWS_REFRESH_TOKEN'],
        '--auto-publish',
    ]
    print(f'uploading {version} to the Chrome Web Store…')
    subprocess.run(cmd, check=True)
    print('Chrome Web Store: uploaded and submitted for review.')


def main():
    version = read_version()
    build(version)
    if '--sign' in sys.argv:
        sign(version)
    if '--chrome' in sys.argv:
        publish_chrome(version)


if __name__ == '__main__':
    main()
