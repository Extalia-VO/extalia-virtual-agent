"""Prepare the compact campus greenery GLBs (potted plants, garden plants, trees).

    Blender --background --factory-startup --python-exit-code 1 --python tooling/blender/prepare-greenery.py -- \
        --source-dir <assets-temp> [--only id,id] [--work-dir <dir>]

Every entry of `campus-greenery.json` names a downloaded archive under the source folder (archives and
their textures are never committed). Only its model and textures are extracted. Per part (one per source
material or, for CGAxis OBJ groups, per `_NN` group):
  leaf  : alpha-card foliage. A seeded random subset of leaf islands is kept and each kept island is
          enlarged about its centre, so the crown keeps its coverage at a fraction of the triangles.
          A part that is one connected canopy mesh is decimated instead.
  solid : bark, stems, pots, fruit. Twigs smaller than `prune` x height are removed (trees), then the
          part is collapse-decimated to its share of `budget`, welding split seams when collapse stalls.
  drop  : removed (e.g. a gravel disc).
Base colour (+ opacity as alpha) is resized to `tex` px (leaves) or `solidTex` px and exported as WebP;
bump/normal/gloss maps are dropped. Leaves export as alphaMode MASK, double sided. The model is scaled
to `height` metres with its base centred on the origin. Output: apps/web/local-assets/greenery/<id>.glb
and greenery.manifest.json (triangles, bytes, size). Reruns are deterministic (seeded by the id).
"""
import bpy, bmesh, sys, os, json, re, random, struct, subprocess, fcntl
import numpy as np
from mathutils import Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
CATALOG = os.path.join(ROOT, 'tooling', 'blender', 'campus-greenery.json')
OUT = os.path.join(ROOT, 'apps', 'web', 'local-assets', 'greenery')
argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
opt = {argv[i][2:]: argv[i + 1] for i in range(0, len(argv) - 1, 2)}
if 'source-dir' not in opt:
    raise SystemExit('--source-dir <folder with plants/ and trees/ archives> is required')
SOURCE = os.path.abspath(opt['source-dir'])
WORK = os.path.abspath(opt.get('work-dir', os.path.join(OUT, '.work')))
only = set(opt['only'].split(',')) if opt.get('only') else None
recipes = json.load(open(CATALOG))['greenery']
os.makedirs(OUT, exist_ok=True)
HEAVY = ['*.max', '*.c4d', '*.mb', '*.ma', '*.uasset', '*.umap', '*.3ds', '*.fbx', '*.FBX', '*.abc', '*.usd*', '*.dae',
         '*.stl', '*.vrmesh', '*.rar', '*.blend', '*.blend1']


def extract(recipe):
    """Extract the archive (and an optional inner archive) once into its own work folder."""
    stem = re.sub(r'\W+', '-', os.path.splitext(recipe['archive'])[0]).strip('-')
    folder = os.path.join(WORK, stem)
    target = os.path.join(folder, recipe['source'])
    if not os.path.exists(target):
        os.makedirs(folder, exist_ok=True)
        archive = os.path.join(SOURCE, recipe['archive'])
        excludes = [arg for pattern in HEAVY if not ((recipe.get('inner') or recipe.get('nested')) and pattern == '*.rar') for arg in ('--exclude', pattern)]
        if recipe.get('inner'):
            subprocess.run(['bsdtar', '-xf', archive, '-C', folder, recipe['inner']], check=True)
            subprocess.run(['bsdtar', '-xf', os.path.join(folder, recipe['inner']), '-C', folder], check=True)
        else:
            subprocess.run(['bsdtar', '-xf', archive, '-C', folder, *excludes], check=True)
        for nested in recipe.get('nested', []):  # texture archives inside the download
            subprocess.run(['bsdtar', '-xf', os.path.join(folder, nested), '-C', os.path.dirname(os.path.join(folder, nested))], check=True)
    if not os.path.exists(target):
        raise FileNotFoundError(f"{recipe['id']}: {recipe['source']} not found in {recipe['archive']}")
    return target


def find_file(folder, name):
    """Case-insensitive search for a texture basename anywhere under folder."""
    want = name.lower()
    for root, _, files in os.walk(folder):
        for f in files:
            if f.lower() == want:
                return os.path.join(root, f)
    return None


def islands(me):
    """Connected face components; returns (face -> island id array, island count)."""
    nv, nf = len(me.vertices), len(me.polygons)
    parent = list(range(nv))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    loops = np.empty(len(me.loops), np.int64); me.loops.foreach_get('vertex_index', loops)
    starts = np.empty(nf, np.int64); me.polygons.foreach_get('loop_start', starts)
    totals = np.empty(nf, np.int64); me.polygons.foreach_get('loop_total', totals)
    for s, t in zip(starts.tolist(), totals.tolist()):
        a = find(loops[s])
        for k in range(s + 1, s + t):
            b = find(loops[k])
            if a != b:
                parent[b] = a
    root = np.array([find(loops[s]) for s in starts.tolist()], np.int64)
    uniq, ids = np.unique(root, return_inverse=True)
    return ids, len(uniq)


def tri_count(me):
    t = np.empty(len(me.polygons), np.int64); me.polygons.foreach_get('loop_total', t)
    return int((t - 2).sum())


def thin_leaves(obj, keep, enlarge, rng):
    me = obj.data
    ids, n = islands(me)
    if n < 40:  # one big canopy mesh: islands are not individual leaves
        return False
    chosen = set(i for i in range(n) if rng.random() < keep)
    bm = bmesh.new(); bm.from_mesh(me); bm.faces.ensure_lookup_table()
    kill = [f for f, i in zip(bm.faces, ids.tolist()) if i not in chosen]
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    bm.verts.ensure_lookup_table()
    # enlarge the kept islands about their centres
    for v in bm.verts:
        v.tag = False
    for v in bm.verts:
        if v.tag:
            continue
        stack, group = [v], []
        v.tag = True
        while stack:
            x = stack.pop(); group.append(x)
            for e in x.link_edges:
                y = e.other_vert(x)
                if not y.tag:
                    y.tag = True; stack.append(y)
        c = sum((x.co for x in group), Vector()) / len(group)
        for x in group:
            x.co = c + (x.co - c) * enlarge
    bm.to_mesh(me); bm.free()
    return True


def prune_small(obj, min_diag):
    """Remove solid islands (thin twigs) whose bounding-box diagonal is below min_diag."""
    me = obj.data
    ids, n = islands(me)
    if n < 40:
        return 0
    co = np.empty(len(me.vertices) * 3, np.float32); me.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
    loops = np.empty(len(me.loops), np.int64); me.loops.foreach_get('vertex_index', loops)
    starts = np.empty(len(me.polygons), np.int64); me.polygons.foreach_get('loop_start', starts)
    fv = co[loops[starts]]
    lo = np.full((n, 3), np.inf, np.float32); hi = np.full((n, 3), -np.inf, np.float32)
    np.minimum.at(lo, ids, fv); np.maximum.at(hi, ids, fv)
    small = np.linalg.norm(hi - lo, axis=1) < min_diag
    bm = bmesh.new(); bm.from_mesh(me); bm.faces.ensure_lookup_table()
    kill = [f for f, i in zip(bm.faces, ids.tolist()) if small[i]]
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    bm.to_mesh(me); bm.free()
    return int(small.sum())


def decimate(obj, target, height=1.0):
    """Collapse-decimate; when collapse stalls (open tubes, split seams), weld progressively and retry."""
    bpy.context.view_layer.objects.active = obj
    for weld in (0, 0.0015, 0.004, 0.009):
        have = tri_count(obj.data)
        if have <= target * 1.15:
            return
        if weld:
            bm = bmesh.new(); bm.from_mesh(obj.data)
            bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=weld * height)
            bm.to_mesh(obj.data); bm.free()
            have = tri_count(obj.data)
        m = obj.modifiers.new('dec', 'DECIMATE'); m.ratio = max(target / have, 0.0005); m.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier=m.name)


def image_rgba(path, size, alpha_path=None, name='texture'):
    img = bpy.data.images.load(path, check_existing=False)
    w, h = img.size
    s = min(1.0, size / max(w, h))
    tw, th = max(4, round(w * s)), max(4, round(h * s))
    if (tw, th) != (w, h):
        img.scale(tw, th)
    px = np.empty(tw * th * 4, np.float32); img.pixels.foreach_get(px)
    px = px.reshape(-1, 4)
    if alpha_path:
        a = bpy.data.images.load(alpha_path, check_existing=False)
        a.scale(tw, th)
        ap = np.empty(tw * th * 4, np.float32); a.pixels.foreach_get(ap)
        px[:, 3] = ap.reshape(-1, 4)[:, :3].mean(axis=1)
        bpy.data.images.remove(a)
    out = bpy.data.images.new(name, tw, th, alpha=True)
    out.pixels.foreach_set(px.ravel()); out.pack()
    bpy.data.images.remove(img)
    has_alpha = bool((px[:, 3] < 0.5).any())
    return out, has_alpha


def build_material(name, spec, tex):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree; bsdf = nt.nodes.get('Principled BSDF')
    bsdf.inputs['Roughness'].default_value = spec.get('roughness', 0.85)
    if spec.get('color'):
        bsdf.inputs['Base Color'].default_value = (*spec['color'], 1)
    if spec.get('base'):
        img, has_alpha = image_rgba(spec['base'], tex, spec.get('opacity'), name)
        node = nt.nodes.new('ShaderNodeTexImage'); node.image = img
        nt.links.new(node.outputs['Color'], bsdf.inputs['Base Color'])
        if spec['role'] == 'leaf' and (spec.get('opacity') or has_alpha):
            nt.links.new(node.outputs['Alpha'], bsdf.inputs['Alpha'])
    mat.use_backface_culling = spec['role'] == 'solid'
    return mat


def import_source(path, recipe):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    ext = os.path.splitext(path)[1].lower()
    if ext == '.obj':
        bpy.ops.wm.obj_import(filepath=path, use_split_groups=True, use_split_objects=True)
    else:
        bpy.ops.import_scene.gltf(filepath=path)
    keep = recipe.get('objects')
    for o in list(bpy.context.scene.objects):
        if o.type == 'MESH' and keep and not any(re.search(k, o.name) for k in keep):
            bpy.data.objects.remove(o)
    return [o for o in bpy.context.scene.objects if o.type == 'MESH']


def part_specs(objs, recipe, folder):
    """One spec per (object, material slot): role, base image, opacity image, colour."""
    parts = []
    for o in objs:
        mats = [s.material for s in o.material_slots] or [None]
        for idx, mat in enumerate(mats):
            key = mat.name if mat else o.name
            m = re.search(r'_(\d\d)(?:\.\d+)?$', o.name if recipe.get('by') == 'group' else key)
            spec = {'key': key, 'obj': o, 'slot': idx}
            if recipe.get('by') == 'group' and m:  # CGAxis: group _NN -> <prefix>_NN.jpg
                nn = m.group(1); prefix = recipe['prefix']
                spec['base'] = find_file(folder, f'{prefix}_{nn}.jpg')
                spec['opacity'] = find_file(folder, f'{prefix}_{nn}_opacity.jpg')
                spec['key'] = nn
                if not spec['base'] and mat and mat.use_nodes:
                    bsdf = next((n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
                    spec['color'] = list(bsdf.inputs['Base Color'].default_value)[:3] if bsdf else [0.5, 0.5, 0.5]
            elif mat and mat.use_nodes:
                bsdf = next((n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
                if bsdf:
                    for sock, field in (('Base Color', 'base'), ('Alpha', 'opacity')):
                        node, todo, seen = None, [l.from_node for l in bsdf.inputs[sock].links], set()
                        while todo:  # reverse breadth-first search to the first image texture
                            n = todo.pop(0)
                            if n.name in seen:
                                continue
                            seen.add(n.name)
                            if n.type == 'TEX_IMAGE' and n.image and not re.search(r'normal|gloss|rough|bump', n.image.name, re.I):
                                node = n; break
                            todo += [l.from_node for i in n.inputs for l in i.links]
                        if node:
                            img = node.image
                            fp = bpy.path.abspath(img.filepath) if img.filepath else ''
                            if not os.path.exists(fp):
                                base = re.sub(r'^.*[\\/]', '', fp or img.name)
                                fp = find_file(folder, base) or (find_file(folder, base[4:]) if base.lower().startswith('maps') else None) or ''
                            if not fp and img.packed_file:
                                fp = os.path.join(WORK, '_img_' + re.sub(r'\W', '_', img.name) + '.png')
                                img.filepath_raw = fp; img.file_format = 'PNG'; img.save()
                            spec[field] = fp or None
                    if not spec.get('base'):
                        spec['color'] = list(bsdf.inputs['Base Color'].default_value)[:3]
            if spec.get('base') and spec.get('opacity') == spec.get('base'):
                spec['opacity'] = None
                spec['self_alpha'] = True
            ov = recipe.get('parts', {}).get(spec['key'], {})
            spec.update({k: v for k, v in ov.items()})
            for f in ('base', 'opacity'):
                if ov.get(f) and not os.path.isabs(ov[f]):
                    spec[f] = find_file(folder, ov[f])
            if ov.get('color') and 'base' not in ov:
                spec['base'] = None
            spec.setdefault('role', 'leaf' if (spec.get('opacity') or spec.get('self_alpha')) else 'solid')
            parts.append(spec)
    return parts


def split_by_slot(objs):
    """Separate multi-material objects so each object carries exactly one material slot."""
    out = []
    for o in objs:
        if len(o.material_slots) > 1:
            bpy.ops.object.select_all(action='DESELECT'); o.select_set(True)
            bpy.context.view_layer.objects.active = o
            bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.separate(type='MATERIAL'); bpy.ops.object.mode_set(mode='OBJECT')
            out += [x for x in bpy.context.selected_objects]
        else:
            out.append(o)
    return out


def process(recipe):
    path = extract(recipe)
    folder = os.path.dirname(path)
    objs = split_by_slot(import_source(path, recipe))
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    parts = part_specs(objs, recipe, folder)
    rng = random.Random(recipe['id'])
    budget = recipe.get('budget', 10000)
    leaf_share = recipe.get('leafShare', 0.62)
    source = {'tris': sum(tri_count(o.data) for o in objs)}
    groups = {}
    for p in parts:
        if p['role'] == 'drop':
            bpy.data.objects.remove(p['obj']); continue
        groups.setdefault(p['role'], []).append(p)
    leaf_tris = sum(tri_count(p['obj'].data) for p in groups.get('leaf', []))
    solid_tris = sum(tri_count(p['obj'].data) for p in groups.get('solid', []))
    leaf_budget = budget * (leaf_share if solid_tris else 1.0) if leaf_tris else 0
    solid_budget = budget - leaf_budget if solid_tris else 0
    for p in groups.get('leaf', []):
        t = tri_count(p['obj'].data)
        target = leaf_budget * t / leaf_tris * p.get('share', 1)
        keep = min(1.0, target / t)
        if keep < 0.98:
            enlarge = min(recipe.get('maxEnlarge', 2.4), (1 / keep) ** recipe.get('enlargePower', 0.33))
            ok = thin_leaves(p['obj'], keep, enlarge, rng)
            if not ok:
                decimate(p['obj'], int(target), 1.0)
            print('PART leaf', p['key'], t, '->', tri_count(p['obj'].data), 'thinned' if ok else 'decimated', round(keep, 4), round(enlarge, 2))
    zs = []
    for p in parts:
        if p['role'] != 'drop':
            z = np.empty(len(p['obj'].data.vertices) * 3, np.float32); p['obj'].data.vertices.foreach_get('co', z); zs.append(z[2::3])
    zs = np.concatenate(zs)
    height = float(zs.max() - zs.min())
    prune = recipe.get('prune', 0.035 if recipe.get('kind') == 'tree' else 0)
    if prune:
        for p in groups.get('solid', []):
            before = tri_count(p['obj'].data)
            removed = prune_small(p['obj'], prune * height)
            print('PRUNE', p['key'], before, '->', tri_count(p['obj'].data), 'islands removed', removed)
        solid_tris = sum(tri_count(p['obj'].data) for p in groups.get('solid', []))
    for p in groups.get('solid', []):
        t = tri_count(p['obj'].data)
        decimate(p['obj'], int(max(solid_budget * t / solid_tris * p.get('share', 1), 60)), height)
        print('PART solid', p['key'], t, '->', tri_count(p['obj'].data))
    # materials, one per part
    for i, p in enumerate(parts):
        if p['role'] == 'drop':
            continue
        o = p['obj']
        mat = build_material(f"{recipe['id']}-{p['role']}-{i}", p, p.get('tex', recipe.get('tex', 512) if p['role'] == 'leaf' else recipe.get('solidTex', 256)))
        o.data.materials.clear(); o.data.materials.append(mat)
        o.data.shade_smooth() if p['role'] == 'solid' else None
    live = [p['obj'] for p in parts if p['role'] != 'drop']
    bpy.ops.object.select_all(action='DESELECT')
    for o in live:
        o.select_set(True)
    bpy.context.view_layer.objects.active = live[0]
    if len(live) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.name = recipe['id']; obj.data.name = recipe['id']
    # remove UV maps beyond the first, attributes and loose verts
    while len(obj.data.uv_layers) > 1:
        obj.data.uv_layers.remove(obj.data.uv_layers[-1])
    for a in [a.name for a in obj.data.color_attributes]:
        obj.data.color_attributes.remove(obj.data.color_attributes[a])
    # normalise: height, base centred
    co = np.empty(len(obj.data.vertices) * 3, np.float32); obj.data.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
    lo, hi = co.min(0), co.max(0)
    base = co[co[:, 2] < lo[2] + (hi[2] - lo[2]) * 0.06]
    cx, cy = (base[:, 0].mean(), base[:, 1].mean()) if len(base) else ((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2)
    s = recipe['height'] / (hi[2] - lo[2])
    co = (co - np.array([cx, cy, lo[2]], np.float32)) * s
    obj.data.vertices.foreach_set('co', co.ravel()); obj.data.update()
    final = tri_count(obj.data)
    out = os.path.join(OUT, recipe['id'] + '.glb')
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', use_selection=True, export_image_format='WEBP',
                              export_image_quality=recipe.get('quality', 82), export_tangents=False, export_attributes=False,
                              export_extras=False, export_cameras=False, export_lights=False, export_apply=True,
                              export_yup=True, export_materials='EXPORT', export_vertex_color='NONE')
    fix_alpha(out, recipe)
    size = os.path.getsize(out)
    dims = [round(float(v), 2) for v in (co.max(0) - co.min(0))]
    result = {'id': recipe['id'], 'sourceTriangles': source['tris'], 'triangles': final, 'bytes': size,
              'size': dims, 'roles': sorted({p['role'] for p in parts if p['role'] != 'drop'})}
    print('GREENERY', json.dumps(result))
    return result


def fix_alpha(path, recipe):
    """Leaf materials: alpha MASK (no sorting), double sided. Everything else opaque."""
    data = open(path, 'rb').read()
    jl = struct.unpack_from('<I', data, 12)[0]
    gl = json.loads(data[20:20 + jl])
    for m in gl.get('materials', []):
        leaf = '-leaf-' in m['name']
        if leaf and m.get('alphaMode') in ('BLEND', 'MASK'):
            m['alphaMode'] = 'MASK'; m['alphaCutoff'] = recipe.get('cutoff', 0.42); m['doubleSided'] = True
        elif leaf:
            m['doubleSided'] = True
        else:
            m.pop('alphaMode', None); m.pop('alphaCutoff', None)
    gl.get('asset', {}).pop('generator', None)
    j = json.dumps(gl, separators=(',', ':')).encode()
    j += b' ' * (-len(j) % 4)
    rest = data[20 + jl:]
    body = struct.pack('<I', len(j)) + b'JSON' + j + rest
    open(path, 'wb').write(struct.pack('<III', 0x46546C67, 2, 12 + len(body)) + body)


def record(entry):
    """Merge one result into greenery.manifest.json under a lock (parallel --only runs)."""
    path = os.path.join(OUT, 'greenery.manifest.json')
    with open(path + '.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        data = json.load(open(path)) if os.path.exists(path) else {}
        data[entry['id']] = {k: v for k, v in entry.items() if k != 'id'}
        with open(path, 'w') as f:
            json.dump(dict(sorted(data.items())), f, indent=2)
            f.write('\n')


failed = False
for r in recipes:
    if only and r['id'] not in only:
        continue
    try:
        record(process(r))
    except Exception as e:
        import traceback; traceback.print_exc()
        print('GREENERY', json.dumps({'id': r['id'], 'error': str(e)}))
        failed = True
if failed:
    raise SystemExit(1)
