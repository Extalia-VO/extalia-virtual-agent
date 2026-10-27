"""Author a closed normalized floor panel and an editable contact review scene.

Run: Blender --background --factory-startup --python tooling/blender/create-floor-panel.py
Optional arguments after --: --output <directory> --preview <png-path>
Metres; app X/Y/Z = Blender X/Z/-Y. Export only the normalized source panel.
Generated models and review renders stay in ignored local-assets.
"""
import argparse
import json
import math
import os
import sys
import bpy
from mathutils import Vector

parser = argparse.ArgumentParser()
parser.add_argument("--output", default=os.path.abspath(os.path.join(os.path.dirname(__file__), "../../apps/web/local-assets/floors")))
parser.add_argument("--preview")
args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
os.makedirs(args.output, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.name = "Extalia floor panels — top contact at zero"
scene.unit_settings.system = "METRIC"
scene["coordinate_system"] = "app X/Y/Z = Blender X/Z/-Y; exported panel top Y=0, bottom Y=-1"
scene["review_note"] = "Review finish thicknesses are examples. The app supplies final footprint, thickness and textures."


def point(p):
    return Vector((p[0], -p[2], p[1]))


vertices = [(-.5, 0, -.5), (-.5, 0, .5), (.5, 0, .5), (.5, 0, -.5),
            (-.5, -1, -.5), (-.5, -1, .5), (.5, -1, .5), (.5, -1, -.5)]
faces = [(0, 1, 2, 3), (4, 7, 6, 5), (0, 4, 5, 1), (0, 3, 7, 4), (3, 2, 6, 7), (1, 5, 6, 2)]
mesh = bpy.data.meshes.new("Floor panel — closed volume, planar top UV")
mesh.from_pydata([point(vertex) for vertex in vertices], [], faces)
mesh.update()
uv = mesh.uv_layers.new(name="FloorUV")
for face_index, polygon in enumerate(mesh.polygons):
    for corner, loop_index in enumerate(polygon.loop_indices):
        vertex = vertices[mesh.loops[loop_index].vertex_index]
        uv.data[loop_index].uv = (vertex[0] + .5, vertex[2] + .5) if face_index < 2 else [(0, 0), (0, 1), (1, 1), (1, 0)][corner]
    polygon.use_smooth = False
source_collection = bpy.data.collections.new("01 — Exported normalized source")
scene.collection.children.link(source_collection)
panel = bpy.data.objects.new("floor-panel", mesh)
source_collection.objects.link(panel)
panel["app_bounds_min"] = [-.5, -1, -.5]
panel["app_bounds_max"] = [.5, 0, .5]
panel["top_contact_y"] = 0.0
panel["app_materials"] = "Imported geometry only; renderer preserves its floor textures."
bpy.context.view_layer.update()
assert len(mesh.polygons) == 6
assert mesh.polygons[0].normal.z > .9999
assert mesh.polygons[1].normal.z < -.9999
assert all(len([polygon for polygon in mesh.polygons if edge.vertices[0] in polygon.vertices and edge.vertices[1] in polygon.vertices]) == 2 for edge in mesh.edges)
bpy.ops.object.select_all(action="DESELECT")
panel.select_set(True)
bpy.context.view_layer.objects.active = panel
bpy.ops.export_scene.gltf(filepath=os.path.join(args.output, "floor-panel.glb"), export_format="GLB", use_selection=True,
    export_yup=True, export_materials="NONE", export_extras=True, export_cameras=False, export_lights=False)
with open(os.path.join(args.output, "floor-panel.manifest.json"), "w", encoding="utf-8") as output:
    json.dump({"schema": 1, "mesh": "floor-panel", "meshes": 1, "coordinateSystem": "app X/Y/Z = Blender X/Z/-Y",
        "bounds": {"min": [-.5, -1, -.5], "max": [.5, 0, .5]}, "topContactY": 0,
        "triangles": 12, "closed": True, "uv": "glTF top U=app X+0.5, V=0.5-app Z (matches Three BoxGeometry); side-local planar mapping",
        "loader": {"bakeWorldMatrix": True, "translateY": .5, "centeredBounds": [-.5, .5]},
        "materialPolicy": "Export geometry only; app retains floor finish materials and textures."}, output, indent=2)

# Save an editable inspection scene without exporting review props.
panel.hide_render = True
panel.hide_set(True)
review_collection = bpy.data.collections.new("02 — Thin finish and ground contact review")
scene.collection.children.link(review_collection)


def material(name, color, roughness=.75):
    material = bpy.data.materials.new(name)
    material.diffuse_color = (*color, 1)
    material.use_nodes = True
    bsdf = material.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1)
    bsdf.inputs["Roughness"].default_value = roughness
    return material


def move_to_review(obj):
    for collection in list(obj.users_collection):
        collection.objects.unlink(obj)
    review_collection.objects.link(obj)


wood = material("Review pale oak finish", (.53, .36, .20))
carpet = material("Review warm-grey carpet finish", (.26, .31, .31), .95)
stone = material("Review pale stone finish", (.63, .65, .62))
mark = material("Contact reference graphite", (.035, .048, .048), .9)
for index, (finish, thickness) in enumerate([(wood, .028), (carpet, .014), (stone, .032)]):
    obj = bpy.data.objects.new(f"Review finish — {finish.name}", mesh.copy())
    review_collection.objects.link(obj)
    obj.location = point((index * 1.1, 0, 0))
    obj.scale = (1, 1, thickness)
    obj.data.materials.append(finish)
    obj["top_contact_y"] = 0
    obj["review_thickness"] = thickness
    for side in [-1, 1]:
        bpy.ops.mesh.primitive_cube_add(size=1, location=point((index * 1.1 + side * .12, .012, .05)))
        sole = bpy.context.object
        sole.name = f"Reference foot sole — bottom at zero — {index}-{side}"
        sole.dimensions = (.09, .24, .024)
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        sole.data.materials.append(mark)
        bevel = sole.modifiers.new("Sole edge", "BEVEL")
        bevel.width = .008
        bevel.segments = 3
        move_to_review(sole)
    bpy.ops.mesh.primitive_cylinder_add(vertices=32, radius=.035, depth=.024, location=point((index * 1.1 + .32, .035, -.30)), rotation=(math.pi / 2, 0, 0))
    wheel = bpy.context.object
    wheel.name = f"Reference wheel — bottom at zero — {index}"
    wheel.data.materials.append(mark)
    move_to_review(wheel)

world = bpy.data.worlds.new("Soft neutral inspection studio")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (.66, .69, .72, 1)
world.node_tree.nodes["Background"].inputs[1].default_value = .7
scene.world = world
bpy.ops.object.light_add(type="AREA", location=point((1, 4, 1)))
light = bpy.context.object
light.name = "Review soft key"
light.data.energy = 500
light.data.shape = "DISK"
light.data.size = 5
bpy.ops.object.camera_add(location=point((3.8, 2.1, 3.6)))
camera = bpy.context.object
camera.name = "Review contact camera"
camera.rotation_euler = (point((1.1, 0, 0)) - camera.location).to_track_quat("-Z", "Y").to_euler()
camera.data.type = "ORTHO"
camera.data.ortho_scale = 4.2
scene.camera = camera
scene.render.engine = "CYCLES"
scene.cycles.samples = 32
scene.render.resolution_x = 1600
scene.render.resolution_y = 900
scene.render.resolution_percentage = 100
scene.view_settings.view_transform = "AgX"
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(args.output, "floor-panel.blend"))
if args.preview:
    os.makedirs(os.path.dirname(os.path.abspath(args.preview)), exist_ok=True)
    scene.render.filepath = os.path.abspath(args.preview)
    bpy.ops.render.render(write_still=True)
print("FLOOR_PANEL_EXPORT", json.dumps({"meshes": 1, "triangles": 12, "topY": 0, "bottomY": -1}))
