"""Recipe-driven topology binding for a joined bodice and hanging sleeves.

Only weights change. The auxiliary positional graph never welds the source mesh,
edits UVs, removes faces, or changes materials. Call before inverse skinning.
``topologyBinding`` supplies ``mainMaterials``, ``ribMaterials``, and
``followMaterials`` as original glTF material indices.

CAD ownership thresholds are opt-in recipe values in registered source-pose
metres: ``componentCoreContactX`` recognizes split torso halves, while
``componentCoreTailX`` preserves lateral sleeve tails as mixed components.
``componentSleeveSideX`` and ``componentSleeveTopHeight`` identify separate
sleeve caps/linings. ``componentCoreBands`` contains whole-component bounds
(``maximumAbsX``, ``minimumHeight``, ``maximumHeight``), never pointwise cuts.
``componentCuffMinimumX`` can distinguish detached cuffs from waist pockets;
``armFollowMaterials`` confines explicit glove/cuff materials to sleeve fields.
None of these options changes mesh topology or repairs open source armholes.
"""
import heapq
import importlib.util
import json
from pathlib import Path

import numpy as np
from mathutils import Vector
from mathutils.kdtree import KDTree


def _math():
    spec = importlib.util.spec_from_file_location('topological_garment_math', Path(__file__).with_name('prepare-avatar-outfits.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def _graph(points, triangles, tolerance):
    vertices = np.unique(triangles)
    _, first, inverse = np.unique(np.round(points[vertices] / tolerance).astype(np.int64),
                                  axis=0, return_index=True, return_inverse=True)
    locations = points[vertices[first]]
    mapping = np.full(len(points), -1, dtype=np.int64)
    mapping[vertices] = inverse
    edges = set()
    for triangle in mapping[triangles]:
        for a, b in zip(triangle, np.roll(triangle, -1)):
            if a != b:
                edges.add((min(int(a), int(b)), max(int(a), int(b))))
    adjacency = [[] for _ in locations]
    for a, b in edges:
        length = float(np.linalg.norm(locations[a] - locations[b]))
        adjacency[a].append((b, length)); adjacency[b].append((a, length))
    return vertices, inverse, locations, adjacency


def _distances(adjacency, seeds):
    result = np.full(len(adjacency), np.inf)
    queue = [(0., int(index)) for index in np.flatnonzero(seeds)]
    for _, index in queue:
        result[index] = 0
    heapq.heapify(queue)
    while queue:
        distance, index = heapq.heappop(queue)
        if distance != result[index]:
            continue
        for other, length in adjacency[index]:
            candidate = distance + length
            if candidate < result[other]:
                result[other] = candidate
                heapq.heappush(queue, (candidate, other))
    return result


def _connect_components(positions, adjacency, distance):
    """Add auxiliary links across close CAD panel/layer seams, never mesh edges."""
    labels = np.full(len(positions), -1, dtype=np.int64)
    count = 0
    for start in range(len(positions)):
        if labels[start] >= 0:
            continue
        labels[start] = count
        pending = [start]
        while pending:
            index = pending.pop()
            for other, _length in adjacency[index]:
                if labels[other] < 0:
                    labels[other] = count
                    pending.append(other)
        count += 1
    tree = KDTree(len(positions))
    for index, point in enumerate(positions):
        tree.insert(Vector(point), index)
    tree.balance()
    links = set()
    for index, point in enumerate(positions):
        for _location, other, separation in tree.find_n(Vector(point), 12):
            if separation > distance:
                break
            if labels[index] != labels[other]:
                links.add((min(index, other), max(index, other)))
                break
    for a, b in links:
        length = float(np.linalg.norm(positions[a] - positions[b]))
        adjacency[a].append((b, length)); adjacency[b].append((a, length))
    return {'sourceComponents': count, 'auxiliarySeamLinks': len(links)}


def _component_ownership(points, parts, config, shoulder_x, shoulder_height):
    """Recognize separate CAD sleeve/bodice components within mixed objects.

    Components are extracted per authored material slot before any cross-part
    seam links. Mixed continuous torso+sleeve surfaces remain unclassified and
    use the geodesic field; no entire object is presumed to be an arm.
    """
    core, arms, small = set(), set(), set()
    reports = []
    low = float(config.get('cuffMinimumHeight', .85))
    high = float(config.get('cuffMaximumHeight', shoulder_height - .1))
    for part, triangles in parts.items():
        vertices, inverse, locations, adjacency = _graph(points, np.asarray(triangles), config.get('weldTolerance', 1e-5))
        labels = np.full(len(locations), -1, dtype=np.int64)
        components = []
        for start in range(len(locations)):
            if labels[start] >= 0:
                continue
            label = len(components)
            labels[start] = label
            pending, nodes = [start], []
            while pending:
                i = pending.pop(); nodes.append(i)
                for j, _distance in adjacency[i]:
                    if labels[j] < 0:
                        labels[j] = label; pending.append(j)
            components.append(nodes)
        for label, nodes in enumerate(components):
            cloud = locations[nodes]
            minimum, maximum = cloud.min(0), cloud.max(0)
            sleeve_side = float(config.get('componentSleeveSideX', .10))
            side_only = minimum[0] > sleeve_side or maximum[0] < -sleeve_side
            long_sleeve = (side_only and minimum[2] > low - .05 and
                           maximum[2] > float(config.get('componentSleeveTopHeight', shoulder_height - .17)) and
                           np.ptp(cloud[:, 2]) > .25)
            across_body = minimum[0] < -.035 and maximum[0] > .035
            # Some CAD jackets author each front half as a separate component.
            # Such a panel reaches the central chest without crossing X=0. This
            # optional source-frame bound distinguishes it from lateral sleeves;
            # continuous torso+sleeve components still have an outlying tail.
            central_contact = across_body
            if 'componentCoreContactX' in config:
                central_contact |= np.min(np.abs(cloud[:, 0])) < float(config['componentCoreContactX'])
            lateral_limit = float(config.get('componentCoreTailX', shoulder_x + .085))
            low_lateral_tail = np.any((np.abs(cloud[:, 0]) > lateral_limit) &
                                      (cloud[:, 2] > low) & (cloud[:, 2] < shoulder_height - .08))
            lower_garment = maximum[2] < high and minimum[2] < low - .04
            low_body_panel = minimum[2] < low - .04 and not low_lateral_tail
            waist_pocket = maximum[2] < high and abs(cloud[:, 0].mean()) < shoulder_x + .025
            body = lower_garment or low_body_panel or waist_pocket or (central_contact and not low_lateral_tail)
            bounded_core = any(
                np.max(np.abs(cloud[:, 0])) <= float(band['maximumAbsX']) and
                minimum[2] >= float(band['minimumHeight']) and
                maximum[2] <= float(band['maximumHeight'])
                for band in config.get('componentCoreBands', []))
            authored_cuff = (
                'componentCuffMinimumX' in config and side_only and len(nodes) < 2500 and
                np.min(np.abs(cloud[:, 0])) > float(config['componentCuffMinimumX']) and
                low - .05 < minimum[2] < high and maximum[2] < high)
            ids = vertices[labels[inverse] == label].tolist()
            role = 'mixed'
            if bounded_core:
                core.update(ids); role = 'core'
            elif long_sleeve:
                arms.update(ids); role = 'arm'
            elif authored_cuff:
                small.update(ids); role = 'follow'
            elif body:
                core.update(ids); role = 'core'
            elif side_only and len(nodes) < 2500 and low - .05 < minimum[2] < high and maximum[2] < high:
                small.update(ids); role = 'follow'
            reports.append({'part': int(part), 'vertices': len(ids), 'role': role})
    return core, arms, small, reports


def _near(points, references, distance):
    if not len(references):
        return np.zeros(len(points), dtype=bool)
    tree = KDTree(len(references))
    for i, point in enumerate(references):
        tree.insert(Vector(point), i)
    tree.balance()
    return np.array([tree.find(Vector(point))[2] <= distance for point in points])


def _smoothstep(lo, hi, values):
    values = np.clip((values - lo) / (hi - lo), 0, 1)
    return values * values * (3 - 2 * values)


def refine_source_weights(points, bm, weights, posed_body, ref, recipe, source_material_indices):
    """Return normalized source-pose weights; callers must recompute rest points.

    The source material mapping is indexed by BMesh material slot, not by object
    name. Configuration is deliberately opt-in; unrecognized topologies fail
    rather than silently applying a whole-object arm classification.
    """
    config = recipe.get('topologyBinding')
    if not config:
        return weights
    if not isinstance(config, dict):
        raise ValueError('topologyBinding must provide original material IDs')
    M = _math()
    rib_materials = set(config.get('ribMaterials', []))
    arm_follow_materials = set(config.get('armFollowMaterials', []))
    follow_materials = set(config.get('followMaterials', [])) | rib_materials | arm_follow_materials
    available = source_material_indices.values() if isinstance(source_material_indices, dict) else source_material_indices
    main_materials = (set(available) - follow_materials if config['mainMaterials'] == 'all'
                      else set(config['mainMaterials']))
    if main_materials & follow_materials:
        raise ValueError('Primary and following material groups must be disjoint')
    main, rib, following, arm_following, parts = [], [], set(), set(), {}
    for face in bm.faces:
        material = source_material_indices[face.material_index]
        ids = [vertex.index for vertex in face.verts]
        if material in main_materials:
            triangles = [[ids[0], ids[i], ids[i + 1]] for i in range(1, len(ids) - 1)]
            main.extend(triangles)
            parts.setdefault(face.material_index, []).extend(triangles)
        if material in rib_materials:
            rib.extend(ids)
        if material in follow_materials:
            following.update(ids)
        if material in arm_follow_materials:
            arm_following.update(ids)
    open_cuffs = config.get('openCuffAnchors', False)
    if not main or not (rib or open_cuffs):
        raise ValueError('Topology binding requires main cloth and hem/cuff rib faces')
    main = np.asarray(main, dtype=np.int64)
    rib = np.unique(rib)
    vertices, inverse, positions, adjacency = _graph(points, main, config.get('weldTolerance', 1e-5))
    seam_report = {}
    if config.get('componentSeamDistance'):
        seam_distance = float(config['componentSeamDistance'])
        if not 0 < seam_distance <= .006:
            raise ValueError('Auxiliary panel seam distance must be at most 6 mm')
        seam_report = _connect_components(positions, adjacency, seam_distance)
    rib_points = points[rib] if len(rib) else np.empty((0, 3))
    lateral = float(config.get('cuffMinimumX', .23))
    shoulder_height = min(ref.joint[side + 'UpperArm'][2] for side in ('left', 'right'))
    shoulder_x = max(abs(ref.joint[side + 'UpperArm'][0]) for side in ('left', 'right'))
    semantic_core, semantic_arm, component_follow, component_reports = set(), set(), set(), []
    if config.get('componentOwnership'):
        semantic_core, semantic_arm, component_follow, component_reports = _component_ownership(
            points, parts, config, shoulder_x, shoulder_height)
    core_nodes = np.zeros(len(positions), dtype=bool)
    arm_nodes = np.zeros(len(positions), dtype=bool)
    np.logical_or.at(core_nodes, inverse, np.isin(vertices, list(semantic_core)))
    np.logical_or.at(arm_nodes, inverse, np.isin(vertices, list(semantic_arm)))
    core_only, arm_only = core_nodes & ~arm_nodes, arm_nodes & ~core_nodes
    minimum_height = config.get('cuffMinimumHeight')
    preliminary_core = None
    if minimum_height is not None:
        # A long skirt may touch a hand in space, but its surface path to the
        # central body or lower hem is short. A sleeve reaches those anchors
        # through its shoulder. Use that distinction before selecting cuffs.
        preliminary_seeds = np.abs(positions[:, 0]) < config.get('coreHalfWidth', .11)
        preliminary_seeds |= positions[:, 2] < float(minimum_height) - .02
        preliminary_seeds |= ((positions[:, 2] > shoulder_height - .015) &
                              (np.abs(positions[:, 0]) < shoulder_x + .055))
        preliminary_core = _distances(adjacency, preliminary_seeds)
    if open_cuffs:
        # A shirt need not author separate rib materials. Its two low, lateral
        # sleeve ends and central hem supply equivalent source-pose anchors.
        cuffs = {}
        for side, sign in (('left', -1), ('right', 1)):
            candidates = positions[:, 0] * sign > lateral
            if minimum_height is not None:
                candidates &= positions[:, 2] >= float(minimum_height)
                candidates &= positions[:, 2] <= float(config.get('cuffMaximumHeight', shoulder_height - .10))
                semantic_candidates = candidates & arm_only
                if semantic_candidates.sum() >= 20:
                    candidates = semantic_candidates
                else:
                    candidates &= preliminary_core >= float(config.get('cuffGeodesicMinimum', .20))
            sleeve = positions[candidates]
            if len(sleeve) < 20:
                raise ValueError('Cannot identify a lateral open cuff for ' + side)
            cuffs[side] = sleeve[sleeve[:, 2] <= np.quantile(sleeve[:, 2], .08) +
                                float(config.get('cuffAnchorDepth', 0))]
        central = positions[np.abs(positions[:, 0]) < .15]
        hem = central[central[:, 2] <= np.quantile(central[:, 2], .06)]
    else:
        cuffs = {side: rib_points[rib_points[:, 0] * sign > lateral]
                 for side, sign in (('left', -1), ('right', 1))}
        hem = rib_points[np.abs(rib_points[:, 0]) < lateral]
    if not len(hem) or any(not len(value) for value in cuffs.values()):
        raise ValueError('Topology anchors require a central hem and two lateral cuffs')
    anchor_distance = float(config.get('anchorDistance', .018))
    hem_seeds = _near(positions, hem, anchor_distance)
    # Open-cuff anchors already belong to this graph. Expanding their radius
    # across space would re-introduce the very skirt/hand ambiguity the surface
    # distance filter excluded. Authored rib materials still need correspondence.
    cuff_radius = 1e-7 if open_cuffs and minimum_height is not None else anchor_distance
    cuff_seeds = {side: _near(positions, cuff, cuff_radius) for side, cuff in cuffs.items()}
    cuff_distances = {side: _distances(adjacency, seeds) for side, seeds in cuff_seeds.items()}
    hem_distance = _distances(adjacency, hem_seeds)
    nearest_cuff = np.minimum(cuff_distances['left'], cuff_distances['right'])
    core_seeds = (np.abs(positions[:, 0]) < config.get('coreHalfWidth', .11))
    if minimum_height is not None:
        core_seeds |= positions[:, 2] < float(minimum_height) - .02
    # The hem supplies the actual bodice width. Below the armpits, its entire
    # vertical continuation is torso cloth; a nearby hanging sleeve must not
    # pull the side/back panels merely because the surface path is short.
    torso_width = float(config.get('lowerTorsoHalfWidth', np.max(np.abs(hem[:, 0])) + .01))
    core_seeds |= ((positions[:, 2] < shoulder_height - .12) &
                   (np.abs(positions[:, 0]) < torso_width) &
                   (hem_distance < nearest_cuff * .8))
    core_seeds |= ((positions[:, 2] > shoulder_height - .015) &
                   (np.abs(positions[:, 0]) < shoulder_x + .055))
    core_seeds |= hem_seeds
    core_seeds |= core_only
    core_seeds[arm_only] = False
    core_distance = _distances(adjacency, core_seeds)
    arm_share = ref.weights[:, M.ARM_BONES].sum(1)
    leg_share = ref.weights[:, M.LEG_BONES].sum(1)
    preserve_legs = bool(config.get('preserveLegs', False))
    core_mask = arm_share[ref.tris].max(1) < .25
    if not preserve_legs:
        core_mask &= leg_share[ref.tris].max(1) < .25
    core_faces = ref.tris[core_mask]
    core = M.transfer_weights(positions, posed_body, core_faces, ref.weights)
    core[:, M.ARM_BONES + ([] if preserve_legs else M.LEG_BONES)] = 0
    core /= core.sum(1, keepdims=True)
    smooth_core_legs = config.get('smoothCoreLegs', False)
    if not isinstance(smooth_core_legs, bool):
        raise ValueError('smoothCoreLegs must be a boolean')
    core_leg_report = {'applied': False}
    if smooth_core_legs:
        if not preserve_legs:
            raise ValueError('smoothCoreLegs requires preserveLegs')
        # Core anchors are restored after each later arm-field smoothing pass.
        # Smooth their lower-body reference field first, so a nearest-triangle
        # hip/thigh switch cannot remain frozen across a one-millimetre seam.
        hip_height = min(float(ref.joint[side + 'UpperLeg'][2]) for side in ('left', 'right'))
        high = hip_height + .16
        lower = core_only & (positions[:, 2] < high)
        core_edges = np.asarray([(i, j) for i, neighbors in enumerate(adjacency) if lower[i]
                                 for j, _ in neighbors if core_only[j]], dtype=np.int64).reshape(-1, 2)
        before_core = core.copy()
        if len(core_edges):
            counts = np.bincount(core_edges[:, 0], minlength=len(core))
            strength = _smoothstep(0., .04, high - positions[:, 2])
            active = lower & (counts > 0)
            for _iteration in range(32):
                averaged = np.zeros_like(core)
                np.add.at(averaged, core_edges[:, 0], core[core_edges[:, 1]])
                averaged /= np.maximum(counts[:, None], 1)
                blend = .5 * strength[active, None]
                core[active] = core[active] * (1 - blend) + averaged[active] * blend
            core[active] /= core[active].sum(1, keepdims=True)
        delta = np.abs(core - before_core)
        core_leg_report = {'applied': True, 'iterations': 32, 'maximumHeight': high,
            'eligibleNodes': int(lower.sum()), 'changedNodes': int((delta.max(1) > 1e-7).sum()),
            'maximumWeightChange': float(delta.max()),
            'nonLowerCoreWeightsUnchanged': bool(np.array_equal(core[~lower], before_core[~lower])),
            'sourcePointsAndGraphUnchanged': True}
    field = core.copy()
    fixed_arm = np.zeros_like(core)
    report = {'graphVertices': len(positions), 'sourceVertices': len(vertices),
              'coreAnchors': int(core_seeds.sum()), 'preserveLegs': preserve_legs,
              'smoothCoreLegs': core_leg_report,
              **seam_report, 'componentOwnership': component_reports, 'arms': {}}
    for side, sign in (('left', -1), ('right', 1)):
        seeds = cuff_seeds[side]
        if not np.any(seeds):
            raise ValueError('No primary cloth reaches the ' + side + ' cuff anchor')
        distance = cuff_distances[side]
        reachable = np.isfinite(distance)
        both = reachable & np.isfinite(core_distance)
        ratio = np.zeros(len(positions))
        ratio[both] = core_distance[both] / np.maximum(core_distance[both] + distance[both], 1e-12)
        ratio[reachable & ~np.isfinite(core_distance)] = 1
        blend = _smoothstep(*config.get('armBlend', [.08, .28]), ratio)
        blend[positions[:, 0] * sign <= 0] = 0
        blend[core_only] = 0
        blend[arm_only & (positions[:, 0] * sign > 0)] = 1
        # Anatomically constrained nearest triangles retain elbow bending while
        # geodesic ownership prevents a hanging cuff from choosing the hip.
        bones = [M.B[side + name] for name in ('Shoulder', 'UpperArm', 'LowerArm', 'Hand')]
        share = ref.weights[:, bones[1:]].sum(1)
        arm_faces = ref.tris[share[ref.tris].max(1) > .25]
        arm = M.transfer_weights(positions, posed_body, arm_faces, ref.weights)
        constrained = np.zeros_like(arm)
        constrained[:, bones] = arm[:, bones]
        constrained /= np.maximum(constrained.sum(1, keepdims=True), 1e-12)
        fixed_arm[positions[:, 0] * sign > 0] = constrained[positions[:, 0] * sign > 0]
        field = field * (1 - blend[:, None]) + constrained * blend[:, None]
        report['arms'][side] = {'cuffAnchors': int(seeds.sum()), 'influenced': int((blend > .01).sum())}
    if np.any(~np.isfinite(core_distance) & (field.sum(1) < .5)):
        raise ValueError('Unanchored primary cloth component')
    # Smooth the complete field on source edges, including ownership transitions.
    # Vectorized neighbor accumulation avoids density-dependent nearest-region flips.
    edges = np.array([(i, j) for i, neighbors in enumerate(adjacency) for j, _ in neighbors], dtype=np.int64)
    counts = np.bincount(edges[:, 0], minlength=len(field))
    for _ in range(int(config.get('smoothIterations', 12))):
        averaged = np.zeros_like(field)
        np.add.at(averaged, edges[:, 0], field[edges[:, 1]])
        averaged /= np.maximum(counts[:, None], 1)
        field = np.where((counts > 0)[:, None], .5 * field + .5 * averaged, field)
        field[core_only] = core[core_only]
        for side, sign in (('left', -1), ('right', 1)):
            owned = arm_only & (positions[:, 0] * sign > 0)
            columns = [M.B[side + name] for name in ('Shoulder', 'UpperArm', 'LowerArm', 'Hand')]
            constrained = np.zeros_like(field[owned])
            constrained[:, columns] = field[owned][:, columns]
            totals = constrained.sum(1, keepdims=True)
            field[owned] = np.where(totals > 1e-9, constrained / np.maximum(totals, 1e-9), fixed_arm[owned])
    result = weights.copy()
    result[vertices] = field[inverse]
    confined_followers = (component_follow | arm_following) - semantic_core
    if confined_followers:
        selected = np.array(sorted(confined_followers), dtype=np.int64)
        # These are specifically lateral cuff ornaments. Sampling bodice faces
        # per vertex can put one end on the hip and stretch a tiny ring a metre.
        source_faces = main[np.all(np.isin(main, list(semantic_arm)), axis=1)]
        report['cuffFollowerField'] = 'component'
        if not len(source_faces):
            # A single fused shirt can have no separate CAD sleeve component.
            # Its geodesic cuff field still supplies confined sleeve triangles;
            # never fall back to unconstrained hip/bodice sampling for cuffs.
            arm_columns = M.ARM_BONES + [M.B['leftShoulder'], M.B['rightShoulder']]
            share = result[:, arm_columns].sum(1)
            source_faces = main[np.all(share[main] > .7, axis=1)]
            report['cuffFollowerField'] = 'geodesic'
        if not len(source_faces):
            raise ValueError('No classified source cloth for detached component binding')
        result[selected] = M.transfer_weights(points[selected], points, source_faces, result)
    followers = np.array(sorted(following - set(vertices.tolist()) - confined_followers), dtype=np.int64)
    if len(followers):
        result[followers] = M.transfer_weights(points[followers], points, main, result)
    result = M.limit_influences(result)
    if not np.all(np.isfinite(result)) or not np.allclose(result.sum(1), 1, atol=1e-6):
        raise ValueError('Topology binding produced invalid skin weights')
    report['followingVertices'] = len(followers)
    report['armFollowingVertices'] = len(arm_following)
    print('SOURCE_TOPOLOGY_BINDING', json.dumps(report), flush=True)
    return result


def refine_armhole_seam_weights(obj, weights, ref, recipe, M, *, source_points):
    """Opt-in source armhole weight diffusion, before inverse skinning.

    ``armholeSeams`` locates contacts in registered source coordinates, not in
    already separated posed panels. Existing bone weights diffuse across these
    contacts and fade along source edges into the original field. Explicit torso,
    bottom, footwear and every vertex outside this small band remain untouched.
    This helper never changes positions, faces, corner attributes or materials.
    """
    config = recipe.get('armholeSeams')
    if not config:
        return weights, {'applied': False}
    if config is True:
        config = {}
    if not isinstance(config, dict):
        raise ValueError('armholeSeams requires a bounded configuration')
    def bounded(name, default, low, high):
        value = config.get(name, default)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not np.isfinite(value) or not low <= value <= high:
            raise ValueError('Invalid armholeSeams ' + name)
        return float(value)
    contact_distance = bounded('contactDistance', .004, .0001, .01)
    band = bounded('bandDistance', .10, .02, .18)
    radius = bounded('jointRadius', .18, .12, .25)
    difference = bounded('minimumWeightDifference', .25, .1, .8)
    gradient_seams = config.get('gradientSeams', True)
    if type(gradient_seams) is not bool:
        raise ValueError('armholeSeams gradientSeams must be boolean')
    pair_config = config.get('partPairs')
    allowed_pairs = None if pair_config is None else {tuple(sorted(map(int, pair))) for pair in pair_config}
    if allowed_pairs is not None and any(len(pair) != 2 for pair in allowed_pairs):
        raise ValueError('Every armhole part pair needs two source part indices')
    points = np.array([vertex.co[:] for vertex in obj.data.vertices])
    source_points = np.asarray(source_points)
    if source_points.shape != points.shape or weights.shape != (len(points), len(M.BONES)):
        raise ValueError('Armhole source positions and canonical weights must match the source mesh')
    anatomy = obj.data.attributes.get('anatomy')
    part_layer = obj.data.attributes.get('part')
    if part_layer is None or part_layer.domain != 'FACE':
        raise ValueError('Armhole binding requires original source part ownership')
    obj.data.calc_loop_triangles()
    eligible, protected, triangles, parts = set(), set(), [], []
    for face in obj.data.polygons:
        name = obj.data.materials[face.material_index].name
        torso = anatomy is not None and anatomy.domain == 'FACE' and anatomy.data[face.index].value == 2
        if name.startswith(('OriginalTop_', 'OriginalOuter_', 'OriginalAccent_')) and not torso:
            eligible.update(face.vertices)
        else:
            protected.update(face.vertices)
    eligible.difference_update(protected)
    for face in obj.data.loop_triangles:
        if all(index in eligible for index in face.vertices):
            triangles.append(face.vertices[:])
            parts.append(part_layer.data[face.polygon_index].value)
    if not triangles:
        raise ValueError('Armhole binding has no eligible original cloth')
    triangles = np.asarray(triangles, dtype=np.int64)
    vertices, inverse, positions, adjacency = _graph(source_points, triangles, 1e-5)
    mapping = np.full(len(points), -1, dtype=np.int64)
    mapping[vertices] = inverse
    count = np.bincount(inverse, minlength=len(positions))
    rest = np.zeros_like(positions)
    old = np.zeros((len(positions), len(M.BONES)))
    np.add.at(rest, inverse, points[vertices]); rest /= count[:, None]
    np.add.at(old, inverse, weights[vertices]); old /= count[:, None]
    part_sets = [set() for _ in positions]
    for triangle, part in zip(mapping[triangles], parts):
        for index in triangle:
            part_sets[index].add(int(part))
    near = np.zeros(len(positions), dtype=bool)
    for side in ('left', 'right'):
        centre = np.asarray(ref.joint[side + 'UpperArm'])
        near |= (np.linalg.norm(positions - centre, axis=1) < radius)
    shoulder = max(ref.joint['leftUpperArm'][2], ref.joint['rightUpperArm'][2])
    near &= ((positions[:, 2] > shoulder - .17) &
             (positions[:, 2] < shoulder + .10) & (np.abs(positions[:, 0]) > .08))
    selected = np.flatnonzero(near)
    if not len(selected):
        return weights, {'applied': False, 'reason': 'no-source-shoulder-region'}
    tree = KDTree(len(selected))
    for index in selected:
        tree.insert(Vector(positions[index]), int(index))
    tree.balance()
    arm = old[:, M.ARM_BONES].sum(axis=1)
    contacts = set()
    for index in selected:
        for _point, other, separation in tree.find_n(Vector(positions[index]), 32):
            if separation > contact_distance:
                break
            if other <= index or part_sets[index] & part_sets[other]:
                continue
            if allowed_pairs is not None and not any(tuple(sorted((a, b))) in allowed_pairs
                    for a in part_sets[index] for b in part_sets[other]):
                continue
            if abs(arm[index] - arm[other]) < difference:
                continue
            contacts.add((int(index), int(other)))
    gradient_edges = set()
    if gradient_seams:
        for index in selected:
            for other, _distance in adjacency[index]:
                if other > index and near[other] and abs(arm[index] - arm[other]) > difference:
                    gradient_edges.add((int(index), int(other)))
    anchors = sorted(contacts | gradient_edges)
    if not anchors:
        return weights, {'applied': False, 'reason': 'no-source-armhole-contact-or-transition'}
    seeds = np.zeros(len(positions), dtype=bool)
    for a, b in anchors:
        seeds[a] = seeds[b] = True
    for a, b in contacts:
        distance = float(np.linalg.norm(positions[a] - positions[b]))
        adjacency[a].append((b, distance)); adjacency[b].append((a, distance))
    distance = _distances(adjacency, seeds)
    active = distance < band
    blend = np.zeros(len(positions))
    blend[active] = 1. - _smoothstep(0., band, distance[active])
    field = old.copy()
    # Average the existing bone palette across authored contacts instead of
    # re-projecting each rim onto a possibly different body triangle/region.
    # The same source graph supplies a smooth finite band on both panels.
    rows, columns, conductance = [], [], []
    for index, neighbors in enumerate(adjacency):
        if not active[index]:
            continue
        for other, length in neighbors:
            strength = 1. / max(length, .001)
            if (min(index, other), max(index, other)) in contacts:
                strength *= 10.
            rows.append(index); columns.append(other); conductance.append(strength)
    rows, columns = np.asarray(rows), np.asarray(columns)
    conductance = np.asarray(conductance)
    totals = np.bincount(rows, weights=conductance, minlength=len(positions))
    for _iteration in range(128):
        accumulated = np.zeros_like(field)
        np.add.at(accumulated, rows, field[columns] * conductance[:, None])
        averaged = accumulated / np.maximum(totals[:, None], 1e-12)
        desired = old[active] * (1 - blend[active, None]) + averaged[active] * blend[active, None]
        field[active] = .5 * field[active] + .5 * desired
    changed_vertices = vertices[active[inverse]]
    result = weights.copy()
    result[changed_vertices] = M.limit_influences(field[inverse[active[inverse]]])
    if not np.isfinite(result).all() or not np.allclose(result.sum(axis=1), 1., atol=1e-6):
        raise ValueError('Armhole seam weights must remain finite and normalized')
    report = {'applied': True, 'sourceContactPairs': len(contacts), 'gradientEdges': len(gradient_edges),
              'anchorNodes': int(seeds.sum()), 'changedVertices': int(len(changed_vertices)),
              'bandDistance': band, 'contactDistance': contact_distance,
              'maximumWeightChange': float(np.max(np.abs(result - weights))),
              'protectedVertices': len(protected), 'sourceGeometryUnchanged': True,
              'iterations': 128,
              'maximumSourceContactRestSeparation': max((float(np.linalg.norm(rest[a] - rest[b])) for a, b in contacts), default=0.),
              'meanContactWeightDifferenceBefore': float(np.mean([np.abs(old[a] - old[b]).sum() for a, b in contacts])) if contacts else 0.,
              'meanContactWeightDifferenceAfter': float(np.mean([np.abs(field[a] - field[b]).sum() for a, b in contacts])) if contacts else 0.}
    print('SOURCE_ARMHOLE_SEAMS', json.dumps(report), flush=True)
    return result, report
