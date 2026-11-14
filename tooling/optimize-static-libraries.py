#!/usr/bin/env python3
"""Offline static library optimization candidates (no runtime decoder).

Preserves named nodes, markers, material definitions, and retained positions/normals.
Simplifies under a 1% attribute-aware error bound. Packs UVs to UNORM16 and vertex
colors to UNORM8; no textures or UV sets are removed. Exact full-attribute duplicate
vertices are welded. Review all candidate views before publication; the size target
never overrides visual safety. Requires NumPy and pinned meshoptimizer 1.1.1.
"""
import argparse
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / 'apps/web/public-assets'
SPEC = importlib.util.spec_from_file_location('garment_buffers', ROOT / 'tooling/compact-garment-buffers.py')
BUFFERS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUFFERS)
DTYPES = {5120: 'i1', 5121: 'u1', 5122: '<i2', 5123: '<u2', 5125: '<u4', 5126: '<f4'}
ATTRIBUTES = {'COLOR_0', 'POSITION', 'NORMAL', 'TANGENT', 'TEXCOORD_0', 'TEXCOORD_1', 'JOINTS_0', 'WEIGHTS_0'}


def stored_array(document, binary, index):
    accessor = document['accessors'][index]
    return np.frombuffer(BUFFERS.accessor_bytes(document, binary, accessor),
                         dtype=DTYPES[accessor['componentType']]).reshape(accessor['count'], -1).copy()


def float_array(document, binary, index):
    accessor = document['accessors'][index]
    values = stored_array(document, binary, index).astype(np.float32)
    if accessor.get('normalized'):
        kind = accessor['componentType']
        values /= {5120: 127, 5121: 255, 5122: 32767, 5123: 65535}[kind]
        if kind in (5120, 5122):
            values = np.maximum(values, -1)
    return values


def triangle_count(document):
    return sum(document['accessors'][primitive['indices']]['count'] // 3
               for mesh in document['meshes'] for primitive in mesh['primitives'])


def validate_input(document):
    if document.get('animations') or document.get('extensions'):
        raise ValueError('Animated or document-extension inputs require explicit support')
    for mesh in document['meshes']:
        if mesh.get('extensions'):
            raise ValueError('Mesh extensions require explicit support')
        for primitive in mesh['primitives']:
            if primitive.get('targets') or primitive.get('extensions') or primitive.get('mode', 4) != 4:
                raise ValueError('Morphs, primitive extensions and non-triangle modes are not simplified')
            if 'indices' not in primitive or set(primitive['attributes']) - ATTRIBUTES:
                raise ValueError('Only indexed triangles with supported vertex attributes are simplified')
            attributes = primitive['attributes']
            count = document['accessors'][attributes['POSITION']]['count']
            if any(document['accessors'][index]['count'] != count for index in attributes.values()):
                raise ValueError('Mismatched vertex attribute counts')
            if ('JOINTS_0' in attributes) != ('WEIGHTS_0' in attributes):
                raise ValueError('Skin joints and weights must occur together')


def simplify(raw, ratio=0.1, error=0.01):
    old, binary = BUFFERS.read_glb(raw)
    validate_input(old)
    document = copy.deepcopy(old)
    output_binary = bytearray(binary)
    statistics, retained = [], []
    # Thin close-up light shades showed faceting in the visual review. Preserve
    # both complete light fixtures; their small cost is preferable to lost quality.
    protected_meshes = {node['mesh'] for node in old.get('nodes', [])
                        if 'mesh' in node and node.get('name', '').split(' / ')[0]
                        in ('floor-lamp', 'pendant-light')}

    def append(values, template):
        accessor = copy.deepcopy(template)
        accessor.pop('sparse', None)
        accessor.pop('byteOffset', None)
        values = np.ascontiguousarray(values)
        output_binary.extend(b'\0' * (-len(output_binary) % 4))
        view = len(document['bufferViews'])
        document['bufferViews'].append({'buffer': 0, 'byteOffset': len(output_binary), 'byteLength': values.nbytes})
        output_binary.extend(values.tobytes())
        accessor['bufferView'], accessor['count'] = view, len(values)
        if 'min' in accessor:
            accessor['min'] = values.min(axis=0).tolist()
        if 'max' in accessor:
            accessor['max'] = values.max(axis=0).tolist()
        index = len(document['accessors'])
        document['accessors'].append(accessor)
        return index

    with tempfile.TemporaryDirectory(prefix='garment-simplify-') as temporary:
        temporary = Path(temporary)
        for mesh_index, mesh in enumerate(document['meshes']):
            if mesh_index in protected_meshes:
                continue
            for primitive_index, primitive in enumerate(mesh['primitives']):
                attributes = primitive['attributes']
                indices = stored_array(old, binary, primitive['indices']).astype(np.uint32).ravel()
                if len(indices) % 3:
                    raise ValueError('Triangle indices must be a multiple of three')
                if len(indices) < 600:
                    continue
                position = float_array(old, binary, attributes['POSITION'])
                if int(indices.max()) >= len(position):
                    raise ValueError('Index exceeds vertex count')
                extent = float(np.ptp(position[indices], axis=0).max())
                name = old['materials'][primitive['material']].get('name', '') if 'material' in primitive else ''
                # Only named accents get the relaxed small-detail rule, never tiny cloth/skin.
                small_accent = False  # Static libraries never use the garment accent exception.
                local_error, local_ratio = (0.05, 0.01) if small_accent else (error, ratio)
                channels, weights = [], []
                for semantic, weight in [('COLOR_0', 1), ('NORMAL', 0.2), ('TEXCOORD_0', 1), ('TEXCOORD_1', 1)]:
                    if semantic in attributes:
                        channel = float_array(old, binary, attributes[semantic])
                        channels.append(channel)
                        weights.extend([weight] * channel.shape[1])
                if 'JOINTS_0' in attributes:
                    joints = stored_array(old, binary, attributes['JOINTS_0'])
                    skin_weights = float_array(old, binary, attributes['WEIGHTS_0'])
                    bones = np.unique(joints[skin_weights > 0])
                    dense = np.zeros((len(position), len(bones)), dtype=np.float32)
                    for column, bone in enumerate(bones):
                        dense[:, column] = np.sum(np.where(joints == bone, skin_weights, 0), axis=1)
                    channels.append(dense)
                    weights.extend([2] * len(bones))
                if not weights or len(weights) > 32:
                    raise ValueError('Attribute-aware simplification requires 1–32 channels')
                combined = np.concatenate(channels, axis=1).astype(np.float32)
                if not np.isfinite(position).all() or not np.isfinite(combined).all():
                    raise ValueError('Non-finite vertex values')
                job = {'indices': str(temporary / 'indices'), 'positions': str(temporary / 'positions'),
                       'attributes': str(temporary / 'attributes'), 'weights': weights,
                       'target': max(120, int(len(indices) * local_ratio) // 3 * 3),
                       'error': local_error, 'output': str(temporary / 'output')}
                indices.tofile(job['indices'])
                position.tofile(job['positions'])
                combined.tofile(job['attributes'])
                (temporary / 'job.json').write_text(json.dumps(job))
                result = json.loads(subprocess.check_output([
                    'node', str(ROOT / 'tooling/simplify-garment-meshes.mjs'), str(temporary / 'job.json')]))
                reduced = np.fromfile(job['output'], dtype='<u4')
                if len(reduced) % 3 or not len(reduced) or int(reduced.max()) >= len(position):
                    raise ValueError('Invalid simplifier output')
                if len(reduced) >= len(indices):
                    continue
                used, inverse = np.unique(reduced, return_inverse=True)
                kind = 5123 if len(used) <= 65535 else 5125
                primitive['indices'] = append(inverse.astype(DTYPES[kind]).reshape(-1, 1),
                                              {'componentType': kind, 'type': 'SCALAR', 'count': len(reduced)})
                for semantic, index in list(attributes.items()):
                    values = stored_array(old, binary, index)[used]
                    new_index = append(values, old['accessors'][index])
                    attributes[semantic] = new_index
                    retained.append((new_index, values.tobytes()))
                statistics.append({'mesh': mesh_index, 'primitive': primitive_index, 'material': name,
                                   'beforeTriangles': len(indices) // 3, 'afterTriangles': len(reduced) // 3,
                                   'relativeError': result['error'], 'smallAccent': small_accent})

    # Remove old vertex storage, but preserve the skin's inverse bind matrix accessor.
    used_accessors = set()
    for mesh in document['meshes']:
        for primitive in mesh['primitives']:
            used_accessors.update(primitive['attributes'].values())
            used_accessors.add(primitive['indices'])
    for skin in document.get('skins', []):
        if 'inverseBindMatrices' in skin:
            used_accessors.add(skin['inverseBindMatrices'])
    remap = {value: index for index, value in enumerate(sorted(used_accessors))}
    for mesh in document['meshes']:
        for primitive in mesh['primitives']:
            primitive['attributes'] = {key: remap[value] for key, value in primitive['attributes'].items()}
            primitive['indices'] = remap[primitive['indices']]
    for skin in document.get('skins', []):
        if 'inverseBindMatrices' in skin:
            skin['inverseBindMatrices'] = remap[skin['inverseBindMatrices']]
    document['accessors'] = [document['accessors'][index] for index in sorted(used_accessors)]
    document['buffers'][0]['byteLength'] = len(output_binary)
    packed, _ = BUFFERS.compact(BUFFERS.write_glb(document, bytes(output_binary)))
    candidate, candidate_binary = BUFFERS.read_glb(packed)
    for index, expected in retained:
        if BUFFERS.accessor_bytes(candidate, candidate_binary, candidate['accessors'][remap[index]]) != expected:
            raise AssertionError('Retained vertex component bytes changed')
    for key in ('asset', 'nodes', 'materials', 'textures', 'samplers', 'scenes', 'scene'):
        if old.get(key) != candidate.get(key):
            raise AssertionError(f'Authored {key} changed')
    for old_skin, new_skin in zip(old.get('skins', []), candidate.get('skins', [])):
        old_meta, new_meta = dict(old_skin), dict(new_skin)
        old_matrix, new_matrix = old_meta.pop('inverseBindMatrices', None), new_meta.pop('inverseBindMatrices', None)
        if old_meta != new_meta:
            raise AssertionError('Skeleton metadata changed')
        if old_matrix is not None and BUFFERS.accessor_bytes(old, binary, old['accessors'][old_matrix]) != BUFFERS.accessor_bytes(candidate, candidate_binary, candidate['accessors'][new_matrix]):
            raise AssertionError('Inverse bind matrix bytes changed')
    for old_image, new_image in zip(old.get('images', []), candidate.get('images', [])):
        if BUFFERS.view_bytes(old, binary, old_image['bufferView']) != BUFFERS.view_bytes(candidate, candidate_binary, new_image['bufferView']):
            raise AssertionError('Image payload changed')
    if len(packed) >= len(raw):
        return raw, {'changed': False, 'sourceBytes': len(raw), 'outputBytes': len(raw),
                     'beforeTriangles': triangle_count(old), 'afterTriangles': triangle_count(old), 'primitives': []}
    return packed, {'changed': True, 'sourceBytes': len(raw), 'outputBytes': len(packed),
                    'beforeTriangles': triangle_count(old), 'afterTriangles': triangle_count(candidate),
                    'sourceSHA256': hashlib.sha256(raw).hexdigest(), 'outputSHA256': hashlib.sha256(packed).hexdigest(),
                    'retainedVertexBytesExact': True, 'imagePayloadsExact': True, 'primitives': statistics}



def pack_static(raw):
    document, binary = BUFFERS.read_glb(raw)
    if document.get('skins') or document.get('animations'):
        raise ValueError('Static packing does not support skins or animations')
    output = bytearray(binary)
    errors, before, after = {}, 0, 0
    def append(values, template):
        accessor = copy.deepcopy(template)
        for key in ('byteOffset', 'sparse', 'min', 'max'):
            accessor.pop(key, None)
        accessor['count'] = len(values)
        accessor['bufferView'] = len(document['bufferViews'])
        output.extend(b'\0' * (-len(output) % 4))
        document['bufferViews'].append({'buffer': 0, 'byteOffset': len(output), 'byteLength': values.nbytes})
        output.extend(values.tobytes())
        index = len(document['accessors'])
        document['accessors'].append(accessor)
        return index
    for mesh in document['meshes']:
        for primitive in mesh['primitives']:
            arrays, templates = {}, {}
            for semantic, index in primitive['attributes'].items():
                values = stored_array(document, binary, index)
                template = copy.deepcopy(document['accessors'][index])
                if semantic in ('TEXCOORD_0', 'COLOR_0'):
                    decoded = float_array(document, binary, index)
                    if not np.isfinite(decoded).all() or decoded.min() < -1e-6 or decoded.max() > 1.000001:
                        raise ValueError('UV/color out of normalized packing range')
                    scale = 65535 if semantic == 'TEXCOORD_0' else 255
                    values = np.round(np.clip(decoded, 0, 1) * scale).astype('<u2' if scale == 65535 else 'u1')
                    errors[semantic] = max(errors.get(semantic, 0), float(np.abs(values.astype(float) / scale - decoded).max()))
                    template.update(componentType=5123 if scale == 65535 else 5121, normalized=True)
                arrays[semantic], templates[semantic] = values, template
            rows = np.concatenate([value.view('u1').reshape(len(value), -1) for value in arrays.values()], axis=1)
            _, take, inverse = np.unique(rows, axis=0, return_index=True, return_inverse=True)
            if len(take) == len(rows):
                take = np.arange(len(rows))
                inverse = take
            before += len(rows)
            after += len(take)
            indices = stored_array(document, binary, primitive['indices']).ravel()
            indices = inverse[indices].astype('<u2' if len(take) <= 65535 else '<u4').reshape(-1, 1)
            primitive['indices'] = append(indices, {'type': 'SCALAR', 'componentType': 5123 if len(take) <= 65535 else 5125})
            for semantic, values in arrays.items():
                primitive['attributes'][semantic] = append(values[take], templates[semantic])
                accessor = document['accessors'][primitive['attributes'][semantic]]
                if semantic == 'POSITION':
                    accessor['min'] = values[take].min(axis=0).tolist()
                    accessor['max'] = values[take].max(axis=0).tolist()
    used = sorted({index for mesh in document['meshes'] for primitive in mesh['primitives']
                   for index in [primitive['indices'], *primitive['attributes'].values()]})
    remap = {index: new for new, index in enumerate(used)}
    for mesh in document['meshes']:
        for primitive in mesh['primitives']:
            primitive['indices'] = remap[primitive['indices']]
            primitive['attributes'] = {key: remap[index] for key, index in primitive['attributes'].items()}
    document['accessors'] = [document['accessors'][index] for index in used]
    document['buffers'][0]['byteLength'] = len(output)
    packed, _ = BUFFERS.compact(BUFFERS.write_glb(document, bytes(output)))
    candidate, candidate_binary = BUFFERS.read_glb(packed)
    original, original_binary = BUFFERS.read_glb(raw)
    for old_mesh, new_mesh in zip(original['meshes'], candidate['meshes']):
        for old_primitive, new_primitive in zip(old_mesh['primitives'], new_mesh['primitives']):
            old_indices = stored_array(original, original_binary, old_primitive['indices']).ravel()
            new_indices = stored_array(candidate, candidate_binary, new_primitive['indices']).ravel()
            for semantic, index in old_primitive['attributes'].items():
                before_values = float_array(original, original_binary, index)[old_indices]
                after_values = float_array(candidate, candidate_binary, new_primitive['attributes'][semantic])[new_indices]
                tolerance = 8e-6 if semantic == 'TEXCOORD_0' else .002 if semantic == 'COLOR_0' else 0
                if before_values.shape != after_values.shape or np.max(np.abs(before_values - after_values)) > tolerance:
                    raise AssertionError(f'Packed triangle attribute changed beyond bound: {semantic}')
    return packed, {'attributeMaximumAbsoluteError': errors, 'beforeWeldVertices': before, 'afterWeldVertices': after,
                    'retainedVertexBytesExact': False, 'retainedPositionNormalBytesExact': True}

def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--only', action='append', default=[], help='asset-relative GLB path, repeatable')
    args = parser.parse_args()
    paths = [ASSETS / name for name in args.only] if args.only else [
        ASSETS / name for name in ('furniture/interior-library.glb', 'landscape/exterior-landscape.glb', 'landscape/district-buildings.glb')]
    rows = []
    for path in paths:
        relative = path.resolve().relative_to(ASSETS.resolve())
        output = args.output_dir.resolve() / relative
        if output == path.resolve():
            raise ValueError('Review output must not overwrite the source asset')
        packed, row = simplify(path.read_bytes())
        packed, packing = pack_static(packed)
        row.update(packing)
        row['outputBytes'] = len(packed)
        row['outputSHA256'] = hashlib.sha256(packed).hexdigest()
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(packed)
        row['path'] = relative.as_posix()
        rows.append(row)
        print(f'{relative}: {row["sourceBytes"]:,} -> {row["outputBytes"]:,} bytes; '
              f'{row["beforeTriangles"]:,} -> {row["afterTriangles"]:,} triangles')
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps({'schemaVersion': 1, 'meshoptimizer': '1.1.1',
                                     'review': 'candidate-needs-static-visual-review', 'files': rows}, indent=2) + '\n')


if __name__ == '__main__':
    main()
