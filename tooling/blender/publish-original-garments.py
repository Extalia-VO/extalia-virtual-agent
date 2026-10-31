"""Register reviewed, source-preserving garment exports in the application's local public assets.

python3 tooling/blender/publish-original-garments.py --only pieces|sets|all

Run only after Blender pose review. Original embedded textures and UVs stay in the GLBs;
attribution distinguishes CC-BY garment geometry from added licensed avatar skin/context.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import struct

ROOT = Path(__file__).resolve().parents[2]
LOCAL = ROOT / 'apps/web/local-assets/avatars'
DESTINATION = ROOT / 'apps/web/public-assets'
START, END = '<!-- original-garments:start -->', '<!-- original-garments:end -->'
SPEC = importlib.util.spec_from_file_location('public_original_helpers', Path(__file__).with_name('prepare-public-models.py'))
PUBLIC = importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(PUBLIC)
PIECES = [
    ('female/outer/cloth-jacket', 'tooling/blender/fit-original-garments.py'),
    ('female/bottom/short-jeans', 'tooling/blender/fit-original-bottoms.py'),
    ('male/bottom/jeans', 'tooling/blender/fit-original-bottoms.py'),
]
SET_PATH = re.compile(r'^avatars/outfits/(?:female/(?:outfit-original-dress|reception-uniform)|male/bartender-uniform)\.glb$')


def document(path):
    data = path.read_bytes();length = struct.unpack_from('<I', data, 12)[0]
    return json.loads(data[20:20 + length])


def atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.staging')
    temporary.write_bytes(data);temporary.replace(path)


def sources(selection):
    if selection in ('pieces', 'all'):
        for name, exporter in PIECES:
            local = LOCAL / 'wardrobe' / (name + '.glb')
            if not local.is_file():
                raise FileNotFoundError(f'Build and review {name} first')
            doc = document(local)
            if doc.get('asset', {}).get('extras', {}).get('nonStandalone'):
                raise ValueError('A paired inner panel cannot be published as a standalone garment')
            sidecar = local.with_suffix('.source.json')
            credit = json.loads(sidecar.read_text())['source'] if sidecar.exists() else doc['asset']['extras']['source']
            yield local, 'avatars/wardrobe/' + name + '.glb', exporter, credit
    if selection in ('sets', 'all'):
        authored = json.loads((LOCAL / 'original-sets/sets.manifest.json').read_text())
        for entry in authored['sets']:
            if not SET_PATH.fullmatch(entry['path']):
                raise ValueError('Unexpected original outfit path')
            yield LOCAL / 'original-sets' / entry['group'] / (entry['id'] + '.glb'), entry['path'], authored['exporter'], entry['credit']
        bartender = LOCAL / 'original-sets/male/bartender-uniform.source.json'
        if bartender.exists():
            entry = json.loads(bartender.read_text())
            yield bartender.with_name('bartender-uniform.glb'), 'avatars/outfits/male/bartender-uniform.glb', entry['exporter'], entry['source']


def main():
    parser = argparse.ArgumentParser();parser.add_argument('--only', required=True, choices=['pieces', 'sets', 'all'])
    parser.add_argument('--ids', help='Comma-separated reviewed file stems to register from the selected group')
    args = parser.parse_args()
    selected = set(args.ids.split(',')) if args.ids else None
    manifest_file = DESTINATION / 'models.json';manifest = json.loads(manifest_file.read_text())
    published = {entry['path']: entry for entry in manifest['models']}
    credits = {}
    for local, relative, exporter, credit in sources(args.only):
        if selected is not None and local.stem not in selected:
            continue
        if local.is_symlink() or not credit.get('license', '').startswith('CC-BY-4.0'):
            raise ValueError('Only reviewed regular-file CC-BY original garments are accepted')
        author_name = credit['author'].split(' (http', 1)[0]
        copyright = (f'Based on "{credit["title"]}" by {author_name}, CC-BY-4.0. '
                     'Fitted and re-rigged; original textures and UVs retained. '
                     'Added avatar skin/context remains under the RenderHub Extended Use License. See THIRD_PARTY_NOTICES.md.')
        data = PUBLIC.public_glb(local, copyright, sanitize_original=True)
        atomic(DESTINATION / relative, data)
        published[relative] = {'path': relative, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data),
            'license': 'CC-BY-4.0', 'provenance': {'kind': 'third-party-derived', 'exporter': exporter,
            'note': f'Original {credit["title"]} garment geometry, UVs and native material maps retained; fitted and re-rigged. '
                    'Source garment: CC-BY-4.0. Any added avatar skin/context: RenderHub Extended Use License; see notices.'}}
        credits[relative] = credit
        print('Registered', relative, len(data), 'bytes')
    # Keep attribution for reviewed files published by another selection in a previous invocation.
    notices = DESTINATION / 'THIRD_PARTY_NOTICES.md';text = notices.read_text()
    previous_lines = {}
    if START in text:
        old = text.split(START, 1)[1].split(END, 1)[0]
        for line in old.splitlines():
            if line.startswith('- `'):
                previous_lines[line.split('`')[1]] = line
    for relative, credit in credits.items():
        previous_lines[relative] = (f'- `{relative}` (CC-BY-4.0): "{credit["title"]}" by {credit["author"]}; '
            f'{credit["source"]}. Modified: body fit, skeletal binding and garment separation; original UVs and texture maps retained.')
    section = [START, '## Original avatar garments', '',
        'These garments use the original owner-provided GLB meshes and native materials, not replacement templates.',
        'The source garment geometry and textures are licensed under CC-BY-4.0 (https://creativecommons.org/licenses/by/4.0/).',
        'Body-specific fitting and skeletal binding adapt them for the Office. Hidden panels of the non-standalone',
        'jacket inner are local review material; only its independently wearable outer is distributed.',
        'Any added avatar skin/context keeps its separate RenderHub Extended Use License:',
        'https://www.renderhub.com/info/3d-content-licensing. Those parts are not relicensed under CC-BY or MIT.', '',
        *[previous_lines[key] for key in sorted(previous_lines) if key in published], '', END]
    block = '\n'.join(section) + '\n'
    if START in text:
        before, tail = text.split(START, 1);text = before + block + tail.split(END, 1)[1].lstrip('\n')
    else:
        text = text.rstrip('\n') + '\n\n' + block
    # Earlier generated-uniform credit lines no longer describe an original replacement at that path.
    replaced = set(credits)
    text = '\n'.join(line for line in text.split('\n') if not (line.startswith('- `') and any(
        f'`{path}`' in line for path in replaced) and 'CC-BY-4.0' not in line))
    atomic(notices, text.encode())
    manifest['models'] = sorted(published.values(), key=lambda entry: entry['path'])
    atomic(manifest_file, (json.dumps(manifest, indent=2) + '\n').encode())


if __name__ == '__main__':
    main()
