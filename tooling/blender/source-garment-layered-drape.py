"""Explicit three-bank seated correction for the reviewed layered mesh gown.

Standing positions, source topology, corner attributes, materials, body context
and skeletal weights remain untouched. Only cloth shape keys are added. The
shared parameter-space vector field translates nearby layers together instead
of projecting their vertices independently onto the body.
"""
import math

import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree


SOURCE_ID = 'source-black-mesh-dress'
MORPH = 'ExtaliaSeatedDrape'


def _smooth(values):
    values = np.clip(values, 0., 1.)
    return values * values * (3. - 2. * values)


def _cloth_vertices(obj):
    owned, protected = set(), set()
    for face in obj.data.polygons:
        material = obj.data.materials[face.material_index]
        destination = (owned if material and material.name.startswith(
            ('OriginalTop_', 'OriginalBottom_', 'OriginalOuter_', 'OriginalAccent_')) else protected)
        destination.update(face.vertices)
    result = np.zeros(len(obj.data.vertices), dtype=bool)
    result[list(owned - protected)] = True
    return result


def _rear_bend(points, target, reference_y, floor):
    """Bend the rear train with thickness, rather than collapsing it onto Z=floor."""
    radius = .42
    anchor_y = reference_y + .015
    depth = target[:, 1] - anchor_y
    station = np.maximum(floor + radius - target[:, 2], 0.) / radius
    angle = np.minimum(station, np.pi / 2.)
    bend_fraction = np.sin(angle) ** 2
    section_depth = depth * (1. - bend_fraction) + .025 * np.tanh(depth / .08) * bend_fraction
    transverse_radius = radius - section_depth
    bent = target.copy()
    bent[:, 1] = (anchor_y + radius - transverse_radius * np.cos(angle)
                  + transverse_radius * np.maximum(station - np.pi / 2., 0.))
    bent[:, 2] = floor + radius - transverse_radius * np.sin(angle)
    influence = _smooth((points[:, 1] - reference_y - .015) / .10) * (station > 0.)
    target += influence[:, None] * (bent - target)
    return target, {
        'rearBendVertices': int((influence > 0.).sum()),
        'minimumTransverseRadius': float(transverse_radius[influence > 0.].min(initial=radius)),
    }


def fit_shared_vector(points, target, triangles, selected, ref, weights, matrices, M,
                      *, low=.62, high=1.27, maximum=.08, margin=.006, outer_iterations=5):
    """Fit one bounded, smooth theta/rest-height field shared by all source layers.

    Actual body surface normals provide half-space constraints at cloth samples.
    The solver projects grid nodes, never individual cloth vertices. Neighbor
    slope bounds spread the correction over at least about ten centimetres;
    top/bottom zero anchors retain the surrounding garment's native binding.
    """
    points = np.asarray(points)
    base = np.asarray(target).copy()
    triangles = np.asarray(triangles, dtype=np.int64)
    selected = np.asarray(selected, dtype=bool)
    if (points.ndim != 2 or points.shape[1] != 3 or base.shape != points.shape
            or selected.shape != (len(points),) or triangles.ndim != 2 or triangles.shape[1] != 3
            or not np.isfinite(points).all() or not np.isfinite(base).all()
            or (triangles.size and (triangles.min() < 0 or triangles.max() >= len(points)))):
        raise ValueError('Shared cloth field requires finite matching samples and source triangles')
    if (any(isinstance(value, bool) or not math.isfinite(value) for value in (low, high, maximum, margin))
            or not .5 <= low <= .75 or not 1.17 <= high <= 1.4 or high - low < .4
            or not 0. < maximum <= .08 or not .003 <= margin <= .012
            or type(outer_iterations) is not int or not 1 <= outer_iterations <= 8):
        raise ValueError('Shared cloth field must retain its bounded height, clearance and displacement')
    active = selected & (points[:, 2] > low) & (points[:, 2] < high)
    rows, columns = 28, 32
    spacing = (high - low) / (rows - 1)
    angular_spacing = .08 * 2. * np.pi / columns
    reference_y = np.mean([ref.joint[side + 'UpperLeg'][1] for side in ('left', 'right')])
    field = np.zeros((rows, columns, 3))
    body = M.skin_points(ref.verts, ref.weights, matrices)
    arm = ref.weights[:, M.ARM_BONES].sum(1)
    faces = ref.tris[np.max(arm[ref.tris], axis=1) < .15]
    tree = BVHTree.FromPolygons([Vector(vertex) for vertex in body], faces.tolist(), all_triangles=True)

    def parameters(samples):
        theta = (np.arctan2(samples[:, 1] - reference_y, samples[:, 0])
                 % (2. * np.pi)) / (2. * np.pi) * columns
        angle = np.floor(theta).astype(int) % columns
        theta_fraction = theta - np.floor(theta)
        height = np.clip((samples[:, 2] - low) / (high - low) * (rows - 1), 0, rows - 1)
        row = np.minimum(np.floor(height).astype(int), rows - 2)
        height_fraction = height - row
        indices = np.column_stack([
            row * columns + angle, row * columns + (angle + 1) % columns,
            (row + 1) * columns + angle, (row + 1) * columns + (angle + 1) % columns,
        ])
        coefficients = np.column_stack([
            (1. - theta_fraction) * (1. - height_fraction), theta_fraction * (1. - height_fraction),
            (1. - theta_fraction) * height_fraction, theta_fraction * height_fraction,
        ])
        return indices, coefficients, row, angle

    vertex_indices, vertex_coefficients, _row, _angle = parameters(points)
    ids = np.flatnonzero(active)
    cloth_triangles = triangles[np.all(active[triangles], axis=1)]
    rest_samples = np.vstack([points[ids], points[cloth_triangles].mean(1)])
    sample_indices, sample_coefficients, sample_rows, sample_angles = parameters(rest_samples)

    def regularize():
        for _iteration in range(12):
            for axis, limit in ((0, spacing * .7), (1, angular_spacing * .7)):
                for parity in (0, 1):
                    if axis == 0:
                        pairs = np.arange(parity, rows - 1, 2)
                        first, second = field[pairs], field[pairs + 1]
                    else:
                        pairs = np.arange(parity, columns, 2)
                        first, second = field[:, pairs], field[:, (pairs + 1) % columns]
                    difference = first - second
                    length = np.linalg.norm(difference, axis=-1)
                    correction = (.5 * difference
                                  * np.maximum(0., 1. - limit / np.maximum(length, 1e-12))[..., None])
                    if axis == 0:
                        field[pairs] -= correction
                        field[pairs + 1] += correction
                    else:
                        field[:, pairs] -= correction
                        field[:, (pairs + 1) % columns] += correction
            length = np.linalg.norm(field, axis=-1)
            field[:] *= np.minimum(1., maximum / np.maximum(length, 1e-12))[..., None]
            field[0] = 0.
            field[-2:] = 0.

    def evaluate():
        displacement = (field.reshape(-1, 3)[vertex_indices]
                        * vertex_coefficients[..., None]).sum(1)
        displacement[~active] = 0.
        return base + displacement

    target = evaluate()
    reports = []
    for outer in range(outer_iterations):
        samples = np.vstack([target[ids], target[cloth_triangles].mean(1)])
        displacement = (field.reshape(-1, 3)[sample_indices]
                        * sample_coefficients[..., None]).sum(1)
        constraints = []
        for index, point in enumerate(samples):
            nearest, normal, _face, distance = tree.find_nearest(Vector(point))
            if nearest is None or distance > .12:
                continue
            signed = float((Vector(point) - nearest).dot(normal))
            if signed < margin:
                normal = np.array(normal)
                required = float(normal @ displacement[index] + margin - signed)
                constraints.append((index, normal, required, float(margin - signed)))
        if not constraints:
            reports.append({'iteration': outer, 'constraints': 0})
            break
        # Keep the worst actual contact in each cell and normal octant. Other
        # materials never acquire their own displacement field or projection.
        worst = {}
        for item in constraints:
            index, normal, _required, depth = item
            key = (int(sample_rows[index]), int(sample_angles[index]), tuple(normal >= 0.))
            if key not in worst or depth > worst[key][3]:
                worst[key] = item
        constraints = list(worst.values())
        nodes = np.array([sample_indices[index] for index, _normal, _required, _depth in constraints])
        coefficients = np.array([sample_coefficients[index] for index, _normal, _required, _depth in constraints])
        normals = np.array([normal for _index, normal, _required, _depth in constraints])
        requirements = np.array([required for _index, _normal, required, _depth in constraints])
        denominator = np.maximum((coefficients * coefficients).sum(1), 1e-12)
        flat = field.reshape(-1, 3)
        for _sweep in range(64):
            for node, coefficient, normal, required, norm in zip(
                    nodes, coefficients, normals, requirements, denominator):
                residual = required - float(((flat[node] * coefficient[:, None]).sum(0)) @ normal)
                if residual > 0.:
                    flat[node] += coefficient[:, None] * normal[None] * (residual / norm)
            regularize()
        residual = requirements - np.einsum(
            'ij,ij->i', (flat[nodes] * coefficients[..., None]).sum(1), normals)
        target = evaluate()
        reports.append({
            'iteration': outer, 'rawConstraints': len(worst),
            'constraintResidual': float(residual.max(initial=0.)),
            'maximumShift': float(np.linalg.norm(target - base, axis=1).max()),
        })
    height_slope = np.linalg.norm(np.diff(field, axis=0), axis=2) / spacing
    angle_slope = np.linalg.norm(field - np.roll(field, 1, axis=1), axis=2) / angular_spacing
    return target, {
        'method': 'shared-posed-constraint-vector-field', 'iterations': reports,
        'maximumShift': float(np.linalg.norm(target - base, axis=1).max()),
        'maximumHeightSlope': float(height_slope.max()),
        'maximumAngularSlopeAt8cmRadius': float(angle_slope.max()),
        'upperZeroAnchor': high, 'waistBasisAndSourceWeightsUVMaterialsExact': True,
    }


def add_layered_seated_drape(obj, ref, weights, selected, M, *, source_id, seated_matrices,
                             waist, pose_profile, tall_pose_profile, short_pose_profile,
                             mode='layered_source'):
    """Add only the explicitly reviewed female gown's seated shape-key banks.

    The caller supplies the renderer-matching seated-matrix function. This keeps
    the shared pose implementation authoritative and avoids a second rig model.
    Other garments continue using their existing solver unless explicitly routed
    here by their authoring recipe.
    """
    if mode != 'layered_source' or source_id != SOURCE_ID or ref.group != 'female':
        raise ValueError('Layered drape requires the inspected female mesh gown')
    if (not callable(seated_matrices) or isinstance(waist, bool)
            or not math.isfinite(waist) or not .9 <= waist <= 1.15):
        raise ValueError('Layered drape requires a canonical pose callback and waist')
    if not all(isinstance(profile, dict) for profile in (pose_profile, tall_pose_profile, short_pose_profile)):
        raise ValueError('Layered drape requires all three reviewed height profiles')
    points, triangles = M.mesh_arrays(obj)
    selected = np.asarray(selected, dtype=bool)
    values = np.asarray(weights)
    if (selected.shape != (len(points),) or not selected.any()
            or values.shape != (len(points), len(M.BONES))
            or not np.issubdtype(values.dtype, np.floating) or not np.isfinite(values).all()
            or np.any(values < 0.) or not np.allclose(values.sum(1), 1., atol=1e-5)
            or np.any((values > 0.).sum(1) > 4)):
        raise ValueError('Layered drape requires an explicit skirt and canonical four-influence weights')
    if obj.data.shape_keys and any(obj.data.shape_keys.key_blocks.get(MORPH + suffix)
                                   for suffix in ('', 'Tall', 'Short')):
        raise ValueError('Layered drape must not replace existing seated corrections')
    clothes = _cloth_vertices(obj)
    arm = values[:, M.ARM_BONES].sum(1)
    mask = selected.copy() & clothes
    mask |= clothes & (points[:, 2] < 1.17) & (arm < .2)
    field_mask = clothes & (points[:, 2] < 1.27) & (arm < .2)
    reference_y = np.mean([ref.joint[side + 'UpperLeg'][1] for side in ('left', 'right')])
    blend = _smooth((1.17 - points[:, 2]) / .14) * mask
    rear = _smooth((points[:, 1] - reference_y + .02) / .14)
    hip_weights = np.zeros_like(values)
    hip_weights[:, M.B['hips']] = 1.
    rear_weights = values * (1. - rear[:, None]) + hip_weights * rear[:, None]
    if not obj.data.shape_keys:
        obj.shape_key_add(name='Basis')
    stats = {}
    for suffix, profile in (('', pose_profile), ('Tall', tall_pose_profile), ('Short', short_pose_profile)):
        matrices = seated_matrices(ref, profile)
        native = M.skin_points(points, values, matrices)
        target = M.skin_points(points, rear_weights, matrices)
        floor = max(0., float(ref.joint['hips'][2]) - .11 - profile['seat_height'] / profile['scale']) + .008
        target, report = _rear_bend(points, target, reference_y, floor)
        target = native + (target - native) * blend[:, None]
        target, field = fit_shared_vector(points, target, triangles, field_mask, ref, values, matrices, M)
        corrected = M.unskin_points(target, values, matrices)
        corrected[~field_mask] = points[~field_mask]
        key = obj.shape_key_add(name=MORPH + suffix)
        key.data.foreach_set('co', corrected.reshape(-1))
        key.value = 0.
        obj['extaliaSeatedDrape' + suffix] = True
        stats[suffix or 'base'] = {
            **report, 'sharedVectorField': field,
            'maximumCorrection': float(np.linalg.norm(corrected - points, axis=1).max()),
        }
    return {'shapeKey': MORPH, 'mode': 'layered_source', **stats}
