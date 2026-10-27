"""Author the local work-chair set in Blender, then export app-ready GLBs.

Run: Blender --background --python tooling/blender/create-office-chairs.py
Optional args after --: --output <directory> --preview <png-path>
Metres; app X/Y/Z = Blender X/Z/-Y. All work is in a new scene; no source file is opened.
The script is source-controlled; generated .blend/.glb files stay in ignored local-assets.
"""
import argparse
import json
import math
import os
import sys
import bpy
from mathutils import Vector

parser = argparse.ArgumentParser()
parser.add_argument("--output", default=os.path.abspath(os.path.join(os.path.dirname(__file__), "../../apps/web/local-assets/furniture")))
parser.add_argument("--preview")
args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
os.makedirs(args.output, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.name = "Extalia ergonomic work chairs"
scene.unit_settings.system = "METRIC"
scene["coordinate_system"] = "app X/Y/Z = Blender X/Z/-Y; floor origin; sitter faces app +Z"
scene["revision"] = "ergonomic-1"


def point(p):
    return Vector((p[0], -p[2], p[1]))


def material(name, color, roughness, metal=0):
    # Hex values are sRGB, Blender's shader colors are linear.
    def linear(c):
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    rgb = tuple(linear(int(color[i:i+2], 16) / 255) for i in (0, 2, 4))
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*rgb, 1)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*rgb, 1)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metal
    return m


frame = material("Graphite polymer", "303b3c", .62)
metal = material("Brushed aluminium", "77817f", .36, .7)
rubber = material("Soft caster tyres", "242b2d", .85)
task = material("Task woven teal", "516368", .92)
executive = material("Executive warm upholstery", "d8d0c1", .88)
seam = material("Upholstery piping", "83928d", .85)
objects = []


def finish(obj, name, mat, bevel=0):
    obj.name = name
    obj.data.materials.append(mat)
    if bevel:
        mod = obj.modifiers.new("Soft manufactured edges", "BEVEL")
        mod.width = bevel
        mod.segments = 3
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=mod.name)
    for poly in obj.data.polygons:
        poly.use_smooth = True
    mod = obj.modifiers.new("Weighted corner normals", "WEIGHTED_NORMAL")
    mod.keep_sharp = True
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=mod.name)
    objects.append(obj)
    return obj


def box(name, center, size, mat, bevel=.01):
    bpy.ops.mesh.primitive_cube_add(size=1, location=point(center))
    obj = bpy.context.object
    obj.dimensions = (size[0], size[2], size[1])
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish(obj, name, mat, bevel)


def cylinder(name, a, b, radius, mat, vertices=12):
    start, end = point(a), point(b)
    direction = end - start
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=direction.length, location=(start+end)/2)
    obj = bpy.context.object
    obj.rotation_euler = direction.to_track_quat("Z", "Y").to_euler()
    return finish(obj, name, mat, .003)


def back(name, height, mat, shell=False):
    # Rounded horizontal cross-sections create a tapered, S-shaped lumbar back.
    rings = [(0, .17), (.025, .205), (.10, .23), (.30, .23), (.61, .25), (.90, .24), (.98, .215), (1, .185)]
    verts, faces = [], []
    count = 20
    for t, width in rings:
        y = .46 + t * height
        z = -.225 - .010 * t + .028 * math.exp(-((t-.30)/.22)**2)
        if shell:
            width += .015
            z -= .025
        for k in range(count):
            angle = 2 * math.pi * k / count
            c, s = math.cos(angle), math.sin(angle)
            # Broad gently curved front, with soft side returns.
            x = width * math.copysign(abs(c)**.55, c)
            depth = (.035 if shell else .027) * math.copysign(abs(s)**.65, s)
            verts.append(point((x, y, z + depth - .014*(abs(x)/width)**2)))
    for ring in range(len(rings)-1):
        for k in range(count):
            a = ring*count+k
            b = ring*count+(k+1)%count
            faces.append((a, b, b+count, a+count))
    faces += [tuple(reversed(range(count))), tuple((len(rings)-1)*count+k for k in range(count))]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    scene.collection.objects.link(obj)
    # Cross-section winding is corrected consistently for export and back-face culling.
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    return finish(obj, name, mat)


def build(variant):
    objects.clear()
    high = variant == "executive"
    cloth = executive if high else task
    box("Seat - sculpted waterfall cushion", (0, .405, .015), (.50, .11, .46), cloth, .045)
    box("Seat - thin rounded shell", (0, .355, 0), (.51, .05, .47), frame, .022)
    # Edge stitching follows the seat rather than a floating front strip.
    box("Seat - front piping", (0, .407, .244), (.40, .009, .006), seam, .0025)
    back("Back - contoured shell", .84 if high else .66, frame, True)
    back("Back - lumbar upholstery", .82 if high else .64, cloth)
    if high:
        box("Back - padded head support", (0, 1.215, -.235), (.34, .10, .075), cloth, .035)
    # Keep the animator's back-grip point on a tangible rear support at y=1.0.
    box("Back - rear grip and spine", (0, .86, -.270), (.41, .30, .035), frame, .014)
    cylinder("Back - lower mount", (0, .35, -.15), (0, .54, -.25), .025, metal)
    for x in (-.28, .28):
        cylinder("Arm - upright", (x, .42, -.065), (x, .66, -.065), .017, metal)
        box("Arm - adjustable sleeve", (x, .58, -.065), (.045, .15, .05), frame, .012)
        box("Arm - soft rounded pad", (x, .685, .035), (.08, .05, .30), frame, .023)
    box("Mechanism - tilt housing", (0, .315, -.01), (.22, .07, .21), frame, .025)
    cylinder("Mechanism - height lever", (.08, .33, .02), (.22, .33, .02), .008, metal)
    box("Mechanism - lever grip", (.22, .33, .02), (.06, .018, .04), frame, .008)
    cylinder("Lift - chrome piston", (0, .14, 0), (0, .32, 0), .023, metal)
    cylinder("Lift - lower sleeve", (0, .08, 0), (0, .21, 0), .039, frame)
    cylinder("Base - central hub", (0, .065, 0), (0, .12, 0), .065, frame)
    for k in range(5):
        angle = 2 * math.pi * k / 5
        dx, dz = math.sin(angle), math.cos(angle)
        # Sloping radial spokes and twin wheels; final tyre bounds fit the .72 m base.
        spoke = box("Base - radial spoke", (dx*.17, .085, dz*.17), (.045, .035, .29), metal if high else frame, .014)
        spoke.rotation_euler[2] = angle
        wx, wz = dx*.307, dz*.307
        cylinder("Caster - swivel stem", (wx, .045, wz), (wx, .082, wz), .012, metal)
        for offset in (-.021, .021):
            tx, tz = math.cos(angle), -math.sin(angle)
            cx, cz = wx+tx*offset, wz+tz*offset
            cylinder("Caster - paired wheel", (cx-tx*.009, .035, cz-tz*.009), (cx+tx*.009, .035, cz+tz*.009), .035, rubber)
    return list(objects)


manifest = {"revision": "ergonomic-1", "coordinate_system": scene["coordinate_system"], "variants": {}}
collections = []
for variant in ("task", "executive"):
    bpy.ops.object.select_all(action="DESELECT")
    meshes = build(variant)
    collection = bpy.data.collections.new("Chair - " + variant)
    scene.collection.children.link(collection)
    for obj in meshes:
        for owner in list(obj.users_collection):
            owner.objects.unlink(obj)
        collection.objects.link(obj)
    collections.append(collection)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    out = os.path.join(args.output, "office-chair-" + variant + ".glb")
    bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", use_selection=True, export_apply=True,
        export_yup=True, export_animations=False, export_cameras=False, export_lights=False)
    manifest["variants"][variant] = {"file": os.path.basename(out), "bytes": os.path.getsize(out),
        "seat_top": .46, "arm_pad_top": .71, "arm_centers_x": [-.28, .28],
        "seat_front_z": .245, "back_grip": [.19, 1, -.295], "base_diameter": .72}

# Separate display positions only in the editable authoring file, after export.
for obj in collections[1].objects:
    obj.location.x += 1.0
scene.world = bpy.data.worlds.new("Studio world")
scene.world.use_nodes = True
scene.world.node_tree.nodes["Background"].inputs[0].default_value = (.65, .70, .72, 1)
scene.world.node_tree.nodes["Background"].inputs[1].default_value = .5
bpy.ops.object.light_add(type="AREA", location=(-3, -4, 5))
bpy.context.object.data.energy = 450
bpy.context.object.data.shape = "DISK"
bpy.context.object.data.size = 4
bpy.ops.object.camera_add(location=(2.7, -3.7, 2.4))
camera = bpy.context.object
camera.rotation_euler = (Vector((.5, 0, .65))-camera.location).to_track_quat("-Z", "Y").to_euler()
camera.data.type = "ORTHO"
camera.data.ortho_scale = 2.2
scene.camera = camera
scene.render.engine = "CYCLES"
scene.cycles.samples = 24
scene.render.resolution_x = 1200
scene.render.resolution_y = 900
scene.render.resolution_percentage = 100
scene.view_settings.view_transform = "AgX"
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(args.output, "office-chairs.blend"))
with open(os.path.join(args.output, "office-chairs.manifest.json"), "w") as file:
    json.dump(manifest, file, indent=2)
if args.preview:
    os.makedirs(os.path.dirname(os.path.abspath(args.preview)), exist_ok=True)
    scene.render.filepath = os.path.abspath(args.preview)
    bpy.ops.render.render(write_still=True)
print("CHAIRS_EXPORTED", json.dumps(manifest), flush=True)
