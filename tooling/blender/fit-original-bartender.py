"""Fit the original CC-BY bartender vest over the male avatar's licensed shirt/trousers.

Blender --background --factory-startup --python-exit-code 1 --python
    tooling/blender/fit-original-bartender.py -- --source-dir <assets-temp/shirt> [--review <dir>]

The original vest, seam/button meshes, UVs, colours and two exact source PNG payloads are
retained. Moderate boundary-protected reduction targets a complete uniform under 70k
triangles. No source body, template replacement vest, visibility culling or fabric recolour
is used. The native undershirt/trousers retain the avatar-template licence separately.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import sys
from types import SimpleNamespace

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / 'apps/web/local-assets/avatars/original-sets/male/bartender-uniform.glb'
EXPORTER = 'tooling/blender/fit-original-bartender.py'


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


F = load('bartender_original_helpers', 'fit-original-garments.py')
M = F.M
U = load('bartender_native_helpers', 'create-staff-uniforms.py')


def glb(path):
    data = path.read_bytes()
    size = struct.unpack_from('<I', data, 12)[0]
    return json.loads(data[20:20 + size]), data[28 + size:]


def source_images(document, binary):
    result = []
    for image in document['images']:
        view = document['bufferViews'][image['bufferView']]
        start = view.get('byteOffset', 0)
        result.append(binary[start:start + view['byteLength']])
    return result


def world_mesh(obj):
    transform = obj.matrix_world.copy()
    obj.data.transform(transform)
    obj.parent = None
    obj.matrix_world = Matrix.Identity(4)
    obj.data.update()


def protect_reduce(obj, target):
    """Only simplify when needed; preserve open edges and source UV loops/materials."""
    before = sum(len(poly.vertices) - 2 for poly in obj.data.polygons)
    if before <= target:
        return before
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    # Source UV seams are per-loop data; joining truly coincident positions before collapse
    # prevents the two sides of an originally split seam from shrinking independently.
    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=1e-7)
    bm.verts.index_update()
    boundary = [vert.index for vert in bm.verts if vert.is_boundary]
    bm.to_mesh(obj.data)
    bm.free()
    group = obj.vertex_groups.new(name='Original boundary')
    if boundary:
        group.add(boundary, 1.0, 'REPLACE')
    modifier = obj.modifiers.new('Moderate original garment reduction', 'DECIMATE')
    modifier.ratio = max(.03, target / before)
    modifier.use_collapse_triangulate = True
    modifier.vertex_group = group.name
    modifier.vertex_group_factor = 1.0
    modifier.invert_vertex_group = True
    M.apply_modifiers(obj)
    return sum(len(poly.vertices) - 2 for poly in obj.data.polygons)


def bind(obj, ref, weights):
    obj.vertex_groups.clear()
    groups = [obj.vertex_groups.new(name=name) for name in M.BONES]
    weights = M.limit_influences(weights)
    for index, row in enumerate(weights):
        for bone in np.nonzero(row)[0]:
            groups[bone].add([index], float(row[bone]), 'REPLACE')
    obj.parent = ref.rig
    obj.matrix_parent_inverse = Matrix.Identity(4)
    obj.matrix_basis = Matrix.Identity(4)
    for modifier in list(obj.modifiers):
        obj.modifiers.remove(modifier)
    modifier = obj.modifiers.new('Avatar skeleton', 'ARMATURE')
    modifier.object = ref.rig


def mark_sleeves(obj, material_names, ref):
    """Find the scan's isolated cuff-reaching sleeves through position-welded connectivity."""
    positions, triangles = M.mesh_arrays(obj)
    obj.data.calc_loop_triangles()
    selected = [triangle.vertices[:] for triangle in obj.data.loop_triangles
                if material_names[obj.data.polygons[triangle.polygon_index].material_index].startswith('OfficeTop')]
    parent = list(range(len(positions)))
    def find(index):
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index
    def join(a, b):
        parent[find(a)] = find(b)
    used = set(index for triangle in selected for index in triangle)
    welded = {}
    for index in used:
        key = tuple(np.rint(positions[index] * 100000).astype(int))
        if key in welded:
            join(index, welded[key])
        else:
            welded[key] = index
    for a, b, c in selected:
        join(a, b); join(b, c)
    components = {}
    for index in used:
        components.setdefault(find(index), []).append(index)
    found = {}
    for side, sign in (('left', -1), ('right', 1)):
        candidates = []
        shoulder, wrist = ref.joint[side + 'UpperArm'], ref.joint[side + 'Hand']
        for component in components.values():
            points = positions[component]
            if len(component) < 12 or (points[:, 0] * sign).min() <= .025:
                continue
            if np.ptp(points[:, 2]) < .38 or np.linalg.norm(points - wrist, axis=1).min() > .13:
                continue
            if np.linalg.norm(points - shoulder, axis=1).min() > .18:
                continue
            candidates += component
        name = 'Original ' + side + ' sleeve'
        group = obj.vertex_groups.new(name=name)
        if candidates:
            group.add(candidates, 1.0, 'REPLACE')
        found[side] = name
        print('BARTENDER_SLEEVE', side, len(candidates), flush=True)
    return found


def native_base(ref, collection):
    source = ref.objects['ScanOutfit']
    obj = source.copy()
    obj.data = source.data.copy()
    collection.objects.link(obj)
    obj.hide_viewport = obj.hide_render = False
    for modifier in list(obj.modifiers):
        obj.modifiers.remove(modifier)
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    names = [mat.name for mat in obj.data.materials]
    bmesh.ops.delete(bm, geom=[face for face in bm.faces if names[face.material_index].startswith(('OfficeShoes', 'Skin_', 'OfficeAccent'))], context='FACES')
    bm.to_mesh(obj.data)
    bm.free()
    # The scanned male shirt is absent behind its waistcoat. Recolour those complete panels
    # as the inner shirt instead of deleting them and leaving an uncovered chest.
    for index, material in enumerate(list(obj.data.materials)):
        clone = material.copy()
        if material.name.startswith(('OfficeOuter', 'OfficeLining', 'OfficeAccent')):
            clone.name = 'OfficeTop_BartenderUnderlayer'
        elif material.name.startswith('OfficeBelt'):
            clone.name = 'OfficeBottom_BartenderWaist'
        else:
            clone.name = material.name.split('_')[0] + '_BartenderUnderlayer'
        if clone.use_nodes:
            shader = next(node for node in clone.node_tree.nodes if node.type == 'BSDF_PRINCIPLED')
            if clone.name.startswith('OfficeTop'):
                shader.inputs['Base Color'].default_value = (.92, .91, .87, 1)
            elif clone.name.startswith('OfficeBottom'):
                shader.inputs['Base Color'].default_value = (.025, .03, .04, 1)
        obj.data.materials[index] = clone
    old_vest = obj.data.attributes.new('Old native vest', 'INT', 'FACE')
    old_vest.data.foreach_set('value', [int(names[poly.material_index].startswith(('OfficeOuter', 'OfficeLining'))) for poly in obj.data.polygons])
    original_top = {vertex for poly in obj.data.polygons if names[poly.material_index].startswith('OfficeTop') for vertex in poly.vertices}
    shirt_group = obj.vertex_groups.new(name='Original shirt surface')
    shirt_group.add(sorted(original_top), 1.0, 'REPLACE')
    sleeve_names = mark_sleeves(obj, names, ref)
    protect_reduce(obj, 7500)
    positions, _triangles = M.mesh_arrays(obj)
    weights = M.vertex_weights(obj)
    core_weights = M.transfer_weights(positions, ref.verts, ref.core_tris, ref.weights)
    core_weights[:, M.ARM_BONES] = 0
    core_weights /= np.maximum(core_weights.sum(1, keepdims=True), 1e-12)
    body_weights = M.transfer_weights(positions, ref.verts, ref.tris, ref.weights)
    body = SimpleNamespace(head={name: Vector(point) for name, point in ref.joint.items()})
    body.arm = lambda side: [body.head[side + part] for part in U.ARM_PARTS]
    sleeve_indices = {side: obj.vertex_groups[name].index for side, name in sleeve_names.items()}
    sleeve_members = {side: [sum(group.weight for group in vertex.groups if group.group == group_index) > .1
                            for vertex in obj.data.vertices] for side, group_index in sleeve_indices.items()}
    shirt_vertices = {index for poly in obj.data.polygons
                      if obj.data.materials[poly.material_index].name.startswith('OfficeTop')
                      for index in poly.vertices}
    for index, point in enumerate(positions):
        owned = next((side for side in ('left', 'right') if sleeve_members[side][index]), None)
        if owned:
            shoulder, elbow, wrist = body.arm(owned)
            strength = F.smooth(0, 1, (shoulder.z - point[2] - .06) / .08)
            axis = wrist - elbow
            t = (Vector(point) - elbow).dot(axis) / axis.length_squared
            lower = F.smooth(0, 1, (t + .12) / .24)
            hand = weights[index, M.B[owned + 'Hand']] if np.linalg.norm(point - ref.joint[owned + 'Hand']) <= .07 else 0.0
            target = np.zeros(len(M.BONES))
            target[M.B[owned + 'UpperArm']] = (1 - lower) * (1 - hand)
            target[M.B[owned + 'LowerArm']] = lower * (1 - hand)
            target[M.B[owned + 'Hand']] = hand
            weights[index] = body_weights[index] * (1 - strength) + target * strength
        else:
            weights[index, M.ARM_BONES] = 0
            if weights[index].sum() < 1e-8:
                weights[index, M.B['chest']] = 1
            weights[index] /= weights[index].sum()
            if index in shirt_vertices:
                weights[index] = core_weights[index]
    # The renderer's pure-limb hinge cleanup, baked here so the Blender pose review uses
    # the same lower-leg binding and does not leave cloth behind at a bent knee.
    for side in ('left', 'right'):
        for upper, lower, end in (('UpperLeg', 'LowerLeg', 'Foot'), ('UpperArm', 'LowerArm', 'Hand')):
            a, b = M.B[side + upper], M.B[side + lower]
            origin = ref.joint[side + lower]
            axis = ref.joint[side + end] - origin
            length = float(axis @ axis)
            for index, point in enumerate(positions):
                total = weights[index, a] + weights[index, b]
                if total < .97 or weights[index, a] <= 1e-6:
                    continue
                delta = point - origin
                t = float(delta @ axis / length)
                if not 0 < t <= 1 or np.linalg.norm(delta - t * axis) > .13:
                    continue
                allowed = total * (1 - F.smooth(0, 1, t / .24))
                if weights[index, a] > allowed:
                    weights[index, a], weights[index, b] = allowed, total - allowed
    sleeve_region = obj.data.attributes.new('Original sleeve region', 'INT', 'POINT')
    sleeve_region.data.foreach_set('value', [int(any(sleeve_members[side][index] for side in ('left', 'right'))) for index in range(len(positions))])
    leg_bones = [M.B[name] for name in M.BONES if 'Leg' in name or 'Foot' in name]
    for index in shirt_vertices:
        weights[index, leg_bones] = 0
        if weights[index].sum() < 1e-8: weights[index, M.B['hips']] = 1
        weights[index] /= weights[index].sum()
    bind(obj, ref, weights)
    obj.name = 'Original bartender underlayer'
    return obj


def normalize(points):
    result = points * np.array([.013, .013, .0125])
    result += [-.004, .03, -.13]
    return result


def fit_source(obj, ref, correction):
    points, _ = M.mesh_arrays(obj)
    points = normalize(points)
    obj.data.vertices.foreach_set('co', points.reshape(-1))
    obj.data.update()
    if obj.data.has_custom_normals:
        obj.data.normals_split_custom_set([(0.0, 0.0, 0.0)] * len(obj.data.loops))
    core = ref.tris[np.max(ref.weights[:, M.ARM_BONES].sum(1)[ref.tris], axis=1) < .3]
    weights = M.transfer_weights(points, ref.verts, core, ref.weights)
    weights[:, M.ARM_BONES] = 0
    weights /= np.maximum(weights.sum(1, keepdims=True), 1e-12)
    bind(obj, ref, weights)
    for index, material in enumerate(list(obj.data.materials)):
        clone = material.copy()
        clone.name = 'OriginalOuter_Bartender' + material.name
        obj.data.materials[index] = clone


def cover_underlayer(native, vest):
    """Keep a continuous shirt just inside covered vest regions; never alter the vest.

    Deleting the scan's torso cells left serrated collar and armhole boundaries when the
    arms moved. Radial coverage now moves only the hidden native bodice behind the vest.
    The open V, collar and sleeve components retain their complete surfaces.
    """
    from mathutils.bvhtree import BVHTree
    points, triangles = M.mesh_arrays(vest)
    tree = BVHTree.FromPolygons([Vector(point) for point in points], triangles.tolist())
    bm = bmesh.new()
    bm.from_mesh(native.data)
    sleeves = bm.verts.layers.int.get('Original sleeve region')
    old_vest = bm.faces.layers.int.get('Old native vest')
    # The scan includes inner shoulder cap panels extending deep inside its old
    # waistcoat. A clean, closed root at the anatomical shoulder removes those hidden
    # flaps while retaining the visible native sleeves and their cuff detail.
    for sign in (-1, 1):
        faces = [face for face in bm.faces if all(vertex[sleeves] for vertex in face.verts)
                 and face.calc_center_median().x * sign > 0]
        edges = {edge for face in faces for edge in face.edges}
        vertices = {vertex for face in faces for vertex in face.verts}
        cut = bmesh.ops.bisect_plane(bm, geom=list(vertices) + list(edges) + faces,
                                    plane_co=(sign * .157, 0, 0), plane_no=(sign, 0, 0),
                                    clear_inner=True, clear_outer=False)
        rim = [edge for edge in cut['geom_cut'] if isinstance(edge, bmesh.types.BMEdge) and edge.is_boundary]
        if rim:
            bmesh.ops.holes_fill(bm, edges=rim, sides=0)
    for vertex in bm.verts:
        if vertex[sleeves]:
            inset = ((1 - F.smooth(.157, .225, abs(vertex.co.x)))
                     * F.smooth(1.25, 1.35, vertex.co.z))
            vertex.co.y = .03 + (vertex.co.y - .03) * (1 - .75 * inset)
    def body_face(face):
        return (native.data.materials[face.material_index].name.startswith('OfficeTop')
                and not any(vertex[sleeves] for vertex in face.verts))
    edges = {edge for face in bm.faces if body_face(face) and 1.08 < face.calc_center_median().z < 1.61
             for edge in face.edges if edge.calc_length() > .025}
    if edges:
        bmesh.ops.subdivide_edges(bm, edges=sorted(edges, key=lambda edge: edge.index), cuts=1, use_grid_fill=True)
    def hit(point):
        origin = Vector((0, .03, point.z))
        direction = Vector((point.x, point.y - .03, 0))
        if direction.length < .005:
            return None
        direction.normalize()
        location = tree.ray_cast(origin + direction * .003, direction, .45)[0]
        return (origin, direction, location) if location is not None else None
    moved = 0
    for vertex in bm.verts:
        faces = [face for face in vertex.link_faces if body_face(face)]
        if not faces:
            continue
        strength = 1.0 if any(face[old_vest] for face in faces) else 1 - F.smooth(1.44, 1.50, vertex.co.z)
        vertex.co.x *= 1 - .20 * strength
        vertex.co.y = .03 + (vertex.co.y - .03) * (1 - .28 * strength)
        if vertex.co.z > 1.50 and not any(face[old_vest] for face in faces):
            continue
        coverage = hit(vertex.co)
        if coverage is None:
            continue
        origin, direction, surface = coverage
        radius = max(.01, (surface - origin).length - .009)
        if (vertex.co - origin).length > radius:
            vertex.co = origin + direction * radius
            moved += 1
    # The canonical head keeps a low, irregular neck rim. Extend the native collar's
    # back hem over that rim instead of exporting skin teeth below the white collar.
    for vertex in bm.verts:
        if (1.55 < vertex.co.z < 1.65 and abs(vertex.co.x) < .105 and vertex.co.y > -.02
                and any(native.data.materials[face.material_index].name.startswith('OfficeTop') for face in vertex.link_faces)):
            strength = 1 - F.smooth(1.60, 1.65, vertex.co.z)
            vertex.co.x *= 1 + .30 * strength
            vertex.co.y += .014 * strength * F.smooth(0, .05, vertex.co.y)
            vertex.co.z -= .014 * strength
    bm.to_mesh(native.data)
    bm.free()
    native.data.update()
    return moved


def original_native_collar(native, collection):
    """Keep the untouched fitted native collar, independent of hidden bodice fitting."""
    obj = native.copy(); obj.data = native.data.copy(); collection.objects.link(obj)
    bm = bmesh.new(); bm.from_mesh(obj.data)
    old_vest = bm.faces.layers.int.get('Old native vest')
    doomed = []
    for face in bm.faces:
        center = face.calc_center_median()
        if (face[old_vest] or not obj.data.materials[face.material_index].name.startswith('OfficeTop')
                or center.z < 1.535 or abs(center.x) > .125):
            doomed.append(face)
    bmesh.ops.delete(bm, geom=doomed, context='FACES')
    bmesh.ops.delete(bm, geom=[vertex for vertex in bm.verts if not vertex.link_faces], context='VERTS')
    bm.to_mesh(obj.data); bm.free()
    obj.name = 'Native fitted shirt collar'
    return obj


def neat_native_edges(native, ref, collection):
    """A smooth shirt collar and tucked hem replace only the scan's frilled edges."""
    material = next(mat for mat in native.data.materials if mat.name.startswith('OfficeTop'))
    # The original waistcoat has a cropped back. A modest high trouser waist tucks
    # the undershirt into it instead of leaving the scan's broad, untucked white band.
    waist_vertices = {index for face in native.data.polygons
                      if native.data.materials[face.material_index].name.startswith('OfficeBottom')
                      for index in face.vertices}
    for index in waist_vertices:
        vertex = native.data.vertices[index]
        vertex.co.z += .065 * F.smooth(.94, 1.065, vertex.co.z)
    bm = bmesh.new(); bm.from_mesh(native.data)
    sleeves = bm.verts.layers.int.get('Original sleeve region')
    doomed = []
    for face in bm.faces:
        if not native.data.materials[face.material_index].name.startswith('OfficeTop'):
            continue
        center = face.calc_center_median()
        if center.z > 1.535 and abs(center.x) < .13:
            doomed.append(face)
        elif center.z < 1.135 and not any(vertex[sleeves] for vertex in face.verts):
            doomed.append(face)
    bmesh.ops.delete(bm, geom=doomed, context='FACES')
    bmesh.ops.delete(bm, geom=[vertex for vertex in bm.verts if not vertex.link_faces], context='VERTS')
    bm.to_mesh(native.data); bm.free()
    points, faces = [], []
    for rings in (((1.575, .105, .105, .025), (1.600, .100, .100, .025),
                   (1.620, .078, .083, .025)),
                  ((1.035, .125, .050, .030), (1.09, .130, .055, .030),
                   (1.145, .130, .050, .030)),):
        start = len(points)
        for z, rx, ry, cy in rings:
            for index in range(48):
                angle = index * np.pi * 2 / 48
                points.append((np.sin(angle) * rx, cy + np.cos(angle) * ry, z))
        for ring in range(len(rings) - 1):
            for index in range(48):
                a = start + ring * 48 + index; b = start + ring * 48 + (index + 1) % 48
                if start == 0 and (points[a][1] + points[b][1]) / 2 < .025:
                    continue
                faces.append((a, b, b + 48, a + 48))
    mesh = bpy.data.meshes.new('Native shirt smooth collar and hem'); mesh.from_pydata(points, [], faces)
    obj = bpy.data.objects.new(mesh.name, mesh); collection.objects.link(obj)
    mesh.materials.append(material)
    for face in mesh.polygons: face.use_smooth = True
    weights = M.transfer_weights(np.asarray(points), ref.verts, ref.core_tris, ref.weights)
    weights[:, M.ARM_BONES] = 0; weights /= np.maximum(weights.sum(1, keepdims=True), 1e-12)
    weights[:, [M.B[name] for name in M.BONES if 'Leg' in name or 'Foot' in name]] = 0
    weights /= np.maximum(weights.sum(1, keepdims=True), 1e-12)
    bind(obj, ref, weights)
    for item in (native, obj):
        for modifier in list(item.modifiers): item.modifiers.remove(modifier)
    with bpy.context.temp_override(active_object=native, object=native, selected_objects=[native, obj], selected_editable_objects=[native, obj]):
        bpy.ops.object.join()
    return native


def neckline(ref, clothes, collection):
    """Supply only uncovered neck skin; the original broad BodyNeckline is suppressed."""
    from mathutils.bvhtree import BVHTree
    all_points, all_triangles, offset = [], [], 0
    for obj in clothes:
        points, triangles = M.mesh_arrays(obj)
        all_points.extend(Vector(point) for point in points)
        all_triangles.extend((triangles + offset).tolist())
        offset += len(points)
    tree = BVHTree.FromPolygons(all_points, all_triangles)
    original = ref.objects['BodyNeckline']
    obj = original.copy(); obj.data = original.data.copy()
    collection.objects.link(obj)
    for modifier in list(obj.modifiers):
        obj.modifiers.remove(modifier)
    bm = bmesh.new(); bm.from_mesh(obj.data); bm.normal_update()
    # A single planar neck edge sits inside the intact shirt collar. Face-by-face
    # visibility removal made skin-coloured teeth along the back neckline.
    bmesh.ops.bisect_plane(bm, geom=list(bm.verts) + list(bm.edges) + list(bm.faces),
                          plane_co=(0, 0, 1.605), plane_no=(0, 0, 1),
                          clear_inner=True, clear_outer=False)
    bmesh.ops.delete(bm, geom=[vertex for vertex in bm.verts if not vertex.link_faces], context='VERTS')
    bm.to_mesh(obj.data); bm.free()
    if not obj.data.polygons:
        bpy.data.objects.remove(obj, do_unlink=True)
        return None
    for index, mat in enumerate(list(obj.data.materials)):
        clone = mat.copy(); clone.name = 'Skin_OriginalBartenderNeckline'; obj.data.materials[index] = clone
    return obj


def restore_pngs(document, binary, source, payloads):
    """Replace exported source-material image views with the exact original PNG bytes."""
    original = next(mat for mat in source['materials'] if mat['name'] == 'LeatherForVest')
    exported = next(mat for mat in document['materials'] if mat['name'].startswith('OriginalOuter_BartenderLeatherForVest'))
    mapping = {}
    for key, parent in (('baseColorTexture', 'pbrMetallicRoughness'), ('normalTexture', None)):
        a = original[parent][key] if parent else original[key]
        b = exported[parent][key] if parent else exported[key]
        src = source['textures'][a['index']]['source']
        dst = document['textures'][b['index']]['source']
        mapping[document['images'][dst]['bufferView']] = payloads[src]
        document['images'][dst]['mimeType'] = source['images'][src]['mimeType']
    parts, cursor = [], 0
    for index, view in enumerate(document['bufferViews']):
        start = view.get('byteOffset', 0)
        content = mapping.get(index, binary[start:start + view['byteLength']])
        padding = b'\0' * (-cursor % 4)
        parts.append(padding); cursor += len(padding)
        view['byteOffset'], view['byteLength'], view['buffer'] = cursor, len(content), 0
        parts.append(content); cursor += len(content)
    packed = b''.join(parts)
    document['buffers'] = [{'byteLength': len(packed)}]
    return packed


def export(path, ref, obj, source, images):
    bpy.ops.object.select_all(action='DESELECT')
    ref.rig.select_set(True); obj.select_set(True)
    bpy.context.view_layer.objects.active = ref.rig
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=str(path), export_format='GLB', use_selection=True, export_yup=True,
                              export_extras=False, export_texcoords=True, export_normals=True, export_tangents=True,
                              export_materials='EXPORT', export_image_format='AUTO', export_skins=True,
                              export_def_bones=False, export_rest_position_armature=True, export_animations=False,
                              export_morph=False, export_cameras=False, export_lights=False, export_vertex_color='NONE')
    document, binary = glb(path)
    binary = restore_pngs(document, binary, source, images)
    document['asset']['copyright'] = ('Original vest based on Vest For Ray II by ChamberSu1996, CC-BY-4.0; fitted and moderately simplified. '
                                      'Native shirt/trousers use the separate RenderHub Extended Use License. See THIRD_PARTY_NOTICES.md.')
    document['asset']['extras'] = {'source': source['asset'].get('extras', {}), 'exporter': EXPORTER,
                                 'nativeUnderlayerLicense': 'LicenseRef-RenderHub-Extended-Use'}
    for node in document.get('nodes', []):
        if 'mesh' in node:
            node['extras'] = {'extaliaNativeFootwear': True, 'extaliaOwnNeckline': True}
    for material in document['materials']:
        if material['name'].startswith('OriginalOuter_'):
            material['extras'] = {'preserveNativeColor': True}
    encoded = json.dumps(document, ensure_ascii=True, separators=(',', ':')).encode()
    encoded += b' ' * (-len(encoded) % 4)
    binary += b'\0' * (-len(binary) % 4)
    data = struct.pack('<IIIII', 0x46546C67, 2, 28 + len(encoded) + len(binary), len(encoded), 0x4E4F534A)
    data += encoded + struct.pack('<II', len(binary), 0x004E4942) + binary
    path.write_bytes(data)
    restored = source_images(document, binary)
    if sorted(hashlib.sha256(item).hexdigest() for item in restored) != sorted(hashlib.sha256(item).hexdigest() for item in images):
        raise ValueError('Original image payload hashes changed')
    return len(data)


def review(ref, uniform, directory):
    directory.mkdir(parents=True, exist_ok=True)
    scene = bpy.context.scene
    for name, obj in ref.objects.items():
        if obj.type == 'MESH':
            obj.hide_viewport = obj.hide_render = name != 'Body'
    uniform.hide_render = uniform.hide_viewport = False
    for material in uniform.data.materials:
        if material.name.startswith('OfficeTop'):
            material.diffuse_color = (.92, .91, .87, 1)
        elif material.name.startswith('OfficeBottom'):
            material.diffuse_color = (.025, .03, .04, 1)
        elif material.name.startswith('Skin_'):
            material.diffuse_color = (.60, .40, .29, 1)
    for material in ref.objects['Body'].data.materials:
        material.diffuse_color = (.60, .40, .29, 1)
    scene.render.engine = 'BLENDER_WORKBENCH'
    scene.display.shading.light = 'STUDIO'
    scene.display.shading.color_type = 'TEXTURE'
    scene.render.resolution_x, scene.render.resolution_y, scene.render.resolution_percentage = 800, 1000, 100
    camera = bpy.data.objects.new('Original bartender camera', bpy.data.cameras.new('Original bartender camera'))
    scene.collection.objects.link(camera); scene.camera = camera
    camera.data.type, camera.data.ortho_scale = 'ORTHO', 2.05
    for name, angles in U.POSES.items():
        U.pose(ref.rig, angles)
        for side, where in (('front', (0, -4, 1)), ('back', (0, 4, 1)), ('side', (4, -.8, 1))):
            camera.location = where
            camera.rotation_euler = (Vector((0, 0, .95)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
            scene.render.filepath = str(directory / f'bartender-{name}-{side}.png')
            bpy.ops.render.render(write_still=True)
    U.pose(ref.rig, {})
    bpy.ops.wm.save_as_mainfile(filepath=str(directory / 'original-bartender-review.blend'))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-dir', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=OUTPUT)
    parser.add_argument('--review', type=Path)
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
    source_path = args.source_dir / 'male/bartender_vest_style.glb'
    source, source_binary = glb(source_path)
    if not source['asset'].get('extras', {}).get('license', '').startswith('CC-BY-4.0'):
        raise ValueError('Expected the source recorded CC-BY-4.0 licence')
    images = source_images(source, source_binary)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    collection = bpy.data.collections.new('Original bartender uniform')
    bpy.context.scene.collection.children.link(collection)
    ref = M.Reference('male', collection)
    native = native_base(ref, collection)
    imported = M.import_source(str(source_path), collection)
    meshes = [obj for obj in imported if obj.type == 'MESH']
    for obj in meshes:
        world_mesh(obj)
    vest = next(obj for obj in meshes if any(material.name == 'LeatherForVest' for material in obj.data.materials))
    correction = None
    stats = []
    for obj in meshes:
        triangles = sum(len(poly.vertices) - 2 for poly in obj.data.polygons)
        material = obj.data.materials[0].name
        target = 40000 if material == 'LeatherForVest' else 300 if material == 'Metal' else 1800
        reduced = protect_reduce(obj, target)
        fit_source(obj, ref, correction)
        stats.append({'material': material, 'trianglesBefore': triangles, 'trianglesAfter': reduced})
    collar = original_native_collar(native, collection)
    fitted_underlayer_vertices = cover_underlayer(native, vest)
    native = neat_native_edges(native, ref, collection)
    neck = neckline(ref, [native, *meshes], collection)
    additions = [*meshes, collar, *([neck] if neck is not None else [])]
    for obj in [native, *additions]:
        for modifier in list(obj.modifiers):
            obj.modifiers.remove(modifier)
    with bpy.context.temp_override(active_object=native, object=native, selected_objects=[native, *additions], selected_editable_objects=[native, *additions]):
        bpy.ops.object.join()
    native.name = native.data.name = 'Outfit'
    modifier = native.modifiers.new('Avatar skeleton', 'ARMATURE'); modifier.object = ref.rig
    triangles = sum(len(poly.vertices) - 2 for poly in native.data.polygons)
    if triangles > 70000:
        raise ValueError(f'Original bartender exceeds 70k triangle budget: {triangles}')
    size = export(args.output, ref, native, source, images)
    record = {'schema': 'extalia.original-bartender.v1', 'exporter': EXPORTER,
              'path': 'avatars/outfits/male/bartender-uniform.glb', 'bytes': size, 'triangles': triangles,
              'source': source['asset']['extras'], 'nativeUnderlayerLicense': 'LicenseRef-RenderHub-Extended-Use',
              'nativeFootwear': True, 'fittedUnderlayerVertices': fitted_underlayer_vertices, 'ownNeckline': True, 'images': [{'sha256': hashlib.sha256(item).hexdigest(), 'bytes': len(item)} for item in images],
              'simplification': stats}
    args.output.with_suffix('.source.json').write_text(json.dumps(record, indent=2) + '\n')
    (args.output.parent.parent / 'original-bartender.manifest.json').write_text(json.dumps({'uniforms': [record]}, indent=2) + '\n')
    print('ORIGINAL_BARTENDER', json.dumps(record, sort_keys=True), flush=True)
    if args.review:
        review(ref, native, args.review)


if __name__ == '__main__':
    main()
