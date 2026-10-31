"""Opt-in knee articulation for already-owned long skirt/coat vertices.

Use the full anatomical field, or add just knees to an existing skirt field.
Source points, triangles, UVs, materials, and lateral leg sharing are untouched.
Callers must restrict input to skirt-owned cloth, excluding sleeves and shoes.
"""
import numpy as np


def articulated_skirt_weights(points, weights, ref, bone_indices, *, waist=1.04,
                              thigh_depth=.18, above=.08, below=.12):
    """Anatomical hip/lap/knee field independent of the garment's hem length.

    A long dress must follow the same upper thigh as a short skirt. Hem length
    therefore never appears in the hip-to-thigh transition. Input is restricted
    to caller-owned skirt vertices; hanging sleeves must not be included.
    """
    hip = float(np.mean([ref.joint[side + 'UpperLeg'][2] for side in ('left', 'right')]))
    finish = hip - thigh_depth
    if waist <= finish or thigh_depth <= 0:
        raise ValueError('Skirt waist must be above the anatomical thigh transition')
    thigh = np.clip((waist - points[:, 2]) / (waist - finish), 0, 1)
    thigh = thigh * thigh * (3 - 2 * thigh)
    width = abs(float(ref.joint['leftUpperLeg'][0])) * 1.1
    lateral = np.clip(points[:, 0] / max(width, 1e-6), -1, 1)
    field = np.zeros_like(weights)
    field[:, bone_indices['hips']] = 1 - thigh
    field[:, bone_indices['leftUpperLeg']] = thigh * (1 - lateral) / 2
    field[:, bone_indices['rightUpperLeg']] = thigh * (1 + lateral) / 2
    mix = np.clip((waist - points[:, 2]) / .06, 0, 1)
    mix = mix * mix * (3 - 2 * mix)
    result = weights * (1 - mix[:, None]) + field * mix[:, None]
    return add_skirt_knee_bend(points, result, ref, bone_indices, above=above, below=below)


def add_skirt_knee_bend(points, weights, ref, bone_indices, *, above=.08, below=.12):
    """Transfer thigh share to the corresponding shin across a smooth knee band.

    ``bone_indices`` is the canonical name-to-column mapping (M.B). The function
    preserves each side's total influence and normalizes no unrelated fields.
    It is intended for hems below the knee; short skirts require no change.
    """
    if above <= 0 or below <= 0:
        raise ValueError('Skirt knee transition distances must be positive')
    result = weights.copy()
    for side in ('left', 'right'):
        knee = float(ref.joint[side + 'LowerLeg'][2])
        blend = np.clip((knee + above - points[:, 2]) / (above + below), 0, 1)
        blend = blend * blend * (3 - 2 * blend)
        thigh, shin = (bone_indices[side + part] for part in ('UpperLeg', 'LowerLeg'))
        transfer = result[:, thigh] * blend
        result[:, thigh] -= transfer
        result[:, shin] += transfer
    if not np.all(np.isfinite(result)) or not np.allclose(result.sum(1), weights.sum(1), atol=1e-9):
        raise ValueError('Skirt knee articulation changed total vertex influence')
    return result
