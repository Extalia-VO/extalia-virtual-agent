"""Author the work tablet a character carries while it walks during work.

    Blender --background --factory-startup --python-exit-code 1 --python tooling/blender/create-tablet-prop.py
    python3 tooling/blender/prepare-public-models.py --only furniture/tablet.glb

A 10.9-inch tablet (247 x 178 x 7 mm) with rounded corners: an aluminium shell, a black glass
front with an even bezel, a camera dot and a lit work screen (editor panes, a terminal strip and a
task list painted into a 256 px texture, emitted so it reads in the dark). Origin at the centre,
screen facing +Z in Blender (+Y in glTF): the runtime tilts it toward the carrier's face.
Output: apps/web/local-assets/furniture/tablet.glb (a few kB). Reruns are byte-identical.
"""
import os
import bpy
import bmesh
import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(ROOT, 'apps', 'web', 'local-assets', 'furniture', 'tablet.glb')
W, D, T = .247, .178, .007
CORNER, BEZEL = .014, .011

bpy.ops.wm.read_factory_settings(use_empty=True)


def material(name, color, roughness, metallic=0.0, emission=None, image=None):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = next(n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    bsdf.inputs['Base Color'].default_value = (*color, 1)
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Metallic'].default_value = metallic
    if image is not None:
        tex = mat.node_tree.nodes.new('ShaderNodeTexImage')
        tex.image = image
        mat.node_tree.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
        mat.node_tree.links.new(tex.outputs['Color'], bsdf.inputs['Emission Color'])
        bsdf.inputs['Emission Strength'].default_value = emission or 1.0
    return mat


def rounded_slab(name, width, depth, z0, z1, radius, segments=6):
    """A rounded rectangle extruded from z0 to z1, UVs mapped to its footprint."""
    bm = bmesh.new()
    ring = []
    for cx, cy, start in ((width / 2 - radius, depth / 2 - radius, 0), (-width / 2 + radius, depth / 2 - radius, 90),
                          (-width / 2 + radius, -depth / 2 + radius, 180), (width / 2 - radius, -depth / 2 + radius, 270)):
        for k in range(segments + 1):
            a = np.radians(start + 90 * k / segments)
            ring.append((cx + radius * np.cos(a), cy + radius * np.sin(a)))
    bottom = [bm.verts.new((x, y, z0)) for x, y in ring]
    top = [bm.verts.new((x, y, z1)) for x, y in ring]
    bm.faces.new(top)
    bm.faces.new(list(reversed(bottom)))
    for i in range(len(ring)):
        j = (i + 1) % len(ring)
        bm.faces.new((bottom[i], bottom[j], top[j], top[i]))
    uv = bm.loops.layers.uv.new()
    for face in bm.faces:
        for loop in face.loops:
            loop[uv].uv = (loop.vert.co.x / width + .5, loop.vert.co.y / depth + .5)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def screen_image():
    """A calm work screen: editor panes, a terminal strip and a task list (sRGB, 256 x 184)."""
    w, h = 256, 184
    px = np.zeros((h, w, 4), np.float32)
    px[..., :3] = (.07, .09, .11)
    px[..., 3] = 1

    def box(x0, y0, x1, y1, rgb):
        px[y0:y1, x0:x1, :3] = rgb
    box(0, 168, 256, 184, (.13, .16, .19))                      # top bar
    box(6, 172, 30, 179, (.30, .78, .66))                       # app badge
    box(0, 0, 58, 168, (.10, .12, .15))                         # sidebar
    for i in range(9):
        box(8, 150 - i * 16, 50 - (i * 7) % 20, 156 - i * 16, (.33, .38, .44) if i != 2 else (.30, .78, .66))
    for i in range(14):                                         # editor lines
        indent = (i * 13) % 4 * 8
        length = 60 + (i * 37) % 90
        color = ((.55, .72, .95), (.82, .66, .45), (.62, .82, .55), (.70, .72, .76))[i % 4]
        box(66 + indent, 156 - i * 8, 66 + indent + length, 160 - i * 8, color)
    box(58, 0, 256, 40, (.05, .06, .07))                        # terminal
    for i in range(4):
        box(66, 30 - i * 8, 66 + 40 + (i * 29) % 110, 33 - i * 8, (.36, .84, .55) if i == 3 else (.62, .66, .70))
    image = bpy.data.images.new('tablet-work-screen', w, h, alpha=False)
    image.pixels.foreach_set(px.ravel())
    image.pack()
    return image


aluminium = material('Tablet aluminium', (.66, .68, .70), .35, .85)
glass = material('Tablet bezel glass', (.015, .016, .018), .08)
screen = material('Tablet screen', (1, 1, 1), .25, emission=1.4, image=screen_image())
lens = material('Tablet camera lens', (.02, .03, .05), .1)

shell = rounded_slab('tablet-shell', W, D, -T / 2, T / 2 - .0008, CORNER)
shell.data.materials.append(aluminium)
front = rounded_slab('tablet-front', W - .0012, D - .0012, T / 2 - .0008, T / 2, CORNER - .0006)
front.data.materials.append(glass)
panel = rounded_slab('tablet-screen', W - 2 * BEZEL, D - 2 * BEZEL, T / 2, T / 2 + .0002, CORNER - BEZEL + .002, 3)
panel.data.materials.append(screen)
bpy.ops.mesh.primitive_cylinder_add(vertices=12, radius=.0018, depth=.0003, location=(0, D / 2 - BEZEL / 2, T / 2 + .00015))
camera = bpy.context.object
camera.name = 'tablet-camera'
camera.data.materials.append(lens)

for obj in (shell, front, panel, camera):
    obj.select_set(True)
bpy.context.view_layer.objects.active = shell
bpy.ops.object.join()
tablet = bpy.context.object
tablet.name = tablet.data.name = 'tablet'
os.makedirs(os.path.dirname(OUT), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', use_selection=True, export_image_format='WEBP',
                          export_image_quality=90, export_tangents=False, export_extras=False, export_yup=True,
                          export_apply=True, export_vertex_color='NONE')
print('TABLET', OUT, os.path.getsize(OUT))
