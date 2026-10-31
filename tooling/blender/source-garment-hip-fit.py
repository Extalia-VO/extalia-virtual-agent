"""Explicit source hip binding to the actual canonical body's surface field.

Run after rest fitting and before binding/context. ``hipBinding: true`` uses
the reviewed defaults; a bounded dictionary may customize the hip band/fades.
Only weights change. Original geometry, UVs, shaders and resting shape survive.
"""
import json
import math

import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree


KNOWN_HIP_SETS = frozenset(('source-chiffon-dress', 'source-cheongsam-pink',
                           'source-beige-suit', 'source-black-simple',
                           'source-leather-skirt-set', 'source-school-uniform',
                           'source-school-uniform-2', 'source-school-uniform-4',
                           'source-black-mesh-dress', 'source-white-suit'))
DEFAULTS = {'minimumHeight': .82, 'maximumHeight': 1.17, 'maximumDistance': .08,
            'heightFade': .04, 'anchorDistance': .025, 'solverIterations': 256}


def _settings(config):
    if config is True:
        config = {}
    if not isinstance(config, dict) or set(config) - set(DEFAULTS):
        raise ValueError('hipBinding requires a boolean or bounded configuration')
    result = {**DEFAULTS, **config}
    bounds = {'minimumHeight': (.70, 1.05), 'maximumHeight': (1.05, 1.25),
              'maximumDistance': (.02, .10), 'heightFade': (.01, .08),
              'anchorDistance': (.005, .05), 'solverIterations': (16, 2048)}
    for key, value in result.items():
        if (isinstance(value, bool) or not isinstance(value, (int, float))
                or not math.isfinite(value) or not bounds[key][0] <= value <= bounds[key][1]):
            raise ValueError('Invalid hipBinding ' + key)
        result[key] = float(value)
    if result['solverIterations'] != int(result['solverIterations']):
        raise ValueError('Hip binding solverIterations must be an integer')
    result['solverIterations'] = int(result['solverIterations'])
    if (result['maximumHeight'] - result['minimumHeight'] <= 2 * result['heightFade']
            or result['anchorDistance'] >= result['maximumDistance']):
        raise ValueError('Hip binding requires a complete height/distance transition')
    return result


def _continuous_source_field(obj, points, values, mapped, targets, distances, eligible, arms, settings):
    """Interpolate close-body anchors over actual source edges, sharing UV nodes.

    Farther loose cloth keeps the original boundary field rather than acquiring
    a discontinuous nearest hip/thigh owner. Only the connected hip region is
    solved; sleeves and native/source footwear cannot enter the auxiliary graph.
    """
    family = np.zeros(len(points), dtype=np.int64)
    family[list(eligible)] = (arms[list(eligible)] < .15).astype(np.int64)
    keys = np.column_stack([np.rint(points * 1e5).astype(np.int64), family])
    _keys, inverse = np.unique(keys, axis=0, return_inverse=True)
    count = np.bincount(inverse)
    original = np.zeros((len(count), values.shape[1]))
    locations = np.zeros((len(count), 3))
    np.add.at(original, inverse, values)
    np.add.at(locations, inverse, points)
    original /= count[:, None]
    locations /= count[:, None]
    nodes = inverse[mapped]
    target_count = np.bincount(nodes, minlength=len(count))
    active = target_count > 0
    target_field = np.zeros_like(original)
    np.add.at(target_field, nodes, targets)
    target_field /= np.maximum(target_count[:, None], 1)
    distance = np.bincount(nodes, weights=distances, minlength=len(count)) / np.maximum(target_count, 1)
    low, high = settings['minimumHeight'], settings['maximumHeight']
    anchors = (active & (distance <= settings['anchorDistance']) &
               (locations[:, 2] >= low + settings['heightFade']) &
               (locations[:, 2] <= high - settings['heightFade']))
    edges = np.array([edge.vertices[:] for edge in obj.data.edges], dtype=np.int64).reshape(-1, 2)
    edges = inverse[edges]
    node_family = np.zeros(len(count), dtype=bool)
    node_family[inverse[family == 1]] = True
    edges = edges[(edges[:, 0] != edges[:, 1]) & node_family[edges[:, 0]] & node_family[edges[:, 1]]]
    edges = np.unique(np.sort(edges, axis=1), axis=0)
    adjacency = [[] for _ in count]
    for a, b in edges:
        adjacency[a].append(b); adjacency[b].append(a)
    reachable = anchors.copy()
    pending = np.flatnonzero(anchors).tolist()
    while pending:
        for neighbor in adjacency[pending.pop()]:
            if active[neighbor] and not reachable[neighbor]:
                reachable[neighbor] = True; pending.append(neighbor)
    field = original.copy()
    field[anchors] = target_field[anchors]
    unknown = np.flatnonzero(reachable & ~anchors)
    iterations, residual = 0, 0.
    if len(unknown):
        lookup = np.full(len(count), -1, dtype=np.int64)
        lookup[unknown] = np.arange(len(unknown))
        lengths = np.linalg.norm(locations[edges[:, 0]] - locations[edges[:, 1]], axis=1)
        conductance = 1. / np.maximum(lengths, .001) ** 2
        directed = np.concatenate([edges, edges[:, ::-1]])
        conductance = np.tile(conductance, 2)
        take = lookup[directed[:, 0]] >= 0
        source, neighbor = lookup[directed[take, 0]], lookup[directed[take, 1]]
        weight = conductance[take]
        diagonal = np.bincount(source, weights=weight, minlength=len(unknown))
        internal = neighbor >= 0
        rhs = np.zeros((len(unknown), values.shape[1]))
        np.add.at(rhs, source[~internal], weight[~internal, None] * field[directed[take, 1][~internal]])
        def multiply(value):
            result = diagonal[:, None] * value
            np.add.at(result, source[internal], -weight[internal, None] * value[neighbor[internal]])
            return result
        solution = field[unknown].copy()
        error = rhs - multiply(solution)
        preconditioned = error / diagonal[:, None]
        direction = preconditioned.copy()
        product = (error * preconditioned).sum(0)
        for iteration in range(settings['solverIterations']):
            transformed = multiply(direction)
            denominator = (direction * transformed).sum(0)
            step = np.divide(product, denominator, out=np.zeros_like(product), where=np.abs(denominator) > 1e-30)
            solution += direction * step
            error -= transformed * step
            preconditioned = error / diagonal[:, None]
            iterations = iteration + 1
            residual = float(np.abs(preconditioned).max())
            if residual < 1e-9:
                break
            next_product = (error * preconditioned).sum(0)
            ratio = np.divide(next_product, product, out=np.zeros_like(product), where=np.abs(product) > 1e-30)
            direction = preconditioned + direction * ratio
            product = next_product
        if not np.isfinite(solution).all() or residual > 1e-4:
            raise ValueError('Hip source-field solve did not converge within its bounded iterations')
        solution = np.maximum(solution, 0.)
        solution /= solution.sum(1, keepdims=True)
        field[unknown] = solution
    mixed = values[mapped].copy()
    mapped_reachable = reachable[nodes]
    mixed[mapped_reachable] = field[nodes[mapped_reachable]]
    return mixed, {'method': 'anchored-source-edge-harmonic', 'solverIterations': iterations,
                   'maximumResidual': residual, 'bodyAnchors': int(anchors.sum()),
                   'solvedNodes': len(unknown), 'mappedNodes': int(active.sum()),
                   'sourceEdgePairs': len(edges), 'auxiliaryUVNodes': len(count),
                   'coincidentSourceWeightsShared': True}


def fit_hip_weights(obj, ref, weights, recipe, M):
    """Return ``(weights, receipt)`` without mutating the mesh or input weights.

    Near the fitted hips, generic skirt-height weights can differ from the
    wearer's own hip/thigh weights. Transfer the actual reference triangle's
    barycentric anchors with harmonic source-edge transitions. Preserve real sub-two-percent
    influences while limiting changed vertices to the GPU's four slots.
    """
    config = recipe.get('hipBinding', False)
    if config is False or config is None:
        return weights, {'applied': False}
    settings = _settings(config)
    if recipe.get('id') not in KNOWN_HIP_SETS or ref.group != 'female':
        raise ValueError('Hip binding requires an explicitly inspected female source set')
    if not np.allclose(np.asarray(obj.matrix_world), np.eye(4), atol=1e-6):
        raise ValueError('Hip binding requires a canonical identity object transform')
    points, _triangles = M.mesh_arrays(obj)
    values = np.asarray(weights)
    if (values.shape != (len(points), len(M.BONES)) or not np.issubdtype(values.dtype, np.floating)
            or not np.isfinite(values).all() or np.any(values < 0)
            or not np.allclose(values.sum(1), 1., atol=1e-5)
            or np.any((values > 0).sum(1) > 4)):
        raise ValueError('Hip binding requires finite normalized canonical four-influence weights')
    eligible, protected = set(), set()
    for face in obj.data.polygons:
        material = obj.data.materials[face.material_index]
        owned = material and material.name.startswith(('OriginalTop_', 'OriginalBottom_',
                                                       'OriginalOuter_', 'OriginalAccent_'))
        (eligible if owned else protected).update(face.vertices)
    eligible.difference_update(protected)
    low, high = settings['minimumHeight'], settings['maximumHeight']
    arms = values[:, M.ARM_BONES].sum(1)
    ids = np.asarray(sorted(i for i in eligible if low < points[i, 2] < high and arms[i] < .15),
                     dtype=np.int64)
    if not len(ids):
        return weights, {'applied': False, 'reason': 'no-owned-source-hips'}
    centres = ref.verts[ref.tris].mean(1)
    body_arms = ref.weights[:, M.ARM_BONES].sum(1)[ref.tris].max(1)
    faces = ref.tris[(body_arms < .15) & (centres[:, 2] > low - .10)
                     & (centres[:, 2] < high + .07)]
    if not len(faces):
        raise ValueError('Hip binding requires the actual full reference hip/thigh surface')
    tree = BVHTree.FromPolygons([Vector(point) for point in ref.verts], faces.tolist(),
                               all_triangles=True)
    result = values.copy()
    mapped, distances, targets = [], [], []
    for index in ids:
        location, _normal, face, distance = tree.find_nearest(Vector(points[index]))
        if location is None or distance >= settings['maximumDistance']:
            continue
        triangle = faces[face]
        vertices = ref.verts[triangle]
        first, second = vertices[1] - vertices[0], vertices[2] - vertices[0]
        offset = np.asarray(location) - vertices[0]
        a, b, c = np.dot(first, first), np.dot(first, second), np.dot(second, second)
        determinant = a * c - b * b
        if abs(determinant) < 1e-20:
            continue
        s = (c * np.dot(offset, first) - b * np.dot(offset, second)) / determinant
        t = (a * np.dot(offset, second) - b * np.dot(offset, first)) / determinant
        barycentric = np.clip([1 - s - t, s, t], 0., 1.)
        barycentric /= barycentric.sum()
        target = barycentric @ ref.weights[triangle]
        mapped.append(int(index)); distances.append(float(distance))
        targets.append(target)
    field_report = {'method': 'anchored-source-edge-harmonic', 'mappedNodes': 0}
    if mapped:
        mapped = np.asarray(mapped, dtype=np.int64)
        mixed, field_report = _continuous_source_field(obj, points, values, mapped, np.asarray(targets),
            np.asarray(distances), eligible, arms, settings)
        np.put_along_axis(mixed, np.argsort(mixed, axis=1)[:, :-4], 0, axis=1)
        mixed /= mixed.sum(1, keepdims=True)
        result[mapped] = mixed
    outside = np.ones(len(points), dtype=bool)
    outside[mapped] = False
    delta = np.abs(result - values)
    report = {'applied': True, 'settings': settings, 'field': field_report, 'eligibleVertices': len(ids),
        'mappedVertices': len(mapped), 'changedVertices': int((delta.max(1) > 1e-7).sum()),
        'maximumWeightChange': float(delta.max()), 'maximumBodyDistanceUsed': max(distances, default=0.),
        'maximumInfluences': int((result > 0).sum(1).max()),
        'maximumNormalizationError': float(np.abs(result.sum(1) - 1).max()),
        'protectedWeightsUnchanged': bool(np.array_equal(result[outside], values[outside])),
        'sleeveWeightsUnchanged': bool(np.array_equal(result[arms > .5], values[arms > .5])),
        'sourceGeometryUVAndMaterialsUnchanged': True}
    print('SOURCE_HIP_BINDING', json.dumps(report), flush=True)
    return result, report
