"""Smooth source-trouser cross-section fitting in canonical Blender Z-up coordinates.

Call fit_leg_envelope(obj, ref, weights, recipe, math_module, source_material_indices)
after inverse posing, before adding context and binding. Only original trouser vertices move;
UVs, faces, material graphs, skin/context, footwear and the rig remain untouched.
"""
import math

import numpy as np
from mathutils import Vector


def _bounded(recipe, key, default, low, high):
    value = recipe.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError('%s must be a finite number in [%s, %s]' % (key, low, high))
    return float(value)


def _smoothstep(value):
    value = np.clip(value, 0, 1)
    return value * value * (3 - 2 * value)


def _slice(points, triangles, height):
    """Actual plane intersections, independent of source vertex/UV-seam density."""
    if not len(triangles):
        return np.empty((0, 2))
    selected = triangles[(points[triangles, 2].min(1) <= height) & (points[triangles, 2].max(1) >= height)]
    if not len(selected):
        return np.empty((0, 2))
    samples = []
    for first, second in ((0, 1), (1, 2), (2, 0)):
        a, b = points[selected[:, first]], points[selected[:, second]]
        dz = b[:, 2] - a[:, 2]
        valid = (np.abs(dz) > 1e-10) & ((a[:, 2] - height) * (b[:, 2] - height) <= 0)
        if valid.any():
            t = (height - a[valid, 2]) / dz[valid]
            samples.append(a[valid, :2] + (b[valid, :2] - a[valid, :2]) * t[:, None])
    return np.concatenate(samples) if samples else np.empty((0, 2))


def _centre(samples):
    # Quantiles resist tiny detached seam/trim outliers without a density-dependent average.
    return (np.quantile(samples, .02, axis=0) + np.quantile(samples, .98, axis=0)) / 2


def _required_scale(source, body, source_centre, body_centre, margin):
    """One scalar per section preserves every original fold and nested source layer."""
    source_delta, body_delta = source - source_centre, body - body_centre
    source_angle = np.arctan2(source_delta[:, 1], source_delta[:, 0])
    body_angle = np.arctan2(body_delta[:, 1], body_delta[:, 0])
    source_radius, body_radius = np.linalg.norm(source_delta, axis=1), np.linalg.norm(body_delta, axis=1)
    ratios = []
    for angle in np.linspace(-math.pi, math.pi, 24, endpoint=False):
        sd = np.abs(np.arctan2(np.sin(source_angle - angle), np.cos(source_angle - angle)))
        bd = np.abs(np.arctan2(np.sin(body_angle - angle), np.cos(body_angle - angle)))
        sr, br = source_radius[sd < math.pi / 8], body_radius[bd < math.pi / 8]
        # Missing original sectors stay missing: never create a tube across a source opening.
        if len(sr) and len(br):
            radius = np.quantile(sr, .15)
            if radius > .008:
                ratios.append((np.quantile(br, .98) + margin) / radius)
    return max(1., float(np.quantile(ratios, .95))) if ratios else 1.


def _smooth(values):
    kernel = np.array([1., 2., 3., 2., 1.]) / 9
    values = np.asarray(values)
    if values.ndim == 1:
        return np.convolve(np.pad(values, (2, 2), mode='edge'), kernel, mode='valid')
    return np.column_stack([_smooth(values[:, axis]) for axis in range(values.shape[1])])


def fit_leg_envelope(obj, ref, weights, recipe, math_module, source_material_indices=None):
    """Apply bounded shared XY translation/radial expansion to original trouser sections.

    Defaults select OriginalBottom_* materials. legCageMaterials can instead list exact source
    material indices (pass the output-slot → source-index sequence). Mixed full sets with
    skirts require explicit trouser selection; OriginalShoes_* and the foot region stay intact.
    """
    skipped = lambda reason: {'movedVertices': 0, 'maxShift': 0., 'reason': reason}
    if recipe.get('legCage', True) is False:
        return skipped('disabled')
    explicit = recipe.get('legCageMaterials')
    if explicit is not None and (not isinstance(explicit, list) or any(isinstance(i, bool) or not isinstance(i, int) or i < 0 for i in explicit)):
        raise ValueError('legCageMaterials must contain nonnegative source material indices')
    if (recipe.get('skirt') or recipe.get('skirtObjects') and recipe.get('mode') != 'bottom') and explicit is None:
        return skipped('skirt-needs-explicit-trouser-materials')
    if explicit is not None and source_material_indices is None:
        raise ValueError('legCageMaterials requires output-slot source material indices')
    margin = _bounded(recipe, 'legCageMargin', .004, .001, .012)
    maximum = _bounded(recipe, 'legCageMaxShift', .06, .005, .08)
    max_scale = _bounded(recipe, 'legCageMaxScale', 2.5, 1., 3.)
    upper_fade = _bounded(recipe, 'legCageUpperFade', .14, .02, .22)
    points, _all_triangles = math_module.mesh_arrays(obj)
    weights = np.asarray(weights)
    if weights.shape != (len(points), len(math_module.BONES)) or not np.isfinite(weights).all():
        raise ValueError('Leg envelope weights must match canonical source vertices and bones')
    obj.data.calc_loop_triangles()
    selected, protected, triangles = set(), set(), []
    for triangle in obj.data.loop_triangles:
        polygon = obj.data.polygons[triangle.polygon_index]
        slot = polygon.material_index
        name = obj.data.materials[slot].name if obj.data.materials[slot] else ''
        owns = source_material_indices[slot] in explicit if explicit is not None else name.startswith('OriginalBottom_')
        owns = owns and not name.startswith(('OriginalShoes_', 'Skin_', 'Office'))
        if owns:
            selected.update(triangle.vertices)
            triangles.append(list(triangle.vertices))
        else:
            protected.update(triangle.vertices)
    selected.difference_update(protected)
    if not selected or not triangles:
        return skipped('no-original-trousers')
    triangles = np.asarray(triangles, dtype=np.int64)
    body_points, body_triangles = ref.verts, ref.tris
    sides = ('left', 'right')
    columns = [[math_module.B[side + part] for part in ('UpperLeg', 'LowerLeg', 'Foot')] for side in sides]
    shares = np.column_stack([weights[:, indices].sum(1) for indices in columns])
    body_shares = np.column_stack([ref.weights[:, indices].sum(1) for indices in columns])
    centre_x = (ref.joint['leftUpperLeg'][0] + ref.joint['rightUpperLeg'][0]) / 2
    left_is_positive = ref.joint['leftUpperLeg'][0] > ref.joint['rightUpperLeg'][0]
    ownership = np.where(shares.max(1) > .1, shares.argmax(1), np.where((points[:, 0] > centre_x) == left_is_positive, 0, 1))
    low = max(ref.joint[side + 'Foot'][2] for side in sides) + .08
    if recipe.get('shoesBelow') is not None:
        low = max(low, float(recipe['shoesBelow']) + .015)
    high = min(ref.joint[side + 'UpperLeg'][2] for side in sides) - .015
    if high - low < .25:
        return skipped('invalid-leg-span')
    heights = np.linspace(low, high, 72)
    proposed = points.copy()
    stats = []
    for side_index, side in enumerate(sides):
        source_faces = triangles[np.sum(ownership[triangles] == side_index, axis=1) >= 2]
        body_faces = body_triangles[(body_shares[body_triangles, side_index].mean(1) > .35)
            & (body_shares[body_triangles, 1 - side_index].mean(1) < .35)]
        rows = []
        for height in heights:
            source_ring, body_ring = _slice(points, source_faces, height), _slice(body_points, body_faces, height)
            if len(source_ring) < 6 or len(body_ring) < 6:
                continue
            sc, bc = _centre(source_ring), _centre(body_ring)
            scale = min(max_scale, _required_scale(source_ring, body_ring, sc, bc, margin))
            rows.append((height, sc, bc, scale))
        if len(rows) < 6:
            stats.append({'side': side, 'sections': len(rows), 'reason': 'insufficient-cross-sections'})
            continue
        z = np.array([row[0] for row in rows])
        source_centres, body_centres = _smooth([row[1] for row in rows]), _smooth([row[2] for row in rows])
        scales = np.array([row[3] for row in rows])
        # Dilate before smoothing so narrow calf bulges do not get averaged back into the body.
        scales = _smooth(np.array([scales[max(0, i - 2):i + 3].max() for i in range(len(scales))]))
        vertices = np.array(sorted(i for i in selected if ownership[i] == side_index and z[0] <= points[i, 2] <= z[-1]), dtype=np.int64)
        if not len(vertices):
            continue
        h = points[vertices, 2]
        sc = np.column_stack([np.interp(h, z, source_centres[:, axis]) for axis in range(2)])
        bc = np.column_stack([np.interp(h, z, body_centres[:, axis]) for axis in range(2)])
        scale = np.interp(h, z, scales)
        fade = _smoothstep((h - low) / .065) * _smoothstep((high - h) / upper_fade)
        target = bc + (points[vertices, :2] - sc) * scale[:, None]
        proposed[vertices, :2] += (target - points[vertices, :2]) * fade[:, None]
        stats.append({'side': side, 'sections': len(rows), 'maxScale': float(scales.max()), 'vertices': len(vertices)})
    displacement = proposed - points
    lengths = np.linalg.norm(displacement, axis=1)
    peak = float(lengths.max()) if len(lengths) else 0.
    amplitude = min(1., maximum / peak) if peak else 1.
    result = points + displacement * amplitude
    moved = np.nonzero(np.linalg.norm(result - points, axis=1) > 1e-7)[0]
    inverse = obj.matrix_world.inverted()
    for index in moved:
        obj.data.vertices[int(index)].co = inverse @ Vector(result[index])
    obj.data.update()
    return {'movedVertices': len(moved), 'selectedVertices': len(selected), 'maxShift': min(peak, maximum),
        'globalAmplitude': amplitude, 'margin': margin, 'upperFade': upper_fade, 'sections': stats,
        'footwearAndContextUnchanged': True, 'heightUnchanged': True}


def fit_leg_radial_offset(obj, ref, weights, recipe, M, source_material_indices=None):
    """Explicit angular leg clearance, independent of the unchanged legacy cage.

    ``legCageRadialOffset={margin:.008, maximumDisplacement:.06, upperFade:.04}``
    expands only angular sectors where the actual reference leg exceeds original
    trouser coverage. A shared positive radial offset preserves layered folds and
    leaves already loose sectors, source shoes, skin, other garments and weights intact.
    Run late, after shared cages/arm fitting and shoe-role assignment, before
    context generation. The existing legacy fit remains untouched when supplemented.
    """
    config = recipe.get('legCageRadialOffset')
    if config is None or config is False:
        return {'mode': 'angular-radial-offset', 'movedVertices': 0, 'maxShift': 0., 'reason': 'disabled'}
    if config is True:
        config = {}
    if not isinstance(config, dict):
        raise ValueError('legCageRadialOffset must be true or a bounded configuration')
    def bound(key, default, low, high):
        value = config.get(key, default)
        if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) or not low <= value <= high:
            raise ValueError('Invalid legCageRadialOffset ' + key)
        return float(value)
    margin = bound('margin', .008, .002, .015)
    maximum = bound('maximumDisplacement', .06, .005, .08)
    upper_fade = bound('upperFade', .04, .02, .22)
    source_quantile = bound('sourceQuantile', .85, .5, .98)
    explicit = recipe.get('legCageMaterials')
    if explicit is not None and (not isinstance(explicit, list) or any(isinstance(i, bool) or not isinstance(i, int) or i < 0 for i in explicit)):
        raise ValueError('legCageMaterials must contain nonnegative source material indices')
    if explicit is not None and source_material_indices is None:
        raise ValueError('legCageMaterials requires output-slot source material indices')
    if (recipe.get('skirt') or recipe.get('skirtObjects') and recipe.get('mode') != 'bottom') and explicit is None:
        return {'movedVertices': 0, 'maxShift': 0., 'reason': 'skirt-needs-explicit-trouser-materials'}
    points, _faces = M.mesh_arrays(obj)
    weights = np.asarray(weights)
    if weights.shape != (len(points), len(M.BONES)) or not np.isfinite(weights).all():
        raise ValueError('Angular leg envelope requires canonical finite source weights')
    obj.data.calc_loop_triangles()
    selected, protected, triangles = set(), set(), []
    for triangle in obj.data.loop_triangles:
        slot = obj.data.polygons[triangle.polygon_index].material_index
        name = obj.data.materials[slot].name if obj.data.materials[slot] else ''
        owns = name.startswith('OriginalBottom_') and (explicit is None or source_material_indices[slot] in explicit)
        if owns and not name.startswith(('OriginalShoes_', 'Skin_', 'Office')):
            selected.update(triangle.vertices); triangles.append(list(triangle.vertices))
        else:
            protected.update(triangle.vertices)
    selected.difference_update(protected)
    if not triangles or not selected:
        return {'movedVertices': 0, 'maxShift': 0., 'reason': 'no-original-trousers'}
    triangles = np.asarray(triangles, dtype=np.int64)
    sides = ('left', 'right')
    columns = [[M.B[side + part] for part in ('UpperLeg', 'LowerLeg', 'Foot')] for side in sides]
    shares = np.column_stack([weights[:, ids].sum(1) for ids in columns])
    body_shares = np.column_stack([ref.weights[:, ids].sum(1) for ids in columns])
    centre_x = (ref.joint['leftUpperLeg'][0] + ref.joint['rightUpperLeg'][0]) / 2
    left_positive = ref.joint['leftUpperLeg'][0] > ref.joint['rightUpperLeg'][0]
    ownership = np.where(shares.max(1) > .1, shares.argmax(1), np.where((points[:, 0] > centre_x) == left_positive, 0, 1))
    low = max(ref.joint[side + 'Foot'][2] for side in sides) + .08
    if recipe.get('shoesBelow') is not None:
        low = max(low, float(recipe['shoesBelow']) + .015)
    high = min(ref.joint[side + 'UpperLeg'][2] for side in sides) - .015
    proposed, reports = points.copy(), []
    angles = np.linspace(-math.pi, math.pi, 48, endpoint=False)
    for side_index, side in enumerate(sides):
        source_faces = triangles[np.sum(ownership[triangles] == side_index, axis=1) >= 2]
        body_faces = ref.tris[(body_shares[ref.tris, side_index].mean(1) > .35)
            & (body_shares[ref.tris, 1 - side_index].mean(1) < .35)]
        source_vertices = np.array(sorted(i for i in selected if ownership[i] == side_index), dtype=np.int64)
        if not len(source_faces) or not len(source_vertices):
            continue
        bottom = max(low, float(points[source_vertices, 2].min()) + .00005)
        top = min(high, float(points[source_vertices, 2].max()) - .00005)
        if top <= bottom:
            continue
        rows = []
        for height in np.linspace(bottom, top, 96):
            source, body = _slice(points, source_faces, height), _slice(ref.verts, body_faces, height)
            if len(source) < 6 or len(body) < 6:
                continue
            centre = _centre(source)
            sd, bd = source - centre, body - centre
            sa, ba = np.arctan2(sd[:, 1], sd[:, 0]), np.arctan2(bd[:, 1], bd[:, 0])
            sr, br = np.linalg.norm(sd, axis=1), np.linalg.norm(bd, axis=1)
            offsets = []
            for angle in angles:
                s = sr[np.abs(np.arctan2(np.sin(sa - angle), np.cos(sa - angle))) < math.pi / 24]
                b = br[np.abs(np.arctan2(np.sin(ba - angle), np.cos(ba - angle))) < math.pi / 24]
                offsets.append(max(0., float(np.quantile(b, .99) + margin - np.quantile(s, source_quantile))) if len(s) and len(b) else 0.)
            rows.append((height, centre, np.asarray(offsets)))
        if len(rows) < 6:
            reports.append({'side': side, 'sections': len(rows), 'reason': 'insufficient-cross-sections'})
            continue
        z = np.array([row[0] for row in rows])
        centres = _smooth([row[1] for row in rows])
        offsets = np.asarray([row[2] for row in rows])
        # Conservative nearby maxima before smoothing retain small thigh bulges.
        offsets = np.maximum.reduce([np.roll(offsets, shift, axis=1) for shift in (-1, 0, 1)])
        offsets = np.array([offsets[max(0, i - 1):i + 2].max(0) for i in range(len(offsets))])
        offsets = _smooth(offsets)
        # Bound the shared angular field itself. A single narrow dart must not
        # dilute unrelated thigh sectors that already need only a small offset.
        offsets = np.minimum(offsets, maximum)
        vertices = source_vertices[(points[source_vertices, 2] >= z[0]) & (points[source_vertices, 2] <= z[-1])]
        h = points[vertices, 2]
        centre = np.column_stack([np.interp(h, z, centres[:, axis]) for axis in range(2)])
        radial = points[vertices, :2] - centre
        radius = np.linalg.norm(radial, axis=1)
        angle = (np.arctan2(radial[:, 1], radial[:, 0]) + math.pi) * (len(angles) / (2 * math.pi))
        first = np.floor(angle).astype(np.int64) % len(angles)
        ab = angle - np.floor(angle)
        lower = np.clip(np.searchsorted(z, h) - 1, 0, len(z) - 2)
        hb = np.clip((h - z[lower]) / (z[lower + 1] - z[lower]), 0, 1)
        a = offsets[lower, first] * (1 - ab) + offsets[lower, (first + 1) % len(angles)] * ab
        b = offsets[lower + 1, first] * (1 - ab) + offsets[lower + 1, (first + 1) % len(angles)] * ab
        shift = (a * (1 - hb) + b * hb) * _smoothstep((h - low) / .065) * _smoothstep((high - h) / upper_fade)
        proposed[vertices, :2] += radial / np.maximum(radius[:, None], 1e-9) * shift[:, None]
        reports.append({'side': side, 'sections': len(rows), 'vertices': len(vertices), 'maximumFieldOffset': float(offsets.max())})
    displacement = proposed - points
    peak = float(np.linalg.norm(displacement, axis=1).max())
    amplitude = min(1., maximum / peak) if peak else 1.
    result = points + displacement * amplitude
    moved = np.nonzero(np.linalg.norm(result - points, axis=1) > 1e-7)[0]
    inverse = obj.matrix_world.inverted()
    for index in moved:
        obj.data.vertices[int(index)].co = inverse @ Vector(result[index])
    obj.data.update()
    return {'mode': 'angular-radial-offset', 'movedVertices': len(moved), 'selectedVertices': len(selected),
        'maxShift': min(peak, maximum), 'unboundedMaximumDisplacement': peak, 'globalAmplitude': amplitude,
        'margin': margin, 'sourceQuantile': source_quantile, 'upperFade': upper_fade, 'sections': reports,
        'heightWeightsUVFacesMaterialsAndNonTrouserGeometryUnchanged': True}
