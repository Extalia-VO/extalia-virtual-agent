"""Explicit source-material accessory groups, moved together without reweighting.

Call before binding/context after garment fitting. A reviewed recipe can set
``rigidAccessories=[{sourceMaterials:[...], pivot:[x,y,z], translation:[x,y,z],
rotationDegrees:[x,y,z], scale:1.0, maximumDisplacement:.12}]`` in canonical
metres. One rigid/similarity transform preserves every part's relative shape,
all UV corners, faces, material slots and existing weights. No part is inferred
from colour, names, height or its nearest body point.
"""
import math

import numpy as np
from mathutils import Euler


def _vector(value, name):
    if (not isinstance(value, (list, tuple)) or len(value) != 3
            or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in value)):
        raise ValueError('Accessory ' + name + ' must be three finite numbers')
    return np.asarray(value, dtype=float)


def fit_accessory_groups(obj, ref, recipe, M, source_material_indices):
    """Return a receipt; change only explicitly selected source coordinates."""
    groups = recipe.get('rigidAccessories', [])
    if not isinstance(groups, list):
        raise ValueError('Accessory groups must be a list')
    if not groups:
        return {'applied': False}
    if not np.allclose(np.asarray(obj.matrix_world), np.eye(4), atol=1e-6):
        raise ValueError('Accessory groups require a canonical identity object transform')
    points, _faces = M.mesh_arrays(obj)
    original, result, touched, reports = points.copy(), points.copy(), set(), []
    slots = []
    for index, material in enumerate(obj.data.materials):
        source = (source_material_indices.get(material.name) if isinstance(source_material_indices, dict)
                  else source_material_indices[index])
        if type(source) is not int or source < 0:
            raise ValueError('Accessory transform requires explicit source material identity')
        slots.append(source)
    for group in groups:
        if not isinstance(group, dict) or set(group) - {'sourceMaterials', 'pivot', 'translation', 'rotationDegrees', 'scale', 'maximumDisplacement'}:
            raise ValueError('Unknown accessory group fields')
        materials = group.get('sourceMaterials')
        if (not isinstance(materials, list) or not materials
                or any(type(value) is not int or value < 0 for value in materials)
                or len(materials) != len(set(materials))):
            raise ValueError('Accessory group requires unique source material indices')
        selected, outside, present = set(), set(), set()
        for face in obj.data.polygons:
            source = slots[face.material_index]
            if source in materials:
                selected.update(face.vertices); present.add(source)
            else:
                outside.update(face.vertices)
        if present != set(materials) or selected & outside or selected & touched:
            raise ValueError('Accessory group must contain complete disjoint source parts')
        pivot = _vector(group.get('pivot'), 'pivot')
        shift = _vector(group.get('translation', [0, 0, 0]), 'translation')
        angles = _vector(group.get('rotationDegrees', [0, 0, 0]), 'rotationDegrees')
        scale, maximum = group.get('scale', 1.), group.get('maximumDisplacement', .12)
        if (isinstance(scale, bool) or not isinstance(scale, (int, float)) or not math.isfinite(scale) or not .8 <= scale <= 1.2
                or isinstance(maximum, bool) or not isinstance(maximum, (int, float)) or not math.isfinite(maximum) or not .005 <= maximum <= .20
                or np.linalg.norm(shift) > .15 or np.max(np.abs(angles)) > 45):
            raise ValueError('Accessory transform exceeds bounded reviewed similarity settings')
        rotation = np.asarray(Euler(tuple(np.radians(angles)), 'XYZ').to_matrix(), dtype=float)
        ids = np.asarray(sorted(selected), dtype=np.int64)
        result[ids] = (original[ids] - pivot) @ rotation.T * scale + pivot + shift
        distance = np.linalg.norm(result[ids] - original[ids], axis=1)
        if distance.max() > maximum:
            raise ValueError('Accessory group exceeds its reviewed displacement budget')
        touched.update(selected)
        reports.append({'sourceMaterials': materials, 'vertices': len(ids), 'pivot': pivot.tolist(),
                        'translation': shift.tolist(), 'rotationDegrees': angles.tolist(), 'scale': scale,
                        'maximumDisplacement': float(distance.max())})
    # Write only after every group validates; invalid settings leave geometry intact.
    obj.data.vertices.foreach_set('co', result.reshape(-1)); obj.data.update()
    return {'applied': True, 'groups': reports, 'vertices': len(touched), 'weightsUnchanged': True}
