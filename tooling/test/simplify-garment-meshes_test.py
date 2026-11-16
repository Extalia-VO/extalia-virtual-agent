"""Offline simplification regressions, requires NumPy and installed development dependencies."""
import copy
import importlib.util
from pathlib import Path
import sys
import unittest
import numpy as np

SPEC = importlib.util.spec_from_file_location('simplify_garments', Path(__file__).resolve().parents[1] / 'simplify-garment-meshes.py')
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)


def fixture():
    binary, accessors, views = bytearray(), [], []
    def add(values, kind, shape):
        values = np.asarray(values, dtype=M.DTYPES[kind])
        binary.extend(b'\0' * (-len(binary) % 4))
        views.append({'buffer': 0, 'byteOffset': len(binary), 'byteLength': values.nbytes})
        binary.extend(values.tobytes())
        accessors.append({'bufferView': len(views)-1, 'count': len(values), 'componentType': kind, 'type': shape})
        return len(accessors)-1
    size = 25
    positions = [[x/(size-1), y/(size-1), 0] for y in range(size) for x in range(size)]
    position = add(positions, 5126, 'VEC3')
    accessors[position].update(min=[0, 0, 0], max=[1, 1, 0])
    normal = add([[0, 0, 1]] * len(positions), 5126, 'VEC3')
    uv = add([p[:2] for p in positions], 5126, 'VEC2')
    joints = add([[0, 0, 0, 0]] * len(positions), 5121, 'VEC4')
    weights = add([[65535, 0, 0, 0]] * len(positions), 5123, 'VEC4')
    accessors[weights]['normalized'] = True
    indices = []
    for y in range(size-1):
        for x in range(size-1):
            i = y*size+x
            indices.extend([i, i+1, i+size, i+1, i+size+1, i+size])
    index = add(np.array(indices).reshape(-1, 1), 5123, 'SCALAR')
    ibm = add(np.eye(4).reshape(1, 16), 5126, 'MAT4')
    document = {'asset': {'version': '2.0'}, 'buffers': [{'byteLength': len(binary)}],
                'accessors': accessors, 'bufferViews': views,
                'materials': [{'name': 'OriginalTop_Test', 'pbrMetallicRoughness': {'baseColorFactor': [1, .5, .25, 1]}}],
                'meshes': [{'name': 'Fixture', 'primitives': [{'material': 0, 'indices': index, 'attributes': {
                    'POSITION': position, 'NORMAL': normal, 'TEXCOORD_0': uv, 'JOINTS_0': joints, 'WEIGHTS_0': weights}}]}],
                'nodes': [{'mesh': 0, 'skin': 0}, {'name': 'hips'}], 'skins': [{'joints': [1], 'inverseBindMatrices': ibm}],
                'scenes': [{'nodes': [0, 1]}], 'scene': 0}
    return document, bytes(binary)


class SimplifyGarmentMeshes(unittest.TestCase):
    def test_reduces_grid_and_preserves_skin_uvs_and_metadata(self):
        document, binary = fixture()
        raw = M.BUFFERS.write_glb(document, binary)
        result, report = M.simplify(raw)
        new, data = M.BUFFERS.read_glb(result)
        self.assertLess(report['afterTriangles'], report['beforeTriangles'])
        self.assertLess(len(result), len(raw))
        self.assertTrue(report['retainedVertexBytesExact'])
        for key in ('nodes', 'materials', 'scenes'):
            self.assertEqual(new[key], document[key])
        attrs = new['meshes'][0]['primitives'][0]['attributes']
        self.assertTrue(np.array_equal(M.float_array(new, data, attrs['TEXCOORD_0']), M.float_array(new, data, attrs['POSITION'])[:, :2]))
        self.assertTrue((M.stored_array(new, data, attrs['WEIGHTS_0'])[:, 0] == 65535).all())
        # All four plane borders remain represented.
        position = M.float_array(new, data, attrs['POSITION'])
        for axis in (0, 1):
            self.assertEqual(int((position[:, axis] == 0).sum()), 25)
            self.assertEqual(int((position[:, axis] == 1).sum()), 25)
        again, _ = M.simplify(raw)
        self.assertEqual(result, again)

    def test_refuses_morphs_animations_and_unknown_attributes(self):
        document, _ = fixture()
        for mutation in ('morph', 'animation', 'attribute'):
            bad = copy.deepcopy(document)
            primitive = bad['meshes'][0]['primitives'][0]
            if mutation == 'morph':
                primitive['targets'] = [{'POSITION': 0}]
            elif mutation == 'animation':
                bad['animations'] = [{}]
            else:
                primitive['attributes']['COLOR_0'] = 0
            with self.assertRaises(ValueError):
                M.validate_input(bad)

    def test_selected_accessories_preserve_unselected_geometry_bytes(self):
        document, binary = fixture()
        protected = copy.deepcopy(document['meshes'][0])
        protected['name'] = 'ProtectedBody'
        # Color arrays on protected facial hair are preserved, not simplified.
        protected['primitives'][0]['attributes']['COLOR_0'] = 1
        document['meshes'].append(protected)
        document['nodes'].append({'mesh': 1, 'skin': 0})
        raw = M.BUFFERS.write_glb(document, binary)
        output, report = M.simplify(raw, mesh_names={'Fixture'})
        new, data = M.BUFFERS.read_glb(output)
        old_primitive = protected['primitives'][0]
        new_primitive = new['meshes'][1]['primitives'][0]
        for key, index in old_primitive['attributes'].items():
            self.assertEqual(M.BUFFERS.accessor_bytes(document, binary, document['accessors'][index]),
                             M.BUFFERS.accessor_bytes(new, data, new['accessors'][new_primitive['attributes'][key]]))
        self.assertEqual(M.BUFFERS.accessor_bytes(document, binary, document['accessors'][old_primitive['indices']]),
                         M.BUFFERS.accessor_bytes(new, data, new['accessors'][new_primitive['indices']]))
        self.assertTrue(all(row['mesh'] == 0 for row in report['primitives']))
        with self.assertRaises(ValueError):
            M.simplify(raw, mesh_names={'Missing'})
        with self.assertRaises(ValueError):
            M.simplify(raw, ratio=0, mesh_names={'Fixture'})

    def test_excluded_material_primitives_are_byte_exact(self):
        document, binary = fixture()
        document['materials'].append({'name': 'PreserveMe'})
        protected = copy.deepcopy(document['meshes'][0]['primitives'][0])
        protected['material'] = 1
        offset = len(binary)
        view_count = len(document['bufferViews'])
        accessor_count = len(document['accessors'])
        document['bufferViews'] += [dict(v, byteOffset=v.get('byteOffset', 0) + offset) for v in document['bufferViews']]
        document['accessors'] += [dict(a, bufferView=a['bufferView'] + view_count) for a in document['accessors']]
        binary = binary + binary
        document['buffers'][0]['byteLength'] = len(binary)
        protected['indices'] += accessor_count
        protected['attributes'] = {key: value + accessor_count for key, value in protected['attributes'].items()}
        document['meshes'][0]['primitives'].append(protected)
        raw = M.BUFFERS.write_glb(document, binary)
        result, report = M.simplify(raw, exclude_materials=['PreserveMe'])
        new, data = M.BUFFERS.read_glb(result)
        self.assertLess(report['afterTriangles'], report['beforeTriangles'])
        a, b = protected, new['meshes'][0]['primitives'][1]
        for semantic, index in dict(a['attributes'], indices=a['indices']).items():
            new_index = b['indices'] if semantic == 'indices' else b['attributes'][semantic]
            self.assertEqual(M.BUFFERS.accessor_bytes(document, binary, document['accessors'][index]),
                             M.BUFFERS.accessor_bytes(new, data, new['accessors'][new_index]))
        with self.assertRaises(ValueError):
            M.simplify(raw, exclude_materials=['Typo'])

    def test_normalized_signed_accessors_decode_without_losing_sign(self):
        values = np.array([[-32768, 0, 32767]], dtype='<i2')
        document = {'buffers': [{'byteLength': 6}], 'bufferViews': [{'buffer': 0, 'byteLength': 6}],
                    'accessors': [{'bufferView': 0, 'componentType': 5122, 'normalized': True, 'count': 1, 'type': 'VEC3'}]}
        self.assertTrue(np.array_equal(M.float_array(document, values.tobytes(), 0), [[-1, 0, 1]]))


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--fixture':
        document, binary = fixture()
        result, _ = M.simplify(M.BUFFERS.write_glb(document, binary))
        Path(sys.argv[2]).write_bytes(result)
    else:
        unittest.main()
