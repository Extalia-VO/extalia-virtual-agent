"""Audit every example GLB and its fitted derivatives without granting fit approval.

python3 tooling/blender/audit-source-garments.py --source-dir <assets-temp/shirt>
    --output <local-report.json> [--corners]

Reports contain relative paths only. Material fidelity and pose review are separate:
an exact texture receipt does not certify a wearable garment.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).parent


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


P = module('garment_audit_publication', 'publish-source-garments.py')
G = P.G


def sha(data):
    return hashlib.sha256(data).hexdigest()


def audit(source_dir, corners=False):
    recipes = list(P.recipes(ROOT))
    declared = {recipe['source'] for _group, recipe in recipes}
    actual = {path.relative_to(source_dir).as_posix() for group in ('male', 'female')
              for path in (source_dir / group).glob('*.glb')}
    rows = []
    uv = module('garment_audit_uv', 'check-source-uv-fidelity.py') if corners else None
    fitted_root = ROOT / 'apps/web/local-assets/avatars/all-garment-review/fitted'
    for relative in sorted(actual | declared):
        row = {'source': relative, 'derivatives': []}
        rows.append(row)
        if relative not in actual:
            row['error'] = 'Declared source is missing'
            continue
        data, document, binary, _chunks = G._read_glb(source_dir / relative)
        row.update({'sha256': sha(data), 'bytes': len(data),
                    'materials': len(document.get('materials', [])),
                    'images': len(document.get('images', [])),
                    'imageSHA256s': sorted(sha(G._image_bytes(document, binary, image))
                                          for image in document.get('images', []))})
        if relative not in declared:
            row['error'] = 'Source has no fitting recipe'
        for group, recipe in recipes:
            if recipe['source'] != relative:
                continue
            result = {'id': recipe['id'], 'mode': recipe.get('mode', 'outfit'),
                      'existingReviewedPaths': recipe.get('existing', [])}
            row['derivatives'].append(result)
            if recipe.get('existingOnly'):
                result['status'] = 'existing-reviewed-export'
                continue
            fitted = fitted_root / group / (recipe['id'] + '.glb')
            if not fitted.is_file() or not fitted.with_suffix('.source.json').is_file():
                result['status'] = 'missing-candidate'
                continue
            try:
                receipt = json.loads(fitted.with_suffix('.source.json').read_text())
                fitted_data, fitted_doc, fitted_binary, _chunks = G._read_glb(fitted)
                fidelity = receipt['fidelity']
                if fidelity['sourceSHA256'] != row['sha256'] or fidelity['outputSHA256'] != sha(fitted_data):
                    raise ValueError('Stale source or output fidelity receipt')
                materials = P.verify_materials(fitted_doc, fitted_binary, document, binary, fidelity, recipe)
                triangles = P.geometry(fitted_doc)
                result.update({'status': 'material-fidelity-verified', 'fittedSHA256': sha(fitted_data),
                               'bytes': len(fitted_data), 'triangles': triangles,
                               'sourceTriangles': receipt['stats']['sourceTriangles'],
                               'fittedSourceTriangles': receipt['stats']['fittedSourceTriangles'],
                               'sourceMaterialGraphs': len(materials),
                               'sourceImagePayloads': len({image['sha256'] for material in materials.values()
                                                          for image in material['requiredImages']}),
                               'requiredUVSets': sorted({channel for material in materials.values()
                                                         for channel in material['requiredUVSets']}),
                               'fitReview': recipe.get('review', {'status': 'pending'})})
                if uv:
                    proof = uv.audit(source_dir / relative, fitted)
                    result['uvCorners'] = {'match': proof['match'], 'materials': [
                        {key: material[key] for key in ('sourceMaterialIndex', 'sourceTriangles',
                                                        'fittedTriangles', 'triangleCountsMatch')}
                        | {'layersMatch': all(layer['match'] for layer in material['layers'])}
                        for material in proof['materials']]}
                    result['uvCorners']['redundantDoubleSidedSourceTriangles'] = proof['redundantDoubleSidedSourceTriangles']
                    result['uvCorners']['additiveContextMaterialsExcluded'] = proof['additiveContextMaterialsExcluded']
                    detail, primary = set(), set()
                    for mesh_index, name in uv.mesh_instances(document):
                        target = detail if any(re.search(pattern, name, re.I) for pattern in recipe.get('detailObjects', [])) else primary
                        target.update(primitive.get('material') for primitive in document['meshes'][mesh_index]['primitives'])
                    exclusive_detail = detail - primary
                    primary_pass = all(material['triangleCountsMatch'] and all(layer['match'] for layer in material['layers'])
                                       for material in proof['materials'] if material['sourceMaterialIndex'] not in exclusive_detail)
                    reviewed_lod = bool(recipe.get('partLod') and exclusive_detail and primary and primary_pass
                                        and receipt['stats'].get('sourceLod', {}).get('primaryTriangles', 0) > 0
                                        and receipt['stats'].get('sourceLod', {}).get('primaryUnchanged') is True)
                    result['uvCorners']['primaryVerified'] = proof['match'] or reviewed_lod
                    result['uvCorners']['detailLODMaterials'] = sorted(exclusive_detail)
                    if not proof['match']:
                        result['uvCorners']['note'] = ('Reviewed detail LOD changes corner multiplicities; '
                            'inspect primary material results independently.' if recipe.get('partLod')
                            else 'Corner audit failed; inspect source selection and fitting output.')
            except (ValueError, KeyError, OSError) as error:
                result.update({'status': 'fidelity-error', 'error': str(error)})
    derivatives = [item for row in rows for item in row['derivatives']]
    return {'schemaVersion': 1, 'sourceCount': len(actual),
            'groups': {group: sum(path.startswith(group + '/') for path in actual) for group in ('female', 'male')},
            'missingRecipes': sorted(actual - declared), 'missingSources': sorted(declared - actual),
            'derivativeCount': len(derivatives),
            'materialVerified': sum(item['status'] == 'material-fidelity-verified' for item in derivatives),
            'existingReviewed': sum(item['status'] == 'existing-reviewed-export' for item in derivatives),
            'sources': rows}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-dir', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--corners', action='store_true')
    args = parser.parse_args()
    report = audit(args.source_dir, args.corners)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({key: value for key, value in report.items() if key != 'sources'}))
    if report['missingRecipes'] or report['missingSources'] or any(row.get('error') or any(
            item['status'] in ('missing-candidate', 'fidelity-error') or args.corners and not item.get('uvCorners', {}).get('primaryVerified', True)
            for item in row['derivatives']) for row in report['sources']):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
