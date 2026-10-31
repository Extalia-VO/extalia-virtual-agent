"""Derive lightweight, debadged campus cars from reference models in Blender.

Run headless:
    Blender --background --factory-startup --python tooling/blender/prepare-campus-vehicles.py -- \
        --source-dir <folder with the car archives> [--output <dir>] [--only ev-sedan,van] [--work-dir <empty dir>]

Cars are listed in ``campus-vehicles.json`` (style, category, archive name,
preferred source file inside the archive, real length, forward axis, licence,
notice key, optional role rules and lamp boxes). Each archive is found by name
anywhere under ``--source-dir``; only the preferred model file (plus glTF
buffers) is extracted, into a fresh scratch folder. Missing archives are
skipped with a message. Archives, textures and the original high-detail meshes
stay local; only the simplified exports in ``apps/web/local-assets/vehicles``
are reviewed and published by ``prepare-public-models.py``. No script from a
source archive is ever executed: ``.blend`` sources are appended data-only
under --factory-startup. See README.md (How to add a new car).

Pipeline per car (all coordinates in Blender Z-up, metres):
  1. Import into an empty collection; ignore cameras, lights, empties and helpers.
  2. Classify every source face into a material role, first by per-car object
     (or `parent`) rules, then shared interior/badge/name rules, then per-car material rules,
     then shared material-name rules and finally the material colour. Roles:
     paint, glass, trim, rubber, alloy, lamp (split head/tail by position),
     plate and drop. Interior parts (seats, dashboard, steering, pedals, door
     cards, headliner, engine bay, suspension, brakes) and badges, logos,
     lettering and number-plate text are dropped by name. With
     ``colourFrom: "texture"`` textured faces are instead classified from
     their sampled base-colour/emission texels after step 3 (``texture_roles``);
     a ``texture`` rule does the same for single atlas materials. Heavy sources
     (``predecimate``) are first collapse-decimated per part (stage one), and
     ``source_box`` keeps one car when the source scene holds several or props.
  3. Normalise: forward to Blender -Y (app +Z), uniform scale to the published
     real-world length, centred on X/Y, wheels on z=0. Loose badge parts inside
     ``emblems`` boxes are removed; positional ``role_boxes`` (grille emblems, merged
     tyres, loose cargo) and ``caps`` (a roof the source left open) apply here.
  4. Replace wheels by 16-sided tyres with a flat alloy disc; the detected
     source tyres, rims, discs and callipers inside each wheel volume go.
  5. Visibility cull: a face survives only if a ray from it escapes the car in
     some direction at or above 11 degrees below the horizon. Interior that
     the name rules missed, enclosed engine bays and hidden inner panels go.
  6. Remove small isolated islands (< 15 cm, not lamps): emblems, letters,
     clips and badges that did not carry a recognisable name.
  7. Weld panel seams, dissolve flat regions, X-symmetric collapse to the body
     budget, drop decimation spikes; shade smooth by angle (38 degrees) and bake
     area-weighted custom normals so rounded panels read smooth.
     ``side_caps`` then add upright panels behind the side glass.
  8. Build `mobility-<style>`: one mesh per role with fresh role materials
     (light neutral paint so runtime instance tones show; lamp materials match
     /Mobility lamp/i), no UVs, textures, source names or source extras.
"""
import argparse
import colorsys
import fcntl
import json
import math
import os
import re
import struct
import sys
import tempfile
import zipfile

import bmesh
import bpy
import numpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

BODY_TRIANGLES = 5600  # per car body; the instanced wheel template comes on top
SMOOTH_ANGLE = 38  # degrees; sharper creases keep split normals
# Per-file budget for a parked or passing car; a catalog entry may raise it only for a
# traffic-only vehicle (`placement: "traffic-only"`, e.g. the long rigid truck).
MAX_TRIANGLES, MAX_BYTES = 6600, 350_000
# Very heavy sources (600k-2.3M triangles) opt in with `predecimate: <faces>`: each larger
# part is collapse-decimated towards that total before merging, so later passes stay fast and
# memory-bounded. Entries without it keep their single-stage (byte-identical) output.

ROLES = ['paint', 'glass', 'trim', 'rubber', 'alloy', 'lamp_head', 'lamp_tail', 'plate', 'lamp', 'drop']
R = {name: index for index, name in enumerate(ROLES)}
ROLE_MATERIALS = {
    # name, linear base colour, metallic, roughness
    'paint': ('Mobility paint', (.70, .72, .74), .35, .38),
    'glass': ('Mobility glass', (.018, .028, .036), .3, .12),
    'trim': ('Mobility trim', (.026, .03, .033), .1, .7),
    'rubber': ('Mobility rubber', (.012, .013, .014), 0, .9),
    'alloy': ('Mobility alloy', (.36, .39, .41), .8, .32),
    'lamp_head': ('Mobility lamp head', (1, .86, .62), .1, .25),
    'lamp_tail': ('Mobility lamp tail', (.72, .03, .02), .1, .3),
    'plate': ('Mobility plate', (.58, .6, .58), 0, .6),
}
OBJECT_NAMES = {
    'paint': 'Car body', 'glass': 'Car glazing', 'trim': 'Car trim', 'rubber': 'Car tyres',
    'alloy': 'Car wheel discs', 'lamp_head': 'Car headlamps', 'lamp_tail': 'Car tail lamps', 'plate': 'Car plates',
}

# Shared name rules (case-insensitive). Object rules see the object name and
# material rules the material name.
INTERIOR = (r'interior|seat|dash|steer|volant|vol_|pedal|carpet|alcantara|stitch|belt|speaker|gauge|'
            r'cockpit|console|gear|knob|headliner|door_?card|door_interior|engine|shock|spring|suspens|'
            r'muffler|exhaust_inner|brake|break_disc|caliper|calliper|rotor|disk|screw|bolt|(?:^|_)int_')
BADGE = r'logo|badge|emblem|decal|lettering|\btext\b|sticker|plate_text|brand'
GENERIC_OBJECT_RULES = [(INTERIOR, 'drop'), (BADGE, 'drop')]
GENERIC_MATERIAL_RULES = [
    (INTERIOR, 'drop'), (BADGE, 'drop'),
    (r'glass|window|windscreen|windshield|skl', 'glass'),
    (r'tyre|tire|rubber|gum', 'rubber'),
    (r'rim|wheel|alloy|chrome|alu', 'alloy'),
    (r'light|lamp|emissi', 'lamp'),
    (r'paint|carpaint|body|lak', 'paint'),
    (r'plate', 'plate'),
    (r'black|plastic|matte|grille|grill|carbon|trim', 'trim'),
]

CATALOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'campus-vehicles.json')


def load_catalog(path=CATALOG):
    """Catalog entries keyed by runtime model name (`mobility-<style>`).

    Real-world lengths come from published manufacturer dimensions; the source
    proportions are kept, only the scale is normalised. Rules are
    [kind, regex, role] triples (see the module docstring).
    """
    with open(path, encoding='utf-8') as file:
        document = json.load(file)
    if document.get('schemaVersion') != 1:
        raise ValueError('Unsupported campus vehicle catalog')
    cars = {}
    for entry in document['vehicles']:
        if not re.fullmatch(r'[a-z][a-z0-9-]*', entry['style']) or entry['category'] not in ('ev', 'conventional'):
            raise ValueError('Invalid catalog style or category: %r' % entry.get('style'))
        if entry['notice'] not in document['notices']:
            raise ValueError('Unknown notice key for ' + entry['style'])
        if entry.get('colourFrom', 'materials') not in ('materials', 'texture'):
            raise ValueError('Unknown colourFrom for ' + entry['style'])
        if entry.get('placement', 'any') not in ('any', 'traffic-only'):
            raise ValueError('Unknown placement for ' + entry['style'])
        if (entry.get('max_triangles', MAX_TRIANGLES) > MAX_TRIANGLES or entry.get('max_bytes', MAX_BYTES) > MAX_BYTES) \
                and entry.get('placement') != 'traffic-only':
            raise ValueError('Only a traffic-only vehicle may exceed the car budget: ' + entry['style'])
        car = dict(entry)
        car['rules'] = [tuple(rule) for rule in entry.get('rules', [])]
        if any(rule[0] not in ('object', 'parent', 'material') or rule[2] not in ROLES + ['texture'] for rule in car['rules']):
            raise ValueError('Unknown rule kind or role for ' + entry['style'])
        if any(box[0] not in ROLES for box in entry.get('role_boxes', []) + entry.get('caps', [])):
            raise ValueError('Unknown role box role for ' + entry['style'])
        car['texture_roles'] = [tuple(box) for box in entry.get('texture_roles', [])]
        if any(box[0] not in ROLES for box in car['texture_roles']):
            raise ValueError('Unknown texture role for ' + entry['style'])
        for key in ('head_boxes', 'tail_boxes', 'paint_boxes', 'emblems'):
            car[key] = [tuple(box) for box in entry.get(key, [])]
        if any(len(box) != 6 for box in car['emblems']):
            raise ValueError('An emblem box has six values: ' + entry['style'])
        if any(len(box) != 6 or box[0] not in ROLES for box in entry.get('side_caps', [])):
            raise ValueError('A side cap is [role, |x|, from front min, max, z min, z max]: ' + entry['style'])
        cars['mobility-' + entry['style']] = car
    return cars


CARS = load_catalog()


def find_archive(source_dir, name):
    for folder, _directories, files in sorted(os.walk(source_dir)):
        if name in files:
            return os.path.join(folder, name)
    return None


def extract_source(car, source_dir, work_dir):
    """Copy only the preferred model file (plus glTF buffers) out of the archive.

    Archives are untrusted: members are matched by exact name, written under a
    fresh per-car folder by base name, and nothing from them is executed.
    Returns the extracted model path, or None when the archive is missing.
    """
    archive = find_archive(source_dir, car['archive'])
    if archive is None:
        return None
    target = os.path.join(work_dir, car['style'])
    os.makedirs(target, exist_ok=True)
    if not zipfile.is_zipfile(archive):
        # A single self-contained download (`archive` and `source` name the same .glb file).
        if car['source'] != car['archive'] or not car['source'].lower().endswith(('.glb', '.fbx', '.blend')):
            raise ValueError('%s: a loose source must be one .glb, .fbx or .blend named as both archive and source' % car['style'])
        path = os.path.join(target, os.path.basename(car['source']))
        with open(archive, 'rb') as source, open(path, 'wb') as out:
            out.write(source.read())
        return path
    with zipfile.ZipFile(archive) as bundle:
        names = [n for n in bundle.namelist() if not n.startswith('__MACOSX/') and not n.endswith('/')]
        member = car['source'] if car['source'] in names else next(
            (n for n in names if os.path.basename(n).lower() == os.path.basename(car['source']).lower()), None)
        if member is None:
            raise FileNotFoundError('%s: %s not found in %s' % (car['style'], car['source'], car['archive']))
        wanted = [member]
        if member.lower().endswith('.gltf'):
            document = json.loads(bundle.read(member))
            folder = os.path.dirname(member)
            wanted += [os.path.join(folder, b['uri']) if folder else b['uri'] for b in document.get('buffers', []) if 'uri' in b]
        for name in wanted:
            if '..' in name.split('/') or name.startswith('/'):
                raise ValueError('Unsafe archive member ' + name)
            with open(os.path.join(target, os.path.basename(name)), 'wb') as out:
                out.write(bundle.read(name))
    return os.path.join(target, os.path.basename(member))


def log(message):
    print('CAMPUS_VEHICLES ' + message, flush=True)


def role_materials():
    materials = {}
    for role, (name, rgb, metallic, roughness) in ROLE_MATERIALS.items():
        material = bpy.data.materials.get(name) or bpy.data.materials.new(name)
        material.diffuse_color = (*rgb, 1)
        material.use_nodes = True
        principled = next(n for n in material.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
        principled.inputs['Base Color'].default_value = (*rgb, 1)
        principled.inputs['Metallic'].default_value = metallic
        principled.inputs['Roughness'].default_value = roughness
        for key in list(material.keys()):
            del material[key]
        materials[role] = material
    return materials


def import_source(path, collection):
    """Import into ``collection`` only and return the new objects."""
    before = set(bpy.data.objects)
    extension = os.path.splitext(path)[1].lower()
    if extension in ('.glb', '.gltf'):
        bpy.ops.import_scene.gltf(filepath=path, import_shading='NORMALS', loglevel=50)
    elif extension == '.fbx':
        bpy.ops.import_scene.fbx(filepath=path, use_image_search=False, use_custom_props=False)
    elif extension == '.blend':
        with bpy.data.libraries.load(path, link=False) as (source, target):
            target.objects = list(source.objects)
        for obj in target.objects:
            if obj is not None:
                collection.objects.link(obj)
    else:
        raise ValueError('Unsupported source format ' + extension)
    created = [obj for obj in bpy.data.objects if obj not in before]
    for obj in created:
        for owner in list(obj.users_collection):
            if owner != collection:
                owner.objects.unlink(obj)
        if collection not in obj.users_collection:
            collection.objects.link(obj)
    return created


def first(rules, kind, name):
    for rule_kind, pattern, role in rules:
        if rule_kind == kind and re.search(pattern, name or '', re.I):
            return role
    return None


def generic(rules, name):
    for pattern, role in rules:
        if re.search(pattern, name or '', re.I):
            return role
    return None


def material_colour(material):
    if material is None:
        return (.5, .5, .5), 1.0
    colour, alpha = tuple(material.diffuse_color[:3]), material.diffuse_color[3]
    if material.node_tree:
        principled = next((n for n in material.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
        if principled:
            colour = tuple(principled.inputs['Base Color'].default_value[:3])
            alpha = principled.inputs['Alpha'].default_value
            if principled.inputs['Transmission Weight'].default_value > .5:
                alpha = 0
    return colour, alpha


def colour_role(material):
    (r, g, b), alpha = material_colour(material)
    if alpha < .6:
        return 'glass'
    high, low = max(r, g, b), min(r, g, b)
    if high > .25 and r > 2 * g and r > 2 * b:
        return 'lamp'
    if high < .12:
        return 'trim'
    if high - low < .08 and high < .5:
        return 'alloy'
    return 'paint'


def object_rule(obj, car):
    """Per-car object rule for the object itself, then `parent` rules for any ancestor."""
    role = first(car['rules'], 'object', obj.name)
    parent = obj.parent
    while role is None and parent is not None:
        role, parent = first(car['rules'], 'parent', parent.name), parent.parent
    return role


def classify(obj, material, car):
    name = obj.name
    material_name = material.name if material else ''
    return (object_rule(obj, car) or generic(GENERIC_OBJECT_RULES, name)
            or first(car['rules'], 'material', material_name) or generic(GENERIC_MATERIAL_RULES, material_name)
            or colour_role(material))


TEXTURE_LAYERS = ('texture_r', 'texture_g', 'texture_b', 'texture_emission')


def texture_pixels(material, socket):
    """(height, width, channels) pixels of the image feeding a Principled input, or None."""
    if material is None or not material.node_tree:
        return None
    principled = next((n for n in material.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if principled is None or not principled.inputs[socket].links:
        return None
    node = principled.inputs[socket].links[0].from_node
    # glTF vertex-colour tints arrive as a Mix node in front of the image: follow it upstream.
    queue = [node]
    for _ in range(8):
        if not queue or queue[0].type == 'TEX_IMAGE':
            break
        current = queue.pop(0)
        queue += [link.from_node for socket_in in current.inputs for link in socket_in.links]
    node = queue[0] if queue else node
    if node.type != 'TEX_IMAGE' or node.image is None or not node.image.size[0]:
        return None
    width, height = node.image.size
    channels = node.image.channels
    pixels = numpy.empty(width * height * channels, numpy.float32)
    node.image.pixels.foreach_get(pixels)
    return pixels.reshape(height, width, channels)


def sample_face(face, uv_layer, pixels):
    """Median texel (stored, i.e. sRGB-encoded, values) over the UV centroid and four inner points.

    The median ignores a sample that lands across a painted seam (window frame,
    shut-line) so a face takes the colour of most of its area.
    """
    uvs = [loop[uv_layer].uv.copy() for loop in face.loops]
    centre = sum(uvs, Vector((0, 0))) / len(uvs)
    height, width = pixels.shape[:2]
    samples = []
    for point in [centre] + [centre.lerp(uv, .5) for uv in uvs[:4]]:
        x = min(width - 1, int((point.x % 1) * width))
        y = min(height - 1, int((point.y % 1) * height))
        samples.append(pixels[y, x, :3])
    return numpy.median(numpy.array(samples), axis=0)


def combine(objects, car):
    """Flatten every evaluated source mesh into one role-indexed bmesh.

    With ``colourFrom: "texture"`` the faces of textured materials keep their
    sampled base colour and emission in face layers; ``texture_roles`` assigns
    their roles once the car is normalised.
    """
    combined = bmesh.new()
    counts = {}
    textured = car.get('colourFrom') == 'texture'
    sampled = textured or any(rule[2] == 'texture' for rule in car['rules'])
    layers = [combined.faces.layers.float.new(name) for name in TEXTURE_LAYERS] if sampled else []
    meshes = []
    for obj in sorted(objects, key=lambda o: o.name):
        if obj.type != 'MESH' or obj.hide_render:
            continue
        if 'drop_below' in car and max((obj.matrix_world @ Vector(c)).z for c in obj.bound_box) < car['drop_below']:
            continue
        if 'source_box' in car:
            # Keep only the parts of one car when the source scene holds several (or props).
            centre = sum((obj.matrix_world @ Vector(c) for c in obj.bound_box), Vector()) / 8
            x0, x1, y0, y1, z0, z1 = car['source_box']
            if not (x0 <= centre.x <= x1 and y0 <= centre.y <= y1 and z0 <= centre.z <= z1):
                continue
        meshes.append(obj)
    total = sum(len(obj.data.polygons) for obj in meshes)
    budget = car.get('predecimate')
    if budget and total > budget:
        # Stage one for very heavy sources: collapse each larger part towards a shared ratio
        # before evaluation, so the merged mesh stays small (UVs survive for texture sampling).
        for obj in meshes:
            if len(obj.data.polygons) > 2000:
                modifier = obj.modifiers.new('Stage one', 'DECIMATE')
                modifier.decimate_type = 'COLLAPSE'
                modifier.ratio = budget / total
        log('pre-decimated %d source faces to about %d' % (total, budget))
    depsgraph = bpy.context.evaluated_depsgraph_get()
    for obj in meshes:
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        try:
            if not mesh.polygons:
                continue
            slots = [classify(obj, slot.material, car) for slot in obj.material_slots] or [classify(obj, None, car)]
            textures = [(texture_pixels(slot.material, 'Base Color'), texture_pixels(slot.material, 'Emission Color'))
                        if (textured and object_rule(obj, car) is None) or slots[index] == 'texture' else (None, None)
                        for index, slot in enumerate(obj.material_slots)]
            # A `texture` rule on an untextured material falls back to its plain colour.
            slots = [colour_role(obj.material_slots[index].material) if role == 'texture' and index < len(textures) and textures[index][0] is None else role
                     for index, role in enumerate(slots)]
            mesh.transform(obj.matrix_world)
            if obj.matrix_world.determinant() < 0:
                mesh.flip_normals()
            start = len(combined.faces)
            combined.from_mesh(mesh)
            combined.faces.ensure_lookup_table()
            uv_layer = combined.loops.layers.uv.get(mesh.uv_layers.active.name) if mesh.uv_layers.active else None
            for face in combined.faces[start:]:
                slot = min(face.material_index, len(slots) - 1)
                role = slots[slot]
                base, emission = textures[slot] if slot < len(textures) else (None, None)
                for layer in layers:
                    face[layer] = -1
                if base is not None and uv_layer is not None and role != 'drop':
                    rgb = sample_face(face, uv_layer, base)
                    for layer, value in zip(layers, rgb):
                        face[layer] = float(value)
                    face[layers[3]] = float(max(sample_face(face, uv_layer, emission))) if emission is not None else 0.0
                    role = 'texture'
                face.material_index = R[role] if role != 'texture' else R['paint']
                counts[role] = counts.get(role, 0) + 1
        finally:
            evaluated.to_mesh_clear()
    bmesh.ops.delete(combined, geom=[f for f in combined.faces if f.material_index == R['drop']], context='FACES')
    loose = [v for v in combined.verts if not v.link_faces]
    bmesh.ops.delete(combined, geom=loose, context='VERTS')
    log('classified ' + json.dumps({k: counts[k] for k in sorted(counts)}))
    return combined


def normalise(bm, car):
    forward = {'+Y': Vector((0, 1, 0)), '-Y': Vector((0, -1, 0)), '+X': Vector((1, 0, 0)), '-X': Vector((-1, 0, 0))}[car['forward']]
    # Yaw only: the source front turns to Blender -Y (app +Z), up stays +Z.
    rotation = Matrix.Rotation(math.atan2(-1, 0) - math.atan2(forward.y, forward.x), 4, 'Z')
    bmesh.ops.transform(bm, matrix=rotation, verts=bm.verts)
    lo, hi = bounds(bm.verts)
    scale = car['length'] / (hi.y - lo.y)
    centre = (lo + hi) / 2
    matrix = Matrix.Scale(scale, 4) @ Matrix.Translation((-centre.x, -centre.y, -lo.z))
    bmesh.ops.transform(bm, matrix=matrix, verts=bm.verts)


def bounds(verts):
    xs, ys, zs = zip(*(v.co for v in verts))
    return Vector((min(xs), min(ys), min(zs))), Vector((max(xs), max(ys), max(zs)))


def paint_key(h, s, v):
    """Colour family for the paint vote: a hue twelfth for coloured panels, or 'light' neutral."""
    if s >= .3 and v >= .12:
        return int(h * 12 + .5) % 12
    if s < .18 and v >= .55:
        return 'light'
    return None


def same_family(a, b):
    if a == 'light' or b == 'light' or a is None or b is None:
        return a == b
    return min((a - b) % 12, (b - a) % 12) <= 1


def texture_roles(bm, car):
    """Assign roles to texture-coloured faces (``colourFrom: "texture"``) after normalising.

    Colour clusters plus position heuristics (front -Y, rear +Y, wheels on z=0):
      - emission texels -> lamp (head/tail split by position later);
      - paint: the colour family covering the most upper-body area;
      - glass: dark/bluish neutral above the belt line; below it -> trim;
      - round loose parts in the lower outer quadrants -> rubber (detected tyres);
      - light neutral: lamps at the front/rear extremes, plate at the centre, else alloy;
      - red at the rear extreme (rear-facing, at lamp height) -> tail lamp;
      - other dark or saturated colours -> trim; mid grey -> alloy.
    Catalog ``texture_roles`` ([role, |x| min, |x| max, from front min, max, z min, z max])
    override the result inside a box. The colour layers are removed afterwards.
    """
    layers = [bm.faces.layers.float.get(name) for name in TEXTURE_LAYERS]
    if layers[0] is None:
        return {}
    lo, hi = bounds(bm.verts)
    length, width, height = hi.y - lo.y, hi.x - lo.x, hi.z - lo.z
    faces = [f for f in bm.faces if f[layers[3]] >= 0]
    colours = {f: colorsys.rgb_to_hsv(*(min(1, max(0, f[layer])) for layer in layers[:3])) for f in faces}
    votes = {}
    for face in faces:
        key = paint_key(*colours[face])
        # `texture_paint: false`: the paint comes from a plain material; sampled atlases
        # (trim, chrome, lamps) never vote for it.
        if key is not None and face.calc_center_median().z > .4 * height and car.get('texture_paint', True):
            votes[key] = votes.get(key, 0) + face.calc_area()
    paint = max(sorted(votes, key=str), key=votes.get) if votes else None
    # The paint's own saturation and value (area-weighted medians): lamp lenses and
    # badges of a similar hue but a different tone stay out of the paint.
    members = sorted((colours[f][1], colours[f][2], f.calc_area()) for f in faces
                     if paint is not None and paint_key(*colours[f]) == paint and f.calc_center_median().z > .4 * height)
    total = sum(m[2] for m in members)

    def weighted_median(index):
        ordered, seen = sorted(members, key=lambda m: m[index]), 0
        for m in ordered:
            seen += m[2]
            if seen >= total / 2:
                return m[index]
        return 0
    paint_s, paint_v = (weighted_median(0), weighted_median(1)) if members else (0, 0)

    def is_paint(h, s, v):
        if paint is None or not same_family(paint_key(h, s, v), paint):
            return False
        return paint == 'light' or (abs(s - paint_s) < .18 and .35 * paint_v < v < 1.8 * paint_v)
    tyres = set()
    for island in islands(bm):
        if not all(f in colours for f in island):
            continue
        a, b = bounds({v for f in island for v in f.verts})
        size, centre = b - a, (a + b) / 2
        if (b.z < .55 * height and a.z < .08 * height and abs(centre.x) > .25 * width
                and min(size.y, size.z) > .15 * height and abs(size.y - size.z) < .2 * max(size.y, size.z)):
            tyres.update(island)
    counts = {}
    for face in faces:
        h, s, v = colours[face]
        centre = face.calc_center_median()
        front, rear = centre.y - lo.y, hi.y - centre.y
        ends = min(front, rear) < .06 * length
        lamp_side = abs(centre.x) > .22 * width and .3 * height < centre.z < .85 * height
        if face in tyres:
            role = 'rubber'
        elif face[layers[3]] > .25:
            role = 'lamp'
        elif is_paint(h, s, v):
            role = 'paint'
        elif s < .2 and v >= .55:
            role = 'lamp' if ends and lamp_side else 'plate' if ends and abs(centre.x) < .15 * width and centre.z < .55 * height else 'alloy'
        elif s >= .25 and v >= .2 and (h < .06 or h > .95) and rear < .06 * length and lamp_side:
            role = 'lamp_tail'
        elif s >= .35 and v >= .4 and .05 <= h < .16 and ends:
            role = 'lamp'  # amber indicators
        elif .08 <= s < .6 and .1 <= v < .75 and .5 <= h < .75:
            role = 'glass' if centre.z > .5 * height else 'trim'
        elif s < .2 and .3 <= v < .55:
            role = 'alloy'
        else:
            role = 'trim'
        face.material_index = R[role]
    # A lamp unit is often painted as lens segments on a dark housing: dark or
    # light faces inside a lamp cluster's box (per side and end) that face the
    # same way join the lamp, so it reads as one unit.
    clusters = {}
    for face in faces:
        if face.material_index in (R['lamp'], R['lamp_head'], R['lamp_tail']):
            centre = face.calc_center_median()
            key = (face.material_index, centre.x > 0, centre.y > 0)
            box = clusters.setdefault(key, [Vector((1e9,) * 3), Vector((-1e9,) * 3)])
            for axis in range(3):
                box[0][axis] = min(box[0][axis], centre[axis])
                box[1][axis] = max(box[1][axis], centre[axis])
    for face in faces:
        if face.material_index not in (R['trim'], R['alloy'], R['glass']) or face in tyres or abs(face.normal.y) < .5:
            continue
        centre = face.calc_center_median()
        for (role, left, rear), (a, b) in sorted(clusters.items()):
            if (centre.x > 0) == left and (centre.y > 0) == rear and all(a[i] - .01 <= centre[i] <= b[i] + .01 for i in range(3)):
                face.material_index = role
                break
    for face in faces:
        centre = face.calc_center_median()
        for box_role, x0, x1, y0, y1, z0, z1 in car.get('texture_roles', []):
            if x0 <= abs(centre.x) <= x1 and y0 <= centre.y - lo.y <= y1 and z0 <= centre.z <= z1:
                face.material_index = R[box_role]
        role = ROLES[face.material_index]
        counts[role] = counts.get(role, 0) + 1
    for layer in TEXTURE_LAYERS:
        bm.faces.layers.float.remove(bm.faces.layers.float[layer])
    return dict(paint=str(paint), roles={k: counts[k] for k in sorted(counts)})


def drop_emblems(bm, car):
    """Catalog `emblems`: [|x| min, |x| max, from front min, max, z min, z max].

    Removes every loose source part that lies wholly inside a box: a grille or tailgate
    badge modelled on top of its panel goes, the panel stays. Faces count as one part when
    they share a vertex position (1 mm), so unwelded sources still keep their panels whole,
    and a part that reaches outside the box is kept, so a box never cuts a hole into a panel.
    """
    if not car.get('emblems'):
        return 0
    lo, _hi = bounds(bm.verts)
    doomed = set()
    for x0, x1, y0, y1, z0, z1 in car['emblems']:
        def inside(co):
            return (x0 - .002 <= abs(co.x) <= x1 + .002 and y0 - .002 <= co.y - lo.y <= y1 + .002
                    and z0 - .002 <= co.z <= z1 + .002)
        # Any face sharing a position with a face wholly inside has a vertex inside too.
        candidates = [f for f in bm.faces if any(inside(v.co) for v in f.verts)]
        parent = list(range(len(candidates)))

        def root(i):
            while parent[i] != i:
                parent[i] = parent[parent[i]]
                i = parent[i]
            return i
        first = {}
        for index, face in enumerate(candidates):
            for vert in face.verts:
                key = tuple(round(c * 1000) for c in vert.co)
                if key in first:
                    parent[root(index)] = root(first[key])
                else:
                    first[key] = index
        parts = {}
        for index, face in enumerate(candidates):
            parts.setdefault(root(index), []).append(face)
        for faces in parts.values():
            if all(inside(v.co) for f in faces for v in f.verts):
                doomed.update(faces)
    bmesh.ops.delete(bm, geom=list(doomed), context='FACES')
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    return len(doomed)


def apply_role_boxes(bm, car):
    """Catalog `role_boxes`: [role, |x| min, |x| max, from front min, max, z min, z max(, [roles it replaces])].

    Positional overrides after normalising, for any face (plain or texture colours): a
    chrome grille emblem becomes trim, tyres merged into one black material become rubber.
    """
    if not car.get('role_boxes'):
        return
    lo, _hi = bounds(bm.verts)
    for face in bm.faces:
        centre = face.calc_center_median()
        for box in car['role_boxes']:
            role, x0, x1, y0, y1, z0, z1 = box[:7]
            if len(box) > 7 and ROLES[face.material_index] not in box[7]:
                continue
            if x0 <= abs(centre.x) <= x1 and y0 <= centre.y - lo.y <= y1 and z0 <= centre.z <= z1:
                face.material_index = R[role]
    # `drop` boxes cut loose cargo or roof clutter the name rules could not reach.
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.material_index == R['drop']], context='FACES')
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')


def add_caps(bm, car):
    """Catalog `caps`: [role, z, |x| max, from front min, max] adds a flat panel, e.g. tinted
    glass over a roof the source left open, so the cabin below is culled as hidden."""
    if not car.get('caps'):
        return
    lo, _hi = bounds(bm.verts)
    for role, z, half, y0, y1 in car['caps']:
        corners = [bm.verts.new((x, lo.y + y, z)) for x, y in ((-half, y0), (half, y0), (half, y1), (-half, y1))]
        face = bm.faces.new(corners)
        face.material_index = R[role]
        if face.normal.z < 0:
            face.normal_flip()


def add_side_caps(bm, car):
    """Catalog `side_caps`: [role, |x|, from front min, max, z min, z max] adds an upright panel
    on each side after simplifying, behind the side glass: where the simplified glazing leaves a
    gap (or a door window is open in the source) the panel shows instead of the hollow cabin."""
    if not car.get('side_caps'):
        return
    lo, _hi = bounds(bm.verts)
    for role, half, y0, y1, z0, z1 in car['side_caps']:
        for side in (1, -1):
            corners = [bm.verts.new((side * half, lo.y + y, z)) for y, z in ((y0, z0), (y1, z0), (y1, z1), (y0, z1))]
            face = bm.faces.new(corners)
            face.material_index = R[role]
            face.normal_update()
            if face.normal.x * side < 0:
                face.normal_flip()


def detect_wheels(bm):
    """Find the four ground tyres (rubber faces in the lower outer quadrants)."""
    lo, hi = bounds(bm.verts)
    width, height = hi.x - lo.x, hi.z - lo.z
    clusters = {}
    for face in bm.faces:
        if face.material_index != R['rubber']:
            continue
        centre = face.calc_center_median()
        if abs(centre.x) < .25 * width or centre.z > .5 * height:
            continue
        key = (centre.x > 0, centre.y > 0)
        cluster = clusters.setdefault(key, [Vector((1e9,) * 3), Vector((-1e9,) * 3)])
        for vert in face.verts:
            for axis in range(3):
                cluster[0][axis] = min(cluster[0][axis], vert.co[axis])
                cluster[1][axis] = max(cluster[1][axis], vert.co[axis])
    if len(clusters) != 4:
        raise RuntimeError('Expected four ground tyres, found %d clusters' % len(clusters))
    raw = {key: dict(x0=a.x, x1=b.x, y=(a.y + b.y) / 2, radius=((b.z - a.z) + (b.y - a.y)) / 4) for key, (a, b) in clusters.items()}
    # One template is instanced on all four hubs, so use one symmetric radius,
    # width and track; each axle keeps its own measured position.
    radius = sum(w['radius'] for w in raw.values()) / 4
    width = sum(w['x1'] - w['x0'] for w in raw.values()) / 4 * .92
    track = sum(abs(w['x0'] + w['x1']) / 2 for w in raw.values()) / 4
    wheels = []
    for (left, rear), wheel in sorted(raw.items(), key=lambda item: (item[0][1], not item[0][0])):
        # Blender +X is app +X; a car facing app +Z has its left side on +X.
        wheels.append(dict(name='wheel-%s-%s' % ('rear' if rear else 'front', 'left' if left else 'right'),
                           x=track if left else -track, y=wheel['y'], z=radius, radius=radius, width=width, side=1 if left else -1,
                           x0=wheel['x0'], x1=wheel['x1'], measured=wheel['radius']))
    return wheels


def remove_wheel_volumes(bm, wheels):
    doomed = []
    for face in bm.faces:
        if face.material_index == R['paint']:
            continue
        centre = face.calc_center_median()
        for wheel in wheels:
            reach = 1.12 if face.material_index == R['rubber'] else 1.02
            if wheel['x0'] - .03 <= centre.x <= wheel['x1'] + .03 and math.hypot(centre.y - wheel['y'], centre.z - wheel['measured']) < wheel['measured'] * reach:
                doomed.append(face)
                break
    bmesh.ops.delete(bm, geom=doomed, context='FACES')


def replace_spare(bm, wheels, rear_only=False):
    """A tailgate spare (rubber well above the road wheels) becomes a clean low-poly tyre.

    With ``rear_only`` (catalog `spare: "rear"`) only rubber in the rear fifth counts, so high
    seals or under-bonnet parts elsewhere cannot stretch the spare along the car.
    """
    lo, hi = bounds(bm.verts)
    spare = [f for f in bm.faces if f.material_index == R['rubber'] and f.calc_center_median().z > wheels[0]['radius'] * 1.6
             and (not rear_only or f.calc_center_median().y > hi.y - .2 * (hi.y - lo.y))]
    if len(spare) < 50:
        return None
    a, b = bounds({v for f in spare for v in f.verts})
    radius = ((b.x - a.x) + (b.z - a.z)) / 4
    centre = Vector(((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2))
    doomed = [f for f in bm.faces if f.material_index != R['paint'] and abs(f.calc_center_median().y - centre.y) <= (b.y - a.y) / 2 + .02
              and math.hypot(f.calc_center_median().x - centre.x, f.calc_center_median().z - centre.z) < radius * 1.02]
    bmesh.ops.delete(bm, geom=doomed, context='FACES')
    tyre = wheel_template(radius, b.y - a.y)
    # Template axle is X with its face at +X; the spare faces backwards (+Y).
    bmesh.ops.transform(tyre, matrix=Matrix.Translation(centre) @ Matrix.Rotation(math.pi / 2, 4, 'Z'), verts=tyre.verts)
    temp = bpy.data.meshes.new('spare')
    tyre.to_mesh(temp)
    tyre.free()
    bm.from_mesh(temp)
    bpy.data.meshes.remove(temp)
    return dict(radius=radius, y=centre.y, z=centre.z)


def ring(bm, x, radius, sides, phase=0):
    return [bm.verts.new((x, radius * math.cos(2 * math.pi * i / sides + phase), radius * math.sin(2 * math.pi * i / sides + phase))) for i in range(sides)]


def wheel_template(radius, width, sides=16, spokes=5):
    """One road wheel at the origin: axle along X, visible face towards +X.

    A revolved tyre profile with rounded shoulders, a dark wheel well, alloy
    rim ring, hub and five spokes, so rotation reads when it is instanced.
    """
    bm = bmesh.new()
    w, r = width / 2, radius
    b = min(.3 * width, .14 * radius)
    profile = [(-w, .70 * r), (-w, r - b), (-w + .29 * b, r - .29 * b), (-w + b, r), (w - b, r),
               (w - .29 * b, r - .29 * b), (w, r - b), (w, .70 * r)]
    rings = [ring(bm, x, radius_at, sides) for x, radius_at in profile]
    for first, second in zip(rings, rings[1:]):
        for i in range(sides):
            j = (i + 1) % sides
            bm.faces.new((first[i], first[j], second[j], second[i])).material_index = R['rubber']
    bm.faces.new(list(reversed(rings[0]))).material_index = R['rubber']
    well = ring(bm, w + .002, r * .70, sides)
    bm.faces.new(well).material_index = R['trim']
    face_x = w + .006
    rim_outer, rim_inner = ring(bm, face_x, r * .70, sides), ring(bm, face_x, r * .60, sides)
    for i in range(sides):
        j = (i + 1) % sides
        bm.faces.new((rim_outer[i], rim_outer[j], rim_inner[j], rim_inner[i])).material_index = R['alloy']
    hub = ring(bm, face_x + .002, r * .17, 8)
    bm.faces.new(hub).material_index = R['alloy']
    for k in range(spokes):
        angle = 2 * math.pi * k / spokes
        direction, normal = Vector((0, math.cos(angle), math.sin(angle))), Vector((0, -math.sin(angle), math.cos(angle)))
        half = r * .075
        base = Vector((face_x + .001, 0, 0))
        quad = [base + direction * r * .12 - normal * half, base + direction * r * .62 - normal * half * 1.25,
                base + direction * r * .62 + normal * half * 1.25, base + direction * r * .12 + normal * half]
        bm.faces.new([bm.verts.new(p) for p in quad]).material_index = R['alloy']
    bmesh.ops.triangulate(bm, faces=bm.faces)
    for face in bm.faces:
        centre = face.calc_center_median()
        if abs(face.normal.x) > .5:
            if (face.normal.x > 0) != (centre.x > 0):
                face.normal_flip()
        elif face.normal.dot(Vector((0, centre.y, centre.z))) < 0:
            face.normal_flip()
    return bm


def placed_wheels(wheels):
    """Four simple cylinders standing in for the instanced wheels while culling."""
    bm = bmesh.new()
    for wheel in wheels:
        a = ring(bm, wheel['x'] - wheel['width'] / 2, wheel['radius'], 16)
        b = ring(bm, wheel['x'] + wheel['width'] / 2, wheel['radius'], 16)
        for vert in a + b:
            vert.co.y += wheel['y']
            vert.co.z += wheel['z']
        for i in range(16):
            j = (i + 1) % 16
            bm.faces.new((a[i], a[j], b[j], b[i]))
        bm.faces.new(a)
        bm.faces.new(list(reversed(b)))
    return bm


def fibonacci_directions(count=96, min_z=-.2):
    result = []
    for i in range(count):
        z = 1 - 2 * (i + .5) / count
        r = math.sqrt(max(0, 1 - z * z))
        angle = math.pi * (3 - math.sqrt(5)) * i
        if z >= min_z:
            result.append(Vector((r * math.cos(angle), r * math.sin(angle), z)))
    return result


def uncover_lamps(bm, reach=.03):
    """Remove thin painted decal shells laid directly over lamp lenses."""
    bm.faces.ensure_lookup_table()
    tree = BVHTree.FromBMesh(bm)
    lamps = (R['lamp'], R['lamp_head'], R['lamp_tail'])
    doomed = set()
    for face in bm.faces:
        if face.material_index not in lamps:
            continue
        centre = face.calc_center_median()
        for direction in (face.normal, -face.normal):
            hit = tree.ray_cast(centre + direction * .0005, direction, reach)
            if hit[2] is not None and bm.faces[hit[2]].material_index == R['paint']:
                doomed.add(bm.faces[hit[2]])
    bmesh.ops.delete(bm, geom=list(doomed), context='FACES')
    return len(doomed)


def cull_hidden(bm, wheels_bm):
    occluders = bm.copy()
    temp = bpy.data.meshes.new('cull occluders')
    wheels_bm.to_mesh(temp)
    occluders.from_mesh(temp)
    bpy.data.meshes.remove(temp)
    tree = BVHTree.FromBMesh(occluders)
    occluders.free()
    directions = fibonacci_directions()
    hidden, flipped = [], []
    for face in bm.faces:
        centre = face.calc_center_median()
        samples = [centre] + [centre.lerp(v.co, .7) for v in face.verts[:4]]
        # Most normal-aligned directions first: the first escape then tells
        # which side of the face is seen, even for thin two-sided parts.
        ordered = sorted(directions, key=lambda d: -abs(face.normal.dot(d)))
        escape = next((direction for direction in ordered for point in samples
                       if tree.ray_cast(point + direction * .002, direction, 30)[0] is None), None)
        if escape is None:
            hidden.append(face)
        elif face.normal.dot(escape) < 0:
            # Source normals are inconsistent; a visible face must face the
            # side it is seen from, or single-sided runtime materials drop it.
            flipped.append(face)
    for face in flipped:
        face.normal_flip()
    bmesh.ops.delete(bm, geom=hidden, context='FACES')
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    return len(hidden)


def islands(bm):
    bm.faces.index_update()
    seen, result = set(), []
    for face in bm.faces:
        if face.index in seen:
            continue
        stack, island = [face], []
        seen.add(face.index)
        while stack:
            current = stack.pop()
            island.append(current)
            for edge in current.edges:
                for other in edge.link_faces:
                    if other.index not in seen:
                        seen.add(other.index)
                        stack.append(other)
        result.append(island)
    return result


def remove_small_islands(bm, size=.15):
    doomed = []
    for island in islands(bm):
        if any(face.material_index in (R['lamp_head'], R['lamp_tail'], R['lamp']) for face in island):
            continue
        lo, hi = bounds({v for face in island for v in face.verts})
        if (hi - lo).length < size:
            doomed.extend(island)
    bmesh.ops.delete(bm, geom=doomed, context='FACES')
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    return len(doomed)


def split_lamps(bm, car):
    """Resolve position-dependent lamps (clear lenses at the nose become headlamps)
    and apply the catalog's head/tail lamp and badge paint boxes."""
    lo, hi = bounds(bm.verts)
    length, height = hi.y - lo.y, hi.z - lo.z
    nose = lo.y + length * car.get('nose', .07)
    # Cut the large source panels along each lamp box's top and bottom so the
    # lamp band keeps straight edges through decimation.
    for boxes, inside in ((car.get('head_boxes', []), lambda y, y0, y1: y0 <= y - lo.y <= y1),
                          (car.get('tail_boxes', []), lambda y, y0, y1: y0 <= hi.y - y <= y1)):
        for x0, x1, y0, y1, z0, z1 in boxes:
            for z in (z0, z1):
                faces = [f for f in bm.faces if inside(f.calc_center_median().y, y0 - .1, y1 + .1)]
                geom = list({e for f in faces for e in f.edges}) + faces + list({v for f in faces for v in f.verts})
                bmesh.ops.bisect_plane(bm, geom=geom, plane_co=(0, 0, z), plane_no=(0, 0, 1), dist=.002)
    for face in bm.faces:
        centre = face.calc_center_median()
        for x0, x1, y0, y1, z0, z1 in car.get('head_boxes', []):
            # Recessed lamp units the source modelled as dark housings or lenses.
            if face.material_index != R['paint'] and x0 <= abs(centre.x) <= x1 and y0 <= centre.y - lo.y <= y1 and z0 <= centre.z <= z1:
                face.material_index = R['lamp_head']
        for x0, x1, y0, y1, z0, z1 in car.get('tail_boxes', []):
            if face.material_index in (R['glass'], R['trim']) and x0 <= abs(centre.x) <= x1 and y0 <= hi.y - centre.y <= y1 and z0 <= centre.z <= z1:
                face.material_index = R['lamp_tail']
        if face.material_index == R['lamp']:
            face.material_index = R['lamp_head'] if centre.y < 0 else R['lamp_tail']
        elif face.material_index == R['glass'] and centre.y < nose and centre.z < .62 * height:
            face.material_index = R['lamp_head']
        for x0, x1, y0, y1, z0, z1 in car.get('paint_boxes', []):
            # Badges set into a panel (too large for the island filter) are painted
            # over; deleting them would open a hole in the body.
            if x0 <= abs(centre.x) <= x1 and y0 <= centre.y - lo.y <= y1 and z0 <= centre.z <= z1:
                face.material_index = R['paint']


def decimate(bm, target, collection, name, planar=False):
    """Collapse-decimate through a temporary modifier; deterministic for identical input.

    With ``planar`` flat regions are dissolved first so the collapse budget goes
    to curvature (roof, fenders, bonnet, arches); collapse is X-symmetric.
    """
    if planar:
        bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(2), verts=bm.verts, edges=bm.edges, delimit={'MATERIAL'})
        bmesh.ops.triangulate(bm, faces=bm.faces)
        # Collapse protects open borders; opening role borders keeps lamp
        # bands and window lines straight. They are welded again afterwards.
        bmesh.ops.split_edges(bm, edges=[e for e in bm.edges if len({f.material_index for f in e.link_faces}) > 1])
    # Welded coincident panels leave edges shared by 3+ faces; collapse refuses
    # to touch those, so the decimation would stall far above the budget.
    bmesh.ops.split_edges(bm, edges=[e for e in bm.edges if len(e.link_faces) > 2])
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    try:
        for _ in range(4):
            count = sum(len(p.vertices) - 2 for p in mesh.polygons)
            if count <= target * 1.04:
                break
            modifier = obj.modifiers.new('Simplify', 'DECIMATE')
            modifier.decimate_type = 'COLLAPSE'
            modifier.ratio = max(.0005, target / count)
            modifier.use_collapse_triangulate = True
            modifier.use_symmetry = planar
            modifier.symmetry_axis = 'X'
            depsgraph = bpy.context.evaluated_depsgraph_get()
            reduced = bpy.data.meshes.new_from_object(obj.evaluated_get(depsgraph), depsgraph=depsgraph)
            obj.modifiers.remove(modifier)
            old = obj.data
            obj.data = reduced
            bpy.data.meshes.remove(old)
            mesh = reduced
        result = bmesh.new()
        result.from_mesh(mesh)
        return result
    finally:
        mesh = obj.data
        bpy.data.objects.remove(obj)
        bpy.data.meshes.remove(mesh)


def remove_spikes(bm, lo, hi, margin=.01):
    """Quadric collapse can throw a vertex far out on degenerate panels; drop such faces."""
    doomed = []
    for face in bm.faces:
        outside = any(not (lo[i] - margin <= v.co[i] <= hi[i] + margin) for v in face.verts for i in range(3))
        longest = max(e.calc_length() for e in face.edges)
        sliver = longest > .45 and face.calc_area() < longest * longest * .004
        if outside or sliver:
            doomed.append(face)
    bmesh.ops.delete(bm, geom=doomed, context='FACES')
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    return len(doomed)


def weld(bm, distance=.0015):
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=distance)
    bmesh.ops.dissolve_degenerate(bm, edges=bm.edges, dist=distance / 2)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.calc_area() < 1e-9], context='FACES')
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')


def triangles(bm):
    return sum(len(f.verts) - 2 for f in bm.faces)


def smooth_normals(obj):
    """Bake area-weighted custom normals that keep the sharp creases."""
    modifier = obj.modifiers.new('Weighted normals', 'WEIGHTED_NORMAL')
    modifier.mode = 'FACE_AREA'
    modifier.keep_sharp = True
    modifier.weight = 50
    depsgraph = bpy.context.evaluated_depsgraph_get()
    baked = bpy.data.meshes.new_from_object(obj.evaluated_get(depsgraph), depsgraph=depsgraph)
    obj.modifiers.remove(modifier)
    old = obj.data
    name = old.name
    obj.data = baked
    bpy.data.meshes.remove(old)
    baked.name = name


WHEEL_NAMES = {'rubber': 'Wheel tyre', 'trim': 'Wheel well', 'alloy': 'Wheel rim'}


def role_objects(bm, parent, collection, materials, roles, names=OBJECT_NAMES):
    created = []
    for role in roles:
        part = bm.copy()
        bmesh.ops.delete(part, geom=[f for f in part.faces if f.material_index != R[role]], context='FACES')
        bmesh.ops.delete(part, geom=[v for v in part.verts if not v.link_faces], context='VERTS')
        if not part.faces:
            part.free()
            continue
        for face in part.faces:
            face.material_index = 0
            face.smooth = True
        for edge in part.edges:
            edge.smooth = not (len(edge.link_faces) != 2 or edge.calc_face_angle(0) > math.radians(SMOOTH_ANGLE))
        name = names[role]
        mesh = bpy.data.meshes.new(name)
        part.to_mesh(mesh)
        part.free()
        mesh.materials.append(materials[role])
        while mesh.uv_layers:
            mesh.uv_layers.remove(mesh.uv_layers[0])
        obj = bpy.data.objects.new(name, mesh)
        collection.objects.link(obj)
        obj.parent = parent
        smooth_normals(obj)
        created.append(obj)
    return created


def build(style, body, wheel_bm, collection, materials, wheels):
    """`mobility-<style>`: role meshes, one wheel template and four hub markers."""
    root = bpy.data.objects.new(style, None)
    collection.objects.link(root)
    bmesh.ops.triangulate(body, faces=body.faces)
    role_objects(body, root, collection, materials, list(ROLE_MATERIALS))
    # The template stands at the front-left hub so a plain viewer shows one
    # wheel; runtime uses its geometry relative to this node's origin.
    template = bpy.data.objects.new('wheel-template', None)
    collection.objects.link(template)
    template.parent = root
    front_left = next(w for w in wheels if w['name'] == 'wheel-front-left')
    template.location = (front_left['x'], front_left['y'], front_left['z'])
    template['wheel_radius'] = round(front_left['radius'], 4)
    role_objects(wheel_bm, template, collection, materials, ['rubber', 'trim', 'alloy'], WHEEL_NAMES)
    for wheel in wheels:
        marker = bpy.data.objects.new(wheel['name'], None)
        collection.objects.link(marker)
        marker.parent = root
        marker.location = (wheel['x'], wheel['y'], wheel['z'])
        marker['wheel_radius'] = round(wheel['radius'], 4)
        marker['wheel_side'] = wheel['side']
    lo, hi = bounds(list(body.verts) + [type('V', (), {'co': Vector((w['x'] + w['side'] * w['width'] / 2, w['y'], 0))})() for w in wheels])
    front = [w for w in wheels if w['name'].startswith('wheel-front')]
    rear = [w for w in wheels if w['name'].startswith('wheel-rear')]
    spec = {
        'length': round(hi.y - lo.y, 3), 'width': round(hi.x - lo.x, 3), 'height': round(hi.z - lo.z, 3),
        'wheel': round(wheels[0]['radius'], 3), 'wheelbase': round(rear[0]['y'] - front[0]['y'], 3),
        'track': round(2 * abs(front[0]['x']), 3),
    }
    root['vehicle_style'] = style.removeprefix('mobility-')
    root['vehicle_spec'] = spec
    return root, spec


def process(style, path, collection, materials=None):
    """Import ``path`` (an extracted source) and run the whole pipeline for ``style``."""
    car = CARS[style]
    materials = materials or role_materials()
    source_collection = bpy.data.collections.new(style + ' source')
    collection.children.link(source_collection)
    objects = import_source(path, source_collection)
    body = combine(objects, car)
    stats = {'source_triangles': triangles(body)}
    remove_collection(source_collection)
    root, more = simplify(style, body, collection, materials)
    stats.update(more)
    log(style + ' ' + json.dumps(stats))
    return root, stats


def simplify(style, body, collection, materials):
    """Steps 3-8 of the pipeline; consumes ``body``."""
    car = CARS[style]
    normalise(body, car)
    from_texture = texture_roles(body, car)
    if from_texture:
        log(style + ' texture roles ' + json.dumps(from_texture))
    emblems = drop_emblems(body, car)
    apply_role_boxes(body, car)
    add_caps(body, car)
    wheels = detect_wheels(body)
    remove_wheel_volumes(body, wheels)
    spare = replace_spare(body, wheels, car.get('spare') == 'rear')
    split_lamps(body, car)
    weld(body)
    stand_ins = placed_wheels(wheels)
    coarse = decimate(body, 60000, collection, style + ' coarse')
    body.free()
    stats = {'uncovered': uncover_lamps(coarse) if car.get('lamp_decals') else 0}
    stats.update(culled=cull_hidden(coarse, stand_ins), spare=bool(spare))
    if car.get('emblems'):
        stats['emblems'] = emblems
    stand_ins.free()
    stats['islands'] = remove_small_islands(coarse)
    # Close panel shut-lines so neighbouring panels collapse as one surface
    # instead of opening cracks into the culled, now hollow body.
    weld(coarse, car.get('seam', .006))
    template = wheel_template(wheels[0]['radius'], wheels[0]['width'])
    lo, hi = bounds(coarse.verts)
    body = decimate(coarse, car.get('target', BODY_TRIANGLES), collection, style + ' final', planar=True)
    coarse.free()
    weld(body, .002)
    stats['spikes'] = remove_spikes(body, lo, hi)
    add_side_caps(body, car)
    root, spec = build(style, body, template, collection, materials, wheels)
    body.free()
    template.free()
    parts = {}
    for obj in root.children_recursive:
        if obj.type == 'MESH':
            parts[obj.name] = len(obj.data.polygons)
    stats.update(spec=spec, parts=parts, triangles=sum(parts.values()),
                 wheel_triangles=sum(v for k, v in parts.items() if k.startswith('Wheel ')))
    for role in ('lamp_head', 'lamp_tail'):
        if not any(o.type == 'MESH' and o.data.materials[0] == materials[role] for o in root.children):
            raise RuntimeError(style + ' has no ' + role)
    return root, stats


def remove_collection(collection):
    for obj in list(collection.all_objects):
        data = obj.data
        bpy.data.objects.remove(obj)
        if data is not None and data.users == 0:
            if isinstance(data, bpy.types.Mesh):
                bpy.data.meshes.remove(data)
    for child in list(collection.children):
        remove_collection(child)
    bpy.data.collections.remove(collection)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.armatures, bpy.data.cameras, bpy.data.lights):
        for item in list(block):
            if item.users == 0 and not item.name.startswith(('Mobility ', 'Preview ')):
                block.remove(item)


def export(root, path):
    """Export one car and strip everything but geometry, role materials and the spec."""
    for obj in [o for o in bpy.context.view_layer.objects if o is not None]:
        obj.select_set(False)
    root.select_set(True)
    for child in root.children_recursive:
        child.select_set(True)
    saved = root.location.copy()
    root.location = (0, 0, 0)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_yup=True, export_extras=True,
                              export_texcoords=False, export_normals=True, export_materials='EXPORT', export_cameras=False,
                              export_lights=False, export_animations=False, export_skins=False, export_morph=False,
                              export_vertex_color='NONE', export_attributes=False, export_tangents=False)
    root.location = saved
    with open(path, 'rb') as file:
        data = file.read()
    length = struct.unpack_from('<I', data, 12)[0]
    document = json.loads(data[20:20 + length])
    for key in ('images', 'textures', 'samplers', 'extensionsUsed', 'extensionsRequired'):
        if document.get(key):
            raise ValueError('Unexpected ' + key + ' in campus vehicle export')
    for collection in ('meshes', 'materials', 'scenes'):
        for item in document.get(collection, []):
            item.pop('extras', None)
    for node in document.get('nodes', []):
        if node.get('name') != root.name and not node.get('name', '').startswith('wheel-'):
            node.pop('extras', None)
    document['scenes'][0]['name'] = 'Extalia campus vehicle'
    encoded = json.dumps(document, ensure_ascii=True, separators=(',', ':')).encode()
    encoded += b' ' * (-len(encoded) % 4)
    tail = data[20 + length:]
    data = struct.pack('<IIIII', 0x46546C67, 2, 20 + len(encoded) + len(tail), len(encoded), 0x4E4F534A) + encoded + tail
    with open(path, 'wb') as file:
        file.write(data)
    return len(data)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-dir', required=True, help='folder holding the source archives (any depth)')
    parser.add_argument('--output', default=os.path.join(os.path.dirname(__file__), '../../apps/web/local-assets/vehicles'))
    parser.add_argument('--work-dir', help='empty scratch folder for extracted sources (default: a new temporary folder)')
    parser.add_argument('--only', help='comma-separated catalog styles, e.g. ev-sedan,van')
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
    os.makedirs(args.output, exist_ok=True)
    work_dir = args.work_dir or tempfile.mkdtemp(prefix='campus-vehicles-')
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    materials = role_materials()
    manifest_path = os.path.join(args.output, 'vehicles.manifest.json')
    results = {}
    styles = ['mobility-' + style for style in args.only.split(',')] if args.only else list(CARS)
    for style in styles:
        car = CARS[style]
        path = extract_source(car, args.source_dir, work_dir)
        if path is None:
            log('skip %s: archive %s not found under --source-dir' % (car['style'], car['archive']))
            continue
        collection = bpy.data.collections.new(style)
        scene.collection.children.link(collection)
        root, stats = process(style, path, collection, materials)
        name = car['style'] + '.glb'
        stats['bytes'] = export(root, os.path.join(args.output, name))
        stats.update(path='vehicles/' + name, style=car['style'], category=car['category'])
        assert stats['triangles'] <= car.get('max_triangles', MAX_TRIANGLES) and stats['bytes'] <= car.get('max_bytes', MAX_BYTES), stats
        log('exported %s %d bytes' % (name, stats['bytes']))
        results[style] = stats
        remove_collection(collection)
    # Several exports may run in parallel (`--only`): merge this run's cars under a lock.
    with open(manifest_path + '.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        manifest = json.load(open(manifest_path)) if os.path.exists(manifest_path) else {}
        manifest.update(results)
        manifest = {key: manifest[key] for key in manifest if key in CARS}
        with open(manifest_path, 'w') as file:
            json.dump(manifest, file, indent=2, sort_keys=True)
            file.write('\n')


if __name__ == '__main__':
    main()
