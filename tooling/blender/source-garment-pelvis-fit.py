"""Shared posterior pelvis clearance, preserving original layers and all corner data."""
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree


def fit_posterior_pelvis(obj, ref, weights, recipe, M):
    if not recipe.get('posteriorPelvisFit'):
        return {'applied': False}
    points, triangles = M.mesh_arrays(obj)
    original = points.copy()
    arm = weights[:, M.ARM_BONES].sum(1)
    body_arm = ref.weights[:, M.ARM_BONES].sum(1)
    low, high = .80, 1.16
    source_faces = triangles[(arm[triangles].mean(1) < .3)
        & (points[triangles, 2].max(1) >= low) & (points[triangles, 2].min(1) <= high)]
    body_faces = ref.tris[body_arm[ref.tris].max(1) < .3]
    if not len(source_faces):
        raise ValueError('Posterior pelvis fitting requires original lower-torso surfaces')
    body = BVHTree.FromPolygons([Vector(p) for p in ref.verts], body_faces.tolist(), all_triangles=True)
    heights, widths = np.linspace(low, high, 37), np.linspace(-.25, .25, 51)
    axis = float(ref.joint['hips'][1])
    direction = Vector((0, 1, 0))
    selected = (arm < .35) & (points[:, 2] > low) & (points[:, 2] < high) & (np.abs(points[:, 0]) < .25)
    smooth = lambda t: (lambda v: v * v * (3 - 2 * v))(np.clip(t, 0, 1))
    for _iteration in range(3):
        cloth = BVHTree.FromPolygons([Vector(p) for p in points], source_faces.tolist(), all_triangles=True)
        deficit = np.zeros((len(heights), len(widths)))
        for row, height in enumerate(heights):
            for column, x in enumerate(widths):
                origin = Vector((x, axis, height))
                surface = cloth.ray_cast(origin, direction, .45)[0]
                if surface is None:
                    continue
                cursor, rear = origin.copy(), None
                for _hit in range(12):
                    hit = body.ray_cast(cursor, direction, .45)[0]
                    if hit is None:
                        break
                    rear = hit[1]
                    cursor = hit + direction * .0001
                if rear is not None:
                    deficit[row, column] = np.clip(rear + .012 - surface[1], 0, .08)
        for _smooth in range(3):
            deficit = (np.pad(deficit, ((0, 0), (1, 1)), mode='edge')[:, :-2] + 2 * deficit
                + np.pad(deficit, ((0, 0), (1, 1)), mode='edge')[:, 2:]) / 4
            deficit = (np.pad(deficit, ((1, 1), (0, 0)), mode='edge')[:-2] + 2 * deficit
                + np.pad(deficit, ((1, 1), (0, 0)), mode='edge')[2:]) / 4
        shift = np.zeros(len(points))
        for index in np.flatnonzero(selected):
            column = np.clip((points[index, 0] - widths[0]) / (widths[-1] - widths[0]) * (len(widths) - 1), 0, len(widths) - 1)
            left = min(int(column), len(widths) - 2)
            mix = column - left
            shift[index] = ((1 - mix) * np.interp(points[index, 2], heights, deficit[:, left])
                + mix * np.interp(points[index, 2], heights, deficit[:, left + 1]))
        shift *= smooth((points[:, 1] - axis + .015) / .04)
        shift *= smooth((points[:, 2] - low) / .07) * smooth((high - points[:, 2]) / .07)
        points[:, 1] += np.minimum(shift, np.maximum(0, .08 - (points[:, 1] - original[:, 1])))
    obj.data.vertices.foreach_set('co', points.reshape(-1)); obj.data.update()
    change = points[:, 1] - original[:, 1]
    return {'applied': True, 'vertices': int(np.count_nonzero(change > 1e-6)),
        'maximumDisplacement': float(change.max()), 'heightAndWidthUnchanged': True}
