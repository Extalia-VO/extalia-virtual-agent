"""Audit and correct how published garments sit on their body, in the bind pose.

    Blender -b --factory-startup --python-exit-code 1 --python tooling/blender/garment-fit.py -- \
        audit <body.glb> <garment.glb> [<garment.glb> ...]
    Blender -b --factory-startup --python-exit-code 1 --python tooling/blender/garment-fit.py -- \
        fix <body.glb> <garment.glb> '<json options>'

The reference surface is the body's own skin plus its scanned under-outfit (the tight layer the runtime hides
under garments), so a garment must stay just outside it. For every garment vertex (skin parts of a garment
excluded) the signed distance to that surface is measured along its outward normal.

audit prints, per garment: the share of vertices inside the surface (skin would poke through), and the
clearance over the belly, chest, hips and neck bands (a garment that stands far off the belly reads as
pregnant; one far off everywhere is too big).

fix moves only vertex positions, written straight into the GLB's POSITION accessors (bounds updated), so
materials, compact texture records, skin weights and seated-drape morph targets stay exactly as they are:
  push       optional minimum clearance (m) every garment vertex keeps outside the surface; off by default,
             because the scanned under-outfit stands off the skin and pushing out to it would inflate garments
  bands      {name: [z_min, z_max, max_clearance, front_only]}: vertices in a height band (metres, rest pose)
             farther than max_clearance are drawn in to it (front_only: only the front half, y < body centre)
  falloff    metres over which a band's pull fades out above and below it (default 0.06)
  smooth     Laplacian smoothing iterations of the moved offsets (default 4), so panels do not crease
  neckline   {base, scale, half_width, fade}: compress head-adjacent hood/collar height above base;
             the shoulder/cuff frame and every skin primitive are preserved
"""
import bpy, sys, json, struct, math
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

REFERENCE = ('Body', 'BodyNeckline', 'ScanOutfit')


def load_reference(path):
    """BVH of the body skin and scanned under-outfit in the glTF frame (x, y up, z forward)."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if path.endswith('.blend'):
        with bpy.data.libraries.load(path, link=False) as (source, target):
            target.objects = ['ReferenceBody']
        for obj in target.objects:
            bpy.context.scene.collection.objects.link(obj)
    else:
        bpy.ops.import_scene.gltf(filepath=path)
    verts, tris = [], []
    for obj in bpy.context.scene.objects:
        if obj.type != 'MESH' or not obj.name.split('.')[0] in (*REFERENCE, 'ReferenceBody'):
            continue
        mesh = obj.data
        mesh.calc_loop_triangles()
        base = len(verts)
        for v in mesh.vertices:
            w = obj.matrix_world @ v.co
            verts.append((w.x, w.z, -w.y))  # Blender Z-up -> glTF Y-up
        tris += [tuple(base + i for i in t.vertices) for t in mesh.loop_triangles]
    return BVHTree.FromPolygons(verts, tris), np.array(verts)


def read_glb(path):
    data = bytearray(open(path, 'rb').read())
    jl = struct.unpack_from('<I', data, 12)[0]
    doc = json.loads(bytes(data[20:20 + jl]))
    bin_start = 20 + jl + 8
    return data, doc, bin_start


def accessor_array(data, doc, bin_start, index):
    acc = doc['accessors'][index]
    view = doc['bufferViews'][acc['bufferView']]
    if acc['componentType'] != 5126 or acc['type'] != 'VEC3':
        return None, None
    stride = view.get('byteStride', 12)
    offset = bin_start + view.get('byteOffset', 0) + acc.get('byteOffset', 0)
    raw = np.frombuffer(bytes(data[offset:offset + stride * acc['count']]), np.uint8).reshape(acc['count'], stride)
    return raw[:, :12].copy().view(np.float32).reshape(-1, 3), (offset, stride)


def garment_primitives(doc):
    """(primitive, material name) for non-skin garment primitives with float positions."""
    out = []
    for node in doc['nodes']:
        if 'mesh' not in node:
            continue
        for prim in doc['meshes'][node['mesh']]['primitives']:
            name = doc['materials'][prim['material']]['name'] if 'material' in prim else ''
            if name.startswith('Skin_'):
                continue
            out.append((prim, name))
    return out


def signed_distances(bvh, pts):
    d = np.zeros(len(pts)); nearest = np.zeros_like(pts); normal = np.zeros_like(pts)
    for i, p in enumerate(pts):
        loc, n, _, dist = bvh.find_nearest(Vector(p))
        if loc is None:
            d[i] = 1; continue
        delta = Vector(p) - loc
        d[i] = dist if delta.dot(n) >= 0 else -dist
        nearest[i] = loc; normal[i] = n
    return d, nearest, normal


def neckline_offsets(points, options):
    """Lower only the central cloth above the neckline, with a smooth lateral fade."""
    offsets = np.zeros_like(points)
    if not options:
        return offsets
    base, scale = options['base'], options['scale']
    width, fade = options['half_width'], options.get('fade', .08)
    if not (1.35 <= base <= 1.65 and 0 < scale <= 1 and .12 <= width <= .4 and 0 < fade < width):
        raise ValueError('Invalid neckline fitting bounds')
    t = np.clip((width - np.abs(points[:, 0])) / fade, 0, 1)
    weight = t * t * (3 - 2 * t)
    offsets[:, 1] = -np.maximum(0, points[:, 1] - base) * (1 - scale) * weight
    return offsets


BANDS = {'neck': (1.42, 1.56), 'chest': (1.18, 1.38), 'belly': (0.98, 1.16), 'hips': (0.84, 0.98)}


def audit(bvh, ref, path):
    data, doc, bin_start = read_glb(path)
    centre_z = float(np.median(ref[:, 2]))
    rows = []
    for prim, name in garment_primitives(doc):
        pts, _ = accessor_array(data, doc, bin_start, prim['attributes']['POSITION'])
        if pts is not None:
            rows.append(pts)
    pts = np.vstack(rows)
    d, _, _ = signed_distances(bvh, pts)
    report = {'inside': round(float((d < -0.003).mean()), 3)}
    for band, (lo, hi) in BANDS.items():
        sel = (pts[:, 1] > lo) & (pts[:, 1] < hi) & (pts[:, 2] > centre_z) & (d > -0.05)
        if sel.sum() > 20:
            report[band] = [round(float(np.percentile(d[sel], 50)) * 100, 1), round(float(np.percentile(d[sel], 95)) * 100, 1)]
    print('FIT', path.split('/')[-1], json.dumps(report))


def fix(bvh, ref, path, options):
    data, doc, bin_start = read_glb(path)
    push = options.get('push')
    falloff = options.get('falloff', 0.06)
    centre_z = float(np.median(ref[:, 2]))
    moved_total = 0
    for prim, name in garment_primitives(doc):
        pts, (offset, stride) = accessor_array(data, doc, bin_start, prim['attributes']['POSITION'])
        if pts is None:
            continue
        d, nearest, normal = signed_distances(bvh, pts)
        target = d.copy()
        for band, (lo, hi, max_clear, front_only) in options.get('bands', {}).items():
            y = pts[:, 1]
            weight = np.clip(np.minimum((y - (lo - falloff)) / falloff, ((hi + falloff) - y) / falloff), 0, 1)
            if front_only:
                weight *= np.clip((pts[:, 2] - centre_z) / 0.03, 0, 1)
            pulled = np.minimum(target, max_clear)
            target = target + (pulled - target) * weight * (target > max_clear)
        if push is not None:
            target = np.maximum(target, push)
        # Move along the surface normal by the change in signed distance.
        offset_vec = normal * (target - d)[:, None]
        offset_vec[d > 0.2] = 0  # far parts (skirt hems, hoods) keep their drape
        # Smooth the offsets over the primitive's triangles.
        idx = None
        if 'indices' in prim:
            acc = doc['accessors'][prim['indices']]; view = doc['bufferViews'][acc['bufferView']]
            dtype = {5121: np.uint8, 5123: np.uint16, 5125: np.uint32}[acc['componentType']]
            start = bin_start + view.get('byteOffset', 0) + acc.get('byteOffset', 0)
            idx = np.frombuffer(bytes(data[start:start + acc['count'] * np.dtype(dtype).itemsize]), dtype).reshape(-1, 3)
        if idx is not None:
            for _ in range(options.get('smooth', 4)):
                acc_sum = np.zeros_like(offset_vec); count = np.zeros(len(pts))
                for a, b in ((0, 1), (1, 2), (2, 0)):
                    np.add.at(acc_sum, idx[:, a], offset_vec[idx[:, b]]); np.add.at(count, idx[:, a], 1)
                    np.add.at(acc_sum, idx[:, b], offset_vec[idx[:, a]]); np.add.at(count, idx[:, b], 1)
                avg = acc_sum / np.maximum(count, 1)[:, None]
                offset_vec = .5 * offset_vec + .5 * avg
        # Apply this after distance smoothing: a hood near the head must not be
        # fitted to the jaw merely because it is the nearest reference surface.
        offset_vec += neckline_offsets(pts + offset_vec, options.get('neckline'))
        new = (pts + offset_vec).astype(np.float32)
        moved_total += int((np.linalg.norm(offset_vec, axis=1) > 1e-4).sum())
        for i in range(len(new)):
            data[offset + i * stride:offset + i * stride + 12] = new[i].tobytes()
        acc = doc['accessors'][prim['attributes']['POSITION']]
        acc['min'] = [float(v) for v in new.min(0)]; acc['max'] = [float(v) for v in new.max(0)]
    j = json.dumps(doc, separators=(',', ':')).encode()
    j += b' ' * (-len(j) % 4)
    old_jl = struct.unpack_from('<I', data, 12)[0]
    rest = bytes(data[20 + old_jl:])
    body = struct.pack('<I', len(j)) + b'JSON' + j + rest
    open(path, 'wb').write(struct.pack('<III', 0x46546C67, 2, 12 + len(body)) + body)
    print('FIXED', path.split('/')[-1], 'moved', moved_total)


if __name__ == '__main__':
    args = sys.argv[sys.argv.index('--') + 1:]
    mode, body_path = args[0], args[1]
    bvh, ref = load_reference(body_path)
    if mode == 'audit':
        for garment in args[2:]:
            audit(bvh, ref, garment)
    elif mode == 'fix':
        fix(bvh, ref, args[2], json.loads(args[3]) if len(args) > 3 else {})
