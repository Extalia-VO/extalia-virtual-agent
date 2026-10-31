"""Synthetic Blender regressions for connected cloth and fitted-pose skinning.

Run with Blender --background --factory-startup --python-exit-code 1 --python
tooling/blender/check-avatar-outfit-fit.py. No downloaded assets, reference bodies,
profile directories or output files are used.
"""
import importlib.util
import math
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import bmesh
import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree


SPEC = importlib.util.spec_from_file_location(
    "avatar_outfits", Path(__file__).with_name("prepare-avatar-outfits.py"))
OUTFITS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(OUTFITS)


def grid(size, separation=None, split=False):
    """A 40 cm cloth patch, optionally with independent vertices per triangle."""
    vertices = [(x / size * .4 - .2, depth, .7 + z / size * .4)
                for depth in ([0, separation] if separation is not None else [0])
                for z in range(size + 1) for x in range(size + 1)]
    faces = []
    for layer in range(2 if separation is not None else 1):
        offset = layer * (size + 1) ** 2
        for z in range(size):
            for x in range(size):
                a = offset + z * (size + 1) + x
                b, c, d = a + 1, a + size + 1, a + size + 2
                faces.extend([(a, b, d), (a, d, c)])
    if split:
        vertices = [vertices[index] for face in faces for index in face]
        faces = [tuple(range(index, index + 3)) for index in range(0, len(vertices), 3)]
    return np.array(vertices), np.array(faces)


def mesh_object(vertices, faces, name="Synthetic cloth"):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices.tolist(), [], faces.tolist())
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    bpy.context.view_layer.update()
    return obj


def topology(bm):
    unseen = set(bm.verts)
    components = 0
    while unseen:
        components += 1
        pending = [unseen.pop()]
        while pending:
            for edge in pending.pop().link_edges:
                for vertex in edge.verts:
                    if vertex in unseen:
                        unseen.remove(vertex)
                        pending.append(vertex)
    boundary = [edge for edge in bm.edges if edge.is_boundary]
    boundary_vertices = {vertex for edge in boundary for vertex in edge.verts}
    return components, boundary, boundary_vertices


class OutfitFitRegression(unittest.TestCase):
    def tearDown(self):
        for obj in list(bpy.data.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
        for mesh in list(bpy.data.meshes):
            if mesh.users == 0:
                bpy.data.meshes.remove(mesh)

    def test_triangle_seams_are_connected_before_heavy_source_decimation(self):
        vertices, faces = grid(32, split=True)
        obj = mesh_object(vertices, faces)
        # Exercise combine's real Stage one path (>1,500 source faces), not just the weld helper.
        bm, avatar, _colours = OUTFITS.combine([obj], {"predecimate": 512})
        try:
            components, boundary, boundary_vertices = topology(bm)
            self.assertIsNone(avatar)
            self.assertLessEqual(len(bm.faces), 520)
            self.assertGreater(len(bm.faces), 300)
            self.assertEqual(components, 1, "collapse opened independent cloth islands")
            self.assertEqual(len(bm.verts) - len(bm.edges) + len(bm.faces), 1)
            self.assertGreater(len(boundary), 3)
            self.assertTrue(all(sum(edge.is_boundary for edge in vertex.link_edges) == 2
                                for vertex in boundary_vertices), "cloth boundary is not a closed loop")
            self.assertTrue(all(len(edge.link_faces) in (1, 2) for edge in bm.edges))
            self.assertAlmostEqual(sum(face.calc_area() for face in bm.faces), .16, delta=.002)
        finally:
            bm.free()

    def test_close_parallel_shells_remain_separate(self):
        vertices, faces = grid(8, separation=.0001, split=True)
        obj = mesh_object(vertices, faces)
        OUTFITS.weld_source_seams(obj)
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        try:
            components, boundary, _ = topology(bm)
            self.assertEqual(len(bm.verts), 2 * 9 ** 2)
            self.assertEqual(components, 2, "a 0.1 mm lining must not merge into the outer shell")
            self.assertEqual(len(boundary), 2 * 4 * 8)
            self.assertAlmostEqual(max(v.co.y for v in bm.verts) - min(v.co.y for v in bm.verts), .0001, places=8)
        finally:
            bm.free()

    def test_process_roundtrips_source_pose_using_the_exported_weights(self):
        # Isolate skinning from body registration/collision: use a synthetic reference and
        # identity fitting stages, retaining real transfer, smoothing, limiting and mesh export.
        vertices, faces = grid(6)
        weights = np.zeros((len(vertices), len(OUTFITS.BONES)))
        for index in range(6):
            weights[:, index + 1] = .1 + (np.sin(vertices[:, 0] * 19 + vertices[:, 2] * 13 + index) + 1) * .3
        weights /= weights.sum(1, keepdims=True)
        mats = np.repeat(np.eye(4)[None, :, :], len(OUTFITS.BONES), axis=0)
        for index in range(1, 7):
            angle = (index - 3) * .19
            c, s = math.cos(angle), math.sin(angle)
            mats[index, :2, :2] = [[c, -s], [s, c]]
            mats[index, :3, 3] = [.03 * index, -.015 * index, .01 * index]
        posed = OUTFITS.skin_points(vertices, weights, mats)
        cloth = mesh_object(posed + [0, -.012, 0], faces)
        armature = bpy.data.armatures.new("Synthetic rig")
        rig = bpy.data.objects.new("Synthetic rig", armature)
        bpy.context.scene.collection.objects.link(rig)
        bvh = BVHTree.FromPolygons([Vector(point) for point in vertices], faces.tolist())
        reference = SimpleNamespace(verts=vertices, tris=faces, core_tris=faces, weights=weights,
                                    bvh=bvh, core_bvh=bvh, rig=rig, pose=lambda rotations: mats)
        collection = bpy.data.collections.new("Synthetic outfit regression")
        bpy.context.scene.collection.children.link(collection)
        captured = {}
        transfer = OUTFITS.transfer_weights

        def capture_transfer(points, *args):
            captured["posed"] = points.copy()
            result = transfer(points, *args)
            captured["raw_weights"] = result.copy()
            return result

        replacements = {
            "Reference": lambda *args: reference,
            "import_source": lambda *args: [cloth],
            "normalise": lambda *args: True,
            "register": lambda *args, **kwargs: None,
            "assign_zones": lambda *args: {"top": [1, 1, 1]},
            "limb_rotations": lambda *args: {},
            "push_out": lambda points, *args, **kwargs: points.copy(),
            "orient_outward": lambda *args: 0,
            "separate_layers": lambda points, triangles, *args: (points, np.ones(len(triangles), bool)),
            "borrowed_parts": lambda *args: [],
            "visible_skin": lambda *args: np.zeros(len(faces), bool),
            "transfer_weights": capture_transfer,
        }
        try:
            with patch.multiple(OUTFITS, **replacements):
                _, outfit, _stats = OUTFITS.process(
                    {"id": "outfit-synthetic", "group": "female", "barefoot": True,
                     "zones": [["object", ".*", "top"]]}, "synthetic", collection)
            final_weights = OUTFITS.vertex_weights(outfit)
            rest, _ = OUTFITS.mesh_arrays(outfit)
            self.assertTrue(np.any(np.count_nonzero(captured["raw_weights"], axis=1) > 4))
            self.assertTrue(np.all(np.count_nonzero(final_weights, axis=1) <= 4))
            self.assertGreater(np.max(np.abs(final_weights - captured["raw_weights"])), .02,
                               "fixture must exercise smoothing and influence reduction")
            recovered = OUTFITS.skin_points(rest, final_weights, mats)
            error = float(np.linalg.norm(recovered - captured["posed"], axis=1).max())
            self.assertLess(error, 1e-6, "final exported weights no longer recover the fitted source pose")
            print("Source-pose roundtrip maximum error: %.9g m" % error)
        finally:
            bpy.data.collections.remove(collection)

    def test_original_panel_seams_share_weights_without_collapsing_dense_borders(self):
        spec = importlib.util.spec_from_file_location('original_sets', Path(__file__).with_name('fit-original-sets.py'))
        original_sets = importlib.util.module_from_spec(spec);spec.loader.exec_module(original_sets)
        points, source, parts, triangles = [], [], [], []
        for part, sign in [(1, -1), (2, 1)]:
            offset = len(points)
            for row in range(6):
                z = 1.5 + row * .001  # Denser than the matching tolerance: never merge along the seam.
                for column in range(2):
                    x = 0 if column == 0 else sign * .02
                    source.append((x, 0, z));points.append((sign * .005 if column == 0 else x, 0, z));parts.append(part)
            for row in range(5):
                a = offset + row * 2;triangles.extend([(a, a + 1, a + 3), (a, a + 3, a + 2)])
        obj = mesh_object(np.array(points), np.array(triangles), 'Original panels')
        obj.data.attributes.new('Original fit coordinates', 'FLOAT_VECTOR', 'POINT').data.foreach_set('vector', np.array(source).reshape(-1))
        obj.data.attributes.new('Original fit part', 'INT', 'POINT').data.foreach_set('value', parts)
        uv = obj.data.uv_layers.new(name='Source UV')
        for index, loop in enumerate(obj.data.loops):
            uv.data[index].uv = ((loop.vertex_index % 2), (loop.vertex_index // 2 % 6) / 5)
        for name in OUTFITS.BONES:
            obj.vertex_groups.new(name=name)
        obj.vertex_groups['chest'].add(list(range(12)), 1, 'REPLACE')
        obj.vertex_groups['leftUpperArm'].add(list(range(12, 24)), 1, 'REPLACE')
        original_sets.sew_source_seams(obj, {2})
        self.assertEqual(len(obj.data.vertices), 18)
        seam = [vertex for vertex in obj.data.vertices if abs(vertex.co.x) < 1e-6]
        self.assertEqual(len(seam), 6)
        self.assertAlmostEqual(max(v.co.z for v in seam) - min(v.co.z for v in seam), .005, places=6)
        weights = OUTFITS.vertex_weights(obj)
        for vertex in seam:
            self.assertAlmostEqual(weights[vertex.index, OUTFITS.B['chest']], .5, places=6)
            self.assertAlmostEqual(weights[vertex.index, OUTFITS.B['leftUpperArm']], .5, places=6)
        self.assertEqual(len(obj.data.uv_layers), 1)
        self.assertTrue(np.allclose(weights.sum(1), 1))


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(OutfitFitRegression)
    if not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful():
        raise RuntimeError("Avatar outfit fit regressions failed")
