"""Synthetic UV-audit exceptions; standard library only, no source assets needed."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from collections import Counter, defaultdict
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location('uv_audit_checks', Path(__file__).with_name('check-source-uv-fidelity.py'))
U = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(U)


class UVCorners(unittest.TestCase):
    def source(self, double_sided):
        values = [[(0,), (1,), (2,), (0,), (2,), (1,)], [(0., 0.), (.5, 0.), (0., .5)]]
        document = {'materials': [{'doubleSided': double_sided}], 'accessors': [{'count': 6}, {'type': 'VEC2', 'count': 3}],
                    'meshes': [{'primitives': [{'material': 0, 'indices': 0, 'attributes': {'TEXCOORD_0': 1}}]}]}
        return document, values

    def test_only_identical_indexed_double_sided_duplicates_are_redundant(self):
        for double_sided, expected in [(True, 1), (False, 2)]:
            document, values = self.source(double_sided)
            redundant = []
            with patch.object(U, 'decode_accessor', side_effect=lambda _doc, _bin, index: values[index]):
                corners, counts = U.collect_corners(document, b'', {0: 0}, redundant=redundant)
            self.assertEqual(counts[0], expected)
            self.assertEqual(len(corners[0]['TEXCOORD_0']), expected * 3)
            self.assertEqual(sum(item['triangles'] for item in redundant), 2 - expected)

    def test_tolerance_cannot_pass_shifted_or_missing_motif_corners(self):
        source = [(0., 0.), (.5, .25), (1., 1.)]
        self.assertTrue(U.compare_values(source, [(u, v + 1e-8) for u, v in source], 1e-5)['match'])
        self.assertFalse(U.compare_values(source, [(u, v + .01) for u, v in source], 1e-5)['match'])
        self.assertFalse(U.compare_values(source, source[:-1], 1e-5)['match'])

    def test_added_unused_uv_layer_is_allowed_but_original_layer_is_required(self):
        values = [(0., 0.), (.5, .25), (1., 1.)]
        source = {'materials': [{'name': 'Source'}]}
        fitted = {'materials': [{'name': 'Original'}]}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'candidate.glb'
            path.with_suffix('.source.json').write_text(json.dumps({'fidelity': {'materials': {
                'Original': {'sourceMaterialIndex': 0}}}}))
            for missing, expected in [(False, True), (True, False)]:
                original = defaultdict(dict, {0: {'TEXCOORD_0': values}})
                result = defaultdict(dict, {0: {'TEXCOORD_1': [(0., 0.)] * 3,
                                               **({} if missing else {'TEXCOORD_0': values})}})
                with patch.object(U, 'read_glb', side_effect=[(source, b'', 'source'), (fitted, b'', 'fitted')]), \
                     patch.object(U, 'collect_corners', side_effect=[(original, Counter({0: 1})), (result, Counter({0: 1}))]):
                    proof = U.audit(Path(directory) / 'source.glb', path)
                self.assertIs(proof['match'], expected)
                self.assertEqual(proof['materials'][0]['additionalFittedChannels'], ['TEXCOORD_1'])


if __name__ == '__main__':
    unittest.main()
