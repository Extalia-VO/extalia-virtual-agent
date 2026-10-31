"""Bake opt-in forward shoulder collision corrections as source-only morphs.

Call ``add_shoulder_correctives(obj, ref, M, options)`` after final binding and
before joining body context. No rest position, face, loop attribute, material,
or skeletal weight is changed. Each bank uses the final four-influence weights.

The runtime angle is the angle between current and bind upper-arm directions,
both expressed in their corresponding chest frames. Names encode that angle:
``ExtaliaShoulderLeft_30`` and ``ExtaliaShoulderRight_30``, etc. A bank beginning
at 30 degrees has an implicit zero target at 20 degrees. These are forward-arm
samples, not a claim of coverage for every shoulder azimuth.
"""

import math

import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree


_SOURCE_PREFIXES = ('OriginalTop_', 'OriginalOuter_', 'OriginalAccent_')


def _settings(options):
    if not isinstance(options, dict):
        raise ValueError('Shoulder corrective options must be an explicit object')
    allowed = {'angles', 'sides', 'activationAngle', 'margin',
               'maximumDisplacement', 'radius', 'iterations'}
    if set(options) - allowed:
        raise ValueError('Unknown shoulder corrective option')
    angles = options.get('angles', [30, 45, 60, 90, 135])
    if (not isinstance(angles, list) or not angles or
            any(type(a) is not int or not 30 <= a <= 135 for a in angles) or
            angles != sorted(set(angles))):
        raise ValueError('Shoulder angles must be distinct ascending integers from 30 to 135')
    activation = 20 if angles[0] == 30 else 30
    if options.get('activationAngle', activation) != activation:
        raise ValueError('Activation must match the angle-name runtime convention')
    sides = options.get('sides', ['left', 'right'])
    if (not isinstance(sides, list) or not sides or len(set(sides)) != len(sides)
            or any(s not in ('left', 'right') for s in sides)):
        raise ValueError('Shoulder sides must contain left and/or right once')
    values = dict(margin=float(options.get('margin', .008)),
                  maximum=float(options.get('maximumDisplacement', .0694)),
                  radius=float(options.get('radius', .18)),
                  iterations=options.get('iterations', 64))
    if (not all(math.isfinite(values[k]) for k in ('margin', 'maximum', 'radius'))
            or not .002 <= values['margin'] <= .012
            or not .001 <= values['maximum'] <= .0694
            or not .12 <= values['radius'] <= .20
            or type(values['iterations']) is not int
            or not 16 <= values['iterations'] <= 96):
        raise ValueError('Shoulder corrective settings exceed the bounded solve limits')
    return angles, sides, activation, values


def _source_domain(obj, basis, shoulder, side, radius):
    eligible, protected, faces = set(), set(), []
    obj.data.calc_loop_triangles()
    for face in obj.data.loop_triangles:
        material = obj.data.materials[face.material_index]
        if material and material.name.startswith(_SOURCE_PREFIXES):
            eligible.update(face.vertices)
            faces.append(face.vertices[:])
        else:
            protected.update(face.vertices)
    eligible.difference_update(protected)
    faces = np.asarray(faces, dtype=np.int64).reshape(-1, 3)
    distance = np.linalg.norm(basis - shoulder, axis=1)
    fade = np.clip((radius - distance) / .04, 0, 1)
    fade = fade * fade * (3 - 2 * fade)
    sign = 1 if side == 'right' else -1
    fade *= np.clip((basis[:, 0] * sign - .045) / .04, 0, 1)
    mask = np.zeros(len(basis), dtype=bool)
    mask[list(eligible)] = True
    fade *= mask
    faces = faces[(fade[faces] > 0).any(axis=1)]
    return np.asarray(sorted(eligible), dtype=np.int64), faces, fade


def _forward_pose(ref, side, degrees):
    for bone in ref.rig.pose.bones:
        bone.matrix_basis = Matrix.Identity(4)
    direction = ref.joint[side + 'LowerArm'] - ref.joint[side + 'UpperArm']
    direction = direction / np.linalg.norm(direction)
    axial = direction[0] ** 2
    cosine = (math.cos(math.radians(degrees)) - axial) / (1 - axial)
    if not -1 <= cosine <= 1:
        raise ValueError('Requested forward angle is unreachable for this rest arm')
    rotation = math.acos(cosine)
    bone = ref.rig.pose.bones[side + 'UpperArm']
    rest = bone.bone.matrix_local.to_3x3()
    bone.matrix_basis = (rest.inverted() @ Matrix.Rotation(-rotation, 3, 'X') @ rest).to_4x4()
    bpy.context.view_layer.update()
    return math.degrees(rotation)


def _solve_bank(obj, ref, weights, M, basis, side, degrees, *, margin,
                maximum, radius, iterations):
    rotation = _forward_pose(ref, side, degrees)
    matrices = ref.skinning()
    body = M.skin_points(ref.verts, ref.weights, matrices)
    initial = M.skin_points(basis, weights, matrices)
    posed = initial.copy()
    eligible, faces, fade = _source_domain(
        obj, basis, ref.joint[side + 'UpperArm'], side, radius)
    active = np.flatnonzero(fade > 0)
    if not len(active) or not len(faces):
        raise ValueError('No source shoulder surface for ' + side)

    # Exclude the neck/head so their proximity cannot inflate a source collar.
    head = ref.weights[:, [M.B['head'], M.B['neck']]].sum(axis=1)
    body_faces = ref.tris[(head[ref.tris].max(axis=1) < .7) &
                          (ref.verts[ref.tris, 2].min(axis=1) > 1.15)]
    tree = BVHTree.FromPolygons([Vector(p) for p in body],
                               body_faces.tolist(), all_triangles=True)
    barycentric = np.asarray([[a / 6, b / 6, (6 - a - b) / 6]
                             for a in range(7) for b in range(7 - a)] +
                            [[1 / 3, 1 / 3, 1 / 3]])

    def contacts(points):
        destinations, vectors, depths = [], [], []
        for triangle in faces:
            correction, largest = np.zeros(3), 0.
            for sample in barycentric @ points[triangle]:
                nearest, normal, _index, distance = tree.find_nearest(Vector(sample))
                if nearest is None or distance > .07:
                    continue
                depth = -float((Vector(sample) - nearest).dot(normal))
                amount = depth + margin
                if amount > largest:
                    largest = amount
                    correction = np.asarray(normal) * min(amount, .025)
            if largest > 0:
                destinations.append(triangle)
                vectors.append(correction)
                depths.append(largest - margin)
        return (np.asarray(destinations, dtype=np.int64).reshape(-1, 3),
                np.asarray(vectors).reshape(-1, 3), depths)

    # Spatial stations remain in the uncorrected posed frame. All nearby source
    # layers use the same field, instead of independently projecting each layer.
    stable = KDTree(len(eligible))
    for j, index in enumerate(eligible):
        stable.insert(Vector(initial[index]), j)
    stable.balance()
    neighborhoods = []
    for index in active:
        near = stable.find_range(Vector(initial[index]), .055)
        ids = np.asarray([eligible[j] for _, j, _ in near])
        kernel = np.exp(-(np.asarray([d for _, _, d in near]) / .03) ** 2)
        neighborhoods.append((index, ids, kernel / kernel.sum()))

    before, history = contacts(posed)[2], []
    for iteration in range(iterations):
        contact_faces, corrections, depths = contacts(posed)
        history.append({'iteration': iteration, 'clearanceFaces': len(contact_faces),
                        'maximumPenetration': max(0., max(depths, default=0.))})
        if not len(contact_faces):
            break
        delta, count = np.zeros_like(posed), np.zeros(len(posed))
        for slot in range(3):
            np.add.at(delta, contact_faces[:, slot], corrections)
            np.add.at(count, contact_faces[:, slot], 1)
        delta /= np.maximum(count, 1)[:, None]
        stations = np.flatnonzero((count > 0) & (fade > 0))
        if not len(stations):
            break
        spatial = KDTree(len(stations))
        for j, index in enumerate(stations):
            spatial.insert(Vector(initial[index]), j)
        spatial.balance()
        field = np.zeros_like(posed)
        for index in active:
            neighbors = spatial.find_range(Vector(initial[index]), .065)
            if not neighbors:
                continue
            ids = np.asarray([stations[j] for _, j, _ in neighbors])
            distance = np.asarray([d for _, _, d in neighbors])
            kernel = np.exp(-(distance / .035) ** 2)
            field[index] = (delta[ids] * kernel[:, None]).sum(axis=0) / kernel.sum()
        shift = posed + field * fade[:, None] * .9 - initial
        smoothed = shift.copy()
        blend = .25 if iteration < iterations - 16 else .08
        for index, ids, kernel in neighborhoods:
            smoothed[index] = (shift[index] * (1 - blend) +
                               (shift[ids] * kernel[:, None]).sum(axis=0) * blend)
        shift = smoothed
        shift[fade == 0] = 0
        length = np.linalg.norm(shift, axis=1)
        shift *= np.minimum(1, maximum / np.maximum(length, 1e-12))[:, None]
        posed = initial + shift

    target = M.unskin_points(posed, weights, matrices)
    target[fade == 0] = basis[fade == 0]
    if not np.isfinite(target).all():
        raise ValueError('Non-finite inverse-skinning shoulder target')
    recomposed = M.skin_points(target, weights, matrices)
    inverse_error = float(np.linalg.norm(recomposed - posed, axis=1).max())
    if inverse_error > 1e-5:
        raise ValueError('Shoulder inverse skinning failed its posed-space round trip')
    after = contacts(recomposed)[2]
    report = {
        'name': 'ExtaliaShoulder' + side.title() + '_' + str(degrees),
        'side': side, 'degrees': degrees, 'forwardRotationDegrees': rotation,
        'activeVertices': len(active), 'sourceTriangles': len(faces),
        'beforePenetratingFaces': sum(d > 0 for d in before),
        'afterPenetratingFaces': sum(d > 0 for d in after),
        'beforeMaximumPenetration': max(0., max(before, default=0.)),
        'afterMaximumPenetration': max(0., max(after, default=0.)),
        'maximumPosedDisplacement': float(np.linalg.norm(recomposed - initial, axis=1).max()),
        'maximumRestDisplacement': float(np.linalg.norm(target - basis, axis=1).max()),
        'maximumInverseSkinError': inverse_error, 'history': history,
    }
    def measure(candidate):
        return contacts(M.skin_points(candidate, weights, matrices))[2]

    return target, report, measure


def _limit_interpolated_targets(solved, basis, weights, ref, M, activation):
    """Bound interpolated forward poses, not just the baked endpoints.

    With every other local joint at rest, UpperArm and its descendants share
    one world-X rotation. Translation cancels for a morph delta. Therefore this
    evaluates the exact LBS delta without repeatedly updating a Blender rig.
    A small reserve covers float32 export and the half-degree sampling grid.
    """
    checks = []
    for side in ('left', 'right'):
        banks = [entry for entry in solved if entry[1]['side'] == side]
        if not banks:
            continue
        angles = [activation] + [entry[1]['degrees'] for entry in banks]
        deltas = [np.zeros_like(basis)] + [entry[0] - basis for entry in banks]
        direction = ref.joint[side + 'LowerArm'] - ref.joint[side + 'UpperArm']
        axial = (direction[0] / np.linalg.norm(direction)) ** 2
        columns = [M.B[side + bone] for bone in ('UpperArm', 'LowerArm', 'Hand')]
        share = weights[:, columns].sum(axis=1)[:, None]
        peak, peak_angle = 0., float(activation)
        for angle in np.linspace(activation, angles[-1], (angles[-1] - activation) * 2 + 1):
            upper = int(np.clip(np.searchsorted(angles, angle), 1, len(angles) - 1))
            blend = (angle - angles[upper - 1]) / (angles[upper] - angles[upper - 1])
            delta = deltas[upper - 1] * (1 - blend) + deltas[upper] * blend
            rotation = math.acos(np.clip((math.cos(math.radians(angle)) - axial) / (1 - axial), -1, 1))
            matrix = np.asarray(Matrix.Rotation(-rotation, 3, 'X'))
            posed_delta = delta * (1 - share) + (delta @ matrix.T) * share
            maximum = float(np.linalg.norm(posed_delta, axis=1).max())
            if maximum > peak:
                peak, peak_angle = maximum, float(angle)
        scale = min(1., .06995 / max(peak, 1e-12))
        if scale < 1:
            for target, report, measure in banks:
                target[:] = basis + (target - basis) * scale
                depths = measure(target)
                report['afterPenetratingFaces'] = sum(d > 0 for d in depths)
                report['afterMaximumPenetration'] = max(0., max(depths, default=0.))
                report['maximumPosedDisplacement'] *= scale
                report['maximumRestDisplacement'] *= scale
                report['interpolationSafetyScale'] = scale
        checks.append({'side': side, 'stepDegrees': .5, 'peakAngle': peak_angle,
                       'maximumBeforeScale': peak, 'scale': scale,
                       'maximumAfterScale': peak * scale})
    return checks


def add_shoulder_correctives(obj, ref, M, options=None):
    """Return a receipt; false/None is a strict no-op.

    A missing/false option never creates a Basis key or changes pose state.
    This function restores the incoming pose even when a solve fails. Shape
    keys are added only after every requested bank has solved successfully.
    It deliberately reports residual contacts; a receipt is not visual approval.
    """
    if options is None or options is False:
        return {'applied': False}
    angles, sides, activation, settings = _settings(options)
    basis, _faces = M.mesh_arrays(obj)
    weights = M.vertex_weights(obj).copy()
    if not np.isfinite(weights).all() or not np.allclose(weights.sum(axis=1), 1, atol=1e-6):
        raise ValueError('Shoulder correction requires final normalized bound weights')
    saved = {b.name: b.matrix_basis.copy() for b in ref.rig.pose.bones}
    names = ['ExtaliaShoulder' + side.title() + '_' + str(a)
             for side in sides for a in angles]
    if obj.data.shape_keys and any(n in obj.data.shape_keys.key_blocks for n in names):
        raise ValueError('Shoulder targets already exist; bake from a clean Basis')
    solved = []
    try:
        for side in sides:
            for angle in angles:
                solved.append(_solve_bank(obj, ref, weights, M, basis, side, angle, **settings))
        interpolation = _limit_interpolated_targets(solved, basis, weights, ref, M, activation)
    finally:
        for bone in ref.rig.pose.bones:
            bone.matrix_basis = saved[bone.name]
        bpy.context.view_layer.update()

    if not np.array_equal(basis, M.mesh_arrays(obj)[0]):
        raise AssertionError('Shoulder solve changed source Basis')
    if not np.array_equal(weights, M.vertex_weights(obj)):
        raise AssertionError('Shoulder solve changed skeletal weights')
    if obj.data.shape_keys is None:
        obj.shape_key_add(name='Basis', from_mix=False)
    inverse_world = np.asarray(obj.matrix_world.inverted())
    for target, report, _measure in solved:
        local_target = target @ inverse_world[:3, :3].T + inverse_world[:3, 3]
        key = obj.shape_key_add(name=report['name'], from_mix=False)
        key.data.foreach_set('co', local_target.reshape(-1))
        key.value = 0.
    return {'applied': True, 'algorithm': 'source-shoulder-forward-collision-v1',
            'activationAngle': activation, 'angles': angles, 'sides': sides,
            'basisExact': True, 'weightsExact': True,
            'surfaceAttributesUnchanged': True, 'targetsDefaultZero': True,
            'interpolationChecks': interpolation,
            'banks': [report for _target, report, _measure in solved]}
