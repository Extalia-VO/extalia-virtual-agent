"""Compare raw source/fitted GLB UV corner multisets, independent of mesh order.

Usage: python3 tooling/blender/check-source-uv-fidelity.py source.glb fitted.glb
       [--receipt fitted.source.json] [--output report.json] [--quantum 0.00001]

Uses only the standard library. Unbudgeted exports are expected: deliberate LOD
reduction changes corner multiplicities and must not be certified by this check.
Source-node selection/drop rules from the receipt are honored. Material mapping
comes from its fidelity receipt, never an inferred Blender material-name suffix.
"""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
import math
from pathlib import Path
import re
import struct


COMPONENTS = {5120: ('b', 1), 5121: ('B', 1), 5122: ('h', 2), 5123: ('H', 2), 5125: ('I', 4), 5126: ('f', 4)}
WIDTHS = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}


def read_glb(path):
    data = Path(path).read_bytes()
    if len(data) < 20 or struct.unpack_from('<III', data) != (0x46546C67, 2, len(data)):
        raise ValueError('Expected a complete glTF 2 GLB')
    chunks, offset = {}, 12
    while offset < len(data):
        size, kind = struct.unpack_from('<II', data, offset)
        offset += 8
        if size % 4 or offset + size > len(data) or kind in chunks:
            raise ValueError('Invalid GLB chunk layout')
        chunks[kind] = data[offset:offset + size]
        offset += size
    document = json.loads(chunks[0x4E4F534A])
    if any('uri' in buffer for buffer in document.get('buffers', [])) or len(document.get('buffers', [])) > 1:
        raise ValueError('Only embedded GLB geometry is supported')
    return document, chunks.get(0x004E4942, b''), hashlib.sha256(data).hexdigest()


def _elements(document, binary, view_index, offset, count, component, width):
    view = document['bufferViews'][view_index]
    if view.get('buffer', 0) != 0 or 'EXT_meshopt_compression' in view.get('extensions', {}):
        raise ValueError('Compressed/external accessor buffer needs decoding before audit')
    fmt, size = COMPONENTS[component]
    packed = size * width
    stride = view.get('byteStride', packed)
    if stride < packed or offset < 0 or (count and offset + (count - 1) * stride + packed > view['byteLength']):
        raise ValueError('Accessor exceeds its buffer view')
    start = view.get('byteOffset', 0) + offset
    return [struct.unpack_from('<' + fmt * width, binary, start + index * stride) for index in range(count)]


def decode_accessor(document, binary, index):
    accessor = document['accessors'][index]
    width = WIDTHS[accessor['type']]
    count, component = accessor['count'], accessor['componentType']
    if 'bufferView' in accessor:
        values = _elements(document, binary, accessor['bufferView'], accessor.get('byteOffset', 0), count, component, width)
    elif 'sparse' in accessor:
        values = [(0,) * width for _ in range(count)]
    else:
        raise ValueError('Accessor has neither storage nor sparse values')
    if 'sparse' in accessor:
        sparse = accessor['sparse']
        indices = sparse['indices']; replacements = sparse['values']
        locations = _elements(document, binary, indices['bufferView'], indices.get('byteOffset', 0), sparse['count'], indices['componentType'], 1)
        rows = _elements(document, binary, replacements['bufferView'], replacements.get('byteOffset', 0), sparse['count'], component, width)
        for location, row in zip(locations, rows):
            if not 0 <= location[0] < count:
                raise ValueError('Sparse accessor index out of bounds')
            values[location[0]] = row
    if accessor.get('normalized') and component != 5126:
        denominators = {5120: 127, 5121: 255, 5122: 32767, 5123: 65535, 5125: 4294967295}
        values = [tuple(max(-1, value / denominators[component]) for value in row) for row in values]
    return values


def mesh_instances(document):
    """Respect the active scene and repeated mesh instances, without using positions."""
    if not document.get('scenes'):
        return [(index, mesh.get('name', '')) for index, mesh in enumerate(document.get('meshes', []))]
    result = []
    def visit(index, ancestors):
        if index in ancestors:
            raise ValueError('Cyclic source node graph')
        node = document['nodes'][index]
        if 'mesh' in node:
            result.append((node['mesh'], node.get('name', document['meshes'][node['mesh']].get('name', ''))))
        for child in node.get('children', []):
            visit(child, ancestors | {index})
    for index in document['scenes'][document.get('scene', 0)].get('nodes', []):
        visit(index, set())
    return result


def _matches(patterns, value):
    return any(re.search(pattern, value, re.I) for pattern in patterns)


def collect_corners(document, binary, material_map, recipe=None, redundant=None):
    recipe = recipe or {}
    corners = defaultdict(lambda: defaultdict(list))
    triangle_counts = Counter()
    cache = {}
    def accessor(index):
        if index not in cache:
            cache[index] = decode_accessor(document, binary, index)
        return cache[index]
    for mesh_index, name in mesh_instances(document):
        if recipe.get('sourceSelection') and not _matches(recipe['sourceSelection'], name):
            continue
        if _matches(recipe.get('dropObjects', []) + recipe.get('sourceAvatar', []), name):
            continue
        for primitive in document['meshes'][mesh_index]['primitives']:
            material = primitive.get('material')
            if material not in material_map:
                continue
            if _matches(recipe.get('dropMaterials', []), document['materials'][material].get('name', '')):
                continue
            if 'KHR_draco_mesh_compression' in primitive.get('extensions', {}):
                raise ValueError('Draco geometry needs decoding before audit')
            attributes = primitive['attributes']
            indices = [row[0] for row in accessor(primitive['indices'])] if 'indices' in primitive else list(range(document['accessors'][attributes['POSITION']]['count']))
            mode = primitive.get('mode', 4)
            if mode == 4:
                if len(indices) % 3:
                    raise ValueError('Triangle index count is not divisible by three')
            elif mode in (5, 6):
                triangles = [(indices[i - 2], indices[i - 1], indices[i]) if mode == 5 else (indices[0], indices[i - 1], indices[i])
                             for i in range(2, len(indices))]
                indices = [index for triangle in triangles if len(set(triangle)) == 3 for index in triangle]
            else:
                raise ValueError('Non-triangle garment primitive cannot be audited')
            # A double-sided source sometimes repeats one triangle with opposite
            # winding and identical indexed attributes. Blender removes this
            # redundant face on import; it carries no additional visible surface.
            # Record this exception instead of treating it as missing fabric.
            if document['materials'][material].get('doubleSided') is True:
                unique, kept, removed = set(), [], 0
                for start in range(0, len(indices), 3):
                    triangle = indices[start:start + 3]
                    key = tuple(sorted(triangle))
                    if key in unique:
                        removed += 1
                    else:
                        kept.extend(triangle); unique.add(key)
                indices = kept
                if removed and redundant is not None:
                    redundant.append({'mesh': mesh_index, 'material': material, 'triangles': removed})
            source_id = material_map[material]
            triangle_counts[source_id] += len(indices) // 3
            for channel, accessor_index in attributes.items():
                if not channel.startswith('TEXCOORD_'):
                    continue
                values = accessor(accessor_index)
                if document['accessors'][accessor_index]['type'] != 'VEC2':
                    raise ValueError('UV accessor must be VEC2')
                for index in indices:
                    if not isinstance(index, int) or not 0 <= index < len(values):
                        raise ValueError('UV corner index outside accessor')
                    value = values[index]
                    if not all(math.isfinite(component) for component in value):
                        raise ValueError('Non-finite source UV')
                    corners[source_id][channel].append(value)
    return corners, triangle_counts


def quantized(values, quantum, flip_v=False):
    return Counter((round(u / quantum), round((1 - v if flip_v else v) / quantum)) for u, v in values)


def compare_counts(source, fitted):
    common = sum((source & fitted).values())
    source_count, fitted_count = sum(source.values()), sum(fitted.values())
    # Float32 import/export can cross a quantization bin boundary by much less
    # than the requested quantum. Report both strict bins and a one-bin match.
    missing, extra = source - fitted, fitted - source
    nearby = 0
    for (u, v), count in missing.items():
        for du, dv in ((-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)):
            key = (u + du, v + dv)
            take = min(count, extra[key])
            count -= take; extra[key] -= take; nearby += take
            if not count:
                break
    return {'sourceCorners': source_count, 'fittedCorners': fitted_count, 'exactQuantizedMatches': common,
            'matchesWithinOneBin': common + nearby,
            'unmatchedSourceCorners': source_count - common - nearby,
            'unmatchedFittedCorners': fitted_count - common - nearby,
            'match': source_count == fitted_count == common + nearby}


def compare_values(source, fitted, quantum, flip_v=False):
    fitted = [(u, 1 - v) for u, v in fitted] if flip_v else fitted
    result = compare_counts(quantized(source, quantum), quantized(fitted, quantum))
    delta = None
    if len(source) == len(fitted):
        pairs = list(zip(sorted(source), sorted(fitted)))
        delta = [max((abs(a[axis] - b[axis]) for a, b in pairs), default=0) for axis in (0, 1)]
    result['maxSortedCoordinateDelta'] = delta
    # Adjacent bins alone can conceal a difference approaching two quanta. A
    # PASS needs either identical bins (bounded by one quantum), or an actual
    # bijection whose coordinate differences meet the requested tolerance.
    exact_bins = result['sourceCorners'] == result['fittedCorners'] == result['exactQuantizedMatches']
    result['match'] = exact_bins or (delta is not None and max(delta) <= quantum)
    return result


def audit(source_path, fitted_path, receipt_path=None, quantum=1e-5):
    if not math.isfinite(quantum) or quantum <= 0:
        raise ValueError('UV quantum must be positive and finite')
    receipt = json.loads(Path(receipt_path or Path(fitted_path).with_suffix('.source.json')).read_text())
    bindings = receipt.get('fidelity', receipt).get('materials', {})
    if not bindings:
        raise ValueError('No source material bindings in fidelity receipt')
    source, source_bin, source_sha = read_glb(source_path)
    fitted, fitted_bin, fitted_sha = read_glb(fitted_path)
    additive = receipt.get('stats', {}).get('additiveMaterials', [])
    if additive:
        underlap = receipt.get('stats', {}).get('additiveArmholeUnderlap') or {}
        if additive != [underlap.get('material')] or not re.fullmatch(r'OriginalTop_AdditiveUnderlap_S\d+', additive[0]):
            raise ValueError('Unknown additive context cannot be excluded from source UV audit')
    output_map = {index: bindings[material['name']]['sourceMaterialIndex']
                  for index, material in enumerate(fitted.get('materials', [])) if material.get('name') in bindings
                  and material.get('name') not in additive}
    if not output_map:
        raise ValueError('No bound original materials in fitted GLB')
    source_ids = set(output_map.values())
    if any(not isinstance(index, int) or not 0 <= index < len(source.get('materials', [])) for index in source_ids):
        raise ValueError('Invalid source material index in receipt')
    redundant = []
    original, source_counts = collect_corners(source, source_bin, {index: index for index in source_ids}, receipt.get('recipe'), redundant)
    result, fitted_counts = collect_corners(fitted, fitted_bin, output_map)
    reports = []
    success = True
    for source_id in sorted(source_ids):
        layers = []
        for channel in sorted(original[source_id]):
            check = compare_values(original[source_id][channel], result[source_id].get(channel, []), quantum)
            alternatives = []
            for other in sorted(result[source_id]):
                for flip in (False, True):
                    if other == channel and not flip:
                        continue
                    alternative = compare_values(original[source_id][channel], result[source_id][other], quantum, flip)
                    alternatives.append({'fittedChannel': other, 'flipV': flip, **alternative})
            layers.append({'sourceChannel': channel, **check, 'alternatives': alternatives})
            success &= check['match']
        counts_match = source_counts[source_id] == fitted_counts[source_id] and source_counts[source_id] > 0
        success &= counts_match
        reports.append({'sourceMaterialIndex': source_id, 'sourceMaterialName': source['materials'][source_id].get('name', ''),
                        'sourceTriangles': source_counts[source_id], 'fittedTriangles': fitted_counts[source_id],
                        'triangleCountsMatch': counts_match, 'layers': layers,
                        'additionalFittedChannels': sorted(set(result[source_id]) - set(original[source_id]))})
    return {'schema': 'extalia.source-uv-fidelity.v1', 'sourceSHA256': source_sha, 'fittedSHA256': fitted_sha,
            'quantum': quantum, 'match': bool(success), 'materials': reports,
            'additiveContextMaterialsExcluded': additive,
            'redundantDoubleSidedSourceTriangles': redundant}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('fitted', type=Path)
    parser.add_argument('--receipt', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--quantum', type=float, default=1e-5)
    args = parser.parse_args()
    report = audit(args.source, args.fitted, args.receipt, args.quantum)
    encoded = json.dumps(report, indent=2) + '\n'
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded)
    else:
        print(encoded, end='')
    print('UV_FIDELITY ' + ('PASS' if report['match'] else 'FAIL') + ' ' + str(len(report['materials'])) + ' source materials')
    raise SystemExit(0 if report['match'] else 1)


if __name__ == '__main__':
    main()
