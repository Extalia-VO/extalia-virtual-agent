"""Fit the original dress and receptionist suit while retaining their UVs and materials.

Blender --background --factory-startup --python-exit-code 1 --python
    tooling/blender/fit-original-sets.py -- --source-dir <clothing folder> [--only dress,reception]

These are source garments, not replacement templates. Source topology is retained unless a
high-resolution object exceeds its per-part reduction budget. Original textures stay embedded.
Exports stay local until their body/pose review has passed.
"""
import argparse
import importlib.util
import json
import math
import struct
from pathlib import Path
import sys

import bpy
import numpy as np
from mathutils import Matrix, Vector

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / 'apps/web/local-assets/avatars/original-sets'
EXPORTER = 'tooling/blender/fit-original-sets.py'
spec = importlib.util.spec_from_file_location('original_set_helpers', Path(__file__).with_name('prepare-avatar-outfits.py'))
M = importlib.util.module_from_spec(spec)
spec.loader.exec_module(M)
skin_spec = importlib.util.spec_from_file_location('original_skin_seams', Path(__file__).with_name('original-skin-seams.py'))
SKIN = importlib.util.module_from_spec(skin_spec)
skin_spec.loader.exec_module(SKIN)
armhole_spec = importlib.util.spec_from_file_location('original_armhole_seams', Path(__file__).with_name('original-armhole-seams.py'))
ARMHOLES = importlib.util.module_from_spec(armhole_spec)
armhole_spec.loader.exec_module(ARMHOLES)

SPECS = {
    'dress': {'file': 'dress.glb', 'group': 'female', 'id': 'outfit-original-dress', 'dz': .015, 'budget': 90000},
    'reception': {'file': 'receptionist_black_business_suit_set.glb', 'group': 'female', 'id': 'reception-uniform', 'dz': .07, 'budget': 100000},
}


def smoothstep(low, high, value):
    t = np.clip((value - low) / (high - low), 0, 1)
    return t * t * (3 - 2 * t)


def sleeve_vertices(key, name, points, trim=False):
    if key == 'dress':
        return np.full(len(points), 'Sleeve' in name, bool)
    if name in {'Object_10', 'Object_11', 'Object_12', 'Object_20'}:
        return np.ones(len(points), bool)
    if name == 'Object_21':
        # Shirt cuffs share a source object with the central placket and hem.
        return (np.abs(points[:, 0]) > .16) & (points[:, 2] > 1.0) & (points[:, 2] < 1.10) & (np.abs(points[:, 1]) < .07)
    if name == 'Object_22':
        return np.abs(points[:, 0]) > .13  # This object also includes the central shirt collar.
    if trim:
        return (np.abs(points[:, 0]) > .18) & (points[:, 2] < 1.48) & (points[:, 2] > .80) & (np.abs(points[:, 1]) < .085)
    return np.zeros(len(points), bool)


def arm_map(points, ref, key, core, owners, inner_sleeve=False):
    result = core.copy()
    for side, sign in [('left', -1), ('right', 1)]:
        if key == 'dress':
            source = [Vector((sign * .180, .060, 1.540)), Vector((sign * .214, .040, 1.250))]
            target = [Vector(ref.joint[side + 'UpperArm']), Vector(ref.joint[side + 'LowerArm'])]
            radius = 1.55
        else:
            source = [Vector((sign * .198, .0, 1.455)), Vector((sign * .207, .0, 1.150)), Vector((sign * .210, .0, .845))]
            target = [Vector(ref.joint[side + name]) for name in ['UpperArm', 'LowerArm', 'Hand']]
            radius = 1.04 if inner_sleeve else 1.12
        for index, point in enumerate(points):
            if not owners[index] or point[0] * sign < .12 or point[2] < .8 or point[2] > 1.58:
                continue
            p = Vector(point)
            candidates = []
            for segment in range(len(source) - 1):
                axis = source[segment + 1] - source[segment]
                t = max(0.0, min(1.0, (p - source[segment]).dot(axis) / axis.length_squared))
                near = source[segment] + axis * t
                candidates.append(((p - near).length, segment, t, near))
            distance, segment, t, near = min(candidates)
            src_axis = source[segment + 1] - source[segment]
            dst_axis = target[segment + 1] - target[segment]
            rotated = src_axis.rotation_difference(dst_axis) @ (p - near)
            mapped = target[segment] + dst_axis * t + rotated * radius
            # Both original layers need the same interior map; fading through the
            # actual sleeve cross-section lets a shirt cap cross its enclosing jacket.
            influence = smoothstep(.10, .14, abs(point[0])) * (1 - smoothstep(.12, .18, distance))
            influence *= 1 - smoothstep(1.51, 1.58, point[2])
            root_u = (p - source[0]).dot((source[1] - source[0]).normalized())
            influence *= smoothstep(-.04, .10, root_u)
            result[index] = np.array(mapped) * influence + result[index] * (1 - influence)
    return result


def front_envelope(objects, ref):
    """One smooth monotone cage for every original layer: preserve their nesting and wrinkles."""
    all_points = np.concatenate([M.mesh_arrays(obj)[0] for obj in objects])
    arm = ref.weights[:, M.ARM_BONES].sum(1)
    core = ref.verts[arm < .3]
    levels = np.linspace(.85, 1.60, 61)
    deficits = []
    for height in levels:
        body = core[(np.abs(core[:, 2] - height) < .025) & (np.abs(core[:, 0]) < .13)]
        cloth = all_points[(np.abs(all_points[:, 2] - height) < .025) & (np.abs(all_points[:, 0]) < .115)
                           & (all_points[:, 1] < .025)]
        if len(body) < 5 or len(cloth) < 5:
            deficits.append(0.0)
        else:
            # Use the inner front layer. All source layers receive the same displacement field.
            target = np.percentile(body[:, 1], 5) - .012
            inner = np.percentile(cloth[:, 1], 70)
            deficits.append(max(-.15, min(0, target - inner)))
    for _ in range(4):
        deficits = np.convolve(np.pad(deficits, (2, 2), mode='edge'), np.ones(5) / 5, mode='valid')
    for obj in objects:
        points, _ = M.mesh_arrays(obj)
        shift = np.interp(points[:, 2], levels, deficits)
        front = 1 - smoothstep(-.035, .045, points[:, 1])
        torso = 1 - smoothstep(.14, .21, np.abs(points[:, 0]))
        points[:, 1] += shift * front * torso
        obj.data.vertices.foreach_set('co', points.reshape(-1))
        obj.data.update()


def source_credit(path):
    import struct
    data = path.read_bytes()
    length = struct.unpack_from('<I', data, 12)[0]
    return json.loads(data[20:20 + length])['asset'].get('extras', {})


def bind(obj, ref, key):
    points, triangles = M.mesh_arrays(obj)
    arm_share = ref.weights[:, M.ARM_BONES].sum(1)
    core_triangles = ref.tris[np.max(arm_share[ref.tris], axis=1) < .35]
    weights = M.transfer_weights(points, ref.verts, core_triangles, ref.weights)
    # Garment ownership is anatomical, never a height-only rule: cuffs hang below the waist.
    skirt = (key == 'dress' and ('Skrt' in obj.name or 'Belt' in obj.name)) or any(
        material.name.startswith('OriginalBottom_') for material in obj.data.materials)
    arm_group = obj.vertex_groups.get('Source arm ownership')
    owners = np.array([any(group.group == arm_group.index and group.weight > .5 for group in vertex.groups) for vertex in obj.data.vertices]) if arm_group else sleeve_vertices(key, obj.name, points)
    if skirt:
        weights = M.skirt_weights(points, weights, ref, {'skirt': [1.12, .44 if key == 'dress' else .76]})
    else:
        # Torso panels must not acquire arm influence just because a sleeve rests beside them.
        weights[:, M.ARM_BONES] = 0
        weights /= np.maximum(weights.sum(1, keepdims=True), 1e-9)
    if owners.any():
        if key == 'dress':
            # Sleeve and underlying skin must use the same elbow blend. Transferring only
            # from that arm avoids both skin poke-through and unrelated nearby hip weights.
            for side, sign in [('left', -1), ('right', 1)]:
                selected = owners & (points[:, 0] * sign > 0)
                arm_triangles = ref.tris[(np.max(arm_share[ref.tris], axis=1) > .35)
                                         & (ref.verts[ref.tris, 0].mean(1) * sign > .08)]
                rows = M.transfer_weights(points[selected], ref.verts, arm_triangles, ref.weights)
                rows[:, [M.B['hips'], *M.LEG_BONES]] = 0
                rows /= np.maximum(rows.sum(1, keepdims=True), 1e-9)
                weights[selected] = rows
        else:
            for index, point in enumerate(points):
                if not owners[index]:
                    continue
                side = 'left' if point[0] < 0 else 'right'
                shoulder = Vector(ref.joint[side + 'UpperArm'])
                elbow = Vector(ref.joint[side + 'LowerArm'])
                wrist = Vector(ref.joint[side + 'Hand'])
                upper, lower = elbow - shoulder, wrist - elbow
                p = Vector(point)
                u = (p - shoulder).dot(upper.normalized())
                if u > upper.length:
                    u = upper.length + (p - elbow).dot(lower.normalized())
                cap = float(smoothstep(-.03, .08, u))
                bend = float(smoothstep(upper.length - .055, upper.length + .065, u))
                row = np.zeros(len(M.BONES))
                row[M.B['chest']] = (1 - cap) * .65
                row[M.B[side + 'Shoulder']] = (1 - cap) * .35
                row[M.B[side + 'UpperArm']] = cap * (1 - bend)
                row[M.B[side + 'LowerArm']] = cap * bend
                weights[index] = row
    if skirt and key == 'dress':
        # Below the knee a long skirt follows the shins rather than staying horizontal on the
        # thighs when seated. The shared centre still blends both legs for an intact lap.
        knee = (ref.joint['leftLowerLeg'][2] + ref.joint['rightLowerLeg'][2]) / 2
        shin = (1 - smoothstep(knee - .12, knee + .08, points[:, 2]))[:, None]
        width = abs(ref.joint['leftUpperLeg'][0]) * 1.1
        lateral = np.clip(points[:, 0] / width, -1, 1)
        lower = np.zeros_like(weights)
        lower[:, M.B['leftLowerLeg']] = (1 - lateral) / 2
        lower[:, M.B['rightLowerLeg']] = (1 + lateral) / 2
        weights = weights * (1 - shin) + lower * shin
    weights = M.limit_influences(weights)
    if not np.allclose(weights.sum(1), 1, atol=1e-6):
        raise ValueError('Every original garment vertex must have normalized binding')
    if owners.any() and np.any(weights[owners][:, [M.B['hips'], *M.LEG_BONES]].sum(1) > 1e-6):
        raise ValueError('Original sleeves must never bind to the hips or legs')
    obj.vertex_groups.clear()
    for bone, name in enumerate(M.BONES):
        group = obj.vertex_groups.new(name=name)
        for vertex in np.nonzero(weights[:, bone] > 0)[0]:
            group.add([int(vertex)], float(weights[vertex, bone]), 'REPLACE')
    obj.parent = ref.rig
    obj.matrix_parent_inverse = Matrix.Identity(4)
    modifier = obj.modifiers.new('Original garment rig', 'ARMATURE')
    modifier.object = ref.rig
    return points, triangles


def sew_source_seams(obj, sleeve_parts, shoulder_height=1.33):
    """Join matching original panel borders after fitting; UVs remain separate per face corner.

    CAD garments often store touching sleeve/bodice borders in different mesh objects. Giving
    the same seam two independent weights opens an armpit on a raised arm. Correspondence is
    measured in the original source, never guessed from unrelated fitted surfaces.
    """
    import bmesh
    original = obj.data.attributes.get('Original fit coordinates')
    parts = obj.data.attributes.get('Original fit part')
    if original is None or parts is None:
        return
    source = np.empty(len(obj.data.vertices) * 3);original.data.foreach_get('vector', source)
    source = source.reshape(-1, 3)
    identifiers = np.empty(len(obj.data.vertices), np.int32);parts.data.foreach_get('value', identifiers)
    points, _ = M.mesh_arrays(obj)
    layer_attribute = obj.data.attributes.get('Original seam layer')
    layers = np.ones(len(points), np.int32)
    if layer_attribute:
        layer_attribute.data.foreach_get('value', layers)
    owner_attribute = obj.data.attributes.get('Original arm ownership')
    owners = np.empty(len(points), np.int32)
    if owner_attribute:
        owner_attribute.data.foreach_get('value', owners)
    else:
        owners[:] = np.isin(identifiers, list(sleeve_parts))
    bm = bmesh.new();bm.from_mesh(obj.data);bm.verts.index_update()
    boundary = [v.index for v in bm.verts if v.is_boundary and identifiers[v.index] > 0];bm.free()
    boundary_set = set(boundary)
    # Closed thickness rims have no topological boundary. Sleeve-to-bodice correspondence
    # still exists in their original coordinates, so include those contact vertices too.
    candidates = np.nonzero(identifiers > 0)[0].tolist()
    cells = {};clusters = {};anchors = {};parts_by_cluster = {};reach = .0015
    for index in candidates:
        cell = tuple(np.floor(source[index] / reach).astype(int))
        best = None
        for x in (-1, 0, 1):
            for y in (-1, 0, 1):
                for z in (-1, 0, 1):
                    for cluster in cells.get((cell[0] + x, cell[1] + y, cell[2] + z), []):
                        other = anchors[cluster]
                        if not layers[index] or layers[index] != layers[other]:
                            continue
                        if identifiers[index] in parts_by_cluster[cluster]:
                            continue
                        arm_contact = bool(owners[index] or owners[other])
                        if arm_contact:
                            if min(source[index, 2], source[other, 2]) < shoulder_height:
                                continue
                        elif not (index in boundary_set and other in boundary_set):
                            continue
                        distance = np.linalg.norm(source[index] - source[other])
                        if distance <= reach and np.linalg.norm(points[index] - points[other]) < .05:
                            if best is None or distance < best[0]:
                                best = (distance, cluster)
        if best is None:
            cluster = len(clusters);clusters[cluster] = [index];anchors[cluster] = index
            parts_by_cluster[cluster] = {int(identifiers[index])}
            cells.setdefault(cell, []).append(cluster)
        else:
            cluster = best[1];clusters[cluster].append(index)
            parts_by_cluster[cluster].add(int(identifiers[index]))
    # Each original part contributes at most one vertex to a correspondence. Do not union
    # neighbouring pairs transitively: dense stitched borders must remain a line, not one point.
    weights = M.vertex_weights(obj);touched = []
    for members in clusters.values():
        if len(members) < 2:
            continue
        center = points[members].mean(0)
        row = M.limit_influences(weights[members].mean(0)[None, :])[0]
        for index in members:
            obj.data.vertices[index].co = center
        for group in obj.vertex_groups:
            group.remove(members)
        for bone in np.nonzero(row)[0]:
            obj.vertex_groups[M.BONES[bone]].add(members, float(row[bone]), 'REPLACE')
        touched.extend(members)
    bm = bmesh.new();bm.from_mesh(obj.data);bm.verts.ensure_lookup_table()
    bmesh.ops.remove_doubles(bm, verts=[bm.verts[index] for index in touched], dist=.000001)
    bm.to_mesh(obj.data);bm.free()
    for name in ['Original fit coordinates', 'Original fit part', 'Original arm ownership', 'Original seam layer']:
        if obj.data.attributes.get(name):
            obj.data.attributes.remove(obj.data.attributes[name])
    print('ORIGINAL_SEAMS', len(touched), 'border vertices joined', flush=True)


def build(key, source_dir, collection):
    settings = SPECS[key]
    ref = M.Reference(settings['group'], collection)
    # Fitted sets own their neckline skin; the shared body retains head and hands.
    body_points, body_faces = M.mesh_arrays(ref.objects['Body'])
    ref.shipped_centres = body_points[body_faces].mean(1)
    source = source_dir / settings['group'] / settings['file']
    original = M.import_source(str(source), collection)
    garments = [obj for obj in original if obj.type == 'MESH']
    sleeve_parts = {index + 1 for index, obj in enumerate(garments) if 'Sleeve' in obj.name or key == 'reception' and obj.name in {'Object_10', 'Object_11', 'Object_12', 'Object_20', 'Object_21', 'Object_22'}}
    total = sum(len(obj.data.polygons) for obj in garments)
    material_cache = {}
    for part_index, obj in enumerate(garments):
        obj.data = obj.data.copy()
        obj.data.transform(obj.matrix_world)
        obj.parent = None
        obj.matrix_world = Matrix.Identity(4)
        points, _ = M.mesh_arrays(obj)
        obj.data.attributes.new('Original fit coordinates', 'FLOAT_VECTOR', 'POINT').data.foreach_set('vector', points.reshape(-1))
        obj.data.attributes.new('Original fit part', 'INT', 'POINT').data.foreach_set('value', np.full(len(points), part_index + 1, np.int32))
        layer = 1 if key == 'dress' else next((i for i, tag in enumerate(['uniform_1001', 'uniform_1002', 'uniform_1003'], 1) if any(mat.name.startswith(tag) for mat in obj.data.materials)), 0)
        obj.data.attributes.new('Original seam layer', 'INT', 'POINT').data.foreach_set('value', np.full(len(points), layer, np.int32))
        core = points.copy()
        core[:, 2] += settings['dz']
        if key == 'dress':
            core[:, 2] -= np.maximum(0, points[:, 2] - 1.57) * .45
        trim = any('Button' in mat.name or 'blinn' in mat.name for mat in obj.data.materials)
        obj['sourceTrim'] = trim
        owners = sleeve_vertices(key, obj.name, points, trim)
        if trim:
            # Button/thread components retain one anatomical owner through the fit. Reclassifying
            # them after moving the sleeve can bind two sides of one button to different limbs.
            _, faces = M.mesh_arrays(obj)
            adjacency = [[] for _ in points]
            for a, b, c in faces:
                adjacency[a].extend((b, c));adjacency[b].extend((a, c));adjacency[c].extend((a, b))
            unseen = set(range(len(points)))
            while unseen:
                start = unseen.pop();component = [start];pending = [start]
                while pending:
                    for other in adjacency[pending.pop()]:
                        if other in unseen:
                            unseen.remove(other);component.append(other);pending.append(other)
                center = points[component].mean(0)[None, :]
                owners[component] = sleeve_vertices(key, obj.name, center, True)[0]
        owner_group = obj.vertex_groups.new(name='Source arm ownership')
        selected = np.nonzero(owners)[0].tolist()
        if selected:
            owner_group.add(selected, 1, 'REPLACE')
        points = arm_map(points, ref, key, core, owners, key == 'reception' and obj.name == 'Object_20')
        if key == 'reception' and any(mat.name.startswith('uniform_1003') for mat in obj.data.materials):
            points[:, 0] *= 1.2
        obj.data.vertices.foreach_set('co', points.reshape(-1))
        obj.data.update()
        M.weld_source_seams(obj)
        target = max(120, int(settings['budget'] * len(obj.data.polygons) / max(total, 1)))
        if len(obj.data.polygons) > target * 1.1:
            import bmesh
            bm = bmesh.new(); bm.from_mesh(obj.data); bm.verts.index_update()
            boundary = [v.index for v in bm.verts if v.is_boundary]; bm.free()
            if boundary:
                obj.vertex_groups.new(name='Preserve source panel edges').add(boundary, 1, 'REPLACE')
            M.decimate(obj, target, 'Preserve source panel edges' if boundary else None)
        for index, material in enumerate(list(obj.data.materials)):
            role = 'Bottom' if key == 'reception' and material.name.startswith('uniform_1003') else 'Outer' if key == 'reception' and material.name.startswith('uniform_1001') else 'Top'
            cache_key = (material.name, role)
            if cache_key not in material_cache:
                copy = material.copy(); copy.name = f'Original{role}_{key.title()}{len(material_cache)}'
                material_cache[cache_key] = copy
            obj.data.materials[index] = material_cache[cache_key]
    front_envelope(garments, ref)
    for obj in garments:
        group = obj.vertex_groups['Source arm ownership']
        owners = [int(any(item.group == group.index and item.weight > .5 for item in vertex.groups)) for vertex in obj.data.vertices]
        obj.data.attributes.new('Original arm ownership', 'INT', 'POINT').data.foreach_set('value', owners)
    parts = [bind(obj, ref, key) for obj in garments]
    cloth_vertices = np.concatenate([part[0] for part in parts])
    cloth_faces = np.concatenate([part[1] + sum(len(p[0]) for p in parts[:i]) for i, part in enumerate(parts)])
    keep = M.visible_skin(ref, cloth_vertices, cloth_faces, {'hem_band': .10, 'skin_above': .14})
    centers = ref.verts[ref.tris].mean(1)
    regions = M.body_regions(ref.weights)[ref.tris[:, 0]]
    # Closed original garments replace covered torso skin. Keep only their actual openings;
    # a reference body intersecting a source surface must not produce bare patches through it.
    exposed_core = (centers[:, 2] > 1.50) & (np.abs(centers[:, 0]) < .085)
    if key == 'dress':
        exposed_core |= (np.abs(centers[:, 0]) < .045) & (centers[:, 2] > 1.40)
    exposed_arms = centers[:, 2] < (1.24 if key == 'dress' else 1.04)
    # Keep a continuous anatomical underlap at cuffs and hems. Distance culling near a
    # source border creates saw-tooth skin holes; the original cloth provides occlusion.
    keep = ((keep & (regions == 0) & exposed_core)
            | (np.isin(regions, [1, 2]) & exposed_arms) | np.isin(regions, [3, 4]))
    keep &= centers[:, 2] >= .14
    skin_faces = ref.tris[keep]
    if len(skin_faces):
        used = np.unique(skin_faces); remap = np.full(len(ref.verts), -1, np.int64); remap[used] = np.arange(len(used))
        skin_part = M.mesh_part(ref.verts[used], remap[skin_faces], np.full(len(skin_faces), M.Z['skin']), ref.weights[used], 'Visible original-set skin', collection, 2500, protect_boundary=True)
    else:
        skin_part = None
    extras = []
    if skin_part:
        generated_skin = M.build_outfit({'id': 'outfit-source-skin'}, [skin_part], ref, collection)
        SKIN.fit_ankle_skin_seams(generated_skin, ref)
        extras.append(generated_skin)
    for obj in original:
        if obj.type != 'MESH':
            bpy.data.objects.remove(obj, do_unlink=True)
    for obj in garments + extras:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = garments[0]
    with bpy.context.temp_override(active_object=garments[0], object=garments[0], selected_objects=garments + extras,
                                   selected_editable_objects=garments + extras):
        bpy.ops.object.join()
    outfit = garments[0]
    sew_source_seams(outfit, sleeve_parts, 1.43 if key == 'dress' else 1.33)
    outfit.name = outfit.data.name = 'Outfit'
    if key == 'reception':
        print('ORIGINAL_ARMHOLE_UNDERLAP', ARMHOLES.add_armhole_gussets(outfit, ref, M), flush=True)
    for modifier in list(outfit.modifiers):
        if modifier.type == 'ARMATURE':
            outfit.modifiers.remove(modifier)
    modifier = outfit.modifiers.new('Original garment rig', 'ARMATURE');modifier.object = ref.rig
    return ref, outfit, source_credit(source)


def export(ref, outfit, target):
    bpy.ops.object.select_all(action='DESELECT');ref.rig.select_set(True);outfit.select_set(True)
    bpy.context.view_layer.objects.active = ref.rig
    outfit['extaliaNativeFootwear'] = True
    outfit['extaliaOwnNeckline'] = True
    bpy.ops.export_scene.gltf(filepath=str(target), export_format='GLB', use_selection=True, export_yup=True,
                              export_extras=True, export_animations=False, export_skins=True,
                              export_morph=False, export_def_bones=False, export_rest_position_armature=True)


def solid_fabric_metadata(path):
    """Solid layered cloth must participate in depth testing without transparent sorting.

    The source CAD export marks opaque suit fabrics BLEND. Three.js then sorts the
    enclosing jacket behind the shirt. Change only this render flag; embedded maps,
    source geometry, UVs and colours remain byte-for-byte in the binary chunk.
    """
    data = path.read_bytes()
    length = struct.unpack_from('<I', data, 12)[0]
    document = json.loads(data[20:20 + length])
    changed = 0
    for material in document.get('materials', []):
        if material.get('name', '').startswith('Original') and material.get('alphaMode') == 'BLEND':
            material['alphaMode'] = 'OPAQUE'
            changed += 1
    if changed:
        encoded = json.dumps(document, ensure_ascii=True, separators=(',', ':')).encode()
        encoded += b' ' * (-len(encoded) % 4)
        tail = data[20 + length:]
        header = struct.pack('<IIIII', 0x46546C67, 2, 20 + len(encoded) + len(tail), len(encoded), 0x4E4F534A)
        path.write_bytes(header + encoded + tail)
    print('ORIGINAL_SOLID_FABRIC', changed, 'material render flags corrected', flush=True)


def main():
    parser = argparse.ArgumentParser();parser.add_argument('--source-dir', required=True, type=Path)
    parser.add_argument('--only', default=','.join(SPECS));parser.add_argument('--save-review', type=Path)
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
    bpy.ops.wm.read_factory_settings(use_empty=True)
    manifest_path = OUTPUT / 'sets.manifest.json'
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {'schema': 'extalia.original-garment-sets.v1', 'exporter': EXPORTER, 'sets': []}
    for key in args.only.split(','):
        collection = bpy.data.collections.new('Original ' + key);bpy.context.scene.collection.children.link(collection)
        ref, outfit, credit = build(key, args.source_dir, collection)
        directory = OUTPUT / SPECS[key]['group'];directory.mkdir(parents=True, exist_ok=True)
        target = directory / (SPECS[key]['id'] + '.glb');export(ref, outfit, target)
        solid_fabric_metadata(target)
        manifest['sets'] = [entry for entry in manifest['sets'] if entry['id'] != SPECS[key]['id']]
        manifest['sets'].append({'id': SPECS[key]['id'], 'group': SPECS[key]['group'], 'path': 'avatars/outfits/' + SPECS[key]['group'] + '/' + target.name,
                                 'credit': credit, 'bytes': target.stat().st_size,
                                 'triangles': sum(len(p.vertices) - 2 for p in outfit.data.polygons)})
        print('ORIGINAL_SET', manifest['sets'][-1], flush=True)
        if args.save_review:
            for obj in ref.objects.values():
                obj.hide_render = obj.hide_viewport = obj.type == 'MESH' and obj.name.split('.')[0] not in ('Body', 'BodyNeckline')
            bpy.ops.wm.save_as_mainfile(filepath=str(args.save_review), compress=True, copy=True)
        M.remove_collection(collection)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / 'sets.manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')


if __name__ == '__main__':
    main()
