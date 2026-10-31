"""Headless Blender regressions for source corners, fitting and anatomical binding.

Run with Blender --background --factory-startup --python-exit-code 1 --python
tooling/blender/check-source-garment-corners.py. Uses synthetic in-memory meshes;
does not load clothing downloads or touch the live Blender scene.
"""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest

import bmesh
import bpy
import numpy as np


SPEC = importlib.util.spec_from_file_location('source_fit_corner_check', Path(__file__).with_name('fit-source-garments.py'))
F = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(F)


def vector(value):
    return tuple(float(component) for component in value)


class SourceGarmentCorners(unittest.TestCase):
    def setUp(self):
        self.original_objects = set(bpy.data.objects)
        self.original_meshes = set(bpy.data.meshes)
        self.original_materials = set(bpy.data.materials)
        self.original_armatures = set(bpy.data.armatures)
        self.collection = bpy.data.collections.new('Synthetic source corner regression')
        bpy.context.scene.collection.children.link(self.collection)
        self.document = {'materials': [{'name': 'Name'}, {'name': 'Name'}]}

    def tearDown(self):
        for obj in set(bpy.data.objects) - self.original_objects:
            bpy.data.objects.remove(obj, do_unlink=True)
        for mesh in set(bpy.data.meshes) - self.original_meshes:
            if mesh.users == 0:
                bpy.data.meshes.remove(mesh)
        for material in set(bpy.data.materials) - self.original_materials:
            if material.users == 0:
                bpy.data.materials.remove(material)
        for armature in set(bpy.data.armatures) - self.original_armatures:
            if armature.users == 0:
                bpy.data.armatures.remove(armature)
        bpy.data.collections.remove(self.collection)

    def make_mesh(self, name, source_index, vertices, faces, uv0, uv1=None, colors=None):
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata(vertices, [], faces)
        material = bpy.data.materials.new(f'ExtaliaSourceMaterial_{source_index}_Name')
        mesh.materials.append(material)
        for channel, values in [('UVMap', uv0), ('UVMap.001', uv1)]:
            if values is not None:
                layer = mesh.uv_layers.new(name=channel, do_init=False)
                for loop, coordinates in enumerate(values):
                    layer.data[loop].uv = coordinates
        if colors is not None:
            attribute = mesh.color_attributes.new(name='Color', type='FLOAT_COLOR', domain='CORNER')
            for loop, color in enumerate(colors):
                attribute.data[loop].color = color
        mesh.update()
        obj = bpy.data.objects.new(name, mesh)
        self.collection.objects.link(obj)
        return obj

    def records(self, mesh, source_indices, *, world=None):
        result = []
        uv0 = mesh.uv_layers.get('UVMap')
        uv1 = mesh.uv_layers.get('UVMap.001')
        colors = mesh.color_attributes.get('Color')
        for face in mesh.polygons:
            source = source_indices[face.material_index]
            for loop_index in face.loop_indices:
                vertex = mesh.vertices[mesh.loops[loop_index].vertex_index].co
                position = world @ vertex if world is not None else vertex
                # All original pattern corners are compared, including distinct
                # UV/color values at the same shared position on adjacent faces.
                result.append((source, vector(position), vector(uv0.data[loop_index].uv),
                               vector(uv1.data[loop_index].uv) if uv1 else (0.0, 0.0),
                               vector(colors.data[loop_index].color) if colors and source == 1 else None))
        return sorted(result)

    def test_later_mesh_uv1_and_corner_colors_survive_join(self):
        trim = self.make_mesh('A trim first', 0,
                              [(0, 0, 0), (.5, 0, 0), (0, .5, 0)], [(0, 1, 2)],
                              [(.125, .25), (.375, .5), (.625, .75)])
        pattern = self.make_mesh('B patterned cloth second', 1,
                                 [(2, 0, 0), (3, 0, 0), (3, 1, 0), (2, 1, 0)], [(0, 1, 2), (0, 2, 3)],
                                 [(.11, .21), (.31, .41), (.51, .61), (.71, .81), (.91, .17), (.27, .37)],
                                 [(.08, .18), (.28, .38), (.48, .58), (.68, .78), (.88, .98), (.13, .23)],
                                 [(.1, .2, .3, .4), (.2, .3, .4, .5), (.3, .4, .5, .6),
                                  (.4, .5, .6, .7), (.5, .6, .7, .8), (.6, .7, .8, .9)])
        # A nonidentity object transform verifies that position comparison uses
        # the same world frame while corner attributes remain unchanged.
        pattern.location.y = .25
        bpy.context.view_layer.update()
        before_trim = self.records(trim.data, {0: 0})
        before_pattern = self.records(pattern.data, {0: 1})
        expected = sorted(self.records(trim.data, {0: 0}, world=trim.matrix_world)
                          + self.records(pattern.data, {0: 1}, world=pattern.matrix_world))
        # Deliberately reverse caller order: combine_original sorts by name, so
        # the trim without UV1/Color must still initialize the BMesh first.
        bm, materials, bindings, _colors, avatar, _records = F.combine_original(
            [pattern, trim], {'defaultRole': 'top'}, self.document)
        try:
            output = F.mesh_from_bmesh(bm, 'Combined synthetic source', materials, self.collection)
        finally:
            bm.free()
        self.assertIsNone(avatar)
        self.assertEqual(len(output.data.polygons), 3)
        self.assertEqual(len(output.data.loops), 9)
        self.assertEqual([layer.name for layer in output.data.uv_layers], ['UVMap', 'UVMap.001'])
        self.assertIn('Color', output.data.color_attributes)
        attribute = output.data.color_attributes['Color']
        self.assertEqual((attribute.domain, attribute.data_type), ('CORNER', 'FLOAT_COLOR'))
        ids = {index: bindings[material.name] for index, material in enumerate(output.data.materials)}
        self.assertEqual([ids[face.material_index] for face in output.data.polygons], [0, 1, 1])
        self.assertEqual(self.records(output.data, ids), expected)
        # Neither the evaluated import nor the merge may overwrite the source.
        self.assertEqual(self.records(trim.data, {0: 0}), before_trim)
        self.assertEqual(self.records(pattern.data, {0: 1}), before_pattern)

    def test_duplicate_authored_names_resolve_by_encoded_index(self):
        for source_index in (0, 1):
            with self.subTest(source_index=source_index):
                material = bpy.data.materials.new(f'ExtaliaSourceMaterial_{source_index}_Name')
                self.assertEqual(F.source_material_index(material, self.document), source_index)
                # Blender can suffix an already occupied encoded name; the
                # source index must still win over identical authored names.
                duplicate = bpy.data.materials.new(f'ExtaliaSourceMaterial_{source_index}_Name')
                self.assertNotEqual(duplicate.name, material.name)
                self.assertEqual(F.source_material_index(duplicate, self.document), source_index)

    def test_depth_frame_ignores_dense_front_tessellation(self):
        # Identical front/back section envelopes, but one front has 100 times
        # as many vertices. Both start 18 cm behind a symmetric reference body.
        for mode, levels in [('bottom', (.35, .55, .75)), ('top', (1.15, 1.30, 1.45))]:
            with self.subTest(mode=mode):
                body = np.array([(x, y, z) for z in levels for y in (-.08, .08)
                                 for x in np.linspace(-.15, .15, 4)])
                weights = np.zeros((len(body), len(F.M.BONES)))
                weights[:, F.M.B['hips']] = 1
                ref = SimpleNamespace(verts=body, weights=weights)
                shifts, biased_centres = [], []
                for density in (1, 100):
                    source = np.array([(x, y, z) for z in levels
                                       for y, count in ((.10, 4 * density), (.26, 4))
                                       for x in np.linspace(-.15, .15, count)])
                    bm = bmesh.new()
                    try:
                        for point in source:
                            bm.verts.new(point)
                        bm.verts.index_update()
                        before = F.M.bm_points(bm).copy()
                        biased_centres.append(float(before[:, 1].mean()))
                        F.centre_depth(bm, ref, {'mode': mode})
                        after = F.M.bm_points(bm)
                        displacement = after - before
                        np.testing.assert_array_equal(after[:, [0, 2]], before[:, [0, 2]])
                        np.testing.assert_allclose(displacement[:, 1], -.18, atol=1e-7, rtol=0)
                        np.testing.assert_allclose([after[:, 1].min(), after[:, 1].max()], [-.08, .08], atol=1e-7, rtol=0)
                        shifts.append(float(displacement[:, 1].mean()))
                    finally:
                        bm.free()
                self.assertGreater(abs(biased_centres[0] - biased_centres[1]), .07)
                self.assertAlmostEqual(shifts[0], shifts[1], places=7)

    def test_nearby_hands_and_thighs_cannot_capture_wrong_garment(self):
        # Three nearby reference triangles carry pure hand, thigh and chest
        # binding. Geometry alone prefers the wrong body part in each case.
        xz = np.array([[.20, .98], [.25, .98], [.225, 1.04]])
        body = np.array([(x, y, z) for y in (0, .04, .08) for x, z in xz])
        triangles = np.arange(9).reshape(3, 3)
        reference_weights = np.zeros((9, len(F.M.BONES)))
        for triangle, bone in zip(triangles, ('rightHand', 'rightUpperLeg', 'chest')):
            reference_weights[triangle, F.M.B[bone]] = 1
        ref = SimpleNamespace(verts=body, tris=triangles, weights=reference_weights)
        garment_xz = np.array([[.215, .995], [.235, .995], [.225, 1.02]])
        cases = [('bottom', 'bottom', 0, .001, 'rightHand', F.M.ARM_BONES, {}),
                 ('outfit', 'bottom', 3, .001, 'rightHand', F.M.ARM_BONES, {}),
                 ('top', 'top', 0, .045, 'rightUpperLeg', F.M.LEG_BONES, {}),
                 ('outfit', 'top', 2, .045, 'rightUpperLeg', F.M.LEG_BONES, {}),
                 ('outfit', 'top', 0, .001, 'rightHand', F.M.ARM_BONES, {'sleeveless': True})]
        for mode, zone, anatomy, depth, tempting_bone, forbidden, hints in cases:
            with self.subTest(mode=mode, zone=zone, anatomy=anatomy):
                points = np.array([(x, depth, z) for x, z in garment_xz])
                unconstrained = F.M.transfer_weights(points, body, triangles, reference_weights)
                np.testing.assert_allclose(unconstrained[:, F.M.B[tempting_bone]], 1, atol=1e-6)
                bm = bmesh.new()
                try:
                    for name in ('zone', 'part', 'anatomy'):
                        bm.faces.layers.int.new(name)
                    for point in points:
                        bm.verts.new(point)
                    bm.verts.ensure_lookup_table()
                    bm.verts.index_update()
                    face = bm.faces.new(list(bm.verts))
                    face[bm.faces.layers.int['zone']] = F.M.Z[zone]
                    face[bm.faces.layers.int['part']] = 0
                    face[bm.faces.layers.int['anatomy']] = anatomy
                    fitted, _owned = F.anatomical_weights(points, bm, body, ref, {'mode': mode, **hints})
                finally:
                    bm.free()
                self.assertTrue(np.isfinite(fitted).all())
                self.assertTrue((fitted >= 0).all())
                np.testing.assert_allclose(fitted.sum(1), 1, atol=1e-6)
                np.testing.assert_array_equal(fitted[:, forbidden], 0)
                self.assertTrue((np.count_nonzero(fitted, axis=1) <= 4).all())
                transforms = np.repeat(np.eye(4)[None], len(F.M.BONES), axis=0)
                transforms[forbidden, :3, 3] = [.3, -.4, .5]
                # A real skinning evaluation catches normalized but incorrect
                # cross-limb influence: raising a hand must not pull trousers.
                np.testing.assert_allclose(F.M.skin_points(points, fitted, transforms), points, atol=1e-7)
                if zone == 'bottom':
                    self.assertTrue((fitted[:, F.M.LEG_BONES].sum(1) > .99).all())

    def test_additive_underlap_samples_every_original_uv_layer_and_keeps_source_corners(self):
        uv0 = [(.1, .2), (.3, .4), (.5, .6)]
        uv1 = [(.6, .1), (.8, .3), (.9, .7)]
        obj = self.make_mesh('Original source sleeve', 1,
            [(.17, 0, 1.36), (.20, 0, 1.40), (.18, .04, 1.43)], [(0, 1, 2)], uv0, uv1)
        obj.data.materials[0].name = 'OriginalTop_P0S1'
        rig = bpy.data.objects.new('Synthetic underlap rig', bpy.data.armatures.new('Synthetic underlap rig'))
        self.collection.objects.link(rig)
        points = np.array([[.12, .03, 1.40], [.15, .03, 1.42], [.15, .06, 1.40]])
        weights = np.zeros((3, len(F.M.BONES))); weights[:, F.M.B['chest']] = 1
        ref = SimpleNamespace(verts=points, tris=np.array([[0, 1, 2]]), weights=weights, rig=rig,
            joint={'leftUpperArm': np.array([-.16, 0, 1.50]), 'rightUpperArm': np.array([.16, 0, 1.50])})
        result = F.UNDERLAP.add_armhole_gussets(obj, ref, F.M, clearance=.003,
            material_names={'OriginalTop_P0S1'}, material_name='OriginalTop_AdditiveUnderlap_S1')
        self.assertEqual(result['triangles'], 1)
        self.assertEqual(len(obj.data.polygons), 2)
        for name, expected in [('UVMap', uv0), ('UVMap.001', uv1)]:
            layer = obj.data.uv_layers[name]
            source = obj.data.polygons[0]
            np.testing.assert_allclose([layer.data[index].uv[:] for index in source.loop_indices], expected, atol=1e-7)
            np.testing.assert_allclose(result['sample_uv_layers'][name], np.mean(expected, axis=0), atol=1e-7)
            added = obj.data.polygons[1]
            np.testing.assert_allclose(layer.data[added.loop_indices[0]].uv[:], np.mean(expected, axis=0), atol=1e-7)
        self.assertNotEqual(result['sample_uv_layers']['UVMap'], result['sample_uv_layers']['UVMap.001'])

    def test_male_foot_underlay_can_extend_below_default_cutoff(self):
        coverage = F.module('source_coverage_regression', 'original-skin-coverage.py')
        points = np.array([[.07, -.02, .08], [.13, -.02, .08], [.10, .07, .10]])
        triangles = np.array([[0, 1, 2]], dtype=np.int64)
        weights = np.zeros((3, len(F.M.BONES)))
        weights[:, F.M.B['rightFoot']] = 1
        joints = {'hips': [0, 0, 1.0], 'spine': [0, 0, 1.1], 'chest': [0, 0, 1.3], 'neck': [0, 0, 1.6]}
        for side, sign in [('left', -1), ('right', 1)]:
            for suffix, x, z in [('UpperArm', .2, 1.5), ('LowerArm', .22, 1.2), ('Hand', .24, .95),
                                 ('UpperLeg', .1, 1.0), ('LowerLeg', .1, .5), ('Foot', .1, .08)]:
                joints[side + suffix] = [x * sign, 0, z]
        ref = SimpleNamespace(verts=points, tris=triangles, weights=weights,
                              joint={name: np.array(value) for name, value in joints.items()},
                              shipped_centres=np.empty((0, 3)))
        empty_points, empty_faces = np.empty((0, 3)), np.empty((0, 3), dtype=np.int64)
        np.testing.assert_array_equal(coverage.visible_skin_faces(ref, empty_points, empty_faces, 'bottom'), [False])
        np.testing.assert_array_equal(coverage.visible_skin_faces(ref, empty_points, empty_faces, 'bottom', minimum_height=-.1), [True])
        np.testing.assert_array_equal(coverage.visible_skin_faces(ref, empty_points, empty_faces, 'top', minimum_height=-.1), [False])

    def test_generated_skin_retains_small_reference_influences_during_motion(self):
        points = np.array([[0., 0., 0.], [.1, 0., 0.], [0., .1, 0.]])
        obj = self.make_mesh('Synthetic generated skin', 0, points, [(0, 1, 2)], [(0, 0)] * 3)
        rig = bpy.data.objects.new('Synthetic skin rig', bpy.data.armatures.new('Synthetic skin rig'))
        self.collection.objects.link(rig)
        weights = np.zeros((3, len(F.M.BONES)))
        weights[:, F.M.B['chest']] = .99; weights[:, F.M.B['neck']] = .01
        ref = SimpleNamespace(verts=points, weights=weights, rig=rig)
        F.bind(obj, ref, weights)
        np.testing.assert_array_equal(F.M.vertex_weights(obj)[:, F.M.B['neck']], 0)
        F.SKIN_WEIGHTS.restore_reference_skin_weights(obj, ref, F.M)
        restored = F.M.vertex_weights(obj)
        np.testing.assert_allclose(restored, weights, atol=1e-7)
        transforms = np.repeat(np.eye(4)[None], len(F.M.BONES), axis=0)
        transforms[F.M.B['neck'], :3, 3] = [0, .5, 0]
        posed = F.M.skin_points(points, restored, transforms)
        np.testing.assert_allclose(posed, F.M.skin_points(points, weights, transforms), atol=1e-7)
        np.testing.assert_allclose(posed[:, 1] - points[:, 1], .005, atol=1e-7)

    def test_sleeveless_arms_remain_continuous_when_the_bodice_occludes_them_at_rest(self):
        coverage = F.module('source_bare_arm_regression', 'original-skin-coverage.py')
        points = np.array([[.24, -.04, 1.20], [.28, -.04, 1.22], [.25, -.08, 1.21]])
        triangles = np.array([[0, 1, 2]], dtype=np.int64)
        weights = np.zeros((3, len(F.M.BONES))); weights[:, F.M.B['rightUpperArm']] = 1
        joints = {'hips': [0, 0, 1.0], 'spine': [0, 0, 1.1], 'chest': [0, 0, 1.3], 'neck': [0, 0, 1.6]}
        for side, sign in [('left', -1), ('right', 1)]:
            for suffix, x, z in [('UpperArm', .2, 1.5), ('LowerArm', .2, 1.2), ('Hand', .2, .95),
                                 ('UpperLeg', .1, 1.0), ('LowerLeg', .1, .5), ('Foot', .1, .08)]:
                joints[side + suffix] = [x * sign, 0, z]
        ref = SimpleNamespace(verts=points, tris=triangles, weights=weights,
            joint={name: np.array(value) for name, value in joints.items()}, shipped_centres=np.empty((0, 3)))
        occluder = points.copy(); occluder[:, :2] = [.2, 0] + (points[:, :2] - [.2, 0]) * 1.05
        np.testing.assert_array_equal(coverage.visible_skin_faces(ref, occluder, triangles), [False])
        torso_cloth = np.zeros_like(weights); torso_cloth[:, F.M.B['chest']] = 1
        np.testing.assert_array_equal(coverage.visible_skin_faces(ref, occluder, triangles, cloth_weights=torso_cloth), [True])
        np.testing.assert_array_equal(coverage.visible_skin_faces(ref, occluder, triangles, cloth_weights=weights), [False])
        np.testing.assert_array_equal(coverage.visible_skin_faces(ref, occluder, triangles, bare_arms=True), [True])
        ref.shipped_centres = points[triangles].mean(1)
        np.testing.assert_array_equal(coverage.visible_skin_faces(ref, occluder, triangles, bare_arms=True), [False])


    def test_posterior_pelvis_cage_clears_the_body_without_changing_source_corners(self):
        points = np.array([[x, .05, z] for z in [.81, .98, 1.15] for x in [-.20, 0, .20]])
        faces = [(r * 3 + c, r * 3 + c + 1, (r + 1) * 3 + c + 1)
                 for r in range(2) for c in range(2)]
        faces += [(r * 3 + c, (r + 1) * 3 + c + 1, (r + 1) * 3 + c)
                  for r in range(2) for c in range(2)]
        uv = [(corner % 3 / 2, corner // 3 / 8) for corner in range(len(faces) * 3)]
        obj = self.make_mesh('Posterior source', 0, points, faces, uv)
        weights = np.zeros((len(points), 20)); weights[:, F.M.B['hips']] = 1
        body = points.copy(); body[:, 1] = .09
        ref = SimpleNamespace(verts=body, tris=np.array(faces), weights=weights,
            joint={'hips': np.array([0, 0, 1.])})
        before_uv = np.array([loop.uv[:] for loop in obj.data.uv_layers.active.data])
        before_points = F.M.mesh_arrays(obj)[0]
        before_faces = [tuple(face.vertices) for face in obj.data.polygons]
        result = F.PELVIS.fit_posterior_pelvis(obj, ref, weights, {'posteriorPelvisFit': True}, F.M)
        after, _faces = F.M.mesh_arrays(obj)
        self.assertGreater(after[4, 1], .098)
        self.assertLessEqual(result['maximumDisplacement'], .08)
        np.testing.assert_array_equal(after[:, [0, 2]], before_points[:, [0, 2]])
        np.testing.assert_array_equal(before_uv, [loop.uv[:] for loop in obj.data.uv_layers.active.data])
        self.assertEqual(before_faces, [tuple(face.vertices) for face in obj.data.polygons])
        before = after.copy()
        F.PELVIS.fit_posterior_pelvis(obj, ref, weights, {}, F.M)
        np.testing.assert_array_equal(F.M.mesh_arrays(obj)[0], before)


if __name__ == '__main__':
    unittest.main(argv=['check-source-garment-corners'], verbosity=2)
