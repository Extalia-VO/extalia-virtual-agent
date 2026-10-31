"""Fit source GLB clothing while retaining original corner UVs and material graphs.

Blender --background --factory-startup --python-exit-code 1 --python
tooling/blender/fit-source-garments.py -- --source-dir <assets-temp/shirt>
    --group female|male [--only id,id] [--review <directory>]

Outputs are local review candidates. Registration and rig compatibility are not publication
approval: every recipe must also pass source/fitted appearance and activity review.
"""
import argparse
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import re
import sys
import tempfile

import bmesh
import bpy
import numpy as np
from mathutils import Matrix
from mathutils.bvhtree import BVHTree
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).parent
OUTPUT = ROOT / 'apps/web/local-assets/avatars/all-garment-review/fitted'
EXPORTER = 'tooling/blender/fit-source-garments.py'


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


M = module('source_garment_math', 'prepare-avatar-outfits.py')
G = module('source_garment_materials', 'original-gltf-materials.py')
S = module('source_garment_skin', 'original-skin-seams.py')
TORSO = module('source_garment_torso_cage', 'fit-original-sets.py')
LOD = module('source_garment_detail_lod', 'source-garment-lod.py')
BINDING = module('source_garment_topology_binding', 'source-garment-binding.py')
ARMS = module('source_garment_sleeve_fit', 'source-garment-arm-fit.py')
SHOULDERS = module('source_garment_shoulder_corrective', 'source-garment-shoulder-corrective.py')
RADIAL = module('source_garment_radial_fit', 'source-garment-torso-fit.py')
PELVIS = module('source_garment_posterior_fit', 'source-garment-pelvis-fit.py')
SKIRT = module('source_garment_skirt_fit', 'source-garment-skirt.py')
UNDERLAP = module('source_garment_underlap', 'original-armhole-seams.py')
LEGS = module('source_garment_leg_fit', 'source-garment-leg-fit.py')
ROLES = module('source_garment_roles', 'source-garment-roles.py')
SEATED = module('source_garment_seated_fit', 'source-garment-seated-fit.py')
LAYERED = module('source_garment_layered_drape', 'source-garment-layered-drape.py')
ANKLES = module('source_garment_ankle_backing', 'source-garment-ankles.py')
SKIN_WEIGHTS = module('source_garment_skin_weights', 'source-garment-skin-weights.py')
ACCESSORIES = module('source_garment_accessories', 'source-garment-accessories.py')
HIPS = module('source_garment_hip_weights', 'source-garment-hip-fit.py')
INNER_SHORTS = module('source_garment_inner_shorts', 'source-garment-inner-shorts.py')
WALK = module('source_garment_walk_drape', 'source-garment-walk-fit.py')


def walk_matrices(packet, ref):
    """Use eight production samples of both gaits at ordinary and fast stride."""
    if (not isinstance(packet, dict) or packet.get('schemaVersion') != 1
            or packet.get('coordinateFrame') != 'blender-z-up'
            or packet.get('commonRootMotionOmitted') is not True
            or packet.get('boneNames') != list(M.BONES)
            or packet.get('activity') != 'none' or packet.get('walk') != 1 or packet.get('sit') != 0):
        raise ValueError('Walk drape requires a production-generated canonical walk packet')
    joints = packet.get('restJoints', {})
    if not isinstance(joints, dict) or any(name not in joints for name in M.BONES):
        raise ValueError('Walk packet is missing reference joints')
    locations = np.asarray([joints[name] for name in M.BONES], dtype=float)
    if (locations.shape != (len(M.BONES), 3) or not np.isfinite(locations).all()
            or np.max(np.linalg.norm(locations - np.array([ref.joint[name] for name in M.BONES]), axis=1)) > 1e-4):
        raise ValueError('Walk packet does not match the garment reference rig')
    rows = packet.get('poses')
    if not isinstance(rows, list) or not 32 <= len(rows) <= 384:
        raise ValueError('Walk packet needs bounded production profiles')
    selected = []
    for gait in ('feminine', 'masculine'):
        for stride in (1., 1.6):
            profile = [row for row in rows if isinstance(row, dict) and row.get('heightCm') == 170
                       and row.get('gait') == gait and row.get('stride') == stride]
            profile.sort(key=lambda row: row.get('phase', -1))
            if len(profile) not in (8, 16):
                raise ValueError('Walk packet needs 8 or 16 phases for every gait and stride')
            phases = np.asarray([row.get('phase') for row in profile], dtype=float)
            if (not np.isfinite(phases).all()
                    or not np.allclose(phases, np.arange(len(profile)) * 2 * math.pi / len(profile), atol=1e-7)):
                raise ValueError('Walk packet phases must uniformly cover the complete cycle')
            selected.extend(row.get('matrices') for row in profile[::len(profile) // 8])
    matrices = np.asarray(selected, dtype=float)
    if matrices.shape != (32, len(M.BONES), 4, 4) or not np.isfinite(matrices).all():
        raise ValueError('Walk packet requires finite canonical skinning matrices')
    return matrices


def matches(patterns, value):
    return any(re.search(pattern, value, re.I) for pattern in patterns)


def source_document(path):
    import struct
    data = path.read_bytes()
    length = struct.unpack_from('<I', data, 12)[0]
    return json.loads(data[20:20 + length])


def source_material_index(material, document):
    name = material.name if material else ''
    match = re.match(r'^ExtaliaSourceMaterial_(\d+)_', name)
    if not match or int(match[1]) >= len(document.get('materials', [])):
        raise ValueError('Cannot establish encoded original material identity: ' + name)
    return int(match[1])


def import_indexed_source(path, document, collection):
    # Name identity is not unique in glTF. Temporary stable indices avoid conflating two
    # authored materials named "Material", unnamed materials, or Blender suffix collisions.
    from copy import deepcopy
    _data, _original, binary, chunks = G._read_glb(path)
    indexed = deepcopy(document)
    for index, material in enumerate(indexed.get('materials', [])):
        material['name'] = f'ExtaliaSourceMaterial_{index}_' + material.get('name', 'Unnamed')
    with tempfile.TemporaryDirectory(prefix='extalia-garment-import-') as directory:
        temporary = Path(directory) / 'indexed.glb'
        temporary.write_bytes(G._encode_glb(indexed, binary, chunks))
        return M.import_source(str(temporary), collection)


def role_for(recipe, obj, material):
    original_name = re.sub(r'^ExtaliaSourceMaterial_\d+_', '', material.name) if material else ''
    names = {'object': obj.name, 'material': original_name}
    for kind, pattern, role in recipe.get('roleRules', []):
        if re.search(pattern, names[kind], re.I):
            return role
    return recipe.get('defaultRole', 'auto')


def combine_original(objects, recipe, document):
    """Keep all original face-corner data; only explicit non-garment exclusions are allowed."""
    bm = bmesh.new()
    zone = bm.faces.layers.int.new('zone')
    part = bm.faces.layers.int.new('part')
    anatomy = bm.faces.layers.int.new('anatomy')
    materials, bindings, colours, avatars, records = [], {}, {}, [], []
    depsgraph = bpy.context.evaluated_depsgraph_get()
    selected = [obj for obj in objects if obj.type == 'MESH']
    # from_mesh does not add new custom-data layers after its first append. Declare
    # their union before even a UV-less trim can establish the shared BMesh schema.
    uv_names = sorted({layer.name for obj in selected for layer in obj.data.uv_layers})
    for name in uv_names:
        bm.loops.layers.uv.new(name)
    for domain, kind, name in sorted({(layer.domain, layer.data_type, layer.name)
            for obj in selected for layer in obj.data.color_attributes}):
        layers = bm.verts.layers if domain == 'POINT' else bm.loops.layers
        colours_layer = layers.color if kind == 'BYTE_COLOR' else layers.float_color
        if colours_layer.get(name) is None:
            colours_layer.new(name)
    for obj in sorted(selected, key=lambda item: item.name):
        if recipe.get('sourceSelection') and not matches(recipe['sourceSelection'], obj.name):
            continue
        if matches(recipe.get('dropObjects', []), obj.name):
            continue
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh(preserve_all_data_layers=True, depsgraph=depsgraph)
        try:
            mesh.transform(obj.matrix_world)
            if matches(recipe.get('sourceAvatar', []), obj.name):
                vertices = np.array([vertex.co[:] for vertex in mesh.vertices])
                avatars.append(vertices)
                continue
            if obj.matrix_world.determinant() < 0:
                mesh.flip_normals()
            source_slots = list(mesh.materials)
            if not source_slots or any(material is None for material in source_slots):
                raise ValueError('Source mesh has no explicit material: ' + obj.name)
            start = len(bm.faces)
            bm.from_mesh(mesh)
            bm.faces.ensure_lookup_table()
            local = {}
            for slot, material in enumerate(source_slots):
                source_index = source_material_index(material, document)
                role = 'shoes' if matches(recipe.get('shoeObjects', []), obj.name) else role_for(recipe, obj, material)
                target_index = len(materials)
                clone = material.copy()
                # Part identity survives reduction independently from its runtime tint role.
                clone.name = f'OriginalTop_P{target_index}S{source_index}'
                materials.append(clone)
                local[slot] = (target_index, role, source_index)
                bindings[clone.name] = source_index
                colours[target_index] = [0.0, M.material_colour(material)]
            removed = []
            owner = next(({'arm': 1, 'torso': 2, 'leg': 3, 'skirt': 4}[kind]
                          for pattern, kind in recipe.get('anatomyRules', [])
                          if re.search(pattern, obj.name, re.I)), 0)
            for face in bm.faces[start:]:
                source_slot = min(face.material_index, len(source_slots) - 1)
                index, role, _source_index = local[source_slot]
                original_name = re.sub(r'^ExtaliaSourceMaterial_\d+_', '', source_slots[source_slot].name)
                if matches(recipe.get('dropMaterials', []), original_name):
                    removed.append(face)
                    continue
                face.material_index = index
                face[part] = index
                face[zone] = -1 if role == 'auto' else M.Z[role]
                face[anatomy] = owner
                colours[index][0] += face.calc_area()
            if removed:
                bmesh.ops.delete(bm, geom=removed, context='FACES')
            records.append({'object': obj.name, 'triangles': sum(len(poly.vertices) - 2 for poly in mesh.polygons),
                            'uvLayers': [layer.name for layer in mesh.uv_layers],
                            'colorAttributes': [layer.name for layer in mesh.color_attributes]})
        finally:
            evaluated.to_mesh_clear()
    bmesh.ops.delete(bm, geom=[vertex for vertex in bm.verts if not vertex.link_faces], context='VERTS')
    bm.verts.index_update()
    if not bm.faces:
        raise ValueError('The recipe selected no source garment faces')
    return bm, materials, bindings, colours, np.concatenate(avatars) if avatars else None, records


def mesh_from_bmesh(bm, name, materials, collection):
    obj = M.bm_to_object(bm, name, collection)
    for material in materials:
        obj.data.materials.append(material)
    return obj


def recipe_entry(recipe, group):
    entry = {'group': group, 'keep_girth': True, 'fit_reach': recipe.get('fitReach', .5)}
    for source, target in [('targetSpan', 'span'), ('rotate', 'rotate'), ('skirt', 'skirt'), ('armsDown', 'arms_down'),
                           ('offsetY', 'offset_y'), ('offsetZ', 'offset_z')]:
        if source in recipe:
            entry[target] = recipe[source]
    if recipe.get('sleeveless'):
        entry['arms_down'] = True
    return entry


def centre_depth(bm, ref, recipe):
    """Align section envelopes, not vertex-count-biased CAD tessellation averages.

    A densely tessellated front panel must not move an entire suit eighteen cm
    behind its wearer. One common translation keeps all original layers nested.
    """
    points = M.bm_points(bm)
    arm = ref.weights[:, M.ARM_BONES].sum(1)
    body = ref.verts[arm < .2]
    lower = recipe.get('mode') == 'bottom' or (recipe.get('mode', 'outfit') == 'outfit' and not recipe.get('skirt'))
    levels = (.35, .55, .75) if lower else (1.15, 1.30, 1.45)
    offsets = []
    for height in levels:
        garment = points[(np.abs(points[:, 2] - height) < .035) & (np.abs(points[:, 0]) < .19)]
        reference = body[(np.abs(body[:, 2] - height) < .035) & (np.abs(body[:, 0]) < .19)]
        if len(garment) < 8 or len(reference) < 8:
            continue
        source_center = (garment[:, 1].min() + garment[:, 1].max()) / 2
        body_center = (reference[:, 1].min() + reference[:, 1].max()) / 2
        offsets.append(float(body_center - source_center))
    if offsets:
        shift = float(np.median(offsets))
        points[:, 1] += shift
        print('SOURCE_DEPTH_FRAME', shift, 'metres', flush=True)
    points[:, 1] += recipe.get('offsetY', 0)
    M.set_bm_points(bm, points)


def bind(obj, ref, weights, preserve_weights=False):
    obj.vertex_groups.clear()
    if preserve_weights:
        if np.any(weights < 0) or np.any((weights > 0).sum(axis=1) > 4):
            raise ValueError('Preserved source weights must already use at most four positive influences')
    else:
        weights = M.limit_influences(weights)
    if not np.all(np.isfinite(weights)) or not np.allclose(weights.sum(1), 1, atol=1e-6):
        raise ValueError('Original garment binding is not finite and normalized')
    for bone, name in enumerate(M.BONES):
        group = obj.vertex_groups.new(name=name)
        for vertex in np.nonzero(weights[:, bone] > 0)[0]:
            group.add([int(vertex)], float(weights[vertex, bone]), 'REPLACE')
    for modifier in list(obj.modifiers):
        obj.modifiers.remove(modifier)
    obj.parent = ref.rig
    obj.matrix_parent_inverse = Matrix.Identity(4)
    obj.matrix_basis = Matrix.Identity(4)
    obj.modifiers.new('Source garment skeleton', 'ARMATURE').object = ref.rig


def anatomical_weights(points, bm, posed_body, ref, recipe):
    """Never let nearby hanging hands bind trousers, or nearby thighs bind a shirt cuff."""
    mode = recipe.get('mode', 'outfit')
    arm_share = ref.weights[:, M.ARM_BONES].sum(1)
    leg_share = ref.weights[:, M.LEG_BONES].sum(1)
    no_arms = ref.tris[np.max(arm_share[ref.tris], axis=1) < .35]
    no_legs = ref.tris[np.max(leg_share[ref.tris], axis=1) < .35]
    field = no_arms if mode == 'bottom' or recipe.get('sleeveless') else no_legs if mode in ('top', 'outer') else ref.tris
    if recipe.get('sleeveless') and mode in ('top', 'outer'):
        field = field[np.max(leg_share[field], axis=1) < .35]
    weights = M.transfer_weights(points, posed_body, field, ref.weights)
    anatomy_layer, zone_layer, part_layer = (bm.faces.layers.int.get(name) for name in ('anatomy', 'zone', 'part'))
    owned = {kind: set() for kind in (1, 2, 3, 4)}
    parts = {}
    for face in bm.faces:
        vertices = {vertex.index for vertex in face.verts}
        if face[anatomy_layer]:
            owned[face[anatomy_layer]].update(vertices)
        elif face[zone_layer] == M.Z['bottom']:
            owned[3].update(vertices)
        parts.setdefault(face[part_layer], set()).update(vertices)
    # A detached, tube-shaped long sleeve is distinct from a flat side/bodice panel.
    # Explicit source ownership wins; this bounded fallback never uses height alone.
    explicit = set().union(*owned.values())
    for indices in parts.values():
        indices = sorted(indices)
        if len(indices) < 12 or any(index in explicit for index in indices):
            continue
        sample = points[indices]
        extent, center = np.ptp(sample, axis=0), sample.mean(0)
        eigenvalues = np.linalg.eigvalsh(np.cov(sample.T))
        tube = eigenvalues[0] / max(eigenvalues[1], 1e-12) > .12
        if mode != 'bottom' and tube and abs(center[0]) > .15 and .2 < extent[2] < .8 and extent[0] < .23 and sample[:, 2].min() > .7:
            owned[1].update(indices)
    owned[3].difference_update(owned[1])
    for kind, indices in owned.items():
        if not indices:
            continue
        indices = np.array(sorted(indices), dtype=np.int64)
        field = ref.tris[np.max(arm_share[ref.tris], axis=1) > .35] if kind == 1 else no_arms
        if kind == 2:
            field = field[np.max(leg_share[field], axis=1) < .35]
        weights[indices] = M.transfer_weights(points[indices], posed_body, field, ref.weights)
        forbidden = [M.B['hips'], *M.LEG_BONES] if kind == 1 else M.ARM_BONES
        weights[np.ix_(indices, forbidden)] = 0
    if mode == 'bottom' or recipe.get('sleeveless'):
        weights[:, M.ARM_BONES] = 0
    if mode in ('top', 'outer'):
        weights[:, M.LEG_BONES] = 0
    total = weights.sum(1, keepdims=True)
    if np.any(total < 1e-8):
        raise ValueError('Anatomical binding constraint removed all influences; recipe needs explicit ownership')
    weights /= total
    weights = M.limit_influences(weights)
    return weights, owned


def arm_clearance(obj, ref, weights, margin=.004):
    """Keep the original sleeve surface outside the wearer's arm, without cutting skin.

    A shared body-distance field moves coincident UV-seam vertices identically.
    Corrections are bounded; distant or misregistered garments still fail review.
    """
    points, _faces = M.mesh_arrays(obj)
    arms = ref.weights[:, M.ARM_BONES].sum(1)
    hands = ref.weights[:, [M.B['leftHand'], M.B['rightHand']]].sum(1)
    faces = ref.tris[(np.max(arms[ref.tris], axis=1) > .35) & (np.mean(hands[ref.tris], axis=1) < .5)]
    tree = BVHTree.FromPolygons([Vector(point) for point in ref.verts], faces.tolist(), all_triangles=True)
    owned = (weights[:, M.ARM_BONES].sum(1) > .35) & (weights[:, [M.B['leftHand'], M.B['rightHand']]].sum(1) < .7)
    moved, maximum = 0, 0.0
    for index in np.nonzero(owned)[0]:
        location, normal, _face, distance = tree.find_nearest(Vector(points[index]), .04)
        if location is None:
            continue
        depth = (Vector(points[index]) - location).dot(normal)
        if depth < margin:
            shift = min(.025, margin - depth)
            points[index] += np.array(normal) * shift
            moved += 1; maximum = max(maximum, shift)
    obj.data.vertices.foreach_set('co', points.reshape(-1)); obj.data.update()
    print('SOURCE_ARM_CLEARANCE', moved, maximum, flush=True)


def add_context(obj, ref, recipe, collection, vertices, triangles):
    mode = recipe.get('mode', 'outfit')
    skin_minimum = .14 if ref.group == 'female' else -.1
    shoe_skin_minimum = .18
    if 'sourceShoeSkinMinimumHeight' in recipe:
        value = recipe['sourceShoeSkinMinimumHeight']
        if (not recipe.get('hasShoes') or isinstance(value, bool) or
                not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= .18):
            raise ValueError('Source shoe skin overlap requires owned footwear and a height within [0, .18]')
        skin_minimum = shoe_skin_minimum = float(value)
    borrowed = recipe.get('borrow', [])
    contexts, occluders = [], [(vertices, triangles, M.vertex_weights(obj))]
    inner_shorts = INNER_SHORTS.build_inner_shorts(ref, recipe, collection, M)
    if inner_shorts:
        context, points, faces, weights = inner_shorts
        contexts.append(context); occluders.append((points, faces, weights))
    for points, faces, zones, weights, target in M.borrowed_parts(ref, {'borrow': borrowed}):
        # Native footwear remains the renderer's corrected canonical shoes.
        keep = zones != M.Z['shoes']
        if keep.any():
            data = M.mesh_part(points, faces[keep], zones[keep], weights, 'Native context', collection, max(target, 2000))
            contexts.append(M.build_outfit({'id': 'source-context'}, [data], ref, collection))
            occluders.append((points, faces[keep], weights))
    points = np.concatenate([part[0] for part in occluders])
    faces = np.concatenate([part[1] + sum(len(previous[0]) for previous in occluders[:index]) for index, part in enumerate(occluders)])
    occluder_weights = np.concatenate([part[2] for part in occluders])
    ref.shipped_centres = M.mesh_arrays(ref.objects['Body'])[0][M.mesh_arrays(ref.objects['Body'])[1]].mean(1)
    if (HERE / 'original-skin-coverage.py').is_file():
        coverage = module('source_skin_coverage', 'original-skin-coverage.py')
        keep = coverage.visible_skin_faces(ref, points, faces, mode='top' if mode == 'outer' else mode,
            minimum_height=skin_minimum, bare_arms=bool(recipe.get('sleeveless')),
            cloth_weights=occluder_weights,
            skirt_backing=bool(recipe.get('skirt') or recipe.get('continuousLowerBody')) and mode in ('outfit', 'bottom'))
    else:
        keep = M.visible_skin(ref, points, faces, {'hem_band': .10, 'skin_above': .14, 'loose': .02})
    centres = ref.verts[ref.tris].mean(1)
    regions = M.body_regions(ref.weights)[ref.tris[:, 0]]
    if mode == 'outer':
        neck = (regions == 0) & (centres[:, 2] > 1.50) & (np.abs(centres[:, 0]) < .075)
        keep &= neck | (np.isin(regions, [1, 2]) & bool(recipe.get('coverage')))
    elif mode == 'top':
        keep &= (regions == 0) | np.isin(regions, [1, 2])
    elif mode == 'bottom':
        keep &= (np.isin(regions, [3, 4]) | ((regions == 0) & (centres[:, 2] < ref.joint['hips'][2] + .10))) & (centres[:, 2] > skin_minimum)
    else:
        keep &= centres[:, 2] > skin_minimum
        if recipe.get('closedTorso'):
            keep &= (regions != 0) | ((centres[:, 2] > 1.45) & (np.abs(centres[:, 0]) < .08))
    if recipe.get('hasShoes'):
        keep &= ~np.isin(regions, [3, 4]) | (centres[:, 2] > shoe_skin_minimum)
    if keep.any():
        skin_faces = ref.tris[keep]
        used = np.unique(skin_faces)
        remap = np.full(len(ref.verts), -1, np.int64)
        remap[used] = np.arange(len(used))
        skin_budget = recipe.get('skinTriangleBudget', len(skin_faces))
        if type(skin_budget) is not int or skin_budget <= 0:
            raise ValueError('Skin context requires a positive triangle budget')
        data = M.mesh_part(ref.verts[used], remap[skin_faces], np.full(len(skin_faces), M.Z['skin']),
                           ref.weights[used], 'Exposed source-clothing skin', collection, skin_budget, protect_boundary=True)
        skin = M.build_outfit({'id': 'source-skin'}, [data], ref, collection)
        if skin_budget >= len(skin_faces):
            print('SOURCE_REFERENCE_SKIN_WEIGHTS', SKIN_WEIGHTS.restore_reference_skin_weights(skin, ref, M), flush=True)
        ankle_backing = ANKLES.fit_native_ankle_backing(skin, obj, ref, M,
            owns_source_shoes=bool(recipe.get('hasShoes')))
        print('SOURCE_NATIVE_ANKLE_BACKING', ankle_backing, flush=True)
        # Whole/bottom looks with bare lower legs join the actual retained native ankle ring.
        if ref.group == 'female' and mode in ('outfit', 'bottom') and not recipe.get('hasShoes') and np.any(centres[keep, 2] < .22):
            plan = S.ankle_skin_seam_plan(skin, ref)
            if plan['status'] == 'ready':
                S.fit_ankle_skin_seams(skin, ref)
            elif recipe.get('partialAnklePolicy') == 'retain-covered-patches':
                # Some trousers leave only small ankle windows, not complete calf rings.
                # Keep their actual coverage geometry; do not manufacture a bare calf.
                print('SOURCE_PARTIAL_ANKLE', recipe['id'], plan, flush=True)
            else:
                raise ValueError('Partial ankle coverage requires an explicit recipe policy')
        contexts.append(skin)
    if contexts:
        with bpy.context.temp_override(active_object=obj, object=obj, selected_objects=[obj, *contexts],
                                       selected_editable_objects=[obj, *contexts]):
            bpy.ops.object.join()


def build(recipe, group, source_dir, collection, walk_pose_packet=None):
    ref = M.Reference(group, collection)
    path = source_dir / recipe['source']
    document = source_document(path)
    imported = import_indexed_source(path, document, collection)
    lod_stats = LOD.prepare_source_lod(imported, recipe, M)
    bm, materials, bindings, colours, avatar, records = combine_original(imported, recipe, document)
    for original in imported:
        bpy.data.objects.remove(original, do_unlink=True)
    entry = recipe_entry(recipe, group)
    M.normalise(bm, avatar, {**entry, 'offset_y': 0}, ref)
    centre_depth(bm, ref, recipe)
    # Registration is a common, low-frequency frame; it never projects individual wrinkles.
    if recipe.get('register', True):
        M.register(bm, entry, ref, ref.core_bvh, np.abs(M.bm_points(bm)[:, 0]) < .16)
    M.assign_zones(bm, ref, colours)
    before = sum(len(face.verts) - 2 for face in bm.faces)
    zones = bm.faces.layers.int.get('zone')
    part = bm.faces.layers.int.get('part')
    roles = {}
    for face in bm.faces:
        roles.setdefault(face[part], face[zones])
    renamed = {}
    for index, material in enumerate(materials):
        role = M.ZONES[roles.get(index, M.Z['top'])]
        role = 'accent' if role in ('trim', 'lining') else role
        previous = material.name
        material.name = re.sub(r'^OriginalTop_', 'Original' + role.capitalize() + '_', previous)
        renamed[material.name] = bindings[previous]
    pose_points = M.bm_points(bm)
    if 'sourceArmMaterialIndices' in recipe:
        indices = recipe['sourceArmMaterialIndices']
        if (not isinstance(indices, list) or not indices or len(set(indices)) != len(indices)
                or any(type(index) is not int or not 0 <= index < len(document.get('materials', [])) for index in indices)):
            raise ValueError('Source arm calibration requires explicit original material indices')
        selected_vertices = {vertex.index for face in bm.faces
            if renamed[materials[face.material_index].name] in indices
            for vertex in face.verts}
        if len(selected_vertices) < 40:
            raise ValueError('Source arm calibration has insufficient original sleeve geometry')
        pose_points = pose_points[sorted(selected_vertices)]
    rotations = M.limb_rotations(pose_points, ref, entry)
    transforms = ref.pose(rotations)
    posed = M.skin_points(ref.verts, ref.weights, transforms)
    # Keep a full-detail master by default. A reviewed recipe may request a separate LOD.
    obj = mesh_from_bmesh(bm, 'Original source garment', materials, collection)
    bm.free()
    target = recipe.get('maxTriangles')
    if target and before > target:
        bm = bmesh.new(); bm.from_mesh(obj.data)
        M.weld(bm)  # positional seams within one original part, never unrelated layers
        bm.to_mesh(obj.data); bm.free()
        bm = bmesh.new(); bm.from_mesh(obj.data); bm.verts.index_update()
        boundary = [vertex.index for vertex in bm.verts if vertex.is_boundary]
        bm.free()
        if boundary:
            obj.vertex_groups.new(name='Original panel borders').add(boundary, 1, 'REPLACE')
        M.decimate(obj, target, 'Original panel borders' if boundary else None)
    bm = bmesh.new(); bm.from_mesh(obj.data); bm.verts.index_update()
    source_points = M.bm_points(bm)
    weights, owners = anatomical_weights(source_points, bm, posed, ref, recipe)
    weights = BINDING.refine_source_weights(source_points, bm, weights, posed, ref, recipe,
        [renamed[material.name] for material in materials])
    weights, seam_binding = BINDING.refine_armhole_seam_weights(obj, weights, ref, recipe, M,
        source_points=source_points)
    # Smoothing may blend only within the same anatomical region; direct nearest-field
    # weights already interpolate the source skeleton and keep detached trim independent.
    rest = M.unskin_points(source_points, weights, transforms)
    skirt_mask = np.zeros(len(rest), dtype=bool)
    if recipe.get('skirt'):
        # Only skirt-owned vertices use the shared leg blend. A low hanging cuff is
        # still an arm, even below the skirt waist.
        zone_layer = bm.faces.layers.int.get('zone')
        skirt_vertices, non_skirt_vertices = set(owners[4]), set(owners[1])
        for face in bm.faces:
            if face[zone_layer] == M.Z['bottom']:
                skirt_vertices.update(vertex.index for vertex in face.verts)
        # Single-material dresses still have a skirt below the authored waist, while
        # sleeves which hang alongside it remain excluded by their arm ownership.
        arm_weight = weights[:, M.ARM_BONES].sum(1)
        skirt_vertices.update(np.nonzero((rest[:, 2] < recipe['skirt'][0]) & (arm_weight < .2))[0].tolist())
        selected_skirt = np.array(sorted(skirt_vertices - non_skirt_vertices), dtype=np.int64)
        if len(selected_skirt):
            skirt_mask[selected_skirt] = True
            weights[selected_skirt] = M.limit_influences(SKIRT.articulated_skirt_weights(
                rest[selected_skirt], weights[selected_skirt], ref, M.B, waist=recipe['skirt'][0],
                thigh_depth=recipe.get('skirtThighDepth', .18)))
            rest = M.unskin_points(source_points, weights, transforms)
    M.set_bm_points(bm, rest)
    bm.to_mesh(obj.data); bm.free()
    renamed, trouser_roles = ROLES.classify_trouser_components(obj, ref, renamed, recipe, M, weights)
    leg_fit = LEGS.fit_leg_envelope(obj, ref, weights, recipe, M,
        [renamed[material.name] for material in obj.data.materials])
    if recipe.get('mode') != 'bottom' and recipe.get('torsoCage', True):
        # One smooth field for every source layer clears the actual wearer bust/chest.
        # This is essential for sheer fabrics: hiding the underlying body would lose
        # their intended transparency, while independent layer pushes invert nesting.
        TORSO.front_envelope([obj], ref)
    radial_fit = RADIAL.fit_torso_envelope(obj, ref, weights, recipe, M)
    posterior_fit = PELVIS.fit_posterior_pelvis(obj, ref, weights, recipe, M)
    weights, sleeve_fit = ARMS.fit_sleeve_landmarks(obj, ref, weights, recipe, M)
    weights, sleeve_envelope = ARMS.fit_sleeve_envelope(obj, ref, weights, recipe, M)
    accessory_fit = ACCESSORIES.fit_accessory_groups(obj, ref, recipe, M, renamed)
    if recipe.get('mode') != 'bottom' and recipe.get('armClearance', False):
        for _iteration in range(recipe.get('armClearanceIterations', 1)):
            arm_clearance(obj, ref, weights, recipe.get('armClearanceMargin', .004))
    if obj.data.has_custom_normals:
        obj.data.normals_split_custom_set([(0, 0, 0)] * len(obj.data.loops))
    weights, hip_binding = HIPS.fit_hip_weights(obj, ref, weights, recipe, M)
    if recipe.get('hipBinding'):
        bind(obj, ref, weights, preserve_weights=True)
    else:
        bind(obj, ref, weights)
    seated_drape = None
    if recipe.get('seatedDrape'):
        if not recipe.get('skirt') or not skirt_mask.any():
            raise ValueError('A seated drape requires explicitly owned skirt vertices')
        options = dict(recipe.get('seatedDrapeOptions', {}))
        if options.pop('mode', 'analytic') == 'layered_source':
            seated_drape = LAYERED.add_layered_seated_drape(obj, ref, weights, skirt_mask, M,
                source_id=recipe['id'], seated_matrices=SEATED.seated_matrices,
                waist=recipe['skirt'][0], **options)
        else:
            seated_drape = SEATED.add_seated_drape(obj, ref, weights, skirt_mask, M, waist=recipe['skirt'][0],
                **recipe.get('seatedDrapeOptions', {}))
    walk_drape = None
    if recipe.get('walkDrape'):
        if not recipe.get('skirt') or not skirt_mask.any() or walk_pose_packet is None:
            raise ValueError('Walking drape needs an explicit skirt and --walk-poses packet')
        options = recipe['walkDrape']
        if options is True:
            options = {}
        if not isinstance(options, dict) or set(options) - {'low', 'high', 'maximum', 'margin', 'outer_iterations', 'initial_radial_ease'}:
            raise ValueError('Walking drape options must be a bounded explicit configuration')
        # The field fades above the waist. Restricting it to skirt_mask would
        # introduce a hard displacement boundary through the same source panel.
        walk_source = np.zeros(len(obj.data.vertices), dtype=bool)
        for face in obj.data.polygons:
            material = obj.data.materials[face.material_index]
            if material and material.name in renamed and material.name.startswith(
                    ('OriginalTop_', 'OriginalBottom_', 'OriginalOuter_', 'OriginalAccent_')):
                walk_source[list(face.vertices)] = True
        walk_drape = WALK.add_walk_drape(obj, ref, M.vertex_weights(obj), walk_source, M,
            source_id=recipe['id'], pose_matrices=walk_matrices(walk_pose_packet, ref), **options)
        walk_drape['posePacketSHA256'] = hashlib.sha256(json.dumps(walk_pose_packet, sort_keys=True).encode()).hexdigest()
    for bone in ref.rig.pose.bones:
        bone.matrix_basis = Matrix.Identity(4)
    bpy.context.view_layer.update()
    source_triangle_count = sum(len(face.vertices) - 2 for face in obj.data.polygons)
    underlap = None
    if recipe.get('armholeUnderlap') is not None:
        source_index = recipe['armholeUnderlap']['sourceMaterial']
        names = {name for name, index in renamed.items() if index == source_index}
        underlap = UNDERLAP.add_armhole_gussets(obj, ref, M,
            clearance=recipe['armholeUnderlap'].get('clearance', .003), material_names=names,
            material_name=f'OriginalTop_AdditiveUnderlap_S{source_index}',
            lateral_max=recipe['armholeUnderlap'].get('lateralMax', .185),
            rear_inset=recipe['armholeUnderlap'].get('rearInset', True),
            overlap_faces=recipe['armholeUnderlap'].get('overlapFaces', False),
            shoulder_above=recipe['armholeUnderlap'].get('shoulderAbove', .005),
            front_minimum=recipe['armholeUnderlap'].get('frontMinimum', -.055),
            shoulder_below=recipe['armholeUnderlap'].get('shoulderBelow', .235))
        renamed[underlap['material']] = source_index
    vertices, triangles = M.mesh_arrays(obj)
    # A material may span both denim trousers and sneakers. Give only its actual
    # shoe faces a footwear role while retaining the same original material graph.
    if recipe.get('shoesBelow') is not None:
        shoe_slots = {}
        for face in obj.data.polygons:
            if max(vertices[index, 2] for index in face.vertices) >= recipe['shoesBelow']:
                continue
            index = face.material_index
            material = obj.data.materials[index]
            if material.name.startswith('OriginalShoes_'):
                continue
            if index not in shoe_slots:
                clone = material.copy()
                clone.name = material.name.replace('OriginalBottom_', 'OriginalShoes_').replace('OriginalTop_', 'OriginalShoes_')
                renamed[clone.name] = renamed[material.name]
                shoe_slots[index] = len(obj.data.materials)
                obj.data.materials.append(clone)
            face.material_index = shoe_slots[index]
    # A late angular leg pass cannot change the inputs of shared torso/arm cages.
    # Shoe roles are resolved first so source footwear stays outside this field.
    late_leg_fit = None
    late_leg_config = recipe.get('legCageRadialOffset', False)
    if late_leg_config is not None and late_leg_config is not False:
        late_leg_fit = LEGS.fit_leg_radial_offset(obj, ref, M.vertex_weights(obj), recipe, M,
            [renamed[material.name] for material in obj.data.materials])
        vertices, triangles = M.mesh_arrays(obj)
    shoulder_correctives = SHOULDERS.add_shoulder_correctives(obj, ref, M, recipe.get('shoulderCorrective'))
    # Sheer or cut-out faces cannot occlude the underlying body as solid geometry.
    # Confirmed solid-fabric render corrections remain explicit recipe decisions.
    opaque = []
    obj.data.calc_loop_triangles()
    for face in obj.data.loop_triangles:
        material = obj.data.materials[obj.data.polygons[face.polygon_index].material_index]
        source_index = renamed[material.name]
        source_material = document['materials'][source_index]
        if source_index in recipe.get('opaqueMaterials', []) or source_material.get('alphaMode', 'OPAQUE') == 'OPAQUE':
            opaque.append(face.vertices[:])
    owns_shoes = bool(recipe.get('hasShoes')) or any(
        obj.data.materials[index].name.startswith('OriginalShoes_')
        for index in {face.material_index for face in obj.data.polygons})
    add_context(obj, ref, {**recipe, 'hasShoes': owns_shoes}, collection, vertices,
        np.array(opaque, dtype=np.int64).reshape(-1, 3))
    obj.name = obj.data.name = 'Piece' if recipe.get('mode', 'outfit') != 'outfit' else 'Outfit'
    if recipe.get('mode', 'outfit') in ('outfit', 'top', 'outer'):
        obj['extaliaOwnNeckline'] = True
    if recipe.get('mode') == 'outer' and recipe.get('coverage'):
        obj['extaliaWardrobeCoverage'] = recipe['coverage']
    if recipe.get('mode', 'outfit') == 'outfit':
        obj['extaliaNativeFootwear'] = not owns_shoes
        if recipe.get('hasGloves'):
            obj['extaliaOwnHands'] = True
        if recipe.get('hasEyewear'):
            obj['extaliaOwnEyewear'] = True
    return ref, obj, path, renamed, {'sourceObjects': records, 'sourceTriangles': lod_stats['sourceTriangles'],
        'sourceLod': lod_stats,
        'radialTorsoFit': radial_fit, 'sleeveFit': sleeve_fit,
        'sleeveEnvelope': sleeve_envelope,
        'shoulderCorrectives': shoulder_correctives,
        'posteriorPelvisFit': posterior_fit,
        'accessoryFit': accessory_fit,
        'hipBinding': hip_binding,
        'seamBinding': seam_binding,
        'legFit': leg_fit,
        'lateLegFit': late_leg_fit,
        'trouserRoles': trouser_roles,
        'sourceFootwear': owns_shoes,
        'seatedDrape': seated_drape,
        'walkDrape': walk_drape,
        'additiveArmholeUnderlap': underlap,
        'additiveMaterials': [underlap['material']] if underlap else [],
        'fittedSourceTriangles': source_triangle_count, 'poseArmBones': sorted(rotations),
        'triangles': sum(len(face.vertices) - 2 for face in obj.data.polygons)}


def export(ref, obj, recipe, source, bindings, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action='DESELECT')
    ref.rig.select_set(True); obj.select_set(True)
    bpy.context.view_layer.objects.active = ref.rig
    bpy.ops.export_scene.gltf(filepath=str(target), export_format='GLB', use_selection=True,
        export_texcoords=True, export_normals=True, export_materials='EXPORT', export_tangents=True,
        export_image_format='NONE', export_all_vertex_colors=True,
        export_extras=True, export_animations=False, export_skins=True,
        export_morph=bool(obj.data.shape_keys and len(obj.data.shape_keys.key_blocks) > 1),
        export_def_bones=False, export_rest_position_armature=True,
        **({'export_try_sparse_sk': True, 'export_try_omit_sparse_sk': True} if recipe.get('shoulderCorrective') else {}))
    used = {obj.data.materials[index].name for index in {face.material_index for face in obj.data.polygons}
            if obj.data.materials[index] and obj.data.materials[index].name in bindings}
    overrides = {name: {'alphaMode': 'OPAQUE'} for name, source_index in bindings.items()
                 if name in used and source_index in recipe.get('opaqueMaterials', [])}
    return G.graft_source_materials(source, target, {name: index for name, index in bindings.items() if name in used}, overrides=overrides)


def recipes(group, path=None):
    data = json.loads((path or HERE / f'source-garments-{group}.json').read_text())
    for entry in data['entries']:
        if entry.get('variants'):
            for variant in entry['variants']:
                yield {**entry, **variant, 'variants': None}
        else:
            yield entry


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-dir', required=True, type=Path)
    parser.add_argument('--group', required=True, choices=['female', 'male'])
    parser.add_argument('--only')
    parser.add_argument('--recipes', type=Path)
    parser.add_argument('--walk-poses', type=Path, help='Ignored pose JSON from generate-source-walk-poses.ts; required by walkDrape recipes')
    parser.add_argument('--lod-budget', type=int, help='Explicit source-triangle budget; omit to keep the full-detail master')
    parser.add_argument('--full-detail', action='store_true', help='Bypass all recipe LODs for source-fidelity comparison')
    parser.add_argument('--output', type=Path, default=OUTPUT)
    parser.add_argument('--save-review', type=Path)
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
    walk_pose_packet = json.loads(args.walk_poses.read_text()) if args.walk_poses else None
    bpy.ops.wm.read_factory_settings(use_empty=True)
    selected = set(args.only.split(',')) if args.only else None
    rows = list(recipes(args.group, args.recipes))
    if selected and selected - {recipe['id'] for recipe in rows}:
        raise ValueError('Unknown garment ids: ' + ', '.join(sorted(selected - {recipe['id'] for recipe in rows})))
    results = []
    for recipe in rows:
        if selected is not None and recipe['id'] not in selected or recipe.get('existingOnly'):
            continue
        if args.full_detail:
            recipe = {key: value for key, value in recipe.items() if key not in ('partLod', 'maxTriangles')}
        elif args.lod_budget:
            recipe = {**recipe, 'maxTriangles': args.lod_budget}
        collection = bpy.data.collections.new('Source ' + recipe['id'])
        bpy.context.scene.collection.children.link(collection)
        try:
            if walk_pose_packet is None:
                ref, obj, source, bindings, stats = build(recipe, args.group, args.source_dir, collection)
            else:
                ref, obj, source, bindings, stats = build(recipe, args.group, args.source_dir, collection, walk_pose_packet)
            target = args.output / args.group / (recipe['id'] + '.glb')
            receipt = export(ref, obj, recipe, source, bindings, target)
            result = {'id': recipe['id'], 'group': args.group, 'source': recipe['source'],
                      'mode': recipe.get('mode', 'outfit'), 'recipe': recipe, 'stats': stats,
                      'fidelity': receipt, 'review': 'candidate-needs-visual-fit-review'}
            target.with_suffix('.source.json').write_text(json.dumps(result, indent=2) + '\n')
            results.append(result)
            print('SOURCE_GARMENT_COMPLETE', recipe['id'], json.dumps(stats), flush=True)
            if args.save_review:
                bpy.ops.wm.save_as_mainfile(filepath=str(args.save_review), copy=True, compress=True)
        except Exception as error:
            print('SOURCE_GARMENT_ERROR', recipe['id'], repr(error), flush=True)
            results.append({'id': recipe['id'], 'error': str(error)})
            if selected:
                raise
        finally:
            M.remove_collection(collection)
    args.output.mkdir(parents=True, exist_ok=True)
    manifest = args.output / (args.group + '.manifest.json')
    previous = {item['id']: item for item in json.loads(manifest.read_text())} if selected and manifest.exists() else {}
    previous.update({item['id']: item for item in results})
    manifest.write_text(json.dumps([previous[key] for key in sorted(previous)], indent=2) + '\n')
    if any('error' in item for item in results):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
