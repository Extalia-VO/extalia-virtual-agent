"""Build the facility staff uniforms (receptionist, bartender) for both avatar bodies.

Run headless (exports every uniform, or some with --only <id>/<group>[,...]):

    Blender --background --factory-startup --python tooling/blender/create-staff-uniforms.py -- \
        [--only reception-uniform/female] [--review <dir for review renders>]

or exec it in a live Blender to build into the scene "Extalia Uniforms" (nothing is saved):

    exec(open(path).read(), {"__name__": "__live__", "__file__": path,
         "LIVE_ARGS": ["--only", "bartender-uniform/male", "--x", "1.2"]})

A uniform starts from the body's own scanned outfit (`ScanOutfit`: shirt or blouse, trousers,
shoes) and adds tailored layers cut from it with planar edges: a blazer (torso and sleeves
stopping above the shirt cuff, back collar, front V, buttons) or a waistcoat (armholes, deeper
V, satin back). Layers are lifted off the garment below and skinned to the 20-joint
`AvatarLiteRig`: torso panels take the base garment's weights without any arm influence below
the shoulder line (no armpit webbing), sleeves an anatomical upper-arm/forearm blend, hems mostly
the hips. Base faces hidden under a layer are removed. Generated accessories: a name badge, a bow
tie, a knotted neck scarf, a long bistro apron and rolled shirt sleeves with forearm skin.

Downloaded jacket and vest shells were evaluated as sources but did not refit cleanly (layered
pattern panels, A-pose, other proportions), so none is used. The output is a derivative of the
licensed avatar outfit (RenderHub Extended Use License), not MIT.

The export follows the fitted-outfit convention of `prepare-avatar-outfits.py`: the rig plus one
skinned mesh `Outfit`, role materials `Office<Zone>_<Id>` / `Skin_<Id>` in plain white (tinted at
runtime; belt, badge card and apron keep a fixed colour), no UVs or textures, written to
`apps/web/local-assets/avatars/outfits/<group>/<id>.glb`. Reruns are deterministic.
"""
import json
import math
import re
import struct
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

ROOT = Path(__file__).resolve().parents[2]
CATALOG = ROOT / "tooling/blender/staff-uniforms.json"
BODIES = ROOT / "apps/web/public-assets/avatars/bodies"
OUTPUT = ROOT / "apps/web/local-assets/avatars/outfits"
MANIFEST = OUTPUT / "staff-uniforms.manifest.json"
EXPORTER = "tooling/blender/create-staff-uniforms.py"
ARM_PARTS = ("UpperArm", "LowerArm", "Hand")
# Bone names follow the source rig: "left*" bones sit on -X (the wearer's right side).
SIDES = ("left", "right")


def parse_args(argv):
    args = {"only": None, "live": False, "x": 0.0, "review": None, "pose": None, "stay": None}
    i = 0
    while i < len(argv):
        key = argv[i]
        if key == "--only":
            args["only"] = argv[i + 1]; i += 2
        elif key == "--review":
            args["review"] = Path(argv[i + 1]); i += 2
        elif key == "--stay":
            args["stay"] = True; i += 1
        elif key == "--pose":
            args["pose"] = argv[i + 1]; i += 2
        elif key == "--x":
            args["x"] = float(argv[i + 1]); i += 2
        else:
            raise SystemExit(f"unknown argument {key}")
    return args


# ── small helpers ──

def smoothstep(a, b, x):
    if b == a:
        return 1.0 if x >= b else 0.0
    t = max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def import_glb(path, collection):
    layer = bpy.context.view_layer.layer_collection
    def find(layer_collection):
        if layer_collection.collection == collection:
            return layer_collection
        for child in layer_collection.children:
            found = find(child)
            if found:
                return found
        return None
    bpy.context.view_layer.active_layer_collection = find(layer)
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(path), import_shading="NORMALS", loglevel=50)
    return [obj for obj in bpy.data.objects if obj not in before]


def base_name(name):
    return re.sub(r"\.\d+$", "", name)


def material(name, color, roughness=0.75, metallic=0.0):
    mat = bpy.data.materials.get(name)
    if mat is None or mat.get("extalia_uniform") is None:
        mat = bpy.data.materials.new(name)
    mat["extalia_uniform"] = True
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    bsdf = next(node for node in nodes if node.type == "BSDF_PRINCIPLED")
    rgba = (*[int(color[i:i + 2], 16) / 255 for i in (1, 3, 5)], 1.0)
    # sRGB hex to linear for the shader input.
    rgba = tuple(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgba[:3]) + (1.0,)
    bsdf.inputs["Base Color"].default_value = rgba
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    mat.diffuse_color = rgba
    mat.use_backface_culling = False
    return mat


def mesh_object(name, bm, collection):
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    return obj


def remove_objects(objects):
    meshes = {obj.data for obj in objects if obj.type == "MESH"}
    for obj in objects:
        bpy.data.objects.remove(obj, do_unlink=True)
    for mesh in meshes:
        if mesh.users == 0:
            bpy.data.meshes.remove(mesh)


def datablocks():
    return {kind: set(getattr(bpy.data, kind)) for kind in ("images", "materials", "meshes", "textures")}


def purge_orphans(before):
    """Remove unused datablocks created since `before` (never anything already in the file)."""
    for kind, existing in before.items():
        collection = getattr(bpy.data, kind)
        for item in list(collection):
            if item not in existing and item.users == 0:
                collection.remove(item)


# ── body ──

class Body:
    def __init__(self, path, collection):
        objects = import_glb(path, collection)
        self.objects = objects
        self.rig = next(obj for obj in objects if obj.type == "ARMATURE")
        self.base = next(obj for obj in objects if obj.type == "MESH" and base_name(obj.name) == "ScanOutfit")
        self.skin = next(obj for obj in objects if obj.type == "MESH" and base_name(obj.name) == "Body")
        for obj in objects:
            if obj.type == "MESH" and (obj.parent is None or base_name(obj.name).startswith(("ScanOutfit", "Acc", "Facial"))):
                obj.hide_viewport = True
                obj.hide_render = True
        self.bones = {bone.name: bone for bone in self.rig.data.bones}
        self.bone_names = [bone.name for bone in self.rig.data.bones]
        world = self.rig.matrix_world
        self.head = {name: world @ bone.head_local for name, bone in self.bones.items()}

    def arm(self, side):
        return [self.head[f"{side}{part}"] for part in ARM_PARTS]


def face_material(obj, face):
    return base_name(obj.data.materials[face.material_index].name) if obj.data.materials else ""


def dominant_bone(obj, vertex):
    best, weight = None, 0.0
    for group in vertex.groups:
        if group.weight > weight:
            best, weight = obj.vertex_groups[group.group].name, group.weight
    return best


def surface(obj, face_filter=None):
    """BVH of an object's faces (world space), optionally only faces passing the filter."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.transform(obj.matrix_world)
    if face_filter is not None:
        drop = [face for face in bm.faces if not face_filter(face)]
        bmesh.ops.delete(bm, geom=drop, context="FACES")
    bm.normal_update()
    tree = BVHTree.FromBMesh(bm)
    return tree, bm


def arm_face_filter(obj, side):
    names = {f"{side}{part}" for part in ARM_PARTS}
    owners = [dominant_bone(obj, vertex) in names for vertex in obj.data.vertices]
    def accept(face):
        return sum(owners[v.index] for v in face.verts) * 2 > len(face.verts)
    return accept


def torso_face_filter(obj):
    names = {f"{side}{part}" for side in SIDES for part in ARM_PARTS}
    owners = [dominant_bone(obj, vertex) in names for vertex in obj.data.vertices]
    def accept(face):
        return sum(owners[v.index] for v in face.verts) * 2 <= len(face.verts)
    return accept


# ── weights ──

def ensure_groups(obj, names):
    for name in names:
        if obj.vertex_groups.get(name) is None:
            obj.vertex_groups.new(name=name)


def set_weights(obj, index, weights):
    total = sum(weights.values())
    if total <= 0:
        return
    items = sorted(((w / total, name) for name, w in weights.items() if w > 1e-4), reverse=True)[:4]
    total = sum(w for w, _ in items)
    for group in obj.vertex_groups:
        group.remove([index])
    for weight, name in items:
        obj.vertex_groups[name].add([index], weight / total, "REPLACE")


def base_weights_at(body, tree, bm_base, point):
    """Barycentric blend of the base garment's weights at the nearest base face."""
    location, _, face_index, _ = tree.find_nearest(point)
    if location is None:
        return {}
    bm_base.faces.ensure_lookup_table()
    face = bm_base.faces[face_index]
    deform = bm_base.verts.layers.deform.active
    weights = {}
    distances = [max(1e-6, (v.co - location).length) for v in face.verts]
    inverse = [1 / d for d in distances]
    total = sum(inverse)
    names = [group.name for group in body.base.vertex_groups]
    for v, w in zip(face.verts, inverse):
        for group, value in v[deform].items():
            name = names[group]
            weights[name] = weights.get(name, 0) + value * w / total
    return weights


def arm_weights(body, side, point):
    shoulder, elbow, wrist = body.arm(side)
    upper, lower = elbow - shoulder, wrist - elbow
    if (point - elbow).dot(-upper) > 0:
        u = max(0.0, (point - shoulder).dot(upper.normalized()))
    else:
        u = upper.length + max(0.0, (point - elbow).dot(lower.normalized()))
    cap = smoothstep(-0.01, 0.07, u)
    bend = smoothstep(upper.length - 0.045, upper.length + 0.05, u)
    hand = smoothstep(upper.length + lower.length - 0.035, upper.length + lower.length + 0.02, u)
    return {
        "chest": (1 - cap) * 0.45, f"{side}Shoulder": (1 - cap) * 0.55,
        f"{side}UpperArm": cap * (1 - bend), f"{side}LowerArm": cap * bend * (1 - hand), f"{side}Hand": cap * bend * hand,
    }


def strip_arm_influence(body, weights, point):
    """Torso cloth never follows the arm below the shoulder line: that is what webs armpits."""
    shoulder_z = body.head["leftUpperArm"].z
    keep = smoothstep(shoulder_z - 0.07, shoulder_z - 0.01, point.z)
    result = {}
    for name, value in weights.items():
        if any(name.endswith(part) for part in ARM_PARTS):
            value *= keep * 0.6
        result[name] = value
    return result


# ── generated accessories ──

def ray_front(trees, x, z, depth_from=-1.0):
    """First hit of a ray from the front (-Y) at (x, z) on any of the trees."""
    best = None
    for tree in trees:
        hit, normal, _, distance = tree.ray_cast(Vector((x, depth_from, z)), Vector((0, 1, 0)), 2.0)
        if hit is not None and (best is None or distance < best[2]):
            best = (hit, normal, distance)
    return best


def oriented_box(bm, centre, normal, up, size, mat_index):
    """A box of size (width, height, thickness) lying on a surface with the given normal."""
    normal = normal.normalized()
    right = up.cross(normal).normalized()
    up = normal.cross(right).normalized()
    w, h, t = (s / 2 for s in size)
    corners = []
    for dz in (-t, t):
        for dy in (-h, h):
            for dx in (-w, w):
                corners.append(bm.verts.new(centre + right * dx + up * dy + normal * (t + dz)))
    order = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    for quad in order:
        face = bm.faces.new([corners[i] for i in quad])
        face.material_index = mat_index
    return corners


def add_badge(bm, trees, body, mats):
    shoulder = body.head["leftUpperArm"]
    hit = ray_front(trees, abs(shoulder.x) * 0.6, shoulder.z - 0.135)
    if not hit:
        return []
    centre, normal = hit[0], hit[1]
    verts = oriented_box(bm, centre, normal, Vector((0, 0, 1)), (0.072, 0.022, 0.003), mats["badge_plate"])
    stripe = oriented_box(bm, centre + Vector((0, 0, 0.0075)), normal, Vector((0, 0, 1)), (0.072, 0.006, 0.0036), mats["badge_accent"])
    return [(v, {"chest": 1.0}) for v in verts + stripe]


def wing(bm, centre, direction, normal, mat_index, length=0.055, inner=0.012, outer=0.042, thickness=0.012):
    """One bow-tie wing: a tapered, slightly pinched block from the knot outwards."""
    right = direction.normalized()
    up = normal.cross(right).normalized()
    rings = []
    for along, height, depth in ((0.0, inner, thickness * 0.6), (length * 0.55, outer * 0.86, thickness), (length, outer, thickness * 0.7)):
        ring = []
        for dy, dz in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            ring.append(bm.verts.new(centre + right * along + up * (dy * height / 2) + normal * (dz * depth / 2 + depth / 2)))
        rings.append(ring)
    for a, b in zip(rings, rings[1:]):
        for i in range(4):
            face = bm.faces.new([a[i], a[(i + 1) % 4], b[(i + 1) % 4], b[i]])
            face.material_index = mat_index
    for ring, flip in ((rings[0], True), (rings[-1], False)):
        face = bm.faces.new(list(reversed(ring)) if flip else ring)
        face.material_index = mat_index
    return [v for ring in rings for v in ring]


def add_bowtie(bm, trees, body, mats):
    neck = body.head["neck"]
    hit = ray_front(trees, 0.0, neck.z - 0.035)
    if not hit:
        return []
    centre, normal = hit[0], Vector((0, -1, 0))
    knot = oriented_box(bm, centre, normal, Vector((0, 0, 1)), (0.018, 0.02, 0.014), mats["bowtie"])
    verts = list(knot)
    for direction in (Vector((1, 0, 0)), Vector((-1, 0, 0))):
        verts += wing(bm, centre + direction * 0.006, direction, normal, mats["bowtie"])
    return [(v, {"neck": 0.35, "chest": 0.65}) for v in verts]


def add_scarf(bm, trees, body, mats):
    """A small knotted neck scarf with two short tails, worn at the side of the collar."""
    neck = body.head["neck"]
    hit = ray_front(trees, 0.035, neck.z - 0.03)
    if not hit:
        return []
    centre, normal = hit[0], hit[1].normalized()
    verts = list(oriented_box(bm, centre, normal, Vector((0, 0, 1)), (0.026, 0.024, 0.016), mats["scarf"]))
    for angle in (-0.35, 0.45):
        direction = Vector((math.sin(angle), 0, -math.cos(angle)))
        verts += wing(bm, centre + direction * 0.008, direction, normal, mats["scarf"], length=0.075, inner=0.016, outer=0.034, thickness=0.006)
    return [(v, {"neck": 0.3, "chest": 0.7}) for v in verts]


def add_apron(bm, trees, body, mats, waist_z, hem_z):
    """A long bistro apron from the waist to mid-calf, wrapping the front and the sides."""
    hips = body.head["hips"]
    centre = Vector((0, hips.y + 0.01, 0))
    angles = [math.radians(a) for a in range(-96, 97, 12)]
    rows = 11
    heights = [waist_z + (hem_z - waist_z) * (i / (rows - 1)) ** 1.15 for i in range(rows)]
    def radius(angle, z):
        direction = Vector((math.sin(angle), -math.cos(angle), 0))
        origin = Vector((centre.x, centre.y, z)) + direction * 0.6
        best = 0.0
        for tree in trees:
            hit, _, _, _ = tree.ray_cast(origin, -direction, 0.6)
            if hit is not None:
                best = max(best, (hit - Vector((centre.x, centre.y, z))).dot(direction))
        return best
    grid = []
    for angle in angles:
        reach = 0.0
        column = []
        for row, z in enumerate(heights):
            r = radius(angle, z)
            reach = max(reach, r)
            flare = 0.012 * (row / (rows - 1)) ** 2
            direction = Vector((math.sin(angle), -math.cos(angle), 0))
            column.append(Vector((centre.x, centre.y, z)) + direction * (reach + 0.008 + flare))
        grid.append(column)
    verts = [[bm.verts.new(p) for p in column] for column in grid]
    for a, b in zip(verts, verts[1:]):
        for i in range(rows - 1):
            face = bm.faces.new([a[i], b[i], b[i + 1], a[i + 1]])
            face.material_index = mats["apron"]
    # Waist tie around the back.
    band = []
    for step in range(24):
        angle = math.radians(96 + step * (168 / 23))
        r = radius(angle, waist_z) + 0.006
        direction = Vector((math.sin(angle), -math.cos(angle), 0))
        band.append((bm.verts.new(Vector((centre.x, centre.y, waist_z + 0.012)) + direction * r),
                     bm.verts.new(Vector((centre.x, centre.y, waist_z - 0.012)) + direction * r)))
    ends = [(verts[-1][0], verts[-1][1])] + band + [(verts[0][0], verts[0][1])]
    for (a_top, a_low), (b_top, b_low) in zip(ends, ends[1:]):
        if len({a_top, a_low, b_top, b_low}) == 4:
            face = bm.faces.new([a_top, a_low, b_low, b_top])
            face.material_index = mats["apron"]
    result = []
    for column in verts:
        for row, v in enumerate(column):
            t = smoothstep(0.0, 1.0, row / (rows - 1))
            hip_share = 1.0 - 0.55 * t
            left = smoothstep(-0.05, 0.05, -v.co.x)
            result.append((v, {"hips": hip_share, "leftUpperLeg": (1 - hip_share) * left, "rightUpperLeg": (1 - hip_share) * (1 - left)}))
    for top, low in band:
        result += [(top, {"hips": 1.0}), (low, {"hips": 1.0})]
    return result


def roll_sleeves(base_bm, body, mats, top_names):
    """Cut the shirt sleeves below the elbow, add a rolled cuff and forearm skin down to the wrist."""
    deform = base_bm.verts.layers.deform.active
    groups = {}
    out = []
    for side in SIDES:
        shoulder, elbow, wrist = body.arm(side)
        lower = (wrist - elbow)
        axis = lower.normalized()
        cut = 0.075
        def along(co):
            return (co - elbow).dot(axis)
        sleeve_faces = []
        for face in base_bm.faces:
            if face.material_index not in top_names:
                continue
            centre = face.calc_center_median()
            # Only the forearm part of this side's sleeve.
            if along(centre) > cut and (centre - (elbow + axis * along(centre))).length < 0.09 and (centre.x < 0) == (elbow.x < 0):
                sleeve_faces.append(face)
        if not sleeve_faces:
            continue
        samples = {}
        for face in sleeve_faces:
            for v in face.verts:
                samples[v.index] = v.co.copy()
        radius_at_cut = [((co - (elbow + axis * along(co))).length) for co in samples.values() if abs(along(co) - cut) < 0.02]
        r_cut = sum(radius_at_cut) / max(1, len(radius_at_cut)) if radius_at_cut else 0.05
        bmesh.ops.delete(base_bm, geom=sleeve_faces, context="FACES")
        # Forearm: a tube from the cut to just inside the body's wrist skin.
        skin_ring = [body.skin.matrix_world @ v.co for v in body.skin.data.vertices]
        wrist_top = max(co.z for co in skin_ring if (co.x < 0) == (elbow.x < 0) and abs(co.x) > 0.12)
        ring_points = [co for co in skin_ring if (co.x < 0) == (elbow.x < 0) and abs(co.x) > 0.12 and wrist_top - 0.012 <= co.z <= wrist_top]
        r_wrist = max(0.022, sum((co - (elbow + axis * along(co))).length for co in ring_points) / max(1, len(ring_points)))
        end = (wrist_top - 0.012 - elbow.z) / axis.z
        segments, rings = 14, 7
        right = axis.cross(Vector((0, 1, 0))).normalized()
        forward = right.cross(axis).normalized()
        tube = []
        for ring in range(rings):
            t = ring / (rings - 1)
            a = cut - 0.012 + (end - cut + 0.012) * t
            r = (r_cut * 0.8) * (1 - t) + (r_wrist + 0.0015) * t
            # Forearms are slightly flattened front to back.
            loop = []
            for s in range(segments):
                angle = 2 * math.pi * s / segments
                offset = right * math.cos(angle) * r + forward * math.sin(angle) * r * 0.82
                loop.append(base_bm.verts.new(elbow + axis * a + offset))
            tube.append(loop)
        for a, b in zip(tube, tube[1:]):
            for s in range(segments):
                face = base_bm.faces.new([a[s], a[(s + 1) % segments], b[(s + 1) % segments], b[s]])
                face.material_index = mats["forearm"]
        # Rolled cuff: a short thick band over the cut edge.
        cuff = []
        for layer, (a, r) in enumerate(((cut - 0.022, r_cut * 1.02), (cut - 0.004, r_cut * 1.12), (cut + 0.016, r_cut * 1.12), (cut + 0.03, r_cut * 0.84))):
            loop = []
            for s in range(segments):
                angle = 2 * math.pi * s / segments
                offset = right * math.cos(angle) * r + forward * math.sin(angle) * r * 0.86
                loop.append(base_bm.verts.new(elbow + axis * a + offset))
            cuff.append(loop)
        for a, b in zip(cuff, cuff[1:]):
            for s in range(segments):
                face = base_bm.faces.new([a[s], a[(s + 1) % segments], b[(s + 1) % segments], b[s]])
                face.material_index = mats["cuff"]
        for loop in tube + cuff:
            for v in loop:
                out.append((v, arm_weights(body, side, v.co)))
    return out


# ── build ──

def decimate(obj, target):
    tris = sum(len(poly.vertices) - 2 for poly in obj.data.polygons)
    if tris <= target:
        return
    modifier = obj.modifiers.new("Decimate", "DECIMATE")
    modifier.ratio = target / tris
    modifier.use_collapse_triangulate = True
    modifier.use_symmetry = True
    modifier.symmetry_axis = "X"
    with bpy.context.temp_override(object=obj, active_object=obj, selected_objects=[obj]):
        bpy.ops.object.modifier_apply(modifier=modifier.name)



def bisect(bm, co, normal):
    bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=co, plane_no=normal, dist=1e-5)


def drop_faces(bm, predicate):
    bmesh.ops.delete(bm, geom=[face for face in bm.faces if predicate(face.calc_center_median())], context="FACES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")


def shell_from_base(body, spec, collection, mats):
    """A tailored layer cut from the body's own scanned outfit with clean planar edges: a blazer
    (torso and sleeves down to just above the shirt cuff, collar at the back, front V) or a
    waistcoat (torso only, armholes and a deeper V; satin back), lifted off the garment below.
    Weights: the torso takes the base garment's weights without arm influence below the
    shoulder line, sleeves an anatomical upper-arm/forearm blend, the hem mostly the hips."""
    source = body.base
    kind = spec["kind"]
    bm = bmesh.new()
    bm.from_mesh(source.data)
    names = [base_name(m.name) for m in source.data.materials]
    owners = [dominant_bone(source, v) for v in source.data.vertices]
    arm_bones = {f"{side}{part}": side for side in SIDES for part in ARM_PARTS}
    shoulder = body.head["leftUpperArm"].z
    neck = body.head["neck"].z
    crotch = body.head["leftUpperLeg"].z - 0.07
    tops = [f for f in bm.faces if names[f.material_index].startswith("OfficeTop")]
    top_low = min(f.calc_center_median().z for f in tops)
    hem = max(crotch + 0.02, body.head["hips"].z + spec["hem"])

    def side_of(face):
        votes = [arm_bones.get(owners[v.index]) for v in face.verts]
        for side in SIDES:
            if votes.count(side) * 2 > len(votes):
                return side
        return None

    def wanted(face):
        name = names[face.material_index]
        if name.startswith("OfficeTop"):
            return kind == "blazer" or side_of(face) is None
        # A scanned waistcoat replaces the shirt it covers: a blazer is cut over both.
        if kind == "blazer" and name.startswith(("OfficeOuter", "OfficeLining")):
            return True
        # Below an untucked top, a blazer continues over the trouser waist down to its hem.
        if kind == "blazer" and name.startswith(("OfficeBottom", "OfficeBelt")):
            centre = face.calc_center_median()
            return hem - 0.02 <= centre.z <= top_low + 0.005 and side_of(face) is None
        return False
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if not wanted(f)], context="FACES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    band = [v.co.y for v in bm.verts if shoulder - 0.25 < v.co.z < shoulder - 0.1 and abs(v.co.x) < 0.1]
    chest_y = sum(band) / max(1, len(band))
    front = lambda c: c.y < chest_y
    # Hem.
    bisect(bm, Vector((0, 0, hem)), Vector((0, 0, 1)))
    drop_faces(bm, lambda c: c.z < hem)
    # Neckline: lower in front than at the back collar.
    for z in (neck - 0.03, neck + 0.0):
        bisect(bm, Vector((0, 0, z)), Vector((0, 0, 1)))
    drop_faces(bm, lambda c: (c.z > neck - 0.03 and front(c)) or c.z > neck + 0.0)
    # Front V down to the top button.
    v_bottom, v_top, width = shoulder - spec["v_depth"], neck - 0.03, spec["v_width"]
    for sign in (1, -1):
        d = Vector((sign * width, 0, v_top - v_bottom)).normalized()
        bisect(bm, Vector((0, 0, v_bottom)), Vector((d.z, 0, -d.x)))
    drop_faces(bm, lambda c: front(c) and c.z > v_bottom and abs(c.x) < width * (c.z - v_bottom) / (v_top - v_bottom))
    if kind == "waistcoat":
        arm_x = abs(body.head["leftUpperArm"].x) - 0.004
        for sign in (1, -1):
            bisect(bm, Vector((sign * arm_x, 0, 0)), Vector((1, 0, 0)))
        drop_faces(bm, lambda c: abs(c.x) > arm_x)
    else:
        for side in SIDES:
            _, elbow, wrist = body.arm(side)
            axis = (wrist - elbow).normalized()
            stop = elbow + axis * ((wrist - elbow).length - spec["cuff_gap"])
            bisect(bm, stop, axis)
            drop_faces(bm, lambda c, stop=stop, axis=axis, elbow=elbow: (c.x < 0) == (elbow.x < 0) and (c - stop).dot(axis) > 0 and abs(c.x) > 0.1)
    bm.normal_update()
    # Lift off the garment below: torso panels, sleeves and hem with their own ease.
    sleeves = {}
    for v in bm.verts:
        sleeve = abs(v.co.x) > abs(body.head["leftUpperArm"].x) + 0.012 and v.co.z < shoulder - 0.02
        sleeves[v.index] = sleeve
        ease = spec["offset"] + (0.004 if v.co.z < top_low + 0.01 else 0.0) + (0.002 if sleeve else 0.0)
        v.co += v.normal * ease
    obj = mesh_object(f"Garment {kind}", bm, collection)
    obj.data.materials.append(mats["OfficeOuter"])
    obj.data.materials.append(mats["OfficeLining"])
    back = kind == "waistcoat"
    for poly, face in zip(obj.data.polygons, bm.faces):
        poly.material_index = 1 if back and face.calc_center_median().y > chest_y + 0.03 else 0
        poly.use_smooth = True
    bm.free()
    decimate(obj, spec["target_tris"])
    ensure_groups(obj, body.bone_names)
    tree, bm_base = surface(source)
    for index, vertex in enumerate(obj.data.vertices):
        point = vertex.co
        weights = base_weights_at(body, tree, bm_base, point)
        arm_share = sum(value for name, value in weights.items() if any(name.endswith(p) for p in ARM_PARTS))
        if kind == "waistcoat":
            weights = {name: value for name, value in weights.items() if not any(name.endswith(p) for p in ARM_PARTS)}
        else:
            # Sleeves move exactly like the sleeve below; torso panels lose the arm influence that
            # webs armpits, blending across the seam.
            sleeve = smoothstep(0.35, 0.75, arm_share)
            stripped = strip_arm_influence(body, weights, point)
            weights = {name: stripped.get(name, 0.0) * (1 - sleeve) + value * sleeve for name, value in weights.items()}
        # The hem sways with the hips rather than splitting with the thighs.
        weights = {name: value * (0.4 if "UpperLeg" in name else 1.0) for name, value in weights.items()}
        set_weights(obj, index, weights)
    bm_base.free()
    return obj


def add_buttons(bm, trees, body, mats, spec):
    shoulder = body.head["leftUpperArm"].z
    result = []
    for i in range(spec.get("buttons", 0)):
        hit = ray_front(trees, 0.0, shoulder - spec["v_depth"] - 0.012 - i * spec.get("button_pitch", 0.06))
        if hit:
            for v in oriented_box(bm, hit[0], hit[1], Vector((0, 0, 1)), (0.012, 0.012, 0.003), mats["button"]):
                result.append((v, {"chest": 0.5, "spine": 0.5}))
    return result


def zone_materials(spec, accent):
    """Working materials; `finalize_materials` renames them to the outfit convention."""
    mesh = spec["mesh"]
    return {
        "OfficeOuter": material(f"OfficeOuter_{mesh}", "#2b2f38", 0.72),
        "OfficeLining": material(f"OfficeLining_{mesh}", "#8a8c94", 0.4),
        "badge_plate": material(f"BadgeCard_{mesh}", "#f4f2ec", 0.45),
        "badge_accent": material(f"OfficeAccent_{mesh}Badge", accent, 0.5),
        "bowtie": material(f"OfficeAccent_{mesh}Bowtie", accent, 0.55),
        "scarf": material(f"OfficeAccent_{mesh}Scarf", accent, 0.6),
        "apron": material(f"Apron_{mesh}", "#1b1b1e", 0.85),
        "forearm": material(f"Skin_{mesh}Forearm", "#c79a82", 0.6),
        "cuff": material(f"OfficeTop_{mesh}Cuff", "#f2f0ea", 0.8),
        "button": material(f"OfficeTrim_{mesh}Button", "#c8a45e", 0.4, 0.6),
    }


TINTED = ("OfficeTop", "OfficeOuter", "OfficeAccent", "OfficeTrim", "OfficeBottom", "OfficeShoes", "OfficeLining")
FIXED = {"OfficeBelt": ("Belt", "#2b2420", 0.5), "BadgeCard": ("BadgeCard", "#f4f2ec", 0.45), "Apron": ("Apron", "#1b1b1e", 0.85)}


def role_of(name):
    name = base_name(name)
    for prefix in TINTED:
        if name.startswith(prefix):
            return prefix
    if name.startswith("Skin_"):
        return "Skin"
    for prefix, (label, _colour, _roughness) in FIXED.items():
        if name.startswith((prefix, label + "_")):
            return prefix
    raise ValueError(f"material without a tint role: {name}")


def finalize_materials(obj, pascal):
    """Same convention as the fitted garment outfits: `Office<Zone>_<Id>` / `Skin_<Id>` in plain white
    (tinted at runtime); belt, badge card and apron keep a fixed colour."""
    targets, mapping = {}, []
    for mat in obj.data.materials:
        role = role_of(mat.name)
        if role not in targets:
            if role in FIXED:
                label, colour, roughness = FIXED[role]
                targets[role] = material(f"{label}_{pascal}", colour, roughness)
            else:
                rough = 0.62 if role == "Skin" else 0.45 if role in ("OfficeShoes", "OfficeTrim") else 0.82
                targets[role] = material(f"{role}_{pascal}", "#ffffff", rough, 0.6 if role == "OfficeTrim" else 0.0)
            targets[role].use_backface_culling = role == "Skin"
        mapping.append(role)
    order = list(dict.fromkeys(mapping))
    slots = [order.index(role) for role in mapping]
    indices = [0] * len(obj.data.polygons)
    obj.data.polygons.foreach_get("material_index", indices)
    obj.data.materials.clear()
    for role in order:
        obj.data.materials.append(targets[role])
    obj.data.polygons.foreach_set("material_index", [slots[i] for i in indices])
    obj.data.update()


def tuck_feet(obj, body):
    """Port of the renderer's formal-outfit foot fit: closed pumps already contain the toes, so the
    scanned bare forefoot is tucked into the heel cup and the trouser cuff hugs the shoe."""
    mesh = obj.data
    roles = [""] * len(mesh.vertices)
    for poly in mesh.polygons:
        role = role_of(mesh.materials[poly.material_index].name)
        for index in poly.vertices:
            if role in ("OfficeShoes", "Skin", "OfficeBottom") and roles[index] in ("", "OfficeBottom"):
                roles[index] = role
    for side in SIDES:
        ankle = body.head[f"{side}Foot"]
        def on_side(co):
            return (co.x < 0) == (ankle.x < 0)
        shoes = [v.co for v, role in zip(mesh.vertices, roles) if role == "OfficeShoes" and on_side(v.co)]
        if len(shoes) < 3:
            continue
        sole = min(co.z for co in shoes)
        ring = [v.co for v, role in zip(mesh.vertices, roles) if role == "OfficeBottom" and on_side(v.co) and ankle.z + .12 <= v.co.z <= ankle.z + .18]
        cuff = None
        if len(ring) >= 6:
            xs, ys = sorted(co.x for co in ring), sorted(co.y for co in ring)
            q = lambda values, t: values[min(len(values) - 1, int(t * (len(values) - 1)))]
            cuff = (q(xs, .025) - .01, q(xs, .975) + .01, q(ys, .025) - .01, q(ys, .975) + .01)
        for v, role in zip(mesh.vertices, roles):
            if not on_side(v.co):
                continue
            co = v.co
            dz = co.z - ankle.z
            if role == "OfficeBottom" and cuff and co.z >= sole and dz < .13:
                strength = 1 - smoothstep(0, 1, (dz - .035) / .095)
                co.x += (max(cuff[0], min(cuff[1], co.x)) - co.x) * strength
                co.y += (max(cuff[2], min(cuff[3], co.y)) - co.y) * strength
            elif role == "Skin" and co.z > sole and dz < .08:
                strength = 1 - smoothstep(0, 1, (dz - .03) / .05)
                # The avatars face -Y: forward is -Y here (+Z in the renderer).
                excess = max(0.0, (ankle.y - co.y) - .025)
                tucked = .12 * excess + .88 * .005 * -math.expm1(-excess / .005)
                co.y -= (tucked - excess) * strength
                lateral = co.x - ankle.x
                excess_x = max(0.0, abs(lateral) - .026)
                tucked_x = .12 * excess_x + .88 * .003 * -math.expm1(-excess_x / .003)
                co.x += math.copysign(1, lateral) * (tucked_x - excess_x) * strength
    mesh.update()


GENERATED = ("badge_plate", "badge_accent", "bowtie", "scarf", "apron", "forearm", "cuff", "button")


def build(spec, catalog, collection):
    body = Body(BODIES / spec["body"], collection)
    keep = tuple(spec["keep_base"])
    # The base garment: a copy of the body's own outfit, minus the zones the uniform replaces.
    base = body.base.copy()
    base.data = body.base.data.copy()
    base.name = spec["mesh"]
    for modifier in list(base.modifiers):
        base.modifiers.remove(modifier)
    collection.objects.link(base)
    base.hide_viewport = base.hide_render = False
    keep_index = {i for i, mat in enumerate(base.data.materials) if base_name(mat.name).startswith(keep)}
    bm = bmesh.new()
    bm.from_mesh(base.data)
    bmesh.ops.delete(bm, geom=[face for face in bm.faces if face.material_index not in keep_index], context="FACES")
    # A zone can be worn as another (the waistcoat's tie reads as the shirt placket under a bow tie).
    for source_zone, target_zone in spec.get("retint", {}).items():
        target = next(i for i, mat in enumerate(base.data.materials) if base_name(mat.name).startswith(target_zone))
        for face in bm.faces:
            if base_name(base.data.materials[face.material_index].name).startswith(source_zone):
                face.material_index = target
    bm.to_mesh(base.data)
    bm.free()
    mats = zone_materials(spec, catalog["brand_accent"])
    shells = [shell_from_base(body, layer, collection, mats) for layer in spec.get("layers", [])]
    # Remove base faces a shell covers (they would only poke through); trousers, shoes and skin stay.
    if shells:
        trees = []
        for shell in shells:
            tree, shell_bm = surface(shell)
            trees.append(tree)
            shell_bm.free()
        bm = bmesh.new()
        bm.from_mesh(base.data)
        bm.normal_update()
        covered = {v.index for v in bm.verts if any(tree.ray_cast(v.co + v.normal * 0.0005, v.normal, 0.03)[0] is not None for tree in trees)}
        doomed = [face for face in bm.faces if all(v.index in covered for v in face.verts)
                  and not base_name(base.data.materials[face.material_index].name).startswith(("OfficeBottom", "OfficeShoes", "Skin_", "OfficeBelt"))]
        bmesh.ops.delete(bm, geom=doomed, context="FACES")
        bm.to_mesh(base.data)
        bm.free()
    tuck_feet(base, body)
    decimate(base, spec["base_tris"])
    for key in GENERATED:
        if mats[key].name not in [m.name for m in base.data.materials]:
            base.data.materials.append(mats[key])
    index = {mat.name: i for i, mat in enumerate(base.data.materials)}
    slot = {key: index[mats[key].name] for key in GENERATED}
    outer_trees, temporary = [], []
    for obj in [*shells, base]:
        tree, tree_bm = surface(obj)
        outer_trees.append(tree)
        temporary.append(tree_bm)
    bm = bmesh.new()
    bm.from_mesh(base.data)
    weighted = []
    extras = spec.get("extras", [])
    top_slots = {i for i, mat in enumerate(base.data.materials) if base_name(mat.name).startswith("OfficeTop") and mat != mats["cuff"]}
    if "rolled-sleeves" in extras:
        weighted += roll_sleeves(bm, body, slot, top_slots)
    for layer in spec.get("layers", []):
        weighted += add_buttons(bm, outer_trees, body, slot, layer)
    if "badge" in extras:
        weighted += add_badge(bm, outer_trees, body, slot)
    if "bowtie" in extras:
        weighted += add_bowtie(bm, outer_trees, body, slot)
    if "scarf" in extras:
        weighted += add_scarf(bm, outer_trees, body, slot)
    if "apron" in extras:
        legs, legs_bm = surface(base, lambda face: base_name(base.data.materials[face.material_index].name).startswith(("OfficeBottom", "OfficeBelt", "OfficeOuter", "OfficeLining")))
        weighted += add_apron(bm, [legs], body, slot, body.head["hips"].z + 0.01, body.head["leftLowerLeg"].z - 0.17)
        temporary.append(legs_bm)
    for tree_bm in temporary:
        tree_bm.free()
    deform = bm.verts.layers.deform.verify()
    names = [group.name for group in base.vertex_groups]
    for vertex, weights in weighted:
        total = sum(weights.values())
        vertex[deform].clear()
        for name, value in sorted(weights.items(), key=lambda item: -item[1])[:4]:
            if value > 1e-4:
                vertex[deform][names.index(name)] = value / total
    for face in bm.faces:
        face.smooth = True
    bm.to_mesh(base.data)
    bm.free()
    # Join the shells into the base and bind everything to the rig.
    for shell in shells:
        ensure_groups(shell, names)
    if shells:
        with bpy.context.temp_override(active_object=base, object=base, selected_objects=[base, *shells], selected_editable_objects=[base, *shells]):
            bpy.ops.object.join()
    # Drop material slots nothing uses (generated parts this uniform does not wear).
    used = {poly.material_index for poly in base.data.polygons}
    for i in reversed(range(len(base.data.materials))):
        if i not in used:
            base.data.materials.pop(index=i)
    pascal = "".join(part.capitalize() for part in spec["id"].split("-"))
    finalize_materials(base, pascal)
    base.name = base.data.name = "Outfit"
    for layer in list(base.data.uv_layers):
        base.data.uv_layers.remove(layer)
    base.parent = body.rig
    base.matrix_parent_inverse = body.rig.matrix_world.inverted()
    modifier = base.modifiers.new("Armature", "ARMATURE")
    modifier.object = body.rig
    return body, base


def export(spec, body, outfit):
    OUTPUT.mkdir(parents=True, exist_ok=True)
    directory = OUTPUT / spec["group"]
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{spec['id']}.glb"
    for pose_bone in body.rig.pose.bones:
        pose_bone.matrix_basis = Matrix.Identity(4)
    for obj in bpy.context.view_layer.objects:
        obj.select_set(False)
    body.rig.select_set(True)
    outfit.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=str(path), export_format="GLB", use_selection=True, export_yup=True,
        export_texcoords=False, export_normals=True, export_materials="EXPORT", export_cameras=False,
        export_lights=False, export_animations=False, export_skins=True, export_morph=False,
        export_vertex_color="NONE", export_attributes=False, export_tangents=False, export_extras=False,
        export_def_bones=False, export_rest_position_armature=True,
        export_copyright="Staff uniform derived from the RenderHub avatar outfit (Extended Use License); not MIT-licensed. See THIRD_PARTY_NOTICES.md.")
    data = path.read_bytes()
    length = struct.unpack_from("<I", data, 12)[0]
    document = json.loads(data[20:20 + length])
    for key in ("images", "textures", "samplers", "animations"):
        if document.get(key):
            raise ValueError(f"unexpected {key} in staff uniform export")
    for mat in document.get("materials", []):
        mat["doubleSided"] = not mat["name"].startswith("Skin_")
        mat.pop("extras", None)
    for group in ("meshes", "nodes", "scenes"):
        for item in document.get(group, []):
            item.pop("extras", None)
    document["scenes"][0]["name"] = "Extalia staff uniform"
    encoded = json.dumps(document, ensure_ascii=True, separators=(",", ":")).encode()
    encoded += b" " * (-len(encoded) % 4)
    tail = data[20 + length:]
    data = struct.pack("<IIIII", 0x46546C67, 2, 20 + len(encoded) + len(tail), len(encoded), 0x4E4F534A) + encoded + tail
    path.write_bytes(data)
    tris = sum(len(poly.vertices) - 2 for poly in outfit.data.polygons)
    zones = sorted({re.sub(r"_.*$", "", base_name(mat.name)) for mat in outfit.data.materials})
    return {"path": f"avatars/outfits/{spec['group']}/{spec['id']}.glb", "id": spec["id"], "group": spec["group"],
            "role": spec["role"], "triangles": tris, "bytes": len(data), "zones": zones,
            "license": "LicenseRef-RenderHub-Extended-Use"}


# ── review renders (local only) ──

PREVIEW = {"OfficeTop": "#f2f0ea", "OfficeOuter": "#2b2f38", "OfficeAccent": "#10b9ac", "OfficeBottom": "#24262b",
           "OfficeShoes": "#1c1714", "OfficeLining": "#8a8c94", "OfficeTrim": "#c8a45e", "Skin": "#c79a82"}
POSES = {
    "rest": {},
    # Standing at the reception desk: both forearms forward onto the counter.
    "desk": {"leftUpperArm": -0.55, "rightUpperArm": -0.55, "leftLowerArm": -1.0, "rightLowerArm": -1.0},
    # Bartending reach: one arm up to the back shelf, the other forward.
    "reach": {"rightUpperArm": -2.3, "rightLowerArm": -0.3, "leftUpperArm": -0.9, "leftLowerArm": -0.9},
    # Mid-stride.
    "walk": {"leftUpperLeg": -0.45, "leftLowerLeg": 0.35, "rightUpperLeg": 0.35, "rightLowerLeg": 0.25,
             "leftUpperArm": 0.3, "rightUpperArm": -0.3, "leftLowerArm": -0.25, "rightLowerArm": -0.35},
    # Seated (apron and jacket hems over the lap).
    "sit": {"leftUpperLeg": -1.5, "rightUpperLeg": -1.5, "leftLowerLeg": 1.5, "rightLowerLeg": 1.5,
            "leftUpperArm": -0.35, "rightUpperArm": -0.35, "leftLowerArm": -0.9, "rightLowerArm": -0.9},
}


def linear(hex_colour):
    values = [int(hex_colour[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return tuple(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in values) + (1.0,)


def pose(rig, angles):
    """Rotate bones about the world X axis (negative = forward, the avatars face -Y)."""
    for bone in rig.pose.bones:
        bone.matrix_basis = Matrix.Identity(4)
        angle = angles.get(bone.name)
        if angle:
            rest = bone.bone.matrix_local.to_3x3()
            local = rest.inverted() @ Matrix.Rotation(angle, 3, "X") @ rest
            bone.matrix_basis = local.to_4x4()
    bpy.context.view_layer.update()


def review(body, outfit, directory, key):
    directory.mkdir(parents=True, exist_ok=True)
    scene = bpy.context.scene
    for mat in outfit.data.materials:
        role = role_of(mat.name)
        if role in PREVIEW:
            mat.diffuse_color = linear(PREVIEW[role])
    for obj in body.objects:
        if obj.type == "MESH" and base_name(obj.name) in ("Body", "EyesDetail", "Eyebrows", "BodyNeckline"):
            obj.hide_viewport = obj.hide_render = False
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "MATERIAL"
    scene.render.resolution_x, scene.render.resolution_y = 360, 560
    scene.render.film_transparent = False
    camera = bpy.data.objects.get("Review camera") or bpy.data.objects.new("Review camera", bpy.data.cameras.new("Review camera"))
    if camera.name not in scene.objects:
        scene.collection.objects.link(camera)
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = 2.0
    scene.camera = camera
    views = {"front": (0, -4, 0.95), "back": (0, 4, 0.95), "side": (4, 0, 0.95), "three": (2.6, -2.8, 1.3)}
    for name, angles in POSES.items():
        pose(body.rig, angles)
        for view, location in views.items():
            if name != "rest" and view == "back":
                continue
            camera.location = location
            direction = Vector((0, 0, 0.95)) - Vector(location)
            camera.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
            scene.render.filepath = str(directory / f"{key}-{name}-{view}.png")
            bpy.ops.render.render(write_still=True)
    pose(body.rig, {})


def main(argv, live=False):
    args = parse_args(argv)
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    if live:
        # Build into the review scene; the window returns to whatever scene was open.
        scene = bpy.data.scenes.get("Extalia Uniforms") or bpy.data.scenes.new("Extalia Uniforms")
        window = bpy.context.window
        previous = window.scene
        window.scene = scene
        try:
            return run(args, catalog, scene, live)
        finally:
            if args.get("stay") is None:
                window.scene = previous
    else:
        scene = bpy.context.scene
        for obj in list(scene.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
    return run(args, catalog, scene, live)


def run(args, catalog, scene, live):
    manifest = {"schema": "extalia.staff-uniforms-manifest.v1", "exporter": EXPORTER, "uniforms": []}
    if MANIFEST.exists():
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    built = []
    for spec in catalog["uniforms"]:
        key = f"{spec['id']}/{spec['group']}"
        if args["only"] and key not in args["only"].split(","):
            continue
        before = datablocks()
        collection = bpy.data.collections.new(f"Uniform {key}")
        scene.collection.children.link(collection)
        body, outfit = build(spec, catalog, collection)
        if live:
            body.rig.location.x = args["x"] + 1.1 * len(built)
            pose(body.rig, POSES.get(args.get("pose") or "rest", {}))
            # Preview the runtime tint (the export stays white).
            for mat in outfit.data.materials:
                role = role_of(mat.name)
                if role in PREVIEW:
                    mat.diffuse_color = linear(PREVIEW[role])
                    next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED").inputs["Base Color"].default_value = linear(PREVIEW[role])
            for obj in body.objects:
                if obj.type == "MESH" and base_name(obj.name) in ("Body", "EyesDetail", "Eyebrows", "BodyNeckline"):
                    obj.hide_viewport = obj.hide_render = False
            built.append((key, outfit.name, sum(len(p.vertices) - 2 for p in outfit.data.polygons)))
            continue
        entry = export(spec, body, outfit)
        if args["review"]:
            review(body, outfit, args["review"], key.replace("/", "-"))
        manifest["uniforms"] = [item for item in manifest["uniforms"] if item["path"] != entry["path"]] + [entry]
        manifest["uniforms"].sort(key=lambda item: item["path"])
        built.append((key, entry["triangles"], entry["bytes"]))
        for obj in list(collection.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.collections.remove(collection)
        purge_orphans(before)
    if not live:
        MANIFEST.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print("staff uniforms:", built)
    return built


if __name__ == "__main__":
    main(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
elif __name__ == "__live__":
    main(LIVE_ARGS, live=True)  # noqa: F821 - provided by the live exec globals
