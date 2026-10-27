"""Build the local interior library in Blender; app X/Y/Z = Blender X/Z/-Y.

Blender --factory-startup --background --python tooling/blender/create-interior-library.py -- --output <directory> --preview <png>
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
parser.add_argument('--output', default=os.path.join(REPO, 'apps/web/local-assets/furniture'))
parser.add_argument('--preview')
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
os.makedirs(args.output, exist_ok=True)
with open(os.path.join(REPO, 'apps/web/src/office/scene/interior/interiorAssetProfile.json')) as source:
    profile = json.load(source)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.unit_settings.system = 'METRIC'
scene['coordinate_system'] = 'app X/Y/Z = Blender X/Z/-Y'
scene['profile'] = json.dumps(profile)


def mat(name, color, roughness=.55, metal=0):
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


oak = mat('Honey oak', 'bd936c', .66)
ivory = mat('Warm ivory powdercoat', 'deded5', .52)
steel = mat('Graphite alloy', '38474b', .34, .65)
dark = mat('Graphite polymer', '263239', .6)
rubber = mat('Soft black rubber', '1b2529', .9)
keymat = mat('Porcelain keycaps', 'cbd5d3', .58)
teal = mat('Muted teal', '518d87', .55)
paper = mat('Warm paper edges', 'f1ecdd', .94)
clay = mat('Terracotta ceramic', 'bb7d62', .57)
blue = mat('Slate blue bookcloth', '536e80', .78)
gold = mat('Ochre details', 'c6a55d', .67)
green = mat('Botanical dark green', '416d50', .75)
leafgreen = mat('Botanical light green', '70916a', .75)
soil = mat('Potting soil', '342d27', 1)
petal = mat('Cream flower petals', 'f4e7ce', .67)
pink = mat('Dusty rose petals', 'cb9693', .65)
light = mat('Desk lamp diffuser', 'fff2d3', .5)
light.node_tree.nodes['Principled BSDF'].inputs['Emission Color'].default_value = (1, .69, .36, 1)
light.node_tree.nodes['Principled BSDF'].inputs['Emission Strength'].default_value = .45

roots = {}
active = None

def point(p):
    return (p[0], -p[2], p[1])


def merge_root(root):
    # Bound scene object count during authoring; tiny parts remain material batches.
    batches={}
    for child in list(root.children):batches.setdefault(child.data.materials[0].name,[]).append(child)
    for material_name,objects in batches.items():
        bpy.ops.object.select_all(action='DESELECT')
        for obj in objects:obj.select_set(True)
        bpy.context.view_layer.objects.active=objects[0]
        if len(objects)>1:bpy.ops.object.join()
        obj=bpy.context.object;obj.name=root.name+' / '+material_name
        bpy.ops.object.transform_apply(location=True,rotation=True,scale=True);obj.parent=root


def group(name):
    global active
    if active is not None:merge_root(active)
    print('INTERIOR_PART '+name, flush=True)
    active = bpy.data.objects.new(name, None)
    scene.collection.objects.link(active)
    active['interior_part'] = name
    roots[name] = active
    return active


def finish(obj, name, material, bevel=0):
    obj.name = name
    obj.data.materials.append(material)
    bpy.context.view_layer.objects.active = obj
    if bevel:
        modifier = obj.modifiers.new('Rounded manufactured edges', 'BEVEL')
        modifier.width = bevel
        modifier.segments = 1 if min(obj.dimensions) < .025 else 2
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    modifier = obj.modifiers.new('Weighted corner normals', 'WEIGHTED_NORMAL')
    modifier.keep_sharp = True
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    obj.parent = active
    return obj


def box(name, center, size, material, bevel=.003):
    bpy.ops.mesh.primitive_cube_add(size=1, location=point(center))
    obj = bpy.context.object
    obj.dimensions = (size[0], size[2], size[1])
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish(obj, name, material, min(bevel, min(size) * .45))


def cylinder(name, center, radius, height, material, radius_top=None, sides=20):
    bpy.ops.mesh.primitive_cone_add(vertices=sides, radius1=radius, radius2=radius if radius_top is None else radius_top,
                                    depth=height, location=point(center))
    return finish(bpy.context.object, name, material, min(.0015, height / 5, radius / 5))


def rod(name, start, end, radius, material, sides=10):
    a, b = Vector(point(start)), Vector(point(end))
    bpy.ops.mesh.primitive_cylinder_add(vertices=sides, radius=radius, depth=(b-a).length, location=(a+b)/2)
    obj = bpy.context.object
    obj.rotation_mode = 'QUATERNION'
    obj.rotation_quaternion = (b-a).to_track_quat('Z', 'Y')
    return finish(obj, name, material)


def ellipsoid(name, center, size, material, direction=None, segments=12, rings=6):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, radius=1, location=point(center))
    obj = bpy.context.object
    obj.scale = (size[0]/2, size[2]/2, size[1]/2)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if direction:
        obj.rotation_mode = 'QUATERNION'
        obj.rotation_quaternion = Vector(point(direction)).to_track_quat('Z', 'Y')
    return finish(obj, name, material)


def arc(name, center, radius, tube, material, start=0, end=math.tau, plane='vertical', steps=32):
    vertices, faces = [], []
    for i in range(steps+1):
        theta = start + (end-start)*i/steps
        for j in range(8):
            phi = math.tau*j/8
            if plane == 'vertical':
                p = (center[0]+(radius+tube*math.cos(phi))*math.cos(theta), center[1]+(radius+tube*math.cos(phi))*math.sin(theta), center[2]+tube*math.sin(phi))
            else:
                p = (center[0]+(radius+tube*math.cos(phi))*math.cos(theta), center[1]+tube*math.sin(phi), center[2]+(radius+tube*math.cos(phi))*math.sin(theta))
            vertices.append(point(p))
    for i in range(steps):
        for j in range(8):
            a=i*8+j; b=i*8+(j+1)%8
            faces.append((a,b,b+8,a+8))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj=bpy.data.objects.new(name, mesh)
    scene.collection.objects.link(obj)
    return finish(obj,name,material)


def book(x, width, height, depth, color, base=0, z=0):
    box('Cloth book spine', (x,base+height/2,z+depth/2), (width,height,.007), color,.002)
    box('Page block', (x,base+height/2,z-.002), (width-.005,height-.008,depth-.006), paper,.001)
    for side in (-1,1):
        box('Hard book cover', (x+side*(width/2-.001),base+height/2,z), (.002,height,depth),color,.0008)
    for y in (.19,.76):
        box('Foil book title band', (x,base+height*y,z+depth/2+.004), (width*.64,.003,.001), gold,.0003)


# Interior finishes share the workstation palette and named dynamic lenses.
upholstery=mat('Muted teal upholstery','518d87',.72)
walnut=mat('Oiled walnut','625044',.67)
brass=mat('Satin brass','bd9d69',.33,.72)
linen=mat('Soft woven linen','d9cbb5',.9)
cyan=mat('Server LED cyan','48b5c2',.3)
status=mat('Server LED green','58c68a',.32)
amber=mat('Server LED amber','dfa45c',.36)
for material in (cyan,status,amber):
    n=material.node_tree.nodes['Principled BSDF']; n.inputs['Emission Color'].default_value=material.diffuse_color;n.inputs['Emission Strength'].default_value=.8


def cup(x,y,z,color=ivory,scale=1):
    cylinder('Ceramic coffee cup',(x,y+.043*scale,z),.033*scale,.086*scale,color,.041*scale,sides=16)
    cylinder('Visible dark coffee',(x,y+.087*scale,z),.035*scale,.002*scale,walnut,sides=16)
    arc('Cup loop handle',(x+.043*scale,y+.05*scale,z),.023*scale,.005*scale,color,steps=12)
    cylinder('Cup saucer',(x,y+.004*scale,z),.06*scale,.008*scale,color,sides=20)


def bottle(x,y,z,color=green,h=.28):
    cylinder('Bottle body',(x,y+h*.35,z),.038,h*.7,color,.035,sides=12)
    cylinder('Bottle shoulder',(x,y+h*.77,z),.035,h*.14,color,.018,sides=12)
    cylinder('Bottle neck',(x,y+h*.91,z),.018,h*.18,color,sides=12)
    cylinder('Bottle cork',(x,y+h+.006,z),.019,.012,brass,sides=12)
    box('Bottle paper label',(x,y+h*.36,z+.039),(.048,h*.23,.002),paper,.001)


def vase(x,y,z,color=clay,scale=1):
    cylinder('Thrown ceramic vase',(x,y+.12*scale,z),.105*scale,.24*scale,color,.065*scale)
    cylinder('Vase neck',(x,y+.267*scale,z),.047*scale,.055*scale,color)
    cylinder('Vase dark opening',(x,y+.296*scale,z),.038*scale,.002,walnut)
    arc('Vase rolled lip',(x,y+.295*scale,z),.046*scale,.006*scale,color,plane='horizontal',steps=20)


def cabinet(w,h,d):
    box('Recessed toe kick',(0,.055,0),(w-.12,.11,d-.10),dark,.012)
    box('Oak cabinet carcass',(0,(h+.035)/2,0),(w,h-.145,d),walnut,.012)
    for x in (-w/4,w/4):
        box('Ivory inset cabinet door',(x,h/2+.015,d/2+.004),(w/2-.025,h-.15,.022),ivory,.008)
        hx=x+(.15 if x<0 else -.15)
        rod('Satin metal cabinet pull',(hx,h*.43,d/2+.032),(hx,h*.59,d/2+.032),.007,steel)
    box('Thick oak cabinet cap',(0,h-.0275,0),(w+.06,.055,d+.05),oak,.012)

group('storage-cabinet');cabinet(1.6,1.1375,.48)
# Bookcase variants keep a full-height open approach from local +Z.
def bookshelf(open_back=False):
    group('bookshelf-open' if open_back else 'bookshelf')
    w=2.2;h=2.25
    if not open_back:box('Recessed walnut back',(0,1.125,-.1875),(w-.18,h,.055),walnut,.008)
    for x in (-1.055,1.055):box('Oak end stile',(x,h/2,0),(.09,h,.43),walnut,.012)
    for j,y in enumerate((.28,.91,1.54,2.2125)):
        box('Solid oak shelf',(0,y,0 if open_back else .0275),(w-.18,.075,.43 if open_back else .375),oak,.008)
        if j<3:
            for i in range(12):
                color=(teal,clay,blue,gold,ivory)[(i+j*2)%5]
                x=-.92+i*.166; height=.37+((i*7+j*3)%4)*.035
                if i in (4,9):
                    if i==4:box('Linen archive box',(x+.04,y+.18,0),(.25,.28,.29),linen,.008)
                    continue
                book(x,.095+(i%3)*.01,height,.25,color,base=y+.038,z=.025)
                if open_back:
                    box('Reverse cloth book spine',(x,y+.038+height/2,-.102),(.095+(i%3)*.01,height,.007),color,.002)
                    for band in (.19,.76):box('Reverse foil title band',(x,y+.038+height*band,-.107),(.06,.003,.001),gold,.0003)
    for x in (-.86,.86):box('Bookcase plinth pad',(x,.025,0),(.24,.05,.37),steel,.008)
bookshelf();bookshelf(True)

group('display-cabinet')
w=3.8
box('Walnut display back',(0,1.1,-.2225),(w-.20,2.2,.055),walnut,.009)
for x in (-1.85,1.85):box('Display cabinet end',(x,1.1,0),(.1,2.2,.5),walnut,.012)
for y in (.07,.77,1.48,2.1625):box('Display oak shelf',(0,y,.0275),(w-.20,.075,.445),oak,.008)
for x in (-w/6,w/6):box('Display mullion',(x,1.1,-.025),(.045,2.10,.4),walnut,.005)
for i in range(7):
    x=-1.5+i*.5
    box('Linen archive file',(x,.39,.015),(.25,.53,.28),teal if i%2 else linen,.008)
    box('Archive label',(x,.42,.158),(.12,.045,.004),paper,.003)
    box('Archive pull',(x,.31,.165),(.045,.018,.009),brass,.003)
for x in (-.95,.95):
    box('Presentation storage box',(x,1.06,0),(.48,.42,.27),linen,.01)
    box('Presentation lid',(x,1.276,0),(.50,.025,.29),ivory,.005)
for i,x in enumerate((-1.25,0,1.25)):vase(x,1.52,.02,teal if i!=1 else ivory,.9)
for x in (-1.67,-.43,.44,1.68):
    rod('Slim shelf brass bookend',(x,1.52,.02),(x,1.9,.02),.004,brass)
box('Display upper warm lens',(0,2.116,.17),(3.52,.009,.012),light,.001)

group('coffee-table')
box('Rounded oak coffee tabletop',(0,.38,0),(1.25,.07,.7),oak,.025)
box('Walnut recessed apron',(0,.315,0),(1.16,.045,.61),walnut,.009)
box('Lower woven shelf',(0,.14,0),(1.03,.035,.48),linen,.01)
for x in (-.49,.49):
    for z in (-.23,.23):
        rod('Coffee table steel leg',(x,.01,z),(x,.35,z),.022,steel)
        cylinder('Coffee table glide',(x,.008,z),.026,.016,rubber)
box('Coffee table book pages',(-.27,.435,.04),(.35,.03,.25),paper,.003)
for y in (.418,.452):box('Coffee table book cover',(-.27,y,.04),(.36,.004,.26),teal,.002)
cup(.32,.415,-.08,ivory,1.1)

group('console-table')
box('Rounded console top',(0,.79,0),(1.6,.06,.42),oak,.017)
for x in (-.69,.69):
    for z in (-.14,.14):rod('Console slender leg',(x,0,z),(x,.76,z),.018,steel)
box('Console lower shelf',(0,.23,0),(1.45,.025,.34),walnut,.006)
for x in (-.43,.43):
    box('Console shallow drawer',(x,.697,.01),(.77,.13,.36),ivory,.006)
    rod('Console drawer pull',(x-.08,.71,.2),(x+.08,.71,.2),.005,brass)
vase(.54,.82,0,clay,.65)
box('Console linen book',(-.38,.84,0),(.36,.04,.25),linen,.004)
box('Console teal book',(-.34,.87,0),(.30,.02,.22),teal,.004)

# Multifunction copier with scanner, ADF, duplex path and document handling.
group('copier')
for x in (-.32,.32):
    for z in (-.27,.27):cylinder('Copier caster',(x,.035,z),.035,.07,rubber)
box('Copier lower chassis',(0,.54,0),(.82,1.01,.72),ivory,.025)
box('Graphite lower plinth',(0,.11,0),(.8,.13,.70),dark,.014)
for i in range(3):
    y=.23+i*.20
    box('Paper cassette face',(0,y,.369),(.74,.18,.022),keymat,.009)
    box('Paper cassette finger well',(0,y+.03,.384),(.23,.028,.013),dark,.006)
    box('Cassette paper size label',(.25,y-.035,.382),(.10,.025,.003),paper,.001)
box('Paper output recess',(-.07,.855,.369),(.53,.16,.015),dark,.006)
box('Printed document stack',(-.07,.8,.397),(.43,.018,.21),paper,.002)
box('Scanner bed',(0,1.055,-.02),(.80,.055,.68),steel,.012)
box('Scanner glass',(0,1.085,-.025),(.63,.008,.51),teal,.004)
box('Document feeder lid',(-.025,1.155,-.04),(.74,.13,.62),dark,.018)
box('Ivory ADF cover',(-.09,1.211,-.07),(.56,.035,.50),ivory,.009)
box('ADF input paper',(-.09,1.234,-.07),(.39,.012,.42),paper,.002)
box('ADF paper rail',(.235,1.244,-.04),(.035,.05,.5),keymat,.004)
box('Folded control console',(.205,1.19,.325),(.29,.12,.07),steel,.014)
box('Touch control lens',(.18,1.204,.364),(.19,.075,.006),cyan,.003)
for i in range(3):cylinder('Copier tactile button',(.31,1.165+i*.023,.371),.007,.006,teal,sides=12)
for i in range(9):box('Side ventilation grille',(.412,.84,-.24+i*.035),(.003,.095,.012),dark,.001)
box('Side bypass paper tray',(-.455,.78,.02),(.09,.035,.48),steel,.008)

group('print-supply-cabinet');cabinet(.99,.96,.57)
group('printer')
box('Desktop printer chassis',(0,.15,0),(.58,.30,.46),steel,.015)
box('Printer scanner lid',(0,.335,-.03),(.46,.1,.34),ivory,.012)
box('Printer output mouth',(0,.16,.234),(.4,.055,.012),rubber,.003)
box('Printer paper tray',(0,.055,.27),(.42,.02,.22),keymat,.004)
box('Printer output paper',(0,.071,.27),(.35,.008,.20),paper,.001)
box('Printer small lens',(.18,.28,.235),(.085,.04,.005),cyan,.002)
group('recycle-bin')
cylinder('Recycling bin body',(0,.31,0),.20,.60,teal,.24,sides=20)
cylinder('Bin dark open top',(0,.614,0),.217,.009,dark,sides=20)
arc('Bin rolled rim',(0,.615,0),.235,.012,steel,plane='horizontal')
for i in range(3):box('Recycling simple raised mark',((i-1)*.045,.36,.220),(.025,.07,.007),ivory,.003)

# Front pantry bar preserves the blueprint footprint and service aisle.
group('bar-counter')
box('Recessed bar plinth',(0,.055,0),(4.08,.11,.62),dark,.012)
box('Walnut bar carcass',(0,.575,0),(4.2,1.05,.7),walnut,.016)
box('Fluted walnut front',(0,.55,.36),(4.16,1.06,.03),walnut,.008)
for i in range(58):box('Individual oak front flute',(-2.02+i*4.04/57,.55,.383),(.034,1.02,.023),oak,.007)
box('Ivory stone service top',(0,1.12,.02),(4.4,.06,.9),ivory,.022)
box('Raised oak transaction ledge',(0,1.16,.25),(4.2,.03,.35),oak,.009)
box('Warm underledge lens',(0,1.105,.409),(4.1,.012,.014),light,.002)
rod('Brass guest foot rail',(-2,.22,.48),(2,.22,.48),.025,brass,16)
for x in (-1.8,-.9,0,.9,1.8):rod('Footrail support',(x,.03,.36),(x,.22,.48),.014,steel)
box('Serving tray',(.65,1.163,-.10),(.42,.025,.25),walnut,.015)
cup(.55,1.18,-.1);cup(.78,1.18,-.1,teal)
box('Upright bar menu',(-1.7,1.28,.1),(.18,.24,.025),walnut,.006)
box('Chalk menu inset',(-1.7,1.28,.115),(.15,.20,.003),dark,.001)
for j in range(4):box('Menu raised chalk line',(-1.7,1.34-j*.035,.118),(.10-(j%2)*.03,.006,.002),paper,.0005)
cylinder('Pastry serving platter',(1.48,1.167,0),.17,.025,ivory,sides=24)
for x,z in ((1.43,-.04),(1.53,.03),(1.44,.06)):
    ellipsoid('Fresh pastry',(x,1.205,z),(.10,.06,.07),gold)
    box('Pastry glaze',(x,1.229,z),(.06,.004,.025),linen,.002)

group('bar-back')
box('Back bar toe kick',(0,.04,-.06),(4.28,.08,.43),dark,.01)
box('Walnut prep cabinet',(0,.49,-.06),(4.4,.86,.53),walnut,.015)
for i in range(6):
    x=-1.825+i*.73
    box('Inset prep cabinet door',(x,.48,.213),(.70,.76,.018),dark if i==3 else walnut,.007)
    rod('Prep cabinet handle',(x+.22,.54,.235),(x+.22,.70,.235),.006,brass)
box('Stone prep worktop',(0,.93,-.06),(4.44,.05,.58),dark,.012)
box('Walnut backsplash',(0,1.95,-.32),(4.4,2.0,.04),walnut,.009)
for i in range(42):box('Back bar narrow oak slat',(-2.13+i*4.26/41,1.95,-.292),(.025,1.91,.014),oak,.004)
for y in (1.45,1.95,2.45):
    box('Brass edged display shelf',(0,y,-.15),(4.2,.04,.32),oak,.007)
    box('Shelf underlight',(0,y-.023,-.012),(4.05,.007,.012),light,.001)
for x in (-1.9,-.7,.7,1.9):box('Slim black shelf upright',(x,1.95,-.15),(.025,1.1,.3),steel,.004)
for i,x in enumerate((-1.6,-1.3,-1,-.3,0,.3,1.1,1.4,1.7)):
    bottle(x,1.47,-.15,(clay,green,blue,gold,teal)[i%5],.24+(i%3)*.035)
for i,x in enumerate((-1.5,-1.1,-.7,.8,1.2,1.6)):
    cylinder('Tea and bean canister',(x,2.07,-.15),.07,.20,linen if i%2 else walnut,sides=16)
    cylinder('Canister brass lid',(x,2.176,-.15),.075,.016,brass,sides=16)
    box('Canister paper label',(x,2.07,-.077),(.08,.065,.003),paper,.002)
for x in (-1.5,-1.15,-.8):
    for j in range(4):cylinder('Stacked porcelain plates',(x,2.483+j*.012,-.15),.12,.009,ivory,sides=20)
for x in (.8,1.2,1.6):vase(x,2.47,-.15,teal,.65)
# Prep props, leaving the separately authored coffee machine placement open at x=-1.2.
cup(-.65,.957,.02);cup(.5,.957,.02);cup(.75,.957,.02,teal)
vase(-.3,.957,0,brass,.7)
rod('Kettle short spout',(-.26,1.08,.02),(-.16,1.15,.02),.025,brass)
arc('Kettle handle',(-.39,1.11,0),.07,.011,dark,steps=16)
box('Prep chopping board',(.16,.966,-.10),(.32,.018,.25),oak,.015)
box('Prep tray',(-1.95,.972,.015),(.35,.027,.27),steel,.012)
for j in range(3):box('Folded service towel',(-1.95,.995+j*.012,.015),(.25,.012,.18),linen,.002)
# Open inset sink: dark basin below a metal rim, with no opaque slab across it.
box('Sink recessed basin',(1.4,.948,0),(.49,.01,.36),steel,.022)
for x in (1.13,1.67):box('Sink rim side',(x,.960,0),(.028,.016,.43),keymat,.006)
for z in (-.202,.202):box('Sink rim end',(1.4,.960,z),(.55,.016,.028),keymat,.006)
rod('Faucet riser',(1.4,.96,-.16),(1.4,1.14,-.16),.016,keymat)
arc('Gooseneck faucet',(1.4,1.14,-.06),.10,.016,keymat,0,math.pi,steps=20)
rod('Faucet outlet',(1.50,1.14,-.06),(1.50,1.09,-.06),.016,keymat)

group('coffee-machine')
box('Espresso machine main chassis',(0,.26,-.025),(.42,.52,.33),steel,.02)
box('Espresso front fascia',(0,.35,.153),(.39,.24,.025),ivory,.009)
box('Espresso drip tray',(0,.035,.045),(.42,.04,.29),steel,.007)
for i in range(10):box('Drip tray slots',(-.17+i*.038,.057,.085),(.018,.003,.17),dark,.001)
box('Group head',(0,.23,.175),(.12,.07,.045),keymat,.01)
rod('Portafilter handle',(0,.205,.19),(.12,.205,.26),.015,walnut)
for x in (-.11,.11):
    cylinder('Espresso tactile dial',(x,.39,.177),.023,.018,brass,sides=16)
    box('Espresso control button',(x,.46,.174),(.035,.025,.006),teal,.003)
rod('Steam wand',(.16,.29,.17),(.18,.12,.22),.006,keymat)
box('Cup warming top',(0,.518,-.01),(.37,.008,.28),brass,.004)
cup(-.10,.524,-.04,ivory,.65);cup(.09,.524,-.04,ivory,.65)

group('stemware-rack')
for z in (-.23,.23):box('Stemware longitudinal frame',(0,0,z),(3.8,.06,.04),steel,.007)
for x in (-1.88,1.88):box('Stemware end frame',(x,0,0),(.04,.06,.5),steel,.007)
for x in (-1.4,-1,-.6,.6,1,1.4):
    cylinder('Hanging glass foot',(x,-.04,0),.045,.008,keymat,sides=16)
    rod('Hanging glass stem',(x,-.05,0),(x,-.11,0),.006,keymat)
    cylinder('Hanging glass bowl',(x,-.15,0),.045,.08,keymat,.014,sides=16)
box('Stemware warm underside lens',(0,-.035,0),(3.6,.01,.16),light,.002)

group('bar-stool-base')
cylinder('Weighted swivel stool base',(0,.02,0),.25,.04,steel,sides=32)
cylinder('Stool rubber base sole',(0,.004,0),.245,.008,rubber,sides=32)
cylinder('Stool gas lift',(0,.35,0),.035,.65,steel,sides=20)
cylinder('Stool lift sleeve',(0,.17,0),.045,.27,dark,sides=20)
arc('Stool fixed brass footrest',(0,.26,0),.18,.013,brass,plane='horizontal')
for x in (-.14,.14):rod('Footrest spoke',(0,.26,0),(x,.26,.11),.009,steel)
# Relative to the .72 m upper swivel pivot; seat top remains .76 m.
group('bar-stool-seat')
cylinder('Stool oak seat pan',(0,-.035,0),.238,.025,walnut,sides=32)
cylinder('Stool teal upholstered cushion',(0,.005,0),.24,.07,upholstery,sides=32)
arc('Cushion stitched welt',(0,.027,0),.235,.0025,linen,plane='horizontal')
for x in (-.145,.145):rod('Stool low back upright',(x,-.025,-.155),(x,.17,-.18),.009,steel)
box('Rounded low lumbar cushion',(0,.125,-.165),(.34,.16,.055),upholstery,.025)

# Rack floor origin converts the former center origin by +1.09 in asset coordinates.
group('server-rack')
off=1.09
for x in (-.47,.47):box('Rack structural side',(x,off,0),(.075,2.18,1.02),steel,.009)
for y in (-.99,1.04):box('Rack top bottom cap',(0,off+y,0),(1,.09,1.02),dark,.01)
box('Rack rear equipment backing',(0,off,-.47),(.82,2,.035),dark,.008)
for x in (-.38,.38):
    for z in (-.4,.4):cylinder('Locking rack caster',(x,.055,z),.055,.11,rubber,sides=16)
for j in range(7):
    y=off-.76+j*.25
    box('Server chassis',(0,y,.29),(.78,.205,.80),steel,.008)
    box('Recessed server face',(0,y,.711),(.76,.17,.025),dark,.004)
    # Open-looking ventilation grid is inset within the silver frame.
    for i in range(11):
        x=-.31+i*.039
        for k in range(3):box('Server perforated ventilation slot',(x,y-.05+k*.05,.727),(.025,.026,.003),rubber,.001)
    for x in (-.355,.355):
        rod('Server removable tray pull',(x,y-.045,.745),(x,y+.045,.745),.008,keymat)
    for x in (.15,.22):
        box('Drive caddy face',(x,y,.733),(.055,.12,.012),walnut,.003)
        box('Drive caddy latch',(x,y-.025,.742),(.035,.012,.006),keymat,.002)
    box('Green server power lens',(.295,y+.035,.744),(.019,.018,.009),status,.002)
    box('Cyan server activity lens',(.295,y,.744),(.019,.012,.009),cyan,.002)
    if j in (1,4):box('Amber server service lens',(.295,y-.035,.744),(.019,.012,.009),amber,.002)
    # Clearly readable colored patch leads on the rear, no front glass occlusion.
    for k in range(3):
        x=-.24+k*.18
        rod('Rear colored patch lead',(x,y,-.49),(x+.025,y-.12,-.55),.007,(teal,clay,gold)[k])
        rod('Rear cable return',(x+.025,y-.12,-.55),(x+.10,y-.18,-.49),.007,(teal,clay,gold)[k])
for x in (-.43,.43):
    rod('Rack front handle',(x,off-.26,.525),(x,off+.26,.525),.016,keymat)
    for y in (.35,1.1,1.8):box('Rack bolt',(x,y,.516),(.025,.025,.004),keymat,.003)
box('Rack roof ventilation panel',(0,2.195,0),(.55,.035,.56),steel,.009)
for i in range(9):box('Roof exhaust slit',(-.21+i*.052,2.214,0),(.022,.002,.43),rubber,.001)
# Entertainment furniture is independent of all runtime screen planes.
group('tv-console')
box('Walnut media cabinet',(0,.40,0),(3.1,.64,.64),walnut,.022)
box('Media oak top',(0,.735,0),(3.1,.03,.64),oak,.01)
for x in (-1.0,1.0):
    box('Sliding ivory media door',(x,.40,.326),(.96,.54,.025),ivory,.012)
    for i in range(12):box('Media front vertical groove',(x-.40+i*.073,.4,.341),(.008,.46,.003),linen,.001)
    rod('Media brass pull',(x-.15,.46,.350),(x+.15,.46,.350),.005,brass)
box('Media open shelf backing',(0,.4,.235),(.93,.49,.02),dark,.004)
box('Media center shelf',(0,.37,.10),(.94,.025,.4),oak,.005)
for x in (-1.35,1.35):
    for z in (-.21,.21):box('Media cabinet foot',(x,.045,z),(.075,.09,.075),steel,.009)
box('Media warm underlight',(0,.075,.28),(2.8,.009,.012),light,.002)
box('Receiver in open media bay',(0,.47,.10),(.53,.12,.26),steel,.007)
for i in range(5):box('Receiver face vent',(-.13+i*.04,.47,.235),(.015,.06,.004),dark,.001)
box('Receiver activity lens',(.2,.47,.237),(.04,.01,.003),cyan,.001)
group('tv-housing')
box('TV sculpted rear shell',(0,0,-.015),(3.1,1.75,.05),dark,.024)
for x in (-1,1):box('TV slim side bezel',(x*1.519,0,.02),(.062,1.75,.04),dark,.008)
for y in (-1,1):box('TV slim horizontal bezel',(0,y*.837,.02),(3.1,.076,.04),dark,.008)
box('TV bottom brand lozenge',(0,-.851,.042),(.06,.007,.004),brass,.001)
for i in range(20):box('TV rear cooling slit',(-.76+i*.08,.51,-.042),(.035,.1,.003),rubber,.001)
box('Wall VESA mount',(0,0,-.058),(.45,.4,.044),steel,.009)

group('game-console')
box('Vertical game console core',(0,.21,0),(.10,.40,.29),dark,.018)
for side in (-1,1):
    obj=box('Sculpted ivory console fin',(side*.056,.22,-.006),(.038,.40,.32),ivory,.016)
    obj.rotation_euler.y=side*.045
box('Console top ventilation',(0,.416,-.005),(.054,.008,.25),rubber,.003)
for i in range(8):box('Console top vent rib',(0,.419,-.108+i*.03),(.067,.003,.006),steel,.001)
box('Console blue status seam',(.041,.24,.154),(.004,.29,.003),cyan,.001)
box('Console disc slot',(-.04,.17,.162),(.006,.18,.003),rubber,.001)
cylinder('Console pedestal',(0,.009,0),.09,.018,steel,sides=24)

group('game-controller')
ellipsoid('Ergonomic ivory controller body',(0,0,0),(.15,.042,.085),ivory,segments=24,rings=12)
for side in (-1,1):
    ellipsoid('Controller palm grip',(side*.054,-.004,.027),(.051,.047,.077),ivory,(side*.15,-.12,.7),segments=16,rings=8)
box('Controller graphite touchpad',(0,.022,-.016),(.056,.006,.035),dark,.007)
for x in (-.022,.022):
    cylinder('Analog stick rubber well',(x,.021,.015),.013,.008,dark,sides=16)
    cylinder('Analog thumb stick',(x,.029,.015),.010,.008,rubber,sides=16)
for i in range(4):
    a=i*math.pi/2
    cylinder('Controller face button',(.051+.010*math.sin(a),.025,-.012+.010*math.cos(a)),.004,.005,(teal,clay,blue,gold)[i],sides=12)
box('Controller cross horizontal',(-.049,.026,-.013),(.023,.006,.007),dark,.0015)
box('Controller cross vertical',(-.049,.026,-.013),(.007,.006,.023),dark,.0015)
for x in (-.05,.05):box('Controller shoulder bumper',(x,.009,-.046),(.035,.017,.014),dark,.004)
box('Controller narrow light bar',(0,.026,-.036),(.040,.003,.003),cyan,.001)

# Custom arcade wedge sidewalls leave both display apertures completely open.
def prism(name,points,width,material):
    verts=[point((x,y,z)) for x in (-width/2,width/2) for y,z in points];n=len(points)
    faces=[tuple(reversed(range(n))),tuple(range(n,n*2))]
    for i in range(n):faces.append((i,(i+1)%n,(i+1)%n+n,i+n))
    mesh=bpy.data.meshes.new(name);mesh.from_pydata(verts,[],faces);mesh.update()
    obj=bpy.data.objects.new(name,mesh);scene.collection.objects.link(obj);return finish(obj,name,material,.006)
group('arcade-shell')
shape=[(0,-.33),(1.8,-.33),(1.8,.30),(1.69,.35),(1.25,.35),(.95,.32),(.8,.39),(.73,.39),(.68,.30),(0,.30)]
for side in (-1,1):
    obj=prism('Sculpted arcade sidewall',shape,.045,walnut);obj.location.x=side*.3675
    for y in (.13,.58,1.72):box('Arcade brass trim',(side*.391,y,.10),(.007,.018,.37),brass,.003)
box('Arcade rear shell',(0,.9,-.305),(.69,1.8,.05),dark,.012)
box('Arcade lower cabinet',(0,.35,.0),(.69,.70,.58),dark,.014)
box('Arcade kick plate',(0,.09,.308),(.66,.14,.018),steel,.006)
box('Arcade coin door',(0,.42,.309),(.24,.26,.018),steel,.009)
box('Coin acceptor slot',(-.05,.47,.322),(.015,.06,.007),brass,.002)
box('Coin return button',(.06,.47,.323),(.04,.04,.009),teal,.003)
# Black backing is behind the runtime screen, never across its front.
box('Arcade screen rear support',(0,1.08,.29),(.67,.49,.05),dark,.008)
for x in (-.323,.323):box('Arcade display side bezel',(x,1.08,.325),(.036,.49,.03),dark,.005)
for y in (.848,1.312):box('Arcade display horizontal bezel',(0,y,.325),(.67,.035,.03),dark,.004)
box('Arcade marquee backing',(0,1.48,.28),(.69,.44,.05),dark,.007)
box('Arcade control deck',(0,.76,.40),(.69,.1,.28),steel,.013)
for x in (-.20,.08):
    cylinder('Arcade joystick socket',(x,.816,.41),.031,.009,rubber,sides=16)
    rod('Arcade joystick shaft',(x,.82,.41),(x,.87,.41),.006,keymat)
    ellipsoid('Arcade joystick ball',(x,.885,.41),(.045,.045,.045),teal)
for x in (-.08,.20):
    for j in range(3):cylinder('Arcade action button',(x+(j%2)*.037,.819,.46-(j//2)*.04),.012,.012,clay if x<0 else teal,sides=16)
box('Arcade bottom accent lens',(0,.08,.321),(.66,.015,.006),cyan,.002)

group('foosball-table')
for x in (-.7,.7):
    for z in (-.45,.45):
        box('Foosball steel leg',(x,.40,z),(.09,.78,.09),steel,.012)
        box('Foosball levelling foot',(x,.02,z),(.12,.04,.12),rubber,.009)
box('Foosball walnut apron',(0,.83,0),(1.64,.19,1.14),walnut,.023)
box('Foosball green pitch',(0,.935,0),(1.44,.022,.94),green,.008)
for x in (-.78,.78):box('Pitch end rail',(x,.99,0),(.08,.15,1.14),oak,.008)
for z in (-.53,.53):box('Pitch side rail',(0,.99,z),(1.55,.15,.08),oak,.008)
for x in (-.58,.58):
    box('Goal opening',(x,.962,0),(.045,.06,.23),rubber,.004)
    for j in range(8):cylinder('Score counter bead',(x,1.09,-.35+j*.04),.013,.028,teal if x<0 else clay,sides=12)
box('Center pitch line',(0,.949,0),(.007,.002,.88),paper,.0005)
arc('Pitch center circle',(0,.950,0),.13,.003,paper,plane='horizontal',steps=24)
for row,x in enumerate((-.50,-.28,0,.28,.50)):
    rod('Foosball horizontal player rod',(x,1.04,-.76),(x,1.04,.76),.012,keymat,12)
    side=-1 if row%2 else 1
    rod('Foosball rubber handgrip',(x,1.04,side*.63),(x,1.04,side*.82),.024,rubber,12)
    for z in ((0,) if row in (0,4) else (-.28,0,.28)):
        color=teal if row%2 else clay
        cylinder('Foosball player head',(x,1.08,z),.027,.05,color,sides=10)
        box('Foosball player jersey',(x,1.005,z),(.065,.10,.055),color,.005)
        box('Foosball player kick foot',(x,.959,z),(.08,.025,.07),dark,.004)
ellipsoid('Foosball ball',(.12,.965,.19),(.035,.035,.035),paper)

# Fitness equipment: clear walk surfaces, padded contact heights and discrete mechanisms.
group('treadmill-frame')
box('Treadmill steel deck',(0,.10,0),(1.4,.03,1.95),steel,.018)
for x in (-.61,.61):
    box('Treadmill side step',(x,.123,0),(.17,.016,1.84),dark,.006)
    for j in range(13):box('Side step traction rib',(x,.133,-.77+j*.128),(.13,.004,.006),rubber,.001)
    rod('Treadmill silver upright',(x,.11,-.75),(x,1.11,-.61),.026,keymat,12)
    rod('Treadmill padded hand rail',(x,.93,-.55),(x,.93,.30),.026,dark,16)
    box('Deck floor glide',(x,.053,.78),(.16,.09,.17),rubber,.015)
box('Treadmill motor cover',(0,.18,-.81),(.98,.10,.29),dark,.03)
# Console retains the exact position/tilt for live runtime display and station lens.
console=box('Treadmill console chassis',(0,1.08,-.65),(.81,.29,.08),steel,.015)
console.rotation_euler.x=-.48
for x in (-.315,.315):
    # Cup holders remain outside the central live display aperture.
    cylinder('Treadmill cup holder',(x,1.145,-.64),.055,.025,dark,sides=20)
    cylinder('Treadmill cup holder opening',(x,1.159,-.64),.043,.003,rubber,sides=20)
box('Emergency stop key',(0,.96,-.574),(.045,.026,.02),clay,.004)
group('treadmill-belt')
box('Running belt',(0,.122,0),(1.08,.012,1.78),rubber,.007)
# Subtle continuous edge stitch leaves runtime moving center stripes visible.
for x in (-.517,.517):box('Belt edge seam',(x,.1285,0),(.003,.001,1.72),dark,.0003)

group('bike-frame')
for z in (-.45,.45):
    box('Cycle transverse stabilizer',(0,.06,z),(.62,.1,.12),steel,.015)
    for x in (-.28,.28):box('Cycle rubber stabilizer cap',(x,.059,z),(.065,.105,.127),rubber,.01)
rod('Flywheel axle',(-.11,.39,0),(.11,.39,0),.32,steel,32)
rod('Flywheel teal inset',(-.119,.39,0),(-.115,.39,0),.262,teal,32)
rod('Flywheel graphite center',(-.124,.39,0),(-.121,.39,0),.20,dark,24)
rod('Cycle rear diagonal',(0,.10,.40),(0,.72,.25),.032,steel,12)
rod('Cycle chrome seat post',(0,.55,.25),(0,.83,.28),.025,keymat,12)
box('Cycle saddle',(0,.84,.28),(.30,.08,.32),dark,.035)
box('Saddle teal top stitch',(0,.88,.28),(.26,.004,.27),teal,.022)
rod('Cycle front rising frame',(0,.11,-.38),(0,1.22,-.08),.03,steel,12)
rod('Cycle handlebar crossbar',(-.285,1.22,-.08),(.285,1.22,-.08),.027,dark,16)
for x in (-.24,.24):rod('Cycle handle grip',(x,1.22,-.10),(x,1.22,.05),.029,rubber,16)
box('Cycle resistance dial',(0,.73,-.23),(.09,.035,.09),brass,.012)
group('bike-crank')
for side in (-1,1):
    rod('Cycle chrome crank arm',(side*.2,0,0),(side*.2,side*.18,0),.017,keymat,12)
group('bike-pedal')
box('Cycle pedal',(0,0,0),(.17,.035,.13),rubber,.006)
for j in range(4):box('Pedal traction rib',(0,.022,-.045+j*.03),(.12,.005,.007),steel,.001)


def dumbbell_at(x,y,z,scale=1):
    rod('Knurled dumbbell grip',(x-.15*scale,y,z),(x+.15*scale,y,z),.025*scale,keymat,12)
    for side in (-1,1):
        rod('Hex dumbbell head',(x+side*.1075*scale,y,z),(x+side*.1925*scale,y,z),.11*scale,dark,8)
        rod('Dumbbell metal end cap',(x+side*.1926*scale,y,z),(x+side*.195*scale,y,z),.046*scale,steel,12)
    for i in range(6):arc('Dumbbell grip knurl',(x-.06*scale+i*.024*scale,y,z),.0255*scale,.0008*scale,steel,steps=12)

group('dumbbell-rack')
for x in (-1.1,1.1):
    box('Weight rack end frame',(x,.46,0),(.075,.92,.55),steel,.015)
    box('Weight rack nonslip foot',(x,.025,0),(.14,.05,.59),rubber,.009)
for level,y in enumerate((.42,.79)):
    box('Weight rack oak tray',(0,y,0),(2.4,.05,.4),steel,.009)
    for z in (-.19,.19):box('Weight tray retaining rail',(0,y+.04,z),(2.4,.06,.025),dark,.004)
    for x in (-.90,-.45,0,.45,.90):dumbbell_at(x,y+.14,0,.85 if level==0 else 1)

def bench(back):
    group('strength-bench' if back else 'cable-seat')
    for x in (-.40,.40):
        box('Bench floor runner',(x,.10,0),(.15,.12,1.05),steel,.018)
        for z in (-.45,.45):box('Bench rubber end foot',(x,.045,z),(.16,.03,.15),rubber,.006)
    rod('Bench center steel riser',(0,.10,0),(0,.47,0),.045,steel,12)
    box('Bench underseat support',(0,.43,0),(.54,.05,.49),steel,.008)
    box('Bench padded seat',(0,.49,0),(.60,.12,.56),teal,.035)
    for x in (-.275,.275):box('Seat seam',(x,.548,0),(.003,.002,.43),linen,.0006)
    if back:
        rod('Backrest frame',(0,.22,-.34),(0,1.17,-.40),.035,steel,12)
        obj=box('Bench upright back cushion',(0,.87,-.37),(.58,.70,.10),teal,.032);obj.rotation_euler.x=-.07
        for x in (-.25,.25):box('Back cushion seam',(x,.87,-.314),(.003,.54,.002),linen,.0006)
bench(True);bench(False)

group('cable-tower')
for x in (-.48,.48):
    box('Cable row upright',(x,1.05,1.05),(.07,2,.07),steel,.012)
    box('Cable row stabilizer foot',(x,.055,1.05),(.14,.11,.42),rubber,.009)
    rod('Cable weight guide',(x*.58,.20,1.05),(x*.58,1.92,1.05),.011,keymat,12)
box('Cable row crosshead',(0,2.02,1.05),(1.03,.08,.1),steel,.012)
for y in (.24,1.94):rod('Cable pulley wheel',(-.035,y,1.05),(.035,y,1.05),.075,brass,20)
rod('Main cable vertical',(0,.25,1.05),(0,1.94,1.05),.005,rubber,10)
box('Cable row rear cover',(0,1.05,1.15),(.76,1.83,.04),dark,.012)
box('Cable exercise diagram',(0,1.54,1.176),(.30,.35,.003),ivory,.008)
for y in (1.46,1.54,1.62):box('Diagram raised line',(0,y,1.179),(.20,.008,.002),teal,.001)
group('cable-stack')
for i in range(7):
    box('Independent weight stack plate',(0,.35+i*.085,1.05),(.62,.065,.25),steel,.007)
    box('Weight stack number marker',(.20,.35+i*.085,1.18),(.04,.025,.003),paper,.002)
box('Weight stack selector pin',(.08,.60,1.20),(.09,.02,.03),gold,.004)
group('cable-handle')
rod('Cable rowing handle',(-.275,0,0),(.275,0,0),.021,keymat,16)
for x in (-.23,.23):box('Cable handle rubber grip',(x,0,-.04),(.075,.08,.10),rubber,.014)
group('dumbbell');dumbbell_at(0,0,0)

group('yoga-mat')
box('Yoga raised mat support',(0,.055,0),(.91,.11,1.91),dark,.018)
box('Bound cork yoga mat',(0,.111,0),(.95,.018,1.95),teal,.018)
for x in (-.26,0,.26):box('Yoga alignment line',(x,.121,0),(.009,.002,1.75),linen,.001)
for z in (-.88,.88):box('Yoga short alignment end',(0,.121,z),(.55,.002,.008),linen,.001)
group('gym-storage')
box('Sage gym storage shell',(0,.48,0),(1.55,.95,.48),teal,.018)
box('Gym oak cabinet cap',(0,.967,0),(1.55,.025,.48),oak,.006)
for x in (-.45,0,.45):
    box('Linen gym locker face',(x,.54,.25),(.38,.58,.018),linen,.008)
    box('Locker recessed pull',(x,.65,.263),(.09,.018,.008),steel,.003)
    for i in range(4):box('Locker upper vent',(x,.75-i*.027,.263),(.17,.008,.003),teal,.001)
for x in (-.46,-.15,.16,.47):
    for i in range(3):box('Folded fresh gym towel',(x,1.00+i*.035,0),(.24,.032,.32),ivory,.008)

# Decorative fixtures use a shared lens material so runtime light state can isolate it.
light.name='Interior lamp diffuser'
group('floor-lamp')
cylinder('Floor lamp weighted base',(0,.025,0),.22,.05,steel,sides=32)
cylinder('Floor lamp brass collar',(0,.06,0),.06,.03,brass,sides=24)
rod('Floor lamp slender stem',(0,.06,0),(0,1.58,0),.012,brass,16)
cylinder('Linen floor lamp shade',(0,1.66,0),.31,.30,linen,.23,sides=32)
for y,r in ((1.51,.31),(1.81,.23)):arc('Shade rolled binding',(0,y,0),r,.007,ivory,plane='horizontal',steps=32)
cylinder('Floor lamp diffuser',(0,1.506,0),.29,.008,light,sides=32)
cylinder('Lamp top finial',(0,1.816,0),.015,.008,brass,sides=16)
group('pendant-light')
# Shade center is the contract origin; runtime owns canopy and variable-length cord.
cylinder('Pendant socket',(0,.1375,0),.032,.055,brass,sides=16)
cylinder('Spun brass pendant shade',(0,0,0),.40,.22,brass,.14,sides=32)
arc('Pendant rolled edge',(0,-.11,0),.40,.007,brass,plane='horizontal',steps=32)
cylinder('Pendant warm diffuser',(0,-.114,0),.37,.008,light,sides=32)

group('decor-plant')
cylinder('Large tapered ceramic planter',(0,.22,0),.18,.44,clay,.23,sides=24)
arc('Planter rolled lip',(0,.44,0),.225,.010,clay,plane='horizontal',steps=24)
cylinder('Planter dark soil',(0,.439,0),.215,.008,soil,sides=24)
for i in range(14):
    a=i*2.399;h=.9+(i%4)*.16;r=.22+(i%3)*.045
    end=(math.sin(a)*r,h,math.cos(a)*r)
    rod('Botanical woody stalk',(0,.43,0),end,.0045,green)
    ellipsoid('Broad living leaf',(end[0],h-.04,end[2]),(.16,.34,.025),leafgreen if i%3 else green,(math.sin(a)*.6,1,math.cos(a)*.6),segments=12,rings=6)

group('wall-art')
box('Solid oak art frame',(0,0,0),(1.05,.72,.07),walnut,.012)
box('Art linen mat',(0,0,.038),(.98,.65,.01),paper,.004)
box('Abstract art ground',(0,0,.045),(.87,.54,.004),linen,.001)
ellipsoid('Abstract botanical oval',(-.13,-.03,.05),(.36,.43,.003),teal,segments=24,rings=12)
ellipsoid('Abstract terracotta sun',(.20,.10,.054),(.25,.25,.003),clay,segments=24,rings=12)
box('Abstract golden horizon',(.02,-.18,.056),(.56,.019,.004),gold,.002)
for x in (-.18,-.10,-.02):rod('Abstract botanical stroke',(x,-.20,.058),(x+.08,.12,.058),.003,ivory,8)

group('minibar')
box('Minibar graphite housing',(0,.57,0),(.72,1.13,.86),steel,.018)
for x in (-.345,.345):box('Minibar door stile',(x,.59,.441),(.035,.94,.025),brass,.006)
for y in (.13,1.05):box('Minibar door crossrail',(0,y,.441),(.70,.035,.025),brass,.006)
box('Minibar recessed display back',(0,.60,.37),(.62,.85,.02),dark,.008)
for y in (.34,.72):
    box('Minibar shelf',(0,y,.16),(.61,.025,.46),steel,.005)
    for x in (-.22,0,.22):
        cylinder('Chilled drink can',(x,y+.11,.2),.057,.20,teal if y>.5 else clay,sides=16)
        cylinder('Drink can top',(x,y+.214,.2),.055,.007,keymat,sides=16)
        box('Drink can label',(x,y+.11,.258),(.055,.09,.003),paper,.002)
rod('Minibar door pull',(.29,.45,.47),(.29,.75,.47),.011,brass,12)
box('Minibar rounded oak cap',(0,1.23,-.02),(.8,.11,.95),oak,.018)
for x in (-.25,0,.25):box('Snack carton',(x,1.365,0),(.20,.17,.15),gold if x==0 else clay,.012)
group('lounge-round-table')
cylinder('Lounge table pedestal',(0,.21,0),.25,.35,steel,.23,sides=24)
cylinder('Lounge table oak top',(0,.41,0),.61,.12,oak,.56,sides=40)
arc('Round tabletop brass edge',(0,.45,0),.579,.005,brass,plane='horizontal',steps=40)

# Handheld hospitality props use palm-surface and bottom origins respectively.
group('food-plate')
cylinder('Snack serving plate',(0,.009,0),.11,.018,ivory,.105,sides=32)
arc('Plate raised rim',(0,.018,0),.10,.005,ivory,plane='horizontal',steps=32)
for x,z in ((-.035,-.02),(.035,.026)):
    box('Sandwich bread',(x,.035,z),(.075,.018,.065),linen,.01)
    box('Sandwich green filling',(x,.047,z),(.08,.006,.069),green,.004)
    box('Sandwich cheese filling',(x,.053,z),(.076,.006,.065),gold,.004)
    box('Sandwich top bread',(x,.064,z),(.075,.017,.065),linen,.01)
for x,z in ((-.05,.055),(.05,-.05)):
    ellipsoid('Fresh fruit snack',(x,.04,z),(.034,.035,.034),clay)
group('drink-cup')
cylinder('Hospitality ceramic cup',(0,.052,0),.034,.104,ivory,.04,sides=24)
arc('Hospitality cup rolled rim',(0,.105,0),.039,.003,ivory,plane='horizontal',steps=24)
cylinder('Hospitality dark coffee',(0,.104,0),.034,.002,walnut,sides=24)
arc('Hospitality cup handle',(.045,.056,0),.025,.005,ivory,steps=16)

# Compact tabletop vignette shared by room console tables and desks.
group('decor-vignette')
box('Vignette linen book',(-.11,.035,0),(.34,.07,.24),linen,.006)
box('Vignette teal book',(-.09,.10,0),(.30,.055,.22),teal,.006)
vase(.20,0,0,ivory,.6)
rod('Vignette green stem',(.20,.15,0),(.18,.29,0),.003,green)
ellipsoid('Vignette bud leaf',(.16,.285,0),(.10,.10,.025),leafgreen,(-.4,1,0))
# Merge by material per root; bake all primitive transforms to contract origins.
manifest={}
for name,root in roots.items():
    merge_root(root)
    bpy.context.view_layer.update()
    corners=[child.matrix_world @ Vector(c) for child in root.children for c in child.bound_box]
    app=[(c.x,c.z,-c.y) for c in corners]
    mins=[min(c[i] for c in app) for i in range(3)];maxs=[max(c[i] for c in app) for i in range(3)]
    triangles=sum(len(poly.vertices)-2 for child in root.children for poly in child.data.polygons)
    manifest[name]={'origin':[0,0,0],'min':mins,'max':maxs,'size':[maxs[i]-mins[i] for i in range(3)],'triangles':triangles,'meshes':len(root.children),'materials':[c.data.materials[0].name for c in root.children]}
triangles=sum(g['triangles'] for g in manifest.values())
if triangles>180000:raise RuntimeError('Interior triangle budget exceeded: '+str(triangles))
# Exact seat and deck surfaces are validated before export, without using the app.
assert abs(manifest['bar-stool-seat']['max'][1]-.205)<.001 # low back includes top at .205 relative to pivot
assert abs(manifest['treadmill-belt']['max'][1]-.129)<.001
assert abs(manifest['bike-frame']['max'][1]-1.249)<.02
assert set(roots).issuperset({'bar-stool-seat','bar-stool-base','bike-crank','bike-pedal','cable-seat','cable-stack','cable-handle'})
bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.gltf(filepath=os.path.join(args.output,'interior-library.glb'),export_format='GLB',use_selection=True,
    export_yup=True,export_materials='EXPORT',export_extras=True,export_cameras=False,export_lights=False)
with open(os.path.join(args.output,'interior-library.manifest.json'),'w') as output:
    json.dump({'profile':profile,'groups':manifest,'triangles':triangles,'meshes':sum(g['meshes'] for g in manifest.values())},output,indent=2)

# Museum-like inspection rows. GLB above has zero origins for every component.
placement={
 'bar-back':(-4,0,-4),'coffee-machine':(-5.2,.955,-4),'bar-counter':(-4,0,-2.15),
 'bar-stool-base':(-3.2,0,3.8),'bar-stool-seat':(-3.2,.72,3.8),'stemware-rack':(-4,2.65,-2.2),
 'display-cabinet':(.7,0,-4.5),'bookshelf':(4.2,0,-4.5),'bookshelf-open':(6.9,0,-4.5),
 'server-rack':(9.1,0,-4.5),'storage-cabinet':(.8,0,-2.8),'copier':(3,0,-2.7),
 'print-supply-cabinet':(4.4,0,-2.7),'printer':(4.4,.96,-2.7),'recycle-bin':(5.4,0,-2.6),
 'tv-console':(-5.0,0,1.1),'tv-housing':(-5.0,1.75,.95),'game-console':(-4,.75,1.1),
 'game-controller':(-5.5,.79,1.2),'lounge-round-table':(-5,0,2.7),'food-plate':(-5,.47,2.7),'drink-cup':(-4.7,.47,2.7),
 'arcade-shell':(-2.5,0,1.3),'foosball-table':(-.4,0,1.8),'minibar':(-7.2,0,1.3),
 'treadmill-frame':(2.3,0,1.6),'treadmill-belt':(2.3,0,1.6),'bike-frame':(4,0,1.6),'bike-crank':(4,.38,1.6),
 'bike-pedal':(4.27,.56,1.6),'strength-bench':(5.3,0,1.6),'cable-seat':(6.8,0,1.6),'cable-tower':(6.8,0,1.6),
 'cable-stack':(6.8,0,1.6),'cable-handle':(6.8,.94,2.3),'dumbbell-rack':(8.7,0,1.4),
 'yoga-mat':(7.4,0,4),'gym-storage':(9.2,0,4),'dumbbell':(9.2,1.23,4),
 'coffee-table':(-.8,0,-.4),'console-table':(1,0,-.5),'decor-vignette':(1,.82,-.5),
 'wall-art':(.7,1.7,-4.1),'decor-plant':(-7,0,-4),'floor-lamp':(-6.9,0,3.2),'pendant-light':(-5,1.88,2.7)
}
for name,root in roots.items():root.location=point(placement[name])
scene['export_origin_note']='GLB is zero anchored; blend separates components into an inspection arrangement.'
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(args.output,'interior-library.blend'))
if args.preview:
    active=None
    bpy.ops.mesh.primitive_plane_add(size=200,location=(0,0,-.02))
    bpy.context.object.data.materials.append(mat('Preview warm backdrop','e4e3da',.9))
    world=bpy.data.worlds.new('Soft studio');world.use_nodes=True
    world.node_tree.nodes['Background'].inputs[0].default_value=(.67,.72,.76,1)
    world.node_tree.nodes['Background'].inputs[1].default_value=.6;scene.world=world
    for loc,power,size in (((-5,-8,12),2400,10),((7,2,10),1800,8),((-6,7,6),1200,7)):
        bpy.ops.object.light_add(type='AREA',location=loc);bpy.context.object.data.energy=power;bpy.context.object.data.size=size
    bpy.ops.object.camera_add(location=(15,-23,18))
    camera=bpy.context.object;camera.rotation_euler=(Vector((.7,.15,.75))-camera.location).to_track_quat('-Z','Y').to_euler()
    camera.data.type='ORTHO';camera.data.ortho_scale=23.5;scene.camera=camera
    scene.render.engine='CYCLES';scene.cycles.samples=24
    scene.render.resolution_x=2400;scene.render.resolution_y=1500;scene.render.resolution_percentage=100
    scene.view_settings.view_transform='AgX';scene.render.filepath=args.preview
    os.makedirs(os.path.dirname(os.path.abspath(args.preview)),exist_ok=True)
    bpy.ops.render.render(write_still=True)
print('INTERIOR_LIBRARY '+json.dumps({'roots':list(roots),'triangles':triangles,'meshes':sum(g['meshes'] for g in manifest.values())}))
