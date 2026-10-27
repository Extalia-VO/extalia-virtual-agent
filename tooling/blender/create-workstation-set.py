"""Build the local workstation library in Blender; app X/Y/Z = Blender X/Z/-Y.

Blender --background --python tooling/blender/create-workstation-set.py -- --output <directory> --preview <png>
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
with open(os.path.join(REPO, 'apps/web/src/office/scene/interior/workstationAssetProfile.json')) as source:
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


def group(name):
    global active
    active = bpy.data.objects.new(name, None)
    scene.collection.objects.link(active)
    active['workstation_part'] = name
    roots[name] = active
    return active


def finish(obj, name, material, bevel=0):
    obj.name = name
    obj.data.materials.append(material)
    bpy.context.view_layer.objects.active = obj
    if bevel:
        modifier = obj.modifiers.new('Rounded manufactured edges', 'BEVEL')
        modifier.width = bevel
        modifier.segments = 1 if 'keycap' in name or 'Laptop key' in name else 2
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


# Floor-anchored single workstation. Front (+Z) kneespace stays open.
group('single-desk')
d = profile['desk']; top=d['top']; underside=top-d['thickness']
box('Solid softly rounded oak top',(0,top-d['thickness']/2,0),(d['width'],d['thickness'],d['depth']),oak,.025)
for x in (-d['legX'],d['legX']):
    for z in (-.30,.30):
        box('Slender powdercoated leg',(x,(underside+.025)/2,z),(.038,underside-.025,.045),ivory,.008)
        box('Levelling foot',(x,.0125,z),(.052,.025,.060),rubber,.008)
    box('End frame upper rail',(x,underside-.033,0),(.042,.045,.65),ivory,.007)
for z in (-.285,.285):
    box('Recessed longitudinal frame',(0,underside-.035,z),(1.30,.045,.025),steel,.006)
box('Cable tray',(0,underside-.085,-.22),(.8,.025,.16),steel,.006)
for x in (-.3,.3):
    box('Cable tray hanger',(x,underside-.05,-.26),(.015,.06,.015),steel)

# Monitor stand sits on the desk; screen shell is centred separately.
group('monitor-stand')
m=profile['monitor']
box('Floating rounded weighted foot',(0,m['baseHeight']/2,.008),(m['baseWidth'],m['baseHeight'],m['baseDepth']),steel,.012)
box('Rubber underside',(0,.002,.008),(.21,.004,.14),rubber,.002)
box('VESA telescopic neck',(0,.018+(m['clearance']+.018)/2,-.012),(.045,m['clearance']+.018,.035),steel,.007)
cylinder('Stand cable sleeve',(0,.030,-.012),.031,.025,dark)
box('Base accent',(0,.019,.083),(.13,.002,.002),teal,.0005)
group('monitor-shell')
w,h=m['width'],m['height']; b=m['bezel']
box('Sculpted rear enclosure',(0,0,-.007),(w+b,h+b,.021),dark,.010)
for x in (-1,1):
    box('Narrow vertical bezel',(x*(w+b/2)/2,0,.008),(b/2,h,.018),dark,.005)
for y in (-1,1):
    box('Narrow horizontal bezel',(0,y*(h+b/2)/2,.008),(w+b,b/2,.018),dark,.005)
box('Lower bezel accent',(0,-h/2-b*.25,.0172),(.04,.002,.001),teal,.0004)
for x in (-.08,.08):
    for i in range(7):
        box('Rear ventilation slot',(x+i*.009,.075,-.0177),(.004,.035,.001),rubber,.0004)
box('VESA rear bracket',(0,-.05,-.020),(.09,.09,.008),steel,.004)

# Laptop chassis and lid remain separate so the app retains the screen tilt.
group('laptop-deck')
l=profile['laptop']
box('Aluminium unibody deck',(0,l['deckHeight']/2,0),(l['width'],l['deckHeight'],l['depth']),ivory,.006)
box('Recessed keyboard well',(0,.018,-.024),(.307,.001,.139),steel,.005)
for row in range(5):
    for col in range(14):
        box('Laptop keycap',((col-6.5)*.020,.0193,-.078+row*.022),(.017,.002,.017),dark,.002)
box('Laptop spacebar',(0,.0193,.033),(.105,.002,.017),dark,.002)
box('Glass trackpad',(0,.0187,.082),(.107,.001,.054),keymat,.004)
for x in (-.155,.155):
    box('Display hinge',(x,.018,-.115),(.035,.012,.012),steel,.004)
group('laptop-lid')
box('Lid rear enclosure',(0,0,-.003),(l['width'],l['lidHeight'],.012),steel,.006)
# Keep the entire front clear for the application's inset live display.
for x in (-1,1):
    box('Laptop side bezel',(x*(l['width']/2-.006),0,.006),(.012,l['lidHeight'],.006),dark,.002)
for y in (-1,1):
    box('Laptop horizontal bezel',(0,y*(l['lidHeight']/2-.007),.006),(l['width'],.014,.006),dark,.002)
ellipsoid('Camera lens',(0,l['lidHeight']/2-.006,.0092),(.003,.003,.001),rubber)

# Physical keys match keyboardKeys: alpha offset, rows and positive-X numpad.
k=profile['keyboard']; pitch=k['pitch']
def keyboard(kind):
    group('keyboard-'+kind)
    width=k[kind+'Width']; depth=k[kind+'Depth']
    box('Rounded keyboard chassis',(0,0,0),(width,.028,depth),dark,.006)
    letter_x=k['fullAlphaOffset'] if kind=='full' else 0
    keys=[]
    for row,count in enumerate((14,14,13,13,12)):
        for col in range(count):
            keys.append(((col-(count-1)/2)*pitch+letter_x,(row-2.5)*pitch,1,(row==0 and col==0) or (row==4 and col==count-1)))
    for x in (-6,-5,-4,4,5,6): keys.append((x*pitch+letter_x,2.5*pitch,1,False))
    keys.append((letter_x,2.5*pitch,6.6,False))
    if kind=='full':
        padx=width/2-.012-2*pitch; nav=(letter_x+7*pitch+padx-2*pitch)/2
        for row in (1,2):
            for col in range(3): keys.append((nav+(col-1)*pitch,(row-2.5)*pitch,1,False))
        for col,row in ((1,4),(0,5),(1,5),(2,5)):
            keys.append((nav+(col-1)*pitch,(row-2.5)*pitch,1,False))
        for row in range(6):
            for col in range(4): keys.append((padx+(col-1.5)*pitch,(row-2.5)*pitch,1,row==5 and col==3))
    for x,z,units,accent in keys:
        capwidth=k['capSize'] if units==1 else units*pitch-.0025
        box('Tactile rounded keycap',(x,.021,z),(capwidth,.012,k['capSize']),teal if accent else keymat,.002)
    box('Keyboard indicator',(width/2-.03,.015,-depth/2+.006),(.012,.002,.003),teal,.0008)
keyboard('compact'); keyboard('full')

group('mouse')
# Elliptical loft makes a planted underside, broad rear palm and lower nose.
vertices=[]; faces=[]
levels=[(-.019,.026,.046),(-.014,.031,.055),(0,.032,.058),(.011,.028,.048),(.018,.015,.026),(.019,0,0)]
for y,rx,rz in levels:
    for i in range(32):
        theta=math.tau*i/32
        vertices.append(point((rx*math.cos(theta),y,rz*math.sin(theta))))
for row in range(len(levels)-1):
    for i in range(32): faces.append((row*32+i,row*32+(i+1)%32,(row+1)*32+(i+1)%32,(row+1)*32+i))
faces.append(tuple(reversed(range(32))))
mesh=bpy.data.meshes.new('Mouse contoured loft');mesh.from_pydata(vertices,[],faces);mesh.update()
obj=bpy.data.objects.new('Mouse contoured shell',mesh);scene.collection.objects.link(obj);finish(obj,obj.name,dark)
box('Split button seam',(0,.013,-.030),(.001,.002,.035),rubber,.0003)
ellipsoid('Scroll wheel',(0,.015,-.025),(.008,.008,.015),teal)
# Low side seam follows the moulded waist.
arc('Mouse waist seam',(0,-.013,0),.027,.0006,rubber,plane='horizontal')
group('mouse-pad')
p=profile['pad']
box('Bound fabric mousemat',(0,p['thickness']/2,0),(p['width'],p['thickness'],p['depth']),steel,.0018)
box('Woven cloth surface',(0,.0036,0),(p['width']-.005,.0007,p['depth']-.005),teal,.0003)

# Organizers retain tabletop origin and compact footprints.
group('drawer-unit')
box('Rounded document shell',(0,.10,0),(.22,.20,.30),ivory,.008)
for i in range(3):
    y=.035+i*.062
    box('Inset drawer face',(0,y,.151),(.201,.052,.004),teal if i==1 else ivory,.004)
    box('Brushed pull handle',(0,y+.009,.158),(.055,.006,.010),steel,.002)
    box('Drawer label',(0,y-.012,.154),(.043,.010,.001),paper,.0004)
group('letter-tray')
for y in (0,.070):
    box('Document tray',(0,y+.004,0),(.25,.008,.32),ivory,.003)
    box('Tray back rail',(0,y+.022,-.157),(.25,.04,.006),ivory,.002)
    for x in (-.122,.122): box('Open tray side',(x,y+.019,0),(.006,.03,.32),ivory,.002)
    box('A4 paper stack',(0,y+.013,.005),(.21,.01,.297),paper,.001)
for x in (-.115,.115):
    for z in (-.145,.145): rod('Stacking post',(x,.01,z),(x,.075,z),.003,steel)
group('file-holder')
box('File caddy base',(0,.005,0),(.108,.010,.25),steel,.003)
box('File caddy back',(0,.12,-.12),(.108,.24,.008),steel,.003)
for x in (-.05,.05):
    box('Caddy lower side',(x,.05,0),(.008,.10,.25),steel,.002)
for i,color in enumerate((teal,clay,gold,blue)):
    book(-.034+i*.023,.019,.245-i*.012,.225,color,base=.010)
group('books')
for x,width,height,color in ((-.065,.032,.21,teal),(-.032,.027,.19,clay),(.005,.04,.23,blue),(.039,.023,.18,gold),(.068,.027,.20,ivory)):
    book(x,width,height,.15,color)
for x in (-.089,.087):
    box('Bookend upright',(x,.06,0),(.004,.12,.11),steel,.001)
    box('Bookend foot',(x-math.copysign(.016,x),.002,0),(.035,.004,.11),steel,.001)

def pot():
    cylinder('Tapered ceramic planter',(0,.044,0),.042,.088,clay,.054)
    arc('Rolled planter rim',(0,.086,0),.051,.003,clay,plane='horizontal')
    cylinder('Visible pot soil',(0,.087,0),.047,.004,soil)

group('plant');pot()
for i in range(9):
    a=i*2.399; h=.19+(i%3)*.023
    end=(math.sin(a)*.035,h,math.cos(a)*.035)
    rod('Leaf stem',(0,.085,0),end,.0015,green)
    direction=(math.sin(a)*.55,1,math.cos(a)*.55)
    ellipsoid('Lance leaf',(end[0],h-.015,end[2]),(.034,.09,.010),leafgreen if i%2 else green,direction)
group('photo')
box('Oak photo frame',(0,.065,0),(.13,.12,.013),oak,.004)
box('Matboard',(0,.065,.007),(.112,.102,.001),paper,.0004)
box('Abstract landscape background',(0,.065,.008),(.098,.086,.001),blue,.0004)
ellipsoid('Abstract setting sun',(-.023,.087,.009),(.027,.027,.001),gold)
box('Abstract land silhouette',(0,.039,.009),(.098,.035,.001),teal,.0004)
rod('Photo easel',(0,.105,-.005),(0,.003,-.052),.004,steel)
group('notebook')
box('Notebook pages',(0,.008,0),(.145,.012,.205),paper,.002)
for y in (.001,.015): box('Cloth notebook cover',(0,y,0),(.15,.002,.21),teal,.001)
box('Notebook binding',(-.071,.008,0),(.008,.015,.21),teal,.001)
box('Elastic closure',(.048,.017,0),(.005,.001,.21),dark,.0003)
rod('Notebook pen',(-.04,.022,-.05),(.038,.022,.064),.003,steel)
group('headphones')
cylinder('Headphone weighted foot',(0,.006,0),.055,.012,steel)
rod('Headphone stand',(0,.012,0),(0,.22,0),.006,steel)
box('Stand saddle',(0,.23,0),(.065,.012,.03),oak,.004)
arc('Padded headphone band',(0,.15,0),.073,.008,dark,0,math.pi)
for side in (-1,1):
    rod('Adjustable ear slider',(side*.072,.15,0),(side*.072,.105,0),.003,steel)
    ellipsoid('Over-ear cushion',(side*.071,.105,0),(.025,.067,.047),rubber)
    ellipsoid('Teal ear shell',(side*.082,.105,0),(.012,.06,.043),teal)
group('pen-cup')
cylinder('Pen pot body',(0,.045,0),.034,.09,steel,.039)
cylinder('Dark cup opening',(0,.090,0),.034,.002,rubber)
arc('Cup rolled rim',(0,.091,0),.036,.002,steel,plane='horizontal')
for i,color in enumerate((clay,teal,gold)):
    x=-.017+i*.017
    rod('Desk pencil',(x,.01,0),(x+.007*(i-1),.16+i*.014,.008),.003,color)
    rod('Pencil graphite point',(x+.007*(i-1),.16+i*.014,.008),(x+.007*(i-1),.165+i*.014,.008),.0015,rubber)
group('sticky-notes')
box('Sticky note pad',(0,.009,0),(.076,.018,.076),gold,.002)
box('Loose mint note',(.066,.0006,.023),(.076,.0012,.076),teal,.0004)
for i in range(4): box('Paper edge line',(0,.004+i*.003,.0381),(.073,.0003,.0003),paper,.0001)
group('desk-shelf')
for x in (-.102,.102):
    for z in (-.088,.088):
        rod('Mini shelf upright',(x,.004,z),(x,.265,z),.004,steel)
        cylinder('Shelf rubber foot',(x,.003,z),.007,.006,rubber)
for y in (.027,.168):
    box('Oak mini shelf',(0,y,0),(.22,.012,.20),oak,.004)
    box('Shelf back retaining rail',(0,y+.025,-.095),(.21,.03,.006),steel,.002)
for i,color in enumerate((teal,clay,blue)):
    book(-.071+i*.037,.031,.085,.12,color,base=.033)
box('Upper shelf notebook',(0,.182,0),(.14,.014,.15),paper,.002)
box('Upper shelf linen cover',(0,.190,0),(.145,.003,.155),teal,.001)
group('flower-vase')
cylinder('Ceramic vase body',(0,.051,0),.042,.102,ivory,.032)
cylinder('Vase narrow neck',(0,.112,0),.025,.033,ivory,.023)
arc('Vase lip',(0,.128,0),.024,.002,ivory,plane='horizontal')
for i in range(5):
    a=i*2.4; x=math.sin(a)*.036; z=math.cos(a)*.032; y=.255+(i%3)*.019
    rod('Flower stem',(0,.1,0),(x,y,z),.0017,green)
    ellipsoid('Stem leaf',(x*.6,.18+(i%2)*.015,z*.6),(.022,.055,.006),leafgreen,(math.sin(a),1,math.cos(a)))
    for j in range(6):
        phi=math.tau*j/6
        ellipsoid('Flower petal',(x+.014*math.sin(phi),y+.002*math.cos(phi),z+.014*math.cos(phi)),(.021,.009,.028),pink if i%2 else petal)
    ellipsoid('Flower centre',(x,y+.005,z),(.012,.012,.012),gold)
group('ornament-lamp')
cylinder('Lamp weighted foot',(0,.009,0),.056,.018,steel)
rod('Lamp brushed stem',(0,.018,0),(0,.235,0),.006,steel)
# Small warm mushroom shade, raised over the open desk surface.
cylinder('Lamp spun shade',(0,.255,0),.075,.05,ivory,.040,24)
cylinder('Warm lamp diffuser',(0,.230,0),.069,.004,light,sides=24)
cylinder('Shade finial',(0,.283,0),.009,.008,gold)

# Merge by material within each empty root; shared materials survive export.
manifest={}
for name, root in roots.items():
    children=list(root.children)
    by_material={}
    for child in children:
        by_material.setdefault(child.data.materials[0].name,[]).append(child)
    for material_name, objects in by_material.items():
        bpy.ops.object.select_all(action='DESELECT')
        for obj in objects: obj.select_set(True)
        bpy.context.view_layer.objects.active=objects[0]
        bpy.ops.object.join()
        obj=bpy.context.object
        obj.name=name+' / '+material_name
        # Baking mesh transforms sets every merged primitive origin to its contract root.
        bpy.ops.object.transform_apply(location=True,rotation=True,scale=True)
        obj.parent=root
    bpy.context.view_layer.update()
    corners=[child.matrix_world @ Vector(c) for child in root.children for c in child.bound_box]
    app=[(c.x,c.z,-c.y) for c in corners]
    mins=[min(c[i] for c in app) for i in range(3)];maxs=[max(c[i] for c in app) for i in range(3)]
    triangles=sum(len(poly.vertices)-2 for child in root.children for poly in child.data.polygons)
    manifest[name]={'min':mins,'max':maxs,'triangles':triangles,'meshes':len(root.children)}

bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.gltf(filepath=os.path.join(args.output,'workstation-set.glb'),export_format='GLB',use_selection=True,
                          export_yup=True,export_materials='EXPORT',export_extras=True,export_cameras=False,export_lights=False)
with open(os.path.join(args.output,'workstation-set.manifest.json'),'w') as out:
    json.dump({'profile':profile,'groups':manifest,'triangles':sum(x['triangles'] for x in manifest.values())},out,indent=2)

# Inspection layout in the blend: desk hero with authored equipment and rear decorations,
# plus an orderly side display of every alternative (the GLB retains all origins at zero).
placement={
 'single-desk':(0,0,0), 'monitor-stand':(0,top,-.20),'monitor-shell':(0,top+m['clearance']+h/2+m['baseHeight'],-.20),
 'keyboard-full':(-.06,top+.014,.14),'mouse':(.29,top+.019,.15),'mouse-pad':(.29,top,.15),
 'desk-shelf':(-.65,top,-.20),'flower-vase':(.63,top,-.19),'ornament-lamp':(.56,top,.07),
 'laptop-deck':(-1.25,.65,0),'laptop-lid':(-1.25,.65+.13,-.10),
}
remaining=[name for name in roots if name not in placement]
for i,name in enumerate(remaining): placement[name]=(-.9+(i%6)*.36,.035,.75+(i//6)*.47)
for name,root in roots.items():root.location=point(placement[name])
roots['laptop-lid'].rotation_euler.x=math.radians(16)
scene['export_origin_note']='GLB groups are all zero anchored. This blend uses a separated inspection arrangement.'
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(args.output,'workstation-set.blend'))
if args.preview:
    # Studio helpers are created only after saving/exporting the source asset library.
    active=None
    bpy.ops.mesh.primitive_plane_add(size=200,location=(0,0,-.015))
    floor=bpy.context.object
    floor.data.materials.append(mat('Preview floor','e5e6e1',.9))
    world=bpy.data.worlds.new('Soft studio')
    world.use_nodes=True
    world.node_tree.nodes['Background'].inputs[0].default_value=(.65,.70,.75,1)
    world.node_tree.nodes['Background'].inputs[1].default_value=.7
    scene.world=world
    for loc,power,size in (((-3,-4,6),500,5),((3,0,4),350,4)):
        bpy.ops.object.light_add(type='AREA',location=loc)
        bpy.context.object.data.energy=power;bpy.context.object.data.shape='DISK';bpy.context.object.data.size=size
    bpy.ops.object.camera_add(location=(3.4,-4.8,3.6))
    camera=bpy.context.object;camera.rotation_euler=(Vector((0,-.25,.4))-camera.location).to_track_quat('-Z','Y').to_euler()
    camera.data.type='ORTHO';camera.data.ortho_scale=3.65;scene.camera=camera
    scene.render.engine='CYCLES';scene.cycles.samples=32
    scene.render.resolution_x=1800;scene.render.resolution_y=1400;scene.render.resolution_percentage=100
    scene.view_settings.view_transform='AgX'
    scene.render.filepath=args.preview
    os.makedirs(os.path.dirname(os.path.abspath(args.preview)),exist_ok=True)
    bpy.ops.render.render(write_still=True)
print('WORKSTATION_LIBRARY '+json.dumps({'roots':list(roots),'triangles':sum(x['triangles'] for x in manifest.values()),'meshes':sum(x['meshes'] for x in manifest.values())}))
