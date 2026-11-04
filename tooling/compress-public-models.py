#!/usr/bin/env python3
"""Shrink public GLB models by re-encoding embedded PNG textures as lossless WebP.

Rules (owner-approved, see apps/web/public-assets/README.md "Texture encoding"):

* PNG colour textures (baseColor, emissive and every other slot) become WebP lossless.
  The decoded RGBA pixels, including alpha and the RGB under transparent pixels, must be
  exactly equal; otherwise the PNG is kept.
* normal / metallicRoughness / occlusion images larger than 2048 px are downscaled to 2048
  (Lanczos, aspect kept). An image that is also used by any other slot, or by none, is
  never resized.
* JPEG and existing WebP images are left untouched.
* Identical image payloads are stored once. Image entries that differ only in metadata
  (name, extras) keep their own entry and share the same bufferView.
* Textures follow the EXT_texture_webp convention of the existing avatar bodies: no core
  `source`, `extensions.EXT_texture_webp.source`, image mimeType image/webp, and the
  extension in extensionsUsed and extensionsRequired. Three.js GLTFLoader reads it natively.
* Each converted image records `extras.extaliaImageConversion` (source hash, size, pixel
  hash, optional resizedFrom) so the source provenance receipts stay verifiable
  (tooling/public-models.mjs reverts the record before hashing a material receipt).
* Geometry, skins, morph targets, UVs, accessors, materials, samplers and names are not
  touched; only image bufferViews change and the BIN chunk is repacked (4-byte aligned).
* No Draco, Meshopt or KTX2 (CSP script-src 'self' blocks WASM decoders).

  python3 tooling/compress-public-models.py --dry-run [--report FILE] [--cache DIR]
  python3 tooling/compress-public-models.py --write   [--report FILE] [--cache DIR]
  python3 tooling/compress-public-models.py --verify   (re-decode converted WebP vs recorded pixel hash)
"""
import argparse
import copy
import hashlib
import io
import json
import struct
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

from PIL import Image

Image.MAX_IMAGE_PIXELS = None
ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / 'apps/web/public-assets'
MAX_DATA_SIZE = 2048
DATA_SLOTS = {'normalTexture', 'metallicRoughnessTexture', 'occlusionTexture'}
RECORD = 'extaliaImageConversion'
JSON_CHUNK, BIN_CHUNK = 0x4E4F534A, 0x004E4942
PNG_MAGIC = b'\x89PNG\r\n\x1a\n'
COLOR_CHUNKS = {b'iCCP', b'gAMA', b'cHRM', b'sRGB'}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def pixel_hash(rgba):
    return sha(f'{rgba.width}x{rgba.height}:'.encode() + rgba.tobytes())


# ---------------------------------------------------------------- GLB io
def read_glb(data):
    if data[:4] != b'glTF' or struct.unpack_from('<II', data, 4) != (2, len(data)):
        raise ValueError('invalid GLB header')
    cursor, doc, binary = 12, None, None
    while cursor + 8 <= len(data):
        length, kind = struct.unpack_from('<II', data, cursor)
        body = data[cursor + 8:cursor + 8 + length]
        if kind == JSON_CHUNK:
            doc = json.loads(body)
        elif kind == BIN_CHUNK and binary is None:
            binary = body
        cursor += 8 + length
    if doc is None or binary is None:
        raise ValueError('GLB needs JSON and BIN chunks')
    return doc, binary


def write_glb(doc, binary):
    text = json.dumps(doc, separators=(',', ':')).encode('ascii')
    text += b' ' * (-len(text) % 4)
    binary = binary + b'\0' * (-len(binary) % 4)
    total = 12 + 8 + len(text) + 8 + len(binary)
    return (b'glTF' + struct.pack('<II', 2, total) + struct.pack('<II', len(text), JSON_CHUNK) + text
            + struct.pack('<II', len(binary), BIN_CHUNK) + binary)


def view_bytes(doc, binary, index):
    view = doc['bufferViews'][index]
    start = view.get('byteOffset', 0)
    return binary[start:start + view['byteLength']]


def texture_sources(texture):
    """Yield (container, key) for every image reference of a texture."""
    if 'source' in texture:
        yield texture, 'source'
    for extension in (texture.get('extensions') or {}).values():
        if isinstance(extension, dict) and 'source' in extension:
            yield extension, 'source'


def walk_texture_infos(value):
    if isinstance(value, list):
        for child in value:
            yield from walk_texture_infos(child)
    elif isinstance(value, dict):
        for key, child in value.items():
            if key == 'extras':
                continue
            if key.lower().endswith('texture') and isinstance(child, dict) and 'index' in child:
                yield key, child['index']
            else:
                yield from walk_texture_infos(child)


def image_slots(doc):
    """image index -> set of material texture slot names (empty: unreferenced)."""
    slots = {i: set() for i in range(len(doc.get('images', [])))}
    textures = doc.get('textures', [])
    for key, index in walk_texture_infos(doc.get('materials', [])):
        for container, name in texture_sources(textures[index]):
            slots[container[name]].add(key)
    return slots


# ---------------------------------------------------------------- image conversion
def png_info(data):
    chunks, cursor = set(), 8
    while cursor + 8 <= len(data):
        length = struct.unpack_from('>I', data, cursor)[0]
        chunks.add(data[cursor + 4:cursor + 8])
        cursor += 12 + length
    return data[24], sorted(c.decode() for c in chunks & COLOR_CHUNKS)


def convert_payload(job):
    """Worker: PNG bytes -> lossless WebP result dict (never raises)."""
    data, allow_resize, cache_dir = job
    key = sha(data) + ('r' if allow_resize else 'c')
    if cache_dir:
        meta_file, webp_file = Path(cache_dir) / f'{key}.json', Path(cache_dir) / f'{key}.webp'
        if meta_file.exists():
            meta = json.loads(meta_file.read_text())
            if meta.get('webp'):
                meta['webpBytes'] = webp_file.read_bytes()
            return meta
    result = {'sourceSHA256': sha(data), 'sourceBytes': len(data), 'action': 'keep-png'}
    try:
        if data[:8] != PNG_MAGIC:
            raise ValueError('not a PNG')
        depth, chunks = png_info(data)
        result['pngColorChunks'] = chunks
        if depth == 16:
            result['reason'] = '16-bit PNG cannot be stored losslessly as 8-bit WebP; kept PNG'
            return result
        source = Image.open(io.BytesIO(data))
        source.load()
        result['sourceSize'] = list(source.size)
        result['sourceMode'] = source.mode
        rgba = source.convert('RGBA')
        result['sourcePixelSHA256'] = pixel_hash(rgba)
        opaque = rgba.getchannel('A').getextrema()[0] == 255
        target = rgba
        if allow_resize and max(rgba.size) > MAX_DATA_SIZE:
            if opaque:
                longest = max(rgba.size)
                size = tuple(MAX_DATA_SIZE if side == longest else max(1, round(side * MAX_DATA_SIZE / longest))
                             for side in rgba.size)
                target = rgba.resize(size, Image.LANCZOS)
                result['resizedFrom'] = list(rgba.size)
            else:
                result['note'] = 'oversized data map has non-opaque alpha; kept at full size'
        stored = target.convert('RGB') if opaque else target
        buffer = io.BytesIO()
        stored.save(buffer, 'WEBP', lossless=True, quality=100, method=6, exact=True)
        webp = buffer.getvalue()
        decoded = Image.open(io.BytesIO(webp))
        decoded.load()
        decoded_rgba = decoded.convert('RGBA')
        equal = decoded_rgba.size == target.size and decoded_rgba.tobytes() == target.tobytes()
        result.update(size=list(target.size), pixelSHA256=pixel_hash(decoded_rgba), pixelsEqual=bool(equal),
                      webpMode=stored.mode, webpBytesLen=len(webp), webpSHA256=sha(webp))
        if not equal:
            result['reason'] = 'decoded pixels differ; kept PNG'
        elif len(webp) >= len(data) and 'resizedFrom' not in result:
            result['reason'] = 'WebP lossless is not smaller; kept PNG'
        else:
            result['action'] = 'webp-lossless-resize' if 'resizedFrom' in result else 'webp-lossless'
            result['webp'] = True
            result['webpBytes'] = webp
    except Exception as error:  # noqa: BLE001 - a bad image keeps its PNG instead of aborting the run
        result['reason'] = f'{type(error).__name__}: {error}'
        return result
    if cache_dir:
        meta_file.parent.mkdir(parents=True, exist_ok=True)
        if result.get('webp'):
            webp_file.write_bytes(result['webpBytes'])
        meta_file.write_text(json.dumps({k: v for k, v in result.items() if k != 'webpBytes'}))
    return result


# ---------------------------------------------------------------- per-file plan
def remap_buffer_views(value, mapping):
    if isinstance(value, dict):
        return {k: (mapping[v] if k == 'bufferView' and isinstance(v, int) else remap_buffer_views(v, mapping))
                for k, v in value.items()}
    if isinstance(value, list):
        return [remap_buffer_views(v, mapping) for v in value]
    return value


def buffer_view_refs(doc):
    refs = set()

    def collect(value, top=False):
        if isinstance(value, dict):
            for k, v in value.items():
                if top and k == 'images':
                    continue
                if k == 'bufferView' and isinstance(v, int):
                    refs.add(v)
                else:
                    collect(v)
        elif isinstance(value, list):
            for v in value:
                collect(v)
    collect(doc, True)
    return refs


def plan_file(path, data, pool, cache_dir):
    doc, binary = read_glb(data)
    images = doc.get('images', [])
    report = {'path': str(path.relative_to(ASSETS)), 'before': len(data), 'images': []}
    if not images:
        report['skip'] = 'no images'
        return report, None
    slots = image_slots(doc)
    payloads = [view_bytes(doc, binary, image['bufferView']) for image in images]
    if not any(p[:8] == PNG_MAGIC for p in payloads):
        report['skip'] = 'no PNG images'
        return report, None
    image_views = {image['bufferView'] for image in images}
    if image_views & buffer_view_refs(doc):
        report['skip'] = 'image bufferView shared with non-image data'
        return report, None
    for texture in doc.get('textures', []):
        if 'source' in texture and 'EXT_texture_webp' in (texture.get('extensions') or {}):
            report['skip'] = 'texture has a core source plus EXT_texture_webp (fallback layout)'
            return report, None

    groups = {}
    for index, payload in enumerate(payloads):
        groups.setdefault(sha(payload), []).append(index)
    jobs = {}
    for digest, members in groups.items():
        if payloads[members[0]][:8] != PNG_MAGIC:
            continue
        roles = set().union(*(slots[i] for i in members))
        jobs[digest] = (payloads[members[0]], bool(roles) and roles <= DATA_SLOTS, cache_dir)
    results = dict(zip(jobs, pool.map(convert_payload, jobs.values())))

    new_payloads, entries, entry_index, old_to_new = {}, [], {}, {}
    for index, image in enumerate(images):
        digest = sha(payloads[index])
        entry = copy.deepcopy(image)
        result = results.get(digest)
        if result and result.get('webp'):
            payload = result['webpBytes']
            entry['mimeType'] = 'image/webp'
            record = {'encoding': 'webp-lossless', 'sourceMimeType': 'image/png', 'sourceSHA256': digest,
                      'sourceBytes': result['sourceBytes'], 'sourceSize': result['sourceSize'],
                      'sourcePixelSHA256': result['sourcePixelSHA256'], 'size': result['size'],
                      'pixelSHA256': result['pixelSHA256']}
            if 'resizedFrom' in result:
                record['resizedFrom'] = result['resizedFrom']
            entry.setdefault('extras', {})[RECORD] = record
        else:
            payload = payloads[index]
        key = sha(payload)
        new_payloads.setdefault(key, payload)
        entry['bufferView'] = key
        signature = json.dumps(entry, sort_keys=True)
        if signature not in entry_index:
            entry_index[signature] = len(entries)
            entries.append(entry)
        old_to_new[index] = entry_index[signature]
        row = {'index': index, 'slots': sorted(slots[index]) or ['unused'], 'mime': image.get('mimeType'),
               'size': (result or {}).get('sourceSize'), 'before': len(payloads[index]), 'after': len(payload),
               'shared': len(groups[digest]) > 1, 'mergedInto': old_to_new[index] if old_to_new[index] != index else None}
        if result:
            row.update(action=result['action'], pixelsEqual=result.get('pixelsEqual'),
                       resizedFrom=result.get('resizedFrom'), newSize=result.get('size'),
                       reason=result.get('reason') or result.get('note'), chunks=result.get('pngColorChunks'))
        else:
            row['action'] = 'keep-' + image.get('mimeType', '?').split('/')[-1]
        report['images'].append(row)

    kept = [i for i in range(len(doc['bufferViews'])) if i not in image_views]
    mapping = {old: new for new, old in enumerate(kept)}
    new_binary, views, offsets = bytearray(), [], {}
    for old in kept:
        view = copy.deepcopy(doc['bufferViews'][old])
        span = (view.get('byteOffset', 0), view['byteLength'])
        if span not in offsets:
            new_binary += b'\0' * (-len(new_binary) % 4)
            offsets[span] = len(new_binary)
            new_binary += binary[span[0]:span[0] + span[1]]
        view['byteOffset'] = offsets[span]
        views.append(view)
    payload_view = {}
    for key, payload in new_payloads.items():
        new_binary += b'\0' * (-len(new_binary) % 4)
        payload_view[key] = len(views)
        views.append({'buffer': 0, 'byteOffset': len(new_binary), 'byteLength': len(payload)})
        new_binary += payload
    new_binary += b'\0' * (-len(new_binary) % 4)

    new_doc = remap_buffer_views({k: v for k, v in doc.items() if k != 'images'}, mapping)
    new_doc['bufferViews'] = views
    new_doc['buffers'] = [dict(doc['buffers'][0], byteLength=len(new_binary))]
    new_doc['images'] = [dict(entry, bufferView=payload_view[entry['bufferView']]) for entry in entries]
    used_webp = False
    for texture in new_doc.get('textures', []):
        for container, name in list(texture_sources(texture)):
            container[name] = old_to_new[container[name]]
        if 'source' in texture and new_doc['images'][texture['source']]['mimeType'] == 'image/webp':
            texture.setdefault('extensions', {})['EXT_texture_webp'] = {'source': texture.pop('source')}
        used_webp = used_webp or 'EXT_texture_webp' in (texture.get('extensions') or {})
    if used_webp:
        for field in ('extensionsUsed', 'extensionsRequired'):
            values = new_doc.setdefault(field, [])
            if 'EXT_texture_webp' not in values:
                values.append('EXT_texture_webp')
    check_equivalence(doc, binary, new_doc, bytes(new_binary), mapping, results, old_to_new)
    new_data = write_glb(new_doc, bytes(new_binary))
    read_glb(new_data)
    report['after'] = len(new_data)
    return report, new_data


def check_equivalence(old_doc, old_bin, new_doc, new_bin, mapping, results, old_to_new):
    skip = {'images', 'bufferViews', 'buffers', 'extensionsUsed', 'extensionsRequired', 'textures'}
    old_rest = remap_buffer_views({k: v for k, v in old_doc.items() if k not in skip}, mapping)
    new_rest = {k: v for k, v in new_doc.items() if k not in skip}
    if json.dumps(old_rest, sort_keys=True) != json.dumps(new_rest, sort_keys=True):
        raise AssertionError('non-image JSON changed')
    for old, new in mapping.items():
        if view_bytes(old_doc, old_bin, old) != view_bytes(new_doc, new_bin, new):
            raise AssertionError('non-image bufferView bytes changed')
        old_view, new_view = old_doc['bufferViews'][old], new_doc['bufferViews'][new]
        if any(old_view.get(k) != new_view.get(k) for k in set(old_view) | set(new_view) if k != 'byteOffset'):
            raise AssertionError('bufferView metadata changed')
    if len(old_doc.get('textures', [])) != len(new_doc.get('textures', [])):
        raise AssertionError('texture count changed')
    for old, new in zip(old_doc.get('textures', []), new_doc.get('textures', [])):
        if any(old.get(k) != new.get(k) for k in set(old) | set(new) if k not in ('source', 'extensions')):
            raise AssertionError('texture metadata changed')
        old_refs = [c[n] for c, n in texture_sources(old)]
        new_refs = [c[n] for c, n in texture_sources(new)]
        if [old_to_new[i] for i in old_refs] != new_refs:
            raise AssertionError('texture image reference changed')
    for image in new_doc.get('images', []):
        if not isinstance(image.get('bufferView'), int):
            raise AssertionError('image without bufferView')


# ---------------------------------------------------------------- registry
def update_registry(changes):
    """changes: {relative glb path: (sha256, bytes)} -> models.json and source-garments.json."""
    for name, items in (('models.json', 'models'), ('source-garments.json', 'garments')):
        file = ASSETS / name
        if not file.exists():
            continue
        original = file.read_text()
        document = json.loads(original)
        for entry in document[items]:
            if entry['path'] in changes:
                entry['sha256'], entry['bytes'] = changes[entry['path']]
        indent = 2 if original.startswith('{\n  "') else 2
        file.write_text(json.dumps(document, indent=indent, ensure_ascii=False) + ('\n' if original.endswith('\n') else ''))


def verify_all():
    """Re-decode every converted WebP and compare with its recorded pixel hash."""
    failures, count = 0, 0
    for path in sorted(ASSETS.rglob('*.glb')):
        doc, binary = read_glb(path.read_bytes())
        for index, image in enumerate(doc.get('images', [])):
            record = (image.get('extras') or {}).get(RECORD)
            if not record:
                continue
            count += 1
            decoded = Image.open(io.BytesIO(view_bytes(doc, binary, image['bufferView']))).convert('RGBA')
            ok = (image.get('mimeType') == 'image/webp' and pixel_hash(decoded) == record['pixelSHA256']
                  and list(decoded.size) == record['size']
                  and ('resizedFrom' in record or record['pixelSHA256'] == record['sourcePixelSHA256']))
            if not ok:
                failures += 1
                print(f'MISMATCH {path.relative_to(ASSETS)} image {index}')
    print(f'verified {count} converted images, {failures} mismatches')
    return failures == 0


def render_report(rows, mode, seconds):
    mib = lambda n: f'{n / 1048576:.2f}'  # noqa: E731
    changed = [r for r in rows if 'after' in r]
    lines = [f'# GLB texture compression report ({mode})', '',
             f'Files changed: {len(changed)}; before {mib(sum(r["before"] for r in changed))} MiB, '
             f'after {mib(sum(r["after"] for r in changed))} MiB; elapsed {seconds:.0f}s.', '',
             '| file | before | after | images webp / resized / kept |', '|---|---:|---:|---|']
    for row in changed:
        acts = [i['action'] for i in row['images']]
        lines.append(f'| {row["path"]} | {row["before"]} | {row["after"]} | {sum(a.startswith("webp") for a in acts)} / '
                     f'{acts.count("webp-lossless-resize")} / {sum(not a.startswith("webp") for a in acts)} |')
    lines += ['', '## Per image', '']
    for row in rows:
        if 'after' not in row:
            lines.append(f'- {row["path"]}: skipped ({row.get("skip")})')
            continue
        lines.append(f'### {row["path"]} ({row["before"]} -> {row["after"]})')
        for i in row['images']:
            size = 'x'.join(map(str, i['size'])) if i.get('size') else '?'
            extra = ''
            if i.get('resizedFrom'):
                extra += f' resized {"x".join(map(str, i["resizedFrom"]))} -> {"x".join(map(str, i["newSize"]))}'
            if i.get('mergedInto') is not None:
                extra += f' merged into image {i["mergedInto"]} (new numbering)'
            if i.get('reason'):
                extra += f' ({i["reason"]})'
            equal = '' if i.get('pixelsEqual') is None else f' pixels-equal={i["pixelsEqual"]}'
            lines.append(f'- image {i["index"]} [{", ".join(i["slots"])}] {i["mime"]} {size} {i["before"]} -> {i["after"]} '
                         f'{i["action"]}{" shared-payload" if i["shared"] else ""}{equal}{extra}')
        lines.append('')
    return '\n'.join(lines) + '\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--dry-run', action='store_true')
    mode.add_argument('--write', action='store_true')
    mode.add_argument('--verify', action='store_true')
    parser.add_argument('--report', help='write a Markdown report to this file')
    parser.add_argument('--cache', help='directory for converted WebP payloads (speeds up --write after --dry-run)')
    parser.add_argument('--min-bytes', type=int, default=1_000_000, help='only touch GLBs at least this large')
    parser.add_argument('--only', help='substring filter on the relative path')
    parser.add_argument('--workers', type=int, default=4)
    args = parser.parse_args()
    if args.verify:
        sys.exit(0 if verify_all() else 1)
    started, rows, changes = time.time(), [], {}
    with ProcessPoolExecutor(args.workers) as pool:
        for path in sorted(ASSETS.rglob('*.glb')):
            relative = str(path.relative_to(ASSETS))
            data = path.read_bytes()
            if len(data) < args.min_bytes or (args.only and args.only not in relative):
                continue
            try:
                row, new_data = plan_file(path, data, pool, args.cache)
            except Exception as error:  # noqa: BLE001
                rows.append({'path': relative, 'before': len(data), 'images': [], 'skip': f'{type(error).__name__}: {error}'})
                print(f'FAIL {relative}: {error}', file=sys.stderr)
                continue
            rows.append(row)
            if new_data is not None and len(new_data) >= len(data):
                row.pop('after')
                row['skip'] = 'no size reduction'
                new_data = None
            if new_data is None:
                print(f'skip {relative}: {row.get("skip")}', flush=True)
                continue
            print(f'{relative}: {len(data)} -> {len(new_data)}', flush=True)
            if args.write:
                temporary = path.with_suffix('.glb.tmp')
                temporary.write_bytes(new_data)
                temporary.replace(path)
                changes[relative] = (sha(new_data), len(new_data))
    if args.write and changes:
        update_registry(changes)
    text = render_report(rows, 'write' if args.write else 'dry-run', time.time() - started)
    if args.report:
        Path(args.report).parent.mkdir(parents=True, exist_ok=True)
        Path(args.report).write_text(text)
    print(text.split('\n\n')[1])


if __name__ == '__main__':
    main()
