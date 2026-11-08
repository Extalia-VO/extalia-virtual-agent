"""Turn the owner's "Afro IV 3c" hair-curves pack into a card-free afro shell the hair converter can fit.

    Blender -b --factory-startup --python-exit-code 1 --python tooling/blender/prepare-afro-shell.py -- \
        "<extracted>/Afro IV 3c hair.blend" "<work>/afro-shell.blend"

The pack's geometry-nodes hair (59k interpolated, curled and clumped curves) is far beyond a web budget, and an
afro reads as one dense volume: the evaluated strand points become a volume (12 mm voxels, 22 mm point radius),
its surface a mesh, decimated to ~7k triangles and smoothed, with a tileable grey coil texture (tinted by the
character's hair colour at runtime). The saved file keeps the pack's `scalp` for `convert-detailed-hair.py`
(`skull_object: scalp`, `uniform: true`); see tooling/hair-packs.json.
"""
import bpy, sys
import numpy as np
src, out = sys.argv[sys.argv.index('--')+1:][:2]
bpy.ops.wm.open_mainfile(filepath=src)
curves = bpy.data.objects['Curves']
# Geometry nodes: evaluated hair -> points -> volume -> mesh (the afro's outer shell).
holder = bpy.data.objects.new('AfroShell', bpy.data.meshes.new('AfroShell'))
bpy.context.scene.collection.objects.link(holder)
mod = holder.modifiers.new('shell', 'NODES')
tree = bpy.data.node_groups.new('AfroShellNodes', 'GeometryNodeTree')
tree.interface.new_socket('Geometry', in_out='OUTPUT', socket_type='NodeSocketGeometry')
tree.interface.new_socket('Geometry', in_out='INPUT', socket_type='NodeSocketGeometry')
nodes, links = tree.nodes, tree.links
out_node = nodes.new('NodeGroupOutput')
info = nodes.new('GeometryNodeObjectInfo'); info.inputs['Object'].default_value = curves; info.transform_space = 'RELATIVE'
pts = nodes.new('GeometryNodeCurveToPoints'); pts.mode = 'EVALUATED'
vol = nodes.new('GeometryNodePointsToVolume')
for name, value in (('Density', 1.0), ('Voxel Size', 0.012), ('Radius', 0.022)):
    if name in vol.inputs: vol.inputs[name].default_value = value
if hasattr(vol, 'resolution_mode'): vol.resolution_mode = 'VOXEL_SIZE'
v2m = nodes.new('GeometryNodeVolumeToMesh')
if 'Threshold' in v2m.inputs: v2m.inputs['Threshold'].default_value = 0.3
links.new(info.outputs['Geometry'], pts.inputs['Curve'])
links.new(pts.outputs['Points'], vol.inputs['Points'])
links.new(vol.outputs['Volume'], v2m.inputs['Volume'])
links.new(v2m.outputs['Mesh'], out_node.inputs['Geometry'])
mod.node_group = tree
bpy.context.view_layer.objects.active = holder
bpy.ops.object.modifier_apply(modifier=mod.name)
me = holder.data
print('SHELL', len(me.vertices), len(me.polygons))
# Simplify and smooth.
dec = holder.modifiers.new('dec', 'DECIMATE'); dec.ratio = min(1, 7000 / max(1, sum(len(p.vertices) - 2 for p in me.polygons)))
bpy.ops.object.modifier_apply(modifier=dec.name)
sm = holder.modifiers.new('sm', 'SMOOTH'); sm.factor = .6; sm.iterations = 6
bpy.ops.object.modifier_apply(modifier=sm.name)
me.shade_smooth()
# UVs and a tileable curl texture (grey; the runtime tints it).
bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT'); bpy.ops.uv.smart_project(angle_limit=1.15, island_margin=.01); bpy.ops.object.mode_set(mode='OBJECT')
N = 512; rng = np.random.default_rng(3)
y, x = np.mgrid[0:N, 0:N] / N
img = np.zeros((N, N), np.float32)
for _ in range(5200):  # tight ring-shaped coils
    cx, cy, r = rng.random(), rng.random(), .004 + rng.random() * .006
    d = np.sqrt(((x - cx + .5) % 1 - .5) ** 2 + ((y - cy + .5) % 1 - .5) ** 2)
    img = np.maximum(img, np.clip(1 - np.abs(d - r) / .0022, 0, 1) * (.5 + .5 * rng.random()))
shade = .55 + .35 * img
px = np.ones((N, N, 4), np.float32); px[..., 0] = px[..., 1] = px[..., 2] = shade
tex = bpy.data.images.new('Afro_Curls_Diffuse', N, N, alpha=True); tex.pixels.foreach_set(px.ravel()); tex.pack()
mat = bpy.data.materials.new('Afro_Curls'); mat.use_nodes = True
b = next(n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'); t = mat.node_tree.nodes.new('ShaderNodeTexImage'); t.image = tex
mat.node_tree.links.new(t.outputs['Color'], b.inputs['Base Color'])
me.materials.clear(); me.materials.append(mat)
print('FINAL', sum(len(p.vertices) - 2 for p in me.polygons))
bpy.data.objects.remove(curves)
bpy.ops.wm.save_as_mainfile(filepath=out)
