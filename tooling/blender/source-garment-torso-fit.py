"""A smooth shared radial cage for original torso layers; no surface or UV deletion."""
import math

import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree


def fit_torso_envelope(obj, ref, weights, recipe, M):
    """Clear the body with one angle/height field shared by all cloth layers.

    Actual triangle intersections avoid vertex-density and individual breast/skin
    detail projection. Open garment regions without an intersection add no field.
    Only an explicit recipe enables this additional registration step.
    """
    if not recipe.get('radialTorsoFit'):
        return {'applied': False}
    points, triangles = M.mesh_arrays(obj)
    arm = weights[:, M.ARM_BONES].sum(1)
    body_arm = ref.weights[:, M.ARM_BONES].sum(1)
    low = float(recipe.get('radialTorsoMinimumHeight', .82 if recipe.get('skirt') else .97))
    minimum = .1 if recipe.get('skirt') else .45
    if not math.isfinite(low) or not minimum <= low <= 1.05:
        raise ValueError('Radial fitting minimum height is outside its body/skirt range')
    high, angles = 1.62, 48
    levels = np.linspace(low, high, 49)
    core = ref.tris[np.max(body_arm[ref.tris], axis=1) < .3]
    source_faces = triangles[(np.mean(arm[triangles], axis=1) < .3)
                             & (np.max(points[triangles, 2], axis=1) >= low)
                             & (np.min(points[triangles, 2], axis=1) <= high)]
    if not len(core) or not len(source_faces):
        raise ValueError('Radial torso fitting requires body and torso surfaces')
    body = BVHTree.FromPolygons([Vector(point) for point in ref.verts], core.tolist(), all_triangles=True)
    centres = []
    for height in levels:
        section = ref.verts[(np.abs(ref.verts[:, 2] - height) < .035) & (body_arm < .3)
                            & (np.abs(ref.verts[:, 0]) < .22)]
        centres.append(float((section[:, 1].min() + section[:, 1].max()) / 2) if len(section) else 0.)
    centres = np.asarray(centres)
    original = points.copy()
    maximum = float(recipe.get('radialTorsoMaximum', .08))
    clearance = float(recipe.get('radialTorsoClearance', .012))
    iterations = recipe.get('radialTorsoIterations', 2)
    if not math.isfinite(maximum) or not .01 <= maximum <= .12 or not math.isfinite(clearance) or not .003 <= clearance <= .025:
        raise ValueError('Radial torso displacement and clearance must stay within their bounded fitting range')
    if type(iterations) is not int or not 1 <= iterations <= 4:
        raise ValueError('Radial torso fitting requires one to four iterations')
    touched = np.zeros(len(points), dtype=bool)
    for _iteration in range(iterations):
        cloth = BVHTree.FromPolygons([Vector(point) for point in points], source_faces.tolist(), all_triangles=True)
        deficit = np.zeros((len(levels), angles))
        for row, height in enumerate(levels):
            origin = Vector((0, centres[row], height))
            for column in range(angles):
                angle = column / angles * math.tau
                direction = Vector((math.cos(angle), math.sin(angle), 0))
                surface = cloth.ray_cast(origin, direction, .6)[0]
                if surface is None:
                    continue
                source_radius = (surface - origin).length
                # The outermost body intersection includes both thighs at hip
                # height; torso origins themselves lie inside the body.
                cursor, target = origin.copy(), None
                for _hit in range(12):
                    location = body.ray_cast(cursor, direction, .6)[0]
                    if location is None:
                        break
                    target = (location - origin).length
                    cursor = location + direction * .0001
                if target is not None and source_radius > .035:
                    deficit[row, column] = np.clip(target + clearance - source_radius, 0, maximum)
        for _smooth in range(3):
            deficit = (np.roll(deficit, 1, 1) + deficit * 2 + np.roll(deficit, -1, 1)) / 4
            deficit = (np.vstack((deficit[:1], deficit[:-1])) + deficit * 2
                       + np.vstack((deficit[1:], deficit[-1:]))) / 4
        centre = np.interp(points[:, 2], levels, centres)
        radial = points[:, :2] - np.column_stack((np.zeros(len(points)), centre))
        radius = np.linalg.norm(radial, axis=1)
        angular = (np.arctan2(radial[:, 1], radial[:, 0]) % math.tau) / math.tau * angles
        a = np.floor(angular).astype(int) % angles
        fraction = angular - np.floor(angular)
        shift = np.zeros(len(points))
        selected = (arm < .35) & (points[:, 2] >= low) & (points[:, 2] <= high) & (radius > .035)
        for column in range(angles):
            ids = np.flatnonzero(selected & (a == column))
            if len(ids):
                shift[ids] = (np.interp(points[ids, 2], levels, deficit[:, column]) * (1 - fraction[ids])
                              + np.interp(points[ids, 2], levels, deficit[:, (column + 1) % angles]) * fraction[ids])
        fade = np.clip((points[:, 2] - low) / .08, 0, 1) * np.clip((high - points[:, 2]) / .08, 0, 1)
        shift *= fade
        already = np.linalg.norm(points - original, axis=1)
        shift = np.minimum(shift, np.maximum(0, maximum - already))
        points[:, :2] += radial / np.maximum(radius[:, None], 1e-9) * shift[:, None]
        touched |= shift > 1e-6
    obj.data.vertices.foreach_set('co', points.reshape(-1)); obj.data.update()
    result = {'applied': True, 'vertices': int(touched.sum()),
              'maximumDisplacement': float(np.linalg.norm(points - original, axis=1).max())}
    print('SOURCE_RADIAL_TORSO_FIT', result, flush=True)
    return result
