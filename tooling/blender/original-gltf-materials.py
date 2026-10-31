"""Restore original GLB material graphs without changing geometry binary bytes.

This module uses only the standard library; it does not require Blender. Bind
output material names to their original material indices. Source images must be
embedded (buffer views or data URIs). Metadata is retained for the caller's
separate publication sanitizer. Only explicit alphaMode overrides are accepted.
Duplicate source UV channels beyond Blender's eight-layer limit may alias an
existing fitted channel, after exact per-primitive source equality is proven.
"""
from copy import deepcopy
import base64
import hashlib
import json
import math
from pathlib import Path
import struct
from urllib.parse import unquote_to_bytes


JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()


def _read_glb(path):
    data = Path(path).read_bytes()
    if len(data) < 20:
        raise ValueError('Truncated GLB')
    magic, version, length = struct.unpack_from('<III', data)
    if magic != 0x46546C67 or version != 2 or length != len(data):
        raise ValueError('Expected a complete glTF 2 GLB')
    chunks, cursor = [], 12
    while cursor < len(data):
        if cursor + 8 > len(data):
            raise ValueError('Truncated GLB chunk header')
        size, kind = struct.unpack_from('<II', data, cursor)
        cursor += 8
        if size % 4 or cursor + size > len(data):
            raise ValueError('Invalid GLB chunk size')
        chunks.append((kind, data[cursor:cursor + size]))
        cursor += size
    if not chunks or chunks[0][0] != JSON_CHUNK:
        raise ValueError('GLB must start with a JSON chunk')
    if sum(kind == JSON_CHUNK for kind, _ in chunks) != 1 or sum(kind == BIN_CHUNK for kind, _ in chunks) > 1:
        raise ValueError('Duplicate GLB JSON or BIN chunks')
    document = json.loads(chunks[0][1])
    binary = next((payload for kind, payload in chunks if kind == BIN_CHUNK), b'')
    buffers = document.get('buffers', [])
    if len(buffers) > 1 or any('uri' in item for item in buffers):
        raise ValueError('Only a single embedded GLB buffer is supported')
    if buffers and not 0 <= buffers[0].get('byteLength', -1) <= len(binary):
        raise ValueError('GLB buffer length exceeds its binary chunk')
    return data, document, binary, chunks


def _at(items, index, label):
    if not isinstance(index, int) or isinstance(index, bool) or not 0 <= index < len(items):
        raise ValueError('Invalid ' + label + ' index')
    return items[index]


def _image_bytes(document, binary, image):
    if 'bufferView' in image:
        view = _at(document.get('bufferViews', []), image['bufferView'], 'image bufferView')
        start, size = view.get('byteOffset', 0), view.get('byteLength', 0)
        limit = document.get('buffers', [{}])[0].get('byteLength', len(binary))
        if view.get('buffer', 0) != 0 or start < 0 or size <= 0 or start + size > limit:
            raise ValueError('Invalid embedded image buffer range')
        return binary[start:start + size]
    uri = image.get('uri', '')
    if not uri.startswith('data:image/') or ',' not in uri:
        raise ValueError('Source images must be embedded; external image URI rejected')
    header, payload = uri.split(',', 1)
    content = base64.b64decode(payload, validate=True) if header.endswith(';base64') else unquote_to_bytes(payload)
    if not content:
        raise ValueError('Embedded image payload is empty')
    return content


def _texture_infos(value, path=''):
    """Visit standard and extension TextureInfo properties, leaving extras opaque."""
    if isinstance(value, dict):
        for key, child in value.items():
            if key == 'extras':
                continue
            child_path = path + '/' + key
            if key.lower().endswith('texture') and isinstance(child, dict):
                if 'index' not in child:
                    raise ValueError('TextureInfo is missing its index: ' + child_path)
                yield child_path, child
            else:
                yield from _texture_infos(child, child_path)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from _texture_infos(child, path + '/' + str(index))


def _image_sources(value):
    """Texture.source and image-source extensions (BasisU, WebP, AVIF, DDS)."""
    if isinstance(value, dict):
        for key, child in value.items():
            if key == 'extras':
                continue
            if key == 'source':
                yield value, key
            else:
                yield from _image_sources(child)
    elif isinstance(value, list):
        for child in value:
            yield from _image_sources(child)


def _extension_names(value):
    result = set()
    if isinstance(value, dict):
        for key, child in value.items():
            if key == 'extras':
                continue
            if key == 'extensions' and isinstance(child, dict):
                result.update(child)
            result.update(_extension_names(child))
    elif isinstance(value, list):
        for child in value:
            result.update(_extension_names(child))
    return result


def _material_receipt(document, binary, material):
    normalized = deepcopy(material)
    normalized.pop('name', None)
    normalized.pop('extras', None)
    required, uv_sets = [], set()
    for path, info in _texture_infos(normalized):
        texture = deepcopy(_at(document.get('textures', []), info['index'], 'material texture'))
        if 'sampler' in texture:
            texture['sampler'] = deepcopy(_at(document.get('samplers', []), texture['sampler'], 'sampler'))
        sources = list(_image_sources(texture))
        if not sources:
            raise ValueError('Required texture has no image source: ' + path)
        for owner, key in sources:
            image = _at(document.get('images', []), owner[key], 'texture image')
            payload = _image_bytes(document, binary, image)
            digest = _sha(payload)
            image_graph = deepcopy(image)
            image_graph.pop('bufferView', None)
            uri = image_graph.pop('uri', None)
            if uri and 'mimeType' not in image_graph:
                image_graph['mimeType'] = uri.split(';', 1)[0].split(',', 1)[0][5:]
            image_graph['payloadSHA256'] = digest
            owner[key] = image_graph
            required.append({'textureInfo': path, 'sha256': digest, 'bytes': len(payload)})
        info['index'] = texture
        texcoord = info.get('extensions', {}).get('KHR_texture_transform', {}).get('texCoord', info.get('texCoord', 0))
        if not isinstance(texcoord, int) or isinstance(texcoord, bool) or texcoord < 0:
            raise ValueError('Invalid texture coordinate set')
        uv_sets.add(texcoord)
    return {'graphSHA256': _sha(_canonical(normalized)), 'requiredImages': required,
            'requiredUVSets': sorted(uv_sets)}


def _alias_accessor_values(document, binary, index, kind='VEC2'):
    """Small local decoder used only to prove duplicate source UV channels."""
    accessor = _at(document.get('accessors', []), index, 'UV accessor')
    if accessor.get('type') != kind or 'sparse' in accessor:
        raise ValueError('UV alias proof requires a stored, uncompressed ' + kind + ' accessor')
    formats = {5121: ('B', 1, 255), 5123: ('H', 2, 65535), 5125: ('I', 4, None), 5126: ('f', 4, None)}
    if accessor.get('componentType') not in formats:
        raise ValueError('Unsupported UV alias component type')
    if ((kind == 'SCALAR' and (accessor['componentType'] == 5126 or accessor.get('normalized')))
            or (kind == 'VEC2' and accessor['componentType'] == 5125)):
        raise ValueError('Invalid UV alias index/coordinate component type')
    fmt, width, divisor = formats[accessor['componentType']]
    columns = 1 if kind == 'SCALAR' else 2
    view = _at(document.get('bufferViews', []), accessor.get('bufferView'), 'UV bufferView')
    count = accessor.get('count')
    offset, length = accessor.get('byteOffset', 0), view.get('byteLength', 0)
    stride, start = view.get('byteStride', width * columns), view.get('byteOffset', 0)
    limit = document.get('buffers', [{}])[0].get('byteLength', len(binary))
    if (type(count) is not int or count <= 0 or view.get('buffer', 0) != 0
            or 'EXT_meshopt_compression' in view.get('extensions', {})
            or any(type(value) is not int for value in (offset, length, stride, start))
            or min(offset, length, start) < 0 or stride < width * columns
            or offset + (count - 1) * stride + width * columns > length or start + length > limit):
        raise ValueError('Invalid UV alias accessor range')
    values = [struct.unpack_from('<' + fmt * columns, binary, start + offset + row * stride) for row in range(count)]
    if accessor.get('normalized') and divisor:
        values = [tuple(value / divisor for value in row) for row in values]
    if any(not math.isfinite(value) for row in values for value in row):
        raise ValueError('Non-finite coordinates cannot prove a UV alias')
    return values


def _alias_uv_corners(document, binary, primitives, channel):
    result, cache = [], {}
    def values(index, kind='VEC2'):
        if (index, kind) not in cache:
            cache[index, kind] = _alias_accessor_values(document, binary, index, kind)
        return cache[index, kind]
    for primitive in primitives:
        if primitive.get('mode', 4) != 4:
            raise ValueError('UV alias corner correspondence requires triangle primitives')
        uv = values(primitive['attributes'][channel])
        indices = [row[0] for row in values(primitive['indices'], 'SCALAR')] if 'indices' in primitive else range(len(uv))
        if len(indices) % 3 or any(index < 0 or index >= len(uv) for index in indices):
            raise ValueError('Invalid UV alias corner indices')
        result.extend(uv[index] for index in indices)
    return sorted(result)


def _restore_duplicate_uv_channels(source, source_bin, fitted, fitted_bin, bindings, indices):
    """Restore missing high UV channels only when every source primitive agrees.

    The fitted base channel is reused by accessor index, so positions, indices,
    corner data and the existing binary prefix are never rewritten or expanded.
    Nonduplicate channels require a real import path and are rejected here.
    """
    aliases, decoded, verified = [], {}, set()
    def source_values(index):
        if index not in decoded:
            decoded[index] = _alias_accessor_values(source, source_bin, index)
        return decoded[index]
    for name, source_index in bindings.items():
        originals = [primitive for mesh in source.get('meshes', []) for primitive in mesh.get('primitives', [])
                     if primitive.get('material') == source_index]
        uses = [primitive for mesh in fitted.get('meshes', []) for primitive in mesh.get('primitives', [])
                if primitive.get('material') == indices[name]]
        high = sorted({key for primitive in originals for key in primitive.get('attributes', {})
                       if key.startswith('TEXCOORD_') and key[9:].isdigit() and int(key[9:]) >= 8},
                      key=lambda key: int(key[9:]))
        for channel in high:
            missing = [primitive for primitive in uses if channel not in primitive.get('attributes', {})]
            if not missing:
                continue
            # A material-level alias cannot silently change meaning between
            # source primitives or substitute data absent from a source part.
            if any(channel not in primitive.get('attributes', {}) for primitive in originals):
                raise ValueError('Missing high UV channel is inconsistent across source primitives: ' + channel)
            candidates = sorted(set.intersection(*[
                {key for key in primitive['attributes'] if key.startswith('TEXCOORD_')
                 and key[9:].isdigit() and int(key[9:]) < 8} for primitive in originals]),
                key=lambda key: int(key[9:]))
            candidates = [base for base in candidates if all(
                base in primitive.get('attributes', {}) for primitive in missing)]
            base = next((candidate for candidate in candidates if all(
                source_values(primitive['attributes'][channel]) == source_values(primitive['attributes'][candidate])
                for primitive in originals)), None)
            if base is None:
                raise ValueError('Missing high UV channel is not an exact duplicate of an exported source channel: ' + channel)
            if (source_index, base) not in verified:
                # Several fitted material roles can share one source atlas.
                # Compare their combined corners, rather than assuming each
                # separated part represents the whole original material.
                target_indices = {indices[other] for other, original in bindings.items() if original == source_index}
                combined = [primitive for mesh in fitted.get('meshes', []) for primitive in mesh.get('primitives', [])
                            if primitive.get('material') in target_indices]
                if any(base not in primitive.get('attributes', {}) for primitive in combined):
                    raise ValueError('Exported source parts lack a corresponding UV alias base')
                expected = _alias_uv_corners(source, source_bin, originals, base)
                actual = _alias_uv_corners(fitted, fitted_bin, combined, base)
                if (len(expected) != len(actual) or any(abs(a - b) > 1e-6
                        for src, dst in zip(expected, actual) for a, b in zip(src, dst))):
                    raise ValueError('Exported UV alias base does not preserve source corner correspondence')
                verified.add((source_index, base))
            for primitive in missing:
                attrs = primitive['attributes']
                position = _at(fitted.get('accessors', []), attrs.get('POSITION'), 'POSITION accessor')
                accessor = _at(fitted.get('accessors', []), attrs[base], 'exported UV alias accessor')
                if accessor.get('count') != position.get('count'):
                    raise ValueError('Exported UV alias does not correspond to fitted vertices')
                _alias_accessor_values(fitted, fitted_bin, attrs[base])
                attrs[channel] = attrs[base]
            aliases.append({'material': name, 'sourceMaterialIndex': source_index,
                            'channel': channel, 'alias': base, 'sourcePrimitives': len(originals),
                            'fittedPrimitives': len(missing)})
    return aliases


def _encode_glb(document, binary, chunks):
    encoded = _canonical(document)
    encoded += b' ' * (-len(encoded) % 4)
    packed = binary + b'\0' * (-len(binary) % 4)
    result = []
    found_binary = False
    for kind, payload in chunks:
        if kind == JSON_CHUNK:
            payload = encoded
        elif kind == BIN_CHUNK:
            payload, found_binary = packed, True
        result.append(struct.pack('<II', len(payload), kind) + payload)
    if not found_binary and packed:
        result.insert(1, struct.pack('<II', len(packed), BIN_CHUNK) + packed)
    content = b''.join(result)
    return struct.pack('<III', 0x46546C67, 2, 12 + len(content)) + content


def graft_source_materials(source_path, fitted_path, material_bindings, overrides=None):
    """Replace named fitted materials with exact source graphs and return a receipt.

    ``material_bindings`` maps output material names to source material indices.
    ``overrides`` may map those output names to ``{'alphaMode': 'OPAQUE'}`` (or
    MASK/BLEND). All other appearance overrides are rejected. Native materials,
    texture indices, accessors and existing binary bytes stay unchanged. The
    target is written only after material graph and required UV checks pass.
    """
    if not material_bindings:
        raise ValueError('Material bindings cannot be empty')
    overrides = overrides or {}
    if set(overrides) - set(material_bindings):
        raise ValueError('Override does not name a bound material')
    source_data, source, source_bin, _ = _read_glb(source_path)
    fitted_data, fitted, fitted_bin, chunks = _read_glb(fitted_path)
    original_binary = fitted_bin
    source_materials = source.get('materials', [])
    outputs = fitted.get('materials', [])
    indices = {}
    for name, source_index in material_bindings.items():
        matches = [i for i, material in enumerate(outputs) if material.get('name') == name]
        if len(matches) != 1:
            raise ValueError('Bound output material must occur exactly once: ' + name)
        _at(source_materials, source_index, 'source material')
        indices[name] = matches[0]
        change = overrides.get(name, {})
        if set(change) - {'alphaMode'} or ('alphaMode' in change and change['alphaMode'] not in ('OPAQUE', 'MASK', 'BLEND')):
            raise ValueError('Only explicit valid alphaMode overrides are supported')

    uv_aliases = _restore_duplicate_uv_channels(source, source_bin, fitted, fitted_bin, material_bindings, indices)

    # Keep native context tables at their original indices; append the complete
    # source resource graph, so shared maps and extension fallbacks stay shared.
    image_base = len(fitted.get('images', []))
    texture_base = len(fitted.get('textures', []))
    sampler_base = len(fitted.get('samplers', []))
    binary = bytearray(fitted_bin)
    source_graph = {}
    for image in source.get('images', []):
        payload = _image_bytes(source, source_bin, image)
        binary.extend(b'\0' * (-len(binary) % 4))
        view = {'buffer': 0, 'byteOffset': len(binary), 'byteLength': len(payload)}
        binary.extend(payload)
        clone = deepcopy(image)
        uri = clone.pop('uri', None)
        if uri and 'mimeType' not in clone:
            clone['mimeType'] = uri.split(';', 1)[0].split(',', 1)[0][5:]
        clone['bufferView'] = len(fitted.setdefault('bufferViews', []))
        fitted['bufferViews'].append(view)
        fitted.setdefault('images', []).append(clone)
    if source.get('samplers'):
        fitted.setdefault('samplers', []).extend(deepcopy(source['samplers']))
    for texture in source.get('textures', []):
        clone = deepcopy(texture)
        if 'sampler' in clone:
            _at(source.get('samplers', []), clone['sampler'], 'source sampler')
            clone['sampler'] += sampler_base
        for owner, key in _image_sources(clone):
            _at(source.get('images', []), owner[key], 'source texture image')
            owner[key] += image_base
        fitted.setdefault('textures', []).append(clone)
    for name, source_index in material_bindings.items():
        expected = deepcopy(source_materials[source_index])
        expected.update(overrides.get(name, {}))
        source_graph[name] = _material_receipt(source, source_bin, expected)
        clone = deepcopy(expected)
        clone['name'] = name
        # Keep local source metadata, plus the fitted material's runtime flags.
        if isinstance(clone.get('extras', {}), dict) and isinstance(outputs[indices[name]].get('extras', {}), dict):
            extras = {**clone.get('extras', {}), **outputs[indices[name]].get('extras', {})}
            if extras:
                clone['extras'] = extras
        for _path, info in _texture_infos(clone):
            _at(source.get('textures', []), info['index'], 'source material texture')
            info['index'] += texture_base
        outputs[indices[name]] = clone

    if binary or fitted.get('buffers'):
        if not fitted.get('buffers'):
            fitted['buffers'] = [{'byteLength': len(binary)}]
        else:
            fitted['buffers'][0]['byteLength'] = len(binary)
    graph_parts = [source_materials[index] for index in material_bindings.values()]
    graph_parts += [source.get(key, []) for key in ('textures', 'images', 'samplers')]
    extensions = _extension_names(graph_parts)
    if extensions:
        fitted['extensionsUsed'] = sorted(set(fitted.get('extensionsUsed', [])) | extensions)
    required = extensions & set(source.get('extensionsRequired', []))
    if required:
        fitted['extensionsRequired'] = sorted(set(fitted.get('extensionsRequired', [])) | required)

    receipt = {'schema': 'extalia.original-material-fidelity.v1', 'sourceSHA256': _sha(source_data),
               'inputFittedSHA256': _sha(fitted_data), 'materials': {}}
    if uv_aliases:
        receipt['restoredUVChannelAliases'] = uv_aliases
    for name, index in indices.items():
        actual = _material_receipt(fitted, binary, outputs[index])
        if actual != source_graph[name]:
            raise ValueError('Source material graph or required image payload changed: ' + name)
        uses = [primitive for mesh in fitted.get('meshes', []) for primitive in mesh.get('primitives', [])
                if primitive.get('material') == index]
        if not uses:
            raise ValueError('Bound material is unused by fitted geometry: ' + name)
        for primitive in uses:
            attributes = primitive.get('attributes', {})
            position = _at(fitted.get('accessors', []), attributes.get('POSITION'), 'POSITION accessor')
            if position.get('count', 0) <= 0:
                raise ValueError('Fitted primitive has no vertices')
            for uv in actual['requiredUVSets']:
                accessor = _at(fitted.get('accessors', []), attributes.get('TEXCOORD_' + str(uv)), 'required UV accessor')
                if accessor.get('type') != 'VEC2' or accessor.get('count') != position['count']:
                    raise ValueError('Required UV accessor does not match fitted vertices')
        receipt['materials'][name] = {'sourceMaterialIndex': material_bindings[name], **actual,
                                      'alphaMode': outputs[index].get('alphaMode', 'OPAQUE'),
                                      'overrides': deepcopy(overrides.get(name, {}))}
    if bytes(binary[:len(original_binary)]) != original_binary:
        raise ValueError('Fitted geometry binary prefix changed')
    result = _encode_glb(fitted, bytes(binary), chunks)
    receipt['outputSHA256'] = _sha(result)
    Path(fitted_path).write_bytes(result)
    return receipt
