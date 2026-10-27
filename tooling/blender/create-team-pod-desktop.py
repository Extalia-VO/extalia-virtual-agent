"""Author the four-person desktop with inward seat bays, in a separate Blender process.

Run: Blender --background --python tooling/blender/create-team-pod-desktop.py
Optional args after --: --output <directory> --preview <png-path>
App X/Y/Z = Blender X/Z/-Y, in metres. Animated seats, devices and accessories remain in the app.
"""
import argparse
import json
import math
import os
import sys
import bpy
from mathutils import Vector

repo = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
parser = argparse.ArgumentParser()
parser.add_argument("--output", default=os.path.join(repo, "apps/web/local-assets/furniture"))
parser.add_argument("--preview")
args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
os.makedirs(args.output, exist_ok=True)
with open(os.path.join(repo, "apps/web/src/office/scene/interior/teamPodDesktopProfile.json")) as file:
    profile = json.load(file)
s, r, n = profile["halfExtent"], profile["bayRadius"], profile["arcSegments"]
quadrant = [(s, 0)]
for i in range(n + 1):
    a = i / n * math.pi / 2
    quadrant.append((s - r * math.sin(a), s - r * math.cos(a)))
outline = []
for turn in range(4):
    for x, z in quadrant:
        outline.append([(x, z), (-z, x), (-x, -z), (z, -x)][turn])

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.name = "Extalia four-person desk - inward seating bays"
scene.unit_settings.system = "METRIC"
scene["profile"] = json.dumps(profile)
scene["coordinate_system"] = "app X/Y/Z = Blender X/Z/-Y"


def material(name, hex_color, roughness):
    def linear(c):
        return c / 12.92 if c <= .04045 else ((c + .055) / 1.055) ** 2.4
    rgb = tuple(linear(int(hex_color[i:i+2], 16) / 255) for i in (0, 2, 4))
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*rgb, 1)
    mat.use_nodes = True
    node = mat.node_tree.nodes.get("Principled BSDF")
    node.inputs["Base Color"].default_value = (*rgb, 1)
    node.inputs["Roughness"].default_value = roughness
    return mat


wood = material("Warm oak - desktop", "bf9367", .72)
edge = material("Oak - rounded edge band", "a77e58", .76)
count = len(outline)
vertices = [(x, -z, y) for y in (profile["top"] - profile["thickness"], profile["top"]) for x, z in outline]
faces = [tuple(reversed(range(count))), tuple(range(count, count * 2))]
faces += [(i, (i+1)%count, (i+1)%count+count, i+count) for i in range(count)]
mesh = bpy.data.meshes.new("Four inward bays - solid oak surface")
mesh.from_pydata(vertices, [], faces)
mesh.update()
obj = bpy.data.objects.new("TeamPodDesktop", mesh)
scene.collection.objects.link(obj)
obj.data.materials.append(wood)
obj.data.materials.append(edge)
for poly in obj.data.polygons:
    poly.material_index = 0 if poly.index == 1 else 1
bpy.context.view_layer.objects.active = obj
obj.select_set(True)
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode="OBJECT")
bevel = obj.modifiers.new("Soft shoulder and tabletop edges", "BEVEL")
bevel.width = profile["edgeRadius"]
bevel.segments = 3
bevel.affect = "EDGES"
bevel.material = 1
bpy.ops.object.modifier_apply(modifier=bevel.name)
for poly in obj.data.polygons:
    poly.use_smooth = True
normal = obj.modifiers.new("Weighted planar normals", "WEIGHTED_NORMAL")
normal.keep_sharp = True
bpy.ops.object.modifier_apply(modifier=normal.name)

# The complete fixed structure is authored here: open kneespace, narrow steel legs,
# recessed cross-frame, cable spine, and four independently clamped glass screens.
steel = material("Powder coated graphite - structure", "637174", .52)
rubber = material("Adjustable levelling feet", "303b3c", .85)
glass = material("Clear bluegrey - rounded privacy screens", "c3d7d3", .2)
glass.node_tree.nodes["Principled BSDF"].inputs["Alpha"].default_value = .23
glass.diffuse_color = (*glass.diffuse_color[:3], .23)
glass.surface_render_method = "DITHERED"


def finish_part(part, name, mat, radius=0):
    part.name = name
    part.data.materials.append(mat)
    bpy.context.view_layer.objects.active = part
    if radius:
        mod = part.modifiers.new("Rounded manufactured edges", "BEVEL")
        mod.width = radius
        mod.segments = 3
        bpy.ops.object.modifier_apply(modifier=mod.name)
    for face in part.data.polygons:
        face.use_smooth = True
    mod = part.modifiers.new("Weighted planar normals", "WEIGHTED_NORMAL")
    mod.keep_sharp = True
    bpy.ops.object.modifier_apply(modifier=mod.name)
    return part


def box(name, center, size, mat=steel, radius=.006):
    x, y, z = center
    bpy.ops.mesh.primitive_cube_add(size=1, location=(x, -z, y))
    part = bpy.context.object
    part.dimensions = (size[0], size[2], size[1])
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish_part(part, name, mat, radius)


def cylinder(name, x, z, y, height, radius, mat=steel):
    bpy.ops.mesh.primitive_cylinder_add(vertices=16, radius=radius, depth=height, location=(x, -z, y))
    return finish_part(bpy.context.object, name, mat, .002)


underside = profile["top"] - profile["thickness"]
foot_h = profile["footHeight"]
leg_height = underside - foot_h
for x, z in ((profile["legOffset"], 0), (-profile["legOffset"], 0), (0, profile["legOffset"]), (0, -profile["legOffset"])):
    box("PodLeg", (x, foot_h + leg_height/2, z), (profile["legWidth"], leg_height, profile["legWidth"]))
    cylinder("PodFoot", x, z, foot_h/2, foot_h, profile["footRadius"], rubber)
rail_y = underside - profile["frameHeight"]/2
for axis in (0, 1):
    box("PodFrame", (0, rail_y, 0), (2.62 if axis == 0 else .055, profile["frameHeight"], .055 if axis == 0 else 2.62))
box("PodCableSpine", (0, underside/2, 0), (profile["columnWidth"], underside, profile["columnWidth"]), radius=.012)
cylinder("PodDividerPost", 0, 0, (profile["top"]+profile["dividerTop"])/2, profile["dividerTop"]-profile["top"], .014)
for x in (-.15, .15):
    for z in (-.15, .15):
        cylinder("PodCableGrommet", x, z, profile["top"]+.003, .006, .035)
        cylinder("PodCableGrommetInset", x, z, profile["top"]+.006, .004, .026, rubber)


def panel(axis, sign):
    start, end = profile["dividerStart"], profile["dividerEnd"]
    bottom, top = profile["dividerBottom"], profile["dividerTop"]
    rad = profile["dividerCornerRadius"]
    path = []
    for cx, cy, angle in ((end-rad, top-rad, 0), (start+rad, top-rad, 90), (start+rad, bottom+rad, 180), (end-rad, bottom+rad, 270)):
        for k in range(7):
            a = math.radians(angle+k*90/6)
            path.append((cx+rad*math.cos(a), cy+rad*math.sin(a)))
    verts = []
    for depth in (-profile["dividerThickness"]/2, profile["dividerThickness"]/2):
        for along, y in path:
            x, z = (sign*along, depth) if axis == 0 else (depth, sign*along)
            verts.append((x, -z, y))
    m = len(path)
    faces = [tuple(reversed(range(m))), tuple(range(m, 2*m))]
    faces += [(k, (k+1)%m, (k+1)%m+m, k+m) for k in range(m)]
    data = bpy.data.meshes.new("Rounded tempered glass")
    data.from_pydata(verts, [], faces)
    data.update()
    part = bpy.data.objects.new("PodDividerGlass", data)
    scene.collection.objects.link(part)
    bpy.ops.object.select_all(action="DESELECT")
    part.select_set(True)
    bpy.context.view_layer.objects.active = part
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    finish_part(part, "PodDividerGlass", glass)
    for along in profile["clampPositions"]:
        x, z = (sign*along, 0) if axis == 0 else (0, sign*along)
        box("PodDividerClamp", (x, profile["top"]+.027, z), (.055, .054, .025) if axis == 0 else (.025, .054, .055), radius=.005)
        box("PodDividerClampFoot", (x, profile["top"]+.004, z), (.065, .008, .045) if axis == 0 else (.045, .008, .065), radius=.003)


for axis in (0, 1):
    for sign in (-1, 1):
        panel(axis, sign)
bpy.ops.object.select_all(action="SELECT")
out = os.path.join(args.output, "team-pod-desktop.glb")
bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", use_selection=True, export_apply=True,
    export_yup=True, export_animations=False, export_cameras=False, export_lights=False)

# Studio objects never enter the runtime export.
floor_mat = material("Studio floor", "e4e8e3", .9)
bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, -.012))
bpy.context.object.data.materials.append(floor_mat)
scene.world = bpy.data.worlds.new("Studio world")
scene.world.use_nodes = True
scene.world.node_tree.nodes["Background"].inputs[0].default_value = (.7, .74, .77, 1)
scene.world.node_tree.nodes["Background"].inputs[1].default_value = .5
bpy.ops.object.light_add(type="AREA", location=(-3, -4, 7))
bpy.context.object.data.energy = 750
bpy.context.object.data.size = 5
bpy.ops.object.camera_add(location=(4, -5, 6.5))
camera = bpy.context.object
camera.rotation_euler = (Vector((0, 0, .55))-camera.location).to_track_quat("-Z", "Y").to_euler()
camera.data.type = "ORTHO"
camera.data.ortho_scale = 4.5
scene.camera = camera
scene.render.engine = "CYCLES"
scene.cycles.samples = 24
scene.render.resolution_x = 1200
scene.render.resolution_y = 1000
scene.render.resolution_percentage = 100
scene.view_settings.view_transform = "AgX"
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(args.output, "team-pod-desktop.blend"))
with open(os.path.join(args.output, "team-pod-desktop.manifest.json"), "w") as file:
    json.dump({"revision": "concave-open-frame-2", "profile": profile, "file": os.path.basename(out),
        "bytes": os.path.getsize(out), "runtime_owns": ["chairs", "devices", "accessories"]}, file, indent=2)
if args.preview:
    os.makedirs(os.path.dirname(os.path.abspath(args.preview)), exist_ok=True)
    scene.render.filepath = os.path.abspath(args.preview)
    bpy.ops.render.render(write_still=True)
print("POD_EXPORTED", os.path.basename(out), os.path.getsize(out), flush=True)
