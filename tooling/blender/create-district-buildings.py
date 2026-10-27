"""Build the local surrounding district buildings library in Blender; app X/Y/Z = Blender X/Z/-Y.

Blender --factory-startup --background --python tooling/blender/create-district-buildings.py -- --output <directory> --preview <png>

Generates 12 architectural outer-shell buildings (`district-0` .. `district-11`) matching `DISTRICT_BUILDINGS`
in `CampusSkyline.tsx`. Each building root sits at `(0, 0, 0)` and merges child meshes into 4 shared material
roles so the entire 12-building surrounding district renders in just 4 WebGL draw calls while keeping
the live world-space window-grid shader (`FACADE_COLOR` / `FACADE_EMISSIVE`) and night crown lighting.
"""
import argparse
import json
import math
import os
import sys
import bpy
from mathutils import Vector

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '../..'))
parser = argparse.ArgumentParser()
parser.add_argument('--output', default=os.path.join(REPO, 'apps/web/local-assets/landscape'))
parser.add_argument('--preview')
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
os.makedirs(args.output, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.unit_settings.system = 'METRIC'
scene['coordinate_system'] = 'app X/Y/Z = Blender X/Z/-Y'

GROUND_Y = -0.8
FLOOR = 3.6

DISTRICT_BUILDINGS = [
    # West blocks
    {'id': 'district-0', 'x': -84, 'z': -44, 'w': 26, 'd': 16, 'h': 42, 'kind': 'fins', 'arch': 'diagrid-fins', 'tone': '9db0b8', 'seed': 101.0},
    {'id': 'district-1', 'x': -84, 'z': 0, 'w': 26, 'd': 26, 'h': 96, 'kind': 'tower', 'arch': 'chamfered-tower', 'tone': '7b92a5', 'seed': 104.7},
    {'id': 'district-2', 'x': -84, 'z': 45, 'w': 28, 'd': 16, 'h': 58, 'kind': 'stepped', 'arch': 'cascading-terrace', 'tone': 'b6c4cd', 'seed': 108.4},
    {'id': 'district-3', 'x': -84, 'z': 67, 'w': 26, 'd': 16, 'h': 74, 'kind': 'tower', 'arch': 'sky-atrium-tower', 'tone': '88a1b0', 'seed': 112.1},
    # Rear block behind the HQ
    {'id': 'district-4', 'x': -40, 'z': 65, 'w': 22, 'd': 20, 'h': 40, 'kind': 'stepped', 'arch': 'courtyard-stepped', 'tone': 'c2ccd3', 'seed': 115.8},
    {'id': 'district-5', 'x': -14, 'z': 65, 'w': 20, 'd': 18, 'h': 30, 'kind': 'residential', 'arch': 'cantilever-residences', 'tone': 'd0cec5', 'seed': 119.5},
    {'id': 'district-6', 'x': 10, 'z': 65, 'w': 18, 'd': 18, 'h': 26, 'kind': 'fins', 'arch': 'louvered-pavilion', 'tone': 'a3b6c3', 'seed': 123.2},
    {'id': 'district-7', 'x': 36, 'z': 66, 'w': 20, 'd': 18, 'h': 24, 'kind': 'residential', 'arch': 'garden-residences', 'tone': 'c8cdc9', 'seed': 126.9},
    # East blocks
    {'id': 'district-8', 'x': 84, 'z': -44, 'w': 26, 'd': 16, 'h': 36, 'kind': 'residential', 'arch': 'podium-residences', 'tone': 'bcc5c6', 'seed': 130.6},
    {'id': 'district-9', 'x': 84, 'z': 0, 'w': 28, 'd': 24, 'h': 112, 'kind': 'tower', 'arch': 'twin-core-tower', 'tone': '6d8395', 'seed': 134.3},
    {'id': 'district-10', 'x': 84, 'z': 45, 'w': 26, 'd': 16, 'h': 50, 'kind': 'fins', 'arch': 'colonade-fins', 'tone': '8ea5b6', 'seed': 138.0},
    {'id': 'district-11', 'x': 84, 'z': 67, 'w': 24, 'd': 16, 'h': 82, 'kind': 'tower', 'arch': 'tapered-crown-tower', 'tone': '7f97a8', 'seed': 141.7},
]


def hex_to_linear(color):
    rgb = tuple(int(color[i:i+2], 16) / 255 for i in (0, 2, 4))
    return tuple(c / 12.92 if c <= .04045 else ((c + .055) / 1.055) ** 2.4 for c in rgb)


def make_role_mat(name, color, roughness=.55, metal=0):
    rgb = hex_to_linear(color)
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*rgb, 1)
    m.use_nodes = True
    tree = m.node_tree
    bsdf = tree.nodes.get('Principled BSDF')
    attr = tree.nodes.new('ShaderNodeVertexColor')
    attr.layer_name = 'Color'
    tree.links.new(attr.outputs['Color'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Metallic'].default_value = metal
    return m


# 4 shared material roles across the entire district so runtime batching produces 4 draw calls total:
mat_facade = make_role_mat('District facade glazing', 'ffffff', .42, .12)
mat_solid = make_role_mat('District architectural solid', 'ffffff', .82, .08)
mat_crown = make_role_mat('District crown light', 'ffffff', .3, 0)
mat_foliage = make_role_mat('District terrace foliage', 'ffffff', .94, 0)

TONE_PODIUM = 'a4abae'
TONE_STONE = 'cfd4d6'
TONE_LIMESTONE = 'dcdad2'
TONE_MULLION = '47515b'
TONE_DARK_METAL = '343d46'
TONE_MECH = '5a636b'
TONE_BALUSTRADE = '9fb3be'
TONE_TERRACE_1 = '5d8452'
TONE_TERRACE_2 = '6b8f58'
TONE_WARM_CROWN = 'ffd49a'
TONE_COOL_CROWN = 'd6ecff'
TONE_WOOD = 'a98055'

roots = {}
active = None
glazed_masses = {}
detail_counts = {}


def point(p):
    return (p[0], -p[2], p[1])


def stamp_color(obj, hex_color):
    rgb = hex_to_linear(hex_color)
    mesh = obj.data
    if 'Color' not in mesh.color_attributes:
        mesh.color_attributes.new(name='Color', type='FLOAT_COLOR', domain='CORNER')
    layer = mesh.color_attributes['Color'].data
    for item in layer:
        item.color = (*rgb, 1.0)


def merge_root(root):
    batches = {}
    for child in list(root.children):
        batches.setdefault(child.data.materials[0].name, []).append(child)
    for material_name, objects in batches.items():
        bpy.ops.object.select_all(action='DESELECT')
        for obj in objects:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = objects[0]
        if len(objects) > 1:
            bpy.ops.object.join()
        obj = bpy.context.object
        obj.name = root.name + ' / ' + material_name
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        obj.parent = root


def group(spec):
    global active
    if active is not None:
        merge_root(active)
    name = spec['id']
    print('DISTRICT_BUILDING ' + name + ' (' + spec['arch'] + ')', flush=True)
    active = bpy.data.objects.new(name, None)
    scene.collection.objects.link(active)
    active['district_id'] = name
    active['district_seed'] = spec['seed']
    active['district_arch'] = spec['arch']
    roots[name] = active
    glazed_masses[name] = []
    detail_counts[name] = {'mullions': 0, 'transoms': 0, 'lobby_panels': 0}
    return active


def finish(obj, name, role_mat, hex_color, bevel=0, smooth=False):
    obj.name = name
    obj.data.materials.append(role_mat)
    bpy.context.view_layer.objects.active = obj
    if bevel > 0:
        modifier = obj.modifiers.new('Bevel', 'BEVEL')
        modifier.width = bevel
        modifier.segments = 1
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    for poly in obj.data.polygons:
        poly.use_smooth = smooth
    stamp_color(obj, hex_color)
    obj.parent = active
    return obj


def box_at(name, center, size, role_mat, hex_color, bevel=.04, rot_y=0):
    if min(size) <= 0.005:
        return None
    if role_mat == mat_facade and size[1] > FLOOR * 1.5:
        glazed_masses[active.name].append((center, size))
    bpy.ops.mesh.primitive_cube_add(size=1, location=point(center))
    obj = bpy.context.object
    obj.dimensions = (size[0], size[2], size[1])
    if rot_y:
        obj.rotation_euler = (0, 0, rot_y)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    return finish(obj, name, role_mat, hex_color, min(bevel, min(size) * .22), smooth=False)


def box_y0(name, x, y0, z, w, h, d, role_mat, hex_color, bevel=.04, rot_y=0):
    return box_at(name, (x, y0 + h / 2, z), (w, h, d), role_mat, hex_color, bevel, rot_y)


def foliage_at(x, y, z, radius, hex_color):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=1, location=point((x, y, z)))
    obj = bpy.context.object
    obj.scale = (radius, radius, radius * .88)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish(obj, 'Terrace tree crown', mat_foliage, hex_color, 0, smooth=False)


def front_frame(spec):
    along_x = abs(spec['x']) > abs(spec['z'])
    f = -1 if (spec['x'] > 0 if along_x else spec['z'] > 0) else 1
    L = spec['w'] if along_x else spec['d']
    A = spec['d'] if along_x else spec['w']

    def place(along, length, across_len, offset=0):
        if along_x:
            return (f * along, offset, length, across_len)
        return (offset, f * along, across_len, length)

    return L, A, place


def add_podium_portal(spec, podium_h, portal_w=7.2, canopy_proj=1.5):
    L, A, place = front_frame(spec)
    # Recessed dark lobby glass & projecting architectural canopy facing HQ
    px, pz, pw, pd = place(L / 2 + .18, .42, portal_w, 0)
    box_y0('Lobby portal frame', px, GROUND_Y, pz, pw, podium_h * .78, pd, mat_solid, TONE_DARK_METAL, .03)
    # The entry reads as a glazed recess inside the frame, not an opaque plaque.
    gx, gz, gw, gd = place(L / 2 + .41, .025, portal_w - .65, 0)
    box_y0('Lobby recessed glass', gx, GROUND_Y + .12, gz, gw, podium_h * .72, gd, mat_facade, '7695a1', 0)
    detail_counts[active.name]['lobby_panels'] += 1
    for offset in (-portal_w * .25, 0, portal_w * .25):
        fx, fz, fw, fd = place(L / 2 + .45, .12, .08, offset)
        box_y0('Lobby door mullion', fx, GROUND_Y + .12, fz, fw, podium_h * .72, fd, mat_solid, TONE_STONE, 0)
    cx, cz, cw, cd = place(L / 2 + canopy_proj / 2, canopy_proj, portal_w + 1.8, 0)
    box_y0('Lobby entrance canopy', cx, GROUND_Y + podium_h * .68, cz, cw, .28, cd, mat_solid, TONE_STONE, .03)
    lx, lz, lw, ld = place(L / 2 + canopy_proj * .55, canopy_proj * .7, portal_w + 1.0, 0)
    box_y0('Lobby canopy warm soffit', lx, GROUND_Y + podium_h * .65, lz, lw, .08, ld, mat_crown, TONE_WARM_CROWN, 0)
    # Podium colonnade piers along the front face
    pier_count = max(4, int(round(A / 5.2)))
    for i in range(pier_count + 1):
        across = -A / 2 + i * (A / pier_count)
        if abs(across) < portal_w * .45:
            continue
        col_x, col_z, col_w, col_d = place(L / 2 + .16, .48, .55, across)
        box_y0('Podium colonnade pier', col_x, GROUND_Y, col_z, col_w, podium_h, col_d, mat_solid, TONE_STONE, .03)


def add_rooftop_mechanical(spec, top_y, scale_w=.36, scale_d=.36, h=2.6):
    w, d = spec['w'] * scale_w, spec['d'] * scale_d
    box_y0('Rooftop mechanical penthouse', 0, top_y, 0, w, h, d, mat_solid, TONE_MECH, .05)
    # Louvered screen walls & chiller units
    for side in (-1, 1):
        box_y0('Mechanical louver screen', side * (w / 2 + .08), top_y + .3, 0, .08, h - .5, d * .82, mat_solid, TONE_DARK_METAL, .01)
    for cx in (-w * .24, w * .24):
        box_y0('Rooftop HVAC unit', cx, top_y + h, 0, w * .28, .65, d * .42, mat_solid, TONE_STONE, .02)


def add_corner_piers(w, d, y0, h, thickness=.52, tone=TONE_MULLION):
    for sx in (-1, 1):
        for sz in (-1, 1):
            box_y0('Corner structural pier', sx * (w / 2), y0, sz * (d / 2), thickness, h, thickness, mat_solid, tone, .03)


def build_chamfered_tower(spec):
    # district-1: 96m West Flagship Tower — stone podium, 3-tier setback glass shaft, chamfered corner piers, double lit crown
    w, d, h, tone = spec['w'], spec['d'], spec['h'], spec['tone']
    podium_top = FLOOR * 2.2
    mid_split = h * .62
    crown_base = h - FLOOR * 2.5

    box_y0('Podium base', 0, GROUND_Y, 0, w + 3.0, podium_top - GROUND_Y, d + 3.0, mat_facade, TONE_PODIUM, .08)
    box_y0('Podium cornice band', 0, podium_top - .35, 0, w + 3.3, .55, d + 3.3, mat_crown, TONE_WARM_CROWN, 0)
    add_podium_portal(spec, podium_top - GROUND_Y, portal_w=8.4, canopy_proj=1.8)

    # Lower & mid tower shaft
    box_y0('Lower curtain shaft', 0, podium_top, 0, w, mid_split - podium_top, d, mat_facade, tone, .08)
    add_corner_piers(w, d, podium_top, mid_split - podium_top, .55, TONE_MULLION)
    # Sky-lobby refuge floor reveal at mid_split
    box_y0('Refuge floor recessed core', 0, mid_split - .2, 0, w - 1.2, 1.4, d - 1.2, mat_solid, TONE_DARK_METAL, .04)
    box_y0('Refuge floor light band', 0, mid_split + .2, 0, w + .28, .65, d + .28, mat_crown, TONE_COOL_CROWN, 0)

    # Upper shaft with subtle taper
    uw, ud = w * .90, d * .90
    box_y0('Upper curtain shaft', 0, mid_split + 1.0, 0, uw, crown_base - (mid_split + 1.0), ud, mat_facade, tone, .08)
    add_corner_piers(uw, ud, mid_split + 1.0, crown_base - (mid_split + 1.0), .48, TONE_MULLION)
    # Vertical centerpiece mullion fins on all 4 faces
    for side in (-1, 1):
        box_y0('East-west vertical spine fin', side * (uw / 2 + .18), podium_top, 0, .32, crown_base - podium_top, .42, mat_solid, TONE_STONE, .02)
        box_y0('North-south vertical spine fin', 0, podium_top, side * (ud / 2 + .18), .42, crown_base - podium_top, .32, mat_solid, TONE_STONE, .02)

    # Crown lantern
    cw, cd = w * .76, d * .76
    box_y0('Crown lantern glazing', 0, crown_base, 0, cw, h - crown_base, cd, mat_facade, tone, .06)
    box_y0('Crown lower collar', 0, crown_base - .3, 0, uw + .3, .65, ud + .3, mat_crown, TONE_COOL_CROWN, 0)
    box_y0('Crown upper collar', 0, h - .55, 0, cw + .3, .7, cd + .3, mat_crown, TONE_WARM_CROWN, 0)
    # Architectural crown portal frame
    for sx in (-1, 1):
        box_y0('Crown frame fin X', sx * (cw / 2 + .12), crown_base, 0, .28, h - crown_base + 1.2, cd + .24, mat_solid, TONE_STONE, .02)
    add_rooftop_mechanical(spec, h, .32, .32, 2.4)


def build_twin_core_tower(spec):
    # district-9: 112m East Flagship Tower — articulated twin-volume high-rise with central sky-atrium reveal & sculptural crown
    w, d, h, tone = spec['w'], spec['d'], spec['h'], spec['tone']
    podium_top = FLOOR * 2.2
    crown_base = h - FLOOR * 2.8

    box_y0('Podium base', 0, GROUND_Y, 0, w + 3.0, podium_top - GROUND_Y, d + 3.0, mat_facade, TONE_PODIUM, .08)
    box_y0('Podium warm light reveal', 0, podium_top - .4, 0, w + 3.25, .65, d + 3.25, mat_crown, TONE_WARM_CROWN, 0)
    add_podium_portal(spec, podium_top - GROUND_Y, portal_w=8.8, canopy_proj=1.8)

    # Twin articulated shafts separated by a recessed vertical atrium slot
    lobe_d = d * .44
    for sz in (-1, 1):
        z_center = sz * (d * .27)
        box_y0('Twin tower lobe', 0, podium_top, z_center, w, crown_base - podium_top, lobe_d, mat_facade, tone, .07)
        add_corner_piers(w, lobe_d, podium_top, crown_base - podium_top - .1, .45, TONE_MULLION)
    # Recessed glass atrium connector core
    box_y0('Atrium connector core', 0, podium_top, 0, w * .84, crown_base - podium_top, d * .22, mat_facade, '88a1b0', .04)
    # Skybridge mechanical bands every 7 floors across the atrium slot
    for level_y in (podium_top + FLOOR * 6, podium_top + FLOOR * 13, podium_top + FLOOR * 20):
        if level_y < crown_base - 4:
            box_y0('Skybridge spandrel band', 0, level_y, 0, w + .24, .55, d + .2, mat_solid, TONE_STONE, .02)
            box_y0('Skybridge accent glow', 0, level_y + .6, 0, w * .88, .45, d * .32, mat_crown, TONE_COOL_CROWN, 0)

    # Stepped sculptural crown
    cw, cd = w * .80, d * .78
    box_y0('Crown lantern', 0, crown_base, 0, cw, h - crown_base, cd, mat_facade, tone, .06)
    box_y0('Crown base light ring', 0, crown_base - .35, 0, w + .28, .68, d + .25, mat_crown, TONE_COOL_CROWN, 0)
    box_y0('Crown top light ring', 0, h - .55, 0, cw + .25, .7, cd + .25, mat_crown, TONE_WARM_CROWN, 0)
    add_rooftop_mechanical(spec, h, .34, .34, 2.5)


def build_sky_atrium_tower(spec):
    # district-3 (74m) & district-11 (82m): Sleek corporate tower with notched sky-garden terrace & vertical pilaster grid
    w, d, h, tone = spec['w'], spec['d'], spec['h'], spec['tone']
    podium_top = FLOOR * 2.0
    sky_notch = h * .56
    crown_base = h - FLOOR * 2.0

    box_y0('Podium base', 0, GROUND_Y, 0, w + 2.8, podium_top - GROUND_Y, d + 2.8, mat_facade, TONE_PODIUM, .07)
    box_y0('Podium light band', 0, podium_top - .35, 0, w + 3.0, .6, d + 3.0, mat_crown, TONE_WARM_CROWN, 0)
    add_podium_portal(spec, podium_top - GROUND_Y, portal_w=7.0, canopy_proj=1.5)

    # Lower shaft
    box_y0('Lower tower shaft', 0, podium_top, 0, w, sky_notch - podium_top, d, mat_facade, tone, .07)
    add_corner_piers(w, d, podium_top, sky_notch - podium_top, .46, TONE_MULLION)

    # Sky-garden notch at 56% height facing HQ
    L, A, place = front_frame(spec)
    ux, uz, uw, ud = place(-L * .08, L * .84, A, 0)
    box_y0('Upper setback shaft', ux, sky_notch, uz, uw, crown_base - sky_notch, ud, mat_facade, tone, .07)
    tx, tz, tw, td = place(L * .40, L * .18, A - 1.2, 0)
    box_y0('Sky terrace planter deck', tx, sky_notch, tz, tw, .32, td, mat_solid, TONE_TERRACE_1, .02)
    rx, rz, rw, rd = place(L * .48, .10, A - .8, 0)
    box_y0('Sky terrace balustrade', rx, sky_notch + .32, rz, rw, 1.05, rd, mat_solid, TONE_BALUSTRADE, .01)
    box_y0('Sky terrace warm soffit', 0, sky_notch - .35, 0, w + .22, .6, d + .22, mat_crown, TONE_WARM_CROWN, 0)
    for across in (-A * .28, 0, A * .28):
        fx, fz, _, _ = place(L * .40, 0, 0, across)
        foliage_at(fx, sky_notch + 1.15, fz, 1.1, TONE_TERRACE_2)

    # Crown
    cw, cd = w * .78, d * .78
    box_y0('Crown shaft', ux, crown_base, uz, cw, h - crown_base, cd, mat_facade, tone, .06)
    box_y0('Crown collar', ux, crown_base - .3, uz, uw + .24, .62, ud + .24, mat_crown, TONE_COOL_CROWN, 0)
    box_y0('Crown top band', ux, h - .5, uz, cw + .2, .68, cd + .2, mat_crown, TONE_WARM_CROWN, 0)
    add_rooftop_mechanical(spec, h, .32, .32, 2.2)


def build_finned_office(spec):
    # district-0 (42m), district-6 (26m), district-10 (50m): Architectural brise-soleil office building with deep mullion fins & horizontal spandrel shelves
    w, d, h, tone = spec['w'], spec['d'], spec['h'], spec['tone']
    L, A, place = front_frame(spec)
    podium_top = FLOOR * 1.4

    box_y0('Recessed stone podium', 0, GROUND_Y, 0, w - 1.0, podium_top - GROUND_Y, d - 1.0, mat_facade, TONE_PODIUM, .06)
    add_podium_portal(spec, podium_top - GROUND_Y, portal_w=6.4, canopy_proj=1.4)
    box_y0('Main glazed office mass', 0, podium_top, 0, w, h - podium_top, d, mat_facade, tone, .07)

    # Deep vertical architectural sun-shading fins on front & back facades
    count = max(4, int(round(A / 2.3)))
    fin_tone = TONE_LIMESTONE if spec['arch'] == 'colonade-fins' else TONE_STONE
    for i in range(count):
        across = -A / 2 + (i + .5) * (A / count)
        for side in (1, -1):
            fx, fz, fw, fd = place(side * (L / 2 + .28), .58, .22, across)
            box_y0('Vertical sun-shading fin', fx, podium_top, fz, fw, h - podium_top + .55, fd, mat_solid, fin_tone, .02)

    # Horizontal sun-shelf spandrels & flank reveals every 2 floors
    step_h = FLOOR * 2
    y = podium_top + step_h
    while y < h - 1.0:
        for side in (1, -1):
            rx, rz, rw, rd = place(0, L * .95, .16, side * (A / 2 + .08))
            box_y0('Flank spandrel reveal', rx, y, rz, rw, .32, rd, mat_solid, TONE_MULLION, .01)
            sx, sz, sw, sd = place(side * (L / 2 + .24), .48, A + .16, 0)
            box_y0('Horizontal brise-soleil shelf', sx, y, sz, sw, .18, sd, mat_solid, fin_tone, .01)
        y += step_h

    # Roof garden & illuminated parapet cornice
    rx, rz, rw, rd = place(0, L - 1.6, A - 1.6, 0)
    box_y0('Roof garden turf bed', rx, h, rz, rw, .26, rd, mat_solid, TONE_TERRACE_2, .02)
    box_y0('Parapet coping rim', 0, h - .5, 0, w + .32, .68, d + .32, mat_crown, TONE_COOL_CROWN, 0)
    add_rooftop_mechanical(spec, h, .30, .30, 2.3)
    for across in (-A * .28, A * .28):
        tx, tz, _, _ = place(0, 0, 0, across)
        foliage_at(tx, h + 1.0, tz, 1.05, TONE_TERRACE_1)


def build_terraced_office(spec):
    # district-2 (58m) & district-4 (40m): Cascading corporate headquarters stepping down toward HQ with planted sky-terraces & glass balustrades
    w, d, h, tone = spec['w'], spec['d'], spec['h'], spec['tone']
    L, A, place = front_frame(spec)
    spans = (.46, .30, .24)
    depths = (1.0, .70, .44)
    total = h - GROUND_Y
    y = GROUND_Y

    add_podium_portal(spec, FLOOR * 2.0, portal_w=6.8, canopy_proj=1.5)

    for i, span in enumerate(spans):
        length = L * depths[i]
        th = total * span
        centre = -(L - length) / 2
        bx, bz, bw, bd = place(centre, length, A, 0)
        box_y0(f'Stepped tier {i+1} facade', bx, y, bz, bw, th, bd, mat_facade, tone, .07)
        # Vertical mullion pilasters along the flank walls of each tier
        for side in (-1, 1):
            for k in (-1, 0, 1):
                px, pz, pw, pd = place(centre + k * (length * .28), .34, .22, side * (A / 2 + .08))
                box_y0('Tier flank pilaster', px, y, pz, pw, th, pd, mat_solid, TONE_MULLION, .01)
        y += th
        box_y0(f'Tier {i+1} warm cornice light', bx, y - .55, bz, bw + .24, .68, bd + .24, mat_crown, TONE_WARM_CROWN, 0)

        if i + 1 < len(depths):
            next_depth = depths[i + 1]
            strip = length - L * next_depth
            front = centre + length / 2
            tx, tz, tw, td = place(front - strip / 2, strip - .35, A - .8, 0)
            box_y0('Planted terrace deck', tx, y, tz, tw, .26, td, mat_solid, TONE_TERRACE_1 if i % 2 == 0 else TONE_TERRACE_2, .02)
            # Stone planter boxes & glass balustrade along terrace edge
            rx, rz, rw, rd = place(front - .1, .08, A - .4, 0)
            box_y0('Terrace glass balustrade', rx, y + .22, rz, rw, 1.0, rd, mat_solid, TONE_BALUSTRADE, .01)
            for across in (-A / 3, 0, A / 3):
                sx, sz, sw, sd = place(front - strip / 2, 1.4, 1.4, across)
                box_y0('Terrace stone planter', sx, y + .22, sz, sw, .35, sd, mat_solid, TONE_LIMESTONE, .02)
                foliage_at(sx, y + 1.35, sz, 1.22, TONE_TERRACE_2 if i % 2 == 0 else TONE_TERRACE_1)

    cx, cz, cw, cd = place(-(L - L * depths[2]) / 2, L * depths[2] * .5, A * .42, 0)
    box_y0('Terraced rooftop mechanical', cx, y, cz, cw, 2.2, cd, mat_solid, TONE_MECH, .04)


def build_residential_slab(spec):
    # district-5 (30m), district-7 (24m), district-8 (36m): Contemporary residential mid-rise with rhythmic cantilevered balconies, warm wood soffits, party-wall fins & rooftop pergola
    w, d, h, tone = spec['w'], spec['d'], spec['h'], spec['tone']
    L, A, place = front_frame(spec)
    podium_top = FLOOR * 1.3

    box_y0('Residential stone podium', 0, GROUND_Y, 0, w, podium_top - GROUND_Y, d, mat_facade, TONE_PODIUM, .06)
    add_podium_portal(spec, podium_top - GROUND_Y, portal_w=5.8, canopy_proj=1.3)
    box_y0('Residential main facade', 0, podium_top, 0, w, h - podium_top, d, mat_facade, tone, .07)

    # Cantilevered balcony slabs with warm timber undersides and glass balustrades
    y = FLOOR
    floor_idx = 0
    while y < h - 1.0:
        # Alternate split-bay and full-width balconies for architectural rhythm
        if floor_idx % 2 == 0 or spec['arch'] == 'cantilever-residences':
            sx, sz, sw, sd = place(L / 2 + .68, 1.38, A * .86, 0)
            box_y0('Balcony concrete deck', sx, y - .09, sz, sw, .18, sd, mat_solid, TONE_LIMESTONE, .02)
            box_y0('Balcony warm wood soffit', sx, y - .14, sz, sw - .08, .05, sd - .08, mat_solid, TONE_WOOD, .01)
            rx, rz, rw, rd = place(L / 2 + 1.34, .06, A * .86, 0)
            box_y0('Balcony glass railing', rx, y + .09, rz, rw, .95, rd, mat_solid, TONE_BALUSTRADE, .01)
        else:
            for bay in (-1, 1):
                sx, sz, sw, sd = place(L / 2 + .68, 1.38, A * .38, bay * (A * .24))
                box_y0('Split balcony deck', sx, y - .09, sz, sw, .18, sd, mat_solid, TONE_LIMESTONE, .02)
                rx, rz, rw, rd = place(L / 2 + 1.34, .06, A * .38, bay * (A * .24))
                box_y0('Split balcony railing', rx, y + .09, rz, rw, .95, rd, mat_solid, TONE_BALUSTRADE, .01)
        y += FLOOR
        floor_idx += 1

    # Vertical party-wall privacy fins
    for offset in (-A * .43, -A * .14, A * .14, A * .43):
        fx, fz, fw, fd = place(L / 2 + .68, 1.4, .22, offset)
        box_y0('Party-wall privacy fin', fx, FLOOR - .2, fz, fw, h - FLOOR, fd, mat_solid, TONE_LIMESTONE, .02)

    # Rooftop garden terrace & architectural pergola frame
    rx, rz, rw, rd = place(0, L * .64, A * .66, 0)
    box_y0('Rooftop garden lawn', rx, h, rz, rw, .24, rd, mat_solid, TONE_TERRACE_1, .02)
    # Pergola columns & overhead louver beams
    for px_off in (-L * .26, L * .26):
        for pz_off in (-A * .26, A * .26):
            cx, cz, cw, cd = place(px_off, .24, .24, pz_off)
            box_y0('Rooftop pergola post', cx, h + .24, cz, cw, 2.2, cd, mat_solid, TONE_MULLION, .01)
    box_y0('Rooftop pergola canopy frame', rx, h + 2.4, rz, rw, .18, rd, mat_solid, TONE_MULLION, .02)
    box_y0('Residential crown warm band', 0, h - .45, 0, w + .22, .65, d + .22, mat_crown, TONE_WARM_CROWN, 0)
    for across in (-A * .22, A * .22):
        tx, tz, _, _ = place(0, 0, 0, across)
        foliage_at(tx, h + 1.05, tz, 1.05, TONE_TERRACE_2)


def add_curtain_wall_reveals(spec):
    """Physical depth on the two overview-facing elevations; far city stays shader-only.

    The glass mass is the recessed back of a curtain wall. Thin projecting metal
    mullions and transoms supply real silhouettes and grazing-light relief rather
    than tessellating every pane. Bay coordinates match the live world-space
    3.1 m / 3.6 m window shader, including each building's district translation.
    """
    for center, size in glazed_masses[active.name]:
        x, y, z = center
        w, h, d = size
        bottom, top = y - h / 2, y + h / 2
        for axis in ('x', 'z'):
            along, span = (z, d) if axis == 'x' else (x, w)
            world_offset = spec['z'] if axis == 'x' else spec['x']
            first = math.ceil((along - span / 2 + world_offset) / 3.1)
            last = math.floor((along + span / 2 + world_offset) / 3.1)
            for bay in range(first, last + 1):
                local = bay * 3.1 - world_offset
                if axis == 'x':
                    position, dimensions = (x - w / 2 - .08, y, local), (.22, h, .10)
                else:
                    position, dimensions = (local, y, z - d / 2 - .08), (.10, h, .22)
                box_at('Raised curtain-wall mullion', position, dimensions, mat_solid, TONE_MULLION, 0)
                detail_counts[active.name]['mullions'] += 1
            first_floor = math.ceil((bottom - GROUND_Y + .2) / FLOOR)
            last_floor = math.floor((top - GROUND_Y - .2) / FLOOR)
            for floor in range(first_floor, last_floor + 1):
                level = GROUND_Y + floor * FLOOR
                if axis == 'x':
                    position, dimensions = (x - w / 2 - .08, level, z), (.22, .12, d)
                else:
                    position, dimensions = (x, level, z - d / 2 - .08), (w, .12, .22)
                box_at('Recessed-window transom', position, dimensions, mat_solid, TONE_MULLION, 0)
                detail_counts[active.name]['transoms'] += 1


for spec in DISTRICT_BUILDINGS:
    group(spec)
    arch = spec['arch']
    if arch == 'chamfered-tower':
        build_chamfered_tower(spec)
    elif arch == 'twin-core-tower':
        build_twin_core_tower(spec)
    elif arch in ('sky-atrium-tower', 'tapered-crown-tower'):
        build_sky_atrium_tower(spec)
    elif spec['kind'] == 'fins':
        build_finned_office(spec)
    elif spec['kind'] == 'stepped':
        build_terraced_office(spec)
    else:
        build_residential_slab(spec)
    add_curtain_wall_reveals(spec)

manifest = {}
for name, root in roots.items():
    merge_root(root)
    bpy.context.view_layer.update()
    corners = [child.matrix_world @ Vector(c) for child in root.children for c in child.bound_box]
    app = [(c.x, c.z, -c.y) for c in corners]
    mins = [min(c[i] for c in app) for i in range(3)]
    maxs = [max(c[i] for c in app) for i in range(3)]
    triangles = sum(len(poly.vertices) - 2 for child in root.children for poly in child.data.polygons)
    manifest[name] = {
        'origin': [0, 0, 0],
        'min': mins,
        'max': maxs,
        'size': [maxs[i] - mins[i] for i in range(3)],
        'triangles': triangles,
        'meshes': len(root.children),
        'materials': [c.data.materials[0].name for c in root.children],
        'facade_detail': detail_counts[name],
        'detailed_elevations': ['west', 'south'],
    }

triangles = sum(g['triangles'] for g in manifest.values())
if triangles > 35000:
    raise RuntimeError('District buildings triangle budget exceeded: ' + str(triangles))

bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.gltf(
    filepath=os.path.join(args.output, 'district-buildings.glb'),
    export_format='GLB',
    use_selection=True,
    export_yup=True,
    export_materials='EXPORT',
    export_extras=True,
    export_cameras=False,
    export_lights=False,
)
with open(os.path.join(args.output, 'district-buildings.manifest.json'), 'w') as output:
    json.dump(
        {
            'buildings': DISTRICT_BUILDINGS,
            'groups': manifest,
            'triangles': triangles,
            'meshes': sum(g['meshes'] for g in manifest.values()),
        },
        output,
        indent=2,
    )

# Place buildings at their actual campus coordinates in the saved .blend file for inspection
for spec in DISTRICT_BUILDINGS:
    roots[spec['id']].location = point((spec['x'], 0, spec['z']))
scene['export_origin_note'] = 'GLB is zero anchored; blend places district buildings at their campus world coordinates.'
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(args.output, 'district-buildings.blend'))
print('DISTRICT_LIBRARY ' + json.dumps({'roots': list(roots), 'triangles': triangles, 'meshes': sum(g['meshes'] for g in manifest.values())}))

if args.preview:
    # A compact architectural lineup makes the actual exported surfaces easy to
    # inspect without the main Office renderer, and does not enter the GLB.
    for index, spec in enumerate(DISTRICT_BUILDINGS):
        roots[spec['id']].location = point((((index % 4) - 1.5) * 42, 0, (index // 4) * 42))
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 24
    scene.render.resolution_x = 1600
    scene.render.resolution_y = 1200
    scene.render.resolution_percentage = 100
    scene.world = bpy.data.worlds.new('District preview sky')
    scene.world.use_nodes = True
    scene.world.node_tree.nodes['Background'].inputs[0].default_value = (.40, .50, .62, 1)
    scene.world.node_tree.nodes['Background'].inputs[1].default_value = .65
    bpy.ops.object.light_add(type='SUN', location=(-60, 80, 150))
    bpy.context.object.rotation_euler = (math.radians(28), math.radians(-25), math.radians(-30))
    bpy.context.object.data.energy = 3
    bpy.ops.object.camera_add(location=point((-175, 165, -170)))
    camera = bpy.context.object
    camera.rotation_euler = (Vector(point((0, 42, 36))) - camera.location).to_track_quat('-Z', 'Y').to_euler()
    camera.data.type = 'ORTHO'
    camera.data.ortho_scale = 265
    scene.camera = camera
    scene.render.filepath = args.preview
    bpy.ops.render.render(write_still=True)
