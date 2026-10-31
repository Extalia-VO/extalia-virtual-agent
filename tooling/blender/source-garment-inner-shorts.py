"""Optional concealed body-fitted shorts beneath an original short skirt."""
import bpy
import numpy as np
from mathutils import Matrix


def build_inner_shorts(ref, recipe, collection, M):
    """Return native context only; never edit or replace original skirt panels."""
    if not recipe.get('innerShorts'):
        return None
    if recipe.get('innerShorts') is not True or recipe.get('id') != 'source-school-uniform' or ref.group != 'female':
        raise ValueError('Inner shorts require an explicitly reviewed short-skirt recipe')
    points, triangles = ref.verts, ref.tris
    centres = points[triangles].mean(axis=1)
    arms = ref.weights[:, M.ARM_BONES].sum(axis=1)
    keep = ((centres[:, 2] > .76) & (centres[:, 2] < 1.075) &
            (arms[triangles].max(axis=1) < .15))
    faces = triangles[keep]
    if not len(faces):
        raise ValueError('The reference has no continuous shorts surface')
    normals = np.zeros_like(points)
    cross = np.cross(points[triangles[:, 1]] - points[triangles[:, 0]],
                     points[triangles[:, 2]] - points[triangles[:, 0]])
    for corner in range(3):
        np.add.at(normals, triangles[:, corner], cross)
    normals /= np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-12)
    used = np.unique(faces)
    remap = np.full(len(points), -1, dtype=np.int64); remap[used] = np.arange(len(used))
    coordinates = points[used] + normals[used] * .004
    mesh = bpy.data.meshes.new('Concealed native shorts')
    mesh.from_pydata(coordinates.tolist(), [], remap[faces].tolist()); mesh.update()
    obj = bpy.data.objects.new('Concealed native shorts', mesh); collection.objects.link(obj)
    material = bpy.data.materials.new('OfficeLining_InternalShorts')
    material.use_nodes = True
    shader = material.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = (.012, .025, .045, 1.)
    shader.inputs['Roughness'].default_value = .9
    mesh.materials.append(material)
    # Use the exact reference field, including its small influences, so the
    # concealed shell follows the same body at the hips and seated crotch.
    for bone, name in enumerate(M.BONES):
        group = obj.vertex_groups.new(name=name)
        for vertex in np.flatnonzero(ref.weights[used, bone] > 0):
            group.add([int(vertex)], float(ref.weights[used[vertex], bone]), 'REPLACE')
    obj.parent = ref.rig; obj.matrix_parent_inverse = Matrix.Identity(4)
    obj.modifiers.new('Native shorts skeleton', 'ARMATURE').object = ref.rig
    mesh.shade_smooth()
    return obj, coordinates, remap[faces], ref.weights[used]
