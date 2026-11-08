"""Find and fix inner garment layers that poke through outer ones when a character sits or walks.

    Blender -b --factory-startup --python-exit-code 1 --python tooling/blender/garment-layers.py -- audit <garment.glb>...
    Blender -b --factory-startup --python-exit-code 1 --python tooling/blender/garment-layers.py -- fix <garment.glb> ['<json>']

Layers by material role, inside to outside: Skin_* < *Bottom* < *Top*/*Underlap* < *Outer*. In the bind pose
the fitters keep each layer outside the one beneath, but every layer follows its own skin weights, so sitting
(thighs forward, knees bent, torso leaning in) and walking (thighs swinging) can carry an inner layer out through
the one over it: legs through a skirt, trouser seats through a shirt's hem, a waistband through a jacket.

audit poses the garment's own rig (standing, seated, walking, reaching; seated drape morphs in full while seated,
walk drape while walking, as the runtime blends them) and counts, per pose, inner vertices covered by an
outer layer (within `reach` of it in the bind pose) that end up outside it.

fix conforms covered inner CLOTH vertices to the layer over them: their skin weights and drape-morph deltas become
the outer surface's (interpolated where its outward ray meets it), and they move to `clearance` beneath that surface. Hidden under the outer
layer either way, they now bend with it. Body skin keeps its anatomical binding: a sleeve near the waist
must never turn pelvis skin into an arm, or vice versa. Runtime opaque-trouser coverage handles hidden skin.
Only POSITION, JOINTS_0 and
WEIGHTS_0 of the inner primitives are rewritten in the GLB; morph targets, materials and textures are kept.
sleeves gives cloth near arm skin (within `reach`, default 0.15 m) that skin's weights, blended in by how arm-led
the skin is, so loose sleeves bend with the elbow instead of leaving the forearm to poke through.

drape lifts an outer layer's drape morph (default ExtaliaSeatedDrape, posed seated) over every covered inner
point that still pokes through in that pose: nearby outer vertices are raised along the point's outward
direction to `clearance` outside it, converted back to bind space through each vertex's blended skinning, and
added to the morph, so only that pose changes. Options: pose, target, radius (0.05 m), clearance (0.006 m), rounds (4).

Options: reach (default 0.06 m), clearance (0.003 m), min_y (skip covered vertices below this height, for
skirts and dresses), bones (regex: only vertices led by these bones, e.g. Arm), inner (regex on the inner material), morphs (default true: also copy drape deltas; skirts
whose seated drape lifts far onto the lap conform better without).
"""
import bpy, sys, json, struct, math, re
import numpy as np
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

args = sys.argv[sys.argv.index('--') + 1:]
mode = args[0]

LAYER = [('Skin_', 0), ('Bottom', 1), ('Top', 2), ('Underlap', 2), ('Outer', 3)]


def layer_of(material):
    if material.startswith('Skin_'):
        return 0
    for key, rank in LAYER[1:]:
        if key in material:
            return rank
    return None  # accents, shoes, trims: not part of the stacking


# ---------- GLB access ----------
def read_glb(path):
    data = bytearray(open(path, 'rb').read())
    jl = struct.unpack_from('<I', data, 12)[0]
    return data, json.loads(bytes(data[20:20 + jl])), 20 + jl + 8


def accessor(data, doc, bin_start, index):
    acc = doc['accessors'][index]
    view = doc['bufferViews'][acc['bufferView']]
    comps = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}[acc['type']]
    dtype = {5126: np.float32, 5125: np.uint32, 5123: np.uint16, 5121: np.uint8}[acc['componentType']]
    size = np.dtype(dtype).itemsize * comps
    stride = view.get('byteStride', size)
    start = bin_start + view.get('byteOffset', 0) + acc.get('byteOffset', 0)
    raw = np.frombuffer(bytes(data[start:start + stride * (acc['count'] - 1) + size]), np.uint8)
    rows = np.lib.stride_tricks.as_strided(raw, (acc['count'], size), (stride, 1)).copy()
    return rows.view(dtype).reshape(acc['count'], comps), (start, stride, dtype, comps, acc.get('normalized', False))


def write_accessor(data, layout, values):
    start, stride, dtype, comps, _ = layout
    values = np.ascontiguousarray(values.astype(dtype).reshape(-1, comps))
    size = values.itemsize * comps
    for i, row in enumerate(values):
        data[start + i * stride:start + i * stride + size] = row.tobytes()


def weights_float(values, layout):
    dtype, normalized = layout[2], layout[4]
    if dtype == np.float32:
        return values.astype(np.float64)
    return values.astype(np.float64) / np.iinfo(dtype).max


def weights_encode(values, layout):
    dtype = layout[2]
    if dtype == np.float32:
        return values.astype(np.float32)
    top = np.iinfo(dtype).max
    q = np.round(values * top).astype(np.int64)
    q[:, 0] += top - q.sum(1)  # exact sum after rounding
    return np.clip(q, 0, top).astype(dtype)


def primitives(doc):
    """Skinned primitives with their stacking rank."""
    out = []
    for node in doc['nodes']:
        if 'mesh' not in node or 'skin' not in node:
            continue
        for prim in doc['meshes'][node['mesh']]['primitives']:
            name = doc['materials'][prim['material']]['name'] if 'material' in prim else ''
            rank = layer_of(name)
            if rank is not None and 'JOINTS_0' in prim['attributes']:
                names = doc['meshes'][node['mesh']].get('extras', {}).get('targetNames', [])
                out.append((prim, name, rank, node['skin'], names))
    return out


def triangles(data, doc, bin_start, prim):
    if 'indices' not in prim:
        n = doc['accessors'][prim['attributes']['POSITION']]['count']
        return np.arange(n).reshape(-1, 3)
    idx, _ = accessor(data, doc, bin_start, prim['indices'])
    return idx.reshape(-1, 3).astype(np.int64)


# ---------- skinning (linear blend, in the glTF frame) ----------
def node_world(doc, override=None):
    world = [None] * len(doc['nodes'])
    parent = {c: i for i, n in enumerate(doc['nodes']) for c in n.get('children', [])}

    def local(n):
        if override and n.get('name') in override:
            n = {**n, 'rotation': override[n['name']]}
        if 'matrix' in n:
            return np.array(n['matrix']).reshape(4, 4).T
        t = n.get('translation', [0, 0, 0]); r = n.get('rotation', [0, 0, 0, 1]); s = n.get('scale', [1, 1, 1])
        x, y, z, w = r
        R = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                      [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                      [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
        M = np.eye(4); M[:3, :3] = R * np.array(s); M[:3, 3] = t
        return M

    def get(i):
        if world[i] is None:
            world[i] = (get(parent[i]) if i in parent else np.eye(4)) @ local(doc['nodes'][i])
        return world[i]
    for i in range(len(doc['nodes'])):
        get(i)
    return world, parent


def rot(axis, deg):
    a = math.radians(deg); axis = np.array(axis, float) / np.linalg.norm(axis)
    x, y, z = axis; c, s = math.cos(a), math.sin(a); C = 1 - c
    R = np.eye(4)
    R[:3, :3] = [[c + x * x * C, x * y * C - z * s, x * z * C + y * s], [y * x * C + z * s, c + y * y * C, y * z * C - x * s], [z * x * C - y * s, z * y * C + x * s, c + z * z * C]]
    return R


# Pose: bone name -> rotation about a world axis through the bone's rest head (glTF frame: x left, y up, z forward).
POSES = {
    'standing': {},
    'seated': {'leftUpperLeg': ([1, 0, 0], -88), 'rightUpperLeg': ([1, 0, 0], -88),
               'leftLowerLeg': ([1, 0, 0], 88), 'rightLowerLeg': ([1, 0, 0], 88), 'spine': ([1, 0, 0], 8), 'chest': ([1, 0, 0], 6)},
    'walk': {'leftUpperLeg': ([1, 0, 0], -30), 'rightUpperLeg': ([1, 0, 0], 22),
             'leftLowerLeg': ([1, 0, 0], 12), 'rightLowerLeg': ([1, 0, 0], 38), 'spine': ([0, 1, 0], 6)},
    'type': {'leftUpperArm': ([1, 0, 0], -45), 'rightUpperArm': ([1, 0, 0], -45), 'leftLowerArm': ([1, 0, 0], -75),
             'rightLowerArm': ([1, 0, 0], -75), 'leftUpperLeg': ([1, 0, 0], -88), 'rightUpperLeg': ([1, 0, 0], -88),
             'leftLowerLeg': ([1, 0, 0], 88), 'rightLowerLeg': ([1, 0, 0], 88)},
    'reach': {'spine': ([1, 0, 0], 18), 'chest': ([1, 0, 0], 10), 'leftUpperLeg': ([1, 0, 0], -88), 'rightUpperLeg': ([1, 0, 0], -88),
              'leftLowerLeg': ([1, 0, 0], 88), 'rightLowerLeg': ([1, 0, 0], 88)},
}


def joint_matrices(doc, skin_index, pose):
    """Skinning matrices (posed world x inverse bind) for a skin under a pose."""
    if isinstance(pose, dict) and pose.get('__local__'):
        posed, parent = node_world(doc, pose['__local__'])
        rest, _ = node_world(doc)
        skin = doc['skins'][skin_index]
        mats = [posed[j] @ _IBM[skin_index][k] for k, j in enumerate(skin['joints'])]
        joint_set = set(skin['joints']); segments = []
        for j in skin['joints']:
            head = posed[j][:3, 3]
            kids = [c for c in doc['nodes'][j].get('children', []) if c in joint_set]
            tail = np.mean([posed[c][:3, 3] for c in kids], axis=0) if kids else head + (posed[j][:3, :3] @ np.array([0, .1, 0]))
            segments.append((head, tail))
        return mats, segments
    world, parent = node_world(doc)
    skin = doc['skins'][skin_index]
    names = {i: doc['nodes'][i].get('name', '') for i in range(len(doc['nodes']))}
    # Pose: each rotated bone turns about its rest head; children follow.
    posed = [w.copy() for w in world]
    order = sorted(range(len(doc['nodes'])), key=lambda i: _depth(i, parent))
    delta = {i: np.eye(4) for i in range(len(doc['nodes']))}
    for i in order:
        d = delta[parent[i]] if i in parent else np.eye(4)
        name = names[i]
        if name in pose:
            axis, deg = pose[name]
            head = world[i][:3, 3]
            T = np.eye(4); T[:3, 3] = head; Ti = np.eye(4); Ti[:3, 3] = -head
            d = d @ (T @ rot(axis, deg) @ Ti)
        delta[i] = d
        posed[i] = d @ world[i]
    mats = [posed[j] @ _IBM[skin_index][k] for k, j in enumerate(skin['joints'])]
    joint_set = set(skin['joints'])
    segments = []
    for j in skin['joints']:
        head = posed[j][:3, 3]
        kids = [c for c in doc['nodes'][j].get('children', []) if c in joint_set]
        tail = np.mean([posed[c][:3, 3] for c in kids], axis=0) if kids else head + (posed[j][:3, :3] @ np.array([0, .1, 0]))
        segments.append((head, tail))
    return mats, segments


def _depth(i, parent):
    d = 0
    while i in parent:
        i = parent[i]; d += 1
    return d


_IBM = {}


def load_ibm(data, doc, bin_start):
    for s, skin in enumerate(doc['skins']):
        m, _ = accessor(data, doc, bin_start, skin['inverseBindMatrices'])
        _IBM[s] = [row.reshape(4, 4).T for row in m]


# Live poses captured from the running Office (local bone rotations of seated, typing characters).
import os
if os.environ.get('GARMENT_POSES'):
    for live in json.load(open(os.environ['GARMENT_POSES'])):
        POSES[live['name']] = {'__local__': live['bones']}

POSE_MORPHS = {**{name: 'ExtaliaSeatedDrape' for name in POSES if name.startswith('live')}, 'seated': 'ExtaliaSeatedDrape', 'reach': 'ExtaliaSeatedDrape', 'type': 'ExtaliaSeatedDrape', 'walk': 'ExtaliaWalkDrape'}


def morphed(prim, pose_name):
    """Bind positions with the pose's drape morph applied in full, as the runtime does."""
    name = POSE_MORPHS.get(pose_name)
    pos = prim['pos']
    for target in prim['targets']:
        if target and target['name'] == name:
            pos = pos + target['delta']
    return pos


def skin_points(points, joints, weights, mats):
    out = np.zeros_like(points)
    hom = np.c_[points, np.ones(len(points))]
    for k in range(joints.shape[1]):
        M = np.stack([mats[j] for j in joints[:, k]])
        out += weights[:, k:k + 1] * np.einsum('nij,nj->ni', M, hom)[:, :3]
    return out


# ---------- analysis ----------
def load(path):
    data, doc, bin_start = read_glb(path)
    load_ibm(data, doc, bin_start)
    prims = []
    for prim, name, rank, skin, target_names in primitives(doc):
        pos, pl = accessor(data, doc, bin_start, prim['attributes']['POSITION'])
        targets = []
        for t, target in enumerate(prim.get('targets', [])):
            if 'POSITION' not in target or 'sparse' in doc['accessors'][target['POSITION']]:
                targets.append(None); continue
            delta, layout = accessor(data, doc, bin_start, target['POSITION'])
            targets.append({'name': target_names[t] if t < len(target_names) else f'target{t}', 'delta': delta.astype(np.float64), 'layout': layout,
                            'accessor': target['POSITION']})
        jnt, jl = accessor(data, doc, bin_start, prim['attributes']['JOINTS_0'])
        wgt, wl = accessor(data, doc, bin_start, prim['attributes']['WEIGHTS_0'])
        prims.append({'prim': prim, 'name': name, 'rank': rank, 'skin': skin, 'pos': pos.astype(np.float64), 'pl': pl,
                      'jnt': jnt.astype(np.int64), 'jl': jl, 'wgt': weights_float(wgt, wl), 'wl': wl,
                      'tri': triangles(data, doc, bin_start, prim), 'targets': targets})
    return data, doc, bin_start, prims


def bvh(points, tris):
    return BVHTree.FromPolygons([tuple(p) for p in points], [tuple(int(v) for v in t) for t in tris])


def outward(points, joints, weights, segments):
    """Unit directions from each vertex's dominant bone axis out through the vertex."""
    dirs = np.zeros_like(points)
    dominant = joints[np.arange(len(points)), weights.argmax(1)]
    for k, (head, tail) in enumerate(segments):
        sel = dominant == k
        if not sel.any():
            continue
        axis = tail - head; length = axis @ axis or 1e-9
        t = np.clip(((points[sel] - head) @ axis) / length, 0, 1)
        d = points[sel] - (head + t[:, None] * axis)
        dirs[sel] = d / np.maximum(np.linalg.norm(d, axis=1, keepdims=True), 1e-9)
    return dirs


def merged(outers, key):
    pts = np.vstack([o[key] for o in outers])
    offsets = np.cumsum([0] + [len(o['pos']) for o in outers])
    tri = np.vstack([o['tri'] + offsets[i] for i, o in enumerate(outers)])
    return pts, tri


def covered_pairs(prims, doc, reach):
    """Inner vertices whose outward ray meets a higher layer within `reach` in the bind pose: (vertex, face, hit, dir)."""
    pairs = []
    rest = {s: joint_matrices(doc, s, {})[1] for s in {p['skin'] for p in prims}}
    for inner in prims:
        outers = [o for o in prims if o['rank'] > inner['rank'] and o['skin'] == inner['skin']]
        if not outers:
            continue
        pts, tri = merged(outers, 'pos')
        tree = bvh(pts, tri)
        dirs = outward(inner['pos'], inner['jnt'], inner['wgt'], rest[inner['skin']])
        hits = []
        for v, (p, d) in enumerate(zip(inner['pos'], dirs)):
            if not d.any():
                continue
            loc, n, face, dist = tree.ray_cast(Vector(p - d * .001), Vector(d), reach)
            if loc is not None:
                hits.append((v, face, np.array(loc), d))
        pairs.append((inner, outers, pts, tri, hits))
    return pairs


def audit(path, reach=None):
    reach = reach or float(os.environ.get('GARMENT_REACH', .06))
    data, doc, bin_start, prims = load(path)
    pairs = covered_pairs(prims, doc, reach)
    result = {}
    for pose_name, pose in POSES.items():
        posed_skin = {s: joint_matrices(doc, s, pose) for s in {p['skin'] for p in prims}}
        posed = {id(p): skin_points(morphed(p, pose_name), p['jnt'], p['wgt'], posed_skin[p['skin']][0]) for p in prims}
        poke = total = 0
        for inner, outers, _, tri, hits in pairs:
            if not hits:
                continue
            tree = bvh(np.vstack([posed[id(o)] for o in outers]), tri)
            ip = posed[id(inner)]
            dirs = outward(ip, inner['jnt'], inner['wgt'], posed_skin[inner['skin']][1])
            for v, _face, _hit, _d in hits:
                total += 1
                loc, *_ = tree.ray_cast(Vector(ip[v] - dirs[v] * .001), Vector(dirs[v]), .5)
                if loc is None:
                    poke += 1
        result[pose_name] = [poke, total]
    print('LAYERS', path.split('/')[-1], json.dumps(result))


def fix(path, options):
    reach, clearance = options.get('reach', .06), options.get('clearance', .003)
    data, doc, bin_start, prims = load(path)
    changed = 0
    for inner, outers, pts, tri, hits in covered_pairs(prims, doc, reach):
        if inner['rank'] == 0:
            continue  # skin must never inherit the binding or drape of nearby clothing
        if not hits or (options.get('inner') and not re.search(options['inner'], inner['name'])):
            continue
        mjnt = np.vstack([o['jnt'] for o in outers]); mwgt = np.vstack([o['wgt'] for o in outers])
        pos, jnt, wgt = inner['pos'].copy(), inner['jnt'].copy(), inner['wgt'].copy()
        # Drape morphs of the outer layers, by target index (every primitive of a mesh has the same targets).
        mdelta = {}
        for t, target in enumerate(inner['targets'] if options.get('morphs', True) else []):
            if target is None:
                continue
            # An outer layer without this morph does not move in it: the conformed inner must not either.
            mdelta[t] = (np.vstack([o['targets'][t]['delta'] if len(o['targets']) > t and o['targets'][t] is not None
                                    else np.zeros_like(o['pos']) for o in outers]), target['delta'].copy())
        min_y = options.get('min_y', -1e9)
        only = re.compile(options['bones']) if options.get('bones') else None
        joint_names = [doc['nodes'][j].get('name', '') for j in doc['skins'][inner['skin']]['joints']]
        for v, face, hit, d in hits:
            if only and not only.search(joint_names[int(inner['jnt'][v][int(inner['wgt'][v].argmax())])]):
                continue
            if pos[v][1] < min_y:
                continue  # legs under a skirt keep their own weights: the skirt follows the hips, not the thighs
            a, b, c = tri[face]
            A, B, C = pts[a], pts[b], pts[c]
            v0, v1, v2 = B - A, C - A, hit - A
            d00, d01, d11, d20, d21 = v0 @ v0, v0 @ v1, v1 @ v1, v2 @ v0, v2 @ v1
            den = d00 * d11 - d01 * d01 or 1e-12
            bv = (d11 * d20 - d01 * d21) / den; bw = (d00 * d21 - d01 * d20) / den; bu = 1 - bv - bw
            blend = {}
            for vert, f in ((a, bu), (b, bv), (c, bw)):
                for k in range(mjnt.shape[1]):
                    blend[int(mjnt[vert, k])] = blend.get(int(mjnt[vert, k]), 0) + max(f, 0) * mwgt[vert, k]
            top = sorted(blend.items(), key=lambda kv: -kv[1])[:jnt.shape[1]]
            total = sum(w for _, w in top) or 1
            jnt[v] = [j for j, _ in top] + [0] * (jnt.shape[1] - len(top))
            wgt[v] = [w / total for _, w in top] + [0] * (jnt.shape[1] - len(top))
            # Just beneath the outer layer, along the same outward ray, and draping with it.
            pos[v] = hit - d * clearance
            for outer_delta, inner_delta in mdelta.values():
                inner_delta[v] = max(bu, 0) * outer_delta[a] + max(bv, 0) * outer_delta[b] + max(bw, 0) * outer_delta[c]
            changed += 1
        write_accessor(data, inner['pl'], pos)
        for t, (_, inner_delta) in mdelta.items():
            write_accessor(data, inner['targets'][t]['layout'], inner_delta)
            tacc = doc['accessors'][inner['targets'][t]['accessor']]
            tacc['min'] = [float(x) for x in inner_delta.min(0)]; tacc['max'] = [float(x) for x in inner_delta.max(0)]
            inner['targets'][t]['delta'] = inner_delta
        write_accessor(data, inner['jl'], jnt)
        write_accessor(data, inner['wl'], weights_encode(wgt, inner['wl']))
        acc = doc['accessors'][inner['prim']['attributes']['POSITION']]
        acc['min'] = [float(x) for x in pos.min(0)]; acc['max'] = [float(x) for x in pos.max(0)]
        inner['pos'], inner['jnt'], inner['wgt'] = pos, jnt, wgt
    j = json.dumps(doc, separators=(',', ':')).encode(); j += b' ' * (-len(j) % 4)
    old = struct.unpack_from('<I', data, 12)[0]
    body = struct.pack('<I', len(j)) + b'JSON' + j + bytes(data[20 + old:])
    open(path, 'wb').write(struct.pack('<III', 0x46546C67, 2, 12 + len(body)) + body)
    print('CONFORMED', path.split('/')[-1], changed)


def blended(joints, weights, mats):
    M = np.zeros((len(joints), 4, 4))
    for k in range(joints.shape[1]):
        M += weights[:, k, None, None] * np.stack([mats[j] for j in joints[:, k]])
    return M


def drape(path, options):
    """Lift an outer layer's seated drape over inner points that poke through it while seated."""
    pose_name, target_name = options.get('pose', 'seated'), options.get('target', 'ExtaliaSeatedDrape')
    radius, clearance, rounds = options.get('radius', .05), options.get('clearance', .006), options.get('rounds', 4)
    data, doc, bin_start, prims = load(path)
    pairs = covered_pairs(prims, doc, options.get('reach', .06))
    mats, segments = joint_matrices(doc, prims[0]['skin'], POSES[pose_name])
    lifted = 0
    for _ in range(rounds):
        posed = {id(p): skin_points(morphed(p, pose_name), p['jnt'], p['wgt'], mats) for p in prims}
        moves = {id(p): np.zeros_like(p['pos']) for p in prims}
        counts = {id(p): np.zeros(len(p['pos'])) for p in prims}
        any_poke = False
        for inner, outers, _, tri, hits in pairs:
            if not hits:
                continue
            outer_pts = np.vstack([posed[id(o)] for o in outers])
            offsets = np.cumsum([0] + [len(o['pos']) for o in outers])
            tree = bvh(outer_pts, tri)
            ip = posed[id(inner)]
            dirs = outward(ip, inner['jnt'], inner['wgt'], segments)
            from mathutils.kdtree import KDTree
            kd = KDTree(len(outer_pts))
            for i, p in enumerate(outer_pts):
                kd.insert(Vector(p), i)
            kd.balance()
            for v, *_ in hits:
                loc, *_ = tree.ray_cast(Vector(ip[v] - dirs[v] * .001), Vector(dirs[v]), .5)
                if loc is not None:
                    continue
                any_poke = True
                for co, i, dist in kd.find_range(Vector(ip[v]), radius):
                    owner = int(np.searchsorted(offsets, i, side='right') - 1)
                    o = outers[owner]; local = i - offsets[owner]
                    # Raise this outer vertex to clearance outside the poking point, along its outward direction.
                    need = (ip[v] - outer_pts[i]) @ dirs[v] + clearance
                    if need > 0:
                        fade = 1 - dist / radius
                        moves[id(o)][local] += dirs[v] * need * fade
                        counts[id(o)][local] += fade
        if not any_poke:
            break
        for p in prims:
            sel = counts[id(p)] > 0
            if not sel.any():
                continue
            target = next((t for t in p['targets'] if t and t['name'] == target_name), None)
            if target is None:
                continue
            disp = moves[id(p)][sel] / counts[id(p)][sel, None]
            M = blended(p['jnt'][sel], p['wgt'][sel], mats)
            bind = np.einsum('nij,nj->ni', np.linalg.inv(M[:, :3, :3]), disp)
            target['delta'][sel] += bind
            lifted += int(sel.sum())
    for p in prims:
        for target in p['targets']:
            if target and target['name'] == target_name:
                write_accessor(data, target['layout'], target['delta'])
                acc = doc['accessors'][target['accessor']]
                acc['min'] = [float(x) for x in target['delta'].min(0)]; acc['max'] = [float(x) for x in target['delta'].max(0)]
    j = json.dumps(doc, separators=(',', ':')).encode(); j += b' ' * (-len(j) % 4)
    old = struct.unpack_from('<I', data, 12)[0]
    body = struct.pack('<I', len(j)) + b'JSON' + j + bytes(data[20 + old:])
    open(path, 'wb').write(struct.pack('<III', 0x46546C67, 2, 12 + len(body)) + body)
    print('DRAPED', path.split('/')[-1], lifted)


def sleeves(path, options):
    """Sleeves follow the arm: cloth near arm skin takes that skin's weights (blended in across the shoulder)."""
    reach = options.get('reach', .15)
    data, doc, bin_start, prims = load(path)
    skins = [p for p in prims if p['rank'] == 0]
    if not skins:
        print('SLEEVES', path.split('/')[-1], 0); return
    names = [doc['nodes'][j].get('name', '') for j in doc['skins'][skins[0]['skin']]['joints']]
    arm = np.array([bool(re.search('Arm|Hand', n)) for n in names])
    pts, tri = merged(skins, 'pos')
    sjnt = np.vstack([p['jnt'] for p in skins]); swgt = np.vstack([p['wgt'] for p in skins])
    tree = bvh(pts, tri)
    changed = 0
    for cloth in [p for p in prims if p['rank'] > 0 and p['skin'] == skins[0]['skin']]:
        jnt, wgt = cloth['jnt'].copy(), cloth['wgt'].copy()
        for v, p in enumerate(cloth['pos']):
            loc, n, face, dist = tree.find_nearest(Vector(p), reach)
            if loc is None:
                continue
            a, b, c = tri[face]; A, B, C = pts[a], pts[b], pts[c]; P = np.array(loc)
            v0, v1, v2 = B - A, C - A, P - A
            d00, d01, d11, d20, d21 = v0 @ v0, v0 @ v1, v1 @ v1, v2 @ v0, v2 @ v1
            den = d00 * d11 - d01 * d01 or 1e-12
            bv = (d11 * d20 - d01 * d21) / den; bw = (d00 * d21 - d01 * d20) / den; bu = 1 - bv - bw
            blend = {}
            for vert, f in ((a, bu), (b, bv), (c, bw)):
                for k in range(sjnt.shape[1]):
                    blend[int(sjnt[vert, k])] = blend.get(int(sjnt[vert, k]), 0) + max(f, 0) * swgt[vert, k]
            share = sum(w for j, w in blend.items() if arm[j]) / (sum(blend.values()) or 1)
            alpha = min(1, max(0, (share - .3) / .4))
            if alpha <= 0:
                continue
            mix = {int(j): (1 - alpha) * w for j, w in zip(jnt[v], wgt[v]) if w > 0}
            total = sum(blend.values()) or 1
            for j, w in blend.items():
                mix[j] = mix.get(j, 0) + alpha * w / total
            top = sorted(mix.items(), key=lambda kv: -kv[1])[:jnt.shape[1]]
            t = sum(w for _, w in top) or 1
            jnt[v] = [j for j, _ in top] + [0] * (jnt.shape[1] - len(top))
            wgt[v] = [w / t for _, w in top] + [0] * (jnt.shape[1] - len(top))
            changed += 1
        write_accessor(data, cloth['jl'], jnt)
        write_accessor(data, cloth['wl'], weights_encode(wgt, cloth['wl']))
    j = json.dumps(doc, separators=(',', ':')).encode(); j += b' ' * (-len(j) % 4)
    old = struct.unpack_from('<I', data, 12)[0]
    body = struct.pack('<I', len(j)) + b'JSON' + j + bytes(data[20 + old:])
    open(path, 'wb').write(struct.pack('<III', 0x46546C67, 2, 12 + len(body)) + body)
    print('SLEEVES', path.split('/')[-1], changed)


if mode == 'sleeves':
    sleeves(args[1], json.loads(args[2]) if len(args) > 2 else {})
if mode == 'drape':
    drape(args[1], json.loads(args[2]) if len(args) > 2 else {})
if mode == 'audit':
    for path in args[1:]:
        audit(path)
elif mode == 'fix':
    fix(args[1], json.loads(args[2]) if len(args) > 2 else {})
