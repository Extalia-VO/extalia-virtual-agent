"""Optional seated corrective for flared source skirts; Basis stays untouched.

The radial depth of a standing flare must not rotate upright with the thigh.
This helper creates a pre-skinning morph, driven only by the seated pose blend.
All original faces, corner attributes, material slots and skin weights survive.
"""
import numpy as np
import bpy
import bmesh
import math
import re
from mathutils import Matrix, Vector, Quaternion
from mathutils.bvhtree import BVHTree


def _smoothstep(values):
    values = np.clip(values, 0., 1.)
    return values * values * (3. - 2. * values)


def seated_matrices(ref, pose_profile=None, _capture_basis=None):
    """Seated matrices, restoring every original pose basis.

    A runtime profile supplies scale, seat_height, seat_front and sole_heights
    (leftFoot/rightFoot). It mirrors seatedLegPose, supportedThigh,
    floorSeatedKnee and sourceLimbBasis cancellation in SourceHumanoid.
    Omission retains the original fixed-angle QA pose.
    """
    saved = {bone.name: bone.matrix_basis.copy() for bone in ref.rig.pose.bones}
    try:
        for bone in ref.rig.pose.bones:
            bone.matrix_basis = Matrix.Identity(4)
            angle = -1.5 if bone.name.endswith('UpperLeg') else 1.5 if bone.name.endswith('LowerLeg') else 0.
            if pose_profile and bone.name in ('spine', 'chest'):
                angle = .05 if bone.name == 'spine' else .06
            if angle:
                rest = bone.bone.matrix_local.to_3x3()
                bone.matrix_basis = (rest.inverted() @ Matrix.Rotation(angle, 3, 'X') @ rest).to_4x4()
        if pose_profile:
            scale = float(pose_profile['scale'])
            seat = float(pose_profile['seat_height'])
            front = float(pose_profile['seat_front'])
            if scale <= 0 or front <= 0:
                raise ValueError('Runtime seated scale and seat front must be positive')
            down = Vector((0., 0., -1.))
            for side in ('left', 'right'):
                hip, knee, ankle = [ref.joint[side + name] for name in ('UpperLeg', 'LowerLeg', 'Foot')]
                upper, lower = Vector(knee - hip), Vector(ankle - knee)
                l1, l2 = upper.length * scale, lower.length * scale
                hip_above = (.11 + hip[2] - ref.joint['hips'][2]) * scale
                hip_y = seat + hip_above
                floor_ankle = (ankle[2] - float(pose_profile['sole_heights'][side + 'Foot'])) * scale
                room = max(0., hip_above - .08 * scale + .008)
                max_drop = l1 * math.sin(math.atan(room / max(.04, front)))
                drop = max(-l1 * .2, min(max_drop, hip_y - l2 - floor_ankle))
                pitch = min(-math.acos(np.clip(drop / l1, -1., 1.)),
                            -math.acos(np.clip(max_drop / l1, -1., 1.)))
                bend = -pitch
                knee_y = hip_y - math.cos(pitch) * l1
                if knee_y - math.cos(pitch + bend) * l2 < floor_ankle:
                    bend = -math.acos(np.clip((knee_y - floor_ankle) / l2, -1., 1.)) - pitch
                cu = down.rotation_difference(upper.normalized())
                cl = down.rotation_difference(lower.normalized())
                rotations = (Quaternion((1, 0, 0), pitch) @ cu.inverted(),
                             cu @ Quaternion((1, 0, 0), bend) @ cl.inverted(),
                             cl @ Quaternion((1, 0, 0), -(pitch + bend)))
                for part, rotation in zip(('UpperLeg', 'LowerLeg', 'Foot'), rotations):
                    bone = ref.rig.pose.bones[side + part]
                    rest = bone.bone.matrix_local.to_3x3().to_quaternion()
                    bone.matrix_basis = (rest.inverted() @ rotation @ rest).to_matrix().to_4x4()
        bpy.context.view_layer.update()
        if _capture_basis is not None:
            _capture_basis.update({bone.name: bone.matrix_basis.copy() for bone in ref.rig.pose.bones})
        return ref.skinning()
    finally:
        for bone in ref.rig.pose.bones:
            bone.matrix_basis = saved[bone.name]
        bpy.context.view_layer.update()


def seated_drape_points(points, weights, selected, ref, M, *, waist,
                        radial_depth=.105, radial_softness=.02,
                        transition_depth=.18, lateral_start=.16,
                        lateral_radius=.065, clearance=.006, triangles=None,
                        seam_height=None, collider_knee_margin=.10,
                        pose_profile=None, surface_contact_iterations=0,
                        surface_vertex_contacts=False):
    """Return corrective rest coordinates and a small diagnostic receipt.

    ``selected`` is an explicit boolean mask of skirt-owned original vertices.
    Coordinates and the reference rig must use the same armature-local frame.
    This does not infer ownership from height, material names, or proximity.
    """
    points = np.asarray(points, dtype=float)
    selected = np.asarray(selected, dtype=bool)
    if selected.shape != (len(points),) or not np.any(selected):
        raise ValueError('A nonempty explicit skirt vertex mask is required')
    if min(radial_depth, radial_softness, transition_depth) <= 0:
        raise ValueError('Seated drape dimensions must be positive')
    result = points.copy()
    seam_height = (max(float(waist), float(np.quantile(points[selected, 2], .995)))
                   if seam_height is None else float(seam_height))
    axis_y = float(np.mean([ref.joint[side + 'UpperLeg'][1] for side in ('left', 'right')]))
    offset = points[:, 1] - axis_y
    excess = np.maximum(np.abs(offset) - radial_depth, 0.)
    compact = np.minimum(np.abs(offset), radial_depth) + radial_softness * (-np.expm1(-excess / radial_softness))
    influence = _smoothstep((seam_height - .02 - points[:, 2]) / transition_depth)
    influence *= selected
    result[:, 1] += influence * (np.sign(offset) * compact - offset)
    matrices = seated_matrices(ref, pose_profile)
    seated = M.skin_points(result, weights, matrices)
    lateral = np.maximum(np.abs(seated[:, 0]) - lateral_start, 0.)
    angle = np.minimum(lateral / lateral_radius, np.pi / 2.)
    folded_x = lateral_start + lateral_radius * np.sin(angle)
    drop = lateral_radius * (1. - np.cos(angle)) + np.maximum(lateral - np.pi * lateral_radius / 2., 0.)
    seated[:, 0] += influence * np.sign(seated[:, 0]) * np.where(lateral > 0., folded_x - np.abs(seated[:, 0]), 0.)
    seated[:, 2] -= influence * drop
    # A radial envelope of the actual seated hip/thigh surface protects the lap.
    # Restrict the collider anatomically: a ray through the lap must never see
    # the chest, head, hands, feet, or the far shin. Its direction changes from
    # forward at the waist to upward on the lap, avoiding a vertical projection
    # that would drive upper-thigh cloth inside the abdomen.
    knee = float(np.mean([ref.joint[side + 'LowerLeg'][2] for side in ('left', 'right')]))
    body_centres = ref.verts[ref.tris].mean(axis=1)
    body_mask = ((body_centres[:, 2] > knee + collider_knee_margin) &
                 (body_centres[:, 2] < seam_height + .07))
    body_mask &= ref.weights[:, M.ARM_BONES].sum(axis=1)[ref.tris].max(axis=1) < .15
    body_faces = ref.tris[body_mask]
    body_heights = body_centres[body_mask, 2]
    body = M.skin_points(ref.verts, ref.weights, matrices)
    collider = BVHTree.FromPolygons([Vector(point) for point in body], body_faces.tolist(), all_triangles=True)
    hip_x = float(np.mean([abs(ref.joint[side + 'UpperLeg'][0]) for side in ('left', 'right')]))
    axes = points.copy(); axes[:, 1] = axis_y
    axes = M.skin_points(axes, weights, matrices)
    blended = np.einsum('nb,bij->nij', weights, matrices)
    normals = blended[:, :3, 1] * np.sign(offset)[:, None]
    normals /= np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-9)
    adjusted = 0
    corrections = np.zeros_like(points)
    for index in np.flatnonzero(selected & (influence > .01)):
        q = seated[index]
        normal = Vector(normals[index])
        axis = Vector(axes[index]); axis.x = q[0]
        # Bridge the space between the thighs with the adjacent lap surface.
        if normal.z > .5:
            axis.x = np.copysign(max(abs(q[0]), hip_x), q[0])
        start = axis + normal * .45
        hit = None
        for _layer in range(12):
            candidate, _normal, face, _distance = collider.ray_cast(start, -normal, .8)
            if candidate is None:
                break
            # An outward waist ray can cross the bent knee first. Only the
            # corresponding anatomical height may define this cloth station.
            if abs(body_heights[face] - points[index, 2]) < .13:
                hit = candidate
                break
            start = candidate - normal * .0005
        if hit is not None:
            target = (hit - axis).dot(normal) + clearance
            correction = max(target - (Vector(q) - axis).dot(normal), 0.)
            corrections[index] = np.array(normal) * correction
            adjusted += abs(correction) > 1e-9
    if triangles is not None:
        # Smooth only the corrective displacement on an auxiliary welded graph.
        # Closest body facets can otherwise introduce individual pointed fins.
        # Neither source vertices nor faces are welded or subdivided.
        triangles = np.asarray(triangles, dtype=np.int64)
        triangles = triangles[np.all(selected[triangles], axis=1)]
        _, inverse = np.unique(np.round(points / 1e-5).astype(np.int64), axis=0, return_inverse=True)
        edges = np.concatenate([inverse[triangles[:, [0, 1]]], inverse[triangles[:, [1, 2]]],
                                inverse[triangles[:, [2, 0]]]], axis=0)
        edges = np.unique(np.sort(edges, axis=1), axis=0)
        edges = np.concatenate([edges, edges[:, ::-1]], axis=0)
        field = np.zeros((int(inverse.max()) + 1, 3))
        np.add.at(field, inverse, corrections)
        field /= np.bincount(inverse)[:, None]
        counts = np.bincount(edges[:, 0], minlength=len(field))
        for _iteration in range(3):
            averaged = np.zeros_like(field)
            np.add.at(averaged, edges[:, 0], field[edges[:, 1]])
            averaged /= np.maximum(counts[:, None], 1)
            field = np.where((counts > 0)[:, None], .4 * field + .6 * averaged, field)
        corrections = field[inverse]
    seated += corrections * _smoothstep(influence * 10.)[:, None]
    # Resolve residual local contacts after the smooth drape. This bounded
    # contact pass acts only on the selected moving skirt and the anatomical
    # hip/thigh collider, never on arms or distant source components.
    contact_vertices = selected & (influence > .01)
    for _iteration in range(4):
        moved = 0
        for index in np.flatnonzero(contact_vertices):
            point = Vector(seated[index])
            nearest, normal, _face, distance = collider.find_nearest(point)
            if nearest is None or distance > .06:
                continue
            signed = (point - nearest).dot(normal)
            if signed < clearance:
                seated[index] += np.array(normal) * (clearance - signed)
                moved += 1
        if not moved:
            break
    if surface_contact_iterations:
        if triangles is None:
            raise ValueError('Surface contact correction requires source triangles')
        samples = ((1 / 3, 1 / 3, 1 / 3), (.5, .5, 0.), (0., .5, .5), (.5, 0., .5))
        if surface_vertex_contacts:
            samples += ((1., 0., 0.), (0., 1., 0.), (0., 0., 1.))
        for _iteration in range(int(surface_contact_iterations)):
            displacement = np.zeros_like(seated)
            count = np.zeros(len(seated))
            for triangle in triangles:
                if not contact_vertices[triangle].all():
                    continue
                for barycentric in samples:
                    bary = np.asarray(barycentric)
                    point = Vector(bary @ seated[triangle])
                    nearest, normal, _face, distance = collider.find_nearest(point)
                    if nearest is None or distance > .06:
                        continue
                    signed = (point - nearest).dot(normal)
                    if signed >= clearance:
                        continue
                    shift = np.array(normal) * (clearance - signed)
                    for vertex, factor in zip(triangle, bary / (bary @ bary)):
                        if factor:
                            displacement[vertex] += shift * factor
                            count[vertex] += 1
            moved = count > 0
            if not moved.any():
                break
            seated[moved] += displacement[moved] / count[moved, None]
    result = M.unskin_points(seated, weights, matrices)
    result[~selected] = points[~selected]
    delta = np.linalg.norm(result - points, axis=1)
    return result, {'selectedVertices': int(selected.sum()),
                    'changedVertices': int((delta > 1e-9).sum()),
                    'maximumRestCorrection': float(delta.max()),
                    'axisY': axis_y, 'seamHeight': seam_height, 'radialDepth': radial_depth,
                    'radialSoftness': radial_softness, 'transitionDepth': transition_depth,
                    'lateralStart': lateral_start, 'lateralRadius': lateral_radius,
                    'lapEnvelopeVertices': int(adjusted), 'clearance': clearance,
                    'poseProfile': pose_profile, 'colliderKneeMargin': collider_knee_margin,
                    'surfaceContactIterations': int(surface_contact_iterations),
                    'surfaceVertexContacts': bool(surface_vertex_contacts)}


def simulated_seated_drape(obj, ref, weights, selected, M, *, waist,
                           pose_profile, seam_height=None, frames=120,
                           sit_frame=60, quality=8, collision_quality=5,
                           pin_depth=.05, pin_fade=.035, cloth_distance=.006,
                           body_distance=.004, proxy_vertices=6000,
                           proxy_weld_distance=1e-5, follow_unanchored=False,
                           rigid_detail_span=0., weld_consistent_transfer=False,
                           floor_collider=False):
    """Bake an offline cloth proxy into original-vertex seated coordinates.

    Only an explicitly owned skirt is simulated. The hip/thigh collider omits
    arms, which otherwise snag the hem while the seated arm pose interpolates.
    A fresh object/cache is created for every call and removed afterward. The
    source mesh, its corner attributes, weights, and standing shape are never
    edited. A reduced proxy transfers displacement through its rest triangles.
    """
    if not pose_profile:
        raise ValueError('Offline seated cloth requires an exact runtime pose_profile')
    if not 1 < sit_frame < frames <= 300 or not 1 <= quality <= 30:
        raise ValueError('Offline cloth requires 1 < sit_frame < frames <= 300 and quality 1..30')
    if min(pin_depth, pin_fade, cloth_distance, body_distance) <= 0:
        raise ValueError('Cloth pin and collision distances must be positive')
    points = np.array([vertex.co[:] for vertex in obj.data.vertices])
    selected = np.asarray(selected, dtype=bool)
    if selected.shape != (len(points),) or not selected.any():
        raise ValueError('A nonempty explicit skirt vertex mask is required')
    seam = (max(float(waist), float(np.quantile(points[selected, 2], .995)))
            if seam_height is None else float(seam_height))
    native_fixed = np.zeros(len(points), dtype=bool)
    rigid_mask = np.zeros(len(points), dtype=bool)
    rigid_groups = []
    if follow_unanchored or rigid_detail_span > 0:
        # A selected fragment cut out of a longer top is still attached to that
        # unselected top. Keep its native binding instead of letting it fall or
        # transferring it onto a neighboring skirt. Detached sewn decorations,
        # by contrast, follow the anchored cloth proxy below.
        adjacency = [[] for _ in points]
        touches_unselected = np.zeros(len(points), dtype=bool)
        for edge in obj.data.edges:
            a, b = edge.vertices
            if selected[a] and selected[b]:
                adjacency[a].append(b)
                adjacency[b].append(a)
            elif selected[a]:
                touches_unselected[a] = True
            elif selected[b]:
                touches_unselected[b] = True
        # Rejoin exact UV/corner duplicates in the auxiliary ownership graph.
        # This never welds the original mesh or its distinct corner attributes.
        _, position_groups = np.unique(np.round(points / 1e-5).astype(np.int64),
                                       axis=0, return_inverse=True)
        representatives = {}
        for index, group in enumerate(position_groups):
            if group not in representatives:
                representatives[group] = index
                continue
            other = representatives[group]
            if selected[index] and selected[other]:
                adjacency[index].append(other)
                adjacency[other].append(index)
            elif selected[index]:
                touches_unselected[index] = True
            elif selected[other]:
                touches_unselected[other] = True
        visited = np.zeros(len(points), dtype=bool)
        for index in np.flatnonzero(selected):
            if visited[index]:
                continue
            stack, component = [int(index)], []
            visited[index] = True
            while stack:
                current = stack.pop()
                component.append(current)
                for other in adjacency[current]:
                    if not visited[other]:
                        visited[other] = True
                        stack.append(other)
            small_detail = (rigid_detail_span > 0 and len(component) >= 3 and
                            np.ptp(points[component], axis=0).max() <= rigid_detail_span)
            if (touches_unselected[component].any() and
                    (small_detail or (points[component, 2] > seam - pin_depth).sum() < 3)):
                native_fixed[component] = True
            elif small_detail:
                rigid_groups.append(np.array(component, dtype=np.int64))
                rigid_mask[component] = True
    simulated = selected & ~native_fixed & ~rigid_mask
    scene = bpy.context.scene
    saved_frame = scene.frame_current
    saved_subframe = scene.frame_subframe
    saved_gravity = scene.gravity.copy()
    saved_fps = scene.render.fps
    saved_bases = {bone.name: (bone.matrix_basis.copy(), bone.rotation_mode)
                   for bone in ref.rig.pose.bones}
    saved_location = ref.rig.location.copy()
    had_animation = ref.rig.animation_data is not None
    saved_action = ref.rig.animation_data.action if had_animation else None
    end_bases = {}
    matrices = seated_matrices(ref, pose_profile, end_bases)
    proxy = collider = floor = action = floor_action = None
    proxy_mesh = collider_mesh = floor_mesh = None
    try:
        ref.rig.animation_data_create()
        ref.rig.animation_data.action = None
        ref.rig.location = (0, 0, 0)
        scene.gravity = (0, 0, -9.81)
        scene.render.fps = 24
        scene.frame_set(1)
        for bone in ref.rig.pose.bones:
            bone.matrix_basis = Matrix.Identity(4)
        bpy.context.view_layer.update()
        proxy_mesh = bpy.data.meshes.new('Temporary seated cloth geometry')
        proxy_mesh.from_pydata(points.tolist(), [], [tuple(face.vertices) for face in obj.data.polygons])
        proxy_mesh.update()
        proxy = bpy.data.objects.new('Temporary seated cloth proxy', proxy_mesh)
        bpy.context.scene.collection.objects.link(proxy)
        groups = [proxy.vertex_groups.new(name=name) for name in M.BONES]
        for index, row in enumerate(weights):
            for column in np.flatnonzero(row > 0):
                groups[column].add([index], float(row[column]), 'REPLACE')
        proxy.hide_viewport = proxy.hide_render = False
        proxy.parent = ref.rig
        proxy.matrix_parent_inverse = Matrix.Identity(4)
        proxy.matrix_basis = Matrix.Identity(4)
        proxy.modifiers.clear()
        welded_coordinates = points.copy()
        bm = bmesh.new()
        try:
            bm.from_mesh(proxy.data)
            bm.verts.ensure_lookup_table()
            source_index_layer = bm.verts.layers.int.new('Temporary source vertex index')
            for vertex in bm.verts:
                vertex[source_index_layer] = vertex.index
            bmesh.ops.delete(bm, geom=[face for face in bm.faces
                            if not all(simulated[v.index] for v in face.verts)], context='FACES')
            bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
            if weld_consistent_transfer:
                targets = bmesh.ops.find_doubles(bm, verts=list(bm.verts),
                                                  dist=float(proxy_weld_distance))['targetmap']
                for vertex in bm.verts:
                    representative = vertex
                    while representative in targets:
                        representative = targets[representative]
                    welded_coordinates[vertex[source_index_layer]] = np.array(representative.co)
                if targets:
                    bmesh.ops.weld_verts(bm, targetmap=targets)
            else:
                bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=float(proxy_weld_distance))
            # CAD front/back seams and thin shells may be separate in source.
            # This optional coarse sewing is restricted to the disposable proxy.
            # Original panels, thickness, and corner attributes are preserved by
            # the residual transfer to each original vertex below.
            seen_faces = set()
            duplicate_faces = []
            for face in bm.faces:
                key = frozenset(face.verts)
                if key in seen_faces:
                    duplicate_faces.append(face)
                seen_faces.add(key)
            if duplicate_faces:
                bmesh.ops.delete(bm, geom=duplicate_faces, context='FACES_ONLY')
            followed_vertices = 0
            if follow_unanchored:
                visited = set()
                detached = []
                for vertex in bm.verts:
                    if vertex in visited:
                        continue
                    visited.add(vertex)
                    stack, component = [vertex], []
                    while stack:
                        current = stack.pop()
                        component.append(current)
                        for edge in current.link_edges:
                            other = edge.other_vert(current)
                            if other not in visited:
                                visited.add(other)
                                stack.append(other)
                    if sum(v.co.z > seam - pin_depth for v in component) < 3:
                        detached.extend(component)
                followed_vertices = len(detached)
                if detached:
                    bmesh.ops.delete(bm, geom=detached, context='VERTS')
            bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
            bm.to_mesh(proxy.data)
        finally:
            bm.free()
        if len(proxy.data.vertices) > int(proxy_vertices):
            decimate = proxy.modifiers.new('Temporary cloth proxy budget', 'DECIMATE')
            decimate.ratio = int(proxy_vertices) / len(proxy.data.vertices)
            decimate.use_collapse_triangulate = True
            old_mesh = proxy.data
            evaluated = proxy.evaluated_get(bpy.context.evaluated_depsgraph_get())
            proxy.data = bpy.data.meshes.new_from_object(evaluated, preserve_all_data_layers=True,
                                                       depsgraph=bpy.context.evaluated_depsgraph_get())
            proxy.modifiers.clear()
            bpy.data.meshes.remove(old_mesh)
            proxy_mesh = proxy.data
        if not proxy.data.polygons:
            raise ValueError('Selected skirt has no complete source triangles')
        proxy.data.calc_loop_triangles()
        rest_proxy = np.array([v.co[:] for v in proxy.data.vertices])
        proxy_triangles = np.array([f.vertices[:] for f in proxy.data.loop_triangles], dtype=np.int64)
        tree = BVHTree.FromPolygons([Vector(v) for v in rest_proxy], proxy_triangles.tolist(),
                                   all_triangles=True)
        correspondence = []
        maximum_proxy_distance = 0.
        for index in np.flatnonzero(simulated):
            near, normal, face, distance = tree.find_nearest(Vector(welded_coordinates[index] if weld_consistent_transfer else points[index]))
            triangle = proxy_triangles[face]
            bary = M.barycentric(near, *(Vector(rest_proxy[i]) for i in triangle))
            residual = points[index] - np.array(near)
            correspondence.append((int(index), triangle, bary, residual))
            maximum_proxy_distance = max(maximum_proxy_distance, float(distance))
        pin = proxy.vertex_groups.new(name='Temporary seated fixed seam')
        pinned = 0
        for vertex in proxy.data.vertices:
            value = float(np.clip((vertex.co.z - (seam - pin_depth)) / pin_fade, 0, 1))
            if value > 0:
                pin.add([vertex.index], value, 'REPLACE')
                pinned += 1
        if pinned < 3 or pinned == len(rest_proxy):
            raise ValueError('Cloth simulation requires an anchored seam and a free hem')
        armature = proxy.modifiers.new('Temporary cloth input pose', 'ARMATURE')
        armature.object = ref.rig
        cloth = proxy.modifiers.new('Temporary offline seated solve', 'CLOTH')
        settings = cloth.settings
        settings.quality = int(quality)
        settings.mass = .15
        settings.tension_stiffness = settings.compression_stiffness = 25
        settings.shear_stiffness = 15
        settings.bending_stiffness = .5
        settings.vertex_group_mass = pin.name
        settings.pin_stiffness = 1.
        settings.air_damping = 3
        settings.effector_weights.gravity = 1.
        collisions = cloth.collision_settings
        collisions.use_collision = True
        collisions.distance_min = float(cloth_distance)
        collisions.collision_quality = int(collision_quality)
        collisions.use_self_collision = False
        cloth.point_cache.frame_start = 1
        cloth.point_cache.frame_end = int(frames)
        cloth.point_cache.use_disk_cache = False
        collider = ref.full.copy()
        collider.data = ref.full.data.copy()
        collider_mesh = collider.data
        collider.name = 'Temporary continuous seated body collider'
        bpy.context.scene.collection.objects.link(collider)
        collider.hide_viewport = False
        collider.hide_render = True
        body_weights = M.vertex_weights(collider)
        bm = bmesh.new()
        try:
            bm.from_mesh(collider.data)
            bm.verts.ensure_lookup_table()
            bmesh.ops.delete(bm, geom=[face for face in bm.faces
                            if max(body_weights[v.index, M.ARM_BONES].sum()
                                   for v in face.verts) > .15], context='FACES')
            bm.to_mesh(collider.data)
        finally:
            bm.free()
        collider.modifiers.new('Temporary cloth body collision', 'COLLISION')
        collider.collision.thickness_outer = float(body_distance)
        collider.collision.thickness_inner = .001
        collider.collision.cloth_friction = 5
        floor_height = max(0., float(ref.joint['hips'][2]) - .11 -
                           float(pose_profile['seat_height']) / float(pose_profile['scale']))
        if floor_collider:
            # The rig-local floor rises as the actor lowers onto the seat.
            # It is simulation context only and is removed before export.
            floor_mesh = bpy.data.meshes.new('Temporary seated floor geometry')
            floor_mesh.from_pydata([(-2, -2, 0), (2, -2, 0), (2, 2, 0), (-2, 2, 0)],
                                   [], [(0, 1, 2, 3)])
            floor_mesh.update()
            floor = bpy.data.objects.new('Temporary seated floor collider', floor_mesh)
            bpy.context.scene.collection.objects.link(floor)
            floor.hide_render = True
            floor.modifiers.new('Temporary floor collision', 'COLLISION')
            floor.collision.thickness_outer = float(body_distance)
            floor.collision.thickness_inner = .001
            floor.collision.cloth_friction = 5
            floor.location.z = 0.
            floor.keyframe_insert(data_path='location', frame=1)
            floor.location.z = floor_height
            floor.keyframe_insert(data_path='location', frame=int(sit_frame))
            floor_action = floor.animation_data.action
        for bone in ref.rig.pose.bones:
            bone.rotation_mode = 'QUATERNION'
            bone.rotation_quaternion = (1, 0, 0, 0)
            bone.keyframe_insert(data_path='rotation_quaternion', frame=1)
            bone.rotation_quaternion = end_bases[bone.name].to_quaternion()
            bone.keyframe_insert(data_path='rotation_quaternion', frame=int(sit_frame))
        action = ref.rig.animation_data.action
        posed_proxy = None
        for frame in range(1, int(frames) + 1):
            scene.frame_set(frame)
            bpy.context.view_layer.update()
            evaluated = proxy.evaluated_get(bpy.context.evaluated_depsgraph_get())
            mesh = evaluated.to_mesh()
            try:
                posed_proxy = np.array([v.co[:] for v in mesh.vertices])
            finally:
                evaluated.to_mesh_clear()
        if not np.isfinite(posed_proxy).all() or len(posed_proxy) != len(rest_proxy):
            raise ValueError('Offline cloth solve changed proxy topology or produced invalid coordinates')
        target = M.skin_points(points, weights, matrices)
        for index, triangle, bary, residual in correspondence:
            rest = rest_proxy[triangle]
            posed = posed_proxy[triangle]
            def frame(vertices):
                x = vertices[1] - vertices[0]
                x /= max(np.linalg.norm(x), 1e-12)
                z = np.cross(x, vertices[2] - vertices[0])
                z /= max(np.linalg.norm(z), 1e-12)
                return np.column_stack((x, np.cross(z, x), z))
            target[index] = bary @ posed + frame(posed) @ frame(rest).T @ residual
        # A button/buckle is a rigid source detail, not a cloth membrane.
        # One owner frame per detached detail prevents adjacent button vertices
        # from following different nearby folded cloth surfaces.
        for component in rigid_groups:
            centre = points[component].mean(axis=0)
            near, _normal, face, _distance = tree.find_nearest(Vector(centre))
            triangle = proxy_triangles[face]
            bary = M.barycentric(near, *(Vector(rest_proxy[i]) for i in triangle))
            rotation = frame(posed_proxy[triangle]) @ frame(rest_proxy[triangle]).T
            target[component] = (bary @ posed_proxy[triangle] +
                                 (points[component] - np.array(near)) @ rotation.T)
        active = selected & ~native_fixed
        body = M.skin_points(ref.verts, ref.weights, matrices)
        body_tree = BVHTree.FromPolygons([Vector(v) for v in body], ref.tris.tolist(),
                                        all_triangles=True)
        body_arms = ref.weights[:, M.ARM_BONES].sum(axis=1)[ref.tris].max(axis=1) > .15
        def penetration(point):
            nearest, normal, face, _distance = body_tree.find_nearest(Vector(point))
            if nearest is None or body_arms[face]:
                return 0.
            return max(0., -(Vector(point) - nearest).dot(normal))
        vertex_depths = np.array([penetration(target[i]) for i in np.flatnonzero(active)])
        obj.data.calc_loop_triangles()
        source_triangles = np.array([face.vertices[:] for face in obj.data.loop_triangles
                                     if active[list(face.vertices)].all()], dtype=np.int64)
        face_depths = np.array([penetration(target[triangle].mean(axis=0)) for triangle in source_triangles])
        edges = np.unique(np.sort(np.concatenate([source_triangles[:, [0, 1]],
                          source_triangles[:, [1, 2]], source_triangles[:, [2, 0]]]), axis=1), axis=0)
        original_lengths = np.linalg.norm(points[edges[:, 1]] - points[edges[:, 0]], axis=1)
        target_lengths = np.linalg.norm(target[edges[:, 1]] - target[edges[:, 0]], axis=1)
        stretch = target_lengths / np.maximum(original_lengths, 1e-8)
        result = M.unskin_points(target, weights, matrices)
        result[~active] = points[~active]
        return result, {'mode': 'offline_cloth',
                        'sourceVerticesKeepingNativeBinding': int(native_fixed.sum()),
                        'rigidDetailComponents': len(rigid_groups),
                        'rigidDetailVertices': int(rigid_mask.sum()),
                        'coreVertexContactsOver2mm': int((vertex_depths > .002).sum()),
                        'coreFaceContactsOver2mm': int((face_depths > .002).sum()),
                        'maximumCorePenetration': float(max(vertex_depths.max(initial=0), face_depths.max(initial=0))),
                        'maximumEdgeStretch': float(stretch.max(initial=1)),
                        'maximumEdgeLengthIncrease': float((target_lengths - original_lengths).max(initial=0)),
                        'edgesOver5xAnd2cm': int(((stretch > 5) & (target_lengths > .02)).sum()),
                        'edgesOver2x': int(((stretch > 2) & (original_lengths > .001)).sum()), 'selectedVertices': int(selected.sum()),
                        'proxyVertices': len(rest_proxy), 'proxyTriangles': len(proxy_triangles),
                        'proxyWeldDistance': float(proxy_weld_distance),
                        'weldConsistentTransfer': bool(weld_consistent_transfer),
                        'unanchoredProxyVerticesFollowingCloth': followed_vertices,
                        'maximumProxyDistance': maximum_proxy_distance, 'pinnedVertices': pinned,
                        'seamHeight': seam, 'frames': int(frames), 'sitFrame': int(sit_frame),
                        'quality': int(quality), 'collisionQuality': int(collision_quality),
                        'poseProfile': pose_profile, 'floorCollider': bool(floor_collider),
                        'seatedFloorHeight': floor_height if floor_collider else None,
                        'blenderVersion': bpy.app.version_string,
                        'maximumRestCorrection': float(np.linalg.norm(result - points, axis=1).max())}
    finally:
        if ref.rig.animation_data:
            ref.rig.animation_data.action = saved_action
        if not had_animation:
            ref.rig.animation_data_clear()
        if action is not None and action.users == 0:
            bpy.data.actions.remove(action)
        for temporary in (proxy, collider, floor):
            if temporary is not None:
                bpy.data.objects.remove(temporary, do_unlink=True)
        for mesh in (proxy_mesh, collider_mesh, floor_mesh):
            if mesh is not None and mesh.users == 0:
                bpy.data.meshes.remove(mesh)
        if floor_action is not None and floor_action.users == 0:
            bpy.data.actions.remove(floor_action)
        scene.gravity = saved_gravity
        scene.render.fps = saved_fps
        scene.frame_set(saved_frame, subframe=saved_subframe)
        ref.rig.location = saved_location
        for bone in ref.rig.pose.bones:
            basis, rotation_mode = saved_bases[bone.name]
            bone.rotation_mode = rotation_mode
            bone.matrix_basis = basis
        bpy.context.view_layer.update()


def _clear_height_bank(obj, ref, weights, selected, M, profiles):
    """Resolve sampled bank interpolation contacts, solely in seated targets.

    Cloth folds can interpolate through a leg even when both endpoint solves
    are clear. Contact corrections are shared by the two contributing targets;
    three local adjacency passes avoid a hard edge around the contact patch.
    No geometry, source attributes, skin weights, or Basis coordinates change.
    """
    names = ['ExtaliaSeatedDrapeShort', 'ExtaliaSeatedDrape', 'ExtaliaSeatedDrapeTall']
    keys = obj.data.shape_keys.key_blocks
    basis = np.array([v.co[:] for v in keys['Basis'].data])
    targets = np.array([[v.co[:] for v in keys[name].data] for name in names])
    before = targets.copy()
    active = selected & (np.linalg.norm(targets - basis, axis=2) > 1e-7).any(axis=0)
    indices = np.flatnonzero(active)
    obj.data.calc_loop_triangles()
    triangles = np.array([face.vertices[:] for face in obj.data.loop_triangles
                          if active[list(face.vertices)].all()], dtype=np.int64)
    edges = np.array([edge.vertices[:] for edge in obj.data.edges
                      if active[list(edge.vertices)].all()], dtype=np.int64)
    if not len(indices) or not len(triangles) or not len(edges):
        raise ValueError('Height bank clearance requires a complete owned cloth surface')
    source_lengths = np.linalg.norm(basis[edges[:, 1]] - basis[edges[:, 0]], axis=1)
    arm_faces = ref.weights[:, M.ARM_BONES].sum(axis=1)[ref.tris].max(axis=1) > .15
    poses = []
    for segment in range(2):
        for fraction in np.linspace(0., 1., 5)[int(segment > 0):]:
            blend = np.zeros(3)
            blend[segment], blend[segment + 1] = 1. - fraction, fraction
            scale = float(sum(blend[i] * profiles[i]['scale'] for i in range(3)))
            matrices = seated_matrices(ref, {**profiles[1], 'scale': scale})
            body = M.skin_points(ref.verts, ref.weights, matrices)
            tree = BVHTree.FromPolygons([Vector(v) for v in body], ref.tris.tolist(),
                                       all_triangles=True)
            transform = np.einsum('nb,bij->nij', weights, matrices)
            rotation, translation = transform[:, :3, :3], transform[:, :3, 3]
            poses.append((scale, blend, tree, rotation, translation, np.linalg.inv(rotation)))
    iterations = 0
    for iteration in range(8):
        contacts = 0
        for _scale, blend, tree, rotation, translation, inverse in poses:
            posed = np.einsum('nij,nj->ni', rotation,
                             np.einsum('b,bnj->nj', blend, targets)) + translation
            delta, total = np.zeros_like(posed), np.zeros(len(posed))
            def correction(point):
                near, normal, face, _distance = tree.find_nearest(Vector(point))
                depth = -float((Vector(point) - near).dot(normal))
                if not arm_faces[face] and depth > -.002:
                    return np.array(normal) * (depth + .003)
                return None
            for index in indices:
                offset = correction(posed[index])
                if offset is not None:
                    delta[index] += offset; total[index] += 1; contacts += 1
            for face in triangles:
                offset = correction(posed[face].mean(axis=0))
                if offset is not None:
                    delta[face] += offset; total[face] += 1; contacts += 1
            delta /= np.maximum(total, 1)[:, None]
            for _ in range(3):
                accumulated, degree = delta.copy(), np.ones(len(delta))
                np.add.at(accumulated, edges[:, 0], delta[edges[:, 1]])
                np.add.at(accumulated, edges[:, 1], delta[edges[:, 0]])
                np.add.at(degree, edges[:, 0], 1)
                np.add.at(degree, edges[:, 1], 1)
                smooth = accumulated / degree[:, None]
                delta = np.where((total > 0)[:, None], delta * .65 + smooth * .35,
                                 smooth * .5)
            rest_delta = np.einsum('nij,nj->ni', inverse, delta)
            targets += blend[:, None, None] * rest_delta[None, :, :] / float(blend @ blend)
        iterations = iteration + 1
        if not contacts:
            break
    displacement = float(np.linalg.norm(targets - before, axis=2).max())
    if not np.isfinite(targets).all() or displacement > .05:
        raise ValueError('Height bank contact correction exceeded its 50mm bound')
    samples = []
    for scale, blend, tree, rotation, translation, _inverse in poses:
        posed = np.einsum('nij,nj->ni', rotation,
                         np.einsum('b,bnj->nj', blend, targets)) + translation
        def penetration(point):
            near, normal, face, _distance = tree.find_nearest(Vector(point))
            return (0. if arm_faces[face] else
                    max(0., -float((Vector(point) - near).dot(normal))))
        vertex_depths = np.array([penetration(posed[i]) for i in indices])
        face_depths = np.array([penetration(point) for point in posed[triangles].mean(axis=1)])
        lengths = np.linalg.norm(posed[edges[:, 1]] - posed[edges[:, 0]], axis=1)
        long_stretch = int(((lengths > source_lengths * 5) & (lengths > .02)).sum())
        row = {'scale': scale,
               'coreVerticesOver2mm': int((vertex_depths > .002).sum()),
               'coreFacesOver2mm': int((face_depths > .002).sum()),
               'maximumCorePenetration': float(max(vertex_depths.max(initial=0),
                                                    face_depths.max(initial=0))),
               'edgesOver5xAnd2cm': long_stretch}
        if row['coreVerticesOver2mm'] or row['coreFacesOver2mm'] or long_stretch:
            raise ValueError('Height bank clearance validation failed: ' + str(row))
        samples.append(row)
    for name, target in zip(names, targets):
        keys[name].data.foreach_set('co', target.reshape(-1))
    return {'iterations': iterations, 'maximumRestCorrection': displacement, 'samples': samples}


def add_seated_drape(obj, ref, weights, selected, M, *, waist, mode="analytic",
                     selection_height=None, selection_material_patterns=None,
                     tall_pose_profile=None, short_pose_profile=None, height_bank_clearance=False, **options):
    """Add ``ExtaliaSeatedDrape`` with value 0; call before joining context.

    The caller must export morph targets and drive this key with the runtime
    seated transition (0 standing/walking, 1 at the authored seated pose).
    An explicit tall_pose_profile also bakes ExtaliaSeatedDrapeTall at value 0;
    short_pose_profile similarly adds ExtaliaSeatedDrapeShort. The runtime
    interpolates the optional height bank; every target defaults to zero.
    """
    if obj.data.shape_keys and obj.data.shape_keys.key_blocks.get('ExtaliaSeatedDrape'):
        raise ValueError('ExtaliaSeatedDrape already exists')
    points = np.array([vertex.co[:] for vertex in obj.data.vertices])
    selected = np.asarray(selected, dtype=bool).copy()
    if selection_height is not None:
        if float(selection_height) <= 0:
            raise ValueError('A seated-only selection height must be positive')
        # This explicit option is evaluated before native context is joined.
        # It extends only the corrective ownership; walking weights and Basis
        # remain untouched. Hanging sleeves stay excluded by arm ownership.
        selected |= ((points[:, 2] < float(selection_height)) &
                     (weights[:, M.ARM_BONES].sum(axis=1) < .2))
    if selection_material_patterns is not None:
        patterns = [re.compile(pattern) for pattern in selection_material_patterns]
        owned = np.zeros(len(points), dtype=bool)
        for face in obj.data.polygons:
            name = obj.data.materials[face.material_index].name
            if any(pattern.search(name) for pattern in patterns):
                owned[list(face.vertices)] = True
        selected &= owned
        if not selected.any():
            raise ValueError('Seated material selection matched no owned source vertices')
    obj.data.calc_loop_triangles()
    triangles = np.array([face.vertices[:] for face in obj.data.loop_triangles], dtype=np.int64)
    def solve(parameters):
        if mode == 'offline_cloth':
            return simulated_seated_drape(obj, ref, weights, selected, M,
                                           waist=waist, **parameters)
        if mode == 'analytic':
            return seated_drape_points(points, weights, selected, ref, M,
                                        waist=waist, triangles=triangles, **parameters)
        raise ValueError('Unknown seated drape mode: ' + str(mode))
    if height_bank_clearance and (mode != 'offline_cloth' or
            not short_pose_profile or not tall_pose_profile):
        raise ValueError('Height bank clearance requires explicit Short/Base/Tall cloth profiles')
    corrected, receipt = solve(options)
    if not obj.data.shape_keys:
        obj.shape_key_add(name='Basis')
    key = obj.shape_key_add(name='ExtaliaSeatedDrape')
    key.data.foreach_set('co', corrected.reshape(-1))
    key.value = 0.
    key.slider_min = 0.; key.slider_max = 1.
    obj['extaliaSeatedDrape'] = True
    for suffix, profile in (('Tall', tall_pose_profile), ('Short', short_pose_profile)):
        if profile is None:
            continue
        if not isinstance(profile, dict):
            raise ValueError(suffix.lower() + '_pose_profile must contain an explicit supported-seat profile')
        name = 'ExtaliaSeatedDrape' + suffix
        if obj.data.shape_keys.key_blocks.get(name):
            raise ValueError(name + ' already exists')
        variant, variant_receipt = solve({**options, 'pose_profile': profile})
        variant_key = obj.shape_key_add(name=name)
        variant_key.data.foreach_set('co', variant.reshape(-1))
        variant_key.value = 0.
        variant_key.slider_min = 0.; variant_key.slider_max = 1.
        receipt[suffix.lower()] = {'shapeKey': variant_key.name, **variant_receipt}
        obj['extaliaSeatedDrape' + suffix] = True
    if height_bank_clearance:
        receipt['heightBankClearance'] = _clear_height_bank(
            obj, ref, weights, selected, M,
            [short_pose_profile, options['pose_profile'], tall_pose_profile])
    return {'shapeKey': key.name, 'selectionHeight': selection_height,
            'selectionMaterialPatterns': selection_material_patterns, **receipt}
