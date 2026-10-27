"""Editable stair modules. App X/Y/Z maps to Blender X/Z/-Y.

Blender --background --python tooling/blender/create-stair-library.py -- --preview <png>
Contract roots are exported at zero; the blend contains an assembled inspection stair.
All illumination and glass remain app owned.
"""
import argparse
import json
import math
import os
import sys
import bpy
from mathutils import Vector

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '../..'))
parser = argparse.ArgumentParser()
parser.add_argument('--output', default=os.path.join(REPO, 'apps/web/local-assets/architecture'))
parser.add_argument('--preview')
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
os.makedirs(args.output, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.unit_settings.system = 'METRIC'
scene['coordinate_system'] = 'app X/Y/Z = Blender X/Z/-Y'
NOMINAL = {'stair-tread': [2.95, .09, 5.3 / 18], 'stair-stringer': [.12, .24, 1],
           'stair-landing': [1, .13, 1], 'stair-handrail': [.052, .036, 1],
           'stair-shoe': [.058, .055, 1], 'stair-clamp': [.064, .066, .074]}
roots = {}
active = None


def point(p):
    return Vector((p[0], -p[2], p[1]))


def material(name, color, roughness, metal=0):
    rgb = [int(color[i:i+2], 16) / 255 for i in (0, 2, 4)]
    rgb = [c / 12.92 if c <= .04045 else ((c + .055) / 1.055) ** 2.4 for c in rgb]
    result = bpy.data.materials.new(name)
    result.diffuse_color = (*rgb, 1)
    result.use_nodes = True
    shader = result.node_tree.nodes['Principled BSDF']
    shader.inputs['Base Color'].default_value = (*rgb, 1)
    shader.inputs['Roughness'].default_value = roughness
    shader.inputs['Metallic'].default_value = metal
    return result


oak = material('Stair oak', 'b59a78', .66, .02)
endgrain = material('Stair oak endgrain', 'a38763', .72)
metal = material('Stair brushed steel', 'b8c1c4', .26, .82)
structure = material('Stair graphite structure', '30363b', .5, .65)
stone = material('Stair limestone', 'd7d4cb', .86)
grip = material('Stair inset grip', '6d716e', .92)


def group(name):
    global active
    active = bpy.data.objects.new(name, None)
    scene.collection.objects.link(active)
    active['stair_part'] = name
    active['nominal_dimensions'] = NOMINAL[name]
    active['origin_contract'] = 'walking surface Y=0' if name in ('stair-tread', 'stair-landing') else 'centered unit module'
    roots[name] = active


def finish(obj, name, mat, bevel=0):
    obj.name = name
    obj.data.materials.append(mat)
    bpy.context.view_layer.objects.active = obj
    if bevel:
        modifier = obj.modifiers.new('Manufactured edge radius', 'BEVEL')
        modifier.width = bevel
        modifier.segments = 3
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    modifier = obj.modifiers.new('Weighted planar normals', 'WEIGHTED_NORMAL')
    modifier.keep_sharp = True
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    obj.parent = active
    return obj


def box(name, center, size, mat, bevel=.002):
    bpy.ops.mesh.primitive_cube_add(size=1, location=point(center))
    obj = bpy.context.object
    obj.dimensions = (size[0], size[2], size[1])
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish(obj, name, mat, min(bevel, min(size) * .4))


def rod(name, start, end, radius, mat, sides=12):
    a, b = point(start), point(end)
    bpy.ops.mesh.primitive_cylinder_add(vertices=sides, radius=radius, depth=(b-a).length, location=(a+b)/2)
    obj = bpy.context.object
    obj.rotation_mode = 'QUATERNION'
    obj.rotation_quaternion = (b-a).to_track_quat('Z', 'Y')
    return finish(obj, name, mat, .0006)


group('stair-tread')
w, d = 2.95, 5.3 / 18
# Main walking plane is exactly zero, including the inset grip strips.
timber = box('Solid oak tread with softened nosing', (0, -.045, 0), (w, .09, d+.025), oak, .009)
# Cut real recesses so the flush rubber inserts cannot z-fight the wood.
for inset in (.04, .064):
    bpy.ops.mesh.primitive_cube_add(size=1, location=point((0, 0, -d/2+inset)))
    cutter = bpy.context.object
    cutter.dimensions = (w-.14, .007, .004)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    bpy.context.view_layer.objects.active = timber
    modifier = timber.modifiers.new('Recess for flush grip insert', 'BOOLEAN')
    modifier.operation = 'DIFFERENCE'
    modifier.object = cutter
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    bpy.data.objects.remove(cutter, do_unlink=True)
# Front lamination and narrow endgrain inserts show a constructed timber tread.
box('Rounded oak front lamination', (0, -.048, -d/2+.003), (w-.016, .066, .026), oak, .008)
for x in (-w/2+.006, w/2-.006):
    box('Endgrain cap', (x, -.045, .015), (.008, .068, d-.018), endgrain, .003)
box('Recessed brushed nosing carrier', (0, -.09, -d/2+.006), (w-.12, .023, .047), metal, .005)
# Grip surface is flush; no geometry floats above the foot contact plane.
for inset in (.04, .064):
    box('Flush ribbed anti slip inlay', (0, -.001, -d/2+inset), (w-.14, .002, .007), grip, .0005)
# Fine timber lamination seams only on the nosing face, below the walking plane.
for x in (-.98, -.49, 0, .49, .98):
    box('Nosing join', (x, -.049, -d/2-.0101), (.0015, .044, .001), endgrain, .0002)

group('stair-stringer')
# Recessed web and rolled flange edges replace the former solid cuboid spine.
box('Steel web', (0, 0, 0), (.052, .204, 1), structure, .003)
for y in (-.108, .108):
    box('Rolled steel flange', (0, y, 0), (.12, .024, 1), structure, .006)
for z in (-.47, .47):
    box('Stringer end connection plate', (0, 0, z), (.108, .184, .018), metal, .003)

group('stair-landing')
box('Honed limestone landing slab', (0, -.065, 0), (1, .13, 1), stone, .006)
# Continuous recessed fascia, with a fine metal join at the slab underside.
for z in (-.495, .495):
    box('Landing fascia inset', (0, -.094, z), (.984, .028, .006), structure, .001)
    box('Landing brushed edge joint', (0, -.123, z), (.984, .009, .006), metal, .001)
for x in (-.495, .495):
    box('Landing end fascia inset', (x, -.094, 0), (.006, .028, .984), structure, .001)

group('stair-handrail')
# Rounded rectangular grip, unobstructed lower LED channel stays app owned.
box('Ergonomic brushed handrail', (0, 0, 0), (.052, .036, 1), metal, .014)
for z in (-.495, .495):
    box('Flush rail end joint', (0, 0, z), (.047, .031, .006), structure, .008)

group('stair-shoe')
box('Glass base shoe', (0, 0, 0), (.058, .055, 1), metal, .004)
box('Recessed glazing gasket', (0, .0276, 0), (.031, .001, .994), grip, .0003)

group('stair-clamp')
# Axis X spans the glass; two rounded cheeks and a central collar give a real clamp.
for x in (-.023, .023):
    box('Rounded glass clamp cheek', (x, 0, 0), (.018, .066, .074), metal, .008)
    rod('Clamp socket bolt', (x-.010, 0, 0), (x+.010, 0, 0), .009, structure)
box('Clamp neoprene spacer', (0, 0, 0), (.028, .046, .052), grip, .004)

# Flatten per material within each module: immutable meshes are shared at runtime.
manifest = {}
triangles = 0
for name, root in roots.items():
    buckets = {}
    for child in list(root.children):
        buckets.setdefault(child.data.materials[0].name, []).append(child)
    for mat_name, objects in buckets.items():
        bpy.ops.object.select_all(action='DESELECT')
        for obj in objects:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = objects[0]
        if len(objects) > 1:
            bpy.ops.object.join()
        obj = bpy.context.object
        obj.name = name + ' / ' + mat_name
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        obj.parent = root
    points = []
    count = 0
    for child in root.children:
        child.data.calc_loop_triangles()
        count += len(child.data.loop_triangles)
        for v in child.data.vertices:
            p = child.matrix_world @ v.co
            points.append((p.x, p.z, -p.y))
    triangles += count
    manifest[name] = {'nominalDimensions': NOMINAL[name], 'min': [min(p[i] for p in points) for i in range(3)],
                      'max': [max(p[i] for p in points) for i in range(3)], 'triangles': count,
                      'meshes': len(root.children), 'materials': sorted(buckets), 'origin': [0, 0, 0]}
bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.gltf(filepath=os.path.join(args.output, 'stair-library.glb'), export_format='GLB', use_selection=True,
    export_yup=True, export_materials='EXPORT', export_extras=True, export_cameras=False, export_lights=False)
with open(os.path.join(args.output, 'stair-library.manifest.json'), 'w', encoding='utf-8') as output:
    json.dump({'schema': 1, 'coordinateSystem': scene['coordinate_system'], 'groups': manifest,
               'triangles': triangles, 'meshes': sum(g['meshes'] for g in manifest.values()),
               'materialPolicy': 'Immutable opaque authored materials; app owns glass, LED emitters and all lights.',
               'topContactY': 0}, output, indent=2)

# Editable library roots are kept in a labelled collection, inspection copies form a real flight.
library = bpy.data.collections.new('01 - Contract modules at zero')
scene.collection.children.link(library)
for root in roots.values():
    for obj in [root, *root.children]:
        for collection in list(obj.users_collection):
            collection.objects.unlink(obj)
        library.objects.link(obj)
library.hide_render = True
library.hide_viewport = True
review = bpy.data.collections.new('02 - Assembled stair inspection')
scene.collection.children.link(review)

def instance(name, pos, scale=(1, 1, 1), angle=0):
    source = roots[name]
    obj = bpy.data.objects.new('Review ' + name, None)
    review.objects.link(obj)
    obj.location = point(pos)
    obj.scale = (scale[0], scale[2], scale[1])
    obj.rotation_euler.x = angle
    for child in source.children:
        copy = child.copy()
        copy.data = child.data
        review.objects.link(copy)
        copy.parent = obj
    return obj

run, rise = 5.3, 3.2
slope = math.atan2(rise, run)
for i in range(18):
    instance('stair-tread', (0, rise/18*(i+1), -run/2+d*(i+.5)))
for x in (-w*.28, w*.28):
    instance('stair-stringer', (x, rise/2-.22, 0), (1, 1, math.hypot(run, rise)), -slope)
instance('stair-landing', (0, rise, run/2+.75), (3.09, 1, 1.5))
for x in (-1.51, 1.51):
    instance('stair-handrail', (x, rise/2+1.12, 0), (1, 1, math.hypot(run, rise)), -slope)
    instance('stair-shoe', (x, rise/2+.055, 0), (1, 1, math.hypot(run, rise)), -slope)
    for i in range(6):
        t = (i+.08)/5.16
        instance('stair-clamp', (x, rise*t+.15, run*(t-.5)))

world = bpy.data.worlds.new('Neutral inspection studio')
world.use_nodes = True
world.node_tree.nodes['Background'].inputs[0].default_value = (.64, .69, .74, 1)
world.node_tree.nodes['Background'].inputs[1].default_value = .6
scene.world = world
bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, -.22))
bpy.context.object.data.materials.append(material('Preview backdrop', 'd7d9d6', .9))
for loc, energy, size in (((-4, -3, 9), 1800, 7), ((4, 4, 8), 1300, 6)):
    bpy.ops.object.light_add(type='AREA', location=loc)
    bpy.context.object.data.energy = energy
    bpy.context.object.data.size = size
bpy.ops.object.camera_add(location=point((7, 6, -8)))
camera = bpy.context.object
camera.rotation_euler = (point((0, 1.7, .6))-camera.location).to_track_quat('-Z', 'Y').to_euler()
camera.data.type = 'ORTHO'
camera.data.ortho_scale = 10
scene.camera = camera
scene.render.engine = 'CYCLES'
scene.cycles.samples = 24
scene.render.resolution_x = 1600
scene.render.resolution_y = 1200
scene.render.resolution_percentage = 100
scene.view_settings.view_transform = 'AgX'
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(args.output, 'stair-library.blend'))
if args.preview:
    os.makedirs(os.path.dirname(os.path.abspath(args.preview)), exist_ok=True)
    scene.render.filepath = os.path.abspath(args.preview)
    bpy.ops.render.render(write_still=True)
print('STAIR_LIBRARY ' + json.dumps({'triangles': triangles, 'meshes': sum(g['meshes'] for g in manifest.values()), 'groups': list(roots)}))
