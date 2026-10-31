"""Fit original textured jeans without replacing, simplifying or projecting their surfaces.

Blender --background --factory-startup --python-exit-code 1 --python
tooling/blender/fit-original-bottoms.py -- --source-dir <assets-temp/shirt> --review <local-directory>

Only local review exports are written. Original UVs, image maps, material colours and faces
are preserved; a smooth body cage and leg-centre adjustment precede four-influence binding.
Each export records the source's own attribution and licence, including Sketchfab Standard.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

ROOT = Path(__file__).resolve().parents[2]
EXPORTER = 'tooling/blender/fit-original-bottoms.py'
SPEC = importlib.util.spec_from_file_location('original_bottom_helpers', Path(__file__).with_name('prepare-avatar-outfits.py'))
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)
skin_spec = importlib.util.spec_from_file_location('original_skin_seams', Path(__file__).with_name('original-skin-seams.py'))
SKIN = importlib.util.module_from_spec(skin_spec)
skin_spec.loader.exec_module(SKIN)
SOURCES = {'female': ('female', 'female_short_jeans.glb', 'short-jeans'),
           'male': ('male', 'male_jeans.glb', 'jeans-standard-review'),
           'male-casual': ('male', 'hoodie_and_jeans.glb', 'jeans')}


def smooth(a, b, values):
    t = np.clip((values - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def document(path):
    data = path.read_bytes()
    length = struct.unpack_from('<I', data, 12)[0]
    return json.loads(data[20:20 + length])


def image_hashes(path):
    data = path.read_bytes()
    length = struct.unpack_from('<I', data, 12)[0]
    gltf = json.loads(data[20:20 + length])
    binary = data[28 + length:]
    hashes = []
    for image in gltf.get('images', []):
        view = gltf['bufferViews'][image['bufferView']]
        start = view.get('byteOffset', 0)
        hashes.append(hashlib.sha256(binary[start:start + view['byteLength']]).hexdigest())
    return sorted(hashes)


def fitted_positions(points, style):
    if style == 'female':
        fitted = points * [.012, .010, .010] + [0, .015, 0]
        fitted[:, 0] *= 1 + .18 * smooth(.99, 1.075, fitted[:, 2])
    elif style == 'male':
        fitted = points * [.145, .145, .170458] + [0, -.030, .091716]
        lower = 1 - smooth(.57, .91, fitted[:, 2])
        ankle = 1 - smooth(.09, .57, fitted[:, 2])
        # Correct the source's mildly spread/backward legs as a continuous cage; retain
        # each tube's local cross-section, wrinkles, seams and all texture coordinates.
        fitted[:, 0] -= np.sign(fitted[:, 0]) * (.015 * lower + .038 * ankle)
        fitted[:, 1] -= .030 * lower
        fitted[:, 2] -= .055 * (1 - smooth(.10, .40, fitted[:, 2]))
    else:
        fitted = points * [.0085, .0065, .010278] + [0, .010, -.009166]
        fitted[:, 0] -= np.sign(fitted[:, 0]) * .025 * (1 - smooth(.25, .85, fitted[:, 2]))
        # Keep the original sneakers on the floor while the waistband overlaps independent
        # shirts. Only a low-frequency upper cage changes; the source faces/UVs stay exact.
        fitted[:, 2] += .045 * smooth(.85, 1.02, fitted[:, 2])
    return fitted


def envelope(points, ref):
    """Low-frequency per-height clearance; never cast/project individual cloth vertices."""
    safe = ref.weights[:, M.ARM_BONES].sum(1) < .05
    body = ref.verts[safe & (ref.verts[:, 2] < 1.15)]
    low, high = float(points[:, 2].min()), float(points[:, 2].max())
    levels = np.linspace(low, high, 48)
    deltas = []
    for z in levels:
        skin = body[np.abs(body[:, 2] - z) < .035]
        cloth = points[np.abs(points[:, 2] - z) < .035]
        if len(skin) < 5 or len(cloth) < 5:
            deltas.append([0, 0, 0])
            continue
        skin_low, skin_high = np.quantile(skin[:, :2], [.015, .985], axis=0)
        cloth_low, cloth_high = np.quantile(cloth[:, :2], [.015, .985], axis=0)
        width = max(abs(cloth_low[0]), abs(cloth_high[0]), .03)
        scale = max(0, (max(abs(skin_low[0]), abs(skin_high[0])) + .006) / width - 1)
        deltas.append([min(scale, .22), max(0, cloth_low[1] - skin_low[1] + .008),
                       max(0, skin_high[1] - cloth_high[1] + .008)])
    field = np.array(deltas)
    for axis in range(3):
        field[:, axis] = np.convolve(np.pad(field[:, axis], 3, mode='edge'), np.ones(7) / 7, mode='valid')
    result = points.copy()
    for index, point in enumerate(points):
        lateral, front, back = [np.interp(point[2], levels, field[:, axis]) for axis in range(3)]
        result[index, 0] *= 1 + lateral
        blend = smooth(-.015, .055, point[1])
        result[index, 1] += -front * (1 - blend) + back * blend
    return result


def garment_weights(points, triangles, ref):
    arm = ref.weights[:, M.ARM_BONES].sum(1)
    lower = ref.tris[(ref.verts[ref.tris].mean(1)[:, 2] < 1.15) & (arm[ref.tris].max(1) < .05)]
    weights = M.transfer_weights(points, ref.verts, lower, ref.weights)
    weights[:, M.ARM_BONES] = 0
    # Seam duplicates share one smoothing graph without welding or changing the source mesh.
    keys = np.round(points * 1_000_000).astype(np.int64)
    _, reverse = np.unique(keys, axis=0, return_inverse=True)
    count = int(reverse.max()) + 1
    field = np.zeros((count, len(M.BONES)))
    counts = np.zeros(count)
    np.add.at(field, reverse, weights)
    np.add.at(counts, reverse, 1)
    field /= counts[:, None]
    neighbours = [set() for _ in range(count)]
    for triangle in reverse[triangles]:
        for a, b in zip(triangle, np.roll(triangle, -1)):
            if a != b:
                neighbours[a].add(int(b))
                neighbours[b].add(int(a))
    weights = M.smooth_field(field, [sorted(row) for row in neighbours], 2, .35)[reverse]
    for side, sign in [('left', -1), ('right', 1)]:
        other = [M.B[name] for name in M.BONES if name.startswith('right' if side == 'left' else 'left') and ('Leg' in name or 'Foot' in name)]
        mask = (points[:, 0] * sign > .025) & (points[:, 2] < .87)
        weights[np.ix_(mask, other)] = 0
    return M.limit_influences(weights)


def bind(obj, points, weights, ref):
    obj.parent = ref.rig
    obj.matrix_parent_inverse = Matrix.Identity(4)
    obj.matrix_basis = Matrix.Identity(4)
    obj.data.vertices.foreach_set('co', points.reshape(-1))
    obj.data.update()
    if obj.data.has_custom_normals:
        obj.data.normals_split_custom_set([(0, 0, 0)] * len(obj.data.loops))
    obj.vertex_groups.clear()
    groups = [obj.vertex_groups.new(name=name) for name in M.BONES]
    for vertex, row in enumerate(weights):
        for bone in np.nonzero(row)[0]:
            groups[bone].add([vertex], float(row[bone]), 'REPLACE')
    for modifier in list(obj.modifiers):
        obj.modifiers.remove(modifier)
    obj.modifiers.new('Original bottom skin', 'ARMATURE').object = ref.rig


def assemble(meshes, ref, collection):
    arrays = [M.mesh_arrays(obj) for obj in meshes]
    points = np.concatenate([part[0] for part in arrays])
    triangles = np.concatenate([part[1] + sum(len(previous[0]) for previous in arrays[:index]) for index, part in enumerate(arrays)])
    selected = list(meshes)
    if ref.group == 'female':
        # Native footwear and ankle skin remain in the renderer. Only uncovered legs
        # above that seam belong to the shorts; the original cloth itself is untouched.
        keep = M.visible_skin(ref, points, triangles, {'hem_band': .10, 'loose': .025})
        centers = ref.verts[ref.tris].mean(1)
        arms = ref.weights[:, M.ARM_BONES].sum(1)[ref.tris].mean(1)
        legs = ref.weights[:, M.LEG_BONES].sum(1)[ref.tris].mean(1)
        keep |= (legs > .75) & (centers[:, 2] < .26)
        # Formal native ankle skin reaches .1516 m; a .14 m leg seam provides a hidden
        # overlap while the renderer retains native footwear skin below .18 m.
        keep &= (centers[:, 2] > .14) & (centers[:, 2] < 1.04) & (arms < .2)
        if keep.any():
            used = np.unique(ref.tris[keep])
            remap = np.full(len(ref.verts), -1, np.int64)
            remap[used] = np.arange(len(used))
            part = M.mesh_part(ref.verts[used], remap[ref.tris[keep]], np.full(int(keep.sum()), M.Z['skin']),
                               ref.weights[used], 'Exposed lower skin', collection, 3500, protect_boundary=True)
            generated_skin = M.build_outfit({'id': 'outfit-original-bottom-context'}, [part], ref, collection)
            SKIN.fit_ankle_skin_seams(generated_skin, ref)
            selected.append(generated_skin)
    # Intact long jeans need no exposed reference skin. Both bottoms keep the already
    # corrected native shoes; no shoe mesh, bare toes or native trouser cuffs are exported.
    active = meshes[0]
    if len(selected) > 1:
        with bpy.context.temp_override(active_object=active, object=active, selected_objects=selected, selected_editable_objects=selected):
            bpy.ops.object.join()
    active.name = active.data.name = 'Piece'
    return active


def export(path, ref, obj, source, source_path, original_triangles):
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    ref.rig.select_set(True)
    bpy.context.view_layer.objects.active = ref.rig
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=str(path), export_format='GLB', use_selection=True, export_yup=True,
                              export_extras=False, export_texcoords=True, export_normals=True, export_materials='EXPORT',
                              export_image_format='AUTO', export_cameras=False, export_lights=False, export_animations=False,
                              export_skins=True, export_morph=False, export_vertex_color='NONE', export_tangents=True,
                              export_def_bones=False, export_rest_position_armature=True)
    data = path.read_bytes()
    length = struct.unpack_from('<I', data, 12)[0]
    result = json.loads(data[20:20 + length])
    credit = source['asset']['extras']
    result['asset']['copyright'] = f"Based on {credit['title']} by {credit['author']}; {credit['license']}. Body-fitted and re-rigged; original garment faces, UVs, textures and native colours retained."
    result['asset']['extras'] = {'source': credit, 'exporter': EXPORTER}
    for material in result.get('materials', []):
        if material['name'].startswith(('OriginalBottom_', 'OriginalShoes_')):
            material['extras'] = {'preserveNativeColor': True}
    encoded = json.dumps(result, ensure_ascii=True, separators=(',', ':')).encode()
    encoded += b' ' * (-len(encoded) % 4)
    tail = data[20 + length:]
    path.write_bytes(struct.pack('<IIIII', 0x46546C67, 2, 20 + len(encoded) + len(tail), len(encoded), 0x4E4F534A) + encoded + tail)
    exported_triangles = sum(result['accessors'][primitive['indices']]['count'] // 3
                             for mesh in result['meshes'] for primitive in mesh['primitives']
                             if result['materials'][primitive['material']]['name'].startswith(('OriginalBottom_', 'OriginalShoes_')))
    if exported_triangles != original_triangles:
        raise ValueError('Original garment faces changed during fitting/export')
    if not set(image_hashes(path)).issubset(set(image_hashes(source_path))):
        raise ValueError('Original embedded texture bytes changed during fitting/export')
    return {'bytes': path.stat().st_size, 'images': len(result.get('images', [])), 'source': credit,
            'triangles': sum(len(face.vertices) - 2 for face in obj.data.polygons), 'exporter': EXPORTER}


def review(ref, outfit, directory, identifier):
    directory.mkdir(parents=True, exist_ok=True)
    for obj in list(bpy.context.scene.objects):
        obj.hide_render = obj != outfit
    public = ROOT / f'apps/web/public-assets/avatars/bodies/{ref.group}/' / ('female-casual.glb' if ref.group == 'female' else 'office-classic.glb')
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(public), loglevel=50)
    imported = set(bpy.data.objects) - before
    rig = next(obj for obj in imported if obj.type == 'ARMATURE')
    owns_shoes = any(material.name.startswith('OriginalShoes_') for material in outfit.data.materials)
    for obj in imported:
        if obj.type != 'MESH':
            continue
        if obj.name.startswith(('Acc', 'Facial', 'ScanOutfitCasual')):
            obj.hide_render = True
        elif obj.name.startswith('ScanOutfit'):
            bm = bmesh.new()
            bm.from_mesh(obj.data)
            weights = M.vertex_weights(obj)
            names = [mat.name for mat in obj.data.materials]
            bm.verts.ensure_lookup_table()
            doomed = []
            for face in bm.faces:
                material = names[face.material_index]
                upper = (obj.matrix_world @ face.calc_center_median()).z >= 1 or np.mean([weights[v.index, M.ARM_BONES].sum() for v in face.verts]) >= .35
                foot = max((obj.matrix_world @ vertex.co).z for vertex in face.verts) < .18
                if material.startswith(('OfficeBottom', 'OfficeBelt')) or (owns_shoes and material.startswith('OfficeShoes')) or (material.startswith(('Skin', 'Nails')) and not upper and (owns_shoes or not foot)):
                    doomed.append(face)
            bmesh.ops.delete(bm, geom=doomed, context='FACES')
            bm.to_mesh(obj.data)
            bm.free()
    helper_spec = importlib.util.spec_from_file_location('bottom_review_poses', Path(__file__).with_name('create-staff-uniforms.py'))
    helper = importlib.util.module_from_spec(helper_spec)
    helper_spec.loader.exec_module(helper)
    for obj in imported | {outfit}:
        if obj.type == 'MESH':
            for material in obj.data.materials:
                if material.name.startswith('OriginalBottom_'):
                    continue
                role = next((role for role in helper.PREVIEW if material.name.startswith(role)), None)
                if role:
                    colour = helper.linear(helper.PREVIEW[role])
                    material.diffuse_color = colour
                    if material.use_nodes:
                        shader = next((n for n in material.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
                        if shader:
                            for link in list(shader.inputs['Base Color'].links): material.node_tree.links.remove(link)
                            shader.inputs['Base Color'].default_value = colour
    scene = bpy.context.scene
    if scene.world is None:
        scene.world = bpy.data.worlds.new('Original bottom review world')
    scene.world.color = (.35, .35, .35)
    scene.render.resolution_x, scene.render.resolution_y, scene.render.resolution_percentage = 720, 900, 100
    camera = bpy.data.objects.new('Original bottom review camera', bpy.data.cameras.new('Original bottom review camera'))
    scene.collection.objects.link(camera)
    scene.camera = camera
    camera.data.type, camera.data.ortho_scale = 'ORTHO', 2.05
    for name, location, energy, size in [('Key', (2, -4, 4), 700, 4), ('Fill', (-3, -1, 2), 500, 3), ('Back', (0, 3, 3), 700, 3)]:
        light = bpy.data.objects.new(name, bpy.data.lights.new(name, 'AREA'))
        scene.collection.objects.link(light)
        light.location = location
        light.rotation_euler = (Vector((0, 0, 1)) - light.location).to_track_quat('-Z', 'Y').to_euler()
        light.data.energy, light.data.shape, light.data.size = energy, 'DISK', size
    for pose_name in ['rest', 'walk', 'sit']:
        helper.pose(ref.rig, helper.POSES[pose_name])
        helper.pose(rig, helper.POSES[pose_name])
        for view, location in [('front', (0, -4, 1)), ('side', (4, -.5, 1))]:
            camera.location = location
            camera.rotation_euler = (Vector((0, 0, .95)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
            scene.render.filepath = str(directory / f'{identifier}-{pose_name}-{view}.png')
            bpy.ops.render.render(write_still=True)
    helper.pose(ref.rig, {})
    helper.pose(rig, {})
    bpy.ops.wm.save_as_mainfile(filepath=str(directory / f'{identifier}-review.blend'))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-dir', required=True, type=Path)
    parser.add_argument('--output', type=Path, default=ROOT / 'apps/web/local-assets/avatars/wardrobe')
    parser.add_argument('--review', type=Path)
    parser.add_argument('--only', choices=list(SOURCES))
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
    results = []
    for style, (group, filename, identifier) in SOURCES.items():
        if (args.only and args.only != style) or (not args.only and style == 'male'):
            continue
        bpy.ops.wm.read_factory_settings(use_empty=True)
        collection = bpy.data.collections.new('Original bottom')
        bpy.context.scene.collection.children.link(collection)
        ref = M.Reference(group, collection)
        path = args.source_dir / group / filename
        source = document(path)
        if not source['asset'].get('extras', {}).get('license'):
            raise ValueError('Original source must retain recorded attribution and licence')
        objects = M.import_source(str(path), collection)
        meshes = [obj for obj in objects if obj.type == 'MESH']
        if style == 'male-casual':
            for obj in list(meshes):
                if 'Jeans_0' not in obj.name:
                    meshes.remove(obj)
                    bpy.data.objects.remove(obj, do_unlink=True)
        all_points = np.concatenate([M.mesh_arrays(obj)[0] for obj in meshes])
        fitted = envelope(fitted_positions(all_points, style), ref)
        offset, original_triangles = 0, 0
        materials = {}
        for obj in meshes:
            points, triangles = M.mesh_arrays(obj)
            original_triangles += len(triangles)
            fitted_points = fitted[offset:offset + len(points)]
            offset += len(points)
            weights = garment_weights(fitted_points, triangles, ref)
            shoe_faces = []
            if style == 'male-casual':
                # This original source has sneakers connected to its jeans in one atlas mesh.
                # Keep all faces/UVs; only give the existing shoe region its own semantic role.
                shoe_faces = [face for face in obj.data.polygons if points[list(face.vertices), 2].mean() < 12]
                shoe_vertices = sorted({vertex for face in shoe_faces for vertex in face.vertices})
                for vertex in shoe_vertices:
                    weights[vertex] = 0
                    side = 'left' if fitted_points[vertex, 0] < 0 else 'right'
                    weights[vertex, M.B[side + 'Foot']] = 1
            bind(obj, fitted_points, weights, ref)
            for index, material in enumerate(list(obj.data.materials)):
                if material not in materials:
                    copy = material.copy()
                    copy.name = 'OriginalBottom_' + identifier.title().replace('-', '')
                    materials[material] = copy
                obj.data.materials[index] = materials[material]
            if shoe_faces:
                shoe_material = obj.data.materials[0].copy()
                shoe_material.name = 'OriginalShoes_CasualJeans'
                obj.data.materials.append(shoe_material)
                for face in shoe_faces:
                    face.material_index = len(obj.data.materials) - 1
        if original_triangles > (16000 if group == 'female' else 24000):
            raise ValueError('Unexpected original garment topology; review before any simplification')
        outfit = assemble(meshes, ref, collection)
        target = (args.output.parent / 'original-bottom-review/rejected' / f'{identifier}.glb'
                  if style == 'male' else args.output / group / 'bottom' / f'{identifier}.glb')
        stats = export(target, ref, outfit, source, path, original_triangles)
        stats.update(group=group, slot='bottom', id=identifier, originalTriangles=original_triangles,
                     path=(f'review-only/{identifier}.glb' if style == 'male' else f'avatars/wardrobe/{group}/bottom/{identifier}.glb'))
        target.with_suffix('.source.json').write_text(json.dumps(stats, indent=2) + '\n')
        results.append(stats)
        print('ORIGINAL_BOTTOM ' + json.dumps(stats), flush=True)
        if args.review:
            review(ref, outfit, args.review / group, identifier)
    print('ORIGINAL_BOTTOMS_COMPLETE ' + json.dumps(results), flush=True)


if __name__ == '__main__':
    main()
