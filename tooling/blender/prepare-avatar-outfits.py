"""Fit downloaded garments onto the Extalia avatar bodies as wearable, tintable outfit GLBs.

Run headless (one or more catalog ids; several runs may go in parallel):
    Blender --background --factory-startup --python tooling/blender/prepare-avatar-outfits.py -- \
        --source-dir <folder with the clothing downloads> [--only outfit-dress,outfit-sport] \
        [--work-dir <empty dir>] [--review <dir for review renders>]

One-time reference set-up (local only; the reference holds the full skinned base body that the
public body GLBs were cut from, so garments can be fitted and skinned to the same rig):
    Blender --background --factory-startup --python tooling/blender/prepare-avatar-outfits.py -- \
        --build-reference <merged avatar review .blend>

Outfits are listed in ``avatar-outfits.json`` (one entry per outfit: id, gender group, archive
and model file inside it, licence and credit, zone rules, fit hints). Archives are untrusted:
only the named model file is extracted (``bsdtar``, nested archives one level deep) into a fresh
scratch folder, nothing from them is executed, and only meshes are imported. Source textures,
avatars, hair and accessories never leave the scratch folder.

Pipeline per outfit (Blender Z-up metres; the avatars face -Y):
  1. Import; drop the source avatar (kept aside as a fitting hint), hair, eyes, teeth and the
     ``drop`` rules (stitching, logos, labels, props). Heavy sources are collapse-decimated per
     part first (``predecimate``). Every face gets a tint zone from the ``zones`` rules (object
     or material name, first match wins; default ``top``): top, outer, accent, trim, bottom,
     shoes, lining. The area-weighted source colour of each zone becomes its default palette.
  2. Normalise: ``rotate`` and unit scale, then register to the reference body: start from the
     source avatar (or the ``span`` hint) and grid-search scale, height, depth and girth so the
     cloth hugs the torso and legs without entering them.
  3. Pose the reference body into the source's own arm and leg spread (measured from the sleeves
     and trouser legs), then skin the garment from that posed body (nearest face, interpolated):
     with the arms away from the torso, side seams never pick up arm weights, so the cloth does
     not web between arm and torso. Skirts and dress hems blend hips and both thighs instead of
     splitting between the legs. Weights are smoothed along the cloth.
  4. Weld coincident seams within each source part, preserve thin shells and folded panels,
     remove tiny islands (buttons stay as trim when large enough), decimate to budget.
  5. Return to the rig's rest pose (inverse skinning), crop long hems (``hem``), push every
     vertex out of the body by a small margin and relax the correction along the cloth.
  6. Bare skin: keep only the reference body's skin the garment leaves visible (plus a band
     under loose hems for walking and sitting); head, neck and hands come from the body GLB.
     Shoes or trousers missing from the source come from the body's own scan outfit
     (``borrow``).
  7. Export ``avatars/outfits/<group>/<id>.glb``: the 20-joint ``AvatarLiteRig`` and one skinned
     ``Outfit`` mesh with role materials ``Office<Zone>_<Id>`` and ``Skin_<Id>`` (plain white,
     tinted at runtime), smooth normals, no UVs or textures.
"""
import argparse
import colorsys
import fcntl
import json
import math
import os
import random
import re
import shutil
import struct
import subprocess
import sys
import tempfile

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..'))
CATALOG = os.path.join(HERE, 'avatar-outfits.json')
LOCAL = os.path.join(ROOT, 'apps', 'web', 'local-assets', 'avatars')
REFERENCE = os.path.join(LOCAL, 'reference')
OUTPUT = os.path.join(LOCAL, 'outfits')

ZONES = ['top', 'outer', 'accent', 'trim', 'bottom', 'shoes', 'lining', 'skin', 'drop']
Z = {name: index for index, name in enumerate(ZONES)}
ZONE_PREFIX = {'top': 'OfficeTop', 'outer': 'OfficeOuter', 'accent': 'OfficeAccent', 'trim': 'OfficeTrim',
               'bottom': 'OfficeBottom', 'shoes': 'OfficeShoes', 'lining': 'OfficeLining', 'skin': 'Skin'}
BONES = ['root', 'hips', 'spine', 'chest', 'neck', 'head', 'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
         'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot',
         'rightUpperLeg', 'rightLowerLeg', 'rightFoot']
B = {name: index for index, name in enumerate(BONES)}
ARM_BONES = [B[n] for n in BONES if 'Arm' in n or 'Hand' in n]
LEG_BONES = [B[n] for n in BONES if 'Leg' in n or 'Foot' in n]
# Source objects that are never garments: the draping avatar, its hair and face parts.
AVATAR = r'avatar|^body|^obj_?avatar|mannequin|^(?:cc_)?base_body|genesis'
NOT_GARMENT = r'\beye|eyelash|eyebrow|tooth|teeth|tongue|hair|scalp|^head\b|nail'
# Generic seams, topstitching, labels and logos: dropped unless an entry keeps them.
DROP = r'stitch|topstitch|seam_?line|label|logo|brand|tag\b|print|graphic|decal|text'
# Budgets (triangles) per outfit: cloth, plus visible skin and borrowed shoes or trousers.
CLOTH_TRIANGLES = 6000
MAX_TRIANGLES = 10000
MAX_BYTES = 700_000
MARGIN = .0045          # cloth clearance over the skin (metres)
OUTER_MARGIN = .009     # outer layers (coats, jackets, vests) keep clear of the layer below
SMOOTH_ANGLE = 60
DEFAULT_SHOES = {
    'female': {'from': 'ScanOutfit', 'materials': [['OfficeShoes', 'shoes'], ['Skin_Outfit', 'skin']], 'below': .2, 'triangles': 700},
    'male': {'from': 'ScanOutfit', 'materials': [['OfficeShoes', 'shoes']], 'triangles': 600},
}
HEAD_FIT = {'female': (-.017, .036), 'male': (-.027, .036)}  # head pivot (y, z) offsets of the shipped bodies
REFERENCE_OBJECTS = {
    'female': {'rig': 'New female rig', 'full': 'CC_Base_Body.003', 'body': 'Body.female', 'neckline': 'BodyNeckline.female',
               'outfit': 'ClaudiaOutfit.female', 'casual': 'CasualOutfit.female', 'offset': 9.3},
    'male': {'rig': 'New male rig', 'full': 'CC_Base_Body.002', 'body': 'Body.male', 'neckline': 'BodyNeckline.male',
             'outfit': 'EricOutfit.male', 'casual': None, 'offset': 8.0},
}


def log(message):
    print('AVATAR_OUTFITS ' + message, flush=True)


# ---------------------------------------------------------------------------------------------
# Catalog and sources

def load_catalog(path=CATALOG):
    with open(path, encoding='utf-8') as file:
        catalog = json.load(file)
    if catalog.get('schemaVersion') != 1:
        raise ValueError('Unexpected avatar outfit catalog')
    entries = {}
    for entry in catalog['outfits']:
        if not re.fullmatch(r'outfit-[a-z0-9-]+', entry['id']) or entry['group'] not in ('female', 'male') \
                or entry['notice'] not in catalog['notices'] or entry['id'] in entries:
            raise ValueError('Invalid avatar outfit entry %s' % entry.get('id'))
        for rule in entry.get('zones', []):
            if rule[0] not in ('object', 'material') or rule[2] not in ZONES:
                raise ValueError('%s: invalid zone rule %r' % (entry['id'], rule))
        entries[entry['id']] = entry
    return catalog, entries


def find_archive(source_dir, name):
    for folder, _directories, files in sorted(os.walk(source_dir)):
        if name in files:
            return os.path.join(folder, name)
    return None


def safe_member(name):
    parts = name.replace('\\', '/').split('/')
    if name.startswith('/') or '..' in parts:
        raise ValueError('Unsafe archive member ' + name)
    return name


def extract(archive, member, target):
    """Extract exactly ``member`` from an untrusted archive with bsdtar (zip, rar, 7z)."""
    os.makedirs(target, exist_ok=True)
    env = dict(os.environ, LC_ALL='en_US.UTF-8')
    subprocess.run(['bsdtar', '-xf', archive, '-C', target, safe_member(member)], check=True, env=env,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    path = os.path.join(target, member)
    if not os.path.isfile(path) or os.path.islink(path):
        raise FileNotFoundError('%s not extracted from %s' % (member, os.path.basename(archive)))
    return path


def extract_source(entry, source_dir, work_dir):
    """Return the source model path in a fresh folder; ``source`` may name ``inner.zip/model.fbx``."""
    archive = find_archive(source_dir, entry['archive'])
    if archive is None:
        return None
    target = os.path.join(work_dir, entry['id'])
    if os.path.exists(target):
        shutil.rmtree(target)
    os.makedirs(target)
    if entry['archive'] == entry['source']:
        path = os.path.join(target, os.path.basename(archive))
        shutil.copyfile(archive, path)
        return path
    steps = entry['source'].split('::')
    current = archive
    for depth, member in enumerate(steps):
        current = extract(current, member, os.path.join(target, 'layer%d' % depth))
    return current


# ---------------------------------------------------------------------------------------------
# Reference bodies (local only)

def build_reference(merged, group):
    """Cut the reference (rig, full base body, shipped body parts, scan outfits) out of the review file."""
    spec = REFERENCE_OBJECTS[group]
    bpy.ops.wm.open_mainfile(filepath=merged, load_ui=False, use_scripts=False)
    rename = {spec['rig']: 'AvatarLiteRig', spec['full']: 'ReferenceBody', spec['body']: 'Body',
              spec['neckline']: 'BodyNeckline', spec['outfit']: 'ScanOutfit'}
    if spec['casual']:
        rename[spec['casual']] = 'ScanOutfitCasual'
    for obj in list(bpy.data.objects):
        if obj.name not in rename:
            bpy.data.objects.remove(obj)
    for scene in list(bpy.data.scenes)[1:]:
        bpy.data.scenes.remove(scene)
    scene = bpy.data.scenes[0]
    for old, new in rename.items():
        obj = bpy.data.objects[old]
        obj.name = new
        if obj.type == 'MESH':
            obj.data.name = new
        if obj.name not in scene.collection.all_objects:
            scene.collection.objects.link(obj)
    shift = Matrix.Translation((-spec['offset'], 0, 0))
    rig = bpy.data.objects['AvatarLiteRig']
    rig.data.transform(shift)
    for obj in bpy.data.objects:
        if obj.type == 'MESH':
            obj.data.transform(shift)
    # The shipped bodies moved the head pivot so the detailed hair sits on these eyes; match it.
    bpy.context.view_layer.objects.active = rig
    rig.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    head = rig.data.edit_bones['head']
    shift_head = Vector((0, .052 + HEAD_FIT[group][0], 1.626 + HEAD_FIT[group][1])) - head.head
    head.head += shift_head
    head.tail += shift_head
    bpy.ops.object.mode_set(mode='OBJECT')
    bpy.data.orphans_purge(do_local_ids=True, do_linked_ids=True, do_recursive=True)
    for image in list(bpy.data.images):
        bpy.data.images.remove(image)
    os.makedirs(REFERENCE, exist_ok=True)
    path = os.path.join(REFERENCE, group + '.blend')
    bpy.ops.wm.save_as_mainfile(filepath=path, compress=True)
    log('reference %s -> %s' % (group, path))


class Reference:
    """Rig and full base body in rest pose, as numpy arrays plus BVH trees."""

    def __init__(self, group, collection):
        path = os.path.join(REFERENCE, group + '.blend')
        if not os.path.exists(path):
            raise FileNotFoundError('Missing %s: run --build-reference first (see the module docstring)' % path)
        with bpy.data.libraries.load(path, link=False) as (source, target):
            target.objects = [name for name in source.objects]
        self.objects = {}
        for obj in target.objects:
            collection.objects.link(obj)
            self.objects[obj.name.split('.')[0]] = obj
        self.group = group
        self.rig = self.objects['AvatarLiteRig']
        self.full = self.objects['ReferenceBody']
        for obj in self.objects.values():
            if obj.type == 'MESH':
                for modifier in obj.modifiers:
                    if modifier.type == 'ARMATURE':
                        modifier.object = self.rig
        self.rest_bones = {bone.name: bone.matrix_local.copy() for bone in self.rig.data.bones}
        self.verts, self.tris = mesh_arrays(self.full)
        self.weights = vertex_weights(self.full)
        self.normals = vertex_normals(self.full)
        self.bvh = BVHTree.FromPolygons([Vector(v) for v in self.verts], self.tris.tolist())
        limb = self.weights[:, ARM_BONES].sum(1)
        self.core_tris = np.array([t for t in self.tris.tolist() if max(limb[t]) < .5])
        self.core_bvh = BVHTree.FromPolygons([Vector(v) for v in self.verts], self.core_tris.tolist())
        shipped = []
        for name in ('Body', 'BodyNeckline'):
            verts, tris = mesh_arrays(self.objects[name])
            shipped.append(verts[tris].mean(1))
        self.shipped_centres = np.concatenate(shipped)
        self.joint = {bone.name: np.array(bone.head_local) for bone in self.rig.data.bones}
        self.tail = {bone.name: np.array(bone.tail_local) for bone in self.rig.data.bones}

    def pose(self, rotations):
        """Rotate bones (armature-space quaternions about their heads); returns posed body arrays."""
        rig = self.rig
        for pose_bone in rig.pose.bones:
            pose_bone.matrix_basis = Matrix.Identity(4)
        bpy.context.view_layer.update()
        for name in BONES:
            if name not in rotations:
                continue
            pose_bone = rig.pose.bones[name]
            head = pose_bone.head.copy()
            pose_bone.matrix = Matrix.Translation(head) @ rotations[name].to_matrix().to_4x4() @ Matrix.Translation(-head) @ pose_bone.matrix
            bpy.context.view_layer.update()
        return self.skinning()

    def skinning(self):
        """Per-bone skinning matrices (posed armature space @ rest inverse), shape (20, 4, 4)."""
        mats = np.zeros((len(BONES), 4, 4))
        for index, name in enumerate(BONES):
            mats[index] = np.array(self.rig.pose.bones[name].matrix @ self.rest_bones[name].inverted())
        return mats


def mesh_arrays(obj, world=True):
    mesh = obj.data
    verts = np.empty(len(mesh.vertices) * 3)
    mesh.vertices.foreach_get('co', verts)
    verts = verts.reshape(-1, 3)
    if world:
        matrix = np.array(obj.matrix_world)
        verts = verts @ matrix[:3, :3].T + matrix[:3, 3]
    mesh.calc_loop_triangles()
    tris = np.empty(len(mesh.loop_triangles) * 3, dtype=np.int64)
    mesh.loop_triangles.foreach_get('vertices', tris)
    return verts, tris.reshape(-1, 3)


def vertex_normals(obj):
    normals = np.empty(len(obj.data.vertices) * 3)
    obj.data.vertices.foreach_get('normal', normals)
    return normals.reshape(-1, 3)


def vertex_weights(obj):
    groups = {group.index: B.get(group.name) for group in obj.vertex_groups}
    weights = np.zeros((len(obj.data.vertices), len(BONES)))
    for vertex in obj.data.vertices:
        for element in vertex.groups:
            bone = groups.get(element.group)
            if bone is not None:
                weights[vertex.index, bone] += element.weight
    total = weights.sum(1, keepdims=True)
    weights[total[:, 0] == 0, B['hips']] = 1
    return weights / np.maximum(weights.sum(1, keepdims=True), 1e-9)


def skin_points(points, weights, mats):
    """Linear blend skinning of points (n, 3) with weights (n, 20) and matrices (20, 4, 4)."""
    blended = np.einsum('nb,bij->nij', weights, mats)
    homogeneous = np.concatenate([points, np.ones((len(points), 1))], 1)
    return np.einsum('nij,nj->ni', blended, homogeneous)[:, :3]


def unskin_points(points, weights, mats):
    blended = np.einsum('nb,bij->nij', weights, mats)
    homogeneous = np.concatenate([points, np.ones((len(points), 1))], 1)
    return np.einsum('nij,nj->ni', np.linalg.inv(blended), homogeneous)[:, :3]


# ---------------------------------------------------------------------------------------------
# Import and classification

def import_source(path, collection):
    before = set(bpy.data.objects)
    extension = os.path.splitext(path)[1].lower()
    if extension in ('.glb', '.gltf'):
        bpy.ops.import_scene.gltf(filepath=path, import_shading='NORMALS', loglevel=50)
    elif extension == '.fbx':
        bpy.ops.import_scene.fbx(filepath=path, use_image_search=False, use_custom_props=False, use_anim=False)
    elif extension == '.obj':
        bpy.ops.wm.obj_import(filepath=path)
    else:
        raise ValueError('Unsupported source format ' + extension)
    created = [obj for obj in bpy.data.objects if obj not in before]
    for obj in created:
        for owner in list(obj.users_collection):
            owner.objects.unlink(obj)
        collection.objects.link(obj)
    return created


def zone_for(entry, obj, material):
    names = {'object': obj.name, 'material': material.name if material else ''}
    for kind, pattern, zone in entry.get('zones', []):
        if re.search(pattern, names[kind], re.I):
            return zone
    for name in names.values():
        if re.search(NOT_GARMENT, name, re.I) or (not entry.get('keep_details') and re.search(DROP, name, re.I)):
            return 'drop'
    return entry.get('default_zone', 'auto')


def material_colour(material):
    """Linear RGB of a material: its base colour factor times the mean of its base colour texture."""
    if material is None:
        return np.array([.7, .7, .7])
    colour = np.array(material.diffuse_color[:3])
    if material.use_nodes and material.node_tree:
        principled = next((n for n in material.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
        if principled:
            socket = principled.inputs['Base Color']
            colour = np.array(socket.default_value[:3])
            image = texture_of(socket)
            if image is not None:
                colour = colour * mean_texel(image)
    return colour


def texture_of(socket, depth=0):
    if not socket.links or depth > 4:
        return None
    node = socket.links[0].from_node
    if node.type == 'TEX_IMAGE':
        return node.image
    for candidate in node.inputs:
        if candidate.type == 'RGBA':
            image = texture_of(candidate, depth + 1)
            if image is not None:
                return image
    return None


def mean_texel(image):
    try:
        if image.size[0] == 0:
            return np.ones(3)
        small = image.copy()
        small.scale(32, 32)
        pixels = np.empty(32 * 32 * 4, np.float32)
        small.pixels.foreach_get(pixels)
        bpy.data.images.remove(small)
        pixels = pixels.reshape(-1, 4)
        return pixels[:, :3].mean(0)
    except (RuntimeError, ValueError):
        return np.ones(3)


def weld_source_seams(obj):
    """Weld coincident source seams before any collapse can pull their two sides apart.

    Downloads often duplicate vertices on every triangle or UV seam. Decimating that triangle
    soup first opens thousands of gaps which no later weld in fitted metres can close.
    """
    scale = max(abs(value) for value in obj.matrix_world.to_scale())
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=.0000001 / max(scale, 1e-12))
    bm.normal_update()
    bm.to_mesh(obj.data)
    bm.free()


def combine(objects, entry):
    """All garment faces in one bmesh (zone in an int layer); the avatar as a point cloud."""
    garment = bmesh.new()
    zone_layer = garment.faces.layers.int.new('zone')
    part_layer = garment.faces.layers.int.new('part')
    avatar, colours = [], {}
    meshes = [obj for obj in objects if obj.type == 'MESH']
    keep = [(kind, pattern) for kind, pattern in entry.get('avatar', [])]
    for obj in meshes:
        weld_source_seams(obj)
    total = sum(len(obj.data.polygons) for obj in meshes)
    budget = entry.get('predecimate')
    if budget and total > budget:
        for obj in meshes:
            if len(obj.data.polygons) > 1500:
                modifier = obj.modifiers.new('Stage one', 'DECIMATE')
                modifier.decimate_type = 'COLLAPSE'
                modifier.ratio = max(budget / total, .02)
        log('pre-decimated %d source faces to about %d' % (total, budget))
    depsgraph = bpy.context.evaluated_depsgraph_get()
    for obj in sorted(meshes, key=lambda o: o.name):
        is_avatar = any(re.search(pattern, obj.name if kind == 'object' else ' '.join(m.name for m in obj.data.materials if m), re.I)
                        for kind, pattern in keep) or (not keep and re.search(AVATAR, obj.name, re.I))
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        try:
            mesh.transform(obj.matrix_world)
            if is_avatar:
                points = np.empty(len(mesh.vertices) * 3)
                mesh.vertices.foreach_get('co', points)
                avatar.append(points.reshape(-1, 3))
                continue
            slots = [slot.material for slot in obj.material_slots] or [None]
            zones = [zone_for(entry, obj, material) for material in slots]
            if obj.matrix_world.determinant() < 0:
                mesh.flip_normals()
            start = len(garment.faces)
            garment.from_mesh(mesh)
            garment.faces.ensure_lookup_table()
            base = len(colours)
            for slot, material in enumerate(slots):
                colours[base + slot] = [0.0, material_colour(material)]
            for face in garment.faces[start:]:
                slot = min(face.material_index, len(slots) - 1)
                face[zone_layer] = Z[zones[slot]] if zones[slot] != 'auto' else -1
                face[part_layer] = base + slot
                colours[base + slot][0] += face.calc_area()
        finally:
            evaluated.to_mesh_clear()
    bmesh.ops.delete(garment, geom=[f for f in garment.faces if f[zone_layer] == Z['drop']], context='FACES')
    bmesh.ops.delete(garment, geom=[v for v in garment.verts if not v.link_faces], context='VERTS')
    log('source parts %d, avatar points %d' % (len({f[part_layer] for f in garment.faces}), sum(len(a) for a in avatar)))
    return garment, (np.concatenate(avatar) if avatar else None), colours


def assign_zones(bm, ref, colours):
    """Zones for parts without a rule (from their placement on the body); returns the palette.

    Shoes end near the floor, small parts are trim (buttons, zips, buckles), parts below the
    waist are bottoms; of the remaining parts the innermost layer is the top and parts that sit
    clearly further out (jackets, coats, vests over a shirt) are outer."""
    zone_layer, part_layer = bm.faces.layers.int.get('zone'), bm.faces.layers.int.get('part')
    faces = {}
    for face in bm.faces:
        faces.setdefault(face[part_layer], []).append(face)
    auto, upper = {}, {}
    for part, members in faces.items():
        if any(f[zone_layer] >= 0 for f in members):
            continue
        coords = np.array([v.co[:] for f in members for v in f.verts])
        low, high = coords.min(0), coords.max(0)
        area = float(np.nan_to_num(sum(f.calc_area() for f in members)))
        if high[2] < .24:
            auto[part] = 'shoes'
        elif np.linalg.norm(high - low) < .07:
            auto[part] = 'trim'
        elif high[2] < 1.2 and coords[:, 2].mean() < .95:
            auto[part] = 'bottom'
        else:
            sample = coords[np.random.default_rng(3).choice(len(coords), min(len(coords), 300), replace=False)]
            distances = [ref.core_bvh.find_nearest(Vector(p))[3] or .2 for p in sample]
            upper[part] = (float(np.nan_to_num(np.median(distances), nan=.2)), area)
    if upper:
        total = sum(a for _d, a in upper.values())
        inner = min((distance for distance, area in upper.values() if area >= .1 * total), default=min(d for d, _a in upper.values()))
        for part, (distance, area) in upper.items():
            auto[part] = 'outer' if distance > inner + .012 else 'top'
    for face in bm.faces:
        if face[zone_layer] < 0:
            face[zone_layer] = Z[auto[face[part_layer]]]
    totals = {}
    for part, members in faces.items():
        zone = ZONES[members[0][zone_layer]]
        weight, colour = colours[part]
        old = totals.get(zone, (0.0, np.zeros(3)))
        totals[zone] = (old[0] + weight, old[1] + weight * colour)
    palette = {zone: hex_colour(colour / max(weight, 1e-9)) for zone, (weight, colour) in totals.items()}
    counts = {}
    for face in bm.faces:
        counts[ZONES[face[zone_layer]]] = counts.get(ZONES[face[zone_layer]], 0) + 1
    log('zones %s palette %s' % (json.dumps(counts, sort_keys=True), json.dumps(palette, sort_keys=True)))
    return palette


def hex_colour(linear):
    srgb = [12.92 * c if c <= .0031308 else 1.055 * c ** (1 / 2.4) - .055 for c in np.clip(linear, 0, 1)]
    return '#%02x%02x%02x' % tuple(int(round(c * 255)) for c in srgb)


# ---------------------------------------------------------------------------------------------
# Registration

def bm_points(bm):
    return np.array([v.co[:] for v in bm.verts])


def set_bm_points(bm, points):
    for vert, point in zip(bm.verts, points):
        vert.co = point
    bm.normal_update()


def normalise(bm, avatar, entry, ref):
    """Rotate, scale and place the garment near the reference body."""
    points = bm_points(bm)
    rotation = np.array(Matrix.Identity(3))
    if entry.get('rotate'):
        from mathutils import Euler
        rotation = np.array(Euler([math.radians(a) for a in entry['rotate']], 'XYZ').to_matrix())
    points = points @ rotation.T
    if avatar is not None:
        avatar = avatar @ rotation.T
    height = ref.verts[:, 2].max()
    from_avatar = avatar is not None and len(avatar) > 500
    if from_avatar:
        low, high = avatar[:, 2].min(), np.percentile(avatar[:, 2], 99.9)
        scale = entry.get('scale') or height / (high - low)
        avatar = (avatar - [0, 0, low]) * scale
        points = (points - [0, 0, low]) * scale
        centre_x = (avatar[:, 0].min() + avatar[:, 0].max()) / 2
        band = lambda p, v: v[(v[:, 2] > .55 * height) & (v[:, 2] < .75 * height) & (np.abs(v[:, 0] - p) < .15)]
        offset = np.array([-centre_x, band(0, ref.verts)[:, 1].mean() - band(centre_x, avatar)[:, 1].mean(), 0])
        points += offset
        log('placed from the source avatar (scale %.4f)' % scale)
    elif 'span' in entry:
        low, high = entry['span']
        size = points[:, 2].max() - points[:, 2].min()
        scale = entry.get('scale') or (high - low) / size
        points = points * scale
        points += [-(points[:, 0].min() + points[:, 0].max()) / 2, 0, low - points[:, 2].min()]
        log('placed from the span hint (scale %.5f)' % scale)
    else:
        # Unit from the garment's size (m, dm, cm or mm), sized from an average 1.74 m avatar to
        # this body; the top edge starts at the collar line and registration searches the height.
        size = points[:, 2].max() - points[:, 2].min()
        unit = next(10.0 ** -k for k in range(-3, 5) if .25 <= size * 10.0 ** -k <= 2.2)
        scale = entry.get('scale') or unit * height / 1.74
        points = points * scale
        points += [-(points[:, 0].min() + points[:, 0].max()) / 2, 0, entry.get('top', 1.6) - points[:, 2].max()]
        log('placed from the source units (scale %.5f)' % scale)
    if not from_avatar:
        middle = (points[:, 2] > np.percentile(points[:, 2], 40)) & (points[:, 2] < np.percentile(points[:, 2], 60))
        z_mid = np.median(points[middle, 2])
        body = ref.verts[(np.abs(ref.verts[:, 2] - z_mid) < .03) & (np.abs(ref.verts[:, 0]) < .14)]
        points[:, 1] += body[:, 1].mean() - points[middle][np.abs(points[middle][:, 0]) < .14][:, 1].mean()
    for key, axis in (('offset_y', 1), ('offset_z', 2)):
        points[:, axis] += entry.get(key, 0)
    set_bm_points(bm, points)
    return from_avatar


def fit_cost(points, bvh, inside_weight=30.0):
    total = 0.0
    for point in points:
        hit = bvh.find_nearest(Vector(point), .25)
        if hit[0] is None:
            total += .05
            continue
        distance = (Vector(point) - hit[0]).dot(hit[1])
        total += inside_weight * min(-distance + .002, .05) if distance < .002 else min(max(distance - .012, 0), .04)
    return total / len(points)


def register(bm, entry, ref, bvh, sample_mask=None, coarse=True, wide=False):
    """Grid search uniform scale, height, depth, then girth, around the current placement."""
    points = bm_points(bm)
    rng = np.random.default_rng(7)
    candidates = np.arange(len(points)) if sample_mask is None else np.nonzero(sample_mask)[0]
    sample = points[rng.choice(candidates, min(len(candidates), 1200), replace=False)] if len(candidates) else points[:1]
    centre = np.array([0, np.median(sample[:, 1]), np.median(sample[:, 2])])
    best = (fit_cost(sample, bvh), 1.0, 0.0, 0.0, 1.0)
    reach = entry.get('fit_reach', 1.0)
    scales = np.geomspace(1 - .12 * reach, 1 + .12 * reach, 9) if coarse else np.geomspace(.97, 1.03, 5)
    heights = np.linspace(-.06 * reach, .06 * reach, 9) if coarse else np.linspace(-.015, .015, 5)
    if wide:
        heights = np.linspace(-.3, .3, 25)
    depths = np.linspace(-.04, .04, 5) if coarse else np.linspace(-.01, .01, 3)
    for scale in scales:
        for dz in heights:
            for dy in depths:
                moved = (sample - centre) * scale + centre + [0, dy, dz]
                cost = fit_cost(moved, bvh)
                if cost < best[0]:
                    best = (cost, scale, dy, dz, 1.0)
    _, scale, dy, dz, _ = best
    moved = (sample - centre) * scale + centre + [0, dy, dz]
    for girth in np.geomspace(.86, 1.16, 11) if not entry.get('keep_girth') else [1.0]:
        squeezed = moved.copy()
        squeezed[:, [0, 1]] = (moved[:, [0, 1]] - [0, centre[1] + dy]) * girth + [0, centre[1] + dy]
        cost = fit_cost(squeezed, bvh)
        if cost < best[0]:
            best = (cost, scale, dy, dz, girth)
    cost, scale, dy, dz, girth = best
    points = (points - centre) * scale + centre + [0, dy, dz]
    points[:, [0, 1]] = (points[:, [0, 1]] - [0, centre[1] + dy]) * girth + [0, centre[1] + dy]
    set_bm_points(bm, points)
    log('registered: cost %.4f scale %.3f dy %.3f dz %.3f girth %.3f' % (cost, scale, dy, dz, girth))
    return points


def limb_rotations(points, ref, entry):
    """Rotations that bring the rest arms and legs into the source garment's spread."""
    rotations = {}
    for side, sign in (('left', -1), ('right', 1)):
        shoulder = ref.joint[side + 'UpperArm']
        rest = ref.tail[side + 'LowerArm'] - shoulder
        sleeve = points[(points[:, 0] * sign > abs(shoulder[0]) + .05) & (points[:, 2] < shoulder[2] + .04) & (points[:, 2] > 1.0)]
        if len(sleeve) > 40 and not entry.get('arms_down'):
            offsets = sleeve - shoulder
            reach = np.linalg.norm(offsets, axis=1)
            far = offsets[reach >= np.percentile(reach, 85)]
            direction = far.mean(0)
            direction[1] = np.clip(direction[1], -.15 * np.linalg.norm(direction), .15 * np.linalg.norm(direction))
            angle = Vector(rest).angle(Vector(direction))
            if angle > math.radians(4):
                rotations[side + 'UpperArm'] = Vector(rest).rotation_difference(Vector(direction))
                log('%s arm spread %.0f deg' % (side, math.degrees(angle)))
        hip = ref.joint[side + 'UpperLeg']
        rest_leg = ref.tail[side + 'LowerLeg'] - hip
        legs = points[points[:, 2] < hip[2] - .25]
        if len(legs) > 40 and not entry.get('skirt'):
            gap = legs[(np.abs(legs[:, 0]) < .012) & (legs[:, 2] < hip[2] - .3)]
            leg = legs[legs[:, 0] * sign > 0]
            if len(gap) < 5 and len(leg) > 20:
                low = leg[leg[:, 2] <= np.percentile(leg[:, 2], 15)]
                direction = low.mean(0) - hip
                direction[1] = rest_leg[1] / np.linalg.norm(rest_leg) * np.linalg.norm(direction)
                angle = Vector(rest_leg).angle(Vector(direction))
                if math.radians(3) < angle < math.radians(30):
                    rotations[side + 'UpperLeg'] = Vector(rest_leg).rotation_difference(Vector(direction))
                    log('%s leg spread %.0f deg' % (side, math.degrees(angle)))
    return rotations


# ---------------------------------------------------------------------------------------------
# Geometry clean-up

def weld(bm, distance=.0000001):
    """Join coincident seam vertices, never nearby cloth layers or unrelated source parts."""
    part = bm.faces.layers.int.get('part')
    if part is None:
        bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=distance)
        return
    vertices = {}
    for face in bm.faces:
        vertices.setdefault(face[part], set()).update(face.verts)
    for members in vertices.values():
        bmesh.ops.remove_doubles(bm, verts=[v for v in members if v.is_valid], dist=distance)
    bm.normal_update()


def remove_small_islands(bm, size=.012):
    bm.verts.ensure_lookup_table()
    seen, removed = set(), 0
    for start in bm.faces:
        if start.index in seen:
            continue
        stack, island = [start], []
        seen.add(start.index)
        while stack:
            face = stack.pop()
            island.append(face)
            for edge in face.edges:
                for other in edge.link_faces:
                    if other.index not in seen:
                        seen.add(other.index)
                        stack.append(other)
        coords = np.array([v.co[:] for f in island for v in f.verts])
        if np.linalg.norm(coords.max(0) - coords.min(0)) < size:
            bmesh.ops.delete(bm, geom=island, context='FACES')
            removed += len(island)
    bm.faces.index_update()
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    return removed


def orient_outward(bm, body_bvh):
    """Keep connected cloth winding consistent; per-face nearest-body flips tear shading at folds."""
    before = [face.normal.copy() for face in bm.faces]
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    return sum(a.dot(face.normal) < 0 for a, face in zip(before, bm.faces))


def separate_layers(points, tris, zones, body_bvh, gap=.004, hidden=.025):
    """Rest pose: lift outer layers without cutting individual faces out of folded cloth."""
    outer = np.isin(zones, [Z['outer']])
    if not outer.any() or outer.all():
        return points, np.ones(len(tris), bool)
    inner_tris = tris[~outer]
    inner = BVHTree.FromPolygons([Vector(v) for v in points], inner_tris.tolist())
    outer_vertices = np.unique(tris[outer])
    inner_vertices = set(np.unique(inner_tris).tolist())
    points = points.copy()
    for index in outer_vertices:
        if index in inner_vertices:
            continue
        point = Vector(points[index])
        location, _normal, _face, distance = inner.find_nearest(point, .03)
        if location is None:
            continue
        skin = body_bvh.find_nearest(point)[0]
        below = body_bvh.find_nearest(location)[0]
        if skin is None or below is None:
            continue
        lift = ((location - below).length + gap) - (point - skin).length
        if lift > 0:
            direction = (point - skin).normalized()
            points[index] = np.array(point + direction * lift)
    return points, np.ones(len(tris), bool)


def bm_to_object(bm, name, collection):
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    return obj


def decimate(obj, target, protect=None):
    """Collapse-decimate an object to about ``target`` triangles (``protect``: vertex group kept).

    Many small closed parts resist one pass, so passes repeat (up to five) until the budget holds."""
    for _ in range(5):
        faces = sum(len(p.vertices) - 2 for p in obj.data.polygons)
        if faces <= target * 1.02:
            return faces
        modifier = obj.modifiers.new('Budget', 'DECIMATE')
        modifier.decimate_type = 'COLLAPSE'
        modifier.use_collapse_triangulate = True
        modifier.ratio = max(target / faces * .97, .01)
        if protect:
            modifier.vertex_group = protect
            modifier.invert_vertex_group = True
            modifier.vertex_group_factor = 1.0
        apply_modifiers(obj)
        if sum(len(p.vertices) - 2 for p in obj.data.polygons) > faces * .9:
            # Do not split non-manifold edges: that disconnects thin shells into loose triangles.
            # The caller reports an unmet budget rather than destroying the garment to reach it.
            break
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def apply_modifiers(obj):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated = obj.evaluated_get(depsgraph)
    mesh = bpy.data.meshes.new_from_object(evaluated, preserve_all_data_layers=True, depsgraph=depsgraph)
    old = obj.data
    obj.modifiers.clear()
    obj.data = mesh
    bpy.data.meshes.remove(old)


# ---------------------------------------------------------------------------------------------
# Skinning

def transfer_weights(points, body_verts, body_tris, body_weights):
    """Nearest-face interpolated weights from a (posed) body."""
    bvh = BVHTree.FromPolygons([Vector(v) for v in body_verts], body_tris.tolist())
    weights = np.zeros((len(points), len(BONES)))
    for index, point in enumerate(points):
        location, _normal, face, _distance = bvh.find_nearest(Vector(point))
        tri = body_tris[face]
        a, b, c = (Vector(body_verts[i]) for i in tri)
        bary = barycentric(Vector(location), a, b, c)
        weights[index] = bary @ body_weights[tri]
    return weights


def barycentric(p, a, b, c):
    v0, v1, v2 = b - a, c - a, p - a
    d00, d01, d11, d20, d21 = v0.dot(v0), v0.dot(v1), v1.dot(v1), v2.dot(v0), v2.dot(v1)
    denominator = d00 * d11 - d01 * d01
    if abs(denominator) < 1e-14:
        return np.array([1.0, 0, 0])
    v = (d11 * d20 - d01 * d21) / denominator
    w = (d00 * d21 - d01 * d20) / denominator
    return np.clip(np.array([1 - v - w, v, w]), 0, 1) / max(np.clip(np.array([1 - v - w, v, w]), 0, 1).sum(), 1e-9)


def neighbours(bm):
    bm.verts.ensure_lookup_table()
    return [[e.other_vert(v).index for e in v.link_edges] for v in bm.verts]


def smooth_field(field, adjacency, iterations, factor=.5, mask=None):
    field = field.copy()
    for _ in range(iterations):
        averaged = np.array([field[n].mean(0) if n else field[i] for i, n in enumerate(adjacency)])
        update = field + factor * (averaged - field)
        field = update if mask is None else np.where(mask[:, None] if field.ndim > 1 else mask, update, field)
    return field


def skirt_weights(points, weights, ref, entry):
    """Hips plus the thighs for skirt and dress cloth below the hips.

    Cloth over one thigh follows that thigh (seated, the lap lies over it); cloth between the
    legs takes an even share of both, so walking and sitting never split the skirt."""
    top, bottom = entry['skirt']
    width = abs(ref.joint['leftUpperLeg'][0])
    blend = np.clip((top - points[:, 2]) / max(top - bottom, .05), 0, 1)
    lateral = np.clip(points[:, 0] / (width * 1.1), -1, 1)
    left, right = (1 - lateral) / 2, (1 + lateral) / 2
    skirt = np.zeros_like(weights)
    thighs = np.clip(blend * 1.6, 0, 1)
    skirt[:, B['hips']] = 1 - thighs
    skirt[:, B['leftUpperLeg']] = thighs * left
    skirt[:, B['rightUpperLeg']] = thighs * right
    mix = np.clip((top - points[:, 2]) / .06, 0, 1)[:, None]
    return weights * (1 - mix) + skirt * mix


def limit_influences(weights, count=4):
    order = np.argsort(-weights, 1)
    limited = np.zeros_like(weights)
    rows = np.arange(len(weights))[:, None]
    limited[rows, order[:, :count]] = weights[rows, order[:, :count]]
    limited[limited < .02] = 0
    return limited / np.maximum(limited.sum(1, keepdims=True), 1e-9)


# ---------------------------------------------------------------------------------------------
# Rest-pose fitting

def push_out(points, adjacency, bvh, zones, iterations=4):
    """Keep every cloth vertex outside the skin by a margin; relax the correction along the cloth."""
    margin = np.where(np.isin(zones, [Z['outer'], Z['lining']]), OUTER_MARGIN, MARGIN)
    original = points.copy()
    for _ in range(iterations):
        moved = 0
        for index, point in enumerate(points):
            location, normal, _face, _distance = bvh.find_nearest(Vector(point), .12)
            if location is None:
                continue
            depth = (Vector(point) - location).dot(normal)
            if depth < margin[index]:
                points[index] = point + np.array(normal) * (margin[index] - depth)
                moved += 1
        displacement = smooth_field(points - original, adjacency, 3, .5)
        points = original + np.where(np.linalg.norm(displacement, axis=1, keepdims=True) > np.linalg.norm(points - original, axis=1, keepdims=True),
                                     displacement, points - original)
        if not moved:
            break
    return points


def vertex_zones(bm):
    layer = bm.faces.layers.int.get('zone')
    zones = np.full(len(bm.verts), Z['top'])
    for face in bm.faces:
        for vert in face.verts:
            zones[vert.index] = min(zones[vert.index], face[layer]) if face[layer] != Z['outer'] else Z['outer']
    return zones


REGIONS = {'leftArm': ['leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand'],
           'rightArm': ['rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand'],
           'leftLeg': ['leftUpperLeg', 'leftLowerLeg', 'leftFoot'], 'rightLeg': ['rightUpperLeg', 'rightLowerLeg', 'rightFoot']}


def body_regions(weights):
    """Per vertex: 0 torso/head, 1-4 left arm, right arm, left leg, right leg (dominant influence)."""
    totals = np.stack([weights[:, [B[n] for n in names]].sum(1) for names in REGIONS.values()], 1)
    torso = 1 - totals.sum(1, keepdims=True)
    return np.argmax(np.concatenate([torso, totals], 1), 1)


def visible_skin(ref, cloth_verts, cloth_tris, entry):
    """Faces of the reference skin left visible by the cloth, plus a band under loose hems.

    A face counts as covered when the ray along its normal meets cloth (tight within ``loose``,
    else loose) or first meets the body itself (inner thighs, armpits). Loose and body-occluded
    skin stays only within ``hem_band`` of visible skin of the same limb or torso, so walking
    and sitting never open a gap under a hem."""
    count = len(cloth_verts)
    scene = BVHTree.FromPolygons([Vector(v) for v in cloth_verts] + [Vector(v) for v in ref.verts],
                                 cloth_tris.tolist() + (ref.tris + count).tolist())
    cloth_only = BVHTree.FromPolygons([Vector(v) for v in cloth_verts], cloth_tris.tolist())
    tris = ref.tris
    centres = ref.verts[tris].mean(1)
    normals = np.cross(ref.verts[tris[:, 1]] - ref.verts[tris[:, 0]], ref.verts[tris[:, 2]] - ref.verts[tris[:, 0]])
    normals /= np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-12)
    region = body_regions(ref.weights)[tris[:, 0]]
    shipped = KDTree(len(ref.shipped_centres))
    for index, centre in enumerate(ref.shipped_centres):
        shipped.insert(centre, index)
    shipped.balance()
    state = np.zeros(len(tris), np.int8)  # 0 visible, 1 tightly covered, 2 loose or body-occluded, 3 shipped by the body GLB
    for index, (centre, normal) in enumerate(zip(centres, normals)):
        if shipped.find(centre)[2] < .004:
            state[index] = 3
            continue
        near = cloth_only.find_nearest(Vector(centre), .012)
        if near[0] is not None:
            state[index] = 1  # cloth lies on this skin: it would only flicker through
            continue
        hit = scene.ray_cast(Vector(centre) + Vector(normal) * .002, Vector(normal), .2)
        if hit[0] is None:
            continue
        if hit[2] < len(cloth_tris):
            state[index] = 1 if hit[3] < entry.get('loose', .03) else 2
        else:
            state[index] = 2
    if 'skin_above' in entry:
        # Borrowed shoes bring their own ankle skin; the reference skin stops above it.
        state[(centres[:, 2] < entry['skin_above']) & (state != 3)] = 1
    visible = state == 0
    keep = visible.copy()
    log('skin faces: visible %d, tight %d, loose %d, shipped %d' % tuple(int((state == k).sum()) for k in range(4)))
    band = entry.get('hem_band', .07)
    for part in range(5):
        seeds = np.nonzero(visible & (region == part))[0]
        if not len(seeds):
            continue
        tree = KDTree(len(seeds))
        for index in seeds:
            tree.insert(centres[index], int(index))
        tree.balance()
        for index in np.nonzero((state == 2) & (region == part))[0]:
            if tree.find(centres[index])[2] < band:
                keep[index] = True
    return keep


# ---------------------------------------------------------------------------------------------
# Assembly and export

def layer_over(points, tris, part, margin=.004, hidden=.025):
    """Cloth over a borrowed part: lift cloth out of it and drop the part's faces under the cloth."""
    b_points, b_tris, b_zones, b_weights = part
    under = BVHTree.FromPolygons([Vector(v) for v in b_points], b_tris.tolist())
    points = points.copy()
    for index, point in enumerate(points):
        location, normal, _face, distance = under.find_nearest(Vector(point), .03)
        if location is not None:
            depth = (Vector(point) - location).dot(normal)
            if -.02 < depth < margin:
                points[index] = point + np.array(normal) * (margin - depth)
    cloth = BVHTree.FromPolygons([Vector(v) for v in points], tris.tolist())
    keep = []
    for tri in b_tris:
        a, b, c = (Vector(b_points[i]) for i in tri)
        normal = (b - a).cross(c - a).normalized()
        keep.append(cloth.ray_cast((a + b + c) / 3 + normal * .001, normal, hidden)[0] is None)
    keep = np.array(keep, bool)
    if keep.all():
        return points, part
    b_tris, b_zones = b_tris[keep], b_zones[keep]
    used = np.unique(b_tris)
    remap = -np.ones(len(b_points), np.int64)
    remap[used] = np.arange(len(used))
    return points, (b_points[used], remap[b_tris], b_zones, b_weights[used])


def zone_materials(outfit_id):
    pascal = ''.join(part.capitalize() for part in outfit_id.split('-')[1:])
    materials = {}
    for zone, prefix in ZONE_PREFIX.items():
        name = '%s_%s' % (prefix, pascal)
        material = bpy.data.materials.get(name) or bpy.data.materials.new(name)
        material.use_nodes = True
        principled = next(n for n in material.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
        principled.inputs['Base Color'].default_value = (1, 1, 1, 1)
        principled.inputs['Roughness'].default_value = .62 if zone == 'skin' else (.45 if zone in ('shoes', 'trim') else .82)
        principled.inputs['Metallic'].default_value = .6 if zone == 'trim' else 0
        material.use_backface_culling = zone == 'skin'
        material.diffuse_color = (1, 1, 1, 1)
        materials[zone] = material
    return materials


def build_outfit(entry, parts, ref, collection):
    """One skinned mesh from (points, tris, zones per tri, weights) parts, parented to the rig."""
    verts, tris, zones, weights = [], [], [], []
    offset = 0
    for points, faces, face_zones, part_weights in parts:
        verts.append(points)
        tris.append(faces + offset)
        zones.append(face_zones)
        weights.append(part_weights)
        offset += len(points)
    verts, tris, zones, weights = np.concatenate(verts), np.concatenate(tris), np.concatenate(zones), np.concatenate(weights)
    used = sorted(set(zones.tolist()))
    materials = zone_materials(entry['id'])
    mesh = bpy.data.meshes.new('Outfit')
    mesh.from_pydata(verts.tolist(), [], tris.tolist())
    for zone in used:
        mesh.materials.append(materials[ZONES[zone]])
    slot = {zone: index for index, zone in enumerate(used)}
    mesh.polygons.foreach_set('material_index', [slot[z] for z in zones.tolist()])
    mesh.validate()
    obj = bpy.data.objects.new('Outfit', mesh)
    collection.objects.link(obj)
    weights = limit_influences(weights)
    groups = [obj.vertex_groups.new(name=name) for name in BONES]
    for vertex, row in enumerate(weights):
        for bone in np.nonzero(row)[0]:
            groups[bone].add([vertex], float(row[bone]), 'REPLACE')
    obj.parent = ref.rig
    modifier = obj.modifiers.new('Armature', 'ARMATURE')
    modifier.object = ref.rig
    mesh.shade_smooth()
    mesh.set_sharp_from_angle(angle=math.radians(SMOOTH_ANGLE))
    return obj


def export(ref, outfit, path):
    for obj in bpy.context.view_layer.objects:
        obj.select_set(False)
    ref.rig.select_set(True)
    outfit.select_set(True)
    bpy.context.view_layer.objects.active = ref.rig
    for pose_bone in ref.rig.pose.bones:
        pose_bone.matrix_basis = Matrix.Identity(4)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_yup=True, export_extras=False,
                              export_texcoords=False, export_normals=True, export_materials='EXPORT', export_cameras=False,
                              export_lights=False, export_animations=False, export_skins=True, export_morph=False,
                              export_vertex_color='NONE', export_attributes=False, export_tangents=False,
                              export_def_bones=False, export_rest_position_armature=True)
    with open(path, 'rb') as file:
        data = file.read()
    length = struct.unpack_from('<I', data, 12)[0]
    document = json.loads(data[20:20 + length])
    for key in ('images', 'textures', 'samplers', 'animations'):
        if document.get(key):
            raise ValueError('Unexpected %s in outfit export' % key)
    for material in document.get('materials', []):
        material['doubleSided'] = not material['name'].startswith('Skin_')
        material.pop('extras', None)
    for collection in ('meshes', 'nodes', 'scenes'):
        for item in document.get(collection, []):
            item.pop('extras', None)
    document['scenes'][0]['name'] = 'Extalia avatar outfit'
    encoded = json.dumps(document, ensure_ascii=True, separators=(',', ':')).encode()
    encoded += b' ' * (-len(encoded) % 4)
    tail = data[20 + length:]
    data = struct.pack('<IIIII', 0x46546C67, 2, 20 + len(encoded) + len(tail), len(encoded), 0x4E4F534A) + encoded + tail
    with open(path, 'wb') as file:
        file.write(data)
    return len(data)


def borrowed_parts(ref, entry):
    """Shoes, trousers or other parts taken from the body's own scan outfit (already rigged)."""
    parts = []
    for spec in entry.get('borrow', []):
        source = ref.objects[spec['from']]
        verts, tris = mesh_arrays(source)
        weights = vertex_weights(source)
        names = [slot.material.name if slot.material else '' for slot in source.material_slots]
        source.data.calc_loop_triangles()
        material_of = np.array([source.data.polygons[t.polygon_index].material_index for t in source.data.loop_triangles])
        keep = np.zeros(len(tris), bool)
        zones = np.zeros(len(tris), np.int64)
        for index, name in enumerate(names):
            for pattern, zone in spec['materials']:
                if re.search(pattern, name, re.I):
                    keep |= material_of == index
                    zones[material_of == index] = Z[zone]
                    break
        if 'below' in spec:
            keep &= verts[tris].max(1)[:, 2] < spec['below']
        tris, zones = tris[keep], zones[keep]
        used = np.unique(tris)
        remap = -np.ones(len(verts), np.int64)
        remap[used] = np.arange(len(used))
        parts.append((verts[used], remap[tris], zones, weights[used], spec.get('triangles', 900)))
    return parts


def mesh_part(points, tris, zones, weights, name, collection, target, protect_boundary=False):
    """Decimate a part (points/tris/zones/weights) through a temporary object; returns arrays."""
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(points.tolist(), [], tris.tolist())
    mesh.validate()
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    layer = mesh.attributes.new('zone', 'INT', 'FACE')
    layer.data.foreach_set('value', zones.tolist())
    groups = [obj.vertex_groups.new(name=n) for n in BONES]
    for vertex, row in enumerate(weights):
        for bone in np.nonzero(row > 1e-4)[0]:
            groups[bone].add([vertex], float(row[bone]), 'REPLACE')
    if protect_boundary:
        bm = bmesh.new()
        bm.from_mesh(mesh)
        boundary = [v.index for v in bm.verts if v.is_boundary]
        bm.free()
        obj.vertex_groups.new(name='Boundary').add(boundary, 1.0, 'REPLACE')
    decimate(obj, target, 'Boundary' if protect_boundary else None)
    verts, faces = mesh_arrays(obj)
    mesh = obj.data
    mesh.calc_loop_triangles()
    polygon_zone = np.array([a.value for a in mesh.attributes['zone'].data])
    face_zones = np.array([polygon_zone[t.polygon_index] for t in mesh.loop_triangles])
    part_weights = vertex_weights(obj)
    bpy.data.objects.remove(obj)
    return verts, faces, face_zones, part_weights


def process(entry, path, collection, review=None):
    ref = Reference(entry['group'], collection)
    objects = import_source(path, collection)
    bm, avatar, colours = combine(objects, entry)
    for obj in objects:
        bpy.data.objects.remove(obj)
    from_avatar = normalise(bm, avatar, entry, ref)
    weld(bm)
    removed = remove_small_islands(bm)
    log('welded; removed %d faces in tiny islands; %d faces' % (removed, len(bm.faces)))
    points = bm_points(bm)
    core = (np.abs(points[:, 0]) < .17)
    if not from_avatar and 'span' not in entry:
        register(bm, entry, ref, ref.core_bvh, core, wide=True)
    register(bm, entry, ref, ref.core_bvh, core)
    palette = assign_zones(bm, ref, colours)
    points = bm_points(bm)
    rotations = limb_rotations(points, ref, entry)
    mats = ref.pose(rotations)
    posed_body = skin_points(ref.verts, ref.weights, mats)
    posed_bvh = BVHTree.FromPolygons([Vector(v) for v in posed_body], ref.tris.tolist())
    posed_core = BVHTree.FromPolygons([Vector(v) for v in posed_body], ref.core_tris.tolist())
    register(bm, entry, ref, posed_core, np.abs(bm_points(bm)[:, 0]) < .17, coarse=False)
    if len(bm.faces) > 60000:
        # Keep the ray cull affordable: collapse heavy cloth before it.
        obj = bm_to_object(bm, 'Stage two', collection)
        decimate(obj, 60000)
        bm.free()
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        bpy.data.objects.remove(obj)
    # Preserve source surfaces. Pushing a mismatched source sleeve onto the posed body can
    # fold it across an elbow. The retired visibility cull no longer needs this projection.
    bm.verts.index_update()
    boundary = sum(1 for e in bm.edges if e.is_boundary)
    log('before budget: %d faces, %d verts, %d boundary edges, %d non-manifold' % (len(bm.faces), len(bm.verts), boundary,
        sum(1 for e in bm.edges if len(e.link_faces) > 2)))
    obj = bm_to_object(bm, 'Cloth', collection)
    bm.free()
    borrowed_budget = sum(spec.get('triangles', 900) for spec in entry.get('borrow', []))
    triangles = decimate(obj, entry.get('triangles', max(3200, CLOTH_TRIANGLES - borrowed_budget // 2)))
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bpy.data.objects.remove(obj)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    remove_small_islands(bm, .008)
    bm.verts.index_update()
    bm.faces.ensure_lookup_table()
    points = bm_points(bm)
    weights = transfer_weights(points, posed_body, ref.tris, ref.weights)
    adjacency = neighbours(bm)
    weights = limit_influences(smooth_field(weights, adjacency, entry.get('weight_smoothing', 4), .5))
    rest_points = unskin_points(points, weights, mats)
    if entry.get('skirt'):
        weights = limit_influences(skirt_weights(rest_points, weights, ref, entry))
        rest_points = unskin_points(points, weights, mats)
    set_bm_points(bm, rest_points)
    if entry.get('hem'):
        # Long hems are cropped (they would sweep through the chair when seated).
        bm.verts.ensure_lookup_table()
        doomed = [f for f in bm.faces if max(v.co.z for v in f.verts) < entry['hem']]
        keep = np.array([any(f not in doomed_set for f in v.link_faces) for v in bm.verts]
                        if (doomed_set := set(doomed)) is not None else [])
        bmesh.ops.delete(bm, geom=doomed, context='FACES_ONLY')
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
        weights = weights[keep]
        bm.verts.index_update()
        adjacency = neighbours(bm)
    zones = vertex_zones(bm)
    points = push_out(bm_points(bm), adjacency, ref.bvh, zones)
    set_bm_points(bm, points)
    for pose_bone in ref.rig.pose.bones:
        pose_bone.matrix_basis = Matrix.Identity(4)
    bm.faces.ensure_lookup_table()
    flipped = orient_outward(bm, ref.bvh)
    log('oriented %d faces away from the body' % flipped)
    layer = bm.faces.layers.int.get('zone')
    cloth_tris = np.array([[v.index for v in f.verts] for f in bm.faces if len(f.verts) == 3])
    cloth_zones = np.array([f[layer] for f in bm.faces if len(f.verts) == 3])
    points, visible = separate_layers(points, cloth_tris, cloth_zones, ref.bvh)
    cloth_tris, cloth_zones = cloth_tris[visible], cloth_zones[visible]
    log('layers: %d under-layer faces hidden by outer cloth removed' % int((~visible).sum()))
    parts = [(points, cloth_tris, cloth_zones, weights)]
    occluders = [(points, cloth_tris)]
    specs = list(entry.get('borrow', []))
    has_shoes = Z['shoes'] in set(cloth_zones.tolist()) or any(z == 'shoes' for spec in specs for _p, z in spec['materials'])
    if not has_shoes and not entry.get('barefoot'):
        # Every look wears shoes: the body's own scan-outfit shoes (and, for her, the ankle skin inside them).
        specs.append(DEFAULT_SHOES[entry['group']])
    if any(zone == 'shoes' for spec in specs for _p, zone in spec['materials']):
        # Borrowed shoes are closed (hers bring the ankle skin inside them): no reference foot skin.
        entry = dict(entry, skin_above=entry.get('skin_above', .14 if entry['group'] == 'female' else .13))
    for borrowed in borrowed_parts(ref, dict(entry, borrow=specs)):
        b_points, b_tris, b_zones, b_weights, target = borrowed
        part = mesh_part(b_points, b_tris, b_zones, b_weights, 'Borrowed', collection, target)
        points, part = layer_over(points, cloth_tris, part)
        parts[0] = (points, cloth_tris, cloth_zones, weights)
        occluders[0] = (points, cloth_tris)
        parts.append(part)
        occluders.append(part[:2])
    occluder_points = np.concatenate([o[0] for o in occluders])
    occluder_tris = np.concatenate([o[1] + sum(len(p[0]) for p in occluders[:i]) for i, o in enumerate(occluders)])
    keep = visible_skin(ref, occluder_points, occluder_tris, entry)
    if keep.any():
        tris = ref.tris[keep]
        used = np.unique(tris)
        remap = -np.ones(len(ref.verts), np.int64)
        remap[used] = np.arange(len(used))
        skin = mesh_part(ref.verts[used], remap[tris], np.full(len(tris), Z['skin']), ref.weights[used], 'Skin', collection,
                         entry.get('skin_triangles', 1600), protect_boundary=True)
        parts.append(skin)
    outfit = build_outfit(entry, parts, ref, collection)
    stats = {'triangles': sum(len(p[1]) for p in parts), 'cloth': int(len(cloth_tris)),
             'skin': int(len(parts[-1][1])) if keep.any() else 0,
             'zones': sorted({ZONES[z] for p in parts for z in set(p[2].tolist())}),
             'palette': {zone: palette[zone] for zone in sorted(palette) if zone in ZONE_PREFIX},
             'arms': sorted(name for name in rotations)}
    log('outfit %s: %s' % (entry['id'], json.dumps(stats, sort_keys=True)))
    del triangles
    return ref, outfit, stats


def remove_collection(collection):
    for child in list(collection.children):
        remove_collection(child)
    for obj in list(collection.objects):
        bpy.data.objects.remove(obj)
    bpy.data.collections.remove(collection)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.armatures, bpy.data.textures):
        for item in list(block):
            if item.users == 0:
                block.remove(item)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-dir', help='folder holding the clothing downloads (any depth)')
    parser.add_argument('--output', default=OUTPUT)
    parser.add_argument('--work-dir', help='empty scratch folder for extracted sources')
    parser.add_argument('--only', help='comma-separated catalog ids')
    parser.add_argument('--build-reference', help='merged avatar review .blend to cut the reference bodies from')
    parser.add_argument('--save-review', help='save the processed scene as this .blend (review only)')
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
    if args.build_reference:
        for group in ('female', 'male'):
            build_reference(args.build_reference, group)
        return
    _catalog, entries = load_catalog()
    work_dir = args.work_dir or tempfile.mkdtemp(prefix='avatar-outfits-')
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    results = {}
    ids = args.only.split(',') if args.only else list(entries)
    for outfit_id in ids:
        entry = entries[outfit_id]
        if entry.get('status') == 'skip':
            log('skip %s: %s' % (outfit_id, entry.get('reason', 'not processed')))
            continue
        path = extract_source(entry, args.source_dir, work_dir)
        if path is None:
            log('skip %s: archive %s not found under --source-dir' % (outfit_id, entry['archive']))
            continue
        collection = bpy.data.collections.new(outfit_id)
        scene.collection.children.link(collection)
        ref, outfit, stats = process(entry, path, collection)
        target = os.path.join(args.output, entry['group'], outfit_id + '.glb')
        os.makedirs(os.path.dirname(target), exist_ok=True)
        stats['bytes'] = export(ref, outfit, target)
        stats.update(path='avatars/outfits/%s/%s' % (entry['group'], os.path.basename(target)), group=entry['group'])
        if stats['triangles'] > entry.get('max_triangles', MAX_TRIANGLES) or stats['bytes'] > entry.get('max_bytes', MAX_BYTES):
            raise ValueError('%s over budget: %s' % (outfit_id, stats))
        log('exported %s %d bytes' % (target, stats['bytes']))
        results[outfit_id] = stats
        if args.save_review:
            bpy.ops.wm.save_as_mainfile(filepath=args.save_review, compress=True, copy=True)
        remove_collection(collection)
        shutil.rmtree(os.path.join(work_dir, outfit_id), ignore_errors=True)
    manifest_path = os.path.join(args.output, 'outfits.manifest.json')
    os.makedirs(args.output, exist_ok=True)
    with open(manifest_path + '.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        manifest = json.load(open(manifest_path)) if os.path.exists(manifest_path) else {}
        manifest.update(results)
        manifest = {key: manifest[key] for key in sorted(manifest) if key in entries}
        with open(manifest_path, 'w') as file:
            json.dump(manifest, file, indent=2, sort_keys=True)
            file.write('\n')


if __name__ == '__main__':
    main()
