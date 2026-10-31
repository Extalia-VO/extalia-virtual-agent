"""Synthetic standard-library checks for native material and duplicate-UV restoration."""
from copy import deepcopy
import hashlib
import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest
import zlib


SPEC = importlib.util.spec_from_file_location('original_materials', Path(__file__).with_name('original-gltf-materials.py'))
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)


def png(rgba):
    def chunk(kind, payload):
        return struct.pack('>I', len(payload)) + kind + payload + struct.pack('>I', zlib.crc32(kind + payload))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(b'\0' + bytes(rgba))) + chunk(b'IEND', b''))


def fixture(path, materials, images, textures, *, source=False, extensions=()):
    binary, views = bytearray(), []
    # Valid geometry with two UV channels and vertex colours, retained byte-for-byte.
    records = [([0., 0., 0., 1., 0., 0., 0., 1., 0.], 'VEC3', 3),
               ([0., 0., 1., 0., 0., 1.], 'VEC2', 3),
               ([.2, .3, .6, .3, .2, .8], 'VEC2', 3),
               ([1., .2, .3, 1., .4, 1., .6, 1., .7, .8, 1., 1.], 'VEC4', 3)]
    accessors = []
    for values, kind, count in records:
        payload = struct.pack('<' + 'f' * len(values), *values)
        views.append({'buffer': 0, 'byteOffset': len(binary), 'byteLength': len(payload)})
        binary.extend(payload)
        accessors.append({'bufferView': len(views) - 1, 'componentType': 5126, 'count': count, 'type': kind})
    image_specs = []
    for payload in images:
        binary.extend(b'\0' * (-len(binary) % 4))
        views.append({'buffer': 0, 'byteOffset': len(binary), 'byteLength': len(payload)})
        binary.extend(payload)
        image_specs.append({'bufferView': len(views) - 1, 'mimeType': 'image/png'})
    doc = {'asset': {'version': '2.0', 'extras': {'credit': 'Synthetic fixture'}},
           'buffers': [{'byteLength': len(binary)}], 'bufferViews': views, 'accessors': accessors,
           'materials': deepcopy(materials), 'images': image_specs, 'textures': deepcopy(textures),
           'samplers': [{'wrapS': 33648 if source else 33071, 'wrapT': 10497, 'minFilter': 9987}],
           'meshes': [{'primitives': [{'attributes': {'POSITION': 0, 'TEXCOORD_0': 1, 'TEXCOORD_1': 2, 'COLOR_0': 3},
                                        'material': i} for i in range(len(materials))]}],
           'nodes': [{'mesh': 0}], 'scenes': [{'nodes': [0]}], 'scene': 0}
    if extensions:
        doc['extensionsUsed'] = list(extensions)
        doc['extensionsRequired'] = list(extensions)
    path.write_bytes(M._encode_glb(doc, bytes(binary), [(M.JSON_CHUNK, b''), (M.BIN_CHUNK, b''), (0x12345678, b'TEST')]))
    return M._read_glb(path)


class OriginalMaterialChecks(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.source = Path(self.directory.name) / 'source.glb'
        self.fitted = Path(self.directory.name) / 'fitted.glb'
        self.red, self.green, self.blue = (png(colour) for colour in [(240, 20, 10, 127), (10, 220, 30, 255), (40, 60, 230, 255)])

    def high_uv_fixture(self):
        fixture(self.source, [{'name': 'Source', 'pbrMetallicRoughness': {
            'baseColorTexture': {'index': 0, 'texCoord': 8}}}], [self.red], [{'source': 0}], source=True)
        _raw, source, binary, chunks = M._read_glb(self.source)
        source['meshes'][0]['primitives'][0]['attributes'].update(TEXCOORD_8=1, TEXCOORD_9=1)
        # Separate primitives sharing the same source material must all prove
        # the same alias. Their fitted material roles can be separated.
        source['meshes'][0]['primitives'].append(deepcopy(source['meshes'][0]['primitives'][0]))
        self.source.write_bytes(M._encode_glb(source, binary, chunks))
        fixture(self.fitted, [{'name': 'OriginalTop_Source'}, {'name': 'OriginalOuter_Source'}], [], [])

    def test_restores_only_proven_duplicate_uvs_without_changing_geometry_bytes(self):
        self.high_uv_fixture()
        _raw, before, binary, _chunks = M._read_glb(self.fitted)
        receipt = M.graft_source_materials(self.source, self.fitted,
            {'OriginalTop_Source': 0, 'OriginalOuter_Source': 0})
        _raw, after, packed, _chunks = M._read_glb(self.fitted)
        self.assertEqual(packed[:len(binary)], binary)
        self.assertEqual(after['accessors'], before['accessors'])
        self.assertEqual(after['nodes'], before['nodes'])
        for index, primitive in enumerate(after['meshes'][0]['primitives']):
            attrs = primitive['attributes']
            self.assertEqual(attrs['TEXCOORD_8'], attrs['TEXCOORD_0'])
            self.assertEqual(attrs['TEXCOORD_9'], attrs['TEXCOORD_0'])
            self.assertEqual(attrs['POSITION'], before['meshes'][0]['primitives'][index]['attributes']['POSITION'])
        self.assertEqual(len(receipt['restoredUVChannelAliases']), 4)
        self.assertEqual(receipt['materials']['OriginalTop_Source']['requiredUVSets'], [8])

    def test_rejects_nonduplicate_or_inconsistent_high_uvs_and_wrong_exported_base(self):
        for case in ('nonduplicate', 'primitive-disagreement', 'missing-base', 'wrong-base-values'):
            self.high_uv_fixture()
            _raw, source, binary, chunks = M._read_glb(self.source)
            primitives = source['meshes'][0]['primitives']
            if case == 'nonduplicate':
                # UV8 uses a new offset atlas, not an alias of UV0 or UV1.
                source['accessors'].append(deepcopy(source['accessors'][1]))
                accessor = source['accessors'][-1]
                source['bufferViews'].append({'buffer': 0, 'byteOffset': len(binary), 'byteLength': 24})
                accessor['bufferView'] = len(source['bufferViews']) - 1
                binary += struct.pack('<6f', .1, .1, 1.1, .1, .1, 1.1)
                source['buffers'][0]['byteLength'] = len(binary)
                for primitive in primitives: primitive['attributes']['TEXCOORD_8'] = len(source['accessors']) - 1
            elif case == 'primitive-disagreement':
                primitives[1]['attributes']['TEXCOORD_8'] = 2
            self.source.write_bytes(M._encode_glb(source, binary, chunks))
            _raw, fitted, binary, chunks = M._read_glb(self.fitted)
            if case == 'missing-base':
                for primitive in fitted['meshes'][0]['primitives']:
                    primitive['attributes'].pop('TEXCOORD_0')
            elif case == 'wrong-base-values':
                binary = bytearray(binary)
                view = fitted['bufferViews'][fitted['accessors'][1]['bufferView']]
                struct.pack_into('<f', binary, view['byteOffset'], .125)
            self.fitted.write_bytes(M._encode_glb(fitted, bytes(binary), chunks))
            before = self.fitted.read_bytes()
            with self.subTest(case=case), self.assertRaisesRegex(ValueError, 'UV|duplicate|correspondence'):
                M.graft_source_materials(self.source, self.fitted,
                    {'OriginalTop_Source': 0, 'OriginalOuter_Source': 0})
            self.assertEqual(self.fitted.read_bytes(), before)

    def test_uv2_extensions_alpha_and_native_context(self):
        original = {'name': 'Pattern', 'alphaMode': 'BLEND', 'alphaCutoff': .33, 'doubleSided': True,
                    'extras': {'credit': 'Synthetic source'},
                    'pbrMetallicRoughness': {'baseColorFactor': [.4, .5, .6, .7], 'baseColorTexture': {
                        'index': 0, 'texCoord': 0, 'extensions': {'KHR_texture_transform': {
                            'texCoord': 1, 'offset': [.1, .2], 'scale': [2, 3], 'rotation': .4}}}},
                    'normalTexture': {'index': 1, 'texCoord': 1, 'scale': .63},
                    'extensions': {'KHR_materials_clearcoat': {'clearcoatFactor': .8, 'clearcoatNormalTexture': {'index': 1, 'scale': .2}},
                                   'KHR_materials_transmission': {'transmissionTexture': {'index': 0, 'texCoord': 1}}}}
        fixture(self.source, [original], [self.red, self.green], [{'source': 0, 'sampler': 0}, {'source': 1, 'sampler': 0}], source=True,
                extensions=['KHR_texture_transform', 'KHR_materials_clearcoat', 'KHR_materials_transmission'])
        native = {'name': 'NativeContext', 'pbrMetallicRoughness': {'baseColorTexture': {'index': 0}}}
        _, before, binary, chunks = fixture(self.fitted, [{'name': 'OriginalTop_Pattern', 'extras': {'preserveNativeColor': True}}, native],
                                            [self.blue], [{'source': 0, 'sampler': 0}])
        receipt = M.graft_source_materials(self.source, self.fitted, {'OriginalTop_Pattern': 0})
        data, after, new_binary, new_chunks = M._read_glb(self.fitted)
        self.assertEqual(after['meshes'], before['meshes'])
        self.assertEqual(after['accessors'], before['accessors'])
        self.assertEqual(new_binary[:len(binary)], binary)
        self.assertEqual(new_chunks[-1], chunks[-1])
        self.assertEqual(after['materials'][1], native)
        self.assertEqual(after['textures'][0], before['textures'][0])
        self.assertEqual(after['samplers'][0], before['samplers'][0])
        self.assertEqual(M._image_bytes(after, new_binary, after['images'][0]), self.blue)
        graft = after['materials'][0]
        self.assertEqual(graft['alphaMode'], 'BLEND')
        self.assertEqual(graft['normalTexture'], {'index': 2, 'texCoord': 1, 'scale': .63})
        self.assertEqual(graft['pbrMetallicRoughness']['baseColorTexture']['extensions'], original['pbrMetallicRoughness']['baseColorTexture']['extensions'])
        self.assertTrue(graft['extras']['preserveNativeColor'])
        self.assertEqual(graft['extras']['credit'], 'Synthetic source')
        record = receipt['materials']['OriginalTop_Pattern']
        self.assertEqual(record['requiredUVSets'], [0, 1])
        self.assertEqual({row['sha256'] for row in record['requiredImages']}, {M._sha(self.red), M._sha(self.green)})
        self.assertEqual(receipt['outputSHA256'], hashlib.sha256(data).hexdigest())

    def test_shared_maps_extension_image_sources_and_explicit_override(self):
        materials = [{'name': 'A', 'alphaMode': 'MASK', 'alphaCutoff': .6, 'emissiveTexture': {'index': 0}},
                     {'name': 'B', 'alphaMode': 'BLEND', 'normalTexture': {'index': 0, 'scale': .4},
                      'occlusionTexture': {'index': 0, 'strength': .35}}]
        texture = {'source': 0, 'sampler': 0, 'extensions': {'EXT_texture_webp': {'source': 1}}}
        fixture(self.source, materials, [self.red, self.green], [texture], source=True, extensions=['EXT_texture_webp'])
        fixture(self.fitted, [{'name': 'Top'}, {'name': 'Outer'}], [self.blue], [{'source': 0, 'sampler': 0}])
        receipt = M.graft_source_materials(self.source, self.fitted, {'Top': 0, 'Outer': 1}, {'Outer': {'alphaMode': 'OPAQUE'}})
        _, doc, binary, _ = M._read_glb(self.fitted)
        self.assertEqual(len(doc['images']), 3)
        self.assertEqual(doc['textures'][1], {'source': 1, 'sampler': 1, 'extensions': {'EXT_texture_webp': {'source': 2}}})
        self.assertEqual(doc['materials'][0]['alphaMode'], 'MASK')
        self.assertEqual(doc['materials'][0]['alphaCutoff'], .6)
        self.assertEqual(doc['materials'][1]['alphaMode'], 'OPAQUE')
        self.assertEqual(doc['materials'][1]['occlusionTexture']['strength'], .35)
        self.assertIn('EXT_texture_webp', doc['extensionsRequired'])
        self.assertEqual([M._image_bytes(doc, binary, item) for item in doc['images']], [self.blue, self.red, self.green])
        self.assertEqual(receipt['materials']['Outer']['overrides'], {'alphaMode': 'OPAQUE'})
        # An unbound material may not acquire an implicit override.
        before = self.fitted.read_bytes()
        with self.assertRaises(ValueError):
            M.graft_source_materials(self.source, self.fitted, {'Top': 0}, {'Outer': {'alphaMode': 'OPAQUE'}})
        self.assertEqual(self.fitted.read_bytes(), before)

    def test_missing_maps_missing_uv_empty_exports_fail_without_writing(self):
        fixture(self.source, [{'name': 'Pattern', 'pbrMetallicRoughness': {'baseColorTexture': {'index': 0, 'texCoord': 1}}}],
                [self.red], [{'source': 0}], source=True)
        fixture(self.fitted, [{'name': 'Top'}], [], [])
        clean_source, clean_fitted = self.source.read_bytes(), self.fitted.read_bytes()
        cases = ['empty-bindings', 'missing-image', 'missing-uv', 'empty-meshes', 'unused-material', 'unsupported-override']
        for case in cases:
            with self.subTest(case=case):
                self.source.write_bytes(clean_source)
                self.fitted.write_bytes(clean_fitted)
                path = self.source if case == 'missing-image' else self.fitted
                _, doc, binary, chunks = M._read_glb(path)
                if case == 'missing-image':
                    doc['images'] = []
                elif case == 'missing-uv':
                    del doc['meshes'][0]['primitives'][0]['attributes']['TEXCOORD_1']
                elif case == 'empty-meshes':
                    doc['meshes'] = []
                elif case == 'unused-material':
                    doc['materials'].append({'name': 'Unused'})
                    doc['meshes'][0]['primitives'][0]['material'] = 1
                path.write_bytes(M._encode_glb(doc, binary, chunks))
                before = self.fitted.read_bytes()
                with self.assertRaises(ValueError):
                    M.graft_source_materials(self.source, self.fitted, {} if case == 'empty-bindings' else {'Top': 0},
                                             {'Top': {'doubleSided': False}} if case == 'unsupported-override' else None)
                self.assertEqual(self.fitted.read_bytes(), before)


if __name__ == '__main__':
    unittest.main(verbosity=2)
