"""Build the local exterior campus library in Blender; app X/Y/Z = Blender X/Z/-Y.

Blender --factory-startup --background --python tooling/blender/create-exterior-assets.py -- --output <directory> --preview <png>
All exported groups use contract origins. The saved blend arranges the same groups for inspection.
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


def mat(name, color, roughness=.6, metal=0):
    rgb = tuple(int(color[i:i+2], 16) / 255 for i in (0, 2, 4))
    rgb = tuple(c / 12.92 if c <= .04045 else ((c + .055) / 1.055) ** 2.4 for c in rgb)
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*rgb, 1)
    m.use_nodes = True
    node = m.node_tree.nodes.get('Principled BSDF')
    node.inputs['Base Color'].default_value = (*rgb, 1)
    node.inputs['Roughness'].default_value = roughness
    node.inputs['Metallic'].default_value = metal
    return m


# Botanical & architectural landscape palette
bark_dark = mat('Botanical dark bark', '584636', .94)
bark_warm = mat('Botanical warm bark', '78624e', .92)
bark_cherry = mat('Botanical cherry bark', '4f3a34', .90)
canopy_shadow = mat('Botanical shadow canopy', '2b4d2c', .94)
canopy_deep = mat('Botanical deep canopy', '3b6938', .92)
canopy_mid = mat('Botanical mid canopy', '4f8245', .9)
canopy_olive = mat('Botanical olive canopy', '669952', .88)
canopy_sun = mat('Botanical sunlit canopy', '84ba5e', .86)
pine_deep = mat('Cypress deep needle', '264a32', .92)
pine_mid = mat('Cypress mid needle', '366342', .90)
pine_tip = mat('Cypress sunlit tip', '4d8255', .88)
ornamental_sage = mat('Ornamental sage leaf', '6f9462', .9)
ornamental_mint = mat('Ornamental light sage', '8fb37c', .88)
maple_copper = mat('Ornamental copper leaf', '9c473e', .86)
maple_amber = mat('Ornamental amber leaf', 'c96f44', .84)
blossom_deep = mat('Sakura deep magenta', 'cf5f84', .78)
blossom_rose = mat('Botanical soft rose', 'ee9ab4', .76)
blossom_blush = mat('Sakura blush petal', 'f8c8d8', .74)
blossom_cream = mat('Botanical cream blossom', 'fbf3eb', .74)
flower_gold = mat('Botanical golden stamen', 'f2bd3a', .72)
flower_blue = mat('Hydrangea sky blue', '5d9ee6', .78)
flower_coral = mat('Garden coral rose', 'eb6b5e', .76)
flower_crimson = mat('Garden crimson rose', 'c9384d', .78)
tropical_emerald = mat('Tropical monstera emerald', '2d6134', .76)
tropical_fern = mat('Botanical sword fern', '5b9644', .84)
agave_blue = mat('Architectural blue agave', '5c8c84', .80)
water_teal = mat('Reflection pond water', '357f94', .14, .22)
water_foam = mat('Waterfall cascade foam', 'e2f2f7', .45)
koi_orange = mat('Ornamental koi orange', 'eb5a36', .35)
shrub_deep = mat('Garden shrub deep green', '3f663c', .92)
shrub_light = mat('Garden shrub light green', '6c965c', .9)
lavender_foliage = mat('Lavender silvery foliage', '64825e', .92)
lavender_deep = mat('Lavender deep violet', '7e52b8', .82)
lavender_soft = mat('Lavender soft lilac', 'ae84db', .8)

stone_light = mat('Limestone planter cladding', 'c2c7c3', .82)
stone_coping = mat('Honed limestone coping', 'd4d8d3', .74)
stone_plinth = mat('Architectural grey plinth', '94a2b3', .84)
soil_mulch = mat('Organic dark bark mulch', '3e372e', .98)
pebble_grey = mat('River pebble stone', '9fa39a', .86)

oak_honey = mat('Exterior honey oak slat', 'b58b5d', .72)
oak_warm = mat('Exterior warm teak slat', 'a67b4e', .74)
alloy_silver = mat('Brushed cast aluminium', '96a0a4', .34, .68)
steel_charcoal = mat('Powdercoated charcoal steel', '2b333b', .42, .52)
steel_slate = mat('Architectural slate metal', '43525b', .38, .55)
bistro_top = mat('Warm stone table top', 'e3e0d6', .56)
canopy_canvas = mat('Exterior parasol canvas', 'e6e1d3', .86)

# Additional architectural, luminaire, cafe & mobility palette
lamp_diffuser = mat('Exterior lamp diffuser', 'fff3d6', .38)
lamp_diffuser.node_tree.nodes['Principled BSDF'].inputs['Emission Color'].default_value = (1.0, .78, .44, 1.0)
lamp_diffuser.node_tree.nodes['Principled BSDF'].inputs['Emission Strength'].default_value = .35

bike_paint = mat('Bicycle frame paint', '3f6f7a', .40, .38)
rubber_tire = mat('Bicycle vulcanised tire', '22282b', .88)
ceramic_white = mat('Cafe glazed ceramic', 'f5f4ee', .32)
terracotta_pot = mat('Sculpted terracotta clay', 'ba785c', .68)
pastry_gold = mat('Artisanal golden pastry', 'd49b54', .64)
brass_accent = mat('Brushed architectural brass', 'c5a15a', .36, .72)
glass_case = mat('Cafe display glass', 'dce6ea', .22, .12)

roots = {}
active = None


def point(p):
    return (p[0], -p[2], p[1])


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


def group(name):
    global active
    if active is not None:
        merge_root(active)
    print('EXTERIOR_PART ' + name, flush=True)
    active = bpy.data.objects.new(name, None)
    scene.collection.objects.link(active)
    active['exterior_part'] = name
    roots[name] = active
    return active


def finish(obj, name, material, bevel=0, smooth=True):
    obj.name = name
    obj.data.materials.append(material)
    bpy.context.view_layer.objects.active = obj
    if bevel:
        modifier = obj.modifiers.new('Rounded manufactured edges', 'BEVEL')
        modifier.width = bevel
        modifier.segments = 1 if min(obj.dimensions) < .03 else 2
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    for polygon in obj.data.polygons:
        polygon.use_smooth = smooth
    if smooth:
        modifier = obj.modifiers.new('Weighted corner normals', 'WEIGHTED_NORMAL')
        modifier.keep_sharp = True
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    obj.parent = active
    return obj


def box(name, center, size, material, bevel=.004, rot_y=0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=point(center))
    obj = bpy.context.object
    obj.dimensions = (size[0], size[2], size[1])
    if rot_y:
        obj.rotation_euler = (0, 0, rot_y)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    return finish(obj, name, material, min(bevel, min(size) * .42))


def cylinder(name, center, radius, height, material, radius_top=None, sides=18, bevel=.002):
    bpy.ops.mesh.primitive_cone_add(
        vertices=sides,
        radius1=radius,
        radius2=radius if radius_top is None else radius_top,
        depth=height,
        location=point(center),
    )
    return finish(bpy.context.object, name, material, min(bevel, height / 6, radius / 6))


def rod(name, start, end, radius, material, radius_end=None, sides=10):
    a, b = Vector(point(start)), Vector(point(end))
    bpy.ops.mesh.primitive_cone_add(
        vertices=sides,
        radius1=radius,
        radius2=radius if radius_end is None else radius_end,
        depth=(b - a).length,
        location=(a + b) / 2,
    )
    obj = bpy.context.object
    obj.rotation_mode = 'QUATERNION'
    obj.rotation_quaternion = (b - a).to_track_quat('Z', 'Y')
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    return finish(obj, name, material, 0)


def foliage_blob(name, center, radii, material, subdivisions=2, rot=(0, 0, 0), smooth=False):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=subdivisions, radius=1, location=point(center))
    obj = bpy.context.object
    obj.scale = (radii[0], radii[2], radii[1])
    obj.rotation_euler = rot
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    return finish(obj, name, material, 0, smooth=smooth)


def foliage_pad(name, center, radii, material, seed=0.0, rot=(0, 0, 0), subdivisions=2):
    """Organically lobed foliar bough cushion with umbrella dome top and cupped underside."""
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=subdivisions, radius=1, location=(0, 0, 0))
    obj = bpy.context.object
    for v in obj.data.vertices:
        vx, vy, vz = v.co.x, v.co.y, v.co.z
        if vz < 0:
            vz *= .52
        lobe = (
            .20 * math.sin(vx * 4.3 + seed) * math.cos(vy * 4.1 - seed * .7)
            + .15 * math.cos((vx - vy) * 6.2 + vz * 3.9 + seed * 1.4)
            + .11 * math.sin(vz * 6.8 + vx * 4.9 - seed)
        )
        v.co.x = vx * radii[0] * (1.0 + lobe)
        v.co.y = vy * radii[2] * (1.0 + lobe)
        v.co.z = vz * radii[1] * (1.0 + lobe * .85)
    obj.rotation_euler = rot
    obj.location = point(center)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    return finish(obj, name, material, 0, smooth=True)


def leaf_blade(name, center, length, width, material, yaw=0.0, pitch=.35, roll=0.0):
    """Single sculpted pointed botanical leaf blade."""
    bpy.ops.mesh.primitive_cone_add(vertices=5, radius1=width, radius2=.01, depth=length, location=(0, 0, 0))
    obj = bpy.context.object
    obj.scale = (1.0, .22, 1.0)
    for v in obj.data.vertices:
        v.co.z += length * .35
    obj.rotation_euler = (pitch, roll, yaw)
    obj.location = point(center)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    return finish(obj, name, material, 0, smooth=False)


def leaf_fan(name, center, scale, material, yaw=0.0, blades=5, pitch_base=.42):
    """Radial rosette of pointed leaf blades that breaks up canopy silhouettes into visible leaves."""
    for i in range(blades):
        a = yaw + i * (math.tau / blades) + (i % 2) * .18
        pitch = pitch_base + (i % 3) * .14
        leaf_blade(
            name,
            (center[0] + math.cos(a) * scale * .18, center[1] + (i % 2) * .03, center[2] + math.sin(a) * scale * .18),
            scale * .58,
            scale * .24,
            material,
            yaw=-a + math.pi / 2,
            pitch=pitch,
        )


def leafy_bough(name, center, radii, shadow_mat, mid_mat, sun_mat, seed=0.0, fans=7):
    """Layered botanical tree bough: shadow underside + undulating mid pad + sunlit crest + outer leaf fans."""
    rx, ry, rz = radii
    foliage_pad(name + ' shadow', (center[0], center[1] - ry * .22, center[2]), (rx * .92, ry * .68, rz * .92), shadow_mat, seed + 1.1, subdivisions=1)
    foliage_pad(name + ' mid', center, (rx, ry, rz), mid_mat, seed, subdivisions=2)
    foliage_pad(name + ' crest', (center[0] + math.cos(seed) * rx * .12, center[1] + ry * .34, center[2] + math.sin(seed) * rz * .12), (rx * .74, ry * .62, rz * .74), sun_mat, seed + 2.3, subdivisions=2)
    for i in range(fans):
        a = seed + i * (math.tau / fans)
        dist = .62 + (i % 3) * .14
        fx = center[0] + math.cos(a) * rx * dist
        fz = center[2] + math.sin(a) * rz * dist
        fy = center[1] + ((i % 3) - .8) * ry * .28
        mat_choice = sun_mat if i % 2 == 0 else mid_mat
        leaf_fan(name + ' leaf fan', (fx, fy, fz), min(rx, rz) * .48, mat_choice, yaw=a, blades=4, pitch_base=.48)


def flower_cluster(name, center, scale, petal_mat, core_mat, petals=5):
    """Cupped multi-petal blossom rosette with golden stamen core."""
    foliage_blob(name + ' core', (center[0], center[1] + scale * .12, center[2]), (scale * .32, scale * .24, scale * .32), core_mat, subdivisions=1, smooth=False)
    for i in range(petals):
        a = i * (math.tau / petals)
        px = center[0] + math.cos(a) * scale * .48
        pz = center[2] + math.sin(a) * scale * .48
        foliage_blob(name + ' petal', (px, center[1] + scale * .06, pz), (scale * .42, scale * .18, scale * .34), petal_mat, subdivisions=1, rot=(.25, a, 0), smooth=False)


def fern_clump(name, center, fronds=10, radius=.55, height=.42, material=tropical_fern):
    """Radiating sword-fern clump with arching compound fronds."""
    for i in range(fronds):
        a = i * (math.tau / fronds) + (i % 2) * .14
        r = radius * (.78 + (i % 3) * .12)
        h = height * (.75 + (i % 2) * .22)
        mid = (center[0] + math.cos(a) * r * .52, center[1] + h, center[2] + math.sin(a) * r * .52)
        tip = (center[0] + math.cos(a) * r, center[1] + h * .45, center[2] + math.sin(a) * r)
        rod(name + ' rachis', (center[0], center[1] + .04, center[2]), mid, .014, material, .009, sides=5)
        leaf_blade(name + ' frond lower', mid, r * .62, .11, material, yaw=-a + math.pi / 2, pitch=1.05)
        leaf_blade(name + ' frond tip', tip, r * .48, .085, material, yaw=-a + math.pi / 2, pitch=1.32)


# 1. EXTERIOR SHADE TREE: sculpted buttress roots, multi-forked trunk, 14 limbs & layered leafy boughs
group('exterior-shade-tree')
cylinder('Tree root flare', (0, .24, 0), .32, .48, bark_dark, .21, sides=12, bevel=0)
for i in range(5):
    ra = i * (math.tau / 5) + .2
    rod('Tree buttress root', (math.cos(ra) * .14, .34, math.sin(ra) * .14), (math.cos(ra) * .42, .02, math.sin(ra) * .42), .09, bark_dark, .035, sides=7)
rod('Main trunk lower', (0, .18, 0), (.04, 1.65, -.03), .21, bark_dark, .165, sides=12)
rod('Main trunk mid', (.04, 1.58, -.03), (-.02, 2.75, .04), .165, bark_dark, .115, sides=10)
rod('Main trunk upper', (-.02, 2.68, .04), (.02, 3.65, -.02), .115, bark_warm, .072, sides=9)
branches = [
    ((.02, 1.82, 0), (-.88, 3.25, .24), .105, .052),
    ((.03, 1.96, -.02), (.86, 3.40, -.32), .102, .050),
    ((0, 2.12, .02), (.16, 3.38, .88), .094, .046),
    ((-.02, 2.24, -.02), (-.28, 3.52, -.82), .090, .044),
    ((0, 2.75, .02), (-.22, 4.45, -.10), .084, .040),
    ((-.54, 2.68, .15), (-1.28, 3.62, .46), .062, .028),
    ((.52, 2.80, -.18), (1.22, 3.76, -.52), .062, .028),
    ((.10, 2.82, .52), (.48, 3.85, 1.18), .058, .026),
    ((-.18, 2.90, -.48), (-.56, 3.88, -1.12), .058, .026),
    ((-.36, 3.25, -.12), (-.85, 4.32, -.42), .052, .024),
    ((.38, 3.32, .14), (.82, 4.38, .44), .052, .024),
]
for start, end, r0, r1 in branches:
    rod('Sculpted tree limb', start, end, r0, bark_warm, r1, sides=8)

shade_boughs = [
    ((0, 4.08, 0), (1.38, .92, 1.35), canopy_shadow, canopy_mid, canopy_sun, .4, 8),
    ((-1.08, 3.48, .28), (1.08, .76, 1.04), canopy_deep, canopy_olive, canopy_sun, 1.2, 6),
    ((1.04, 3.66, -.36), (1.10, .78, 1.06), canopy_deep, canopy_mid, canopy_sun, 2.1, 6),
    ((.22, 3.62, 1.02), (.98, .74, .96), canopy_shadow, canopy_deep, canopy_olive, 3.0, 6),
    ((-.34, 3.68, -.96), (.96, .72, .94), canopy_shadow, canopy_mid, canopy_olive, 3.9, 6),
    ((-.24, 4.86, -.10), (1.02, .78, .98), canopy_deep, canopy_olive, canopy_sun, 4.7, 7),
    ((.62, 4.44, .42), (.86, .66, .84), canopy_deep, canopy_mid, canopy_sun, 5.5, 5),
    ((-.68, 4.34, -.38), (.84, .64, .82), canopy_shadow, canopy_olive, canopy_sun, 6.2, 5),
]
for center, radii, s_mat, m_mat, h_mat, seed, fans in shade_boughs:
    leafy_bough('Shade canopy bough', center, radii, s_mat, m_mat, h_mat, seed=seed, fans=fans)
# Base root-collar fern & mossy stone vignette
fern_clump('Shade tree base fern', (.28, .02, .26), fronds=6, radius=.42, height=.28)
for i, (bx, bz, br) in enumerate([(-.34, .22, .14), (.18, -.32, .12), (-.22, -.28, .10)]):
    foliage_blob('Shade tree root stone', (bx, .06, bz), (br, br * .6, br * .85), pebble_grey if i % 2 == 0 else stone_plinth, subdivisions=1, smooth=False)


# 2. EXTERIOR ORNAMENTAL TREE: graceful 4-stem Japanese Maple / specimen tree with cloud-pruned foliage pads & blossoms
group('exterior-ornamental-tree')
cylinder('Ornamental basal flare', (0, .14, 0), .22, .28, bark_warm, .16, sides=10, bevel=0)
stems = [
    ((-.06, .08, -.03), (-.34, 1.52, .10), .082, .044),
    ((.06, .08, .02), (.32, 1.60, -.08), .078, .042),
    ((0, .10, .05), (.05, 1.82, .26), .070, .038),
    ((-.02, .10, -.05), (-.06, 1.74, -.28), .068, .036),
    ((-.22, 1.18, .06), (-.64, 1.86, .28), .046, .025),
    ((.22, 1.24, -.05), (.66, 1.92, -.24), .044, .025),
    ((.04, 1.38, .18), (.28, 2.28, .48), .042, .022),
    ((-.05, 1.34, -.18), (-.26, 2.22, -.46), .042, .022),
]
for start, end, r0, r1 in stems:
    rod('Ornamental multi-stem', start, end, r0, bark_warm, r1, sides=8)

ornamental_boughs = [
    ((0, 2.12, .04), (.88, .54, .86), shrub_deep, ornamental_sage, ornamental_mint, .5, 6),
    ((-.58, 1.82, .26), (.64, .42, .62), ornamental_sage, ornamental_mint, canopy_sun, 1.6, 5),
    ((.60, 1.88, -.22), (.62, .42, .60), shrub_deep, ornamental_sage, ornamental_mint, 2.7, 5),
    ((.22, 2.48, .32), (.58, .40, .56), ornamental_sage, maple_copper, maple_amber, 3.8, 5),
    ((-.24, 2.38, -.32), (.54, .38, .52), ornamental_sage, blossom_rose, blossom_cream, 4.9, 5),
]
for center, radii, s_mat, m_mat, h_mat, seed, fans in ornamental_boughs:
    leafy_bough('Ornamental cloud bough', center, radii, s_mat, m_mat, h_mat, seed=seed, fans=fans)
for bx, by, bz in ((-.32, 2.12, .42), (.36, 2.18, -.32), (0, 2.68, .08), (-.48, 2.02, -.18), (.44, 2.34, .28)):
    flower_cluster('Ornamental specimen blossom', (bx, by, bz), .14, blossom_cream, flower_gold, petals=5)


# 3. EXTERIOR SHRUB: lush multi-layered flowering garden bush with pointed leaf fans & camellia blooms
group('exterior-shrub')
shrub_mounds = [
    ((0, .06, 0), (.48, .38, .48), shrub_deep, .2),
    ((-.24, .02, .18), (.36, .30, .36), shrub_light, 1.4),
    ((.26, .03, -.16), (.38, .31, .36), canopy_mid, 2.5),
    ((.14, .16, .20), (.32, .26, .32), ornamental_mint, 3.7),
    ((-.18, .14, -.20), (.30, .25, .30), canopy_olive, 4.8),
]
for center, radii, material, seed in shrub_mounds:
    foliage_pad('Sculpted shrub mound', center, radii, material, seed=seed, subdivisions=2)
for i in range(10):
    a = i * (math.tau / 10)
    r = .36 + (i % 2) * .08
    leaf_fan('Shrub perimeter leaves', (math.cos(a) * r, .12 + (i % 3) * .06, math.sin(a) * r), .26, canopy_sun if i % 2 == 0 else shrub_light, yaw=a, blades=4)
for i in range(6):
    a = i * (math.tau / 6) + .35
    r = .22 + (i % 2) * .12
    flower_cluster('Shrub camellia bloom', (math.cos(a) * r, .28 + (i % 2) * .06, math.sin(a) * r), .085, blossom_cream if i % 2 == 0 else blossom_rose, flower_gold, petals=5)


# 4. EXTERIOR LAVENDER: silvery-sage foliage mound with 20 radiating stems, tiered violet spikes & companion blooms
group('exterior-lavender')
foliage_pad('Lavender basal cushion', (0, .12, 0), (.36, .20, .36), lavender_foliage, seed=.8, subdivisions=2)
foliage_pad('Lavender inner tuft', (.05, .16, -.04), (.26, .18, .26), ornamental_sage, seed=2.1, subdivisions=1)
for i in range(8):
    a = i * (math.tau / 8)
    leaf_blade('Lavender basal leaf', (math.cos(a) * .22, .08, math.sin(a) * .22), .22, .055, lavender_foliage, yaw=-a + math.pi / 2, pitch=1.1)
for i in range(18):
    angle = i * (math.tau / 18) + (i % 3) * .10
    reach = .13 + (i % 3) * .07
    top_x = math.cos(angle) * reach * 1.5
    top_z = math.sin(angle) * reach * 1.5
    top_y = .30 + (i % 4) * .04
    rod('Lavender stem', (math.cos(angle) * .04, .08, math.sin(angle) * .04), (top_x, top_y, top_z), .008, lavender_foliage, .005, sides=6)
    spike_mat = lavender_deep if i % 2 == 0 else lavender_soft
    for tier in range(3):
        t = .66 + tier * .17
        bx = top_x * t
        bz = top_z * t
        by = .10 + (top_y - .08) * t
        foliage_blob('Lavender floral whorl', (bx, by, bz), (.042 - tier * .006, .052, .042 - tier * .006), spike_mat, subdivisions=1, rot=(0, angle, 0), smooth=False)


# 5. EXTERIOR GARDEN PLANTER: honed limestone island planter with coping rim, mulch, ferns, flowers & warm under-lip LED
# Note: ArrivalGarden sits at y=0 and places seats at z = -1.16 with top at y = 0.595.
group('exterior-garden-planter')
box('Planter recessed plinth', (0, .06, 0), (6.24, .12, 2.44), stone_plinth, .008)
box('Planter limestone body', (0, .30, 0), (6.40, .44, 2.60), stone_light, .012)
# Perimeter honed coping rim around top (y = 0.52 to 0.56)
for z in (-1.18, 1.18):
    box('Planter long coping rim', (0, .54, z), (6.46, .04, .28), stone_coping, .006)
for x in (-3.08, 3.08):
    box('Planter short coping rim', (x, .54, 0), (.28, .04, 2.10), stone_coping, .006)
# Architectural warm LED shadow-reveal strip along the seating side & recessed tree uplight housing
box('Planter under-lip LED strip', (0, .505, -1.305), (5.84, .018, .02), lamp_diffuser, .002)
cylinder('Planter recessed uplight bezel', (-.95, .568, .55), .105, .028, steel_charcoal, .095, sides=14)
cylinder('Planter recessed uplight lens', (-.95, .583, .55), .078, .008, lamp_diffuser, .078, sides=14)
box('Planter organic mulch bed', (0, .545, 0), (5.92, .03, 2.08), soil_mulch, .004)
for i, (px, pz, pr) in enumerate([(-2.4, -.55, .16), (-2.15, .48, .13), (-.55, -.42, .14), (.85, .52, .15), (2.55, -.38, .14), (2.72, .35, .12)]):
    foliage_blob('Garden accent boulder', (px, .56, pz), (pr, pr * .55, pr * .88), pebble_grey if i % 2 == 0 else stone_plinth, subdivisions=1, rot=(0, i * .7, 0), smooth=False)
# Rich understory ferns & flowering hydrangea/rose pockets along the rear/middle of the planter (z >= -0.35, clear of front seats!)
for fx, fz in ((-2.45, .32), (-1.15, .58), (.55, .48), (1.85, .52), (2.68, .18)):
    fern_clump('Planter sword fern', (fx, .56, fz), fronds=7, radius=.44, height=.32)
for hx, hz, hmat in ((-.42, .28, flower_blue), (.95, .18, blossom_rose), (2.05, .36, flower_coral)):
    foliage_pad('Planter hydrangea foliage', (hx, .64, hz), (.28, .18, .28), tropical_emerald, seed=hx)
    for dx, dz in ((-.09, -.06), (.09, .05), (0, .09)):
        flower_cluster('Planter flower head', (hx + dx, .76, hz + dz), .09, hmat, flower_gold, petals=5)


# 6. EXTERIOR GARDEN SEAT: 3-slat architectural timber seat mounted on the planter's north edge (seat top = 0.595)
group('exterior-garden-seat')
for sx in (-.68, 0, .68):
    box('Garden seat support cleat', (sx, .552, 0), (.06, .016, .31), steel_charcoal, .002)
for sx in (-.88, .88):
    box('Garden seat brass end trim', (sx, .595 - .0175, 0), (.016, .034, .304), brass_accent, .002)
for i, sz in enumerate((-.11, 0, .11)):
    box('Garden seat timber slat', (0, .595 - .0175, sz), (1.84, .035, .088), oak_honey if i == 1 else oak_warm, .006)


# 7. EXTERIOR PARK BENCH: sculpted cast-alloy frame + bevelled honey-oak slats (seat top = 0.47 around z = 0.12)
group('exterior-park-bench')
for x in (-.76, .76):
    box('Park bench foot pad', (x, .015, .04), (.09, .03, .54), alloy_silver, .005)
    rod('Park bench front leg', (x, .02, .26), (x, .43, .22), .032, alloy_silver, .028, sides=10)
    rod('Park bench rear leg & back upright', (x, .02, -.18), (x, .82, -.26), .034, alloy_silver, .026, sides=10)
    box('Park bench seat support beam', (x, .425, .03), (.055, .04, .48), alloy_silver, .006)
    # Sculpted armrest loop with warm timber arm cap
    rod('Park bench armrest post', (x, .43, .21), (x, .61, .19), .024, alloy_silver, .022, sides=10)
    box('Park bench armrest rail', (x, .62, -.02), (.052, .028, .46), alloy_silver, .006)
    box('Park bench armrest timber pad', (x, .638, .01), (.046, .014, .32), oak_warm, .003)
rod('Park bench lower tie stretcher', (-.76, .18, .02), (.76, .18, .02), .020, steel_slate, .020, sides=10)
for i, z in enumerate((-.09, .01, .11, .21)):
    box('Park bench seat slat', (0, .47 - .022, z), (1.86, .044, .085), oak_honey if i % 2 == 0 else oak_warm, .006)
for i, (y, z) in enumerate(((.58, -.21), (.69, -.235), (.80, -.26))):
    box('Park bench backrest slat', (0, y, z), (1.86, .078, .036), oak_honey if i == 1 else oak_warm, .006)


# 8. EXTERIOR PLINTH BENCH: monolithic chamfered stone base with shadow reveal + warm LED toe-kick + timber slat top (seat top = 0.425)
group('exterior-plinth-bench')
box('Plinth recessed shadow base', (0, .035, 0), (2.14, .07, .50), steel_charcoal, .006)
for z in (-.255, .255):
    box('Plinth warm toe-kick LED', (0, .058, z), (1.96, .014, .014), lamp_diffuser, .002)
box('Plinth architectural stone body', (0, .22, 0), (2.28, .31, .60), stone_plinth, .012)
for sx in (-.82, 0, .82):
    box('Plinth timber bearer', (sx, .382, 0), (.08, .016, .56), steel_charcoal, .002)
for sx in (-1.155, 1.155):
    box('Plinth brass end cap', (sx, .425 - .02, 0), (.016, .038, .53), brass_accent, .002)
for i, z in enumerate((-.21, -.07, .07, .21)):
    box('Plinth top timber slat', (0, .425 - .02, z), (2.30, .04, .115), oak_honey if i in (1, 2) else oak_warm, .006)


# 9. EXTERIOR PICNIC TABLE: powder-coated A-frame steel structure + bevelled oak tabletop (seat groups stay separate for officeSeat)
group('exterior-picnic-table')
for x in (-.72, .72):
    rod('Picnic A-frame leg north', (x, .02, -.42), (x, .71, -.12), .032, steel_charcoal, .028, sides=10)
    rod('Picnic A-frame leg south', (x, .02, .42), (x, .71, .12), .032, steel_charcoal, .028, sides=10)
    box('Picnic table top crossbearer', (x, .70, 0), (.06, .045, .62), steel_charcoal, .006)
    for sz in (-.42, .42):
        box('Picnic leg foot plate', (x, .01, sz), (.09, .02, .11), steel_slate, .003)
rod('Picnic longitudinal tie beam', (-.72, .32, 0), (.72, .32, 0), .022, steel_charcoal, .022, sides=10)
for i, z in enumerate((-.24, -.12, 0, .12, .24)):
    box('Picnic tabletop oak slat', (0, .745 - .02, z), (1.92, .04, .102), oak_honey if i % 2 == 0 else oak_warm, .006)
cylinder('Parasol table grommet ring', (0, .746, 0), .052, .008, alloy_silver, .048, sides=16)
# Subtle tabletop café condiment caddy & small succulent bowl along the center line (z = 0, clear of all 4 seat lanes)
cylinder('Picnic tabletop ceramic planter', (-.22, .768, 0), .062, .046, terracotta_pot, .074, sides=12)
foliage_blob('Picnic tabletop succulent', (-.22, .802, 0), (.058, .035, .058), ornamental_mint, subdivisions=1, smooth=False)
box('Picnic tabletop napkin caddy', (.22, .772, 0), (.09, .054, .065), steel_charcoal, .003)
box('Picnic tabletop napkins', (.22, .792, 0), (.072, .042, .042), ceramic_white, .002)


# 10. EXTERIOR PICNIC BENCH: two-slat bench seat per side (origin at [0, 0, ±0.62], seat top = 0.465)
group('exterior-picnic-bench')
for x in (-.72, .72):
    box('Picnic bench support bracket', (x, .405, 0), (.055, .06, .28), steel_charcoal, .004)
    rod('Picnic bench leg strut', (x, .02, 0), (x, .405, 0), .026, steel_charcoal, .024, sides=10)
    box('Picnic bench foot pad', (x, .01, 0), (.08, .02, .12), steel_slate, .003)
for i, dz in enumerate((-.075, .075)):
    box('Picnic bench timber slat', (0, .465 - .02, dz), (1.92, .04, .125), oak_honey if i == 0 else oak_warm, .006)


# 11. EXTERIOR PARASOL: architectural ribbed square market umbrella with finial, weighted base & warm under-canopy light ring
group('exterior-parasol')
cylinder('Parasol weighted base plate', (0, .02, 0), .26, .04, steel_charcoal, .22, sides=20)
cylinder('Parasol mast pole', (0, 1.34, 0), .038, 2.64, steel_slate, .034, sides=16)
cylinder('Parasol runner hub', (0, 2.18, 0), .062, .07, alloy_silver, .058, sides=16)
cylinder('Parasol warm table lantern ring', (0, 2.38, 0), .135, .038, lamp_diffuser, .125, sides=16)
for angle in (0, math.pi / 2, math.pi, -math.pi / 2):
    cx = math.sin(angle) * .56
    cz = math.cos(angle) * .56
    bpy.ops.mesh.primitive_cube_add(size=1, location=point((cx, 2.53, cz)))
    panel = bpy.context.object
    panel.dimensions = (1.64, .76, .028)
    panel.rotation_mode = 'YXZ'
    panel.rotation_euler = (.34, 0, angle)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    finish(panel, 'Parasol tensioned canvas panel', canopy_canvas, .004)
for diag in (math.pi / 4, 3 * math.pi / 4, -3 * math.pi / 4, -math.pi / 4):
    rx = math.sin(diag) * 1.05
    rz = math.cos(diag) * 1.05
    rod('Parasol canopy rib', (0, 2.66, 0), (rx, 2.34, rz), .012, alloy_silver, .009, sides=8)
    rod('Parasol strut arm', (0, 2.18, 0), (rx * .55, 2.48, rz * .55), .010, alloy_silver, .010, sides=8)
cylinder('Parasol apex finial', (0, 2.71, 0), .07, .08, alloy_silver, .02, sides=16)


# 12. EXTERIOR PATIO TABLE: stone paver pad + café pedestal bistro table + tabletop cup & vase + umbrella with warm lantern
group('exterior-patio-table')
cylinder('Patio stone terrace pad', (0, -.22, 0), .98, .06, stone_light, .94, sides=28)
cylinder('Bistro table weighted base', (0, .02, 0), .28, .04, alloy_silver, .24, sides=22)
cylinder('Bistro table pedestal column', (0, .40, 0), .055, .76, alloy_silver, .048, sides=16)
cylinder('Bistro table stone top', (0, .80, 0), .64, .048, bistro_top, .64, sides=28, bevel=.006)
cylinder('Bistro table brass rim collar', (0, .774, 0), .62, .012, brass_accent, .62, sides=28)
# Delicate bistro tabletop vignette (coffee cup + saucer + small ceramic bud vase)
cylinder('Bistro coffee saucer', (-.18, .828, .12), .068, .008, ceramic_white, .074, sides=12)
cylinder('Bistro coffee cup', (-.18, .858, .12), .036, .052, ceramic_white, .044, sides=12)
cylinder('Bistro bud vase', (.16, .856, -.10), .034, .064, terracotta_pot, .024, sides=10)
foliage_blob('Bistro bud blossom', (.16, .902, -.10), (.035, .032, .035), blossom_rose, subdivisions=1, smooth=False)
cylinder('Bistro umbrella mast', (.02, 1.56, 0), .032, 2.62, steel_slate, .028, sides=14)
cylinder('Bistro umbrella warm lantern', (.02, 2.29, 0), .125, .038, lamp_diffuser, .115, sides=16)
cylinder('Bistro umbrella canopy', (.02, 2.62, 0), 1.56, .58, canopy_canvas, .06, sides=12, bevel=.004)
for i in range(8):
    a = i * (math.tau / 8)
    rod('Bistro umbrella rib', (.02, 2.86, 0), (.02 + math.cos(a) * 1.48, 2.36, math.sin(a) * 1.48), .009, alloy_silver, .007, sides=6)
cylinder('Bistro umbrella finial', (.02, 2.94, 0), .045, .07, alloy_silver, .015, sides=12)


# 13. EXTERIOR PATIO CHAIR: sculpted outdoor café chair with curved tubular frame & slatted seat/back (seat top = 0.47)
group('exterior-patio-chair')
for lx in (-.22, .22):
    rod('Patio chair front leg', (lx, .01, .21), (lx, .44, .18), .018, steel_slate, .016, sides=8)
    rod('Patio chair rear leg & back post', (lx, .01, -.21), (lx, .79, -.25), .018, steel_slate, .015, sides=8)
    box('Patio chair side seat rail', (lx, .43, 0), (.028, .028, .44), alloy_silver, .004)
    rod('Patio chair armrest', (lx, .61, .16), (lx, .63, -.22), .015, alloy_silver, .015, sides=8)
    rod('Patio chair arm upright', (lx, .44, .16), (lx, .61, .16), .014, alloy_silver, .014, sides=8)
for i, z in enumerate((-.15, -.05, .05, .15)):
    box('Patio chair seat slat', (0, .47 - .014, z), (.46, .028, .074), oak_honey if i % 2 == 0 else oak_warm, .004)
for i, (y, z) in enumerate(((.62, -.225), (.73, -.245))):
    box('Patio chair backrest slat', (0, y, z), (.46, .072, .024), oak_honey if i == 0 else oak_warm, .004)


# 14. EXTERIOR WALK LAMP: architectural pedestrian pole luminaire with cast base, tapered shaft & hooded optical head
group('exterior-walk-lamp')
cylinder('Walk lamp stone plinth pad', (0, .03, 0), .15, .06, stone_plinth, .135, sides=12)
cylinder('Walk lamp cast base collar', (0, .18, 0), .095, .24, steel_charcoal, .062, sides=12)
cylinder('Walk lamp brass accent ring', (0, .31, 0), .064, .022, brass_accent, .060, sides=12)
cylinder('Walk lamp tapered pole shaft', (0, 1.36, 0), .054, 2.08, steel_slate, .042, sides=14)
cylinder('Walk lamp neck collar', (0, 2.41, 0), .046, .05, alloy_silver, .085, sides=14)
cylinder('Walk lamp diffuser lens', (0, 2.49, 0), .135, .11, lamp_diffuser, .185, sides=16)
for i in range(4):
    a = i * (math.tau / 4) + math.pi / 4
    rod('Walk lamp optical cage strut', (math.cos(a) * .08, 2.43, math.sin(a) * .08), (math.cos(a) * .185, 2.55, math.sin(a) * .185), .007, steel_charcoal, .007, sides=6)
cylinder('Walk lamp shielded hood cap', (0, 2.57, 0), .215, .055, steel_charcoal, .08, sides=16)
cylinder('Walk lamp top finial', (0, 2.61, 0), .035, .025, brass_accent, .012, sides=10)


# 15. EXTERIOR BOLLARD LIGHT: louvered architectural pathway bollard with warm glowing optical chamber
group('exterior-bollard-light')
cylinder('Bollard ground flange', (0, .02, 0), .105, .04, stone_plinth, .092, sides=14)
cylinder('Bollard lower body', (0, .31, 0), .074, .54, steel_charcoal, .068, sides=14)
cylinder('Bollard brass neck ring', (0, .585, 0), .070, .016, brass_accent, .070, sides=14)
cylinder('Bollard glowing diffuser core', (0, .665, 0), .056, .145, lamp_diffuser, .056, sides=14)
for ly in (.62, .665, .71):
    cylinder('Bollard anti-glare louver ring', (0, ly, 0), .074, .010, alloy_silver, .068, sides=14)
for i in range(4):
    a = i * (math.tau / 4)
    rod('Bollard optical guard strut', (math.cos(a) * .066, .59, math.sin(a) * .066), (math.cos(a) * .066, .74, math.sin(a) * .066), .006, steel_slate, .006, sides=6)
cylinder('Bollard dome cap', (0, .765, 0), .078, .05, steel_charcoal, .028, sides=14)


# 16. EXTERIOR TREE UPLIGHT: ground-recessed adjustable landscape uplight bezel & lens (max.y < 0.08)
group('exterior-tree-uplight')
cylinder('Uplight recessed housing collar', (0, .015, 0), .155, .035, stone_plinth, .145, sides=16)
cylinder('Uplight stainless bezel ring', (0, .035, 0), .138, .016, steel_charcoal, .125, sides=16)
cylinder('Uplight brass inner trim', (0, .043, 0), .118, .008, brass_accent, .112, sides=16)
cylinder('Uplight glowing lens', (0, .046, 0), .106, .008, lamp_diffuser, .102, sides=16)


# 17. EXTERIOR WAYFINDING PYLON: architectural monolith directory totem (keeps z >= 0.082 clear for runtime canvas at z = 0.085)
group('exterior-wayfinding-pylon')
box('Pylon stepped limestone foundation', (0, -.16, 0), (.92, .14, .72), stone_plinth, .008)
box('Pylon upper stone plinth', (0, -.06, 0), (.72, .08, .44), stone_coping, .006)
box('Pylon brass base reveal collar', (0, .01, 0), (.56, .06, .20), brass_accent, .004)
# Main monolith body stays within z in [-0.076, +0.076] so the runtime canvas at [0, 1.1, 0.085] is never occluded
box('Pylon dark slate monolith core', (0, 1.14, 0), (.50, 2.22, .152), steel_charcoal, .006)
for sx in (-.268, .268):
    box('Pylon warm timber side fin', (sx, 1.14, 0), (.036, 2.20, .162), oak_honey, .004)
    box('Pylon brushed alloy outer trim', (sx * 1.08, 1.14, 0), (.016, 2.16, .12), alloy_silver, .002)
box('Pylon architectural crown cap', (0, 2.28, .008), (.58, .06, .21), alloy_silver, .005)
box('Pylon top sign-wash LED bar', (0, 2.242, .082), (.44, .016, .018), lamp_diffuser, .002)


# 18. EXTERIOR CAFE KIOSK: complete Campus Cafe kiosk pod with slatted oak apron, stone counter, espresso bar & pastry case
# Note: Runtime sign plane sits at [0, 2.16, 1.26] (size 4.3 x 0.85). Fascia backing stays at z <= 1.245.
# Customer standing point is at [0, 0, 1.9], so kiosk footprint stays within z <= 1.255.
group('exterior-cafe-kiosk')
# Plinth & main architectural counter pod
box('Kiosk limestone base plinth', (0, .06, -.05), (4.68, .12, 2.16), stone_plinth, .008)
box('Kiosk lower pod body', (0, .78, .12), (4.52, 1.36, 1.80), steel_charcoal, .010)
box('Kiosk recessed rear service wall', (0, 1.36, -.82), (4.56, 2.44, .22), steel_charcoal, .008)
for sx in (-2.22, 2.22):
    box('Kiosk side wing wall', (sx, 1.36, -.18), (.16, 2.44, 1.48), steel_slate, .006)
# Vertical honey-oak slatted front apron & warm under-counter LED toe-kick
for i in range(19):
    sx = -2.07 + i * .23
    box('Kiosk front vertical oak slat', (sx, .76, 1.035), (.11, 1.24, .035), oak_honey if i % 2 == 0 else oak_warm, .004)
for y_rail in (.18, 1.36):
    box('Kiosk apron brass rail', (0, y_rail, 1.03), (4.36, .032, .038), brass_accent, .003)
box('Kiosk under-counter toe-kick LED', (0, .08, 1.02), (4.24, .038, .04), lamp_diffuser, .002)
# Honed stone service counter & under-lip LED strip
box('Kiosk honed stone service counter', (0, 1.49, .44), (4.80, .09, 1.48), stone_coping, .008)
box('Kiosk counter under-lip LED', (0, 1.43, 1.15), (4.56, .022, .03), lamp_diffuser, .002)
# Rear barista shelving & acoustic timber back-bar panel
box('Kiosk rear timber back-bar panel', (0, 1.92, -.69), (4.16, .96, .03), oak_warm, .004)
for sy in (1.72, 2.08):
    box('Kiosk rear barista shelf', (0, sy, -.56), (3.86, .035, .24), oak_honey, .004)
    box('Kiosk shelf LED strip', (0, sy - .022, -.46), (3.72, .014, .018), lamp_diffuser, .002)
# Syrup bottles & coffee canisters on rear shelves
for bx in (-1.55, -1.32, -1.08, .95, 1.22, 1.48):
    cylinder('Back-bar coffee canister', (bx, 1.81, -.56), .055, .14, ceramic_white if bx > 0 else brass_accent, .055, sides=10)
    cylinder('Back-bar upper jar', (bx * .85, 2.17, -.56), .048, .13, terracotta_pot if bx < 0 else steel_slate, .048, sides=10)
# Front brushed-steel canopy columns
for px in (-2.18, 2.18):
    cylinder('Kiosk front canopy post', (px, 2.02, 1.06), .048, .98, alloy_silver, .048, sides=12)
    cylinder('Kiosk post brass collar', (px, 1.55, 1.06), .062, .03, brass_accent, .062, sides=12)
# Cantilevered canopy roof, warm timber soffit, service edge LED, and fascia frame behind z = 1.245
box('Kiosk canopy roof slab', (0, 2.62, 0), (5.00, .14, 2.48), steel_charcoal, .008)
box('Kiosk canopy timber soffit', (0, 2.535, .04), (4.76, .024, 2.26), oak_honey, .004)
box('Kiosk canopy service LED bar', (0, 2.52, 1.12), (4.44, .024, .055), lamp_diffuser, .002)
# Fascia backing board at z = 1.18..1.242 (leaves z = 1.26 completely unobstructed for the runtime CAMPUS CAFE sign!)
box('Kiosk sign fascia backing', (0, 2.16, 1.205), (4.44, .92, .065), steel_charcoal, .006)
for fy in (1.69, 2.63):
    box('Kiosk sign frame horizontal trim', (0, fy, 1.225), (4.48, .035, .048), brass_accent, .003)
for fx in (-2.21, 2.21):
    box('Kiosk sign frame side trim', (fx, 2.16, 1.225), (.045, .96, .048), brass_accent, .003)
# Commercial Twin-Group Espresso Machine & Grinder (x = -1.35, y = 1.535, z = 0.25)
box('Espresso machine chassis', (-1.35, 1.74, .24), (.74, .41, .44), alloy_silver, .008)
box('Espresso machine dark side panels', (-1.35, 1.73, .22), (.76, .35, .36), steel_slate, .006)
box('Espresso machine drip tray', (-1.35, 1.555, .48), (.68, .04, .16), steel_charcoal, .003)
box('Espresso status light bar', (-1.35, 1.86, .465), (.52, .018, .012), lamp_diffuser, .002)
for gx in (-1.52, -1.18):
    cylinder('Espresso brew group head', (gx, 1.73, .47), .048, .06, steel_charcoal, .042, sides=12)
    rod('Espresso portafilter handle', (gx, 1.72, .49), (gx + .04, 1.69, .64), .014, oak_warm, .018, sides=8)
for wx in (-1.66, -1.04):
    rod('Espresso steam wand', (wx, 1.80, .44), (wx + (.03 if wx > -1.3 else -.03), 1.62, .52), .008, alloy_silver, .006, sides=8)
for cx in (-1.56, -1.35, -1.14):
    cylinder('Warming rack espresso cup', (cx, 1.975, .24), .034, .055, ceramic_white, .042, sides=10)
# Burr Coffee Grinder beside the espresso machine (x = -1.92)
box('Coffee grinder body', (-1.92, 1.68, .26), (.22, .29, .26), steel_charcoal, .005)
cylinder('Coffee grinder bean hopper', (-1.92, 1.91, .26), .085, .18, glass_case, .105, sides=14)
cylinder('Coffee grinder hopper lid', (-1.92, 2.01, .26), .108, .02, steel_charcoal, .095, sides=14)
# POS Terminal & Cup Stacks at center (x = -0.15..0.45)
box('POS terminal stand base', (-.18, 1.55, .42), (.18, .025, .18), steel_charcoal, .003)
rod('POS terminal neck', (-.18, 1.56, .42), (-.18, 1.69, .40), .018, alloy_silver, .016, sides=8)
box('POS touchscreen tablet', (-.18, 1.73, .42), (.28, .19, .024), steel_charcoal, .003)
for cx, h in ((.22, .22), (.38, .17), (.54, .12)):
    cylinder('Takeaway coffee cup stack', (cx, 1.535 + h / 2, .38), .046, h, ceramic_white, .052, sides=12)
    cylinder('Takeaway cup lid', (cx, 1.545 + h, .38), .054, .018, steel_charcoal, .050, sides=12)
# Artisanal Pastry Display Case on the right counter (x = 1.32, z = 0.36)
box('Pastry case timber base', (1.32, 1.58, .36), (.96, .09, .52), oak_warm, .005)
box('Pastry case glass enclosure', (1.32, 1.78, .36), (.92, .32, .48), glass_case, .006)
box('Pastry case top brass frame', (1.32, 1.945, .36), (.94, .022, .50), brass_accent, .003)
box('Pastry case warm showcase LED', (1.32, 1.925, .56), (.84, .014, .018), lamp_diffuser, .002)
for px in (.98, 1.20, 1.44, 1.66):
    for pz, py in ((.28, 1.74), (.44, 1.64)):
        foliage_blob('Golden croissant pastry', (px, py, pz), (.065, .038, .045), pastry_gold, subdivisions=1, rot=(0, .3, 0), smooth=False)


# 19. EXTERIOR CAFE DECK: architectural timber slat terrace deck (8.8 x 7.6 m; max.y <= 0.04 so WalkingClearance treats it as passable)
group('exterior-cafe-deck')
box('Cafe deck dark structural sub-frame', (0, -.06, 0), (9.08, .09, 7.88), steel_slate, .006)
for sz in (-3.88, 3.88):
    box('Cafe deck long border trim', (0, -.005, sz), (9.12, .042, .12), stone_plinth, .004)
for sx in (-4.48, 4.48):
    box('Cafe deck short border trim', (sx, -.005, 0), (.12, .042, 7.64), stone_plinth, .004)
# 21 bevelled timber deck boards running north-south across x in [-4.2, +4.2], top at y = 0.036 <= 0.04
for i in range(21):
    dx = -4.20 + i * .42
    box('Cafe deck timber plank', (dx, .012, 0), (.35, .048, 7.60), oak_honey if i % 3 != 0 else oak_warm, .005)


# 20. EXTERIOR FESTOON MAST: architectural festoon light pole with stone footing, base gussets & top ring finial
group('exterior-festoon-mast')
box('Festoon mast stone footing pad', (0, .025, 0), (.38, .05, .38), stone_plinth, .005)
cylinder('Festoon mast base collar', (0, .16, 0), .085, .24, steel_charcoal, .062, sides=12)
cylinder('Festoon mast brass accent ring', (0, .29, 0), .065, .02, brass_accent, .062, sides=12)
cylinder('Festoon mast tapered steel pole', (0, 1.68, 0), .054, 2.78, steel_charcoal, .038, sides=12)
box('Festoon mast top cross-arm bracket', (0, 3.04, 0), (.06, .05, .22), alloy_silver, .004)
cylinder('Festoon mast top finial lantern', (0, 3.11, 0), .052, .07, lamp_diffuser, .032, sides=12)


# 21. EXTERIOR BIKE RACK: chamfered stone pad, wheel-stop curb channel & 4 brushed-steel Sheffield U-loops
group('exterior-bike-rack')
box('Bike rack chamfered stone pad', (0, -.215, 0), (3.44, .065, 1.56), stone_light, .008)
for z in (-.42, .42):
    box('Bike rack ground anchor rail', (0, .02, z), (3.18, .055, .075), alloy_silver, .005)
for offset in (-1.5, -.5, .5, 1.5):
    lx = offset * .72
    for dz in (-.26, .26):
        cylinder('Sheffield loop base flange', (lx, .05, dz), .058, .024, steel_slate, .052, sides=12)
        rod('Sheffield loop vertical post', (lx, .05, dz), (lx, .56, dz), .030, alloy_silver, .030, sides=10)
    # Arch top connecting the two posts of each Sheffield loop
    rod('Sheffield loop arch south', (lx, .56, -.26), (lx, .72, -.11), .030, alloy_silver, .030, sides=10)
    rod('Sheffield loop arch crown', (lx, .72, -.11), (lx, .72, .11), .030, alloy_silver, .030, sides=10)
    rod('Sheffield loop arch north', (lx, .72, .11), (lx, .56, .26), .030, alloy_silver, .030, sides=10)


# 22. EXTERIOR BICYCLE: sculpted commuter road bicycle with spoked wheels, tintable diamond frame, saddle, bars & headlamp
group('exterior-bicycle')
for wz in (-.42, .42):
    # Wheel tire + alloy rim + hub + radial spokes
    for seg in range(16):
        a0 = seg * (math.tau / 16)
        a1 = (seg + 1) * (math.tau / 16)
        p0 = (0, .33 + math.sin(a0) * .30, wz + math.cos(a0) * .30)
        p1 = (0, .33 + math.sin(a1) * .30, wz + math.cos(a1) * .30)
        rod('Bicycle tire segment', p0, p1, .026, rubber_tire, .026, sides=8)
        r0 = (0, .33 + math.sin(a0) * .272, wz + math.cos(a0) * .272)
        r1 = (0, .33 + math.sin(a1) * .272, wz + math.cos(a1) * .272)
        rod('Bicycle alloy rim segment', r0, r1, .012, alloy_silver, .012, sides=6)
        if seg % 2 == 0:
            rod('Bicycle wheel spoke', (0, .33, wz), r0, .0035, alloy_silver, .0035, sides=4)
    rod('Bicycle wheel hub axle', (-.045, .33, wz), (.045, .33, wz), .018, alloy_silver, .018, sides=8)
# Sculpted diamond commuter frame in tintable `Bicycle frame paint`
rod('Bicycle head tube', (0, .58, .31), (0, .74, .25), .022, bike_paint, .022, sides=10)
rod('Bicycle top tube', (0, .71, .26), (0, .68, -.16), .019, bike_paint, .019, sides=10)
rod('Bicycle down tube', (0, .60, .30), (0, .31, -.04), .022, bike_paint, .022, sides=10)
rod('Bicycle seat tube', (0, .31, -.04), (0, .71, -.17), .020, bike_paint, .020, sides=10)
for sx in (-.04, .04):
    rod('Bicycle front fork blade', (sx * .8, .33, .42), (0, .59, .31), .014, bike_paint, .016, sides=8)
    rod('Bicycle chainstay', (sx, .31, -.04), (sx, .33, -.42), .013, bike_paint, .011, sides=8)
    rod('Bicycle seatstay', (sx, .66, -.16), (sx, .33, -.42), .012, bike_paint, .010, sides=8)
# Stem, swept commuter handlebars, grips & front dynamo headlamp
rod('Bicycle handlebar stem', (0, .74, .25), (0, .84, .27), .015, alloy_silver, .015, sides=8)
rod('Bicycle handlebar crossbar', (-.22, .84, .24), (.22, .84, .24), .013, alloy_silver, .013, sides=8)
for gx in (-.22, .22):
    rod('Bicycle cork handlebar grip', (gx, .84, .24), (gx * 1.12, .83, .15), .017, oak_warm, .017, sides=8)
cylinder('Bicycle dynamo headlamp housing', (0, .76, .31), .024, .045, steel_charcoal, .020, sides=10)
cylinder('Bicycle dynamo headlamp lens', (0, .76, .335), .020, .010, lamp_diffuser, .020, sides=10)
# Seatpost, contoured saddle, crankset, pedals & rear commuter rack
rod('Bicycle alloy seatpost', (0, .71, -.17), (0, .82, -.20), .015, alloy_silver, .014, sides=8)
box('Bicycle contoured leather saddle', (0, .84, -.21), (.13, .045, .24), oak_warm, .008)
cylinder('Bicycle chainring', (.032, .31, -.04), .075, .012, alloy_silver, .075, sides=14)
for side, py in ((-1, .22), (1, .40)):
    rod('Bicycle crank arm', (side * .045, .31, -.04), (side * .055, py, -.04 + side * .06), .011, alloy_silver, .010, sides=6)
    box('Bicycle platform pedal', (side * .095, py, -.04 + side * .06), (.07, .018, .055), steel_charcoal, .003)
box('Bicycle rear commuter rack', (0, .52, -.38), (.13, .018, .32), alloy_silver, .003)


# 23. EXTERIOR GARDEN DECOR: sculpted Japanese Yukimi stone lantern + Tsukubai water basin + 3 overflowing flower amphoras + stepping stones
group('exterior-garden-decor')
# Yukimi-doro (Snow-Viewing Pagoda Lantern) on mossy boulder plinth with glowing diffuser firebox
foliage_blob('Lantern mossy foundation boulder', (0, .06, 0), (.32, .10, .28), stone_plinth, subdivisions=1, rot=(0, .3, 0), smooth=False)
for i in range(3):
    la = i * (math.tau / 3) + .2
    rod('Lantern arched tripod leg', (math.cos(la) * .16, .08, math.sin(la) * .16), (math.cos(la) * .09, .26, math.sin(la) * .09), .036, stone_plinth, .028, sides=7)
cylinder('Garden lantern middle shelf', (0, .28, 0), .24, .05, stone_coping, .21, sides=8)
cylinder('Garden lantern glowing core', (0, .42, 0), .13, .22, lamp_diffuser, .13, sides=8)
for i in range(6):
    a = i * (math.tau / 6)
    rod('Garden lantern lattice post', (math.cos(a) * .145, .30, math.sin(a) * .145), (math.cos(a) * .145, .53, math.sin(a) * .145), .018, stone_plinth, .016, sides=6)
cylinder('Garden lantern pagoda hood lower', (0, .57, 0), .34, .08, stone_plinth, .18, sides=8)
cylinder('Garden lantern pagoda hood upper', (0, .64, 0), .20, .07, stone_coping, .06, sides=8)
cylinder('Garden lantern lotus finial', (0, .71, 0), .05, .07, brass_accent, .014, sides=8)

# Tsukubai carved basalt water basin with water mirror & bamboo spout on the right
cylinder('Tsukubai basalt water basin', (.48, .16, .18), .22, .26, stone_plinth, .25, sides=12)
cylinder('Tsukubai water mirror', (.48, .285, .18), .19, .015, water_teal, .19, sides=12)
rod('Tsukubai bamboo water post', (.68, .02, .28), (.66, .42, .26), .028, ornamental_sage, .026, sides=8)
rod('Tsukubai bamboo water spout', (.66, .36, .26), (.50, .32, .20), .018, oak_honey, .016, sides=8)

# Trio of glazed ceramic & terracotta garden vessels overflowing with flowers, agave & fern fronds
for vx, vz, r0, r1, h, pot_mat, bloom_mat in (
    (-.46, .16, .18, .25, .34, terracotta_pot, flower_coral),
    (-.28, -.28, .14, .20, .26, bike_paint, flower_blue),
    (.18, -.34, .12, .17, .22, ceramic_white, lavender_deep),
):
    cylinder('Garden artisan vessel', (vx, h / 2, vz), r0, h, pot_mat, r1, sides=14)
    cylinder('Garden vessel rim', (vx, h, vz), r1 * 1.06, .032, pot_mat, r1, sides=14)
    foliage_pad('Vessel foliage cushion', (vx, h + .06, vz), (r1 * 1.05, .14, r1 * 1.05), shrub_deep, seed=vx * 3)
    leaf_fan('Vessel cascading leaves', (vx, h + .08, vz), r1 * .95, canopy_sun, yaw=vx, blades=5)
    for fi in range(3):
        fa = fi * (math.tau / 3) + vx
        flower_cluster('Vessel overflowing bloom', (vx + math.cos(fa) * r1 * .45, h + .16, vz + math.sin(fa) * r1 * .45), .085, bloom_mat, flower_gold, petals=5)

# Natural boulders, fern & flat slate stepping stones
fern_clump('Decor corner fern', (-.12, .02, .36), fronds=7, radius=.42, height=.30)
for bx, bz, rx, ry, rz, bmat in (
    (.42, -.14, .26, .16, .22, pebble_grey),
    (.26, .38, .18, .11, .16, stone_plinth),
    (-.58, -.16, .20, .04, .18, stone_coping),
    (.04, .48, .22, .04, .19, stone_coping),
):
    foliage_blob('Decor boulder or stepping stone', (bx, ry * .6, bz), (rx, ry, rz), bmat, subdivisions=1, rot=(0, bx * 2, 0), smooth=False)


# 24. EXTERIOR COLUMNAR TREE: tiered Italian Cypress / Evergreen Conifer with upward-swept needle whorls
group('exterior-columnar-tree')
cylinder('Cypress root flare', (0, .22, 0), .24, .44, bark_dark, .16, sides=10, bevel=0)
rod('Cypress central trunk', (0, .18, 0), (0, 5.20, 0), .16, bark_dark, .04, sides=10)
for tier in range(13):
    t = tier / 12.0
    ty = 1.15 + tier * .36
    # Classic tapered spindle profile of an architectural cypress/conifer
    profile = math.sin(t * math.pi * .88 + .22) * (1.0 - t * .52)
    tr = .22 + .78 * max(.18, profile)
    th = .48 - t * .14
    t_mat = pine_deep if tier % 3 == 0 else (pine_mid if tier % 3 == 1 else pine_tip)
    foliage_pad('Cypress needle tier', (0, ty, 0), (tr, th, tr), t_mat, seed=tier * 1.3, subdivisions=2)
    whorl_blades = 7 - (tier // 4)
    for w in range(whorl_blades):
        wa = w * (math.tau / whorl_blades) + tier * .45
        leaf_blade(
            'Cypress upward frond',
            (math.cos(wa) * tr * .68, ty - .06, math.sin(wa) * tr * .68),
            tr * .62,
            tr * .28,
            pine_tip if (w + tier) % 2 == 0 else pine_mid,
            yaw=-wa + math.pi / 2,
            pitch=.38,
        )
leaf_blade('Cypress leader spire', (0, 5.75, 0), .65, .22, pine_tip, yaw=0, pitch=.05)


# 25. EXTERIOR BLOSSOM TREE: full flowering Sakura / Cherry Blossom tree with dark bark, 14 limbs, sakura clouds & fallen petals
group('exterior-blossom-tree')
cylinder('Sakura root flare', (0, .20, 0), .28, .40, bark_cherry, .18, sides=12, bevel=0)
for i in range(4):
    ra = i * (math.tau / 4) + .4
    rod('Sakura surface root', (math.cos(ra) * .12, .26, math.sin(ra) * .12), (math.cos(ra) * .38, .02, math.sin(ra) * .38), .075, bark_cherry, .03, sides=7)
rod('Sakura main trunk lower', (0, .16, 0), (.03, 1.55, -.02), .18, bark_cherry, .135, sides=11)
rod('Sakura main trunk upper', (.03, 1.48, -.02), (-.02, 2.55, .03), .135, bark_cherry, .085, sides=9)
sakura_limbs = [
    ((.02, 1.45, 0), (-.86, 2.58, .28), .092, .042),
    ((.03, 1.54, -.02), (.88, 2.66, -.26), .090, .042),
    ((0, 1.65, .02), (.18, 2.62, .86), .084, .038),
    ((-.02, 1.72, -.02), (-.24, 2.70, -.84), .082, .038),
    ((-.01, 2.25, .02), (-.16, 3.45, -.06), .072, .034),
    ((-.52, 2.15, .18), (-1.26, 2.88, .48), .054, .024),
    ((.54, 2.22, -.16), (1.24, 2.94, -.46), .054, .024),
    ((.12, 2.20, .52), (.52, 2.96, 1.16), .050, .022),
    ((-.16, 2.26, -.50), (-.54, 3.02, -1.12), .050, .022),
]
for start, end, r0, r1 in sakura_limbs:
    rod('Sakura arching limb', start, end, r0, bark_cherry, r1, sides=8)

sakura_boughs = [
    ((0, 3.12, 0), (1.28, .78, 1.26), blossom_deep, blossom_rose, blossom_blush, .3, 7),
    ((-1.02, 2.68, .32), (.98, .66, .95), blossom_deep, blossom_rose, blossom_cream, 1.4, 6),
    ((1.00, 2.76, -.30), (1.00, .68, .96), blossom_rose, blossom_blush, blossom_cream, 2.5, 6),
    ((.24, 2.74, .94), (.92, .64, .90), blossom_deep, blossom_rose, blossom_blush, 3.6, 5),
    ((-.28, 2.80, -.92), (.90, .62, .88), blossom_rose, blossom_blush, blossom_cream, 4.7, 5),
    ((-.18, 3.74, -.06), (.94, .66, .92), blossom_rose, blossom_blush, blossom_cream, 5.8, 6),
    ((.58, 3.38, .40), (.78, .56, .76), blossom_deep, blossom_rose, blossom_blush, 6.9, 5),
    ((-.62, 3.32, -.36), (.76, .54, .74), blossom_rose, blossom_blush, blossom_cream, 8.0, 5),
]
for center, radii, s_mat, m_mat, h_mat, seed, fans in sakura_boughs:
    leafy_bough('Sakura blossom bough', center, radii, s_mat, m_mat, h_mat, seed=seed, fans=fans)
# Fresh spring-green leaf sprouts peeking through the sakura blossom clouds
for sx, sy, sz, syaw in ((-.65, 3.15, .55, .4), (.68, 3.22, -.48, 1.8), (.15, 3.68, .52, 3.1), (-.42, 3.55, -.52, 4.5)):
    leaf_fan('Sakura spring leaf shoot', (sx, sy, sz), .38, canopy_sun, yaw=syaw, blades=4, pitch_base=.45)
# Ring of fallen sakura petals on the ground around the base
for i in range(12):
    pa = i * (math.tau / 12) + (i % 3) * .18
    pr = .36 + (i % 4) * .22
    foliage_blob('Fallen sakura petal cluster', (math.cos(pa) * pr, .018, math.sin(pa) * pr), (.11, .015, .09), blossom_blush if i % 2 == 0 else blossom_rose, subdivisions=1, rot=(0, pa, 0), smooth=False)


# 26. EXTERIOR FLOWER BED: lush multi-species botanical flower parterre (Hydrangeas, Roses, Tulips & Feather Grass)
group('exterior-flower-bed')
foliage_pad('Flower bed contoured organic soil', (0, .04, 0), (1.12, .08, .74), soil_mulch, seed=.5, subdivisions=2)
# 3 Bigleaf Hydrangea shrubs (sky blue, violet, blush pink)
for hx, hz, h_mat, seed in ((-.62, .08, flower_blue, 1.1), (.04, -.12, lavender_soft, 2.4), (.64, .10, blossom_rose, 3.7)):
    foliage_pad('Hydrangea broadleaf base', (hx, .18, hz), (.38, .22, .36), tropical_emerald, seed=seed, subdivisions=2)
    leaf_fan('Hydrangea serrated leaves', (hx, .16, hz), .38, shrub_light, yaw=seed, blades=5)
    for dx, dy, dz in ((0, .34, 0), (-.16, .28, .12), (.16, .29, -.10), (-.10, .27, -.14), (.12, .30, .14)):
        foliage_blob('Hydrangea pom-pom panicle', (hx + dx, dy, hz + dz), (.11, .09, .11), h_mat, subdivisions=1, smooth=False)
# Blooming Rose & Peony bushes (crimson, coral, sunny gold)
for rx, rz, r_mat in ((-.32, -.26, flower_crimson), (.36, .24, flower_coral), (-.08, .28, flower_gold), (.82, -.20, flower_crimson), (-.84, -.18, flower_coral)):
    leaf_fan('Rose compound foliage', (rx, .12, rz), .28, shrub_deep, yaw=rx * 3, blades=4)
    flower_cluster('Garden rose bloom', (rx, .22, rz), .10, r_mat, flower_gold, petals=5)
# Ornamental Fountain Grass (Pennisetum) clumps with feathery cream plumes
for gx, gz in ((-.92, .22), (.90, .20), (0, -.38)):
    leaf_fan('Ornamental fountain grass blades', (gx, .14, gz), .42, tropical_fern, yaw=gx * 2, blades=6, pitch_base=.32)
    for pi in range(3):
        pa = pi * 2.1 + gx
        rod('Fountain grass stem', (gx, .10, gz), (gx + math.cos(pa) * .16, .52, gz + math.sin(pa) * .16), .008, ornamental_sage, .005, sides=5)
        foliage_blob('Fountain grass plume', (gx + math.cos(pa) * .19, .56, gz + math.sin(pa) * .19), (.04, .11, .04), blossom_cream, subdivisions=1, rot=(.2, pa, 0), smooth=False)


# 27. EXTERIOR TROPICAL CLUSTER: architectural Sword Ferns, Monstera/Hosta broadleaves & sculpted Blue Agave
group('exterior-tropical-cluster')
foliage_pad('Tropical cluster mulch mound', (0, .035, 0), (.92, .07, .72), soil_mulch, seed=1.9, subdivisions=1)
fern_clump('Tropical main sword fern', (-.38, .04, .08), fronds=11, radius=.64, height=.48, material=tropical_fern)
fern_clump('Tropical secondary fern', (.46, .04, -.18), fronds=8, radius=.48, height=.36, material=canopy_olive)
# Broadleaf Monstera / Hosta clump
for i in range(7):
    ma = i * (math.tau / 7) + .3
    mr = .24 + (i % 2) * .12
    mx, mz = .12 + math.cos(ma) * mr, .22 + math.sin(ma) * mr
    rod('Monstera petiole stem', (.12, .05, .22), (mx, .28 + (i % 3) * .06, mz), .014, tropical_emerald, .010, sides=6)
    leaf_blade('Monstera glossy broadleaf', (mx, .28 + (i % 3) * .06, mz), .38, .19, tropical_emerald if i % 2 == 0 else shrub_deep, yaw=-ma + math.pi / 2, pitch=.88)
# Sculpted Blue Agave succulent rosette on river pebbles
for ring, (blades, length, width, pitch) in enumerate(((8, .36, .095, .95), (6, .28, .08, .58), (4, .20, .06, .24))):
    for b in range(blades):
        ba = b * (math.tau / blades) + ring * .4
        leaf_blade('Blue agave succulent leaf', (-.06 + math.cos(ba) * .06, .06 + ring * .04, -.26 + math.sin(ba) * .06), length, width, agave_blue, yaw=-ba + math.pi / 2, pitch=pitch)
for bx, bz, br in ((.58, .22, .16), (-.62, -.24, .14), (.24, -.36, .12)):
    foliage_blob('Tropical river boulder', (bx, .06, bz), (br, br * .6, br * .85), pebble_grey, subdivisions=1, smooth=False)


# 28. EXTERIOR GARDEN POND: sculpted Koi & Lotus reflection pond with boulder waterfall cascade, timber edge & stone lantern
group('exterior-garden-pond')
# Shimmering teal-turquoise water basin & dark liner bed
cylinder('Pond dark stone basin bed', (0, .02, 0), 2.35, .04, steel_charcoal, 2.40, sides=24)
cylinder('Pond turquoise water mirror', (0, .065, 0), 2.28, .03, water_teal, 2.30, sides=24)
# Curved teakwood viewing boardwalk deck along the front-south edge
for i in range(7):
    dx = -1.26 + i * .42
    box('Pond viewing timber deck slat', (dx, .09, -1.58), (.38, .045, .64), oak_honey if i % 2 == 0 else oak_warm, .005)
box('Pond viewing deck edge beam', (0, .06, -1.26), (2.96, .06, .08), steel_charcoal, .004)
# Perimeter ring of 20 natural limestone & mossy basalt boulders
for i in range(20):
    ba = i * (math.tau / 20)
    if -2.15 < ba < -.98:
        continue  # Leave front viewing deck edge open
    rx = math.cos(ba) * 2.32
    rz = math.sin(ba) * 1.62
    br = .26 + (i % 3) * .09
    bh = .16 + (i % 4) * .06
    b_mat = stone_plinth if i % 3 == 0 else (pebble_grey if i % 2 == 0 else stone_light)
    foliage_blob('Pond rim boulder', (rx, bh * .65, rz), (br * 1.15, bh, br), b_mat, subdivisions=1, rot=(0, ba, 0), smooth=False)
    if i % 4 == 1:
        foliage_pad('Boulder moss cushion', (rx * .96, bh * 1.05, rz * .96), (br * .7, .05, br * .7), shrub_deep, seed=i, subdivisions=1)

# Tiered waterfall boulder cascade on the rear-east bank with white water foam sheets
for wx, wy, wz, wrx, wry, wrz in (
    (1.45, .34, 1.08, .58, .36, .48),
    (1.05, .54, 1.24, .52, .48, .44),
    (1.68, .46, .72, .46, .42, .40),
):
    foliage_blob('Waterfall cliff boulder', (wx, wy, wz), (wrx, wry, wrz), stone_plinth, subdivisions=1, smooth=False)
for cx, cy, cz, cw, cd in ((1.18, .44, .98, .42, .34), (1.02, .26, .74, .48, .38), (.88, .11, .48, .56, .42)):
    box('Waterfall cascade spillway sheet', (cx, cy, cz), (cw, .035, cd), water_foam, .006, rot_y=.45)
cylinder('Waterfall splash ripple ring', (.78, .082, .38), .44, .006, water_foam, .46, sides=16)

# 14 Floating Water Lily Pads (Nymphaea) & 6 Blooming Pink/Cream Lotus Flowers
lily_spots = [
    (-1.25, .42, .22), (-.88, .72, .18), (-.52, .35, .20), (-1.42, -.18, .17),
    (.35, -.58, .23), (.72, -.36, .19), (.18, -.88, .18), (.95, -.72, .16),
    (-.22, .88, .21), (.24, .74, .18), (-1.05, -.64, .19), (-.62, -.48, .16),
    (1.25, -.18, .20), (-.12, -.15, .17),
]
for i, (lx, lz, lr) in enumerate(lily_spots):
    cylinder('Floating water lily pad', (lx, .084, lz), lr, .008, tropical_fern if i % 2 == 0 else canopy_mid, lr, sides=12)
    if i % 2 == 0 and i < 12:
        flower_cluster('Blooming lotus flower', (lx, .10, lz), .095, blossom_rose if i % 4 == 0 else blossom_cream, flower_gold, petals=6)

# 6 Swimming Ornamental Koi Fish (orange Kohaku & golden Yamabuki)
for kx, kz, kyaw, k_mat in (
    (-.38, -.12, .4, koi_orange),
    (-.12, .18, .8, flower_gold),
    (.28, .08, -2.2, koi_orange),
    (-.68, -.28, 1.1, koi_orange),
    (.52, -.22, -1.6, flower_gold),
    (.08, -.48, 2.5, koi_orange),
):
    foliage_blob('Swimming koi body', (kx, .076, kz), (.14, .028, .048), k_mat, subdivisions=1, rot=(0, kyaw, 0), smooth=True)
    leaf_blade('Swimming koi tail fin', (kx - math.cos(kyaw) * .13, .078, kz + math.sin(kyaw) * .13), .09, .042, blossom_cream, yaw=kyaw + math.pi / 2, pitch=1.52)

# Marginal aquatic ferns, irises & glowing lakeside stone lantern
fern_clump('Pond bank sword fern', (-1.85, .12, .95), fronds=9, radius=.56, height=.42)
fern_clump('Pond waterfall fern', (1.78, .14, .18), fronds=8, radius=.48, height=.38)
for ix, iz in ((-1.65, 1.18), (-1.35, 1.32), (1.48, 1.32)):
    leaf_fan('Pond water iris blades', (ix, .18, iz), .42, tropical_emerald, yaw=ix, blades=5, pitch_base=.25)
    flower_cluster('Pond purple water iris', (ix, .48, iz), .085, lavender_deep, flower_gold, petals=4)
# Glowing water-edge stone lantern on the west bank
cylinder('Pond lantern pedestal', (-1.92, .18, -.55), .12, .18, stone_plinth, .09, sides=8)
cylinder('Pond lantern glowing core', (-1.92, .34, -.55), .09, .14, lamp_diffuser, .09, sides=8)
cylinder('Pond lantern pagoda roof', (-1.92, .45, -.55), .22, .08, stone_coping, .05, sides=8)


# 29. EXTERIOR GARDEN PERGOLA: architectural cedar & charcoal-steel garden pavilion with climbing wisteria/rose vines & warm LED cove
group('exterior-garden-pergola')
for px in (-1.85, 1.85):
    for pz in (-1.25, 1.25):
        box('Pergola stone column plinth', (px, .12, pz), (.28, .24, .28), stone_plinth, .008)
        box('Pergola steel column', (px, 1.44, pz), (.13, 2.44, .13), steel_charcoal, .006)
        # Climbing vine stems & leaves wrapping each column
        for vy in (.48, .92, 1.38, 1.84, 2.28):
            va = vy * 2.4 + (1 if px > 0 else 0)
            leaf_fan('Pergola climbing vine leaves', (px + math.cos(va) * .11, vy, pz + math.sin(va) * .11), .24, canopy_mid if int(vy * 2) % 2 == 0 else canopy_sun, yaw=va, blades=4)
            if vy > 1.0:
                flower_cluster('Pergola climbing rose', (px + math.cos(va + .6) * .12, vy + .08, pz + math.sin(va + .6) * .12), .075, blossom_rose if px < 0 else flower_coral, flower_gold, petals=5)
# Longitudinal main beams & integrated warm LED cove bars
for pz in (-1.25, 1.25):
    box('Pergola longitudinal beam', (0, 2.68, pz), (4.16, .14, .14), steel_charcoal, .006)
    box('Pergola warm LED cove strip', (0, 2.60, pz + (-.075 if pz > 0 else .075)), (3.52, .022, .022), lamp_diffuser, .002)
# 9 Warm honey-cedar overhead louver rafters
for i in range(9):
    rx = -1.76 + i * .44
    box('Pergola cedar louver rafter', (rx, 2.80, 0), (.075, .12, 3.04), oak_honey if i % 2 == 0 else oak_warm, .005)
# Lush overhead vine canopy & cascading wisteria floral racemes hanging from the rafters (y = 2.25..2.92, clear of head height)
for vx, vz, v_mat, seed in (
    (-1.15, -.55, canopy_mid, 1.1), (-.35, .42, canopy_olive, 2.3),
    (.55, -.38, canopy_sun, 3.5), (1.22, .48, shrub_light, 4.7),
    (0, 0, canopy_mid, 5.9),
):
    foliage_pad('Pergola overhead vine mat', (vx, 2.88, vz), (.68, .14, .58), v_mat, seed=seed, subdivisions=2)
    for ri in range(4):
        ra = seed + ri * 1.57
        hx = vx + math.cos(ra) * .34
        hz = vz + math.sin(ra) * .30
        w_mat = lavender_deep if (ri + int(seed)) % 3 == 0 else (lavender_soft if ri % 2 == 0 else blossom_rose)
        for tier, (ty, tr) in enumerate(((2.68, .065), (2.56, .052), (2.45, .038))):
            foliage_blob('Wisteria hanging floral raceme', (hx, ty, hz), (tr, .068, tr), w_mat, subdivisions=1, smooth=False)


# 30. EXTERIOR CANOPY CLUSTER: bounded LOD used hundreds of times by outer tree batches.
# Keep this below the previous 400-triangle shrub: rich close-up vegetation must not
# multiply the cost of every background crown.
group('exterior-canopy-cluster')
for center, radii, material, seed in (
    ((0, .05, 0), (.90, .68, .86), canopy_deep, .4),
    ((-.38, -.06, .25), (.64, .46, .60), canopy_mid, 1.6),
    ((.38, .14, -.18), (.60, .48, .58), canopy_sun, 2.7),
):
    foliage_pad('Distant lobed canopy cushion', center, radii, material, seed=seed, subdivisions=1)
for i in range(6):
    a = i * math.tau / 6
    leaf_blade('Distant crown silhouette leaf', (math.cos(a) * .70, .04, math.sin(a) * .68), .30, .11, canopy_mid, yaw=a, pitch=.7)

# 31. EXTERIOR GRASS TUFT: bent blade strips, instanced only when visible at close zoom.
group('exterior-grass-tuft')
vertices, faces = [], []
for blade in range(4):
    yaw = blade * math.pi / 4
    c, sn = math.cos(yaw), math.sin(yaw)
    start = len(vertices)
    for x, y, z in ((-.014, 0, 0), (.014, 0, 0), (.008, .045, .008), (-.008, .045, .008), (0, .085, .028)):
        vertices.append(point((x * c + z * sn, y, -x * sn + z * c)))
    faces.extend(((start, start + 1, start + 2), (start, start + 2, start + 3), (start + 3, start + 2, start + 4)))
mesh = bpy.data.meshes.new('Curved architectural turf blades')
mesh.from_pydata(vertices, [], faces)
mesh.update()
obj = bpy.data.objects.new('Bent turf blade clump', mesh)
scene.collection.objects.link(obj)
finish(obj, 'Bent turf blade clump', canopy_mid, smooth=False)


# Merge by material per root; bake all primitive transforms to contract origins.
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
    }

triangles = sum(g['triangles'] for g in manifest.values())
if manifest['exterior-canopy-cluster']['triangles'] > 400:
    raise RuntimeError('Repeated canopy LOD must stay within 400 triangles')
if triangles > 120000:
    raise RuntimeError('Exterior triangle budget exceeded: ' + str(triangles))

# Validate exact seat contact heights and clearance invariants against OUTDOOR_FACILITIES_BLUEPRINT before export
assert abs(manifest['exterior-garden-seat']['max'][1] - .595) < .003
assert abs(manifest['exterior-plinth-bench']['max'][1] - .425) < .003
assert abs(manifest['exterior-picnic-bench']['max'][1] - .465) < .003
assert manifest['exterior-cafe-deck']['max'][1] <= .04
assert manifest['exterior-cafe-kiosk']['max'][2] <= 1.255

bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.gltf(
    filepath=os.path.join(args.output, 'exterior-landscape.glb'),
    export_format='GLB',
    use_selection=True,
    export_yup=True,
    export_materials='EXPORT',
    export_extras=True,
    export_cameras=False,
    export_lights=False,
)
with open(os.path.join(args.output, 'exterior-landscape.manifest.json'), 'w') as output:
    json.dump(
        {
            'groups': manifest,
            'triangles': triangles,
            'meshes': sum(g['meshes'] for g in manifest.values()),
        },
        output,
        indent=2,
    )

# Arrange components into an inspection layout for the saved .blend file
placement = {
    'exterior-shade-tree': (-6.0, 0, -3.0),
    'exterior-ornamental-tree': (-2.2, 0, -3.0),
    'exterior-shrub': (.5, 0, -3.0),
    'exterior-lavender': (2.0, 0, -3.0),
    'exterior-garden-planter': (0, 0, 1.5),
    'exterior-garden-seat': (0, 0, .34),
    'exterior-park-bench': (-5.0, 0, 1.5),
    'exterior-plinth-bench': (5.2, 0, 1.5),
    'exterior-picnic-table': (-3.5, 0, 5.0),
    'exterior-picnic-bench': (-3.5, 0, 5.62),
    'exterior-parasol': (-3.5, 0, 5.0),
    'exterior-patio-table': (2.5, 0, 5.0),
    'exterior-patio-chair': (2.5, 0, 6.25),
    'exterior-walk-lamp': (6.5, 0, -3.0),
    'exterior-bollard-light': (8.0, 0, -3.0),
    'exterior-tree-uplight': (9.2, 0, -3.0),
    'exterior-wayfinding-pylon': (8.5, 0, 1.5),
    'exterior-cafe-kiosk': (-11.0, 0, 2.0),
    'exterior-cafe-deck': (-11.0, 0, 8.0),
    'exterior-festoon-mast': (-6.0, 0, 8.0),
    'exterior-bike-rack': (8.5, 0, 5.5),
    'exterior-bicycle': (8.5, 0, 5.56),
    'exterior-garden-decor': (5.5, 0, -1.0),
    'exterior-columnar-tree': (-11, 0, -6.0),
    'exterior-blossom-tree': (-6.5, 0, -7.0),
    'exterior-flower-bed': (-2.0, 0, -7.0),
    'exterior-tropical-cluster': (1.5, 0, -7.0),
    'exterior-garden-pond': (13.0, 0, -6.0),
    'exterior-garden-pergola': (11.0, 0, 2.5),
    'exterior-canopy-cluster': (4.5, 1.0, -7.0),
    'exterior-grass-tuft': (5.8, 0, -7.0),
}
for name, root in roots.items():
    root.location = point(placement[name])
scene['export_origin_note'] = 'GLB is zero anchored; blend separates components into an inspection arrangement.'
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(args.output, 'exterior-landscape.blend'))
print('EXTERIOR_LIBRARY ' + json.dumps({'roots': list(roots), 'triangles': triangles, 'meshes': sum(g['meshes'] for g in manifest.values())}))

if args.preview:
    # The editable library remains a clean assembly sheet; preview lighting is
    # added after saving and is never exported to the runtime GLB.
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 24
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 1600
    scene.render.resolution_y = 1100
    scene.render.resolution_percentage = 100
    scene.world = bpy.data.worlds.new('Exterior preview world')
    scene.world.color = (.3, .3, .3)
    bpy.ops.mesh.primitive_plane_add(size=60, location=(0, 0, -.03))
    ground = bpy.context.object
    ground.data.materials.append(stone_light)
    bpy.ops.object.light_add(type='AREA', location=(2, -8, 18))
    bpy.context.object.data.energy = 2100
    bpy.context.object.data.shape = 'DISK'
    bpy.context.object.data.size = 16
    bpy.ops.object.light_add(type='SUN', location=(0, 0, 14))
    bpy.context.object.data.energy = 1.7
    bpy.context.object.rotation_euler = (.35, -.25, -.5)
    bpy.ops.object.camera_add(location=(31, 32, 27))
    camera = bpy.context.object
    camera.rotation_euler = (Vector((0, -1, 1.1)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
    camera.data.type = 'ORTHO'
    camera.data.ortho_scale = 37
    scene.camera = camera
    scene.render.filepath = args.preview
    bpy.ops.render.render(write_still=True)
