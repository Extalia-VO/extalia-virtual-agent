"""Author the project-generated campus EV chargers and cycle shelter in Blender.
Run Blender --background --factory-startup --python this-file -- --output <directory>.
Application coordinates map to Blender X/Z/-Y. Every vehicle, pickups included, is derived
separately (`prepare-campus-vehicles.py`, one licensed GLB each); the former procedural
single-cab truck is retired and its runtime name resolves to a derived pickup.
"""
import argparse
import json
import math
import os
import sys
import bpy
from mathutils import Vector

parser = argparse.ArgumentParser()
parser.add_argument('--output', default=os.path.join(os.path.dirname(__file__), '../../apps/web/local-assets/landscape'))
parser.add_argument('--preview')
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
os.makedirs(args.output, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.unit_settings.system = 'METRIC'
roots = {}
current = None

def material(name, rgb, metal=0, roughness=.5):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*rgb, 1)
    m.use_nodes = True
    p = m.node_tree.nodes.get('Principled BSDF')
    p.inputs['Base Color'].default_value = (*rgb, 1)
    p.inputs['Metallic'].default_value = metal
    p.inputs['Roughness'].default_value = roughness
    return m

white = material('Mobility warm ceramic', (.76, .8, .75), .22, .36)
rubber = material('Mobility tire and cable rubber', (.014, .018, .021), 0, .88)
glass = material('Mobility opaque blue grey glazing', (.06, .14, .18), .35, .23)
metal = material('Mobility brushed wheel alloy', (.32, .38, .4), .75, .3)
trim = material('Mobility charcoal trim', (.035, .055, .065), .4, .45)
head = material('Mobility lamp warm headlight', (1, .82, .48), .1, .3)
green = material('Mobility lamp charging indicator', (.08, .85, .55), .1, .3)
solar = material('Mobility shelter solar glass', (.025, .08, .12), .3, .35)

def group(name):
    global current
    current = bpy.data.objects.new(name, None)
    scene.collection.objects.link(current)
    roots[name] = current

def finish(obj, name, mat):
    obj.name = name
    obj.data.materials.append(mat)
    obj.parent = current
    return obj

def box(name, center, size, mat, bevel=0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=(center[0], -center[2], center[1]))
    obj = bpy.context.object
    obj.scale = (size[0], size[2], size[1])
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel:
        mod = obj.modifiers.new('Soft manufactured edge', 'BEVEL')
        mod.width = bevel
        mod.segments = 1
        bpy.ops.object.modifier_apply(modifier=mod.name)
    return finish(obj, name, mat)

group('mobility-charger')
box('Charging pedestal plinth', (0, .04, 0), (.72, .08, .55), trim, .025)
box('Rounded DC charging cabinet', (0, .88, 0), (.62, 1.64, .36), white, .08)
box('Recessed charging fascia', (0, 1.20, .185), (.45, .65, .025), trim, .025)
box('Charging status display', (0, 1.32, .205), (.32, .24, .016), glass, .015)
box('Charge LED status bar', (0, 1.11, .21), (.3, .035, .018), green, .006)
box('Cable holster', (.36, .86, .05), (.12, .25, .12), trim, .02)
curve = bpy.data.curves.new('Coiled charging cable', 'CURVE')
curve.dimensions = '3D'
curve.bevel_depth = .024
curve.bevel_resolution = 0
spline = curve.splines.new('POLY')
spline.points.add(17)
for i, point in enumerate(spline.points):
    a = i / 17 * math.pi * 1.7
    point.co = (.45 + .16 * math.sin(a), -.1 - .12 * math.cos(a), .64 + .38 * math.cos(a), 1)
obj = bpy.data.objects.new('Charging cable loop', curve)
scene.collection.objects.link(obj)
obj.parent = current
obj.data.materials.append(rubber)
bpy.context.view_layer.objects.active = obj
obj.select_set(True)
bpy.ops.object.convert(target='MESH')
obj.select_set(False)

group('mobility-cycle-shelter')
for x in [-2.1, 2.1]:
    for z in [-.9, .9]:
        box('Shelter slender steel column', (x, 1.25, z), (.09, 2.5, .09), trim, .008)
        box('Shelter post base shoe', (x, .06, z), (.2, .12, .2), metal, .008)
box('Cantilever bicycle canopy frame', (0, 2.54, 0), (4.7, .13, 2.45), trim, .025)
for i in range(6):
    box('Solar panel strip', (-1.88 + i * .75, 2.62, 0), (.71, .035, 2.25), solar, .008)
box('Cycle canopy warm strip', (0, 2.45, -.8), (3.8, .022, .035), head, .003)

# Keep each root at its contract origin; runtime merges immutable surfaces by role.
manifest = {}
for name, root in roots.items():
    bpy.context.view_layer.update()
    children = [o for o in root.children_recursive if o.type == 'MESH']
    bounds = [o.matrix_world @ Vector(c) for o in children for c in o.bound_box]
    app = [(p.x, p.z, -p.y) for p in bounds]
    tris = sum(sum(len(poly.vertices) - 2 for poly in o.data.polygons) for o in children)
    manifest[name] = {'min': [min(p[i] for p in app) for i in range(3)], 'max': [max(p[i] for p in app) for i in range(3)], 'triangles': tris}
assert sum(v['triangles'] for v in manifest.values()) < 8000
bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.gltf(filepath=os.path.join(args.output, 'campus-mobility.glb'), export_format='GLB', export_yup=True, export_extras=True, export_cameras=False, export_lights=False)
with open(os.path.join(args.output, 'campus-mobility.manifest.json'), 'w') as file:
    json.dump({'groups': manifest, 'triangles': sum(v['triangles'] for v in manifest.values())}, file, indent=2)
# Save editable collection, then arrange a separate preview.
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(args.output, 'campus-mobility.blend'))
if args.preview:
    for i, root in enumerate(roots.values()):
        root.location = ((i % 4 - 1.5) * 5.8, -(i // 4) * 7, 0)
    bpy.ops.object.light_add(type='AREA', location=(0, -5, 12))
    bpy.context.object.data.energy = 2200
    bpy.context.object.data.shape = 'DISK'
    bpy.context.object.data.size = 12
    bpy.ops.object.camera_add(location=(23, -31, 23))
    cam = bpy.context.object
    cam.rotation_euler = (Vector((0, -5, .7)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
    cam.data.type = 'ORTHO'
    cam.data.ortho_scale = 36
    scene.camera = cam
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 12
    scene.render.resolution_x = 1440
    scene.render.resolution_y = 1050
    scene.render.resolution_percentage = 100
    scene.world = bpy.data.worlds.new('Mobility studio world')
    scene.world.use_nodes = True
    scene.world.node_tree.nodes['Background'].inputs[0].default_value = (.36, .42, .50, 1)
    scene.world.node_tree.nodes['Background'].inputs[1].default_value = .8
    scene.render.filepath = args.preview
    bpy.ops.render.render(write_still=True)
print('MOBILITY_LIBRARY ' + json.dumps(manifest))
