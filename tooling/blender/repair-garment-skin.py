"""Restore damaged skin context from an earlier export without replacing fitted cloth.

Dry run: python3 tooling/blender/repair-garment-skin.py --source original.glb --target fitted.glb --audit
Apply after review: add --write. Originals must have identical skin topology and accessor formats.
Only Skin_* POSITION/NORMAL/JOINTS_0/WEIGHTS_0 and their morph deltas may change.
"""
import argparse
import hashlib
import json
import math
import pathlib
import struct


COMPONENTS = {5120: ('b', 1), 5121: ('B', 1), 5122: ('h', 2), 5123: ('H', 2), 5125: ('I', 4), 5126: ('f', 4)}
WIDTHS = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT2': 4, 'MAT3': 9, 'MAT4': 16}
RESTORED = {'POSITION', 'NORMAL', 'JOINTS_0', 'WEIGHTS_0'}
MORPH = {'POSITION', 'NORMAL', 'TANGENT'}


def require(condition, message):
    if not condition:
        raise ValueError(message)


class Glb:
    def __init__(self, path):
        self.path = pathlib.Path(path)
        self.raw = self.path.read_bytes()
        require(len(self.raw) >= 20, 'truncated GLB')
        require(struct.unpack_from('<III', self.raw) == (0x46546c67, 2, len(self.raw)), 'invalid GLB header')
        self.chunks = []
        offset = 12
        while offset < len(self.raw):
            require(offset + 8 <= len(self.raw), 'truncated chunk header')
            length, kind = struct.unpack_from('<II', self.raw, offset)
            require(length % 4 == 0 and offset + 8 + length <= len(self.raw), 'invalid chunk length')
            self.chunks.append((kind, self.raw[offset + 8:offset + 8 + length]))
            offset += 8 + length
        require(len(self.chunks) >= 2 and self.chunks[0][0] == 0x4e4f534a and self.chunks[1][0] == 0x004e4942, 'expected JSON and BIN chunks')
        self.doc = json.loads(self.chunks[0][1])
        require(len(self.doc.get('buffers', [])) == 1 and 'uri' not in self.doc['buffers'][0], 'requires one embedded buffer')
        self.binary = bytearray(self.chunks[1][1])

    def layout(self, index):
        accessor = self.doc['accessors'][index]
        require('bufferView' in accessor, 'accessor has no dense storage')
        view = self.doc['bufferViews'][accessor['bufferView']]
        require(view.get('buffer', 0) == 0, 'external accessor buffer')
        component, size = COMPONENTS[accessor['componentType']]
        width = WIDTHS[accessor['type']]
        require(accessor['type'] not in ('MAT2', 'MAT3') or size == 4, 'padded matrix accessor is unsupported')
        row = width * size
        stride = view.get('byteStride', row)
        start = view.get('byteOffset', 0) + accessor.get('byteOffset', 0)
        count = accessor['count']
        require(isinstance(count, int) and count >= 0 and stride >= row, 'invalid accessor dimensions')
        end = start + (count - 1) * stride + row if count else start
        require(0 <= start <= end <= len(self.binary), 'accessor leaves embedded buffer')
        require(end <= view.get('byteOffset', 0) + view['byteLength'], 'accessor leaves buffer view')
        return accessor, start, stride, row, count, component, width

    def sparse_layout(self, index):
        accessor = self.doc['accessors'][index]
        sparse = accessor['sparse']
        count = sparse['count']
        require(isinstance(count, int) and 0 <= count <= accessor['count'], 'invalid sparse count')
        index_type = sparse['indices']['componentType']
        require(index_type in (5121, 5123, 5125), 'invalid sparse index type')
        component, size = COMPONENTS[index_type]
        width = WIDTHS[accessor['type']] * COMPONENTS[accessor['componentType']][1]

        def span(entry, row):
            view = self.doc['bufferViews'][entry['bufferView']]
            require(view.get('buffer', 0) == 0 and 'byteStride' not in view, 'invalid sparse buffer view')
            start = view.get('byteOffset', 0) + entry.get('byteOffset', 0)
            end = start + count * row
            require(0 <= start <= end <= len(self.binary), 'sparse storage leaves embedded buffer')
            require(end <= view.get('byteOffset', 0) + view['byteLength'], 'sparse storage leaves buffer view')
            return start, end

        indices = span(sparse['indices'], size)
        values = span(sparse['values'], width)
        return count, component, size, width, indices, values

    def storage_ranges(self, index):
        accessor = self.doc['accessors'][index]
        ranges = []
        if 'bufferView' in accessor:
            _, start, stride, row, count, _, _ = self.layout(index)
            ranges.append((start, start + (count - 1) * stride + row if count else start))
        if 'sparse' in accessor:
            _, _, _, _, indices, values = self.sparse_layout(index)
            ranges.extend([indices, values])
        return ranges

    def rows(self, index):
        accessor = self.doc['accessors'][index]
        if 'bufferView' in accessor:
            _, start, stride, row, count, _, _ = self.layout(index)
            rows = [bytes(self.binary[start + vertex * stride:start + vertex * stride + row]) for vertex in range(count)]
        else:
            row = WIDTHS[accessor['type']] * COMPONENTS[accessor['componentType']][1]
            rows = [bytes(row) for _ in range(accessor['count'])]
        if 'sparse' in accessor:
            count, component, size, row, indices, values = self.sparse_layout(index)
            previous = -1
            for vertex in range(count):
                destination = struct.unpack_from('<' + component, self.binary, indices[0] + vertex * size)[0]
                require(previous < destination < len(rows), 'sparse indices must be unique, sorted and in range')
                previous = destination
                start = values[0] + vertex * row
                rows[destination] = bytes(self.binary[start:start + row])
        return rows

    def values(self, index):
        accessor = self.doc['accessors'][index]
        component = COMPONENTS[accessor['componentType']][0]
        width = WIDTHS[accessor['type']]
        result = [list(struct.unpack('<' + component * width, row)) for row in self.rows(index)]
        if accessor.get('normalized') and accessor['componentType'] != 5126:
            maximum = {5120: 127, 5121: 255, 5122: 32767, 5123: 65535, 5125: 4294967295}[accessor['componentType']]
            result = [[max(-1, value / maximum) for value in row] for row in result]
        return result

    def skin(self):
        primitives = []
        for mesh in self.doc.get('meshes', []):
            for primitive in mesh.get('primitives', []):
                material = self.doc['materials'][primitive['material']].get('name', '') if 'material' in primitive else ''
                if material.startswith('Skin_'):
                    primitives.append((material, primitive))
        return primitives

    def encoded(self):
        document = json.dumps(self.doc, separators=(',', ':'), ensure_ascii=True).encode()
        document += b' ' * (-len(document) % 4)
        chunks = [(0x4e4f534a, document), (0x004e4942, bytes(self.binary)), *self.chunks[2:]]
        body = b''.join(struct.pack('<II', len(data), kind) + data for kind, data in chunks)
        return struct.pack('<III', 0x46546c67, 2, 12 + len(body)) + body


def skin_metrics(source, target, original, current):
    positions = source.values(original['attributes']['POSITION'])
    changed_positions = target.values(current['attributes']['POSITION'])
    joints = source.values(original['attributes']['JOINTS_0'])
    weights = source.values(original['attributes']['WEIGHTS_0'])
    next_joints = target.values(current['attributes']['JOINTS_0'])
    next_weights = target.values(current['attributes']['WEIGHTS_0'])
    require(len(source.doc.get('skins', [])) == 1 and len(target.doc.get('skins', [])) == 1, 'requires one canonical skin')
    names = [source.doc['nodes'][joint].get('name', '') for joint in source.doc['skins'][0]['joints']]
    next_names = [target.doc['nodes'][joint].get('name', '') for joint in target.doc['skins'][0]['joints']]
    require(names == next_names, 'joint names/order changed')

    def arm_share(js, ws):
        return sum(weight for joint, weight in zip(js, ws) if 'Arm' in names[int(joint)] or 'Hand' in names[int(joint)])

    leaks = 0
    for point, js, ws, next_js, next_ws in zip(positions, joints, weights, next_joints, next_weights):
        if abs(point[0]) < .23 and .9 < point[1] < 1.4 and arm_share(js, ws) < .1 and arm_share(next_js, next_ws) > .25:
            leaks += 1
    return {
        'vertices': len(positions),
        'changedPositions': sum(a != b for a, b in zip(positions, changed_positions)),
        'changedJointRows': sum(a != b for a, b in zip(joints, next_joints)),
        'changedWeightRows': sum(a != b for a, b in zip(weights, next_weights)),
        'newTorsoArmLeaks': leaks,
        'maximumPositionShift': max((math.dist(a, b) for a, b in zip(positions, changed_positions)), default=0),
    }


def repair(source, target):
    originals, currents = source.skin(), target.skin()
    require(len(originals) == len(currents) and originals, 'skin primitive count differs or no skin exists')
    replacements = {}
    metrics = []

    def plan(old_index, new_index):
        old = source.doc['accessors'][old_index]
        new = target.doc['accessors'][new_index]
        require(all(old.get(key, False) == new.get(key, False) for key in ('componentType', 'type', 'count', 'normalized')), 'accessor format/count changed')
        rows = source.rows(old_index)
        if new_index in replacements:
            require(replacements[new_index][0] == rows, 'conflicting shared skin accessor')
        replacements[new_index] = (rows, old)

    for (old_name, old), (new_name, new) in zip(originals, currents):
        require(old_name == new_name, 'skin primitive material/order changed')
        require(old.get('mode', 4) == new.get('mode', 4) == 4, 'skin must be triangles')
        require(('indices' in old) == ('indices' in new), 'skin index topology changed')
        if 'indices' in old:
            require(source.values(old['indices']) == target.values(new['indices']), 'skin triangle indices changed')
        require(set(old['attributes']) == set(new['attributes']), 'skin attribute set changed')
        metrics.append({'material': new_name, **skin_metrics(source, target, old, new)})
        for semantic in RESTORED & old['attributes'].keys():
            plan(old['attributes'][semantic], new['attributes'][semantic])
        require(len(old.get('targets', [])) == len(new.get('targets', [])), 'skin morph count changed')
        for old_morph, new_morph in zip(old.get('targets', []), new.get('targets', [])):
            require(set(old_morph) == set(new_morph) and set(old_morph) <= MORPH, 'skin morph semantic set changed')
            for semantic in old_morph:
                plan(old_morph[semantic], new_morph[semantic])

    # Refuse shared/interleaved writes that could modify another attribute, cloth or image.
    protected = []
    for index in range(len(target.doc['accessors'])):
        if index not in replacements:
            protected.extend(target.storage_ranges(index))
    for image in target.doc.get('images', []):
        if 'bufferView' in image:
            view = target.doc['bufferViews'][image['bufferView']]
            protected.append((view.get('byteOffset', 0), view.get('byteOffset', 0) + view['byteLength']))
    for mesh in target.doc.get('meshes', []):
        for primitive in mesh.get('primitives', []):
            name = target.doc['materials'][primitive['material']].get('name', '') if 'material' in primitive else ''
            if name.startswith('Skin_'):
                continue
            used = set(primitive['attributes'].values()) | {value for morph in primitive.get('targets', []) for value in morph.values()}
            if 'indices' in primitive:
                used.add(primitive['indices'])
            require(not (used & replacements.keys()), 'skin accessor shared with cloth')

    for index, (rows, original_accessor) in replacements.items():
        accessor = target.doc['accessors'][index]
        if 'sparse' in accessor or 'bufferView' not in accessor:
            # The source and target can encode different sparse vertex sets. Materialize
            # only this skin accessor; every existing cloth/image byte remains untouched.
            data = b''.join(rows)
            accessor['bufferView'] = len(target.doc['bufferViews'])
            target.doc['bufferViews'].append({'buffer': 0, 'byteOffset': len(target.binary), 'byteLength': len(data)})
            target.binary.extend(data + bytes(-len(data) % 4))
            target.doc['buffers'][0]['byteLength'] = len(target.binary)
            accessor.pop('sparse', None)
            accessor.pop('byteOffset', None)
        else:
            accessor, start, stride, row, count, _, _ = target.layout(index)
            for vertex, value in enumerate(rows):
                offset = start + vertex * stride
                require(not any(offset < end and offset + row > begin for begin, end in protected), 'skin storage overlaps protected accessor or image')
                target.binary[offset:offset + row] = value
        for field in ('min', 'max'):
            if field in original_accessor:
                accessor[field] = original_accessor[field]
            else:
                accessor.pop(field, None)
    return metrics, len(replacements)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    parser.add_argument('--target', required=True)
    parser.add_argument('--write', action='store_true')
    parser.add_argument('--audit', action='store_true', help='include per-primitive position/binding leakage metrics')
    options = parser.parse_args()
    source, target = Glb(options.source), Glb(options.target)
    require(source.path.resolve() != target.path.resolve(), 'source and target must differ')
    metrics, count = repair(source, target)
    encoded = target.encoded()
    if options.write:
        require(target.path.read_bytes() == target.raw, 'target changed during repair')
        target.path.write_bytes(encoded)
    report = {'target': target.path.name, 'write': options.write, 'skinAccessors': count,
              'beforeSHA256': hashlib.sha256(target.raw).hexdigest(), 'afterSHA256': hashlib.sha256(encoded).hexdigest()}
    if options.audit:
        report['skin'] = metrics
    print(json.dumps(report, separators=(',', ':')))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, IndexError, struct.error) as error:
        raise SystemExit('Skin repair refused: ' + str(error)) from error
