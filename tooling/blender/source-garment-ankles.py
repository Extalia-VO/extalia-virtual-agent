"""Continuous generated male ankle backing for native closed shoes (Blender Z-up metres).

Call fit_native_ankle_backing(skin, garment, ref, M, owns_source_shoes=False)
instead of tucking the reference forefoot, before joining generated context. Only
Skin_* vertex positions and weights are modified. Original clothing/shoes are read-only.
"""
import math
from collections import Counter

import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree


def _smooth(value):
    value = np.clip(value, 0., 1.)
    return value * value * (3. - 2. * value)


def _section(points, triangles, height):
    triangles = triangles[(points[triangles, 2].min(1) <= height) & (points[triangles, 2].max(1) >= height)]
    samples = []
    for first, second in ((0, 1), (1, 2), (2, 0)):
        a, b = points[triangles[:, first]], points[triangles[:, second]]
        delta = b[:, 2] - a[:, 2]
        valid = (np.abs(delta) > 1e-10) & ((a[:, 2] - height) * (b[:, 2] - height) <= 0)
        if valid.any():
            blend = (height - a[valid, 2]) / delta[valid]
            samples.append(a[valid, :2] + (b[valid, :2] - a[valid, :2]) * blend[:, None])
    return np.concatenate(samples) if samples else np.empty((0, 2))


def _ellipse(samples):
    low, high = np.quantile(samples, (.02, .98), axis=0)
    return (low + high) / 2, np.maximum((high - low) / 2, .008)


def _rim(points, triangles):
    # Auxiliary coincidence graph only: UV-seam duplicates never weld source geometry.
    keys, representatives, remap = {}, [], []
    for point in points:
        key = tuple(np.round(point / 1e-5).astype(np.int64))
        if key not in keys:
            keys[key] = len(representatives)
            representatives.append(point)
        remap.append(keys[key])
    faces = np.asarray(remap)[triangles]
    counts = Counter(tuple(sorted((int(a), int(b)))) for face in faces for a, b in zip(face, np.roll(face, -1)))
    vertices = np.asarray(representatives)
    return np.asarray([[vertices[a], vertices[b]] for (a, b), count in counts.items() if count == 1])


def _rim_radius(edges, centre, direction):
    hits = []
    for a, b in edges[:, :, :2]:
        delta = b - a
        matrix = np.column_stack((direction, -delta))
        if abs(np.linalg.det(matrix)) < 1e-10:
            continue
        radius, blend = np.linalg.solve(matrix, a - centre)
        if radius > .005 and 0 <= blend <= 1:
            hits.append(float(radius))
    return min(hits) if hits else None


def fit_native_ankle_backing(skin_obj, garment_obj, ref, math_module,
                            owns_source_shoes=False, calf_height=.18):
    """Compress a reference forefoot into an anatomically weighted, shoe-compatible ankle.

    The unchanged reference calf joins a narrow tube inside the actual native shoe rim.
    Original trouser cuffs may further constrain this generated backing; bare shorts do
    not. No faces are removed, and reference skin at/above calf_height stays exact.
    Female anatomy and source-owned footwear deliberately keep their own seam policies.
    """
    if ref.group != 'male' or owns_source_shoes is True:
        return {'movedVertices': 0, 'reason': 'not-male-native-footwear'}
    if not isinstance(owns_source_shoes, bool):
        raise ValueError('owns_source_shoes must be a boolean')
    if any(garment_obj.data.materials[face.material_index].name.startswith('OriginalShoes_')
           for face in garment_obj.data.polygons if garment_obj.data.materials[face.material_index]):
        return {'movedVertices': 0, 'reason': 'source-owned-footwear'}
    if isinstance(calf_height, bool) or not isinstance(calf_height, (float, int)) or not math.isfinite(calf_height) or not .16 <= calf_height <= .24:
        raise ValueError('calf_height must be finite and between .16 and .24 metres')
    if not skin_obj.data.materials or any(not material or not material.name.startswith('Skin_') for material in skin_obj.data.materials):
        raise ValueError('Only generated Skin_* backing can be fitted')
    M = math_module
    points, _faces = M.mesh_arrays(skin_obj)
    weights = M.vertex_weights(skin_obj)
    native = ref.objects['ScanOutfit']
    shoe_points, _faces = M.mesh_arrays(native)
    shoe_weights = M.vertex_weights(native)
    native.data.calc_loop_triangles()
    shoe_triangles = np.asarray([list(face.vertices) for face in native.data.loop_triangles
        if native.data.materials[native.data.polygons[face.polygon_index].material_index].name.startswith('OfficeShoes')], dtype=np.int64)
    if not len(shoe_triangles):
        raise ValueError('Native ankle backing requires actual OfficeShoes geometry')
    source_points, _faces = M.mesh_arrays(garment_obj)
    garment_obj.data.calc_loop_triangles()
    cloth_triangles = np.asarray([list(face.vertices) for face in garment_obj.data.loop_triangles
        if garment_obj.data.materials[garment_obj.data.polygons[face.polygon_index].material_index].name.startswith('OriginalBottom_')], dtype=np.int64).reshape(-1, 3)
    cloth_weights = M.vertex_weights(garment_obj)
    columns = [[M.B[side + part] for part in ('UpperLeg', 'LowerLeg', 'Foot')] for side in ('left', 'right')]
    shares = np.column_stack([weights[:, col].sum(1) for col in columns])
    body_shares = np.column_stack([ref.weights[:, col].sum(1) for col in columns])
    shoe_shares = np.column_stack([shoe_weights[:, col].sum(1) for col in columns])
    cloth_shares = np.column_stack([cloth_weights[:, col].sum(1) for col in columns])
    proposed, final_weights = points.copy(), weights.copy()
    reports = []
    for side_index, side in enumerate(('left', 'right')):
        ankle = np.asarray(ref.joint[side + 'Foot'])
        body_faces = ref.tris[body_shares[ref.tris, side_index].mean(1) > .5]
        shoe_faces = shoe_triangles[shoe_shares[shoe_triangles].mean(1).argmax(1) == side_index]
        edges = _rim(shoe_points, shoe_faces)
        if not len(edges):
            raise ValueError('Native shoe has no usable collar boundary: ' + side)
        ankle_centre = ankle[:2]
        local_rim = edges.reshape(-1, 3)
        local_rim = local_rim[np.linalg.norm(local_rim[:, :2] - ankle_centre, axis=1) < .075]
        if len(local_rim) < 4:
            raise ValueError('Native collar does not surround anatomical ankle: ' + side)
        # Real rim/heel-cup bounds, excluding the raised forefoot lip at the shoe's front.
        collar_height = float(np.quantile(local_rim[:, 2], .8))
        heights = np.linspace(max(.0001, float(ref.verts[:, 2].min()) + .00005), calf_height, 48)
        sections = []
        for height in heights:
            samples = _section(ref.verts, body_faces, height)
            if len(samples) >= 6:
                centre, radius = _ellipse(samples)
                sections.append((height, centre, radius))
        if len(sections) < 8:
            raise ValueError('Reference calf has insufficient sections: ' + side)
        z = np.array([row[0] for row in sections])
        centres = np.array([row[1] for row in sections])
        radii = np.array([row[2] for row in sections])
        calf_centre, calf_radius = centres[-1], radii[-1]
        native_tree = BVHTree.FromPolygons([Vector(p) for p in shoe_points], shoe_faces.tolist(), all_triangles=True)
        cloth_faces = cloth_triangles[cloth_shares[cloth_triangles].mean(1).argmax(1) == side_index] if len(cloth_triangles) else cloth_triangles
        cloth_tree = BVHTree.FromPolygons([Vector(p) for p in source_points], cloth_faces.tolist(), all_triangles=True) if len(cloth_faces) else None
        indices = np.nonzero((shares.argmax(1) == side_index) & (shares[:, side_index] > .75) & (points[:, 2] < calf_height))[0]
        vertical_hits, cuff_hits = 0, 0
        for index in indices:
            point = points[index]
            centre = np.array([np.interp(point[2], z, centres[:, axis]) for axis in range(2)])
            radius = np.array([np.interp(point[2], z, radii[:, axis]) for axis in range(2)])
            normalized = (point[:2] - centre) / radius
            length = float(np.linalg.norm(normalized))
            if length < 1e-7:
                continue
            direction = normalized / length
            actual_direction = direction * calf_radius
            actual_direction /= np.linalg.norm(actual_direction)
            rim_radius = _rim_radius(edges, ankle_centre, actual_direction)
            if rim_radius is None:
                raise ValueError('Native shoe collar ray is open: ' + side)
            calf_distance = float(np.linalg.norm(direction * calf_radius))
            tube_distance = min(calf_distance * .72, rim_radius * .82, .034)
            tube_distance = max(.016, tube_distance)
            blend = float(_smooth((point[2] - collar_height) / max(.06, calf_height - collar_height)))
            target_centre = ankle_centre * (1 - blend) + calf_centre * blend
            target_radius = tube_distance * (1 - blend) + calf_distance * blend
            radial_length = min(length, 1.12) * (1 - blend) + length * blend
            target = target_centre + actual_direction * target_radius * radial_length
            # Confirm the proxy enters the actual heel cup; source shoes remain untouched.
            vertical = native_tree.ray_cast(Vector((target[0], target[1], calf_height + .05)), Vector((0, 0, -1)), .5)
            vertical_hits += int(vertical[0] is not None)
            if cloth_tree is not None:
                samples = _section(source_points, cloth_faces, float(point[2]))
                if len(samples) >= 6:
                    cloth_centre, _cloth_radius = _ellipse(samples)
                    ray = Vector((target[0] - cloth_centre[0], target[1] - cloth_centre[1], 0))
                    distance = ray.length
                    if distance > .005:
                        ray.normalize()
                        hit = cloth_tree.ray_cast(Vector((cloth_centre[0], cloth_centre[1], point[2])), ray)
                        if hit[0] is not None and .005 < hit[3] < distance + .02:
                            safe = max(.004, hit[3] - .004)
                            if distance > safe:
                                constrained = cloth_centre + np.asarray(ray)[:2] * safe
                                # Exact unchanged calf boundary; cuff restriction fades over its last20mm.
                                fade = float(_smooth((calf_height - point[2]) / .02))
                                target = target * (1 - fade) + constrained * fade
                                cuff_hits += 1
            proposed[index, :2] = target
            # Former forefoot vertices may be Foot1 even high above the ankle. A height
            # blend prevents toe rotation pulling the proxy out through the cuff in activity.
            lower = float(_smooth((point[2] - max(collar_height, ankle[2] - .025)) / .085))
            proxy = np.zeros(len(M.BONES))
            proxy[M.B[side + 'Foot']], proxy[M.B[side + 'LowerLeg']] = 1 - lower, lower
            preserve = float(_smooth((point[2] - (calf_height - .025)) / .025))
            final_weights[index] = proxy * (1 - preserve) + weights[index] * preserve
        reports.append({'side': side, 'vertices': len(indices), 'collarHeight': collar_height,
            'actualShoeVerticalHits': vertical_hits, 'coveredCuffVertices': cuff_hits})
    moved = np.nonzero(np.linalg.norm(proposed - points, axis=1) > 1e-7)[0]
    inverse = skin_obj.matrix_world.inverted()
    groups = {group.name: group for group in skin_obj.vertex_groups}
    for index in moved:
        skin_obj.data.vertices[int(index)].co = inverse @ Vector(proposed[index])
        for group in skin_obj.vertex_groups:
            group.remove([int(index)])
        for bone, weight in zip(M.BONES, final_weights[index]):
            if weight > 1e-7:
                if bone not in groups:
                    groups[bone] = skin_obj.vertex_groups.new(name=bone)
                groups[bone].add([int(index)], float(weight), 'REPLACE')
    skin_obj.data.update()
    if len(moved) and skin_obj.data.has_custom_normals:
        skin_obj.data.normals_split_custom_set([(0, 0, 0)] * len(skin_obj.data.loops))
    return {'movedVertices': len(moved), 'maxShift': float(np.linalg.norm(proposed - points, axis=1).max()),
        'calfHeight': calf_height, 'heightAndTopologyUnchanged': True, 'originalClothingAndNativeShoesUnchanged': True,
        'sides': reports}
