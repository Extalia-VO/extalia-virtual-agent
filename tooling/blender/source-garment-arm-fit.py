"""Opt-in shoulder/elbow/cuff correspondence in the canonical rest frame.

This changes source vertex positions only along a continuous two-segment sleeve
field, preserving every face, UV corner and material. It runs after unskinning
and before arm clearance/binding. Elbow heights are reviewed recipe landmarks,
not guessed from the body's nearest surface.
"""
import json

import numpy as np


def fit_sleeve_landmarks(obj, ref, weights, recipe, M):
    """Return (updated_weights, receipt), updating only obj's vertex positions.

    Example ``sleeveLandmarks={'left': {'elbowHeight': 1.27},
    'right': {'elbowHeight': 1.27}}``. Coordinates are metres in the fitted rest
    frame. Cuff centres use the lowest 5% of that side's arm-owned vertices.
    Do not call on a mesh that already contains generated/native body context.
    """
    config = recipe.get('sleeveLandmarks')
    if not config:
        return weights, {'applied': False}
    if not np.allclose(np.asarray(obj.matrix_world), np.eye(4), atol=1e-6):
        raise ValueError('Sleeve landmarks require identity object transform in the canonical rest frame')
    points, _triangles = M.mesh_arrays(obj)
    corrected = points.copy()
    result = weights.copy()
    report = {'applied': True, 'sides': {}}
    for side in ('left', 'right'):
        if side not in config:
            continue
        settings = config[side]
        bones = [M.B[side + name] for name in ('UpperArm', 'LowerArm', 'Hand')]
        share = weights[:, bones].sum(1)
        cloud = points[share > .7]
        if len(cloud) < 40:
            raise ValueError('Insufficient owned sleeve geometry for ' + side)
        shoulder = ref.joint[side + 'UpperArm']
        elbow = ref.joint[side + 'LowerArm']
        wrist = ref.joint[side + 'Hand'].copy()
        wrist[2] += float(settings.get('cuffInset', .012))
        cuff = cloud[cloud[:, 2] < np.quantile(cloud[:, 2], .05)].mean(0)
        height = float(settings['elbowHeight'])
        section = cloud[np.abs(cloud[:, 2] - height) < .015]
        if len(section) < 8 or not cuff[2] + .08 < height < shoulder[2] - .08:
            raise ValueError('Invalid source elbow/cuff correspondence for ' + side)
        source_elbow = (section.min(0) + section.max(0)) / 2
        source_elbow[2] = height
        ids = np.flatnonzero(share > .35)
        selected = points[ids]

        def segment(source_a, source_b, target_a, target_b):
            t = (source_a[2] - selected[:, 2]) / (source_a[2] - source_b[2])
            source_axis = source_a + (source_b - source_a) * t[:, None]
            target_axis = target_a + (target_b - target_a) * t[:, None]
            return selected + target_axis - source_axis

        upper = segment(shoulder, source_elbow, shoulder, elbow)
        lower = segment(source_elbow, cuff, elbow, wrist)
        blend = np.clip((height + .03 - selected[:, 2]) / .06, 0, 1)
        blend = blend * blend * (3 - 2 * blend)
        target = upper * (1 - blend[:, None]) + lower * blend[:, None]
        fade = np.clip((shoulder[2] + .025 - selected[:, 2]) / .10, 0, 1)
        fade = fade * fade * (3 - 2 * fade)
        corrected[ids] = selected + (target - selected) * fade[:, None] * share[ids, None]
        maximum = float(np.linalg.norm(corrected[ids] - selected, axis=1).max())
        if maximum > float(settings.get('maximumDisplacement', .16)):
            raise ValueError('Sleeve correspondence exceeds its reviewed displacement budget')
        # The crease now sits at the wearer's elbow; re-sample that side's arm
        # field there, retaining its prior topology-based torso/arm ownership.
        columns = [M.B[side + name] for name in ('Shoulder', 'UpperArm', 'LowerArm', 'Hand')]
        body_share = ref.weights[:, bones].sum(1)
        faces = ref.tris[body_share[ref.tris].max(1) > .35]
        transferred = M.transfer_weights(corrected[ids], ref.verts, faces, ref.weights)
        family = transferred[:, columns]
        family /= np.maximum(family.sum(1, keepdims=True), 1e-9)
        retained = weights[np.ix_(ids, columns)].sum(1)
        result[np.ix_(ids, columns)] = family * retained[:, None]
        report['sides'][side] = {'sourceElbow': source_elbow.tolist(), 'sourceCuff': cuff.tolist(),
                                 'targetElbow': elbow.tolist(), 'targetCuff': wrist.tolist(),
                                 'maximumDisplacement': maximum}
    if not np.all(np.isfinite(result)) or not np.allclose(result.sum(1), 1, atol=1e-6):
        raise ValueError('Sleeve correspondence produced invalid weights')
    obj.data.vertices.foreach_set('co', corrected.reshape(-1))
    obj.data.update()
    print('SOURCE_SLEEVE_LANDMARKS', json.dumps(report), flush=True)
    return M.limit_influences(result), report


def _arm_frame(points, shoulder, elbow, wrist, shoulder_extension=0.):
    """Continuous anatomical two-segment coordinates; no source topology changes."""
    frames = []
    offset = 0.
    for start, end in ((shoulder, elbow), (elbow, wrist)):
        direction = np.asarray(end) - start
        length = float(np.linalg.norm(direction))
        tangent = direction / length
        u = np.cross(tangent, np.array([0., 1., 0.]))
        u /= np.linalg.norm(u)
        v = np.cross(tangent, u)
        distance = np.clip((points - start) @ tangent,
                           -shoulder_extension if offset == 0. and shoulder_extension else 0., length)
        axis = start + distance[:, None] * tangent
        delta = points - axis
        frames.append((np.einsum('ij,ij->i', delta, delta),
            np.column_stack((delta @ u, delta @ v, distance + offset)), u, v))
        offset += length
    choose = frames[1][0] < frames[0][0]
    local = np.where(choose[:, None], frames[1][1], frames[0][1])
    u = np.where(choose[:, None], frames[1][2], frames[0][2])
    v = np.where(choose[:, None], frames[1][3], frames[0][3])
    return local, u, v, np.sqrt(np.minimum(frames[0][0], frames[1][0])), offset


def _sleeve_section(points, faces, height):
    faces = faces[(points[faces, 2].min(1) <= height) & (points[faces, 2].max(1) >= height)]
    samples = []
    for first, second in ((0, 1), (1, 2), (2, 0)):
        a, b = points[faces[:, first]], points[faces[:, second]]
        delta = b[:, 2] - a[:, 2]
        valid = (np.abs(delta) > 1e-10) & ((a[:, 2] - height) * (b[:, 2] - height) <= 0)
        if valid.any():
            blend = (height - a[valid, 2]) / delta[valid]
            samples.append(a[valid, :2] + (b[valid, :2] - a[valid, :2]) * blend[:, None])
    return np.concatenate(samples) if samples else np.empty((0, 2))


def _sleeve_smooth(values):
    values = np.asarray(values)
    if values.ndim > 1:
        return np.column_stack([_sleeve_smooth(values[:, column]) for column in range(values.shape[1])])
    return np.convolve(np.pad(values, (3, 3), mode='edge'), np.array([1., 2., 3., 4., 3., 2., 1.]) / 16, mode='valid')


def _shoulder_cap_offsets(points, faces, eligible, weights, ref, M, margin, *, spatial=False):
    """Shared directional offsets for the closed proximal end of each sleeve.

    Cross-section inflation cannot move a cap along the arm axis. This bounded
    shoulder-joint field includes that direction while preserving source layers.
    Explicit torso and non-upper-garment vertices are excluded by the caller.
    """
    from mathutils import Vector
    from mathutils.bvhtree import BVHTree
    result = points.copy()
    ownership = np.zeros(len(points), dtype=bool)
    ownership[list(eligible)] = True
    surface = faces[ownership[faces].all(axis=1)]
    if not len(surface):
        return result, []
    body = BVHTree.FromPolygons([Vector(v) for v in ref.verts], ref.tris.tolist(), all_triangles=True)
    cloth = BVHTree.FromPolygons([Vector(v) for v in points], surface.tolist(), all_triangles=True)
    def smooth(t):
        t = np.clip(t, 0., 1.)
        return t * t * (3. - 2. * t)
    reports = []
    for side in ('left', 'right'):
        origin = np.asarray(ref.joint[side + 'UpperArm'])
        axis = np.asarray(ref.joint[side + 'LowerArm']) - origin
        axis /= np.linalg.norm(axis)
        horizontal = np.cross(axis, np.array([0., 1., 0.]))
        horizontal /= np.linalg.norm(horizontal)
        vertical = np.cross(axis, horizontal)
        offsets = np.zeros((17, 24))
        for row, theta in enumerate(np.linspace(0., np.pi, 17)):
            for column, phi in enumerate(np.linspace(-np.pi, np.pi, 24, endpoint=False)):
                direction = (np.sin(theta) * (np.cos(phi) * horizontal + np.sin(phi) * vertical)
                             + np.cos(theta) * axis)
                source_hit = cloth.ray_cast(Vector(origin), Vector(direction), .18)
                body_hit = body.ray_cast(Vector(origin), Vector(direction), .18)
                if source_hit[0] is not None and body_hit[0] is not None and source_hit[3] > .015:
                    offsets[row, column] = np.clip(body_hit[3] + margin - source_hit[3], 0., .05)
        # Coarse source triangles may cut a curved body even when their corners
        # clear it. Spread the directional deficit to neighboring corners before
        # smoothing; this changes one shared field, never individual faces.
        padded = np.pad(offsets, ((1, 1), (0, 0)), mode='edge')
        offsets = np.maximum.reduce([np.roll(padded[row:row + len(offsets)], column, axis=1)
                                     for row in range(3) for column in (-1, 0, 1)])
        for _ in range(2):
            offsets = (np.roll(offsets, 1, axis=1) + 2 * offsets + np.roll(offsets, -1, axis=1)) / 4
            offsets = (np.vstack((offsets[:1], offsets[:-1])) + 2 * offsets +
                       np.vstack((offsets[1:], offsets[-1:]))) / 4
        offsets[0] = offsets[0].mean(); offsets[-1] = offsets[-1].mean()
        delta = points - origin
        radius = np.linalg.norm(delta, axis=1)
        longitudinal = delta @ axis
        family = [M.B[side + name] for name in ('Shoulder', 'UpperArm', 'LowerArm', 'Hand')]
        share = weights[:, family].sum(axis=1)
        cap_ownership = np.ones(len(points), dtype=bool) if spatial else share > .2
        ids = np.flatnonzero(ownership & cap_ownership & (radius > .015) & (radius < .18)
                             & (longitudinal > -.10) & (longitudinal < .18))
        direction = delta[ids] / radius[ids, None]
        theta = np.arccos(np.clip(direction @ axis, -1., 1.)) * (16 / np.pi)
        phi = (np.arctan2(direction @ vertical, direction @ horizontal) + np.pi) * (24 / (2 * np.pi))
        low_theta = np.minimum(theta.astype(np.int64), 15)
        blend_theta = theta - low_theta
        low_phi = np.floor(phi).astype(np.int64) % 24
        blend_phi = phi - np.floor(phi)
        lower = offsets[low_theta, low_phi] * (1 - blend_phi) + offsets[low_theta, (low_phi + 1) % 24] * blend_phi
        upper = offsets[low_theta + 1, low_phi] * (1 - blend_phi) + offsets[low_theta + 1, (low_phi + 1) % 24] * blend_phi
        amplitude = (smooth((.18 - radius[ids]) / .04) if spatial else
                     smooth((share[ids] - .2) / .35) * smooth((.18 - radius[ids]) / .04))
        amplitude *= smooth((longitudinal[ids] + .10) / .03) * smooth((.18 - longitudinal[ids]) / .08)
        shift = (lower * (1 - blend_theta) + upper * blend_theta) * amplitude
        result[ids] += direction * shift[:, None]
        reports.append({'side': side, 'affectedVertices': int((shift > 1e-7).sum()),
                        'maximumDisplacement': float(shift.max(initial=0.))})
    return result, reports


def fit_sleeve_envelope(obj, ref, weights, recipe, M):
    """Return (unchanged weights, report), fitting a common radial sleeve clearance.

    Opt in with ``sleeveEnvelope={margin:.006, maximumDisplacement:.07}``.
    ``shoulderTransition=True`` additionally fits clavicle-owned cap vertices
    through a bounded shared three-dimensional field. Explicit torso ownership
    stays fixed; this option does not change bindings or guarantee pose clearance.
    ``spatialShoulderCaps=True`` removes skeletal-share attenuation only from
    that bounded shoulder field, keeping nearby bodice and sleeve layers together.
    One smooth angular/longitudinal OFFSET field applies to every arm-owned original
    layer. It expands only sectors that fail to contain the actual reference arm,
    preserving the sleeve axis, loose outer silhouette and inter-layer radial gaps.
    Run after landmarks and before context/binding. Disable pointwise armClearance.
    No body, source footwear/bottom, face, UV, material, alpha or weight is modified.
    """
    config = recipe.get('sleeveEnvelope')
    if not config:
        return weights, {'applied': False}
    if config is True:
        config = {}
    if not isinstance(config, dict):
        raise ValueError('sleeveEnvelope must be a boolean or bounded configuration')
    import math
    def bounded(name, default, low, high):
        value = config.get(name, default)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
            raise ValueError('Invalid sleeveEnvelope ' + name)
        return float(value)
    margin = bounded('margin', .006, .002, .015)
    maximum = bounded('maximumDisplacement', .04, .005, .07)
    shoulder_transition = config.get('shoulderTransition', False)
    if type(shoulder_transition) is not bool:
        raise ValueError('sleeveEnvelope shoulderTransition must be a boolean')
    spatial_caps = config.get('spatialShoulderCaps', False)
    if type(spatial_caps) is not bool or (spatial_caps and not shoulder_transition):
        raise ValueError('spatialShoulderCaps requires boolean true with shoulderTransition')
    minimum_share = bounded('minimumArmShare', .4 if shoulder_transition else .6, .4, .9)
    if not np.allclose(np.asarray(obj.matrix_world), np.eye(4), atol=1e-6):
        raise ValueError('Sleeve envelope requires canonical identity object transform')
    points, _faces = M.mesh_arrays(obj)
    if weights.shape != (len(points), len(M.BONES)) or not np.isfinite(weights).all():
        raise ValueError('Sleeve envelope requires canonical finite weights')
    obj.data.calc_loop_triangles()
    eligible, protected, faces = set(), set(), []
    for triangle in obj.data.loop_triangles:
        material = obj.data.materials[obj.data.polygons[triangle.polygon_index].material_index]
        if material and material.name.startswith(('OriginalTop_', 'OriginalOuter_', 'OriginalAccent_')):
            faces.append(list(triangle.vertices)); eligible.update(triangle.vertices)
        else:
            protected.update(triangle.vertices)
    if shoulder_transition:
        anatomy = obj.data.attributes.get('anatomy')
        if anatomy is not None and anatomy.domain == 'FACE':
            for face in obj.data.polygons:
                if anatomy.data[face.index].value == 2:
                    protected.update(face.vertices)
    eligible.difference_update(protected)
    if not faces or not eligible:
        return weights, {'applied': False, 'reason': 'no-original-upper-garment'}
    faces = np.asarray(faces, dtype=np.int64)
    proposed = points.copy()
    sides = []
    torso = np.array([ref.joint[name] for name in ('hips', 'spine', 'chest', 'neck')])
    torso = torso[np.argsort(torso[:, 2])]
    torso_axis = np.column_stack([np.interp(points[:, 2], torso[:, 2], torso[:, column]) for column in range(2)])
    torso_distance = np.linalg.norm(points[:, :2] - torso_axis, axis=1)
    def smooth(t):
        t = np.clip(t, 0., 1.)
        return t * t * (3 - 2 * t)
    for side in ('left', 'right'):
        chain = [np.asarray(ref.joint[side + name]) for name in ('UpperArm', 'LowerArm', 'Hand')]
        local, basis_u, basis_v, distance, length = _arm_frame(points, *chain, shoulder_extension=.08 if shoulder_transition else 0.)
        body, _u, _v, body_distance, _length = _arm_frame(ref.verts, *chain, shoulder_extension=.08 if shoulder_transition else 0.)
        family = ('Shoulder', 'UpperArm', 'LowerArm', 'Hand') if shoulder_transition else ('UpperArm', 'LowerArm', 'Hand')
        columns = [M.B[side + name] for name in family]
        share = weights[:, columns].sum(1)
        body_share = ref.weights[:, columns].sum(1)
        section_share = .3 if shoulder_transition else .65
        section_radius = .13 if shoulder_transition else .10
        source_faces = faces[(share[faces].mean(1) > section_share) &
                             (distance[faces].mean(1) < section_radius)]
        body_faces = ref.tris[(body_share[ref.tris].mean(1) > section_share) &
                              (body_distance[ref.tris].mean(1) < section_radius)]
        if not len(source_faces):
            continue
        rows = []
        for height in np.linspace(-.06 if shoulder_transition else .025, length - .008, 64):
            source = _sleeve_section(local, source_faces, height)
            target = _sleeve_section(body, body_faces, height)
            if len(source) < 8 or len(target) < 8:
                continue
            centre = (np.quantile(source, .04, axis=0) + np.quantile(source, .96, axis=0)) / 2
            source_delta, target_delta = source - centre, target - centre
            sa = np.arctan2(source_delta[:, 1], source_delta[:, 0])
            ta = np.arctan2(target_delta[:, 1], target_delta[:, 0])
            sr, tr = np.linalg.norm(source_delta, axis=1), np.linalg.norm(target_delta, axis=1)
            offsets = []
            for angle in np.linspace(-np.pi, np.pi, 24, endpoint=False):
                s = sr[np.abs(np.arctan2(np.sin(sa - angle), np.cos(sa - angle))) < np.pi / 8]
                t = tr[np.abs(np.arctan2(np.sin(ta - angle), np.cos(ta - angle))) < np.pi / 8]
                # Missing source sectors remain missing; no artificial sleeve panels.
                offsets.append(max(0., float(np.quantile(t, .98) + margin - np.quantile(s, .1)))
                    if len(s) and len(t) else 0.)
            offsets = np.convolve(np.pad(offsets, (2, 2), mode='wrap'), np.array([1., 2., 3., 2., 1.]) / 9, mode='valid')
            body_centre = (np.quantile(target, .02, axis=0) + np.quantile(target, .98, axis=0)) / 2
            body_radius = np.linalg.norm(target - body_centre, axis=1)
            support = min(.11, max(.04, float(max(np.quantile(sr, .98), np.quantile(body_radius, .98))) + .012))
            rows.append((height, centre, support, offsets))
        if len(rows) < 8:
            raise ValueError('Insufficient original sleeve sections for ' + side)
        z = np.array([row[0] for row in rows])
        centres = _sleeve_smooth([row[1] for row in rows])
        support = _sleeve_smooth([row[2] for row in rows])
        offsets = _sleeve_smooth([row[3] for row in rows])
        ids = np.array(sorted(eligible), dtype=np.int64)
        ids = ids[(local[ids, 2] > (-.075 if shoulder_transition else .001)) &
                  (local[ids, 2] < length - .003) & (distance[ids] < .16)]
        centre = np.column_stack([np.interp(local[ids, 2], z, centres[:, axis]) for axis in range(2)])
        radial = local[ids, :2] - centre
        radius = np.linalg.norm(radial, axis=1)
        fade = (smooth((local[ids, 2] + .08) / .11) if shoulder_transition else
                smooth(local[ids, 2] / .06)) * smooth((length - local[ids, 2]) / .025)
        fade *= smooth((torso_distance[ids] - distance[ids]) / .065)
        fade *= smooth((np.interp(local[ids, 2], z, support) + .015 - radius) / .015)
        fade *= smooth((share[ids] - minimum_share) / max(.05, 1 - minimum_share))
        angle = (np.arctan2(radial[:, 1], radial[:, 0]) + np.pi) * (24 / (2 * np.pi))
        first_angle = np.floor(angle).astype(np.int64) % 24
        angle_blend = angle - np.floor(angle)
        first_height = np.clip(np.searchsorted(z, local[ids, 2]) - 1, 0, len(z) - 2)
        height_blend = np.clip((local[ids, 2] - z[first_height]) / (z[first_height + 1] - z[first_height]), 0, 1)
        low = offsets[first_height, first_angle] * (1 - angle_blend) + offsets[first_height, (first_angle + 1) % 24] * angle_blend
        high = offsets[first_height + 1, first_angle] * (1 - angle_blend) + offsets[first_height + 1, (first_angle + 1) % 24] * angle_blend
        shift = (low * (1 - height_blend) + high * height_blend) * fade
        delta = radial / np.maximum(radius[:, None], 1e-9) * shift[:, None]
        proposed[ids] += basis_u[ids] * delta[:, :1] + basis_v[ids] * delta[:, 1:]
        sides.append({'side': side, 'sections': len(rows), 'maximumFieldOffset': float(offsets.max()),
            'affectedVertices': int((shift > 1e-7).sum())})
    cap_reports = []
    if shoulder_transition:
        for iteration in range(3):
            proposed, cap_pass = _shoulder_cap_offsets(proposed, faces, eligible, weights, ref, M, margin, spatial=spatial_caps)
            cap_reports.extend({'iteration': iteration + 1, **row} for row in cap_pass)
    delta = proposed - points
    peak = float(np.linalg.norm(delta, axis=1).max())
    amplitude = min(1., maximum / peak) if peak else 1.
    result = points + delta * amplitude
    obj.data.vertices.foreach_set('co', result.reshape(-1)); obj.data.update()
    report = {'applied': True, 'maximumDisplacement': min(peak, maximum), 'globalAmplitude': amplitude,
        'unboundedMaximumDisplacement': peak, 'margin': margin, 'sides': sides,
        'originalFacesUVMaterialsAndWeightsUnchanged': True}
    if shoulder_transition:
        report['shoulderTransition'] = True
        report['minimumArmShare'] = minimum_share
        report['sectionMinimumArmShare'] = .3
        report['clavicleOwnership'] = True
        report['proximalExtension'] = .08
        report['shoulderCaps'] = cap_reports
        report['capMinimumOwnership'] = 0. if spatial_caps else .2
        if spatial_caps:
            report['spatialShoulderCaps'] = True
    print('SOURCE_SLEEVE_ENVELOPE', json.dumps(report), flush=True)
    return weights, report
