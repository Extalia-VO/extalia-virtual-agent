"""Promote hash-bound, pose-reviewed original garments; never infer review approval.

python3 tooling/blender/publish-source-garments.py --source-dir <assets-temp/shirt> --dry-run
python3 tooling/blender/publish-source-garments.py --source-dir <assets-temp/shirt> --ids male/denim-jacket

A recipe review requires status=passed, fittedSHA256, explicit triangles/bytes budgets,
and true rest/walk/sit/reach/sourceAppearance fitChecks. Public CC-BY promotion additionally
requires publish=true. Approved Standard and held CC-BY assets stay local with publish=false. No candidate,
registry, notice or manifest is written by a dry run; temporary validation files are removed.

There is one receipt per promoted path, not per downloaded source: selected pack variants
are separate records; existingOnly routes stay with their existing exporter. The generic
public manifest excludes local-only records and previously registered original exports.
Raw primary UV corners and source triangle counts must match. The sole detail exception
is the explicit Flame hoodie stitch LOD; its primary cloth and native maps remain exact.
"""
from copy import deepcopy
import argparse
import hashlib
import importlib.util
import json
import math
from pathlib import Path, PurePosixPath
import re
import tempfile
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[2]
EXPORTER = 'tooling/blender/fit-source-garments.py'
START, END = '<!-- source-garments:start -->', '<!-- source-garments:end -->'
CHECKS = ('rest', 'walk', 'sit', 'reach', 'sourceAppearance')
SHA = re.compile(r'^[0-9a-f]{64}$')
SLUG = re.compile(r'^[a-z0-9]+(?:-[a-z0-9]+)*$')
PRIVATE = re.compile(r'(?:/Users/|/home/|[A-Za-z]:\\Users\\)')
BONES = {'root', 'hips', 'spine', 'chest', 'neck', 'head', 'leftShoulder', 'leftUpperArm',
         'leftLowerArm', 'leftHand', 'rightShoulder', 'rightUpperArm', 'rightLowerArm',
         'rightHand', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg',
         'rightLowerLeg', 'rightFoot'}


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


G = module('source_publication_materials', 'original-gltf-materials.py')
PUBLIC = module('source_publication_sanitizer', 'prepare-public-models.py')
UV = module('source_publication_uv_corners', 'check-source-uv-fidelity.py')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, indent=2, ensure_ascii=True) + '\n').encode()


def atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(prefix='.' + path.name + '.', dir=path.parent, delete=False) as file:
            temporary = Path(file.name)
            file.write(data)
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def regular(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError('Expected a regular asset file: ' + path.name)
    return path


def contained(base, relative):
    value = PurePosixPath(relative)
    if value.is_absolute() or '..' in value.parts or '\\' in relative or not value.parts:
        raise ValueError('Asset paths must be relative and contained')
    path = base.joinpath(*value.parts)
    if not path.resolve().is_relative_to(base.resolve()):
        raise ValueError('Asset path leaves its declared directory')
    return path


def recipes(root):
    seen = set()
    for group in ('female', 'male'):
        path = root / f'tooling/blender/source-garments-{group}.json'
        data = json.loads(regular(path).read_text())
        if data.get('schemaVersion') != 1 or data.get('group') != group:
            raise ValueError('Unexpected source garment recipe schema')
        for entry in data['entries']:
            variants = entry.get('variants')
            for variant in variants if variants else [None]:
                recipe = {**entry, **variant, 'variants': None} if variant is not None else dict(entry)
                key = group + '/' + recipe['id']
                if not SLUG.fullmatch(recipe['id']) or key in seen:
                    raise ValueError('Invalid or duplicate garment id: ' + key)
                if recipe.get('mode', 'outfit') not in ('outfit', 'top', 'bottom', 'outer'):
                    raise ValueError('Invalid source garment mode: ' + key)
                source = PurePosixPath(recipe['source'])
                if source.parts[0] != group or source.suffix.lower() != '.glb':
                    raise ValueError('Source group or format does not match recipe')
                seen.add(key)
                yield group, recipe


def approval(recipe, fitted_sha):
    review = recipe.get('review')
    if not isinstance(review, dict) or review.get('status') != 'passed':
        raise ValueError('No passed recipe review')
    approved_sha = review.get('fittedSHA256', '')
    if not SHA.fullmatch(approved_sha) or approved_sha != fitted_sha:
        raise ValueError('Review is stale: fittedSHA256 does not match candidate')
    checks = review.get('fitChecks', {})
    if (not isinstance(checks, dict) or any(checks.get(key) is not True for key in CHECKS)
            or any(not isinstance(key, str) or value is not True for key, value in checks.items())):
        raise ValueError('All required fitChecks must explicitly pass')
    budgets = review.get('budgets', {})
    if not isinstance(budgets, dict) or any(type(budgets.get(key)) is not int or budgets[key] <= 0
                                           for key in ('triangles', 'bytes')):
        raise ValueError('Review needs positive triangles and bytes budgets')
    return {'status': 'passed', 'fittedSHA256': approved_sha,
            'budgets': {key: budgets[key] for key in ('triangles', 'bytes')},
            'fitChecks': {key: checks[key] for key in CHECKS}}


def credit(document):
    source = document.get('asset', {}).get('extras', {})
    result = {key: source.get(key) for key in ('title', 'author', 'source', 'license')}
    if any(not isinstance(value, str) or not value.strip() or '\n' in value or '\r' in value
           or PRIVATE.search(value) for value in result.values()):
        raise ValueError('Missing or unsafe public source attribution')
    url = urlsplit(result['source'])
    if url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password:
        raise ValueError('Source credit needs a public attribution URL')
    if result['license'].startswith('CC-BY-4.0'):
        license_id = 'CC-BY-4.0'
    elif result['license'].upper().startswith('SKETCHFAB STANDARD'):
        license_id = 'LicenseRef-Sketchfab-Standard'
    else:
        raise ValueError('Source license is neither CC-BY-4.0 nor Sketchfab Standard')
    return result, license_id


def geometry(document):
    skins = document.get('skins', [])
    if len(document.get('meshes', [])) != 1 or len(skins) != 1 or len(skins[0]['joints']) != 20:
        raise ValueError('Expected one garment mesh and the canonical 20-joint skin')
    if {document['nodes'][index].get('name') for index in skins[0]['joints']} != BONES:
        raise ValueError('Garment does not use the canonical avatar bones')
    triangles = 0
    for mesh in document['meshes']:
        for primitive in mesh.get('primitives', []):
            if primitive.get('mode', 4) != 4:
                raise ValueError('Only triangle garment primitives are supported')
            position = G._at(document.get('accessors', []), primitive.get('attributes', {}).get('POSITION'), 'POSITION')
            count = G._at(document['accessors'], primitive['indices'], 'indices')['count'] if 'indices' in primitive else position['count']
            if count <= 0 or count % 3:
                raise ValueError('Invalid garment triangle count')
            triangles += count // 3
    if not triangles:
        raise ValueError('Garment has no triangles')
    return triangles


def verify_skin(document, binary):
    """The runtime consumes exactly four finite normalized influences per vertex."""
    for mesh in document['meshes']:
        for primitive in mesh.get('primitives', []):
            attrs = primitive.get('attributes', {})
            if any(key.startswith(('JOINTS_', 'WEIGHTS_')) and key not in ('JOINTS_0', 'WEIGHTS_0') for key in attrs):
                raise ValueError('Source garment exceeds the four-influence runtime skin format')
            position = G._at(document['accessors'], attrs.get('POSITION'), 'POSITION')
            for key in ('JOINTS_0', 'WEIGHTS_0'):
                accessor = G._at(document['accessors'], attrs.get(key), key)
                if accessor.get('type') != 'VEC4' or accessor.get('count') != position.get('count'):
                    raise ValueError('Garment skin attributes must be four-component and match POSITION')
            joints = UV.decode_accessor(document, binary, attrs['JOINTS_0'])
            weights = UV.decode_accessor(document, binary, attrs['WEIGHTS_0'])
            for js, ws in zip(joints, weights):
                if (any(not math.isfinite(value) or value < 0 for value in ws)
                        or abs(sum(ws) - 1) > 1e-5
                        or any(not math.isfinite(value) or value != int(value) or not 0 <= value < 20 for value in js)):
                    raise ValueError('Garment skin weights/joints are not finite, normalized canonical influences')


def verify_source_corners(source_path, fitted, sidecar, recipe):
    """Require raw source fidelity; a reviewed SHA cannot excuse altered fabric UVs."""
    proof = UV.audit(source_path, fitted, fitted.with_suffix('.source.json'))
    if proof['match']:
        return {'primaryExact': True, 'detailLOD': False}
    # Only this audited source has an explicit stitch-only detail budget. Its
    # detail material is disjoint from all primary fabric materials, so a full
    # corner audit still verifies every source fabric surface independently.
    if (recipe.get('id') != 'source-flame-hoodie'
            or recipe.get('source') != 'female/classic_black_flame_hoodie.glb'
            or recipe.get('partLod') != [['stitch', 10000]] or recipe.get('detailObjects') != ['stitch']):
        raise ValueError('Original primary triangle counts or UV corners changed')
    source, _binary, _sha = UV.read_glb(source_path)
    primary, detail = set(), set()
    for mesh_index, name in UV.mesh_instances(source):
        destination = detail if re.search('stitch', name, re.I) else primary
        destination.update(primitive.get('material') for primitive in source['meshes'][mesh_index]['primitives'])
    reports = {item['sourceMaterialIndex']: item for item in proof['materials']}
    if not primary or not detail or primary & detail or set(reports) != primary | detail:
        raise ValueError('Stitch LOD must retain disjoint primary and detail source materials')
    for index in primary:
        report = reports[index]
        if not report['triangleCountsMatch'] or any(not layer['match'] for layer in report['layers']):
            raise ValueError('Stitch LOD altered primary fabric topology or UV corners')
    lod = sidecar.get('stats', {}).get('sourceLod', {})
    parts = lod.get('parts', [])
    if (lod.get('primaryUnchanged') is not True or not parts
            or len(parts) != len(UV.mesh_instances(source))):
        raise ValueError('Missing complete per-part stitch LOD provenance')
    for part in parts:
        is_detail = bool(re.search('stitch', part.get('object', ''), re.I))
        before, after = part.get('trianglesBefore'), part.get('trianglesAfter')
        if (part.get('detail') is not is_detail or type(before) is not int or type(after) is not int
                or not 0 < after <= before
                or (is_detail and (part.get('target') != 10000 or after > 10200))
                or (not is_detail and (part.get('target') is not None or before != after))):
            raise ValueError('Invalid or destructive stitch-only LOD provenance')
    if (sum(part['trianglesBefore'] for part in parts) != sum(row['sourceTriangles'] for row in reports.values())
            or sum(part['trianglesAfter'] for part in parts) != sum(row['fittedTriangles'] for row in reports.values())
            or lod.get('primaryTriangles') != sum(reports[index]['sourceTriangles'] for index in primary)
            or any(reports[index]['fittedTriangles'] <= 0 for index in detail)):
        raise ValueError('Stitch LOD part receipts do not match actual raw/fitted geometry')
    return {'primaryExact': True, 'detailLOD': True}


def verify_materials(document, binary, source, source_binary, fidelity, recipe):
    declared = fidelity.get('materials', {})
    if not isinstance(declared, dict) or not declared:
        raise ValueError('Missing original-material fidelity receipts')
    uses = {}
    for mesh in document.get('meshes', []):
        for primitive in mesh.get('primitives', []):
            material = G._at(document.get('materials', []), primitive.get('material'), 'material')
            name = material.get('name', '')
            if name.startswith('Original'):
                uses.setdefault(name, []).append(primitive)
    if set(uses) != set(declared):
        raise ValueError('Used original materials and fidelity receipts do not match')
    result = {}
    for name, receipt in declared.items():
        index = receipt.get('sourceMaterialIndex')
        original = deepcopy(G._at(source.get('materials', []), index, 'source material'))
        expected_override = {'alphaMode': 'OPAQUE'} if index in recipe.get('opaqueMaterials', []) else {}
        if receipt.get('overrides', {}) != expected_override:
            raise ValueError('Unapproved or stale material appearance override: ' + name)
        original.update(expected_override)
        expected = G._material_receipt(source, source_binary, original)
        if {key: receipt.get(key) for key in expected} != expected:
            raise ValueError('Fidelity receipt does not match current source: ' + name)
        materials = [material for material in document['materials'] if material.get('name') == name]
        if len(materials) != 1 or G._material_receipt(document, binary, materials[0]) != expected:
            raise ValueError('Original material graph or image payload changed: ' + name)
        if receipt.get('alphaMode') != materials[0].get('alphaMode', 'OPAQUE'):
            raise ValueError('Material alpha mode does not match its receipt: ' + name)
        for primitive in uses[name]:
            attrs = primitive.get('attributes', {})
            position = G._at(document['accessors'], attrs.get('POSITION'), 'POSITION')
            for uv in expected['requiredUVSets']:
                accessor = G._at(document['accessors'], attrs.get('TEXCOORD_' + str(uv)), 'required UV')
                if accessor.get('type') != 'VEC2' or accessor.get('count') != position.get('count'):
                    raise ValueError('Required texture coordinates are missing or incompatible: ' + name)
        result[name] = {'sourceMaterialIndex': index, **expected, 'overrides': expected_override}
    return result


def prepare(root, source_dir, stage, group, recipe):
    key = group + '/' + recipe['id']
    local = root / 'apps/web/local-assets/avatars'
    fitted = regular(local / 'all-garment-review/fitted' / group / (recipe['id'] + '.glb'))
    sidecar = json.loads(regular(fitted.with_suffix('.source.json')).read_text())
    if any(sidecar.get(field) != value for field, value in
           (('id', recipe['id']), ('group', group), ('source', recipe['source']), ('mode', recipe.get('mode', 'outfit')))):
        raise ValueError('Sidecar identity does not match recipe: ' + key)
    data, document, binary, _chunks = G._read_glb(fitted)
    fitted_sha = sha(data)
    review = approval(recipe, fitted_sha)
    fidelity = sidecar.get('fidelity', {})
    if fidelity.get('schema') != 'extalia.original-material-fidelity.v1' or fidelity.get('outputSHA256') != fitted_sha:
        raise ValueError('Sidecar output hash does not match candidate: ' + key)
    source_path = regular(contained(source_dir, recipe['source']))
    source_data, source, source_binary, _chunks = G._read_glb(source_path)
    source_sha = sha(source_data)
    if fidelity.get('sourceSHA256') != source_sha:
        raise ValueError('Current source hash does not match fitted receipt: ' + key)
    attribution, license_id = credit(source)
    triangles = geometry(document)
    verify_skin(document, binary)
    if sidecar.get('stats', {}).get('triangles') != triangles:
        raise ValueError('Sidecar triangle count does not match candidate: ' + key)
    materials = verify_materials(document, binary, source, source_binary, fidelity, recipe)
    corners = verify_source_corners(source_path, fitted, sidecar, recipe)
    mode = recipe.get('mode', 'outfit')
    relative = (f'avatars/outfits/{group}/outfit-{recipe["id"]}.glb' if mode == 'outfit'
                else f'avatars/wardrobe/{group}/{mode}/{recipe["id"]}.glb')
    public = recipe.get('publish') is True and license_id == 'CC-BY-4.0'
    if license_id != 'CC-BY-4.0' and recipe.get('publish') is True:
        raise ValueError('Standard assets require publish=false and remain local-only')
    author = attribution['author'].split(' (http', 1)[0]
    copyright = (f'Based on "{attribution["title"]}" by {author}; source garment: {license_id}. '
                 'Modified: body-specific fitting, skeletal binding and garment separation; original UVs and native maps retained. '
                 'Reference avatar rig and any added skin/context retain the RenderHub Extended Use License. '
                 'See THIRD_PARTY_NOTICES.md.' if public else
                 f'Based on "{attribution["title"]}" by {author}; source garment: {license_id}. '
                 'Body-specific fitting and skeletal binding; original UVs and native maps retained. '
                 'Reference avatar rig and any added skin/context retain the RenderHub Extended Use License. '
                 'See reviewed-source-garments.json for original attribution. Local-only asset.')
    if corners['detailLOD']:
        copyright += ' Modeled stitching uses an explicit reviewed detail LOD; primary fabric geometry and UV corners remain unchanged.'
    sanitized = PUBLIC.public_glb(fitted, copyright, sanitize_original=True)
    staged = stage / (group + '--' + recipe['id'] + '.glb')
    staged.write_bytes(sanitized)
    public_data, public_doc, public_binary, _chunks = G._read_glb(staged)
    verify_skin(public_doc, public_binary)
    after = verify_materials(public_doc, public_binary, source, source_binary, fidelity, recipe)
    if after != materials or geometry(public_doc) != triangles or public_binary != binary:
        raise ValueError('Sanitizer changed garment geometry or material fidelity: ' + key)
    budgets = review['budgets']
    if triangles > budgets['triangles'] or max(len(data), len(public_data)) > budgets['bytes']:
        raise ValueError('Reviewed per-asset triangle or byte budget exceeded: ' + key)
    images = sorted({item['sha256'] for value in materials.values() for item in value['requiredImages']})
    record = {'path': relative, 'id': recipe['id'], 'group': group, 'mode': mode,
              'source': {'path': recipe['source'], 'sha256': source_sha}, 'fittedSHA256': fitted_sha,
              'sha256': sha(public_data), 'triangles': triangles, 'bytes': len(public_data),
              'budgets': budgets, 'fitChecks': review['fitChecks'], 'materials': materials,
              'materialGraphSHA256': sha(G._canonical({name: value['graphSHA256'] for name, value in materials.items()})),
              'imageSHA256s': images, 'license': license_id,
              'attribution': attribution,
              'componentLicenses': {'sourceGarment': license_id, 'referenceAvatarRigAndContext': 'LicenseRef-RenderHub-Extended-Use'}}
    if PRIVATE.search(json.dumps(record)):
        raise ValueError('Private authoring path in publication record')
    destination = root / 'apps/web/public-assets' if public else local
    destination_relative = relative if public else relative.removeprefix('avatars/')
    return {'record': record, 'public': public, 'stage': staged, 'credit': attribution, 'sourceCorners': corners,
            'sourcePath': source_path, 'fittedPath': fitted,
            'target': contained(destination, destination_relative)}


def merge_records(path, records):
    data = json.loads(regular(path).read_text()) if path.exists() else {'schemaVersion': 1, 'exporter': EXPORTER, 'garments': []}
    if data.get('schemaVersion') != 1 or data.get('exporter') != EXPORTER:
        raise ValueError('Unexpected reviewed source garment manifest')
    previous = {entry['path']: entry for entry in data['garments']}
    previous.update({entry['path']: entry for entry in records})
    return {**data, 'garments': [previous[key] for key in sorted(previous)]}


def notices(text, credits, detail_lods=()):
    lines, detail_lines = {}, {}
    if (START in text) != (END in text) or text.count(START) > 1 or text.count(END) > 1:
        raise ValueError('Malformed source garment notice markers')
    if START in text:
        old = text.split(START, 1)[1].split(END, 1)[0]
        lines = {line.split('`')[1]: line for line in old.splitlines() if line.startswith('- `')}
        detail_lines = {line.split('`')[1]: line for line in old.splitlines() if line.startswith('Detail LOD for `')}
    for relative, item in credits.items():
        lines[relative] = (f'- `{relative}` (CC-BY-4.0): "{item["title"]}" by {item["author"]}; {item["source"]}. '
                           'Modified: body fit, skeletal binding and garment separation; native UVs and material maps retained.')
        detail_lines.pop(relative, None)
        if relative in detail_lods:
            detail_lines[relative] = (f'Detail LOD for `{relative}`: modeled stitch meshes use an explicit reviewed reduction; '
                                      'primary fabric geometry and UV corners remain unchanged.')
    block = '\n'.join([START, '## Reviewed source avatar garments', '',
        'Original garment geometry, fabric motifs, textures and native material maps are retained.',
        'The source garments listed below are CC-BY-4.0; attribution and source URLs are per asset.',
        'CC-BY-4.0 terms: https://creativecommons.org/licenses/by/4.0/.',
        'The reference avatar rig and any added skin/context retain the separate RenderHub Extended Use License',
        '(https://www.renderhub.com/info/3d-content-licensing); those components are not relicensed as CC-BY or MIT.',
        '', *[lines[key] for key in sorted(lines)], '', *[detail_lines[key] for key in sorted(detail_lines)], '', END])
    if START in text:
        before, tail = text.split(START, 1)
        return before + block + tail.split(END, 1)[1]
    return text.rstrip('\n') + '\n\n' + block + '\n'


def publish(source_dir, ids=None, dry_run=False, root=ROOT):
    source_dir = Path(source_dir)
    if not source_dir.is_dir():
        raise ValueError('The declared source directory does not exist')
    rows = list(recipes(root))
    known = {recipe['id'] for _group, recipe in rows} | {group + '/' + recipe['id'] for group, recipe in rows}
    if ids and set(ids) - known:
        raise ValueError('Unknown source garment ids: ' + ', '.join(sorted(set(ids) - known)))
    selected = [(group, recipe) for group, recipe in rows
                if not ids or recipe['id'] in ids or group + '/' + recipe['id'] in ids]
    with tempfile.TemporaryDirectory(prefix='extalia-source-publish-') as directory:
        plans = [prepare(root, source_dir, Path(directory), group, recipe) for group, recipe in selected
                 if not recipe.get('existingOnly') and isinstance(recipe.get('review'), dict)
                 and recipe['review'].get('status') == 'passed']
        summary = {'approved': len(plans), 'public': sum(item['public'] for item in plans),
                   'localOnly': sum(not item['public'] for item in plans), 'skipped': len(selected) - len(plans),
                   'dryRun': dry_run, 'assets': [item['record']['path'] for item in plans]}
        if not plans:
            return {**summary, 'writes': 0}
        public_root = root / 'apps/web/public-assets'
        local = root / 'apps/web/local-assets/avatars'
        public_plans = [item for item in plans if item['public']]
        local_plans = [item for item in plans if not item['public']]
        public_file = public_root / 'source-garments.json'
        local_file = local / 'reviewed-source-garments.json'
        public_records = merge_records(public_file, [item['record'] for item in public_plans]) if public_plans else None
        local_records = merge_records(local_file, [{**item['record'], 'localOnly': True, 'attribution': item['credit']}
                                                  for item in local_plans]) if local_plans else None
        outputs = {item['target']: item['stage'] for item in plans}
        if public_plans:
            manifest_path = public_root / 'models.json'
            manifest = json.loads(regular(manifest_path).read_text())
            entries = {entry['path']: entry for entry in manifest['models']}
            for item in public_plans:
                record, relative = item['record'], item['record']['path']
                previous = entries.get(relative)
                if previous and previous.get('provenance', {}).get('exporter') != EXPORTER:
                    raise ValueError('Refusing to replace another exporter\'s registered asset: ' + relative)
                entries[relative] = {'path': relative, 'sha256': record['sha256'], 'bytes': record['bytes'],
                    'license': 'CC-BY-4.0', 'provenance': {'kind': 'third-party-derived', 'exporter': EXPORTER,
                    'note': ('Primary fabric geometry/UVs retained; explicit reviewed modeled-stitch detail LOD; native material maps retained. '
                             if item['sourceCorners']['detailLOD'] else
                             'Original garment geometry, UVs and native material maps retained; reviewed body fit and binding. ') +
                            'Source garment: CC-BY-4.0. Reference avatar rig and any added skin/context: RenderHub Extended Use License.'}}
            outputs[manifest_path] = encoded({**manifest, 'models': sorted(entries.values(), key=lambda entry: entry['path'])})
            notice_path = public_root / 'THIRD_PARTY_NOTICES.md'
            text = regular(notice_path).read_text()
            outputs[notice_path] = notices(text, {item['record']['path']: item['credit'] for item in public_plans},
                {item['record']['path'] for item in public_plans if item['sourceCorners']['detailLOD']}).encode()
            outputs[public_file] = encoded(public_records)
        if local_records is not None:
            outputs[local_file] = encoded(local_records)
        owned_public = {entry['path'] for entry in json.loads(public_file.read_text()).get('garments', [])} if public_file.exists() else set()
        owned_local = {entry['path'] for entry in json.loads(local_file.read_text()).get('garments', [])} if local_file.exists() else set()
        for item in plans:
            record = item['record']
            if sha(regular(item['sourcePath']).read_bytes()) != record['source']['sha256'] or sha(regular(item['fittedPath']).read_bytes()) != record['fittedSHA256']:
                raise ValueError('Source or fitted input changed during publication preflight')
            target = item['target']
            owned = owned_public if item['public'] else owned_local
            if target.is_symlink() or (target.exists() and record['path'] not in owned and sha(target.read_bytes()) != record['sha256']):
                raise ValueError('Refusing to overwrite an unowned asset: ' + record['path'])
        if dry_run:
            return {**summary, 'writes': 0}
        for path, data in outputs.items():
            atomic(path, data.read_bytes() if isinstance(data, Path) else data)
        return {**summary, 'writes': len(outputs)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-dir', required=True, type=Path)
    parser.add_argument('--ids', help='Comma-separated ids, optionally qualified as male/id or female/id')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    ids = [value.strip() for value in args.ids.split(',')] if args.ids else None
    if ids and any(not value for value in ids):
        parser.error('--ids cannot contain empty ids')
    try:
        print(json.dumps(publish(args.source_dir, ids, args.dry_run), sort_keys=True))
    except (ValueError, KeyError, TypeError, OSError) as error:
        parser.exit(1, 'Source garment publication rejected: ' + str(error) + '\n')


if __name__ == '__main__':
    main()
