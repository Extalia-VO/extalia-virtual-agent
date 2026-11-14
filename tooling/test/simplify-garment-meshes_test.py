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
