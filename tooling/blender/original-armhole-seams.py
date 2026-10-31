"""Add an anatomical cloth underlap behind an original jacket's open armholes.

The original CAD panels can have separate closed-thickness rims whose contact
opens when the arm rises. This additive gusset uses the reference shoulder and
side-chest surface, their native skin binding, and a texel from the original
jacket material. It leaves every original garment face, UV and material intact.
Call ``add_armhole_gussets(outfit, reference, helpers)`` after joining the outfit
and sewing its original source panels, while the rig is in its rest pose.
"""
import bpy
import numpy as np
from mathutils import Matrix


def add_armhole_gussets(outfit, ref, helpers, clearance=-.012, *, material_names=None, material_name=None,
                       lateral_max=.185, rear_inset=True, overlap_faces=False,
                       shoulder_above=.005, front_minimum=-.055, shoulder_below=.235):
    """Join receptionist side-chest underlaps; negative clearance insets the liner.

    This covers the separated CAD panel rims; it does not weld their topology.
    """
    mesh = outfit.data
    slots = [i for i, mat in enumerate(mesh.materials)
             if mat and (mat.name in material_names if material_names is not None else mat.name.startswith('OriginalOuter_'))]
    if not slots or mesh.uv_layers.active is None:
        raise ValueError('Armhole gussets require the original jacket material and UV map')
    # Sample an existing jacket sleeve face. A tiny UV patch avoids inventing an
    # atlas or dragging a logo/trim region across the normally concealed surface.
    choices = []
    for face in mesh.polygons:
        if face.material_index not in slots:
            continue
        center = np.mean([mesh.vertices[i].co[:] for i in face.vertices], axis=0)
        if abs(center[0]) > .16 and 1.30 < center[2] < 1.48:
            choices.append(face)
    if not choices:
        raise ValueError('No original jacket sleeve face is available for the underlap')
    face = max(choices, key=lambda item: item.area)
    original_material = mesh.materials[face.material_index]
    sampled_uv = {layer.name: np.mean([layer.data[index].uv[:] for index in face.loop_indices], axis=0)
                  for layer in mesh.uv_layers}
    uv = sampled_uv[mesh.uv_layers.active.name]
    if material_name:
        original_material = original_material.copy()
        original_material.name = material_name

    points, triangles = ref.verts, ref.tris
    # Keep the medial arm root and adjacent side chest. Native outer-arm and
    # breast surfaces extend beyond this source jacket, so cannot form a liner.
    shoulder = max(ref.joint['leftUpperArm'][2], ref.joint['rightUpperArm'][2])
    region = ((np.abs(points[:, 0]) > .095)
              & (np.abs(points[:, 0]) < lateral_max)
              & (points[:, 2] > shoulder - shoulder_below)
              & (points[:, 2] < shoulder + shoulder_above)
              # The fitted jacket front sits inside the native breast envelope.
              # Keep this lining behind the side/back armhole, not on the bust.
              & ((points[:, 1] > front_minimum) | (points[:, 2] > shoulder - .015)))
    selected = triangles[np.any(region[triangles], axis=1) if overlap_faces else np.all(region[triangles], axis=1)]
    if not len(selected):
        raise ValueError('The reference body has no shoulder surface for armhole underlaps')
    used = np.unique(selected)
    remap = np.full(len(points), -1, np.int64)
    remap[used] = np.arange(len(used))
    # Area-weighted normals in the same coordinates as ref.verts; no per-vertex
    # nearest-surface projection or re-fitting of the source cloth is performed.
    normals = np.zeros_like(points)
    crosses = np.cross(points[triangles[:, 1]] - points[triangles[:, 0]],
                       points[triangles[:, 2]] - points[triangles[:, 0]])
    for corner in range(3):
        np.add.at(normals, triangles[:, corner], crosses)
    normals /= np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-12)
    fitted = points[used] + normals[used] * clearance
    # The source jacket's rear shoulder is shallower than the native body.
    # Monotonically inset only this liner's rear edge, avoiding an exposed flap.
    if rear_inset:
        rear = fitted[:, 1] > .08
        fitted[rear, 1] = .08 + (fitted[rear, 1] - .08) * .25
    # Match the visible body's small influences too. Pruning its sub-2% weights
    # lets the body cross the underlap during a raised-arm pose.
    weights = np.array(ref.weights[used], copy=True)
    if (not np.isfinite(weights).all() or np.any(weights < 0)
            or np.any(np.count_nonzero(weights > 0, axis=1) > 4)
            or not np.allclose(weights.sum(1), 1, atol=1e-6)):
        raise ValueError('Every armhole underlap vertex must retain normalized native binding')

    under_mesh = bpy.data.meshes.new('Original jacket armhole underlap')
    under_mesh.from_pydata(fitted.tolist(), [], remap[selected].tolist())
    under_mesh.materials.append(original_material)
    layers = {name: under_mesh.uv_layers.new(name=name) for name in sampled_uv}
    for polygon in under_mesh.polygons:
        polygon.use_smooth = True
        # Nonzero triangle UV area also keeps the original tangent-space normal
        # map well-defined; all three corners sample the same small cloth patch.
        for name, layer in layers.items():
            for corner, loop in enumerate(polygon.loop_indices):
                layer.data[loop].uv = sampled_uv[name] + np.array(((0, 0), (.0001, 0), (0, .0001))[corner])
    under_mesh.update()
    underlap = bpy.data.objects.new('Original jacket armhole underlap', under_mesh)
    outfit.users_collection[0].objects.link(underlap)
    underlap.parent = ref.rig
    underlap.matrix_parent_inverse = Matrix.Identity(4)
    for bone, name in enumerate(helpers.BONES):
        group = underlap.vertex_groups.new(name=name)
        for index in np.nonzero(weights[:, bone] > 0)[0]:
            group.add([int(index)], float(weights[index, bone]), 'REPLACE')
    modifier = underlap.modifiers.new('Native armhole binding', 'ARMATURE')
    modifier.object = ref.rig
    before = len(mesh.polygons)
    with bpy.context.temp_override(active_object=outfit, object=outfit,
                                   selected_objects=[outfit, underlap],
                                   selected_editable_objects=[outfit, underlap]):
        bpy.ops.object.join()
    expected = before + len(selected)
    if len(outfit.data.polygons) != expected:
        raise ValueError('Joining the underlap changed existing garment face count')
    return {'triangles': int(len(selected)), 'vertices': int(len(used)),
            'material': original_material.name, 'sample_uv': uv.tolist(),
            'sample_uv_layers': {name: value.tolist() for name, value in sampled_uv.items()},
            'clearance': clearance}
