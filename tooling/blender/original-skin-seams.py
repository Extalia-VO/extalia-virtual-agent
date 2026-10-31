"""Join generated leg skin to the actual native ankle boundary, without editing source clothes.

Load with importlib and call ``fit_ankle_skin_seams(generated_skin, ref)`` immediately after
``M.build_outfit`` creates the generated skin, before joining it to original garments.
Coordinates are Blender Z-up metres. ``ref.objects['ScanOutfit']`` supplies the native ankle
ring and its weights; the canonical runtime instep correction is mirrored at that ring.
"""
import math

import bmesh
import numpy as np
from mathutils import Vector


SIDES = ('left', 'right')


def _mesh_arrays(obj):
    matrix = obj.matrix_world
    points = np.array([(matrix @ vertex.co)[:] for vertex in obj.data.vertices])
    obj.data.calc_loop_triangles()
    triangles = np.array([tuple(triangle.vertices) for triangle in obj.data.loop_triangles], dtype=np.int64)
    materials = [obj.data.polygons[triangle.polygon_index].material_index for triangle in obj.data.loop_triangles]
    groups = {group.index: group.name for group in obj.vertex_groups}
    weights = [{groups[item.group]: float(item.weight) for item in vertex.groups if item.weight > 0}
               for vertex in obj.data.vertices]
    return points, triangles, materials, weights


def _components(graph):
    unseen = set(graph)
    while unseen:
        start = min(unseen, key=lambda vertex: vertex if isinstance(vertex, int) else vertex.index)
        unseen.remove(start)
        pending, members = [start], []
        while pending:
            vertex = pending.pop(); members.append(vertex)
            for other in graph[vertex]:
                if other in unseen:
                    unseen.remove(other); pending.append(other)
        yield members


def _ordered_loop(members, graph, point):
    if len(members) < 6 or any(len(graph[vertex]) != 2 for vertex in members):
        raise ValueError('An ankle seam must be one closed, non-branching ring')
    start = min(members, key=lambda vertex: (point(vertex)[0], point(vertex)[1]))
    loop, previous, current = [start], None, start
    while True:
        candidates = [other for other in graph[current] if other != previous]
        following = candidates[0]
        if following == start:
            break
        if following in loop:
            raise ValueError('An ankle seam revisited a vertex before closing')
        loop.append(following); previous, current = current, following
    if len(loop) != len(members):
        raise ValueError('An ankle seam has multiple cycles')
    points = [point(vertex) for vertex in loop]
    area = sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(points, points[1:] + points[:1]))
    if area < 0:
        loop = [loop[0]] + list(reversed(loop[1:]))
    return loop


def _native_rings(ref, native_limit):
    obj = ref.objects['ScanOutfit']
    points, triangles, materials, weights = _mesh_arrays(obj)
    names = [material.name if material else '' for material in obj.data.materials]
    kept = [triangle for triangle, material in zip(triangles, materials)
            if names[material].startswith('Skin_') and points[triangle, 2].max() < native_limit]
    # UV seams can duplicate native vertices. Reconstruct their geometric boundary without
    # changing the source, retaining the original coordinates and equivalent bone weights.
    keys, representatives, remap = {}, [], []
    for index, point in enumerate(points):
        key = tuple(np.round(point, 6))
        if key not in keys:
            keys[key] = len(representatives); representatives.append(index)
        remap.append(keys[key])
    edges = {}
    for triangle in kept:
        for a, b in zip(triangle, np.roll(triangle, -1)):
            edge = tuple(sorted((remap[int(a)], remap[int(b)])))
            if edge[0] != edge[1]:
                edges[edge] = edges.get(edge, 0) + 1
    graph = {}
    for (a, b), count in edges.items():
        if count == 1:
            graph.setdefault(a, set()).add(b); graph.setdefault(b, set()).add(a)
    candidates = {side: [] for side in SIDES}
    get_point = lambda index: points[representatives[index]]
    for members in _components(graph):
        coordinates = np.array([get_point(vertex) for vertex in members])
        if coordinates[:, 2].mean() < .11 or any(len(graph[vertex]) != 2 for vertex in members):
            continue  # lower instep/shoe openings are not the terminal ankle ring
        totals = {side: sum(weight for vertex in members for bone, weight in weights[representatives[vertex]].items()
                            if bone.startswith(side) and any(part in bone for part in ('Leg', 'Foot', 'Toes')))
                  for side in SIDES}
        side = max(totals, key=totals.get)
        if totals[side] < len(members) * .5:
            continue
        loop = _ordered_loop(members, graph, get_point)
        candidates[side].append((float(coordinates[:, 2].mean()), loop))
    rings = {}
    for side in SIDES:
        if not candidates[side]:
            raise ValueError(f'No closed native upper ankle boundary for {side}')
        _, loop = max(candidates[side], key=lambda item: item[0])
        ids = [representatives[index] for index in loop]
        rings[side] = {'points': points[ids].copy(), 'weights': [dict(weights[index]) for index in ids]}
    return rings


def _correct_native_ring(ring, ankle):
    # Same monotone instep map as sourceFootGeometry.ts. The upper ankle ring is mostly
    # above its reach; its lowest vertices still need this exact small correction to meet
    # the already-corrected native skin at runtime.
    points = ring['points'].copy()
    for index, point in enumerate(points):
        dy = point[2] - ankle[2]
        if dy >= .08:
            continue
        t = min(1.0, max(0.0, (dy - .03) / .05)); strength = 1 - t * t * (3 - 2 * t)
        excess = max(0.0, ankle[1] - point[1] - .025)
        tucked = .12 * excess + .88 * .005 * -math.expm1(-excess / .005)
        points[index, 1] += (excess - tucked) * strength
        lateral = point[0] - ankle[0]; excess_x = max(0.0, abs(lateral) - .026)
        tucked_x = .12 * excess_x + .88 * .003 * -math.expm1(-excess_x / .003)
        points[index, 0] += math.copysign(1.0, lateral) * (tucked_x - excess_x) * strength
    return points


def _parameters(points):
    lengths = np.linalg.norm(np.roll(points, -1, axis=0) - points, axis=1)
    total = float(lengths.sum())
    if total < .02:
        raise ValueError('Degenerate ankle seam circumference')
    return np.concatenate(([0.0], np.cumsum(lengths) / total))


def _blend_weights(a, b, mix):
    result = {name: a.get(name, 0) * (1 - mix) + b.get(name, 0) * mix for name in set(a) | set(b)}
    result = dict(sorted(((name, value) for name, value in result.items() if value > 1e-6), key=lambda item: -item[1])[:4])
    total = sum(result.values())
    if total <= 0:
        raise ValueError('An ankle seam has no bone weights')
    return {name: value / total for name, value in result.items()}


def _cut_ring_summary(skin_obj, height):
    """Inspect a disposable cut, retaining the distinction between arcs and rings."""
    world = skin_obj.matrix_world
    inverse = world.inverted()
    bm = bmesh.new()
    try:
        bm.from_mesh(skin_obj.data)
        plane = inverse @ Vector((0, 0, height))
        normal = (world.to_3x3().transposed() @ Vector((0, 0, 1))).normalized()
        bmesh.ops.bisect_plane(bm, geom=list(bm.verts) + list(bm.edges) + list(bm.faces), dist=1e-7,
                               plane_co=plane, plane_no=normal, clear_inner=True, clear_outer=False)
        point = lambda vertex: np.array((world @ vertex.co)[:])
        graph = {}
        for edge in bm.edges:
            if edge.is_boundary and all(abs(point(vertex)[2] - height) < .00001 for vertex in edge.verts):
                a, b = edge.verts
                graph.setdefault(a, set()).add(b)
                graph.setdefault(b, set()).add(a)
        closed, open_components = [], 0
        for members in _components(graph):
            if len(members) >= 6 and all(len(graph[vertex]) == 2 for vertex in members):
                coordinates = np.array([point(vertex) for vertex in members])
                closed.append({'vertices': len(members), 'center_x': float(coordinates[:, 0].mean())})
            else:
                open_components += 1
        return {'height': float(height), 'closed_rings': closed, 'open_components': open_components}
    finally:
        bm.free()


def _seam_plan(skin_obj, rings, join_height):
    native_max = max(float(ring['points'][:, 2].max()) for ring in rings.values())
    midline = float(np.mean([ring['points'][:, 0].mean() for ring in rings.values()]))
    requested = max(join_height, native_max + .055)
    # A short exposed ankle can have a complete ring below a clipped calf. Keep
    # at least 10 mm above the highest native ankle point; do not cross into feet.
    heights = [requested]
    heights.extend(requested - .005 * step for step in range(1, int((requested - native_max - .010) / .005) + 1))
    attempts = []
    for height in heights:
        cut = _cut_ring_summary(skin_obj, height)
        attempts.append(cut)
        closed = sorted(cut['closed_rings'], key=lambda item: item['center_x'])
        if len(closed) == 2 and not cut['open_components'] and closed[0]['center_x'] < midline < closed[1]['center_x']:
            return {'status': 'ready', 'join_height': float(height), 'requested_join_height': float(requested),
                    'adaptive': len(attempts) > 1, 'native_vertices': {side: len(rings[side]['points']) for side in SIDES},
                    'cuts': attempts}
    partial = any(cut['closed_rings'] or cut['open_components'] for cut in attempts)
    return {'status': 'partial' if partial else 'absent', 'join_height': None,
            'requested_join_height': float(requested), 'adaptive': False,
            'native_vertices': {side: len(rings[side]['points']) for side in SIDES}, 'cuts': attempts,
            'reason': 'Coverage exposes ankle patches, not two complete calf rings' if partial
                      else 'Generated skin does not cross an eligible calf join plane'}


def ankle_skin_seam_plan(skin_obj, ref, native_limit=.18, join_height=.215):
    """Read-only eligibility/height plan for callers with partially covered ankles.

    ``ready`` permits the existing two-ring bridge. ``partial``/``absent`` need
    an explicit coverage decision by the caller; they never imply permission to
    create complete bare calves or silently discard the generated skin patches.
    """
    if not skin_obj.data.materials or any(not material or not material.name.startswith('Skin_') for material in skin_obj.data.materials):
        raise ValueError('Expected generated skin only; original garments must never be passed')
    return _seam_plan(skin_obj, _native_rings(ref, native_limit), join_height)


def fit_ankle_skin_seams(skin_obj, ref, native_limit=.18, join_height=.215):
    """Replace only generated skin below a level calf ring and bridge to each native ankle.

    Native-ring positions and weights match the retained runtime ankle skin. Source garment
    objects and ``ref.objects['ScanOutfit']`` are read-only. Returns compact review statistics.
    """
    if not skin_obj.data.materials or any(not material or not material.name.startswith('Skin_') for material in skin_obj.data.materials):
        raise ValueError('Expected generated skin only; original garments must never be passed')
    rings = _native_rings(ref, native_limit)
    plan = _seam_plan(skin_obj, rings, join_height)
    if plan['status'] != 'ready':
        raise ValueError('Ankle seam coverage is ' + plan['status'] + ': ' + plan['reason']
                         + '; inspect ankle_skin_seam_plan before choosing a partial-coverage policy')
    join_height = plan['join_height']
    for side in SIDES:
        bone = ref.rig.data.bones[side + 'Foot']
        ankle = np.array((ref.rig.matrix_world @ bone.head_local)[:])
        rings[side]['points'] = _correct_native_ring(rings[side], ankle)
    world, inverse = skin_obj.matrix_world.copy(), skin_obj.matrix_world.inverted()
    bm = bmesh.new(); bm.from_mesh(skin_obj.data)
    deform = bm.verts.layers.deform.verify()
    group_names = {group.index: group.name for group in skin_obj.vertex_groups}
    group_ids = {group.name: group.index for group in skin_obj.vertex_groups}
    for ring in rings.values():
        for row in ring['weights']:
            for name in row:
                if name not in group_ids:
                    group = skin_obj.vertex_groups.new(name=name); group_ids[name] = group.index; group_names[group.index] = name
    plane = inverse @ Vector((0, 0, join_height))
    normal = (world.to_3x3().transposed() @ Vector((0, 0, 1))).normalized()
    bmesh.ops.bisect_plane(bm, geom=list(bm.verts) + list(bm.edges) + list(bm.faces), dist=1e-7,
                           plane_co=plane, plane_no=normal, clear_inner=True, clear_outer=False)
    bm.verts.index_update()
    graph = {}
    point = lambda vertex: np.array((world @ vertex.co)[:])
    for edge in bm.edges:
        if edge.is_boundary and all(abs(point(vertex)[2] - join_height) < .00001 for vertex in edge.verts):
            a, b = edge.verts; graph.setdefault(a, set()).add(b); graph.setdefault(b, set()).add(a)
    loops = []
    for members in _components(graph):
        loops.append(_ordered_loop(members, graph, point))
    if len(loops) != 2:
        bm.free(); raise ValueError(f'Expected two generated calf rings, found {len(loops)}')
    loops.sort(key=lambda loop: float(np.array([point(vertex) for vertex in loop])[:, 0].mean()))
    ordered_sides = sorted(SIDES, key=lambda side: float(rings[side]['points'][:, 0].mean()))
    new_faces, reports = [], {}
    def row(vertex):
        return {group_names[index]: float(value) for index, value in vertex[deform].items() if index in group_names and value > 0}
    def vertex_at(coordinate, weights):
        vertex = bm.verts.new(inverse @ Vector(coordinate)); data = vertex[deform]
        for name, value in weights.items():
            data[group_ids[name]] = value
        return vertex
    def bridge(upper, lower):
        top_parameters = _parameters(np.array([point(vertex) for vertex in upper]))
        low_parameters = _parameters(np.array([point(vertex) for vertex in lower]))
        i = j = 0
        while i < len(upper) or j < len(lower):
            top_next = top_parameters[i + 1] if i < len(upper) else math.inf
            low_next = low_parameters[j + 1] if j < len(lower) else math.inf
            a, b = upper[i % len(upper)], lower[j % len(lower)]
            if top_next <= low_next:
                face = bm.faces.new((a, b, upper[(i + 1) % len(upper)])); i += 1
            else:
                face = bm.faces.new((a, b, lower[(j + 1) % len(lower)])); j += 1
            face.material_index = 0; face.smooth = True; new_faces.append(face)
    for side, upper in zip(ordered_sides, loops):
        ring = rings[side]; target = ring['points']
        # Preserve native edge order and start on the same left-most radial direction.
        start = min(range(len(target)), key=lambda index: (target[index, 0], target[index, 1]))
        target = np.roll(target, -start, axis=0); target_weights = ring['weights'][start:] + ring['weights'][:start]
        upper_points = np.array([point(vertex) for vertex in upper]); params = _parameters(upper_points)
        target_params = _parameters(target)
        lower = [vertex_at(coordinate, weights) for coordinate, weights in zip(target, target_weights)]
        middle = []
        for coordinate, weights, fraction in zip(target, target_weights, target_params[:-1]):
            segment = min(len(upper) - 1, int(np.searchsorted(params, fraction, side='right') - 1))
            mix = float((fraction - params[segment]) / max(params[segment + 1] - params[segment], 1e-12))
            a, b = upper[segment], upper[(segment + 1) % len(upper)]
            top = point(a) * (1 - mix) + point(b) * mix
            co = coordinate * .35 + top * .65
            if not plan['adaptive']:
                co[2] = join_height - .022
            top_weights = _blend_weights(row(a), row(b), mix)
            middle.append(vertex_at(co, _blend_weights(weights, top_weights, .65)))
        bridge(upper, middle); bridge(middle, lower)
        reports[side] = {'native_vertices': len(lower), 'calf_vertices': len(upper),
                         'native_min_z': float(target[:, 2].min()), 'native_max_z': float(target[:, 2].max())}
    bm.normal_update(); bm.to_mesh(skin_obj.data); bm.free(); skin_obj.data.update()
    result = {'join_height': join_height, 'bridge_triangles': len(new_faces), 'feet': reports,
              'adaptive_join': plan['adaptive']}
    print('ORIGINAL_SKIN_SEAMS', result, flush=True)
    return result
