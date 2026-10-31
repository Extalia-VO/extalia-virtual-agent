"""Run in Blender: shared-field containment, layer-gap and immutable-input checks."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest

import numpy as np


SPEC = importlib.util.spec_from_file_location(
    'checked_layered_drape', Path(__file__).with_name('source-garment-layered-drape.py'))
L = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(L)


def cylinder(radius, levels, segments=48, caps=False):
    points = np.array([(radius * np.cos(angle), radius * np.sin(angle), height)
                       for height in levels for angle in np.arange(segments) * 2 * np.pi / segments])
    faces = []
    for row in range(len(levels) - 1):
        for column in range(segments):
            first = row * segments + column
            second = row * segments + (column + 1) % segments
            faces.extend([(first, second, second + segments), (first, second + segments, first + segments)])
    if caps:
        start = len(points)
        points = np.vstack([points, (0, 0, levels[0]), (0, 0, levels[-1])])
        for column in range(segments):
            other = (column + 1) % segments
            faces.extend([(start, other, column),
                          (start + 1, (len(levels) - 1) * segments + column,
                           (len(levels) - 1) * segments + other)])
    return points, np.asarray(faces, dtype=np.int64)


class SharedLayerField(unittest.TestCase):
    def setUp(self):
        body, faces = cylinder(.1, [.65, 1.2], caps=True)
        body_weights = np.zeros((len(body), 3))
        body_weights[:, 1] = 1
        self.ref = SimpleNamespace(verts=body, tris=faces, weights=body_weights,
            joint={'leftUpperLeg': np.array([-.1, 0., 1.]), 'rightUpperLeg': np.array([.1, 0., 1.])})
        def skin(points, weights, matrices):
            homogeneous = np.column_stack([points, np.ones(len(points))])
            return np.einsum('nb,bij,nj->ni', weights, matrices, homogeneous)[:, :3]
        self.math = SimpleNamespace(ARM_BONES=[2], skin_points=skin)
        self.matrices = np.repeat(np.eye(4)[None], 3, axis=0)

    def test_nested_layers_clear_body_with_the_same_displacement_and_keep_inputs(self):
        inner, triangles = cylinder(.09, np.linspace(.8, 1.05, 6))
        outer, _ = cylinder(.094, np.linspace(.8, 1.05, 6))
        count = len(inner)
        points = np.vstack([inner, outer, (0., 0., .95)])
        triangles = np.vstack([triangles, triangles + count])
        selected = np.ones(len(points), dtype=bool)
        selected[-1] = False  # Protected body/context point must never move.
        weights = np.zeros((len(points), 3))
        weights[:, 1] = 1
        before, faces_before, weights_before = points.copy(), triangles.copy(), weights.copy()
        fitted, report = L.fit_shared_vector(points, points, triangles, selected, self.ref,
                                             weights, self.matrices, self.math, outer_iterations=3)
        self.assertTrue(np.array_equal(points, before))
        self.assertTrue(np.array_equal(triangles, faces_before))
        self.assertTrue(np.array_equal(weights, weights_before))
        self.assertTrue(np.array_equal(fitted[-1], points[-1]))
        np.testing.assert_allclose(fitted[count:count * 2] - fitted[:count], outer - inner, atol=1e-10)
        self.assertGreater(np.linalg.norm(fitted[:count, :2], axis=1).min(), .101)
        self.assertLessEqual(report['maximumShift'], .08 + 1e-10)
        self.assertLess(report['maximumHeightSlope'], 1.)
        self.assertLess(report['maximumAngularSlopeAt8cmRadius'], 1.)

    def test_already_clear_cloth_is_exact_and_excessive_displacement_is_rejected(self):
        points, triangles = cylinder(.14, [.8, 1.05])
        selected = np.ones(len(points), dtype=bool)
        weights = np.zeros((len(points), 3))
        weights[:, 1] = 1
        fitted, _ = L.fit_shared_vector(points, points, triangles, selected, self.ref,
                                        weights, self.matrices, self.math)
        self.assertTrue(np.array_equal(fitted, points))
        with self.assertRaises(ValueError):
            L.fit_shared_vector(points, points, triangles, selected, self.ref,
                                weights, self.matrices, self.math, maximum=.081)

    def test_unreviewed_source_cannot_enable_this_gown_solver(self):
        with self.assertRaises(ValueError):
            L.add_layered_seated_drape(None, SimpleNamespace(group='female'), None, None, None,
                source_id='other-source', seated_matrices=lambda *_: None, waist=1.04,
                pose_profile={}, tall_pose_profile={}, short_pose_profile={})


if __name__ == '__main__':
    unittest.main(argv=['check-source-layered-drape'])
