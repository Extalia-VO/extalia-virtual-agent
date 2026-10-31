"""Opt-in walking cloth correction shared by every original garment layer.

A single bounded rest-space theta/height vector field is constrained against
all supplied runtime walk poses. It only adds a zero-default shape key; source
Basis, faces, UVs, material graphs, weights and generated body skin survive.
Pose matrices come from the caller's authoritative runtime pose implementation.
"""
import math

import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree


MORPH = 'ExtaliaWalkDrape'
KNOWN_WALK_SETS = frozenset(('source-cheongsam-blue', 'source-polka-dress',
                            'source-chiffon-dress', 'source-cheongsam-pink'))


def _parameters(points, reference_y, low, high, rows, columns):
    theta = (np.arctan2(points[:, 1] - reference_y, points[:, 0]) % (2 * np.pi)) / (2 * np.pi) * columns
    angle = np.floor(theta).astype(np.int64) % columns
    fraction = theta - np.floor(theta)
    height = np.clip((points[:, 2] - low) / (high - low) * (rows - 1), 0, rows - 1)
    row = np.minimum(np.floor(height).astype(np.int64), rows - 2)
    z = height - row
    indices = np.column_stack((row * columns + angle, row * columns + (angle + 1) % columns,
                               (row + 1) * columns + angle, (row + 1) * columns + (angle + 1) % columns))
    coefficients = np.column_stack(((1 - fraction) * (1 - z), fraction * (1 - z),
                                    (1 - fraction) * z, fraction * z))
    return indices, coefficients, row, angle


def _regularize(field, height_step, angle_step, maximum, slope, sweeps=24):
    """Bound neighboring vector differences, with fixed end rows and norm cap."""
    rows, columns = field.shape[:2]
    for _ in range(sweeps):
        for axis, limit in ((0, height_step * slope), (1, angle_step * slope)):
            for parity in (0, 1):
                pairs = np.arange(parity, (rows - 1) if axis == 0 else columns, 2)
                first = field[pairs] if axis == 0 else field[:, pairs]
                second = field[pairs + 1] if axis == 0 else field[:, (pairs + 1) % columns]
                difference = first - second
                length = np.linalg.norm(difference, axis=-1)
                correction = .5 * difference * np.maximum(0., 1. - limit / np.maximum(length, 1e-12))[..., None]
                if axis == 0:
                    field[pairs] -= correction
                    field[pairs + 1] += correction
                else:
                    field[:, pairs] -= correction
                    field[:, (pairs + 1) % columns] += correction
        length = np.linalg.norm(field, axis=-1)
        field *= np.minimum(1., maximum / np.maximum(length, 1e-12))[..., None]
        field[0] = 0.
        field[-2:] = 0.


def fit_walk_field(points, triangles, selected, ref, weights, pose_matrices, M, *,
                   source_id, low=.16, high=1.27, maximum=.08, margin=.006,
                   outer_iterations=6, initial_radial_ease=0.):
    """Return rest-space deltas and a receipt, without writing any input.

    ``pose_matrices`` contains 8..32 actual runtime limb-basis-aware skinning
    arrays, including both stride directions. All poses constrain the SAME
    field. A posed normal n acts on a rest displacement through R.T @ n;
    projecting posed positions directly would create incompatible morphs.
    """
    p = np.asarray(points, dtype=float)
    tri = np.asarray(triangles, dtype=np.int64)
    mask = np.asarray(selected, dtype=bool)
    w = np.asarray(weights, dtype=float)
    poses = np.asarray(pose_matrices, dtype=float)
    if source_id not in KNOWN_WALK_SETS or ref.group != 'female':
        raise ValueError('Walk correction requires an explicitly inspected female garment')
    if (p.ndim != 2 or p.shape[1] != 3 or tri.ndim != 2 or tri.shape[1] != 3
            or mask.shape != (len(p),) or w.shape != (len(p), len(M.BONES))
            or not np.isfinite(p).all() or not np.isfinite(w).all() or np.any(w < 0.)
            or not np.allclose(w.sum(1), 1., atol=1e-5) or np.any((w > 0).sum(1) > 4)
            or not len(tri) or tri.min() < 0 or tri.max() >= len(p)
            or poses.ndim != 4 or poses.shape[1:] != (len(M.BONES), 4, 4)
            or not 8 <= len(poses) <= 32 or not np.isfinite(poses).all()):
        raise ValueError('Walk correction requires finite source geometry, four weights and 8..32 runtime poses')
    rotation = poses[..., :3, :3]
    if (not np.allclose(np.swapaxes(rotation, -1, -2) @ rotation, np.eye(3), atol=1e-4)
            or not np.allclose(np.linalg.det(rotation), 1., atol=1e-4)
            or not np.allclose(poses[..., 3, :], (0., 0., 0., 1.), atol=1e-6)
            or np.abs(poses[..., :3, 3]).max() > 3.):
        raise ValueError('Walk correction requires canonical rigid bone skinning matrices')
    if (any(isinstance(v, bool) or not math.isfinite(v) for v in (low, high, maximum, margin, initial_radial_ease))
            or not .10 <= low <= .30 or not 1.17 <= high <= 1.30
            or not 0. < maximum <= .08 or not .003 <= margin <= .012
            or not 0. <= initial_radial_ease <= .04
            or type(outer_iterations) is not int or not 1 <= outer_iterations <= 8):
        raise ValueError('Walk correction requires bounded clearance, displacement and waist anchors')
    if initial_radial_ease and source_id != 'source-cheongsam-blue':
        raise ValueError('Initial radial ease is restricted to the inspected blue cheongsam')
    active = mask & (p[:, 2] > low) & (p[:, 2] < high) & (w[:, M.ARM_BONES].sum(1) < .15)
    if not active.any():
        raise ValueError('Walk correction has no explicit original lower cloth')
    rows, columns, slope = 40, 32, .7
    height_step = (high - low) / (rows - 1)
    angle_step = .08 * 2 * np.pi / columns
    reference_y = float(np.mean([ref.joint[s + 'UpperLeg'][1] for s in ('left', 'right')]))
    field = np.zeros((rows, columns, 3))
    if initial_radial_ease:
        # Choose the outer-leg SDF branch without relaxing the frozen norm or
        # slope bounds. The shared seed eases every source layer together.
        heights = np.linspace(low, high, rows)
        smooth = lambda x: np.clip(x, 0., 1.) ** 2 * (3. - 2. * np.clip(x, 0., 1.))
        ease = initial_radial_ease * smooth((heights - low) / .15) * smooth((high - .04 - heights) / .18)
        theta = np.arange(columns) * 2 * np.pi / columns
        field[:, :, 0] = ease[:, None] * np.cos(theta)[None]
        field[:, :, 1] = ease[:, None] * np.sin(theta)[None]
        _regularize(field, height_step, angle_step, maximum, slope, sweeps=64)

    vi, vc, _, _ = _parameters(p, reference_y, low, high, rows, columns)
    ids = np.flatnonzero(active)
    faces = tri[np.all(active[tri], axis=1)]
    samples = np.vstack((p[ids], p[faces].mean(1)))
    sample_weights = np.vstack((w[ids], w[faces].mean(1)))
    si, sc, sr, sa = _parameters(samples, reference_y, low, high, rows, columns)
    # Runtime body is full reference, excluding arms to keep hanging hands from
    # expanding a skirt. Every cloth layer uses these same parameters/nodes.
    body_arm = ref.weights[:, M.ARM_BONES].sum(1)
    body_faces = ref.tris[np.max(body_arm[ref.tris], axis=1) < .15]
    frames = []
    for matrices in poses:
        body = M.skin_points(ref.verts, ref.weights, matrices)
        tree = BVHTree.FromPolygons([Vector(q) for q in body], body_faces.tolist(), all_triangles=True)
        linear = np.einsum('nb,bij->nij', sample_weights, matrices[:, :3, :3])
        posed_vertices = M.skin_points(p, w, matrices)
        base_samples = np.vstack((posed_vertices[ids], posed_vertices[faces].mean(1)))
        frames.append((tree, linear, base_samples))
    reports = []
    flat = field.reshape(-1, 3)
    for iteration in range(outer_iterations):
        displacement = (flat[si] * sc[..., None]).sum(1)
        worst = {}
        raw = 0
        for phase, (tree, linear, base) in enumerate(frames):
            posed = base + np.einsum('nij,nj->ni', linear, displacement)
            for index, point in enumerate(posed):
                nearest, normal, _face, distance = tree.find_nearest(Vector(point))
                if nearest is None or distance > .12:
                    continue
                signed = float((Vector(point) - nearest).dot(normal))
                if signed >= margin:
                    continue
                gradient = linear[index].T @ np.asarray(normal)
                length = float(np.linalg.norm(gradient))
                if length < 1e-6:
                    continue
                raw += 1
                depth = margin - signed
                required = float(gradient @ displacement[index] + depth)
                key = (phase, int(sr[index]), int(sa[index]), tuple(gradient >= 0.))
                item = (index, gradient, required, depth, phase)
                if key not in worst or depth > worst[key][3]:
                    worst[key] = item
        if not worst:
            reports.append({'iteration': iteration, 'violatedSamples': 0})
            break
        constraints = list(worst.values())
        nodes = np.array([si[i] for i, *_ in constraints])
        coefficients = np.array([sc[i] for i, *_ in constraints])
        normals = np.array([n for _, n, *_ in constraints])
        requirements = np.array([r for _, _, r, *_ in constraints])
        norm = np.maximum((coefficients ** 2).sum(1) * (normals ** 2).sum(1), 1e-12)
        for _sweep in range(32):
            for node, coefficient, normal, required, denominator in zip(nodes, coefficients, normals, requirements, norm):
                residual = required - float(((flat[node] * coefficient[:, None]).sum(0)) @ normal)
                if residual > 0.:
                    flat[node] += coefficient[:, None] * normal[None] * (residual / denominator)
            _regularize(field, height_step, angle_step, maximum, slope)
        reports.append({'iteration': iteration, 'violatedSamples': raw,
                        'projectedConstraints': len(constraints),
                        'maximumRemainingLinearResidual': float((requirements - np.einsum(
                            'ij,ij->i', (flat[nodes] * coefficients[..., None]).sum(1), normals)).max(initial=0.))})
    # Final relaxation guarantees the advertised geometric bound even if a
    # contact set is infeasible; callers must inspect residual collisions.
    _regularize(field, height_step, angle_step, maximum, slope, sweeps=512)
    delta = (flat[vi] * vc[..., None]).sum(1)
    delta[~active] = 0.
    report = {'method': 'shared-rest-space-multi-phase-halfspace-field',
              'sourceId': source_id, 'poses': len(poses), 'samplesPerPose': len(samples),
              'selectedVertices': int(active.sum()), 'rows': rows, 'columns': columns,
              'maximumDisplacement': float(np.linalg.norm(delta, axis=1).max()),
              'maximumHeightSlope': float((np.linalg.norm(np.diff(field, axis=0), axis=2) / height_step).max()),
              'maximumAngularSlopeAt8cmRadius': float((np.linalg.norm(field - np.roll(field, 1, axis=1), axis=2) / angle_step).max()),
              'upperZeroAnchor': high, 'iterations': reports,
              'protectedVerticesExact': bool(np.array_equal(delta[~active], np.zeros_like(delta[~active]))),
              'basisUVWeightsAndMaterialsUnchanged': True}
    if initial_radial_ease:
        report['initialRadialEase'] = initial_radial_ease
    if (not np.isfinite(delta).all() or report['maximumDisplacement'] > maximum + 1e-8
            or report['maximumHeightSlope'] > slope + 1e-5
            or report['maximumAngularSlopeAt8cmRadius'] > slope + 1e-5):
        raise ValueError('Walk field failed bounded displacement/slope validation')
    return delta, report


def add_walk_drape(obj, ref, weights, selected, M, *, source_id, pose_matrices, **options):
    """Add one default-zero walking-only target; existing seated keys survive."""
    if not np.allclose(np.asarray(obj.matrix_world), np.eye(4), atol=1e-6):
        raise ValueError('Walk correction requires a canonical identity object transform')
    if obj.data.shape_keys and obj.data.shape_keys.key_blocks.get(MORPH):
        raise ValueError('Walk correction must not replace an existing target')
    points, triangles = M.mesh_arrays(obj)
    owned, protected = set(), set()
    for face in obj.data.polygons:
        material = obj.data.materials[face.material_index]
        source = material and material.name.startswith(
            ('OriginalTop_', 'OriginalBottom_', 'OriginalOuter_', 'OriginalAccent_'))
        (owned if source else protected).update(face.vertices)
    source_mask = np.zeros(len(points), dtype=bool)
    source_mask[list(owned - protected)] = True
    selected = np.asarray(selected, dtype=bool) & source_mask
    delta, report = fit_walk_field(points, triangles, selected, ref, weights, pose_matrices,
                                   M, source_id=source_id, **options)
    if not obj.data.shape_keys:
        obj.shape_key_add(name='Basis')
    key = obj.shape_key_add(name=MORPH)
    for vertex, point in zip(key.data, points + delta):
        vertex.co = point
    key.value = 0.
    return report
