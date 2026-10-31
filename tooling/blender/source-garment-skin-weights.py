"""Keep generated skin bound like the reference body, including small influences."""
import numpy as np
from mathutils import Vector
from mathutils.kdtree import KDTree


def restore_reference_skin_weights(skin, ref, M, tolerance=2e-6):
    """Restore exact reference weights before ankle fitting or context joining.

    Full-resolution exposed skin uses reference vertices. Generic cloth cleanup
    drops weights below 2%; on a moving knee that can displace visible skin by
    several millimetres. This pass preserves the reference's four influences.
    It is deliberately not used for reduced or remeshed context.
    """
    points, _triangles = M.mesh_arrays(skin)
    previous = M.vertex_weights(skin)
    tree = KDTree(len(ref.verts))
    for index, point in enumerate(ref.verts):
        tree.insert(Vector(point), index)
    tree.balance()
    weights = np.zeros_like(previous)
    maximum = 0.
    for index, point in enumerate(points):
        matches = tree.find_range(Vector(point), tolerance)
        if not matches:
            raise ValueError('Full-resolution skin vertex does not match the reference body')
        _point, source, distance = min(matches,
            key=lambda value: float(np.linalg.norm(ref.weights[value[1]] - previous[index])))
        weights[index] = ref.weights[source]
        maximum = max(maximum, distance)
    if not np.isfinite(weights).all() or np.any(weights < 0) or np.any(np.count_nonzero(weights > 0, axis=1) > 4):
        raise ValueError('Reference skin must have at most four finite nonnegative influences')
    sums = weights.sum(1)
    if not np.allclose(sums, 1, atol=1e-6):
        raise ValueError('Reference skin weights must already be normalized')
    skin.vertex_groups.clear()
    for bone, name in enumerate(M.BONES):
        group = skin.vertex_groups.new(name=name)
        for index in np.flatnonzero(weights[:, bone] > 0):
            group.add([int(index)], float(weights[index, bone]), 'REPLACE')
    return {'vertices': len(points), 'maximumRestCorrespondenceError': maximum,
            'maximumWeightCorrection': float(np.max(np.abs(weights - previous)))}
