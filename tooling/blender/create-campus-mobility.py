"""Author lightweight local campus vehicles, EV chargers and cycle shelters in Blender.
Run Blender --background --factory-startup --python this-file -- --output <directory>.
Binary assets remain local; application coordinates map to Blender X/Z/-Y.
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

paint = material('Mobility pearl enamel', (.44, .57, .59), .35, .3)
white = material('Mobility warm ceramic', (.76, .8, .75), .22, .36)
rubber = material('Mobility tire and cable rubber', (.014, .018, .021), 0, .88)
glass = material('Mobility opaque blue grey glazing', (.06, .14, .18), .35, .23)
metal = material('Mobility brushed wheel alloy', (.32, .38, .4), .75, .3)
trim = material('Mobility charcoal trim', (.035, .055, .065), .4, .45)
head = material('Mobility lamp warm headlight', (1, .82, .48), .1, .3)
tail = material('Mobility lamp red taillight', (.85, .05, .025), .1, .35)
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

VEHICLES = {
    'mobility-sedan': dict(length=4.46, width=1.79, height=1.45, wheel=.30, cabinZ=-.14, cabinLength=2.35, cabinBase=.77, windows=2, cargo=False),
    'mobility-suv': dict(length=4.67, width=1.90, height=1.82, wheel=.36, cabinZ=-.17, cabinLength=3.07, cabinBase=.84, windows=3, cargo=False),
    'mobility-jeep': dict(length=4.10, width=1.88, height=1.89, wheel=.38, cabinZ=-.28, cabinLength=2.50, cabinBase=.85, windows=2, cargo=False),
    'mobility-mpv': dict(length=4.91, width=1.89, height=1.86, wheel=.32, cabinZ=-.10, cabinLength=3.83, cabinBase=.78, windows=3, cargo=False),
    'mobility-hatchback': dict(length=3.82, width=1.72, height=1.50, wheel=.29, cabinZ=-.25, cabinLength=2.65, cabinBase=.76, windows=2, cargo=False),
    'mobility-truck': dict(length=5.02, width=1.93, height=1.90, wheel=.36, cabinZ=.92, cabinLength=1.86, cabinBase=.84, windows=1, cargo=True),
    'mobility-double-cabin': dict(length=5.02, width=1.95, height=1.84, wheel=.35, cabinZ=.40, cabinLength=2.74, cabinBase=.83, windows=2, cargo=True),
    'mobility-ev': dict(length=4.12, width=1.80, height=1.53, wheel=.31, cabinZ=-.10, cabinLength=2.60, cabinBase=.76, windows=2, cargo=False),
}


def wheel(x, z, radius):
    bpy.ops.mesh.primitive_cylinder_add(vertices=12, radius=radius, depth=.19, location=(x, -z, radius), rotation=(0, math.pi / 2, 0))
    finish(bpy.context.object, 'Sculpted road tire', rubber)
    bpy.ops.mesh.primitive_cylinder_add(vertices=10, radius=radius * .67, depth=.195, location=(x, -z, radius), rotation=(0, math.pi / 2, 0))
    finish(bpy.context.object, 'Recessed alloy wheel hub', metal)


def roof_rail(x, height, z, length):
    for offset in [-length * .35, length * .35]:
        box('Roof rail mounting foot', (x, height + .035, z + offset), (.06, .07, .09), trim)
    box('Longitudinal roof rail', (x, height + .09, z), (.055, .045, length * .85), metal, .015)


def vehicle(name, spec):
    group(name)
    current['vehicle_style'] = name.removeprefix('mobility-')
    current['vehicle_spec'] = spec
    length, width, height, radius = (spec[k] for k in ('length', 'width', 'height', 'wheel'))
    cabin_z, cabin_length, cabin_base = (spec[k] for k in ('cabinZ', 'cabinLength', 'cabinBase'))
    body = white if name in ('mobility-ev', 'mobility-mpv') else paint
    body_y = radius + .25
    if spec['cargo']:
        # A low chassis plus an actual open cargo bed gives pickups a different
        # silhouette from the passenger vehicles, rather than a coloured van box.
        box('Commercial ladder chassis', (0, radius + .10, 0), (width * .91, .24, length), trim, .025)
        front_length = length / 2 - (cabin_z - cabin_length / 2)
        front_z = (length / 2 + cabin_z - cabin_length / 2) / 2
        box('Commercial cab lower body', (0, body_y, front_z), (width, .59, front_length), body, .08)
        bed_front = cabin_z - cabin_length / 2 - .10
        bed_back = -length / 2 + .08
        bed_length = bed_front - bed_back
        bed_z = (bed_front + bed_back) / 2
        box('Open cargo bed floor', (0, .66, bed_z), (width, .12, bed_length), trim, .02)
        for side in [-1, 1]:
            box('Cargo bed side wall', (side * (width / 2 - .055), .91, bed_z), (.11, .48, bed_length), body, .025)
            box('Bed liner upper rail', (side * (width / 2 - .055), 1.16, bed_z), (.12, .045, bed_length), trim, .01)
        for z in [bed_back, bed_front]:
            box('Cargo bed headboard or tailgate', (0, .91, z), (width, .48, .10), body, .02)
        box('Tailgate handle', (0, 1.03, bed_back - .06), (.23, .045, .025), trim, .006)
    else:
        box('Rounded vehicle lower body', (0, body_y, 0), (width, .58, length), body, .12 if name != 'mobility-jeep' else .045)
    cabin_width = width * .84
    box('Raised passenger cabin', (0, (height + cabin_base) / 2, cabin_z), (cabin_width, height - cabin_base, cabin_length), body, .11 if name != 'mobility-jeep' else .035)
    window_height = min(.43, height - cabin_base - .15)
    window_y = height - window_height / 2 - .085
    front = cabin_z + cabin_length / 2
    rear = cabin_z - cabin_length / 2
    box('Front windscreen', (0, window_y, front + .018), (cabin_width * .89, window_height, .035), glass, .015)
    box('Rear windscreen', (0, window_y, rear - .018), (cabin_width * .87, window_height * .92, .035), glass, .015)
    for side in [-1, 1]:
        bay = cabin_length / spec['windows']
        for i in range(spec['windows']):
            z = rear + bay * (i + .5)
            box('Divided side window', (side * (cabin_width / 2 + .012), window_y, z), (.025, window_height, bay * .80), glass, .012)
            box('Recessed door handle', (side * (width / 2 + .012), cabin_base + .05, z - bay * .18), (.025, .035, .16), metal, .006)
        box('Body sill skirt', (side * (width / 2 - .025), radius + .01, 0), (.10, .12, length * .76), trim, .015)
        box('Side mirror', (side * (width / 2 + .015), cabin_base + .23, front - .18), (.12, .12, .21), body, .02)
        for z in [-length * .31, length * .31]:
            wheel(side * (width * .46), z, radius)
            if name in ('mobility-jeep', 'mobility-suv', 'mobility-double-cabin'):
                box('Off-road wheel arch shoulder', (side * (width / 2 + .02), radius * 1.85, z), (.12, .11, radius * 2.15), trim, .025)
        box('Front LED headlamp', (side * (width * .33), radius + .36, length / 2 + .012), (.38, .11, .035), head, .015)
        box('Rear LED lamp', (side * (width * .34), radius + .36, -length / 2 - .012), (.30, .13, .035), tail, .015)
        if name in ('mobility-suv', 'mobility-mpv', 'mobility-jeep'):
            roof_rail(side * cabin_width * .39, height, cabin_z, cabin_length)
    box('Front lower grille', (0, radius + .16, length / 2 + .018), (.76, .13, .04), trim, .015)
    box('Front number plate', (0, radius + .30, length / 2 + .04), (.30, .075, .012), white, .003)
    box('Rear bumper', (0, radius + .07, -length / 2), (width * .86, .13, .08), trim, .02)
    if name == 'mobility-jeep':
        # Upright grille, separate off-road arches and a rear-mounted spare wheel.
        for x in [-.30, -.20, -.10, 0, .10, .20, .30]:
            box('Upright off-road grille slot', (x, .78, length / 2 + .025), (.045, .29, .04), trim, .008)
        for mat, r, z, depth in [(rubber, radius, -length / 2 - .16, .21), (metal, radius * .63, -length / 2 - .275, .025)]:
            bpy.ops.mesh.primitive_cylinder_add(vertices=12, radius=r, depth=depth, location=(0, -z, 1.01), rotation=(math.pi / 2, 0, 0))
            finish(bpy.context.object, 'Rear-mounted off-road spare wheel', mat)
    elif name == 'mobility-sedan':
        box('Separate sedan boot lid', (0, .87, rear - .36), (width * .91, .10, .65), body, .04)
    elif name in ('mobility-hatchback', 'mobility-ev'):
        box('Compact rear hatch spoiler', (0, height - .015, rear - .055), (cabin_width + .12, .065, .16), trim, .02)
    elif name == 'mobility-mpv':
        for side in [-1, 1]:
            box('Sliding-door track', (side * (width / 2 + .02), .96, cabin_z - .48), (.026, .035, 1.25), trim, .005)


for vehicle_name, vehicle_spec in VEHICLES.items():
    vehicle(vehicle_name, vehicle_spec)

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
    children = [o for o in root.children if o.type == 'MESH']
    bounds = [o.matrix_world @ Vector(c) for o in children for c in o.bound_box]
    app = [(p.x, p.z, -p.y) for p in bounds]
    tris = sum(sum(len(poly.vertices) - 2 for poly in o.data.polygons) for o in children)
    manifest[name] = {'min': [min(p[i] for p in app) for i in range(3)], 'max': [max(p[i] for p in app) for i in range(3)], 'triangles': tris, 'vehicle': VEHICLES.get(name)}
assert sum(v['triangles'] for v in manifest.values()) < 24000
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
