"""Author the local wall/door library with nominal dimensions and animation pivots.

Blender --factory-startup --background --python tooling/blender/create-architecture-library.py -- --preview <png>
Generated assets are local-only. App X/Y/Z = Blender X/Z/-Y. Root transforms in
the GLB stay identity; the editable blend separates them for visual inspection.
"""
import argparse
import json
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
with open(os.path.join(REPO, 'apps/web/src/office/scene/interior/architectureAssetProfile.json')) as source:
    profile = json.load(source)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.name = 'Extalia interior architectural components'
scene.unit_settings.system = 'METRIC'
scene['coordinate_system'] = profile['coordinateSystem']
scene['profile'] = json.dumps(profile)


def point(p):
    return Vector((p[0], -p[2], p[1]))


def material(name, color, roughness=.5, metallic=0, alpha=1):
    rgb = tuple(int(color[i:i+2], 16) / 255 for i in (0, 2, 4))
    rgb = tuple(c / 12.92 if c <= .04045 else ((c + .055) / 1.055) ** 2.4 for c in rgb)
    result = bpy.data.materials.new(name)
    result.diffuse_color = (*rgb, alpha)
    result.use_nodes = True
    shader = result.node_tree.nodes['Principled BSDF']
    shader.inputs['Base Color'].default_value = (*rgb, 1)
    shader.inputs['Roughness'].default_value = roughness
    shader.inputs['Metallic'].default_value = metallic
    shader.inputs['Alpha'].default_value = alpha
    return result


alloy = material('Architecture powdercoat aluminium', '35494c', .43, .55)
seal = material('Architecture EPDM gasket and shadow reveal', '14262a', .82)
hardware = material('Architecture satin stainless hardware', 'aebdbb', .28, .85)
glass = material('Architecture glazing', 'b5dcdb', .16, alpha=.2)
glass.surface_render_method = 'DITHERED'
frost = material('Architecture etched safety bands', 'cee0da', .72, alpha=.62)
frost.surface_render_method = 'DITHERED'
paint = material('Architecture wall paint', 'e7e5dc', .89)
oak = material('Architecture warm oak rails', 'b08862', .64)
panel = material('Architecture recessed oak panels', 'b8936d', .71)
led = material('Architecture sensor LED', '54c5b9', .35)
shader = led.node_tree.nodes['Principled BSDF']
shader.inputs['Emission Color'].default_value = (.08, .65, .48, 1)
shader.inputs['Emission Strength'].default_value = 2
roots = {}
active = None


def finish(obj, name, mat, bevel=0):
    obj.name = name
    obj.data.materials.append(mat)
    if bevel:
        mod = obj.modifiers.new('Manufactured edge radius', 'BEVEL')
        mod.width = bevel
        mod.segments = 1 if min(obj.dimensions) < .04 else 2
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=mod.name)
        for poly in obj.data.polygons:
            poly.use_smooth = True
        normal = obj.modifiers.new('Weighted broad face normals', 'WEIGHTED_NORMAL')
        normal.keep_sharp = True
        bpy.ops.object.modifier_apply(modifier=normal.name)
    obj.parent = active
    return obj


def box(name, center, size, mat, bevel=.002):
    bpy.ops.mesh.primitive_cube_add(size=1, location=point(center))
    obj = bpy.context.object
    obj.dimensions = (size[0], size[2], size[1])
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish(obj, name, mat, min(bevel, min(size) * .25))


def rod(name, a, b, radius, mat):
    start, end = point(a), point(b)
    bpy.ops.mesh.primitive_cylinder_add(vertices=12, radius=radius, depth=(end-start).length, location=(start+end)/2)
    obj = bpy.context.object
    obj.rotation_euler = (end-start).to_track_quat('Z', 'Y').to_euler()
    return finish(obj, name, mat, .001)


def group(name):
    global active
    active = bpy.data.objects.new(name, None)
    scene.collection.objects.link(active)
    active['architecture_part'] = name
    active['nominal_dimensions'] = [profile['models'][name][key] for key in ('width', 'height', 'depth')]
    active['origin_contract'] = profile['models'][name]['origin']
    roots[name] = active


def trim_rectangle(name, left, right, bottom, top, width, depth, mat, z=0):
    # All rails stay inside the supplied silhouette; glazing fills the aperture.
    for x in (left+width/2, right-width/2):
        box(name+' stile', (x, (bottom+top)/2, z), (width, top-bottom, depth), mat)
    for y in (bottom+width/2, top-width/2):
        box(name+' rail', ((left+right)/2, y, z), (right-left-2*width, width, depth), mat)


def glazed(left, right, bottom, top, depth, leaf=False):
    trim_rectangle('Slim powdercoat section', left, right, bottom, top, .035, depth, alloy)
    trim_rectangle('Continuous dark glazing seal', left+.033, right-.033, bottom+.033, top-.033, .009, .027, seal)
    box('Clear glazing', ((left+right)/2, (bottom+top)/2, 0), (right-left-.078, top-bottom-.078, .014), glass, .0008)
    if top-bottom > 1:
        for y in (bottom+(top-bottom)*.43, bottom+(top-bottom)*.47):
            for z in (-.008, .008):
                box('Etched safety stripe', ((left+right)/2, y, z), (right-left-.09, .018, .001), frost, .0002)
    if leaf:
        # Two-face levers retain the choreography's stem/contact point exactly.
        x, y = .82, (top-bottom)/2
        for sign in (-1, 1):
            rod('Lever escutcheon', (x, y, sign*.029), (x, y, sign*.038), .024, hardware)
            rod('Lever stem', (x, y, sign*.035), (x, y, sign*.10), .012, hardware)
            rod('Rounded horizontal lever', (x-.145, y, sign*.10), (x+.005, y, sign*.10), .012, hardware)


for name, height in (('architecture-glass-panel', 2.55), ('architecture-glass-transom', .4)):
    group(name)
    glazed(-.5, .5, -height/2, height/2, .11)

group('architecture-solid-wall')
# A real inset skirting and fine upper shadow line, within the wall thickness.
box('Plaster wall body', (0, .03, 0), (1, 2.43, .11), paint, .003)
box('Recessed skirting', (0, -1.235, 0), (1, .08, .085), alloy, .002)
box('Skirting shadow joint', (0, -1.190, 0), (1, .01, .089), seal, .001)
box('Plaster top cap', (0, 1.26, 0), (1, .03, .11), paint, .003)


def doorway_frame(name, width, height, depth, sliding=False):
    group(name)
    # Never intrude on x +/- width/2, y 0..height. Opening stays unobstructed.
    jamb = .065
    for sign in (-1, 1):
        x = sign*(width/2+jamb/2)
        box('Outer structural jamb', (x, height/2, 0), (jamb, height, depth), alloy, .004)
        for z in (-depth/2-.006, depth/2+.006):
            box('Casing shadow reveal', (sign*(width/2+.052), height/2, z), (.014, height, .012), seal, .002)
            box('Casing fine lip', (sign*(width/2+.075), height/2, z), (.026, height, .018), alloy, .003)
    box('Head section', (0, height+.04, 0), (width+2*jamb, .08, depth), alloy, .004)
    for z in (-depth/2-.006, depth/2+.006):
        box('Head reveal', (0, height+.055, z), (width+.17, .014, .012), seal, .002)
        box('Head casing lip', (0, height+.078, z), (width+.176, .026, .018), alloy, .003)
    if sliding:
        # Runtime leaves span .49w and travel another .88 leaf widths outward:
        # each open outer edge reaches .9212w from center. Support the full run.
        box('Sliding header motor cover', (0, height+.112, 0), (1.85*width+.18, .064, .24), alloy, .008)
        box('Recessed sliding rail', (0, height+.015, .095), (1.85*width+.06, .023, .025), seal, .002)
        box('Presence sensor enclosure', (0, height+.103, .133), (.22, .042, .032), seal, .008)
        box('Sensor LED strip', (0, height+.103, .151), (.074, .007, .004), led, .001)
        active['clear_opening'] = [-width/2, width/2, 0, height]
    else:
        for y in (.34, height/2, height-.34):
            rod('Jamb hinge knuckle', (-width/2-.015, y-.042, .035), (-width/2-.015, y+.042, .035), .012, hardware)
        active['clear_opening'] = [-width/2, width/2, 0, height]


doorway_frame('architecture-hinged-frame', 1, 2.55, .14)
group('architecture-hinged-glass-leaf')
glazed(0, 1, 0, 2.55, .055, True)
for y in (.34, 1.275, 2.21):
    rod('Flush hinge knuckle', (.012, y-.04, 0), (.012, y+.04, 0), .012, hardware)

group('architecture-hinged-wood-leaf')
# Full silhouette at contract dimensions, inset infill makes recessed panels.
box('Solid timber core', (.5, 1.275, 0), (1, 2.55, .041), oak, .004)
trim_rectangle('Oak face perimeter', 0, 1, 0, 2.55, .10, .055, oak)
box('Oak central lock rail', (.5, 1.275, 0), (.8, .14, .055), oak, .003)
for low, high in ((.10, 1.205), (1.345, 2.45)):
    for sign in (-1, 1):
        trim_rectangle('Recessed panel shadow', .105, .895, low+.006, high-.006, .012, .003, seal, sign*.022)
        box('Recessed oak infill', (.5, (low+high)/2, sign*.022), (.754, high-low-.036, .003), panel, .002)
        # Sparse long-grain accent, physically shallow and subordinate to panel.
        for x in (.32, .61, .72):
            box('Fine timber grain inlay', (x, (low+high)/2, sign*.0237), (.0015, high-low-.09, .0005), oak, .0001)
for sign in (-1, 1):
    rod('Lever escutcheon', (.82, 1.275, sign*.029), (.82, 1.275, sign*.038), .024, hardware)
    rod('Lever contact stem', (.82, 1.275, sign*.035), (.82, 1.275, sign*.10), .012, hardware)
    rod('Rounded horizontal lever', (.675, 1.275, sign*.10), (.825, 1.275, sign*.10), .012, hardware)
for y in (.34, 1.275, 2.21):
    rod('Flush hinge knuckle', (.012, y-.04, 0), (.012, y+.04, 0), .012, hardware)

doorway_frame('architecture-sliding-frame', 2.4, 2.65, .16, True)
group('architecture-sliding-leaf')
glazed(-.5, .5, 0, 2.65, .045)
for sign in (-1, 1):
    for y in (1.03, 1.27):
        rod('Sliding pull standoff', (.41, y, sign*.022), (.41, y, sign*.085), .009, hardware)
    rod('Sliding vertical pull', (.41, 1.00, sign*.085), (.41, 1.30, sign*.085), .012, hardware)

# Material batches preserve the root pivots while reducing each part to <=6 draws.
manifest = {}
for name, root in roots.items():
    batches = {}
    for child in list(root.children):
        batches.setdefault(child.data.materials[0].name, []).append(child)
    for material_name, objects in batches.items():
        bpy.ops.object.select_all(action='DESELECT')
        for obj in objects:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = objects[0]
        if len(objects) > 1:
            bpy.ops.object.join()
        obj = bpy.context.object
        obj.name = name+' / '+material_name
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        obj.parent = root
    bpy.context.view_layer.update()
    corners = [child.matrix_world @ Vector(c) for child in root.children for c in child.bound_box]
    app = [(c.x, c.z, -c.y) for c in corners]
    mins = [min(c[i] for c in app) for i in range(3)]
    maxs = [max(c[i] for c in app) for i in range(3)]
    triangles = sum(len(poly.vertices)-2 for child in root.children for poly in child.data.polygons)
    manifest[name] = {'origin': [0, 0, 0], 'min': mins, 'max': maxs, 'triangles': triangles,
                      'meshes': len(root.children), 'materials': list(batches)}
    assert len(root.children) <= 6, name
triangles = sum(part['triangles'] for part in manifest.values())
assert triangles < 30000, triangles
bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.gltf(filepath=os.path.join(args.output, 'interior-architecture.glb'), export_format='GLB',
                          use_selection=True, export_yup=True, export_materials='EXPORT', export_extras=True,
                          export_cameras=False, export_lights=False, export_animations=False)
with open(os.path.join(args.output, 'interior-architecture.manifest.json'), 'w') as out:
    json.dump({'profile': profile, 'groups': manifest, 'triangles': triangles,
               'meshes': sum(part['meshes'] for part in manifest.values())}, out, indent=2)

# Inspection layout is separate from the export; each root retains its local pivot.
placements = [(-4.6, 1.275, 1.0), (-3.05, 2.95, 1.0), (-3.05, 1.275, 1.0),
              (-1.4, 0, 1), (-.1, 0, .65), (1.2, 0, 1), (3.8, 0, 1), (3.8, 0, .6)]
for root, placement in zip(roots.values(), placements):
    root.location = point(placement)
scene['export_origin_note'] = 'GLB roots are identity; blend components are separated for inspection.'
world = bpy.data.worlds.new('Architecture soft studio world')
world.use_nodes = True
world.node_tree.nodes['Background'].inputs[0].default_value = (.65, .72, .76, 1)
world.node_tree.nodes['Background'].inputs[1].default_value = .55
scene.world = world
active = None
box('Preview floor', (0, -.045, 0), (200, .06, 200), material('Preview warm floor', 'dcd9cd', .9), 0)
for location, energy, size in (((-4, -6, 8), 1800, 7), ((5, 2, 7), 1400, 6), ((0, 5, 5), 1000, 5)):
    bpy.ops.object.light_add(type='AREA', location=location)
    light = bpy.context.object
    light.data.energy = energy
    light.data.size = size
    light.rotation_euler = (Vector((0, 0, 1))-light.location).to_track_quat('-Z', 'Y').to_euler()
bpy.ops.object.camera_add(location=(8, -15, 7))
camera = bpy.context.object
camera.rotation_euler = (Vector((.1, -.7, 1.3))-camera.location).to_track_quat('-Z', 'Y').to_euler()
camera.data.type = 'ORTHO'
camera.data.ortho_scale = 13.4
scene.camera = camera
scene.render.engine = 'CYCLES'
scene.cycles.samples = 32
scene.render.resolution_x = 2200
scene.render.resolution_y = 1000
scene.render.resolution_percentage = 100
scene.view_settings.view_transform = 'AgX'
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(args.output, 'interior-architecture.blend'))
if args.preview:
    os.makedirs(os.path.dirname(os.path.abspath(args.preview)), exist_ok=True)
    scene.render.filepath = os.path.abspath(args.preview)
    bpy.ops.render.render(write_still=True)
print('ARCHITECTURE_LIBRARY '+json.dumps({'roots': len(roots), 'triangles': triangles,
                                        'meshes': sum(part['meshes'] for part in manifest.values())}), flush=True)
