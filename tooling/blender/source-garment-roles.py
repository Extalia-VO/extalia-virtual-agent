"""Opt-in original trouser-component roles; no source mesh welding or geometric edits."""
import re

import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree


KNOWN_TROUSER_SETS = frozenset(('black-business-suit', 'mens-two-piece-suit', 'prom-suit',
                              'sweatshirt-jacket-workwear', 'source-white-suit'))


def _part(mesh, polygon):
    attribute = mesh.attributes.get('part')
    if attribute is not None and attribute.domain == 'FACE':
        return int(attribute.data[polygon.index].value)
    name = mesh.materials[polygon.material_index].name
    match = re.search(r'_P(\d+)S\d+', name)
    return int(match.group(1)) if match else polygon.material_index


def inspect_components(obj, ref, math_module):
    """Return auxiliary source-part components and bounded primary trouser candidates."""
    points, _triangles = math_module.mesh_arrays(obj)
    parent, rank, nodes, coincident = [], [], {}, {}

    def find(index):
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def join(a, b):
        a, b = find(a), find(b)
        if a == b:
            return
        if rank[a] < rank[b]:
            a, b = b, a
        parent[b] = a
        if rank[a] == rank[b]:
            rank[a] += 1

    faces = []
    for polygon in obj.data.polygons:
        if not obj.data.materials:
            continue
        name = obj.data.materials[polygon.material_index].name
        if not re.match(r'^Original(?:Top|Bottom|Outer|Accent)_', name):
            continue
        part = _part(obj.data, polygon)
        face_nodes = []
        for vertex in polygon.vertices:
            key = (part, int(vertex))
            node = nodes.get(key)
            if node is None:
                node = len(parent)
                nodes[key] = node
                parent.append(node); rank.append(0)
                # Only the auxiliary graph joins UV-seam duplicates within this original part.
                spatial = (part, *np.rint(points[vertex] * 1e5).astype(np.int64).tolist())
                previous = coincident.get(spatial)
                if previous is not None:
                    join(node, previous)
                else:
                    coincident[spatial] = node
            face_nodes.append(node)
        for node in face_nodes[1:]:
            join(face_nodes[0], node)
        faces.append((polygon.index, face_nodes[0]))
    components = {}
    for (part, vertex), node in nodes.items():
        root = find(node)
        component = components.setdefault(root, {'parts': set(), 'vertices': set(), 'faces': []})
        component['parts'].add(part); component['vertices'].add(vertex)
    for face, node in faces:
        components[find(node)]['faces'].append(face)
    hip = float(ref.joint['hips'][2])
    knee = float((ref.joint['leftLowerLeg'][2] + ref.joint['rightLowerLeg'][2]) / 2)
    result = []
    for component in components.values():
        vertices = np.array(sorted(component['vertices']), dtype=np.int64)
        sample = points[vertices]
        low, high = sample.min(0), sample.max(0)
        result.append({**component, 'vertices': vertices, 'low': low, 'high': high,
            'primary': bool(high[2] <= hip + .15 and low[2] <= knee + .12 and high[2] - low[2] > .3)})
    return points, result


def _summary(component):
    return {'parts': sorted(component['parts']), 'vertices': len(component['vertices']),
        'faces': len(component['faces']), 'bounds': [component['low'].tolist(), component['high'].tolist()]}


def _trouser_weight_field(obj, ref, points, components, selected_faces, weights, math_module):
    """Plan a continuous hip/thigh field on complete, explicitly selected panels.

    The same anatomical height gives coincident front/back/UV-seam points the
    same weights. Nearest body triangles never choose between hip and thigh.
    Coordinates and every vertex outside the selected components stay intact.
    """
    if (not isinstance(weights, np.ndarray) or weights.shape != (len(points), len(math_module.BONES))
            or not np.issubdtype(weights.dtype, np.floating) or not weights.flags.writeable
            or not np.isfinite(weights).all()):
        raise ValueError('Smooth trouser weights require a mutable finite canonical weight array')
    selected = {int(vertex) for component in components for vertex in component['vertices']}
    outside = {int(vertex) for polygon in obj.data.polygons if polygon.index not in selected_faces
               for vertex in polygon.vertices}
    if selected & outside:
        raise ValueError('Trouser weight field requires components with no shared non-trouser vertices')
    proposed = weights.copy()
    centre_x = float((ref.joint['leftUpperLeg'][0] + ref.joint['rightUpperLeg'][0]) / 2)
    sides = []
    for component in components:
        ids = component['vertices']
        median_x = float(np.median(points[ids, 0]))
        if abs(median_x - centre_x) < 1e-5:
            raise ValueError('Trouser component has ambiguous left/right ownership')
        side = min(('left', 'right'), key=lambda name: abs(median_x - ref.joint[name + 'UpperLeg'][0]))
        hip_height = float(ref.joint[side + 'UpperLeg'][2])
        thigh = np.clip((hip_height + .09 - points[ids, 2]) / .21, 0., 1.)
        thigh = thigh * thigh * (3 - 2 * thigh)
        proposed[ids] = 0
        proposed[ids, math_module.B['hips']] = 1 - thigh
        proposed[ids, math_module.B[side + 'UpperLeg']] = thigh
        sides.append({'parts': sorted(component['parts']), 'side': side, 'vertices': len(ids),
                      'transitionHeight': [hip_height - .12, hip_height + .09]})
    ids = np.array(sorted(selected), dtype=np.int64)
    delta = np.abs(proposed[ids] - weights[ids])
    return ids, proposed[ids], {'applied': True, 'selectedVertices': len(ids),
        'changedVertices': int((delta.max(1) > 1e-7).sum()), 'maximumWeightChange': float(delta.max()),
        'maximumInfluences': 2, 'nonTrouserWeightsUnchanged': True,
        'geometryAndUVUnchanged': True, 'field': 'canonical-height-hips-to-same-side-thigh',
        'components': sides}


def classify_trouser_components(obj, ref, bindings, recipe, math_module, weights=None):
    """Return (updated source-material bindings, report), preserving every face and UV corner.

    Run on canonical rest geometry before the leg envelope, context generation and binding.
    Only inspected full sets can opt in with classifyTrouserComponents:true.
    smoothTrouserWeights:true also updates the caller's mutable weights in place,
    using complete selected components and an anatomical continuous height field.
    """
    updated = dict(bindings)
    if recipe.get('classifyTrouserComponents') is not True or recipe.get('id') not in KNOWN_TROUSER_SETS or recipe.get('mode', 'outfit') != 'outfit':
        return updated, {'classifiedFaces': 0, 'reason': 'not-an-opted-in-known-trouser-set'}
    points, components = inspect_components(obj, ref, math_module)
    primaries = [component for component in components if component['primary']]
    if not primaries:
        return updated, {'classifiedFaces': 0, 'components': len(components), 'reason': 'no-unambiguous-trouser-components'}
    if recipe.get('id') == 'source-white-suit' and (len(primaries) != 4 or
            {tuple(sorted(component['parts'])) for component in primaries} != {(3,), (4,), (14,), (15,)}):
        raise ValueError('White suit requires its four inspected original trouser components')
    primary_faces = {face for component in primaries for face in component['faces']}
    obj.data.calc_loop_triangles()
    triangles = [list(triangle.vertices) for triangle in obj.data.loop_triangles if triangle.polygon_index in primary_faces]
    tree = BVHTree.FromPolygons([Vector(point) for point in points], triangles, all_triangles=True)
    followers = []
    if weights is not None:
        weights = np.asarray(weights)
        if weights.shape != (len(points), len(math_module.BONES)) or not np.isfinite(weights).all():
            raise ValueError('Trouser follower weights must match canonical source vertices and bones')
        leg = weights[:, math_module.LEG_BONES].sum(1)
        foot = weights[:, [math_module.B['leftFoot'], math_module.B['rightFoot']]].sum(1)
        low = np.min([component['low'] for component in primaries], axis=0)
        high = np.max([component['high'] for component in primaries], axis=0)
        for component in components:
            vertices = component['vertices']
            if component['primary'] or len(vertices) < 3 or leg[vertices].mean() < .5 or foot[vertices].mean() > .5:
                continue
            if np.any(component['low'] < low - .025) or np.any(component['high'] > high + .025):
                continue
            samples = vertices[np.linspace(0, len(vertices) - 1, min(12, len(vertices))).astype(np.int64)]
            if all(tree.find_nearest(Vector(points[index]), .025)[0] is not None for index in samples):
                followers.append(component)
    selected_faces = {face for component in [*primaries, *followers] for face in component['faces']}
    smooth = recipe.get('smoothTrouserWeights', False)
    if not isinstance(smooth, bool):
        raise ValueError('smoothTrouserWeights must be a boolean')
    weight_plan = (_trouser_weight_field(obj, ref, points, [*primaries, *followers], selected_faces,
                                       weights, math_module) if smooth else None)
    # Validate every mapping before making even a material-role change.
    slots = {obj.data.polygons[face].material_index for face in selected_faces}
    for slot in slots:
        name = obj.data.materials[slot].name
        if name not in bindings or isinstance(bindings[name], bool) or not isinstance(bindings[name], int) or bindings[name] < 0:
            raise ValueError('Missing original source graph binding for ' + name)
    replacements, clones = {}, []
    for slot in sorted(slots):
        original = obj.data.materials[slot]
        if original.name.startswith('OriginalBottom_'):
            replacements[slot] = slot
            continue
        material = original.copy()
        material.name = re.sub(r'^Original(?:Top|Outer|Accent)_', 'OriginalBottom_', original.name)
        updated[material.name] = bindings[original.name]
        replacements[slot] = len(obj.data.materials)
        obj.data.materials.append(material)
        clones.append({'from': original.name, 'to': material.name, 'sourceMaterialIndex': bindings[original.name]})
    zone = obj.data.attributes.get('zone')
    for face in selected_faces:
        polygon = obj.data.polygons[face]
        polygon.material_index = replacements[polygon.material_index]
        if zone is not None and zone.domain == 'FACE':
            zone.data[face].value = math_module.Z['bottom']
    obj.data.update()
    if weight_plan is not None:
        ids, values, _report = weight_plan
        weights[ids] = values
    return updated, {'classifiedFaces': len(selected_faces), 'components': len(components),
        'primaryComponents': [_summary(component) for component in primaries],
        'followerComponents': [_summary(component) for component in followers], 'materials': clones,
        'geometryAndUVUnchanged': True,
        'weightField': weight_plan[2] if weight_plan is not None else {'applied': False}}
