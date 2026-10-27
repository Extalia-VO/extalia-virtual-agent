"""Export the reviewed HQ's five local-only building parts, without changing the authoring scene.

Run: EXTALIA_REPO=<repository> Blender <review.blend> --background --python <this-file>
Optional: EXTALIA_BUILDING_SCENE selects the source scene (default "Scene").
Blender X/Y/Z map to app X/-Z/Y in metres. Runtime owns doors, cabs and fan motion.
"""
import json
import os
import bpy

repo = os.environ.get("EXTALIA_REPO") or os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
folder = os.path.join(repo, "apps", "web", "local-assets", "building")
os.makedirs(folder, exist_ok=True)
source = bpy.data.scenes[os.environ.get("EXTALIA_BUILDING_SCENE", "Scene")]
if source.get("preview_only"):
    raise ValueError("Choose the authoring scene, not a preview scene")


def eligible(obj):
    return obj.name in source.objects and obj.type == "MESH" and not obj.hide_render and not obj.get("preview_only")


def meshes_in(*names):
    result = []
    for name in names:
        collection = bpy.data.collections.get(name)
        if collection:
            result.extend(obj for obj in collection.all_objects if eligible(obj))
    return result


def review(*prefixes):
    collection = bpy.data.collections.get("Review - terrace entrance and roof")
    return [obj for obj in (collection.all_objects if collection else []) if eligible(obj) and obj.name.startswith(prefixes)]


parts = {
    "extalia-shell.glb": meshes_in("ExtaliaShell") + review("Entrance - canopy sign backing", "Roof sign - ", "Access opening - "),
    "roof-utilities.glb": meshes_in("Roof utilities - STATIC", "Roof utilities - ROTORS runtime"),
    "roof-stair.glb": review("Stair - ", "Roof landing - ", "Landing connection - "),
    "elevators.glb": meshes_in("Elevator static A", "Elevator static B"),
    "terrace.glb": review("Terrace L3 - glass", "Terrace L3 - base shoe", "Terrace L3 - top rail"),
}
# An incomplete refresh must fail visibly instead of silently keeping an older part.
if any(not objects for objects in parts.values()):
    raise ValueError("Missing building parts: " + str([name for name, objects in parts.items() if not objects]))
expected_rotors = {f"AC_FAN_ROTOR_{i:02d}" for i in range(8)}
assert {obj.name for obj in parts["roof-utilities.glb"] if obj.name.startswith("AC_FAN_ROTOR_")} == expected_rotors

manifest = {"source_revision": source.get("review_version"), "coordinate_system": "app X/Y/Z = Blender X/Z/-Y", "parts": {}}
previous_scene = bpy.context.window.scene
previous_selection = list(bpy.context.selected_objects)
previous_active = bpy.context.view_layer.objects.active
# Only copies enter this isolated scene. Review worlds/lights, cameras and preview animation never do.
export_scene = bpy.data.scenes.new("_building_export")
pending_files = []
try:
    bpy.context.window.scene = export_scene
    for filename, objects in parts.items():
        copies, meshes, materials, renamed = [], [], [], []
        material_cache, mesh_cache = {}, {}
        try:
            for obj in dict.fromkeys(objects):
                original_name = obj.name
                # Preserve exact runtime rotor names; restore source names even after an exporter failure.
                obj.name = "_export_source_" + original_name
                renamed.append((obj, original_name))
                clone = obj.copy()
                copies.append(clone)
                clone.name = original_name
                clone.animation_data_clear()
                clone.parent = None
                clone.matrix_world = obj.matrix_world.copy()
                for key in list(clone.keys()):
                    del clone[key]
                if original_name in expected_rotors:
                    clone.rotation_mode = "XYZ"
                    clone.rotation_euler = (0, 0, 0)
                # Preserve shared rotor geometry and isolate material extras from authoring metadata.
                if obj.data not in mesh_cache:
                    data = obj.data.copy()
                    meshes.append(data)
                    for i, material in enumerate(data.materials):
                        if material is None:
                            continue
                        if material not in material_cache:
                            copied = material.copy()
                            for key in list(copied.keys()):
                                del copied[key]
                            role = material.get("extalia_material_role")
                            if role:
                                copied["extalia_material_role"] = role
                            materials.append(copied)
                            material_cache[material] = copied
                        data.materials[i] = material_cache[material]
                    mesh_cache[obj.data] = data
                clone.data = mesh_cache[obj.data]
                export_scene.collection.objects.link(clone)
                clone.select_set(True)
            bpy.context.view_layer.objects.active = copies[0]
            out = os.path.join(folder, filename)
            # Replace a complete GLB atomically, retaining the previous file on export failure.
            pending = os.path.join(folder, ".pending-" + filename)
            pending_files.append((pending, out))
            bpy.ops.export_scene.gltf(filepath=pending, export_format="GLB", use_selection=True,
                export_apply=True, export_yup=True, export_animations=False, export_cameras=False,
                export_lights=False, export_extras=True, export_image_format="AUTO")
            manifest["parts"][filename] = {"objects": [original for _, original in renamed], "bytes": os.path.getsize(pending)}
            print("STAGED", filename, len(copies), os.path.getsize(pending), flush=True)
        finally:
            for clone in copies:
                bpy.data.objects.remove(clone, do_unlink=True)
            for data in meshes:
                bpy.data.meshes.remove(data)
            for material in materials:
                bpy.data.materials.remove(material)
            for obj, original_name in renamed:
                obj.name = original_name
    # No published file changes until every part has exported successfully.
    for pending, out in pending_files:
        os.replace(pending, out)
finally:
    for pending, _ in pending_files:
        if os.path.exists(pending):
            os.remove(pending)
    bpy.context.window.scene = previous_scene
    bpy.data.scenes.remove(export_scene)
    for obj in bpy.context.view_layer.objects:
        obj.select_set(obj in previous_selection)
    bpy.context.view_layer.objects.active = previous_active
with open(os.path.join(folder, "building-manifest.json"), "w", encoding="utf-8") as handle:
    json.dump(manifest, handle, indent=2)
print("BUILDING_EXPORT_COMPLETE", source.get("review_version"), flush=True)
