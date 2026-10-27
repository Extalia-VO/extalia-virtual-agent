"""Convert a hair-card hair pack you are licensed to use (a Character Creator style
.blend or .fbx) into a detailed hair GLB for the local avatars: fitted to the
canonical head, bound rigidly to the canonical skeleton's `head` bone, with one
grey-shaded RGBA texture per material (tinted by the character's hair colour at
runtime, alpha from the pack's opacity map). Outputs are local-only
(apps/web/local-assets is git-ignored) and must never be committed.

Usage (run Blender with factory settings so user add-ons do not start):
  Blender -b --factory-startup --python tooling/convert-detailed-hair.py -- '<json>'

JSON config:
  src          .blend or .fbx pack
  objects      hair mesh object names to keep (hair cards, scalp cap)
  eyes, body   the pack's eye mesh names and body mesh name (fit reference)
  ref          a local body GLB (apps/web/local-assets/avatars/bodies/...): its skeleton is the one the
               hair binds to
  fit_ref      fit to the ref body's own skull (its `Body` and eye meshes) instead of the original
               canonical head; use it for bodies whose head differs from that canonical head
  out, mesh    output GLB path and its mesh name (Hair_detail_<style>)
  budget       triangle budget; whole cards are thinned deterministically above it
  tex          texture size (default 1024)
  opacity_file, shade_file   optional texture files when the pack does not link them
  alpha_gamma, cutoff, dense, dense_gain   optional alpha shaping
Then register the outputs: node tooling/register-detailed-hair.mjs
"""
import bpy, bmesh, json, sys, random, math
import numpy as np
from mathutils import Vector, Matrix

cfg = json.loads(sys.argv[sys.argv.index('--') + 1])

# 1. Load the source.
if cfg['src'].endswith('.blend'):
    bpy.ops.wm.open_mainfile(filepath=cfg['src'])
else:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=cfg['src'])
bpy.context.view_layer.update()
dg = bpy.context.evaluated_depsgraph_get()

def world_verts(obj):
    ev = obj.evaluated_get(dg)
    me = ev.to_mesh()
    pts = np.array([obj.matrix_world @ v.co for v in me.vertices])
    ev.to_mesh_clear()
    return pts

# 2. Source head frame: eye centre and the skull above the eye line.
eyes = np.vstack([world_verts(bpy.data.objects[n]) for n in cfg['eyes']])
eye_c = (eyes.min(0) + eyes.max(0)) / 2
body = world_verts(bpy.data.objects[cfg['body']])
skull = body[(body[:, 2] > eye_c[2]) & (np.abs(body[:, 0] - eye_c[0]) < 0.14) & (np.abs(body[:, 1] - eye_c[1]) < 0.22)]
s_min, s_max = skull.min(0), skull.max(0)
print('SRC eye', eye_c.round(4).tolist(), 'skull', s_min.round(4).tolist(), s_max.round(4).tolist(), flush=True)

# Target (Blender frame of the glTF canonical head: x, y = -glTF z, z = glTF y).
T_MIN = np.array([-0.0945, -0.0478, 1.7042])
T_MAX = np.array([0.0922, 0.1414, 1.8138])
T_EYE_Z = 1.704
if cfg.get('fit_ref'):
    # The same skull measure, taken on the reference body itself.
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=cfg['ref'])
    imported = [o for o in bpy.data.objects if o not in before]
    bpy.context.view_layer.update(); dg = bpy.context.evaluated_depsgraph_get()
    named = lambda *names: next(o for o in imported if o.type == 'MESH' and o.name.split('.')[0] in names)
    t_eyes = world_verts(named('EyesDetail', 'Eyes')); t_eye = (t_eyes.min(0) + t_eyes.max(0)) / 2
    t_body = world_verts(named('Body'))
    t_skull = t_body[(t_body[:, 2] > t_eye[2]) & (np.abs(t_body[:, 0] - t_eye[0]) < 0.14) & (np.abs(t_body[:, 1] - t_eye[1]) < 0.22)]
    T_MIN, T_MAX, T_EYE_Z = t_skull.min(0), t_skull.max(0), float(t_eye[2])
    for o in imported: bpy.data.objects.remove(o)
    bpy.context.view_layer.update(); dg = bpy.context.evaluated_depsgraph_get()
    print('TARGET skull', T_MIN.round(4).tolist(), T_MAX.round(4).tolist(), flush=True)
inflate = cfg.get('inflate', 1.03)
scale = (T_MAX - T_MIN) / (s_max - s_min)
# Keep the hair's own proportions: one horizontal scale, height from the skull above the eyes.
h = (scale[0] + scale[1]) / 2
scale = np.array([h, h, scale[2]]) * inflate
s_c = (s_min + s_max) / 2
t_c = (T_MIN + T_MAX) / 2
print('SCALE', scale.round(4).tolist(), flush=True)

def fit(p):
    q = (p - s_c) * scale + t_c
    return q + np.array([0, 0, cfg.get('lift', 0.0)])

# 3. Bake the hair objects (modifiers applied, world space) into one fitted mesh.
bm_all = bmesh.new()
mat_map = []
for name in cfg['objects']:
    obj = bpy.data.objects[name]
    ev = obj.evaluated_get(dg)
    me = ev.to_mesh()
    tmp = bpy.data.meshes.new('tmp')
    bm = bmesh.new(); bm.from_mesh(me)
    bm.transform(obj.matrix_world)
    offset = len(mat_map)
    for f in bm.faces: f.material_index += offset
    mat_map += [obj.material_slots[i].material for i in range(len(obj.material_slots))]
    bm.to_mesh(tmp); bm.free(); ev.to_mesh_clear()
    bm_all.from_mesh(tmp)
    bpy.data.meshes.remove(tmp)
for v in bm_all.verts:
    v.co = Vector(fit(np.array(v.co)))

# 4. Thin the hair cards to the triangle budget: keep whole cards (connected pieces), deterministically.
tris = sum(len(f.verts) - 2 for f in bm_all.faces)
budget = cfg.get('budget', 12000)
if tris > budget:
    bm_all.faces.ensure_lookup_table()
    seen, cards = set(), []
    for f in bm_all.faces:
        if f.index in seen: continue
        stack, card = [f], []
        seen.add(f.index)
        while stack:
            g = stack.pop(); card.append(g)
            for e in g.edges:
                for n in e.link_faces:
                    if n.index not in seen: seen.add(n.index); stack.append(n)
        cards.append(card)
    keep = budget / tris
    rnd = random.Random(cfg.get('seed', 7))
    drop = []
    # Scalp/base pieces (very large cards) always stay.
    for card in cards:
        if len(card) > 400: continue
        if rnd.random() > keep: drop += card
    bmesh.ops.delete(bm_all, geom=drop, context='FACES')
    print('CARDS', len(cards), 'TRIS', tris, '->', sum(len(f.verts) - 2 for f in bm_all.faces), flush=True)

# 5. Materials: grey diffuse (tinted by the hair colour at runtime) with the opacity map as alpha.
def find_image(material, *keys):
    for n in material.node_tree.nodes if material and material.use_nodes else []:
        if n.type == 'TEX_IMAGE' and n.image and any(k.lower() in n.image.name.lower() or k.lower() in n.image.filepath.lower() for k in keys):
            return n.image
    return None

size = cfg.get('tex', 1024)
def loaded(img):
    try:
        return len(img.pixels) > 0
    except Exception as error:
        print('NOIMG', img.name, img.filepath, error, flush=True); return False
new_mats = []
for index, material in enumerate(mat_map):
    diffuse = find_image(material, 'Diffuse', 'Base_Color', 'BaseColor', 'Depth', 'color')
    opacity = find_image(material, 'Opacity', 'Alpha', 'Mask')
    if cfg.get('opacity_file'): opacity = bpy.data.images.load(cfg['opacity_file'])
    if cfg.get('shade_file'): diffuse = None
    out = bpy.data.images.new(f'hair_{index}', size, size, alpha=True)
    rgba = np.ones((size, size, 4), dtype=np.float32)
    def sampled(img):
        img = img.copy(); _ = len(img.pixels); img.scale(size, size)
        px = np.array(img.pixels[:], dtype=np.float32).reshape(size, size, 4)
        return px
    bump = bpy.data.images.load(cfg['shade_file']) if cfg.get('shade_file') else find_image(material, 'Bump', 'Normal', 'Depth')
    if opacity is not None and loaded(opacity):
        alpha = sampled(opacity)[..., 0]
    elif diffuse is not None and loaded(diffuse):
        alpha = sampled(diffuse)[..., 3]
    else:
        alpha = np.ones((size, size), dtype=np.float32)
    # Base layers (scalp caps) are meant to read dense: they hide the skin between thinned cards.
    if material and any(k.lower() in material.name.lower() for k in cfg.get('dense', ['Scalp'])):
        alpha = np.clip(alpha * cfg.get('dense_gain', 1.5), 0, 1)
    if cfg.get('alpha_gamma'): alpha = np.power(alpha, cfg['alpha_gamma'])
    covered = alpha > 0.3
    lum = lambda px: px[..., :3] @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    shade = None
    if diffuse is not None and loaded(diffuse):
        d = lum(sampled(diffuse))
        if covered.any() and float(d[covered].mean()) > 0.12: shade = d
    if shade is None and bump is not None and loaded(bump):
        shade = lum(sampled(bump))
    if shade is None:
        shade = np.full((size, size), 0.7, dtype=np.float32)
    # Strand variation without the pack's own colour: 5th..95th percentile mapped to 0.5..1 (tinted at runtime).
    if covered.any():
        lo, hi = np.percentile(shade[covered], [5, 95])
    else:
        lo, hi = 0.0, 1.0
    grey = np.clip(0.5 + 0.5 * (shade - lo) / max(hi - lo, 1e-3), 0.35, 1.0)
    mean = float(grey[covered].mean()) if covered.any() else 0.0
    rgba[..., 0] = rgba[..., 1] = rgba[..., 2] = grey
    rgba[..., 3] = alpha
    out.pixels[:] = rgba.ravel()
    out.file_format = 'PNG'; out.pack()
    m = bpy.data.materials.new(f"{cfg['mesh']}_{index}")
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes.get('Principled BSDF')
    tex = nt.nodes.new('ShaderNodeTexImage'); tex.image = out
    nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    nt.links.new(tex.outputs['Alpha'], bsdf.inputs['Alpha'])
    bsdf.inputs['Roughness'].default_value = 0.62
    m.blend_method = 'CLIP' if hasattr(m, 'blend_method') else None
    try: m.alpha_threshold = cfg.get('cutoff', 0.35)
    except Exception: pass
    m.use_backface_culling = False
    new_mats.append(m)
    print('MAT', index, material.name if material else None, 'diffuse', diffuse.name if diffuse else None, 'opacity', opacity.name if opacity else None, 'mean', round(mean, 3), flush=True)

# 6. Fresh scene: the canonical armature from the reference body, and the hair bound rigidly to `head`.
for o in list(bpy.data.objects): bpy.data.objects.remove(o)
bpy.ops.import_scene.gltf(filepath=cfg['ref'])
arm = next(o for o in bpy.context.scene.objects if o.type == 'ARMATURE')
for o in list(bpy.data.objects):
    if o.type == 'MESH': bpy.data.objects.remove(o)
mesh = bpy.data.meshes.new(cfg['mesh'])
bm_all.to_mesh(mesh); bm_all.free()
for m in new_mats: mesh.materials.append(m)
obj = bpy.data.objects.new(cfg['mesh'], mesh)
bpy.context.scene.collection.objects.link(obj)
group = obj.vertex_groups.new(name='head')
group.add(list(range(len(mesh.vertices))), 1.0, 'REPLACE')
obj.parent = arm
mod = obj.modifiers.new('Armature', 'ARMATURE'); mod.object = arm
for o in bpy.data.objects: o.select_set(o in (arm, obj))
bpy.context.view_layer.objects.active = arm
bpy.ops.export_scene.gltf(filepath=cfg['out'], export_format='GLB', use_selection=True, export_skins=True,
    export_animations=False, export_morph=False, export_apply=False, export_image_format='AUTO', export_yup=True)
print('EXPORTED', cfg['out'], len(mesh.polygons), flush=True)
