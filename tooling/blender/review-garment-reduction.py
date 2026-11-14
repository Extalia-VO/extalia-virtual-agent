"""Render isolated garment regression poses, not full application fit certification.

Blender -b --factory-startup --python-exit-code 1 --python tooling/blender/review-garment-reduction.py -- \
  --input <garment.glb> --output-dir <review-dir> [--rear]

Uses synthetic rest/walk/sit/reach joint rotations in glTF coordinates, inspired by
existing garment-layers.py audit poses. No runtime body removal, corrective morphs,
IK, furniture or other avatar combinations are simulated. Compare baseline and candidate
with the same script/settings; source GLBs are never modified.
"""
import argparse
import copy
import importlib.util
import math
from pathlib import Path
import sys
import tempfile

import bpy
import numpy as np
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('garment_simplify', ROOT / 'tooling/simplify-garment-meshes.py')
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)
POSES = {
    'rest': {},
    'sit': {'leftUpperLeg': ([1, 0, 0], -88), 'rightUpperLeg': ([1, 0, 0], -88),
            'leftLowerLeg': ([1, 0, 0], 88), 'rightLowerLeg': ([1, 0, 0], 88),
            'spine': ([1, 0, 0], 8), 'chest': ([1, 0, 0], 6)},
    'walk': {'leftUpperLeg': ([1, 0, 0], -30), 'rightUpperLeg': ([1, 0, 0], 22),
             'leftLowerLeg': ([1, 0, 0], 12), 'rightLowerLeg': ([1, 0, 0], 38), 'spine': ([0, 1, 0], 6)},
    'reach': {'leftUpperArm': ([1, 0, 0], -45), 'rightUpperArm': ([1, 0, 0], -45),
              'leftLowerArm': ([1, 0, 0], -75), 'rightLowerArm': ([1, 0, 0], -75),
              'spine': ([1, 0, 0], 18), 'chest': ([1, 0, 0], 10)},
}


def rotation(axis, degrees):
    x, y, z = np.array(axis, float) / np.linalg.norm(axis)
    angle = math.radians(degrees)
    c, s = math.cos(angle), math.sin(angle)
    v = 1-c
    result = np.eye(4)
    result[:3, :3] = [[c+x*x*v, x*y*v-z*s, x*z*v+y*s],
                      [y*x*v+z*s, c+y*y*v, y*z*v-x*s],
                      [z*x*v-y*s, z*y*v+x*s, c+z*z*v]]
    return result


def pose_copy(raw, pose):
    source, binary = M.BUFFERS.read_glb(raw)
    M.validate_input(source)
    document, output = copy.deepcopy(source), bytearray(binary)
    parents = {child: index for index, node in enumerate(source['nodes']) for child in node.get('children', [])}
    world, deltas = {}, {}

    def rest_world(index):
        if index not in world:
            node = source['nodes'][index]
            x, y, z, w = node.get('rotation', [0, 0, 0, 1])
            matrix = np.eye(4)
            matrix[:3, :3] = np.array([
                [1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)],
                [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)],
                [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)]]) * node.get('scale', [1, 1, 1])
            matrix[:3, 3] = node.get('translation', [0, 0, 0])
            if 'matrix' in node:
                matrix = np.array(node['matrix']).reshape(4, 4).T
            world[index] = (rest_world(parents[index]) if index in parents else np.eye(4)) @ matrix
        return world[index]

    def pose_delta(index):
        if index not in deltas:
            delta = pose_delta(parents[index]) if index in parents else np.eye(4)
            name = source['nodes'][index].get('name')
            if name in pose:
                axis, degrees = pose[name]
                translation, inverse = np.eye(4), np.eye(4)
                translation[:3, 3] = rest_world(index)[:3, 3]
                inverse[:3, 3] = -rest_world(index)[:3, 3]
                delta = delta @ translation @ rotation(axis, degrees) @ inverse
            deltas[index] = delta
        return deltas[index]

    def append(values):
        values = np.array(values, dtype='<f4')
        output.extend(b'\0' * (-len(output) % 4))
        view = len(document['bufferViews'])
        document['bufferViews'].append({'buffer': 0, 'byteOffset': len(output), 'byteLength': values.nbytes})
        output.extend(values.tobytes())
        index = len(document['accessors'])
        document['accessors'].append({'bufferView': view, 'componentType': 5126, 'count': len(values),
                                     'type': 'VEC3', 'min': values.min(axis=0).tolist(), 'max': values.max(axis=0).tolist()})
        return index

    for node in source['nodes']:
        if 'mesh' not in node:
            continue
        if 'skin' not in node:
            raise ValueError('Review currently requires skinned garment nodes')
        skin = source['skins'][node['skin']]
        inverse_bind = M.stored_array(source, binary, skin['inverseBindMatrices']).reshape(-1, 4, 4).transpose(0, 2, 1)
        matrices = np.array([pose_delta(joint) @ rest_world(joint) @ inverse_bind[k] for k, joint in enumerate(skin['joints'])])
        for primitive in document['meshes'][node['mesh']]['primitives']:
            attributes = primitive['attributes']
            joints = M.stored_array(source, binary, attributes['JOINTS_0'])
            weights = M.float_array(source, binary, attributes['WEIGHTS_0'])
            blend = (matrices[joints] * weights[:, :, None, None]).sum(axis=1)
            positions = M.float_array(source, binary, attributes['POSITION'])
            posed = np.einsum('nij,nj->ni', blend, np.column_stack([positions, np.ones(len(positions))]))[:, :3]
            attributes['POSITION'] = append(posed)
            if 'NORMAL' in attributes:
                normals = np.einsum('nij,nj->ni', blend[:, :3, :3], M.float_array(source, binary, attributes['NORMAL']))
                normals /= np.maximum(np.linalg.norm(normals, axis=1)[:, None], 1e-12)
                attributes['NORMAL'] = append(normals)
            for key in ('TANGENT', 'JOINTS_0', 'WEIGHTS_0'):
                attributes.pop(key, None)
    document['nodes'] = [{'mesh': index} for index in range(len(document['meshes']))]
    document['scenes'] = [{'nodes': list(range(len(document['meshes'])))}]
    document['scene'] = 0
    document.pop('skins', None)
    document['buffers'][0]['byteLength'] = len(output)
    return M.BUFFERS.write_glb(document, bytes(output))


def render(path, output, rear):
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=str(path))
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']
    points = [obj.matrix_world @ Vector(vertex) for obj in meshes for vertex in obj.bound_box]
    low = Vector([min(point[i] for point in points) for i in range(3)])
    high = Vector([max(point[i] for point in points) for i in range(3)])
    center, size = (low+high)*.5, max(high-low)
    camera = bpy.data.cameras.new('Review')
    obj = bpy.data.objects.new('Review', camera)
    bpy.context.collection.objects.link(obj)
    obj.location = center + Vector((size*.6, size*2.5 if rear else -size*2.5, size*.2))
    obj.rotation_euler = (center-obj.location).to_track_quat('-Z', 'Y').to_euler()
    camera.type, camera.ortho_scale = 'ORTHO', size*1.15
    bpy.context.scene.camera = obj
    for position, power in [((2, -3, 4), 500), ((-3, -2, 2), 300), ((0, 3, 4), 400)]:
        light = bpy.data.lights.new('ReviewLight', 'AREA')
        light.energy, light.shape, light.size = power, 'DISK', size*2
        obj = bpy.data.objects.new('ReviewLight', light)
        bpy.context.collection.objects.link(obj)
        obj.location = center + Vector(position)*size
        obj.rotation_euler = (center-obj.location).to_track_quat('-Z', 'Y').to_euler()
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.samples, scene.cycles.use_denoising = 16, False
    scene.world.color = (.15, .15, .15)
    scene.render.resolution_x = scene.render.resolution_y = 512
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.filepath = str(output)
    scene.render.film_transparent = False
    bpy.ops.render.render(write_still=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--rear', action='store_true')
    args = parser.parse_args(sys.argv[sys.argv.index('--')+1:])
    raw = args.input.read_bytes()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='garment-review-') as temporary:
        for name, pose in POSES.items():
            path = Path(temporary) / 'posed.glb'
            path.write_bytes(pose_copy(raw, pose))
            render(path, args.output_dir / f'{name}.png', args.rear)


if __name__ == '__main__':
    main()
