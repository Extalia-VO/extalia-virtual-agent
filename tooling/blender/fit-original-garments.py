"""Fit original textured garments without replacing their geometry or deleting detail.

Blender --background --factory-startup --python-exit-code 1 --python
    tooling/blender/fit-original-garments.py -- --source-dir <assets-temp/shirt> [--review <directory>]

The first supported source is female/cloth_jacket.glb (Cloth Jacket, CC-BY-4.0).
Its jacket topology, UVs, normal/roughness/base-colour maps and native colours are retained.
The paired inner's visible front is retained; its deliberately occluded back/armholes are cropped. The sleeve centreline is mapped onto the body's two-segment rest arm
before binding; no visibility culling, decimation or nearest-surface projection is used.
"""
import argparse
import importlib.util
import json
import math
from pathlib import Path
import struct
import sys

import bpy
import bmesh
import numpy as np
from mathutils import Matrix, Vector

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / 'apps/web/local-assets/avatars/wardrobe/female'
EXPORTER = 'tooling/blender/fit-original-garments.py'
SPEC = importlib.util.spec_from_file_location('original_garment_helpers', Path(__file__).with_name('prepare-avatar-outfits.py'))
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)


def smooth(a, b, value):
    t = max(0.0, min(1.0, (value - a) / max(b - a, 1e-12)))
    return t * t * (3 - 2 * t)


def source_document(path):
    data = path.read_bytes()
    size = struct.unpack_from('<I', data, 12)[0]
    return json.loads(data[20:20 + size])


def ancestors(obj):
    result = []
    while obj is not None:
        result.append(obj.name)
        obj = obj.parent
    return result


def plane_section(vertices, triangles, x):
    """Actual sleeve cross-section, independent of vertex density or UV seam duplication."""
    samples = []
    for triangle in triangles:
        for a, b in zip(triangle, np.roll(triangle, -1)):
            va, vb = vertices[a], vertices[b]
            if (va[0] - x) * (vb[0] - x) < 0:
                t = (x - va[0]) / (vb[0] - va[0])
                samples.append(va + (vb - va) * t)
    if not samples:
        raise ValueError('Missing source sleeve section')
    points = np.array(samples)
    low, high = np.quantile(points[:, 1:], [.02, .98], axis=0)
    return np.array([x, *(low + high) / 2])


def sleeve_curves(vertices, triangles):
    curves = {}
    for side, sign in (('left', -1), ('right', 1)):
        # The cuff/sections are measured from this original source. The broad shoulder seam
        # itself is not an anatomical joint; the root is a documented fitting landmark.
        points = [np.array([sign * .82, .29, 6.42])]
        points += [plane_section(vertices, triangles, sign * x) for x in np.linspace(.9, 2.6, 35)]
        points.append(np.array([sign * 2.65, -.14, 5.17]))
        curve = np.array(points)
        lengths = np.linalg.norm(np.diff(curve, axis=0), axis=1)
        curves[side] = (curve, np.r_[0.0, np.cumsum(lengths)])
    return curves


def nearest_curve(point, curve, distances):
    starts, delta = curve[:-1], np.diff(curve, axis=0)
    t = np.clip(np.einsum('ij,ij->i', point - starts, delta) / np.maximum((delta * delta).sum(1), 1e-12), 0, 1)
    centers = starts + delta * t[:, None]
    index = int(np.argmin(np.linalg.norm(point - centers, axis=1)))
    tangent = delta[index] / max(np.linalg.norm(delta[index]), 1e-12)
    arc = distances[index] + t[index] * (distances[index + 1] - distances[index])
    return centers[index], tangent, float(arc / distances[-1])


def frame(tangent):
    normal = np.array([0.0, 1.0, 0.0])
    normal -= tangent * float(np.dot(normal, tangent))
    normal /= max(np.linalg.norm(normal), 1e-12)
    binormal = np.cross(tangent, normal)
    return normal, binormal


def target_arm(ref, side, ratio):
    shoulder, elbow, wrist = (ref.joint[side + suffix] for suffix in ('UpperArm', 'LowerArm', 'Hand'))
    upper, lower = elbow - shoulder, wrist - elbow
    a, b = np.linalg.norm(upper), np.linalg.norm(lower)
    distance = ratio * (a + b)
    if distance <= a:
        center = shoulder + upper * (distance / a)
    else:
        center = elbow + lower * ((distance - a) / b)
    blend = smooth(a - .035, a + .035, distance)
    tangent = upper / a * (1 - blend) + lower / b * blend
    tangent /= np.linalg.norm(tangent)
    weights = np.zeros(len(M.BONES))
    weights[M.B[side + 'UpperArm']] = 1 - blend
    weights[M.B[side + 'LowerArm']] = blend
    return center, tangent, weights


def front_envelope(points, body_points, clearance=.012, low=1.05, high=1.53):
    """Smooth per-height front clearance, preserving the source's local folds and UVs.

    Pass already registered torso-only garment/body points. Every front point at a given
    height gets the same interpolated translation; there is no nipple-by-nipple projection.
    The caller must exclude sleeves (for example using known source object/landmark regions).
    """
    levels = np.linspace(low, high, 40)
    deficits = []
    for z in levels:
        body = body_points[np.abs(body_points[:, 2] - z) < .028]
        source = points[np.abs(points[:, 2] - z) < .035]
        if len(body) < 4 or len(source) < 4:
            deficits.append(0.0)
            continue
        body_front = float(np.quantile(body[:, 1], .05))
        source_front = float(np.quantile(source[:, 1], .05))
        deficits.append(max(0.0, source_front - (body_front - clearance)))
    # Smooth the height field, not the garment's own coordinates or wrinkles.
    values = np.pad(np.array(deficits), 3, mode='edge')
    values = np.convolve(values, np.ones(7) / 7, mode='valid')
    result = points.copy()
    for index, point in enumerate(points):
        if not low <= point[2] <= high:
            continue
        band = body_points[np.abs(body_points[:, 2] - point[2]) < .04]
        center = float(np.median(band[:, 1])) if len(band) else .035
        front = 1 - smooth(center - .02, center + .05, point[1])
        result[index, 1] -= np.interp(point[2], levels, values) * front
    return result


def torso_positions(points, role):
    fitted = points.copy()
    fitted[:, 0] *= .215
    # A shared depth frame keeps the two source layers nested exactly as authored.
    fitted[:, 1] = points[:, 1] * .28 - .024
    fitted[:, 2] = points[:, 2] * .24 - .0243
    high = fitted[:, 2] > 1.62
    fitted[high, 2] = 1.62 + (fitted[high, 2] - 1.62) * .42
    # A low-frequency chest cage supplies the female body's front envelope while retaining
    # every original vertex/UV and its high-frequency folds. No nearest-face projection is
    # applied: only front torso panels are eased, never sleeves, collar or the back.
    for index, point in enumerate(points):
        x, z = abs(fitted[index, 0]), fitted[index, 2]
        band = smooth(1.08, 1.23, z) * (1 - smooth(1.49, 1.59, z))
        front = 1 - smooth(.10, .35, point[1])
        middle = 1 - smooth(.16, .23, x)
        envelope = (-.165 if role == 'top' else -.185) + .026 * (x / .23) ** 2
        fitted[index, 1] -= max(0, fitted[index, 1] - envelope) * band * front * middle
        if role == 'outer':
            back = smooth(.08, .30, point[1])
            back_envelope = .165 - .025 * (x / .23) ** 2
            fitted[index, 1] += max(0, back_envelope - fitted[index, 1]) * band * back * middle
    return fitted


def crop_paired_inner(obj):
    """Retain the source's visible central front, not its deliberately occluded back/armholes.

    Shirt_low was authored only for this jacket. Its hidden panels are not a complete
    standalone garment; explicit planar coverage avoids them emerging through the moving coat.
    UVs on the retained front and interpolated cut boundaries stay on the original atlas.
    """
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.transform(obj.matrix_world)
    for point, normal in (((-.16, 0, 0), (1, 0, 0)), ((.16, 0, 0), (1, 0, 0)), ((0, .05, 0), (0, 1, 0))):
        bmesh.ops.bisect_plane(bm, geom=[*bm.verts, *bm.edges, *bm.faces], dist=1e-7,
                               plane_co=Vector(point), plane_no=Vector(normal))
    bmesh.ops.delete(bm, geom=[face for face in bm.faces if abs(face.calc_center_median().x) > .16
                             or face.calc_center_median().y > .05], context='FACES')
    bmesh.ops.delete(bm, geom=[vert for vert in bm.verts if not vert.link_faces], context='VERTS')
    bm.to_mesh(obj.data)
    bm.free()
    obj.parent = None
    obj.matrix_world = Matrix.Identity(4)


def fit_mesh(obj, ref, curves, role):
    points, triangles = M.mesh_arrays(obj)
    fitted = torso_positions(points, role)
    torso_triangles = ref.tris[np.max(ref.weights[:, M.ARM_BONES].sum(1)[ref.tris], axis=1) < .35]
    weights = M.transfer_weights(fitted, ref.verts, torso_triangles, ref.weights)
    if role == 'outer':
        for index, point in enumerate(points):
            side = 'left' if point[0] < 0 else 'right'
            curve, distances = curves[side]
            center, tangent, ratio = nearest_curve(point, curve, distances)
            source_n, source_b = frame(tangent)
            target, target_t, arm_weights = target_arm(ref, side, ratio)
            target_n, target_b = frame(target_t)
            offset = point - center
            mapped = target + target_n * np.dot(offset, source_n) * .24 + target_b * np.dot(offset, source_b) * .24
            # Keep a tilted cuff rim, rather than flattening all vertices onto one wrist plane.
            mapped += target_t * np.dot(offset, tangent) * .24
            radial = np.linalg.norm(offset - tangent * np.dot(offset, tangent))
            blend = smooth(.65, 1.02, abs(point[0])) * (1 - smooth(.44, .70, radial))
            fitted[index] = fitted[index] * (1 - blend) + mapped * blend
            weights[index] = weights[index] * (1 - blend) + arm_weights * blend
    obj.parent = ref.rig
    obj.matrix_parent_inverse = Matrix.Identity(4)
    obj.matrix_basis = Matrix.Identity(4)
    obj.data.vertices.foreach_set('co', fitted.reshape(-1))
    obj.data.update()
    if obj.data.has_custom_normals:
        obj.data.normals_split_custom_set([(0.0, 0.0, 0.0)] * len(obj.data.loops))
    obj.vertex_groups.clear()
    groups = [obj.vertex_groups.new(name=name) for name in M.BONES]
    weights = M.limit_influences(weights)
    for vertex, row in enumerate(weights):
        for bone in np.nonzero(row)[0]:
            groups[bone].add([vertex], float(row[bone]), 'REPLACE')
    for modifier in list(obj.modifiers):
        obj.modifiers.remove(modifier)
    modifier = obj.modifiers.new('Original garment skin', 'ARMATURE')
    modifier.object = ref.rig
    obj.name = obj.data.name = 'Piece'
    # Clone per role because the source shares one atlas material between the two meshes.
    for index, material in enumerate(list(obj.data.materials)):
        copy = material.copy()
        copy.name = ('OriginalTop_' if role == 'top' else 'OriginalOuter_') + 'ClothJacket'
        obj.data.materials[index] = copy
    return fitted, triangles


def add_skin(obj, ref, fitted, triangles, collection):
    keep = M.visible_skin(ref, fitted, triangles, {'hem_band': .09})
    centers = ref.verts[ref.tris].mean(1)
    arms = ref.weights[:, M.ARM_BONES].sum(1)[ref.tris].mean(1) >= .35
    keep &= arms  # The complete underlayer covers the torso; only exposed arms need skin.
    if not keep.any():
        return
    used = np.unique(ref.tris[keep])
    remap = np.full(len(ref.verts), -1, np.int64)
    remap[used] = np.arange(len(used))
    part = M.mesh_part(ref.verts[used], remap[ref.tris[keep]], np.full(int(keep.sum()), M.Z['skin']),
                       ref.weights[used], 'Exposed reference skin', collection, 3500, protect_boundary=True)
    skin = M.build_outfit({'id': 'outfit-original-skin'}, [part], ref, collection)
    with bpy.context.temp_override(active_object=obj, object=obj, selected_objects=[obj, skin], selected_editable_objects=[obj, skin]):
        bpy.ops.object.join()


def export_piece(path, ref, obj, source):
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    ref.rig.select_set(True)
    bpy.context.view_layer.objects.active = ref.rig
    for bone in ref.rig.pose.bones:
        bone.matrix_basis = Matrix.Identity(4)
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=str(path), export_format='GLB', use_selection=True, export_yup=True,
                              export_extras=False, export_texcoords=True, export_normals=True, export_materials='EXPORT',
                              export_image_format='AUTO', export_cameras=False, export_lights=False, export_animations=False,
                              export_skins=True, export_morph=False, export_vertex_color='NONE', export_tangents=True,
                              export_def_bones=False, export_rest_position_armature=True)
    data = path.read_bytes()
    length = struct.unpack_from('<I', data, 12)[0]
    document = json.loads(data[20:20 + length])
    paired_inner = any(material['name'].startswith('OriginalTop_') for material in document.get('materials', []))
    geometry_note = ('Visible front retained; occluded paired-inner panels cropped. ' if paired_inner
                     else 'Original jacket topology retained. ')
    document['asset']['copyright'] = ('Based on Cloth Jacket by Curtis Kinney, CC-BY-4.0; body-fitted and re-rigged for Extalia. '
                                       + geometry_note + 'Native UVs, textures and materials retained. See THIRD_PARTY_NOTICES.md.')
    document['asset']['extras'] = {'source': source['asset'].get('extras', {}), 'exporter': EXPORTER,
                                 'pairedInnerFrontOnly': paired_inner, 'nonStandalone': paired_inner}
    if not paired_inner:
        for node in document.get('nodes', []):
            if 'mesh' in node:
                node.setdefault('extras', {})['extaliaWardrobeCoverage'] = {
                    'kind': 'closed-jacket', 'frontHalfWidth': .045,
                    'frontMinDepth': .04, 'collarMinHeight': 1.52,
                }
    for material in document.get('materials', []):
        if material['name'].startswith('Original'):
            material['extras'] = {'preserveNativeColor': True}
    encoded = json.dumps(document, ensure_ascii=True, separators=(',', ':')).encode()
    encoded += b' ' * (-len(encoded) % 4)
    tail = data[20 + length:]
    encoded = struct.pack('<IIIII', 0x46546C67, 2, 20 + len(encoded) + len(tail), len(encoded), 0x4E4F534A) + encoded + tail
    path.write_bytes(encoded)
    if len(encoded) > 15_000_000:
        raise ValueError('Original garment exceeds the 15 MB review budget')
    return {'bytes': len(encoded), 'images': len(document.get('images', [])), 'materials': len(document.get('materials', []))}


def review(ref, pieces, directory):
    directory.mkdir(parents=True, exist_ok=True)
    scene = bpy.context.scene
    for name, obj in ref.objects.items():
        if obj.type == 'MESH':
            obj.hide_viewport = obj.hide_render = name not in ('Body', 'BodyNeckline', 'ScanOutfit')
    # Keep only the scan's trousers and shoes, as review context rather than exported replacements.
    scan = ref.objects['ScanOutfit']
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(scan.data)
    slots = {index for index, mat in enumerate(scan.data.materials) if mat.name.startswith(('OfficeBottom', 'OfficeShoes', 'Skin_'))}
    bmesh.ops.delete(bm, geom=[face for face in bm.faces if face.material_index not in slots], context='FACES')
    bm.to_mesh(scan.data)
    bm.free()
    for obj in (ref.objects['Body'], ref.objects['BodyNeckline']):
        for material in obj.data.materials:
            if material.use_nodes:
                shader = next((node for node in material.node_tree.nodes if node.type == 'BSDF_PRINCIPLED'), None)
                if shader:
                    for link in list(shader.inputs['Base Color'].links):
                        material.node_tree.links.remove(link)
                    shader.inputs['Base Color'].default_value = (.60, .40, .29, 1)
    scene.render.engine = 'BLENDER_WORKBENCH'
    scene.display.shading.light = 'STUDIO'
    scene.display.shading.color_type = 'TEXTURE'
    scene.render.resolution_x, scene.render.resolution_y, scene.render.resolution_percentage = 800, 1000, 100
    camera = bpy.data.objects.new('Original garment review camera', bpy.data.cameras.new('Original garment review camera'))
    scene.collection.objects.link(camera)
    scene.camera = camera
    camera.data.type, camera.data.ortho_scale = 'ORTHO', 2.05
    U = importlib.util.spec_from_file_location('original_uniform_review', Path(__file__).with_name('create-staff-uniforms.py'))
    helper = importlib.util.module_from_spec(U)
    U.loader.exec_module(helper)
    for pose_name, angles in helper.POSES.items():
        helper.pose(ref.rig, angles)
        for view, where in (('front', (0, -4, 1)), ('back', (0, 4, 1)), ('side', (4, -.8, 1))):
            camera.location = where
            camera.rotation_euler = (Vector((0, 0, .95)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
            scene.render.filepath = str(directory / f'cloth-jacket-{pose_name}-{view}.png')
            bpy.ops.render.render(write_still=True)
    helper.pose(ref.rig, {})
    bpy.ops.wm.save_as_mainfile(filepath=str(directory / 'cloth-jacket-review.blend'))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-dir', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=OUTPUT)
    parser.add_argument('--review', type=Path)
    parser.add_argument('--standalone-skin', action='store_true', help='review exposed arm skin; this source inner is not approved standalone')
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
    path = args.source_dir / 'female/cloth_jacket.glb'
    source = source_document(path)
    if not source['asset'].get('extras', {}).get('license', '').startswith('CC-BY-4.0'):
        raise ValueError('Expected the recorded source CC-BY-4.0 licence')
    bpy.ops.wm.read_factory_settings(use_empty=True)
    collection = bpy.data.collections.new('Original Cloth Jacket')
    bpy.context.scene.collection.children.link(collection)
    ref = M.Reference('female', collection)
    objects = M.import_source(str(path), collection)
    meshes = [obj for obj in objects if obj.type == 'MESH']
    jacket = next(obj for obj in meshes if 'Jacket_low' in ancestors(obj))
    curves = sleeve_curves(*M.mesh_arrays(jacket))
    result = []
    for obj in meshes:
        role = 'top' if 'Shirt_low' in ancestors(obj) else 'outer'
        if role == 'top':
            crop_paired_inner(obj)
        fitted, triangles = fit_mesh(obj, ref, curves, role)
        if role == 'top' and args.standalone_skin:
            add_skin(obj, ref, fitted, triangles, collection)
        target = args.output / role / ('cloth-shirt.glb' if role == 'top' else 'cloth-jacket.glb')
        stats = export_piece(target, ref, obj, source)
        triangles_count = sum(len(poly.vertices) - 2 for poly in obj.data.polygons)
        if triangles_count > 30_000:
            raise ValueError('Original garment exceeds the triangle review budget')
        result.append({'id': target.stem, 'group': 'female', 'slot': role, 'triangles': triangles_count,
                       'standalone': role == 'outer', **stats})
    print('ORIGINAL_GARMENT', json.dumps(result, sort_keys=True), flush=True)
    if args.review:
        review(ref, meshes, args.review)


if __name__ == '__main__':
    main()
