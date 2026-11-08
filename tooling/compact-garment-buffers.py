#!/usr/bin/env python3
"""Losslessly repack garment GLBs without a runtime decoder.

Dense/interleaved accessors are tightly packed and identical payloads share bytes.
Zero-filled accessor rows become glTF 2.0 sparse accessors only when that is smaller;
an entirely zero accessor uses the glTF zero-initialized form. Unreferenced buffer
views and interleaved padding disappear. All decoded attribute/index/morph/skin bytes,
materials and embedded images remain exact. No geometry is simplified or quantized.

python3 tooling/compact-garment-buffers.py --dry-run [--only avatars/wardrobe/...glb]
python3 tooling/compact-garment-buffers.py --write [--report <report.json>]
python3 tooling/compact-garment-buffers.py --dry-run --output-dir <review-dir>

The default selection is every public outfit and wardrobe GLB. --output-dir writes
review copies even in dry-run mode; --write replaces only smaller, verified files.
Hashes in the public model/source receipts must be refreshed after reviewed writes.
"""
import argparse
import copy
import hashlib
import json
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / 'apps/web/public-assets'
JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942
WIDTHS = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}
COMPONENTS = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4,
              'MAT2': 4, 'MAT3': 9, 'MAT4': 16}


def read_glb(raw):
    if len(raw) < 28 or raw[:4] != b'glTF' or struct.unpack_from('<II', raw, 4) != (2, len(raw)):
        raise ValueError('Expected a complete glTF 2.0 binary')
    cursor, chunks = 12, []
    while cursor < len(raw):
        if cursor + 8 > len(raw):
            raise ValueError('Truncated chunk header')
        length, kind = struct.unpack_from('<II', raw, cursor)
        if length % 4 or cursor + 8 + length > len(raw):
            raise ValueError('Invalid chunk length')
        chunks.append((kind, raw[cursor + 8:cursor + 8 + length]))
        cursor += 8 + length
    if [kind for kind, _ in chunks] != [JSON_CHUNK, BIN_CHUNK]:
        raise ValueError('Expected only JSON and BIN chunks')
    doc, binary = json.loads(chunks[0][1]), chunks[1][1]
    if len(doc.get('buffers', [])) != 1 or 'uri' in doc['buffers'][0]:
        raise ValueError('Only one embedded buffer is supported')
    if doc['buffers'][0]['byteLength'] > len(binary):
        raise ValueError('Truncated binary buffer')
    if any(name in doc.get('extensionsUsed', []) for name in
           ('KHR_draco_mesh_compression', 'EXT_meshopt_compression')):
        raise ValueError('Encoded geometry needs its own decoder and is not repacked')
    return doc, binary


def write_glb(doc, binary):
    text = json.dumps(doc, separators=(',', ':'), ensure_ascii=True).encode('ascii')
    text += b' ' * (-len(text) % 4)
    binary += b'\0' * (-len(binary) % 4)
    size = 28 + len(text) + len(binary)
    return (struct.pack('<III', 0x46546C67, 2, size)
            + struct.pack('<II', len(text), JSON_CHUNK) + text
            + struct.pack('<II', len(binary), BIN_CHUNK) + binary)


def view_bytes(doc, binary, index):
    view = doc['bufferViews'][index]
    if view.get('buffer', 0) != 0:
        raise ValueError('Unexpected external buffer view')
    start, length = view.get('byteOffset', 0), view['byteLength']
    if start < 0 or length < 0 or start + length > doc['buffers'][0]['byteLength']:
        raise ValueError('Buffer view outside the binary buffer')
    return binary[start:start + length]


def element_size(accessor):
    width = WIDTHS[accessor['componentType']]
    kind = accessor['type']
    if kind.startswith('MAT'):
        columns = int(kind[-1])
        return ((columns * width + 3) // 4 * 4) * columns
    return COMPONENTS[kind] * width


def accessor_bytes(doc, binary, accessor):
    """Decoded storage rows, preserving component bits (including signed zero).

    Matrix column padding is retained; generated padding is zero for an accessor
    without a base view, as required by glTF sparse initialization.
    """
    count, size = accessor['count'], element_size(accessor)
    if not isinstance(count, int) or count < 1:
        raise ValueError('Accessor count must be positive')
    rows = bytearray(count * size)
    if 'bufferView' in accessor:
        view = doc['bufferViews'][accessor['bufferView']]
        data = view_bytes(doc, binary, accessor['bufferView'])
        stride, offset = view.get('byteStride', size), accessor.get('byteOffset', 0)
        if stride < size or offset < 0 or offset + (count - 1) * stride + size > len(data):
            raise ValueError('Accessor outside its buffer view')
        if stride == size:
            rows[:] = data[offset:offset + count * size]
        else:
            for row in range(count):
                rows[row * size:(row + 1) * size] = data[offset + row * stride:offset + row * stride + size]
    sparse = accessor.get('sparse')
    if sparse:
        n, indices, values = sparse['count'], sparse['indices'], sparse['values']
        kind = indices['componentType']
        if kind not in (5121, 5123, 5125) or n < 1 or n > count:
            raise ValueError('Invalid sparse indices')
        index_data = view_bytes(doc, binary, indices['bufferView'])
        value_data = view_bytes(doc, binary, values['bufferView'])
        io, vo, width = indices.get('byteOffset', 0), values.get('byteOffset', 0), WIDTHS[kind]
        if io < 0 or vo < 0 or io + n * width > len(index_data) or vo + n * size > len(value_data):
            raise ValueError('Sparse data outside its view')
        fmt, previous = {5121: '<B', 5123: '<H', 5125: '<I'}[kind], -1
        for row in range(n):
            index = struct.unpack_from(fmt, index_data, io + row * width)[0]
            if index <= previous or index >= count:
                raise ValueError('Sparse indices must be increasing and in range')
            rows[index * size:(index + 1) * size] = value_data[vo + row * size:vo + (row + 1) * size]
            previous = index
    return bytes(rows)


def buffer_references(value):
    if isinstance(value, list):
        for item in value:
            yield from buffer_references(item)
    elif isinstance(value, dict):
        for key, item in value.items():
            if key == 'bufferView':
                yield value, key, item
            elif key != 'extras':
                yield from buffer_references(item)


def semantic_document(doc, binary):
    """Normalize storage references, retaining every other authored field."""
    result = copy.deepcopy(doc)
    result.pop('bufferViews', None)
    # Preserve buffer extras/name, only storage length changes.
    result['buffers'][0].pop('byteLength', None)
    for accessor in result.get('accessors', []):
        accessor.pop('bufferView', None)
        accessor.pop('byteOffset', None)
        accessor.pop('sparse', None)
    for container, key, index in buffer_references(result):
        container[key] = hashlib.sha256(view_bytes(doc, binary, index)).hexdigest()
    return result


def verify_equivalent(old_doc, old_binary, new_doc, new_binary):
    if semantic_document(old_doc, old_binary) != semantic_document(new_doc, new_binary):
        raise AssertionError('Repacking changed authored metadata or embedded image bytes')
    if len(old_doc.get('accessors', [])) != len(new_doc.get('accessors', [])):
        raise AssertionError('Accessor identity changed')
    for index, (old, new) in enumerate(zip(old_doc.get('accessors', []), new_doc.get('accessors', []))):
        if accessor_bytes(old_doc, old_binary, old) != accessor_bytes(new_doc, new_binary, new):
            raise AssertionError(f'Accessor {index} changed decoded component bytes')


def compact(raw):
    old_doc, old_binary = read_glb(raw)
    doc, binary, views = copy.deepcopy(old_doc), bytearray(), []
    payloads, view_ids = {}, {}
    statistics = {'sparseAccessors': 0, 'zeroAccessors': 0, 'sharedPayloads': 0,
                  'accessors': len(doc.get('accessors', []))}

    def store(payload, metadata=None):
        if not payload:
            raise ValueError('Empty buffer views are not valid')
        metadata = dict(metadata or {})
        for key in ('buffer', 'byteOffset', 'byteLength'):
            metadata.pop(key, None)
        digest = hashlib.sha256(payload).digest()
        identity = (digest, json.dumps(metadata, sort_keys=True, separators=(',', ':')))
        if identity in view_ids:
            statistics['sharedPayloads'] += 1
            return view_ids[identity]
        if digest in payloads:
            offset = payloads[digest]
            statistics['sharedPayloads'] += 1
        else:
            binary.extend(b'\0' * (-len(binary) % 4))
            offset = len(binary)
            binary.extend(payload)
            payloads[digest] = offset
        view_ids[identity] = len(views)
        views.append({'buffer': 0, 'byteOffset': offset, 'byteLength': len(payload), **metadata})
        return len(views) - 1

    # Images and any extension-owned raw views keep their full view payload/metadata.
    external = {key: value for key, value in doc.items() if key not in ('accessors', 'bufferViews')}
    for container, key, index in list(buffer_references(external)):
        container[key] = store(view_bytes(old_doc, old_binary, index), old_doc['bufferViews'][index])
    for accessor in doc.get('accessors', []):
        decoded = accessor_bytes(old_doc, old_binary, accessor)
        size, count = element_size(accessor), accessor['count']
        old_view = old_doc['bufferViews'][accessor['bufferView']] if 'bufferView' in accessor else {}
        # Opaque accessor/view extensions can depend on original storage layout.
        if accessor.get('extensions') or old_view.get('extensions'):
            raise ValueError('Accessor or buffer-view extensions need explicit layout support')
        accessor.pop('bufferView', None)
        accessor.pop('byteOffset', None)
        accessor.pop('sparse', None)
        nonzero = [row for row in range(count) if any(decoded[row * size:(row + 1) * size])]
        if not nonzero:
            statistics['zeroAccessors'] += 1
            continue
        index_type = 5121 if nonzero[-1] <= 255 else 5123 if nonzero[-1] <= 65535 else 5125
        width = WIDTHS[index_type]
        # Keep dense data when sparse JSON and extra view headers erase its saving.
        if len(nonzero) * (size + width) + 256 < len(decoded):
            fmt = {5121: '<B', 5123: '<H', 5125: '<I'}[index_type]
            indices = b''.join(struct.pack(fmt, index) for index in nonzero)
            values = b''.join(decoded[index * size:(index + 1) * size] for index in nonzero)
            accessor['sparse'] = {'count': len(nonzero),
                                  'indices': {'bufferView': store(indices), 'componentType': index_type},
                                  'values': {'bufferView': store(values)}}
            statistics['sparseAccessors'] += 1
        else:
            metadata = {key: value for key, value in old_view.items()
                        if key not in ('byteStride', 'buffer', 'byteOffset', 'byteLength')}
            accessor['bufferView'] = store(decoded, metadata)
    doc['bufferViews'] = views
    doc['buffers'][0]['byteLength'] = len(binary)
    candidate = write_glb(doc, bytes(binary))
    new_doc, new_binary = read_glb(candidate)
    verify_equivalent(old_doc, old_binary, new_doc, new_binary)
    # Never grow a file merely to standardize its layout.
    result = candidate if len(candidate) < len(raw) else raw
    return result, {**statistics, 'before': len(raw), 'after': len(result),
                    'saved': len(raw) - len(result), 'verified': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--dry-run', action='store_true')
    mode.add_argument('--write', action='store_true')
    parser.add_argument('--only', action='append', default=[], help='asset-relative or absolute GLB path; repeatable')
    parser.add_argument('--report', type=Path)
    parser.add_argument('--output-dir', type=Path, help='write verified review copies while leaving originals intact')
    args = parser.parse_args()
    paths = [Path(name) if Path(name).is_absolute() else ASSETS / name for name in args.only]
    if not paths:
        paths = sorted((ASSETS / 'avatars/outfits').rglob('*.glb')) + sorted((ASSETS / 'avatars/wardrobe').rglob('*.glb'))
    rows = []
    for path in paths:
        raw = path.read_bytes()
        packed, row = compact(raw)
        relative = path.resolve().relative_to(ASSETS)
        row['path'] = relative.as_posix()
        row['sha256'] = hashlib.sha256(packed).hexdigest()
        if args.write and packed != raw:
            path.write_bytes(packed)
        if args.output_dir:
            output = args.output_dir / relative
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(packed)
        print(f'{relative}: {len(raw):,} -> {len(packed):,} bytes (exact decoded data)')
        rows.append(row)
    report = {'mode': 'write' if args.write else 'dry-run', 'files': rows,
              'before': sum(row['before'] for row in rows), 'after': sum(row['after'] for row in rows),
              'atMostOneMB': sum(row['after'] <= 1_000_000 for row in rows), 'count': len(rows)}
    print(json.dumps({key: value for key, value in report.items() if key != 'files'}, sort_keys=True))
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + '\n')


if __name__ == '__main__':
    main()
