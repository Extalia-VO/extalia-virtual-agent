"""Anatomical radial coverage for generated skin beneath original clothing.

``visible_skin_faces(ref, vertices, opaque_triangles, mode='outfit')`` returns a
mask over ``ref.tris``. Inputs are rest-pose Blender Z-up metres. Pass only opaque
garment/context triangles: transparent fabric must retain its body underlay.
No source garment vertices, faces, materials or binding are modified.
"""
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree


# The reference exporter stores this fixed public 20-joint order.
REGION_COLUMNS = ((6, 7, 8, 9), (10, 11, 12, 13), (14, 15, 16), (17, 18, 19))


def _regions(weights):
    limbs = np.stack([weights[:, columns].sum(1) for columns in REGION_COLUMNS], axis=1)
    return np.c_[np.maximum(0, 1 - limbs.sum(1)), limbs]


def _near_segment(point, start, end):
    delta = end - start
    t = np.clip(np.dot(point - start, delta) / max(np.dot(delta, delta), 1e-12), 0, 1)
    return start + delta * t


def _axes(ref):
    chains = {}
    for region, side, names in ((1, 'left', ('UpperArm', 'LowerArm', 'Hand')),
                                (2, 'right', ('UpperArm', 'LowerArm', 'Hand')),
                                (3, 'left', ('UpperLeg', 'LowerLeg', 'Foot')),
                                (4, 'right', ('UpperLeg', 'LowerLeg', 'Foot'))):
        chains[region] = [np.asarray(ref.joint[side + name], dtype=float) for name in names]
    spine = np.array([ref.joint[name] for name in ('hips', 'spine', 'chest', 'neck')])
    return chains, spine[np.argsort(spine[:, 2])]


def _origin(point, region, chains, spine):
    if region == 0:
        return np.array([np.interp(point[2], spine[:, 2], spine[:, 0]),
                         np.interp(point[2], spine[:, 2], spine[:, 1]), point[2]])
    candidates = [_near_segment(point, a, b) for a, b in zip(chains[region], chains[region][1:])]
    return min(candidates, key=lambda candidate: np.dot(point - candidate, point - candidate))


def _cloth_trees(points, triangles, body_tree, body_regions, chains, hips, cloth_regions=None):
    """Assign occluders by nearby body anatomy, not a single whole-body ray tree."""
    if not len(triangles):
        return [None] * 5
    owners = np.zeros((len(points), 5), dtype=bool)
    if cloth_regions is not None:
        owners = cloth_regions >= np.maximum(.18, cloth_regions.max(1) * .45)[:, None]
    for index in np.unique(triangles):
        if cloth_regions is not None:
            continue
        _near, _normal, face, _distance = body_tree.find_nearest(Vector(points[index]))
        if face is not None:
            row = body_regions[face]
            owners[index, row >= max(.18, float(row.max()) * .45)] = True
            # A narrow sleeve inside the upper arm can be nearer the torso skin
            # on its medial side. Its anatomical arm axis remains unambiguous.
            # Restrict this correction above the waist so trouser hips cannot
            # become forearm occluders beside a hanging hand.
            if points[index, 2] > hips + .10 and int(row.argmax()) == 0:
                for region in (1, 2):
                    chain = chains[region]
                    near = min((_near_segment(points[index], a, b) for a, b in zip(chain, chain[1:])),
                               key=lambda point: np.linalg.norm(points[index] - point))
                    if np.linalg.norm(points[index] - near) < .060:
                        owners[index, region] = True
    assignments = np.any(owners[triangles], axis=1)
    vertices = [Vector(point) for point in points]
    return [BVHTree.FromPolygons(vertices, triangles[assignments[:, region]].tolist(), all_triangles=True)
            if assignments[:, region].any() else None for region in range(5)]


def visible_skin_faces(ref, cloth_vertices, opaque_triangles, mode='outfit', minimum_height=.14, bare_arms=False,
                       cloth_weights=None, skirt_backing=False):
    """Return visible native skin, including a small concealed overlap at cloth hems.

    Rays start on the anatomical axis, so opaque cloth still covers skin when a
    fitted sleeve/trouser surface lies slightly inside the reference body's
    radius. Region-specific trees and same-side limits prevent unrelated clothes
    from hiding a bare limb. Two of three interior face samples must be covered.
    """
    if mode not in ('outfit', 'top', 'bottom', 'outer'):
        raise ValueError('Unknown source garment coverage mode: ' + str(mode))
    points = np.asarray(cloth_vertices, dtype=float).reshape(-1, 3)
    triangles = np.asarray(opaque_triangles, dtype=np.int64).reshape(-1, 3)
    body = np.asarray(ref.verts, dtype=float)
    faces = np.asarray(ref.tris, dtype=np.int64)
    if not np.isfinite(points).all() or (len(triangles) and (triangles.min() < 0 or triangles.max() >= len(points))):
        raise ValueError('Invalid opaque garment geometry')
    if mode == 'outer':
        return np.zeros(len(faces), dtype=bool)
    vertex_regions = _regions(np.asarray(ref.weights))
    face_regions = vertex_regions[faces].mean(1)
    region_ids = face_regions.argmax(1)
    centres = body[faces].mean(1)
    chains, spine = _axes(ref)
    body_tree = getattr(ref, 'bvh', None) or BVHTree.FromPolygons(
        [Vector(point) for point in body], faces.tolist(), all_triangles=True)
    hips = float(ref.joint['hips'][2])
    cloth_regions = None
    if cloth_weights is not None:
        cloth_weights = np.asarray(cloth_weights)
        if cloth_weights.shape != (len(points), 20) or not np.isfinite(cloth_weights).all() or np.any(cloth_weights < 0):
            raise ValueError('Cloth coverage weights must use the canonical 20-joint order')
        # Reviewed garment ownership wins over proximity: a skirt beside a
        # hanging forearm must never permanently cut its bare skin away.
        cloth_regions = _regions(cloth_weights)
    trees = _cloth_trees(points, triangles, body_tree, face_regions, chains, hips, cloth_regions)
    if bare_arms:
        # A sleeveless bodice can occlude the medial arm at rest. That arm is
        # exposed after it moves: keep its continuous skin, not a pose-frozen
        # visibility cut. Shared head/hands remain excluded by eligibility.
        trees[1] = trees[2] = None
    if skirt_backing:
        # Moving skirts and loose shorts reveal thigh faces hidden at rest.
        # Keep a continuous lower body instead of freezing a jagged rest mask.
        trees[3] = trees[4] = None
    eligible = np.ones(len(faces), dtype=bool)
    # Shared head/hands are already rendered by the body GLB. Keep its topology
    # separate instead of recreating almost-coincident skin in every garment.
    shipped = np.asarray(getattr(ref, 'shipped_centres', []), dtype=float).reshape(-1, 3)
    if len(shipped):
        tree = KDTree(len(shipped))
        for index, point in enumerate(shipped):
            tree.insert(point, index)
        tree.balance()
        eligible &= np.array([tree.find(point)[2] >= .004 for point in centres])
    eligible &= centres[:, 2] > minimum_height
    if mode == 'top':
        eligible &= (region_ids <= 2) & ((region_ids != 0) | (centres[:, 2] > hips - .025))
    elif mode == 'bottom':
        eligible &= (region_ids >= 3) | ((region_ids == 0) & (centres[:, 2] < hips + .10))

    covered = np.zeros(len(faces), dtype=bool)
    outer_clearance = np.full(len(faces), -np.inf)
    barycentric = np.array([[.6, .2, .2], [.2, .6, .2], [.2, .2, .6]])
    for face in np.nonzero(eligible)[0]:
        region = int(region_ids[face])
        tree = trees[region]
        if tree is None:
            continue
        hits, clearances = 0, []
        for point in barycentric @ body[faces[face]]:
            origin = _origin(point, region, chains, spine)
            ray = point - origin
            radius = float(np.linalg.norm(ray))
            if radius < .005:
                continue
            direction = ray / radius
            margin = .18 if region == 0 else .09 if region <= 2 else .16
            maximum = min(radius + margin, .40 if region == 0 else .20 if region <= 2 else .30)
            start = max(.001, radius * .25)
            # A ray on a left/right limb cannot travel through the midline and
            # mistake the opposite trouser leg or sleeve for this limb's cover.
            sign = -1 if region in (1, 3) else 1
            if region and direction[0] * sign < 0 and abs(direction[0]) > 1e-8:
                maximum = min(maximum, -origin[0] / direction[0] - .001)
            if maximum <= start:
                continue
            hit, _normal, _triangle, distance = tree.ray_cast(
                Vector(origin + direction * start), Vector(direction), maximum - start)
            if hit is None:
                continue
            if region and (hit.x * sign < -.001 or abs(hit.z - point[2]) > .065):
                continue
            hits += 1
            clearances.append(float(distance + start - radius))
        covered[face] = hits >= 2
        if clearances:
            outer_clearance[face] = min(clearances)

    visible = eligible & ~covered
    if bare_arms:
        visible |= eligible & (face_regions[:, 1:3].sum(1) >= .25)
    if skirt_backing:
        visible |= eligible & ((face_regions[:, 3:5].sum(1) >= .25)
                               | ((region_ids == 0) & (centres[:, 2] < hips + .10)))
    # Add a small continuous hem overlap only where cloth is genuinely outside
    # the body. Re-adding skin outside a slim garment would recreate the defect.
    for region in range(5):
        seeds = np.nonzero(visible & (region_ids == region))[0]
        if not len(seeds):
            continue
        tree = KDTree(len(seeds))
        for index, face in enumerate(seeds):
            tree.insert(centres[face], index)
        tree.balance()
        candidates = np.nonzero(eligible & covered & (region_ids == region) & (outer_clearance > .006))[0]
        for face in candidates:
            if tree.find(centres[face])[2] < .012:
                visible[face] = True
    return visible
