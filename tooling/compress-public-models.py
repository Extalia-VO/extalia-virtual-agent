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
  python3 tooling/compress-public-models.py --dry-run|--write --profile compact   (owner-approved compact profile, see below)
  python3 tooling/compress-public-models.py --verify   (re-decode converted WebP vs recorded pixel hash,
                                                        and re-check every recorded vertex quantization)

Compact profile (`--profile compact`, owner-approved 2026-11, 512 px cap, supersedes the pixel-identical rule for size):

* Colour maps (baseColor, emissive, anything shared with a colour slot): longest side <= 512 (Lanczos, never upscaled),
  WebP lossy q90 (method 6, alpha_quality 100), raised to q95 then lossless when PSNR < 38 dB or SSIM < 0.95.
* Data maps used only by normal / metallicRoughness / occlusion: longest side <= 512, JPEG q92 with 4:4:4 chroma
  (q95, then lossless WebP when a threshold fails; lossless WebP when alpha matters). Normal maps: mean angular error
  <= 2 degrees and p99 <= 6 degrees. Never lossy WebP for data maps.
* The smallest passing encoding wins; an image that is already within limits and not made smaller is kept.
* Textures and images no material references are removed; EXT_texture_webp is declared only where WebP remains.
* Records (`extras.extaliaImageConversion`, profile "compact") keep the original source provenance.

Vertex quantization (`--quantize` with --dry-run / --write), KHR_mesh_quantization, no WASM:

* Only SKINNED primitives (those with JOINTS_0) are touched, and only these attributes:
  WEIGHTS_n -> normalized uint16 (every vertex renormalised to sum exactly 65535, largest remainder),
  TANGENT -> normalized int8 (normalized int16 when the angular error would exceed 0.5 degrees; w must be
  exactly -1/0/1 and stays exact).
* POSITION and NORMAL stay float: a skinned mesh ignores its node transform, so a quantized POSITION would
  need the dequantization folded into the skin; NORMAL stays because runtime avatar code calls
  `computeVertexNormals()` on geometries that keep their normal attribute, which accumulates in the
  attribute's own type. Static (non-skinned) meshes are never touched because the scene bakes their
  geometry with `applyMatrix4` / `mergeGeometries`.
* TEXCOORD_*, JOINTS_*, indices, morph targets, sparse accessors, skins, inverse bind matrices, materials, names
  and extras are not touched; the BIN chunk is repacked with the same bufferView indices.
* `KHR_mesh_quantization` is added to extensionsUsed and extensionsRequired only in files with a quantized TANGENT.
  Each quantized accessor records `extras.extaliaQuantization`.
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

import numpy as np
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
QRECORD = 'extaliaQuantization'
QEXTENSION = 'KHR_mesh_quantization'
MAX_TANGENT_DEGREES = 0.5
DTYPES = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
COMPONENTS = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT2': 4, 'MAT3': 9, 'MAT4': 16}


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


# ---------------------------------------------------------------- vertex quantization
def read_accessor(doc, binary, index):
    """Tightly packed accessor -> (count, comps) ndarray, or None for sparse / strided / missing data."""
    accessor = doc['accessors'][index]
    if 'sparse' in accessor or 'bufferView' not in accessor:
        return None
    view = doc['bufferViews'][accessor['bufferView']]
    dtype, comps = np.dtype(DTYPES[accessor['componentType']]), COMPONENTS[accessor['type']]
    if view.get('byteStride', dtype.itemsize * comps) != dtype.itemsize * comps:
        return None
    start = view.get('byteOffset', 0) + accessor.get('byteOffset', 0)
    return np.frombuffer(binary, dtype=dtype, count=accessor['count'] * comps, offset=start).reshape(accessor['count'], comps)


def accessor_roles(doc):
    """accessor index -> set of reference roles ('WEIGHTS', 'TANGENT', ... or 'other')."""
    roles = {}

    def mark(index, role):
        roles.setdefault(index, set()).add(role)
    for mesh in doc.get('meshes', []):
        for primitive in mesh['primitives']:
            skinned = 'JOINTS_0' in primitive['attributes']
            for name, index in primitive['attributes'].items():
                base = name.rsplit('_', 1)[0] if name.rsplit('_', 1)[-1].isdigit() else name
                mark(index, base if skinned and base in ('WEIGHTS', 'TANGENT') else 'other')
            for target in primitive.get('targets', []):
                for index in target.values():
                    mark(index, 'other')
            if 'indices' in primitive:
                mark(primitive['indices'], 'other')
    for skin in doc.get('skins', []):
        if 'inverseBindMatrices' in skin:
            mark(skin['inverseBindMatrices'], 'other')
    for animation in doc.get('animations', []):
        for sampler in animation.get('samplers', []):
            mark(sampler['input'], 'other')
            mark(sampler['output'], 'other')
    return roles


def quantize_weights(sets):
    """List of (N,4) float weight sets -> list of uint16 sets whose per-vertex sum is exactly 65535 (or 0)."""
    stacked = np.concatenate([np.asarray(w, dtype=np.float64) for w in sets], axis=1)
    total = stacked.sum(axis=1, keepdims=True)
    live = total[:, 0] > 0
    unit = np.divide(stacked, total, out=np.zeros_like(stacked), where=total > 0) * 65535.0
    base = np.floor(unit)
    remaining = (65535 - base.sum(axis=1)).astype(np.int64)
    remaining[~live] = 0
    order = np.argsort(-(unit - base), axis=1, kind='stable')
    rank = np.empty_like(order)
    np.put_along_axis(rank, order, np.arange(order.shape[1])[None, :].repeat(order.shape[0], axis=0), axis=1)
    quantized = (base + (rank < remaining[:, None])).astype(np.uint16)
    return [quantized[:, 4 * i:4 * i + 4] for i in range(len(sets))]


def angle_degrees(a, b):
    a, b = np.asarray(a, dtype=np.float64), np.asarray(b, dtype=np.float64)
    na, nb = np.linalg.norm(a, axis=1), np.linalg.norm(b, axis=1)
    cosine = np.einsum('ij,ij->i', a, b) / np.maximum(na * nb, 1e-30)
    angle = np.degrees(np.arccos(np.clip(cosine, -1, 1)))
    return np.where((na == 0) & (nb == 0), 0.0, angle)


def quantize_tangents(tangent):
    """(N,4) float tangent -> (array, np.dtype, max error degrees) or None when it cannot stay within 0.5 degrees."""
    tangent = np.asarray(tangent, dtype=np.float64)
    if not np.isin(tangent[:, 3], (-1.0, 0.0, 1.0)).all() or not np.isfinite(tangent).all():
        return None
    for dtype, top in ((np.int8, 127), (np.int16, 32767)):
        xyz = tangent[:, :3]
        floor = np.floor(xyz * top)
        best, best_angle = None, np.full(len(xyz), np.inf)
        for mask in range(8):  # round-down / round-up per axis, keep the closest direction
            candidate = np.clip(floor + np.array([(mask >> axis) & 1 for axis in range(3)]), -top, top)
            angle = angle_degrees(xyz, candidate)
            if best is None:
                best, best_angle = candidate.copy(), angle
            else:
                better = angle < best_angle
                best[better], best_angle[better] = candidate[better], angle[better]
        worst = float(best_angle.max()) if len(best_angle) else 0.0
        if worst <= MAX_TANGENT_DEGREES:
            result = np.concatenate([best, tangent[:, 3:] * top], axis=1).astype(dtype)
            return result, np.dtype(dtype), worst
    return None


def plan_quantize(path, data):
    doc, binary = read_glb(data)
    report = {'path': str(path.relative_to(ASSETS)), 'before': len(data), 'accessors': []}
    roles = accessor_roles(doc)
    users = {}
    for index, accessor in enumerate(doc.get('accessors', [])):
        if 'bufferView' in accessor:
            users.setdefault(accessor['bufferView'], []).append(index)
    replacements = {}  # accessor index -> (ndarray, new componentType, record)
    for mesh in doc.get('meshes', []):
        for primitive in mesh['primitives']:
            attributes = primitive['attributes']
            if 'JOINTS_0' not in attributes:
                continue
            weight_names = sorted(n for n in attributes if n.startswith('WEIGHTS_'))
            candidates = [attributes[n] for n in weight_names]
            sets = [read_accessor(doc, binary, i) for i in candidates]
            if candidates and all(roles[i] == {'WEIGHTS'} for i in candidates) and all(
                    s is not None and doc['accessors'][i]['componentType'] == 5126 and doc['accessors'][i]['type'] == 'VEC4'
                    for i, s in zip(candidates, sets)) and not any(i in replacements for i in candidates):
                quantized = quantize_weights(sets)
                for position, (name, index) in enumerate(zip(weight_names, candidates)):
                    original = sets[position].astype(np.float64)
                    dequantized = quantized[position].astype(np.float64) / 65535.0
                    replacements[index] = (quantized[position], 5123, {
                        'attribute': name, 'encoding': 'uint16-normalized', 'sourceComponentType': 5126,
                        'sourceSHA256': sha(sets[position].tobytes()),
                        'maxDeviation': float(np.abs(dequantized - original).max()) if len(original) else 0.0})
            tangent = attributes.get('TANGENT')
            if tangent is not None and roles[tangent] == {'TANGENT'} and tangent not in replacements:
                accessor = doc['accessors'][tangent]
                values = read_accessor(doc, binary, tangent)
                if values is not None and accessor['componentType'] == 5126 and accessor['type'] == 'VEC4':
                    outcome = quantize_tangents(values)
                    if outcome is not None:
                        array, dtype, worst = outcome
                        replacements[tangent] = (array, 5120 if dtype == np.int8 else 5122, {
                            'attribute': 'TANGENT', 'encoding': 'int8-normalized' if dtype == np.int8 else 'int16-normalized',
                            'sourceComponentType': 5126, 'sourceSHA256': sha(values.tobytes()), 'maxAngleDegrees': round(worst, 4)})
    # a bufferView is rewritten only when every accessor using it is replaced
    replacements = {i: v for i, v in replacements.items()
                    if all(j in replacements for j in users[doc['accessors'][i]['bufferView']])}
    if not replacements:
        report['skip'] = 'no skinned WEIGHTS / TANGENT to quantize'
        return report, None

    new_doc = copy.deepcopy(doc)
    new_views = {}
    for index, (array, component, record) in replacements.items():
        accessor = new_doc['accessors'][index]
        accessor['componentType'] = component
        accessor['normalized'] = True
        accessor.pop('min', None)
        accessor.pop('max', None)
        accessor.pop('byteOffset', None)
        accessor.setdefault('extras', {})[QRECORD] = record
        new_views[accessor['bufferView']] = np.ascontiguousarray(array).tobytes()
        report['accessors'].append({'accessor': index, 'before': int(read_accessor(doc, binary, index).nbytes),
                                    'after': len(new_views[accessor['bufferView']]), **record})
    new_binary, offsets = bytearray(), {}
    for index, view in enumerate(new_doc['bufferViews']):
        content = new_views.get(index)
        if content is None:
            span = (view.get('byteOffset', 0), view['byteLength'])
            content = binary[span[0]:span[0] + span[1]]
            key = ('old',) + span
        else:
            key = ('new', index)
        if key not in offsets:
            new_binary += b'\0' * (-len(new_binary) % 4)
            offsets[key] = len(new_binary)
            new_binary += content
        view['byteOffset'], view['byteLength'] = offsets[key], len(content)
    new_binary += b'\0' * (-len(new_binary) % 4)
    new_doc['buffers'] = [dict(doc['buffers'][0], byteLength=len(new_binary))]
    if any(r[1] in (5120, 5122) and r[2]['attribute'] == 'TANGENT' for r in replacements.values()):
        for field in ('extensionsUsed', 'extensionsRequired'):
            values = new_doc.setdefault(field, [])
            if QEXTENSION not in values:
                values.append(QEXTENSION)
    check_quantize_equivalence(doc, binary, new_doc, bytes(new_binary), replacements)
    new_data = write_glb(new_doc, bytes(new_binary))
    read_glb(new_data)
    report['after'] = len(new_data)
    return report, new_data


def check_quantize_equivalence(old_doc, old_bin, new_doc, new_bin, replacements):
    skip = {'accessors', 'bufferViews', 'buffers', 'extensionsUsed', 'extensionsRequired'}
    if json.dumps({k: v for k, v in old_doc.items() if k not in skip}, sort_keys=True) != \
            json.dumps({k: v for k, v in new_doc.items() if k not in skip}, sort_keys=True):
        raise AssertionError('JSON outside accessors changed')
    for index, (old, new) in enumerate(zip(old_doc['accessors'], new_doc['accessors'])):
        if index in replacements:
            ignored = {'componentType', 'normalized', 'min', 'max', 'byteOffset', 'extras'}
            if {k: v for k, v in old.items() if k not in ignored} != {k: v for k, v in new.items() if k not in ignored}:
                raise AssertionError('quantized accessor metadata changed')
            if {k: v for k, v in (old.get('extras') or {}).items()} != {k: v for k, v in new['extras'].items() if k != QRECORD}:
                raise AssertionError('accessor extras changed')
        elif old != new:
            raise AssertionError('untouched accessor changed')
    for index, (old, new) in enumerate(zip(old_doc['bufferViews'], new_doc['bufferViews'])):
        if {k: v for k, v in old.items() if k not in ('byteOffset', 'byteLength')} != {k: v for k, v in new.items() if k not in ('byteOffset', 'byteLength')}:
            raise AssertionError('bufferView metadata changed')
        used_by = [i for i, a in enumerate(old_doc['accessors']) if a.get('bufferView') == index]
        if not any(i in replacements for i in used_by) and view_bytes(old_doc, old_bin, index) != view_bytes(new_doc, new_bin, index):
            raise AssertionError('untouched bufferView bytes changed')
    for field in ('extensionsUsed', 'extensionsRequired'):
        extra = set(new_doc.get(field, [])) - set(old_doc.get(field, []))
        if extra - {QEXTENSION}:
            raise AssertionError('unexpected extension')


def verify_quantized():
    """Check every recorded quantization: type, weight sums, tangent w and extension declarations."""
    failures, count = 0, 0
    for path in sorted(ASSETS.rglob('*.glb')):
        doc, binary = read_glb(path.read_bytes())
        needs_extension = False
        for index, accessor in enumerate(doc.get('accessors', [])):
            record = (accessor.get('extras') or {}).get(QRECORD)
            if not record:
                continue
            count += 1
            values = read_accessor(doc, binary, index)
            if record['attribute'].startswith('WEIGHTS_'):
                ok = (values is not None and accessor['componentType'] == 5123 and accessor.get('normalized') is True
                      and bool(np.isin(values.astype(np.uint32).sum(axis=1), (0, 65535)).all()) is True)
            else:
                needs_extension = True
                top = 127 if accessor['componentType'] == 5120 else 32767
                ok = (values is not None and accessor['componentType'] in (5120, 5122) and accessor.get('normalized') is True
                      and bool(np.isin(values[:, 3], (-top, 0, top)).all()))
            if not ok:
                failures += 1
                print(f'QUANTIZATION MISMATCH {path.relative_to(ASSETS)} accessor {index}')
        if needs_extension and not all(QEXTENSION in doc.get(f, []) for f in ('extensionsUsed', 'extensionsRequired')):
            failures += 1
            print(f'MISSING {QEXTENSION} declaration {path.relative_to(ASSETS)}')
    print(f'verified {count} quantized accessors, {failures} mismatches')
    return failures == 0


def render_quantize_report(rows, mode, seconds):
    mib = lambda n: f'{n / 1048576:.2f}'  # noqa: E731
    changed = [r for r in rows if 'after' in r]
    lines = [f'# GLB vertex quantization report ({mode})', '',
             f'Files changed: {len(changed)}; before {mib(sum(r["before"] for r in changed))} MiB, '
             f'after {mib(sum(r["after"] for r in changed))} MiB; elapsed {seconds:.0f}s.', '',
             '| file | before | after | weights accessors / tangent accessors | max weight deviation | max tangent error (deg) |',
             '|---|---:|---:|---|---:|---:|']
    for row in changed:
        weights = [a for a in row['accessors'] if a['attribute'].startswith('WEIGHTS')]
        tangents = [a for a in row['accessors'] if a['attribute'] == 'TANGENT']
        lines.append(f'| {row["path"]} | {row["before"]} | {row["after"]} | {len(weights)} / {len(tangents)} '
                     f'({sum(a["encoding"] == "int16-normalized" for a in tangents)} int16) | '
                     f'{max((a["maxDeviation"] for a in weights), default=0):.2e} | '
                     f'{max((a["maxAngleDegrees"] for a in tangents), default=0):.4f} |')
    for row in rows:
        if 'after' not in row:
            lines.append(f'\n- {row["path"]}: skipped ({row.get("skip")})')
    return '\n'.join(lines) + '\n'


# ---------------------------------------------------------------- compact profile
# Owner-approved size profile (2026-11): all textures <= 512 px: colour maps as lossy WebP, data maps as
# 4:4:4 JPEG (lossless WebP when alpha matters), unreferenced textures/images removed.
COMPACT = 'compact'
COMPACT_MAX_SIDE = 512
MIN_PSNR, MIN_SSIM, MAX_ANGLE_MEAN, MAX_ANGLE_P99 = 38.0, 0.95, 2.0, 6.0
COMPACT_CACHE_VERSION = 'c4'


def floor_to(value, digits):
    scale = 10 ** digits
    return float(np.floor(value * scale + 1e-9) / scale)


def ceil_to(value, digits):
    scale = 10 ** digits
    return float(np.ceil(value * scale - 1e-9) / scale)


def compact_size(size):
    longest = max(size)
    if longest <= COMPACT_MAX_SIDE:
        return tuple(size)
    return tuple(COMPACT_MAX_SIDE if side == longest else max(1, round(side * COMPACT_MAX_SIDE / longest)) for side in size)


def box_mean(plane, window):
    integral = np.pad(plane, ((1, 0), (1, 0))).cumsum(0).cumsum(1)
    total = integral[window:, window:] - integral[:-window, window:] - integral[window:, :-window] + integral[:-window, :-window]
    return total / (window * window)


def color_metrics(reference, test):
    """PSNR (premultiplied RGB over visible pixels) and mean SSIM (luma over mid-grey) of two RGBA images."""
    ref, out = np.asarray(reference, dtype=np.float64), np.asarray(test, dtype=np.float64)
    alpha = ref[..., 3:4] / 255.0
    visible = ref[..., 3] > 0
    if not visible.any():
        return 100.0, 1.0
    ref_rgb, out_rgb = ref[..., :3] * alpha, out[..., :3] * alpha
    mse = float(np.mean((ref_rgb[visible] - out_rgb[visible]) ** 2))
    psnr = 100.0 if mse == 0 else min(100.0, 10 * np.log10(255.0 ** 2 / mse))
    grey = 128.0 * (1 - alpha)
    luma = np.array([0.299, 0.587, 0.114])
    a, b = ((ref_rgb + grey) @ luma), ((out_rgb + grey) @ luma)
    window = 7 if min(a.shape) >= 7 else 1
    if window == 1:
        return psnr, 1.0 if mse == 0 else 0.0
    mu_a, mu_b = box_mean(a, window), box_mean(b, window)
    var_a, var_b = box_mean(a * a, window) - mu_a ** 2, box_mean(b * b, window) - mu_b ** 2
    covariance = box_mean(a * b, window) - mu_a * mu_b
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    ssim = ((2 * mu_a * mu_b + c1) * (2 * covariance + c2)) / ((mu_a ** 2 + mu_b ** 2 + c1) * (var_a + var_b + c2))
    half = window // 2
    centre = visible[half:half + ssim.shape[0], half:half + ssim.shape[1]]
    return psnr, float(ssim[centre].mean() if centre.any() else 1.0)


def normal_angles(reference, test):
    def vectors(rgba):
        v = np.asarray(rgba, dtype=np.float64)[..., :3].reshape(-1, 3) / 255.0 * 2 - 1
        length = np.linalg.norm(v, axis=1, keepdims=True)
        return np.where(length > 1e-6, v / np.maximum(length, 1e-6), np.array([0.0, 0.0, 1.0]))
    cosine = np.clip(np.einsum('ij,ij->i', vectors(reference), vectors(test)), -1, 1)
    angle = np.degrees(np.arccos(cosine))
    return float(angle.mean()), float(np.percentile(angle, 99))


def meets_thresholds(role, metrics):
    if role == 'normal':
        return metrics['angularMean'] <= MAX_ANGLE_MEAN and metrics['angularP99'] <= MAX_ANGLE_P99
    return metrics['psnr'] >= MIN_PSNR and metrics['ssim'] >= MIN_SSIM


def encode_candidate(image, kind, quality):
    buffer = io.BytesIO()
    if kind == 'jpeg':
        try:
            image.convert('RGB').save(buffer, 'JPEG', quality=quality, subsampling=0, optimize=True)
        except OSError:  # Pillow's optimised-Huffman pass can fail on some inputs; retry with the standard tables
            buffer = io.BytesIO()
            image.convert('RGB').save(buffer, 'JPEG', quality=quality, subsampling=0)
    elif kind == 'webp-lossy':
        image.save(buffer, 'WEBP', quality=quality, method=6, alpha_quality=100)
    else:
        image.save(buffer, 'WEBP', lossless=True, quality=100, method=6, exact=True)
    return buffer.getvalue()


def compact_convert(job):
    """Worker: one image payload -> {'action': 'keep'} or a compact re-encoding with measured metrics."""
    payload, role, prior, cache_dir = job
    key = sha(payload) + role + COMPACT_CACHE_VERSION
    if cache_dir:
        meta_file, data_file = Path(cache_dir) / f'{key}.json', Path(cache_dir) / f'{key}.bin'
        if meta_file.exists():
            meta = json.loads(meta_file.read_text())
            if meta['action'] == 'compact':
                meta['payload'] = data_file.read_bytes()
            return meta
    source = Image.open(io.BytesIO(payload))
    source.load()
    current = source.convert('RGBA')
    alpha_matters = current.getchannel('A').getextrema()[0] < 255
    target_size = compact_size(current.size)
    reference = current if target_size == current.size else current.resize(target_size, Image.LANCZOS)
    if prior:
        provenance = {k: prior[k] for k in ('sourceMimeType', 'sourceSHA256', 'sourceBytes', 'sourceSize', 'sourcePixelSHA256')}
    else:
        provenance = {'sourceMimeType': Image.MIME[source.format], 'sourceSHA256': sha(payload), 'sourceBytes': len(payload),
                      'sourceSize': list(current.size), 'sourcePixelSHA256': pixel_hash(current)}
    plan = []  # (encoding, kind, quality)
    if role == 'color':
        plan = [('webp-lossy-q90', 'webp-lossy', 90), ('webp-lossy-q95', 'webp-lossy', 95)]
    elif not alpha_matters:
        plan = [('jpeg-444-q92', 'jpeg', 92), ('jpeg-444-q95', 'jpeg', 95)]
    plan.append(('webp-lossless', 'webp-lossless', 100))
    stored = reference if alpha_matters else reference.convert('RGB')
    best = None
    lossy_done = False
    for encoding, kind, quality in plan:
        if encoding.endswith('q95') and lossy_done:
            continue
        data = encode_candidate(stored, kind, quality)
        decoded = Image.open(io.BytesIO(data))
        decoded.load()
        decoded_rgba = decoded.convert('RGBA')
        if decoded_rgba.size != reference.size:
            raise AssertionError('decoded size differs')
        if kind == 'webp-lossless':
            if decoded_rgba.tobytes() != reference.tobytes():
                raise AssertionError('lossless WebP is not exact')
            metrics = {'psnr': 100.0, 'ssim': 1.0, 'angularMean': 0.0, 'angularP99': 0.0}
        else:
            if alpha_matters and decoded_rgba.getchannel('A').tobytes() != reference.getchannel('A').tobytes():
                raise AssertionError('alpha changed')
            psnr, ssim = color_metrics(reference, decoded_rgba)
            mean, p99 = normal_angles(reference, decoded_rgba) if role == 'normal' else (0.0, 0.0)
            metrics = {'psnr': floor_to(psnr, 2), 'ssim': floor_to(ssim, 4), 'angularMean': ceil_to(mean, 3), 'angularP99': ceil_to(p99, 3)}
        if not meets_thresholds(role, metrics):
            continue
        lossy_done = lossy_done or kind != 'webp-lossless'
        if best is None or len(data) < len(best[1]):
            best = (encoding, data, metrics, kind)
    encoding, data, metrics, kind = best
    resized = target_size != tuple(current.size)
    if not resized and len(data) >= len(payload):
        result = {'action': 'keep', 'reason': 'no smaller allowed encoding'}
    else:
        record = {'profile': COMPACT, 'encoding': encoding, **provenance, 'size': list(target_size), 'payloadSHA256': sha(data),
                  'psnr': metrics['psnr'], 'ssim': metrics['ssim']}
        if role == 'normal':
            record.update(angularMean=metrics['angularMean'], angularP99=metrics['angularP99'])
        if list(target_size) != provenance['sourceSize']:
            record['resizedFrom'] = provenance['sourceSize']
        result = {'action': 'compact', 'mimeType': 'image/jpeg' if kind == 'jpeg' else 'image/webp', 'record': record,
                  'payload': data, 'bytes': len(data)}
    if cache_dir:
        meta_file.parent.mkdir(parents=True, exist_ok=True)
        if result['action'] == 'compact':
            data_file.write_bytes(result['payload'])
        meta_file.write_text(json.dumps({k: v for k, v in result.items() if k != 'payload'}))
    return result


def image_roles(slots):
    if not slots:
        return 'color'  # unreferenced images are removed; role is irrelevant
    if slots <= DATA_SLOTS:
        return 'normal' if 'normalTexture' in slots else 'data'
    return 'color'


def remap_texture_indices(value, mapping):
    if isinstance(value, list):
        return [remap_texture_indices(v, mapping) for v in value]
    if isinstance(value, dict):
        out = {}
        for key, child in value.items():
            if key == 'extras':
                out[key] = child
            elif key.lower().endswith('texture') and isinstance(child, dict) and 'index' in child:
                out[key] = dict(remap_texture_indices(child, mapping), index=mapping[child['index']])
            else:
                out[key] = remap_texture_indices(child, mapping)
        return out
    return value


def plan_compact(path, data, pool, cache_dir):
    doc, binary = read_glb(data)
    images = doc.get('images', [])
    report = {'path': str(path.relative_to(ASSETS)), 'before': len(data), 'images': [], 'removed': 0}
    if not images:
        report['skip'] = 'no images'
        return report, None
    image_views = {image['bufferView'] for image in images}
    if image_views & buffer_view_refs(doc):
        report['skip'] = 'image bufferView shared with non-image data'
        return report, None
    for texture in doc.get('textures', []):
        if 'source' in texture and 'EXT_texture_webp' in (texture.get('extensions') or {}):
            report['skip'] = 'texture has a core source plus EXT_texture_webp (fallback layout)'
            return report, None
    slots = image_slots(doc)
    old_textures = doc.get('textures', [])
    used_textures = sorted({index for _, index in walk_texture_infos(doc.get('materials', []))})
    texture_map = {old: new for new, old in enumerate(used_textures)}
    used_images = sorted({container[name] for t in used_textures for container, name in texture_sources(old_textures[t])})
    report['removed'] = len(images) - len(used_images)
    report['removedTextures'] = len(old_textures) - len(used_textures)

    payloads = {i: view_bytes(doc, binary, images[i]['bufferView']) for i in used_images}
    groups = {}
    for index in used_images:
        groups.setdefault(sha(payloads[index]), []).append(index)
    jobs = {}
    for digest, members in groups.items():
        first = members[0]
        jobs[digest] = (payloads[first], image_roles(set().union(*(slots[i] for i in members))),
                        (images[first].get('extras') or {}).get(RECORD), cache_dir)
    results = dict(zip(jobs, pool.map(compact_convert, jobs.values())))

    new_payloads, entries, entry_index, old_to_new = {}, [], {}, {}
    for index in used_images:
        digest = sha(payloads[index])
        entry = copy.deepcopy(images[index])
        result = results[digest]
        if result['action'] == 'compact':
            payload = result['payload']
            entry['mimeType'] = result['mimeType']
            entry.setdefault('extras', {})[RECORD] = result['record']
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
        record = result.get('record') or {}
        report['images'].append({'index': index, 'slots': sorted(slots[index]), 'role': jobs[digest][1], 'mime': images[index].get('mimeType'),
                                 'before': len(payloads[index]), 'after': len(payload), 'action': result['action'],
                                 'encoding': record.get('encoding'), 'size': record.get('size'), 'psnr': record.get('psnr'),
                                 'ssim': record.get('ssim'), 'angularMean': record.get('angularMean'), 'angularP99': record.get('angularP99')})

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

    skip = {'images', 'textures', 'materials'}
    new_doc = remap_buffer_views({k: v for k, v in doc.items() if k not in skip}, mapping)
    new_doc['materials'] = remap_texture_indices(doc.get('materials', []), texture_map) if 'materials' in doc else None
    if new_doc['materials'] is None:
        del new_doc['materials']
    new_doc['bufferViews'] = views
    new_doc['buffers'] = [dict(doc['buffers'][0], byteLength=len(new_binary))]
    new_images = [dict(entry, bufferView=payload_view[entry['bufferView']]) for entry in entries]
    new_textures = []
    for old in used_textures:
        texture = copy.deepcopy(old_textures[old])
        (container, name), = list(texture_sources(texture))
        target = old_to_new[container[name]]
        extensions = texture.get('extensions') or {}
        extensions.pop('EXT_texture_webp', None)
        texture.pop('source', None)
        if new_images[target]['mimeType'] == 'image/webp':
            extensions['EXT_texture_webp'] = {'source': target}
        else:
            texture['source'] = target
        if extensions:
            texture['extensions'] = extensions
        else:
            texture.pop('extensions', None)
        new_textures.append(texture)
    if new_images:
        new_doc['images'] = new_images
    if new_textures:
        new_doc['textures'] = new_textures
    used_webp = any('EXT_texture_webp' in (t.get('extensions') or {}) for t in new_textures)
    for field in ('extensionsUsed', 'extensionsRequired'):
        values = [v for v in new_doc.get(field, []) if v != 'EXT_texture_webp']
        if used_webp:
            values.append('EXT_texture_webp')
        if values:
            new_doc[field] = values
        else:
            new_doc.pop(field, None)
    check_compact_equivalence(doc, binary, new_doc, bytes(new_binary), mapping, texture_map)
    new_data = write_glb(new_doc, bytes(new_binary))
    read_glb(new_data)
    report['after'] = len(new_data)
    return report, new_data


def check_compact_equivalence(old_doc, old_bin, new_doc, new_bin, mapping, texture_map):
    skip = {'images', 'bufferViews', 'buffers', 'extensionsUsed', 'extensionsRequired', 'textures', 'materials'}
    old_rest = remap_buffer_views({k: v for k, v in old_doc.items() if k not in skip}, mapping)
    if json.dumps(old_rest, sort_keys=True) != json.dumps({k: v for k, v in new_doc.items() if k not in skip}, sort_keys=True):
        raise AssertionError('non-image JSON changed')
    if json.dumps(remap_texture_indices(old_doc.get('materials', []), texture_map), sort_keys=True) != json.dumps(new_doc.get('materials', []), sort_keys=True):
        raise AssertionError('materials changed beyond texture index remapping')
    for old, new in mapping.items():
        if view_bytes(old_doc, old_bin, old) != view_bytes(new_doc, new_bin, new):
            raise AssertionError('non-image bufferView bytes changed')
        old_view, new_view = old_doc['bufferViews'][old], new_doc['bufferViews'][new]
        if any(old_view.get(k) != new_view.get(k) for k in set(old_view) | set(new_view) if k != 'byteOffset'):
            raise AssertionError('bufferView metadata changed')
    for old, new in zip([old_doc['textures'][i] for i in sorted(texture_map)], new_doc.get('textures', [])):
        if any(old.get(k) != new.get(k) for k in set(old) | set(new) if k not in ('source', 'extensions')):
            raise AssertionError('texture metadata changed')
    for texture in new_doc.get('textures', []):
        (container, name), = list(texture_sources(texture))
        if container[name] >= len(new_doc.get('images', [])):
            raise AssertionError('texture image out of range')


def verify_compact_record(image, record, payload, roles):
    """Python-side re-check of one compact record against its payload bytes."""
    decoded = Image.open(io.BytesIO(payload))
    decoded.load()
    encoding = record['encoding']
    role = image_roles(roles)
    ok = (record.get('profile') == COMPACT and sha(payload) == record['payloadSHA256'] and list(decoded.size) == record['size']
          and max(decoded.size) <= COMPACT_MAX_SIDE)
    if encoding.startswith('jpeg-444'):
        from PIL import JpegImagePlugin
        ok = ok and image.get('mimeType') == 'image/jpeg' and decoded.format == 'JPEG' and role != 'color' \
            and JpegImagePlugin.get_sampling(decoded) == 0
    else:
        ok = ok and image.get('mimeType') == 'image/webp' and decoded.format == 'WEBP' \
            and (encoding == 'webp-lossless' or role == 'color')
    ok = ok and meets_thresholds(role, {'psnr': record.get('psnr', 0), 'ssim': record.get('ssim', 0),
                                        'angularMean': record.get('angularMean', 99), 'angularP99': record.get('angularP99', 99)})
    return ok


def render_compact_report(rows, mode, seconds):
    mib = lambda n: f'{n / 1048576:.2f}'  # noqa: E731
    changed = [r for r in rows if 'after' in r]
    lines = [f'# GLB compact profile report ({mode})', '',
             f'Files changed: {len(changed)}; before {mib(sum(r["before"] for r in changed))} MiB, '
             f'after {mib(sum(r["after"] for r in changed))} MiB; elapsed {seconds:.0f}s.', '',
             '| file | before | after | images compacted / kept / removed |', '|---|---:|---:|---|']
    for row in changed:
        acts = [i['action'] for i in row['images']]
        lines.append(f'| {row["path"]} | {row["before"]} | {row["after"]} | {acts.count("compact")} / {acts.count("keep")} / {row["removed"]} |')
    lines += ['', '## Per image', '']
    for row in rows:
        if 'after' not in row:
            lines.append(f'- {row["path"]}: skipped ({row.get("skip")})')
            continue
        lines.append(f'### {row["path"]} ({row["before"]} -> {row["after"]}, {row["removed"]} unreferenced images removed)')
        for i in row['images']:
            metric = '' if i['psnr'] is None else f' psnr={i["psnr"]} ssim={i["ssim"]}' + (
                f' angle mean={i["angularMean"]} p99={i["angularP99"]}' if i['angularMean'] is not None else '')
            lines.append(f'- image {i["index"]} [{", ".join(i["slots"])}] {i["role"]} {i["mime"]} {i["before"]} -> {i["after"]} '
                         f'{i["action"]} {i["encoding"] or ""} {i["size"] or ""}{metric}')
        lines.append('')
    return '\n'.join(lines) + '\n'


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
        slots = image_slots(doc)
        for index, image in enumerate(doc.get('images', [])):
            record = (image.get('extras') or {}).get(RECORD)
            if not record:
                continue
            count += 1
            if record.get('profile') == COMPACT:
                if not verify_compact_record(image, record, view_bytes(doc, binary, image['bufferView']), slots[index]):
                    failures += 1
                    print(f'MISMATCH {path.relative_to(ASSETS)} image {index} (compact)')
                continue
            decoded = Image.open(io.BytesIO(view_bytes(doc, binary, image['bufferView']))).convert('RGBA')
            ok = (image.get('mimeType') == 'image/webp' and pixel_hash(decoded) == record['pixelSHA256']
                  and list(decoded.size) == record['size']
                  and ('resizedFrom' in record or record['pixelSHA256'] == record['sourcePixelSHA256']))
            if not ok:
                failures += 1
                print(f'MISMATCH {path.relative_to(ASSETS)} image {index}')
    print(f'verified {count} converted images, {failures} mismatches')
    return failures == 0 and verify_quantized()


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
    parser.add_argument('--quantize', action='store_true', help='with --dry-run/--write: quantize skinned WEIGHTS/TANGENT (KHR_mesh_quantization) instead of re-encoding textures')
    parser.add_argument('--profile', choices=[COMPACT], help='with --dry-run/--write: owner-approved compact profile (all textures <= 512 px: colour lossy WebP, data maps JPEG 4:4:4, unreferenced images removed)')
    parser.add_argument('--report', help='write a Markdown report to this file')
    parser.add_argument('--cache', help='directory for converted WebP payloads (speeds up --write after --dry-run)')
    parser.add_argument('--min-bytes', type=int, default=None, help='only touch GLBs at least this large (default 1000000, 0 with --quantize)')
    parser.add_argument('--only', help='substring filter on the relative path')
    parser.add_argument('--workers', type=int, default=4)
    args = parser.parse_args()
    if args.verify:
        sys.exit(0 if verify_all() else 1)
    if args.min_bytes is None:
        args.min_bytes = 0 if (args.quantize or args.profile) else 1_000_000
    started, rows, changes = time.time(), [], {}
    with ProcessPoolExecutor(args.workers) as pool:
        for path in sorted(ASSETS.rglob('*.glb')):
            relative = str(path.relative_to(ASSETS))
            data = path.read_bytes()
            if len(data) < args.min_bytes or (args.only and args.only not in relative):
                continue
            try:
                row, new_data = plan_quantize(path, data) if args.quantize else plan_compact(path, data, pool, args.cache) if args.profile else plan_file(path, data, pool, args.cache)
            except Exception as error:  # noqa: BLE001
                rows.append({'path': relative, 'before': len(data), 'images': [], 'accessors': [], 'skip': f'{type(error).__name__}: {error}'})
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
    render = render_quantize_report if args.quantize else render_compact_report if args.profile else render_report
    text = render(rows, 'write' if args.write else 'dry-run', time.time() - started)
    if args.report:
        Path(args.report).parent.mkdir(parents=True, exist_ok=True)
        Path(args.report).write_text(text)
    print(text.split('\n\n')[1])


if __name__ == '__main__':
    main()
