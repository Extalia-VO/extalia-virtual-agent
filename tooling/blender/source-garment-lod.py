"""Opt-in per-object detail LOD before source garments are combined.

Call ``prepare_source_lod(objects, recipe, M)`` after indexed source import.
Example: ``partLod=[['stitch', 10000]], detailObjects=['stitch']``. Both rules
match object names, case-insensitively. Primary cloth is never reduced. Source
files and materials are read-only; only copied detail mesh datablocks change.
"""
import hashlib
import json
import re

import numpy as np


def _triangles(mesh):
    return sum(len(face.vertices) - 2 for face in mesh.polygons)


def _signature(obj):
    """Capture primary geometry/corner attributes without topology operations."""
    mesh = obj.data
    digest = hashlib.sha256()
    def column(collection, attribute, width, dtype):
        values = np.empty(len(collection) * width, dtype=dtype)
        collection.foreach_get(attribute, values)
        digest.update(values.tobytes())
    column(mesh.vertices, 'co', 3, np.float32)
    column(mesh.loops, 'vertex_index', 1, np.int32)
    for name in ('loop_start', 'loop_total', 'material_index'):
        column(mesh.polygons, name, 1, np.int32)
    for layer in mesh.uv_layers:
        digest.update(layer.name.encode())
        column(layer.data, 'uv', 2, np.float32)
    for layer in mesh.color_attributes:
        digest.update((layer.name + layer.domain + layer.data_type).encode())
        column(layer.data, 'color', 4, np.float32)
    digest.update(np.asarray(obj.matrix_world, dtype=np.float64).tobytes())
    # No LOD operation may exchange a primary material or touch its parameters.
    materials = []
    for material in mesh.materials:
        if material is None:
            materials.append(None)
            continue
        nodes = []
        if material.use_nodes and material.node_tree:
            for node in material.node_tree.nodes:
                sockets = []
                for socket in node.inputs:
                    if not hasattr(socket, 'default_value'):
                        continue
                    value = socket.default_value
                    try:
                        value = list(value)
                    except TypeError:
                        pass
                    if isinstance(value, (str, int, float, bool, list)):
                        sockets.append((socket.name, value))
                image = getattr(node, 'image', None)
                nodes.append((node.name, node.bl_idname, image.as_pointer() if image else None, sockets))
            links = [(link.from_node.name, link.from_socket.identifier, link.to_node.name, link.to_socket.identifier)
                     for link in material.node_tree.links]
        else:
            links = []
        materials.append((material.as_pointer(), material.name, list(material.diffuse_color), material.metallic,
                          material.roughness, nodes, links))
    digest.update(json.dumps(materials, sort_keys=True).encode())
    return digest.hexdigest()


def prepare_source_lod(objects, recipe, M):
    """Reduce explicitly selected detail meshes; assert primary data is unchanged.

    Returns actual per-part triangle counts. A resistant detail mesh may remain
    above budget: no non-manifold splitting or object deletion is permitted.
    Shared mesh data is copied before reduction, protecting other source parts.
    """
    rules = recipe.get('partLod', [])
    detail_patterns = [re.compile(pattern, re.I) for pattern in recipe.get('detailObjects', [])]
    compiled = []
    for pattern, target in rules:
        if not isinstance(target, int) or isinstance(target, bool) or target < 4:
            raise ValueError('Detail LOD target must be an integer of at least four triangles')
        compiled.append((re.compile(pattern, re.I), target))
    meshes = [obj for obj in objects if obj.type == 'MESH']
    selected, protected = {}, {}
    for obj in meshes:
        target = next((target for pattern, target in compiled if pattern.search(obj.name)), None)
        if target is not None:
            if not any(pattern.search(obj.name) for pattern in detail_patterns):
                raise ValueError('LOD rule targets a non-detail source object: ' + obj.name)
            selected[obj] = target
        else:
            protected[obj] = _signature(obj)
    reports = []
    for obj in meshes:
        before = _triangles(obj.data)
        target = selected.get(obj)
        slots_before = tuple(material.as_pointer() if material else None for material in obj.data.materials)
        if target is not None and before > target:
            # Never weld shared source data in place. Coincident stitch corners
            # may be joined for reduction, while per-loop UVs remain available.
            obj.data = obj.data.copy()
            M.weld_source_seams(obj)
            M.decimate(obj, target)
        after = _triangles(obj.data)
        if before and not after:
            raise ValueError('Detail LOD removed an entire source part: ' + obj.name)
        slots_after = tuple(material.as_pointer() if material else None for material in obj.data.materials)
        if slots_before != slots_after:
            raise ValueError('Detail LOD changed material identity: ' + obj.name)
        reports.append({'object': obj.name, 'detail': target is not None, 'trianglesBefore': before,
                        'trianglesAfter': after, 'target': target,
                        'budgetMet': target is None or after <= target * 1.02})
    for obj, before in protected.items():
        if _signature(obj) != before:
            raise ValueError('LOD changed protected primary cloth geometry, UVs or material: ' + obj.name)
    result = {'sourceTriangles': sum(item['trianglesBefore'] for item in reports),
              'resultTriangles': sum(item['trianglesAfter'] for item in reports),
              'primaryTriangles': sum(item['trianglesAfter'] for item in reports if not item['detail']),
              'primaryUnchanged': True, 'parts': reports}
    print('SOURCE_PART_LOD', json.dumps(result), flush=True)
    return result
