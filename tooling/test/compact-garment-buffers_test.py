"""Synthetic lossless GLB storage regressions; needs only Python's standard library."""
import copy
import importlib.util
import json
import pathlib
import struct
import sys
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / 'compact-garment-buffers.py'
SPEC = importlib.util.spec_from_file_location('compact_garment_buffers', SCRIPT)
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)


def fixture():
    count = 512
    binary = bytearray()
    # Deliberate interleaving, byte offset, and otherwise unused row padding.
    for row in range(count):
        position = (1., 0., 0.) if row == 1 else (0., 1., 0.) if row == 2 else (0., 0., 0.)
        binary.extend(struct.pack('<3fI3fI', *position, 0x12345678, 0., 0., 1., 0x87654321))
    views = [{'buffer': 0, 'byteOffset': 0, 'byteLength': len(binary), 'byteStride': 32, 'target': 34962}]
    morph_offset = len(binary)
    binary.extend(bytes(count * 12))
    views.append({'buffer': 0, 'byteOffset': morph_offset, 'byteLength': count * 12})
    index_offset = len(binary)
    binary.extend(struct.pack('<3H', 0, 1, 2))
    views.append({'buffer': 0, 'byteOffset': index_offset, 'byteLength': 6, 'target': 34963})
    binary.extend(bytes(2))
    # An unreferenced buffer view proves dead storage really disappears.
    views.append({'buffer': 0, 'byteOffset': len(binary), 'byteLength': 1024})
    binary.extend(b'd' * 1024)
    doc = {'asset': {'version': '2.0'}, 'buffers': [{'byteLength': len(binary)}], 'bufferViews': views,
           'accessors': [
               {'bufferView': 0, 'componentType': 5126, 'type': 'VEC3', 'count': count,
                'min': [0, 0, 0], 'max': [1, 1, 0]},
               {'bufferView': 0, 'byteOffset': 16, 'componentType': 5126, 'type': 'VEC3', 'count': count},
               {'bufferView': 1, 'componentType': 5126, 'type': 'VEC3', 'count': count,
                'min': [0, 0, 0], 'max': [0, 0, 0]},
               {'bufferView': 2, 'componentType': 5123, 'type': 'SCALAR', 'count': 3}],
           'materials': [{'name': 'OriginalTop_Test', 'pbrMetallicRoughness': {'roughnessFactor': .75}}],
           'meshes': [{'name': 'Exact garment fixture', 'weights': [0], 'extras': {'targetNames': ['ExtaliaSeatedDrape']},
                       'primitives': [{'attributes': {'POSITION': 0, 'NORMAL': 1}, 'indices': 3,
                                       'material': 0, 'targets': [{'POSITION': 2}]}]}],
           'nodes': [{'mesh': 0}], 'scenes': [{'nodes': [0]}], 'scene': 0}
    return M.write_glb(doc, bytes(binary))


class CompactGarmentBuffers(unittest.TestCase):
    def test_deinterleave_sparse_zero_and_unused_storage(self):
        raw = fixture()
        packed, report = M.compact(raw)
        before, old_binary = M.read_glb(raw)
        after, new_binary = M.read_glb(packed)
        self.assertLess(len(packed), len(raw) // 2)
        self.assertTrue(report['verified'])
        self.assertIn('sparse', after['accessors'][0])
        self.assertNotIn('bufferView', after['accessors'][2])
        self.assertNotIn('sparse', after['accessors'][2])
        self.assertEqual(before['materials'], after['materials'])
        M.verify_equivalent(before, old_binary, after, new_binary)

    def test_existing_sparse_overlay_and_signed_zero(self):
        doc = {'asset': {'version': '2.0'}, 'buffers': [{'byteLength': 32}],
               'bufferViews': [{'buffer': 0, 'byteOffset': 0, 'byteLength': 16},
                               {'buffer': 0, 'byteOffset': 16, 'byteLength': 1},
                               {'buffer': 0, 'byteOffset': 20, 'byteLength': 4}],
               'accessors': [{'bufferView': 0, 'componentType': 5126, 'type': 'SCALAR', 'count': 4,
                              'sparse': {'count': 1, 'indices': {'bufferView': 1, 'componentType': 5121},
                                         'values': {'bufferView': 2}}}]}
        binary = struct.pack('<4f', 0., -0., 0., 0.) + b'\2\0\0\0' + struct.pack('<f', 7.) + bytes(8)
        decoded = M.accessor_bytes(doc, binary, doc['accessors'][0])
        self.assertEqual(decoded, struct.pack('<4f', 0., -0., 7., 0.))
        # Increase unused storage so the verified candidate wins the size comparison.
        binary += bytes(4096)
        doc['buffers'][0]['byteLength'] = len(binary)
        packed, _ = M.compact(M.write_glb(doc, binary))
        after, payload = M.read_glb(packed)
        self.assertEqual(M.accessor_bytes(after, payload, after['accessors'][0]), decoded)

    def test_equal_payloads_share_storage_and_normalized_metadata(self):
        payload = struct.pack('<4H', 1, 65534, 0, 0) * 128
        record = {'componentType': 5126, 'normalized': False, 'maxDeviation': 0.00001}
        doc = {'asset': {'version': '2.0'}, 'buffers': [{'byteLength': len(payload) * 2}],
               'extensionsUsed': ['KHR_mesh_quantization'], 'extensionsRequired': ['KHR_mesh_quantization'],
               'bufferViews': [{'buffer': 0, 'byteOffset': 0, 'byteLength': len(payload)},
                               {'buffer': 0, 'byteOffset': len(payload), 'byteLength': len(payload)}],
               'accessors': [{'bufferView': i, 'componentType': 5123, 'type': 'VEC4', 'count': 128,
                              'normalized': True, 'extras': {'extaliaQuantization': record}} for i in range(2)]}
        packed, report = M.compact(M.write_glb(doc, payload * 2))
        after, _ = M.read_glb(packed)
        self.assertGreater(report['sharedPayloads'], 0)
        self.assertEqual(after['accessors'][0]['bufferView'], after['accessors'][1]['bufferView'])
        self.assertTrue(after['accessors'][0]['normalized'])
        self.assertEqual(after['accessors'][0]['extras'], {'extaliaQuantization': record})
        self.assertEqual(after['extensionsRequired'], ['KHR_mesh_quantization'])

    def test_matrix_column_padding_stays_exact(self):
        # MAT3/uint8 uses three 4-byte columns per element, not nine tightly packed bytes.
        row = bytes([1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0])
        doc = {'asset': {'version': '2.0'}, 'buffers': [{'byteLength': 4096}],
               'bufferViews': [{'buffer': 0, 'byteOffset': 0, 'byteLength': 24}],
               'accessors': [{'bufferView': 0, 'componentType': 5121, 'type': 'MAT3', 'count': 2}]}
        packed, _ = M.compact(M.write_glb(doc, row * 2 + bytes(4096 - 24)))
        after, binary = M.read_glb(packed)
        self.assertEqual(M.accessor_bytes(after, binary, after['accessors'][0]), row * 2)

    def test_embedded_images_and_extension_owned_view_bytes(self):
        raw = fixture()
        doc, binary = M.read_glb(raw)
        receipt = {'sourceSHA256': '0' * 64, 'sourceBytes': 1024, 'profile': 'compact'}
        doc['images'] = [{'name': 'Original motif', 'mimeType': 'image/png', 'bufferView': 3,
                          'extras': {'extaliaImageConversion': receipt}}]
        doc['materials'][0]['pbrMetallicRoughness']['baseColorTexture'] = {'index': 0}
        doc['textures'] = [{'extensions': {'EXT_texture_webp': {'source': 0}}}]
        doc['extensionsUsed'] = ['EXT_texture_webp']
        doc['extensionsRequired'] = ['EXT_texture_webp']
        doc['extensions'] = {'EXAMPLE_raw': {'bufferView': 3}}
        packed, _ = M.compact(M.write_glb(doc, binary))
        after, new_binary = M.read_glb(packed)
        self.assertEqual(M.view_bytes(after, new_binary, after['images'][0]['bufferView']), b'd' * 1024)
        self.assertEqual(after['images'][0]['bufferView'], after['extensions']['EXAMPLE_raw']['bufferView'])
        self.assertEqual(after.get('extensionsUsed'), doc.get('extensionsUsed'))
        self.assertEqual(after['images'][0]['extras']['extaliaImageConversion'], receipt)
        self.assertEqual(after['materials'], doc['materials'])
        self.assertEqual(after['textures'], doc['textures'])

    def test_rejects_out_of_range_and_unsorted_sparse_indices(self):
        raw = fixture()
        doc, binary = M.read_glb(raw)
        doc['accessors'][0]['byteOffset'] = 100_000
        with self.assertRaisesRegex(ValueError, 'outside'):
            M.compact(M.write_glb(doc, binary))
        doc = {'buffers': [{'byteLength': 16}],
               'bufferViews': [{'buffer': 0, 'byteOffset': 0, 'byteLength': 2},
                               {'buffer': 0, 'byteOffset': 4, 'byteLength': 8}]}
        accessor = {'componentType': 5126, 'type': 'SCALAR', 'count': 4,
                    'sparse': {'count': 2, 'indices': {'bufferView': 0, 'componentType': 5121},
                               'values': {'bufferView': 1}}}
        with self.assertRaisesRegex(ValueError, 'increasing'):
            M.accessor_bytes(doc, b'\2\1' + bytes(14), accessor)

    def test_idempotent_and_never_grows(self):
        once, _ = M.compact(fixture())
        twice, report = M.compact(once)
        self.assertEqual(twice, once)
        self.assertEqual(report['saved'], 0)


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--fixture':
        pathlib.Path(sys.argv[2]).write_bytes(M.compact(fixture())[0])
        print(json.dumps({'fixture': True}))
    else:
        unittest.main()
