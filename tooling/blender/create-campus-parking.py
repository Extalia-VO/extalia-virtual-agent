"""Author both campus parking lots in Blender: layout markers, the east lot and both access connectors.

Blender --background --factory-startup --python tooling/blender/create-campus-parking.py -- --output <directory>

App X/Y/Z = Blender X/Z/-Y. Layout markers (empties) are the single source of truth: every bay,
aisle point, entry point and lamp is an empty in the "Parking layout markers" collection. The
geometry builders read the markers back, so moving a marker in Blender and re-running `build()`
moves the drawn bay with it. The script writes:

- `campus-parking.glb`: the east lot (asphalt, kerbs, bay lines, wheel stops, EV pads, footway and
  garden link, aisle crossing, planting) and the west and east access connectors (level throat,
  eased ramp cut into the plinth with retaining walls, dropped-kerb footway crossing with curved
  kerb returns, give-way line and access centre line). The west lot's bays stay instanced slabs
  in the runtime (`CampusParking.tsx`); its layout data still comes from these markers.
- `campus-parking.layout.json`: lots (bays, aisle, entry, top, lane), lamps, chargers, the access
  profile and the GLB triangle budget. `prepare-public-models.py` publishes it as the runtime
  `apps/web/src/office/scene/campusParkingLots.json`.

In the live Blender app the same file can be exec'd with `__name__ != '__main__'`; call
`setup_scene(name)`, `create_markers()`, then `build_lot()` / `build_access(side)` step by step.
"""
import argparse
import json
import math
import os
import sys

import bmesh
import bpy

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '../..')) if '__file__' in globals() else None

# Site levels and lines shared with the runtime (campusSiteLayout / CampusNeighborhood / CampusExterior).
TOP = -0.22            # lot surface (plinth top -0.26 + 4 cm asphalt)
PLINTH_TOP = -0.26
GROUND = -0.72         # neighbourhood plane under the plinth edge
WALK_TOP = -0.66       # avenue footway top
ROAD_TOP = -0.69       # avenue carriageway top
PLINTH_EDGE = 52.0
BAND = (53.5, 56.5)    # avenue footway band (back edge, road edge)
LANE_X = 58.35         # inner avenue lane centre
ACCESS = {'z': -28.5, 'half': 3.0, 'throat': 46.0, 'return': 1.0, 'wall': 0.3, 'walkRampEdge': 32.6, 'walkGap': 24.3}

WEST_ROWS = [-10.2, -7, -3.8, -.6, 2.6, 5.8, 9, 12.2, 15.4]
EAST = {'west': 39.3, 'east': 51.6, 'south': -31.5, 'north': 24.0, 'bayX': 47.65, 'bayDepth': 5.5, 'bayWidth': 3.2,
        'aisleX': 42.15, 'firstZ': -20.4, 'bays': 14, 'evFrom': 11, 'footway': (37.4, 39.1), 'link': (34.2, 8.5, 2.8)}


def smoothstep(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


def access_y(u):
    """Surface height at |x| = u along the access: level throat, eased ramp, 1% crossfall over the footway band."""
    if u <= ACCESS['throat']:
        return TOP
    if u <= BAND[0]:
        return TOP + (WALK_TOP - TOP) * smoothstep((u - ACCESS['throat']) / (BAND[0] - ACCESS['throat']))
    if u <= BAND[1]:
        return WALK_TOP + (ROAD_TOP - WALK_TOP) * (u - BAND[0]) / (BAND[1] - BAND[0])
    return ROAD_TOP


def layout_definition():
    """The authored layout. Markers are created from it once; afterwards the markers are the source."""
    west_bays = []
    for index, z in enumerate(WEST_ROWS):
        for side in (-1, 1):
            west_bays.append({'id': f'parking-{side}-{index}', 'x': -47.25 if side < 0 else -37.75, 'z': z,
                              'yaw': math.pi / 2 if side < 0 else -math.pi / 2, 'ev': side < 0 and index >= 6})
    east_bays = [{'id': f'parking-east-{k}', 'x': EAST['bayX'], 'z': round(EAST['firstZ'] + EAST['bayWidth'] * k, 3),
                  'yaw': -math.pi / 2, 'ev': k >= EAST['evFrom']} for k in range(EAST['bays'])]
    z, throat = ACCESS['z'], ACCESS['throat']
    return [
        {'id': 'west', 'top': TOP, 'laneId': 'west-northbound', 'bays': west_bays,
         'aisle': [[-throat, z], [-44.0, z], [-42.5, -27.0], [-42.5, 17.5]],
         'entry': {'from': [-LANE_X, z], 'throat': [-throat, z]},
         'lamps': [{'id': f'parking-{edge}-{lz}', 'x': x, 'z': lz, 'poolX': pool}
                   for lz in (-13, 3, 18) for edge, x, pool in (('west', -51, -46.8), ('east', -34.2, -38.4))],
         'chargerX': -50.45},
        {'id': 'east', 'top': TOP, 'laneId': 'east-southbound', 'bays': east_bays,
         'aisle': [[throat, z], [43.6, z], [EAST['aisleX'], -27.05], [EAST['aisleX'], 22.5]],
         'entry': {'from': [LANE_X, z], 'throat': [throat, z]},
         'lamps': [{'id': f'parking-east-lot-{lz}', 'x': 51.15, 'z': lz, 'poolX': 45.6} for lz in (-18.8, -6.0, 6.8, 19.6)]
         + [{'id': 'parking-east-lot-entry', 'x': 50.9, 'z': -23.8, 'poolX': 46.0}],
         'chargerX': 50.95},
    ]


# --- scene ---------------------------------------------------------------------------------------
STATE = {'scene': None, 'markers': None, 'roots': {}, 'materials': {}}


def setup_scene(name='Extalia Parking', factory=False):
    if factory:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        scene = bpy.context.scene
        scene.name = name
    else:
        scene = bpy.data.scenes.get(name) or bpy.data.scenes.new(name)
        if bpy.context.window:
            bpy.context.window.scene = scene
    scene.unit_settings.system = 'METRIC'
    scene['coordinate_system'] = 'app X/Y/Z = Blender X/Z/-Y'
    STATE['scene'] = scene
    STATE['roots'] = {}
    STATE['materials'] = {}
    return scene


def collection(name):
    scene = STATE['scene']
    found = next((c for c in scene.collection.children if c.name.split('.')[0] == name), None)
    if found:
        return found
    created = bpy.data.collections.new(name)
    scene.collection.children.link(created)
    return created


def mat(name, color, roughness=.9):
    materials = STATE['materials']
    if name in materials:
        return materials[name]
    rgb = tuple(int(color[i:i + 2], 16) / 255 for i in (0, 2, 4))
    rgb = tuple(c / 12.92 if c <= .04045 else ((c + .055) / 1.055) ** 2.4 for c in rgb)
    m = bpy.data.materials.new('Parking ' + name)
    m.diffuse_color = (*rgb, 1)
    m.use_nodes = True
    node = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    node.inputs['Base Color'].default_value = (*rgb, 1)
    node.inputs['Roughness'].default_value = roughness
    materials[name] = m
    return m


PALETTE = {
    'asphalt': ('asphalt', '454c50'), 'kerb': ('concrete kerb', 'afb6a8'), 'wall': ('retaining wall', '9da49b'),
    'paint': ('white line paint', 'd4d6cd'), 'guide': ('aisle guide paint', 'd8cfaa'), 'ev': ('EV bay green', '446e62'),
    'stop': ('wheel stop', 'b9c0b7'), 'footway': ('footway paving', 'c9c5bb'), 'link': ('garden link paving', 'd9d4c8'),
    'tactile': ('tactile paving', 'c9a35a'), 'soil': ('planter soil', '4e4237'), 'planter': ('planter rim', '8d958a'),
    'bark': ('tree bark', '6f5e4d'), 'leaf': ('tree canopy', '577f4c'), 'leaf2': ('tree canopy light', '6d9658'),
    'hedge': ('hedge', '4d7a4c'),
}


def m(role):
    name, color = PALETTE[role]
    return mat(name, color, .55 if role in ('paint', 'guide') else .92)


def bl(p):
    """App (x, y, z) to Blender (x, -z, y)."""
    return (p[0], -p[2], p[1])


class Builder:
    """Collects app-space faces per material and writes one mesh object per material under a root."""

    def __init__(self, root):
        self.root = root
        self.parts = {}

    def face(self, role, points):
        self.parts.setdefault(role, []).append([tuple(p) for p in points])

    def quad(self, role, x0, z0, x1, z1, y):
        """Flat horizontal rectangle (counter-clockwise seen from above in app space)."""
        self.face(role, [(x0, y, z1), (x1, y, z1), (x1, y, z0), (x0, y, z0)])

    def box(self, role, cx, cz, w, d, y0, y1, yaw=0.0):
        c, s = math.cos(yaw), math.sin(yaw)
        corners = [(-w / 2, d / 2), (w / 2, d / 2), (w / 2, -d / 2), (-w / 2, -d / 2)]
        pts = [(cx + a * c + b * s, cz - a * s + b * c) for a, b in corners]
        top = [(x, y1, z) for x, z in pts]
        bottom = [(x, y0, z) for x, z in pts]
        self.face(role, top)
        for i in range(4):
            j = (i + 1) % 4
            self.face(role, [bottom[i], bottom[j], top[j], top[i]])

    def strip(self, role, xs, z0, z1, height, lift=0.0):
        """A surface along x following `height(x)` between z0 and z1 (one quad per x step)."""
        for a, b in zip(xs, xs[1:]):
            self.face(role, [(a, height(a) + lift, z1), (b, height(b) + lift, z1), (b, height(b) + lift, z0), (a, height(a) + lift, z0)])

    def blob(self, role, center, radius, stretch=1.0, subdivisions=1):
        mesh = bmesh.new()
        bmesh.ops.create_icosphere(mesh, subdivisions=subdivisions, radius=1.0)
        for face in mesh.faces:
            self.face(role, [(center[0] + v.co.x * radius, center[1] + v.co.z * radius * stretch, center[2] + v.co.y * radius) for v in face.verts])
        mesh.free()

    def cylinder(self, role, center, radius, y0, y1, sides=6):
        ring = [(center[0] + radius * math.cos(2 * math.pi * i / sides), center[1] + radius * math.sin(2 * math.pi * i / sides)) for i in range(sides)]
        for i in range(sides):
            a, b = ring[i], ring[(i + 1) % sides]
            self.face(role, [(a[0], y0, a[1]), (b[0], y0, b[1]), (b[0], y1, b[1]), (a[0], y1, a[1])])
        self.face(role, [(x, y1, z) for x, z in reversed(ring)])

    def finish(self):
        objects = []
        for role, faces in self.parts.items():
            mesh = bmesh.new()
            for face in faces:
                verts = [mesh.verts.new(bl(p)) for p in face]
                try:
                    created = mesh.faces.new(verts)
                except ValueError:
                    continue
                created.normal_update()
                # Every surface faces up or outwards; flip faces authored clockwise from above.
                if created.normal.z < -1e-4:
                    created.normal_flip()
            bmesh.ops.remove_doubles(mesh, verts=mesh.verts, dist=1e-5)
            data = bpy.data.meshes.new(f'{self.root.name} {role}')
            mesh.to_mesh(data)
            mesh.free()
            data.materials.append(m(role))
            obj = bpy.data.objects.new(f'{self.root.name} {PALETTE[role][0]}', data)
            for collection_ in self.root.users_collection:
                collection_.objects.link(obj)
            obj.parent = self.root
            objects.append(obj)
        return objects


def root(name):
    old = bpy.data.objects.get(name)
    if old:
        for child in list(old.children_recursive):
            bpy.data.objects.remove(child, do_unlink=True)
        bpy.data.objects.remove(old, do_unlink=True)
    empty = bpy.data.objects.new(name, None)
    collection('Parking geometry').objects.link(empty)
    STATE['roots'][name] = empty
    return empty


# --- markers -------------------------------------------------------------------------------------
def marker(name, x, z, y, kind, size=.35, yaw=0.0, **props):
    target = collection('Parking layout markers')
    obj = bpy.data.objects.get(name)
    if obj is None:
        obj = bpy.data.objects.new(name, None)
        target.objects.link(obj)
    obj.empty_display_type = {'bay': 'SINGLE_ARROW', 'aisle': 'SPHERE', 'entry': 'CONE', 'lamp': 'PLAIN_AXES', 'lot': 'CUBE'}[kind]
    obj.empty_display_size = size
    obj.location = bl((x, y, z))
    # A bay arrow points along the parked car's +Z (app), i.e. where its nose faces.
    obj.rotation_euler = (math.pi / 2, 0, yaw) if kind == 'bay' else (0, 0, yaw)
    obj['kind'] = kind
    for key, value in props.items():
        obj[key] = value
    return obj


def create_markers(definition=None):
    for lot in definition or layout_definition():
        lid = lot['id']
        marker(f'lot:{lid}', lot['entry']['throat'][0], lot['entry']['throat'][1], lot['top'], 'lot', 1.0,
               lot=lid, top=lot['top'], laneId=lot['laneId'], chargerX=lot['chargerX'])
        for order, bay in enumerate(lot['bays']):
            marker(f"bay:{lid}:{bay['id']}", bay['x'], bay['z'], lot['top'], 'bay', 1.2, bay['yaw'], lot=lid, bay=bay['id'], ev=bay['ev'], order=order)
        for index, (x, z) in enumerate(lot['aisle']):
            marker(f'aisle:{lid}:{index:02d}', x, z, lot['top'], 'aisle', .3, lot=lid, index=index)
        for key in ('from', 'throat'):
            x, z = lot['entry'][key]
            marker(f'entry:{lid}:{key}', x, z, access_y(abs(x)), 'entry', .6, lot=lid, point=key)
        for order, lamp in enumerate(lot['lamps']):
            marker(f"lamp:{lid}:{lamp['id']}", lamp['x'], lamp['z'], lot['top'], 'lamp', .8, lot=lid, lamp=lamp['id'], poolX=lamp['poolX'], order=order)


def app_point(obj):
    p = obj.matrix_world.translation
    return round(p.x, 3), round(p.z, 3), round(-p.y, 3)


def read_layout():
    """Lots back from the markers, in marker order."""
    for layer in STATE['scene'].view_layers:
        layer.update()
    objects = [o for o in bpy.data.objects if o.type == 'EMPTY' and 'kind' in o and o.users_scene and STATE['scene'] in o.users_scene]
    lots = []
    for lot in sorted((o for o in objects if o['kind'] == 'lot'), key=lambda o: 0 if o['lot'] == 'west' else 1):
        lid = lot['lot']
        mine = [o for o in objects if o.get('lot') == lid]
        bays = []
        for obj in sorted((o for o in mine if o['kind'] == 'bay'), key=lambda o: o['order']):
            x, _y, z = app_point(obj)
            yaw = round(obj.matrix_world.to_euler('XYZ').z, 6)
            bays.append({'id': obj['bay'], 'x': x, 'z': z, 'yaw': yaw, 'ev': bool(obj['ev'])})
        aisle = [[app_point(o)[0], app_point(o)[2]] for o in sorted((o for o in mine if o['kind'] == 'aisle'), key=lambda o: o['index'])]
        entry = {o['point']: [app_point(o)[0], app_point(o)[2]] for o in mine if o['kind'] == 'entry'}
        lamps = [{'id': o['lamp'], 'x': app_point(o)[0], 'z': app_point(o)[2], 'poolX': round(o['poolX'], 3)}
                 for o in sorted((o for o in mine if o['kind'] == 'lamp'), key=lambda o: o['order'])]
        lots.append({'id': lid, 'bays': bays, 'aisle': aisle, 'entry': {'from': entry['from'], 'throat': entry['throat']},
                     'top': round(lot['top'], 3), 'laneId': lot['laneId'], 'lamps': lamps,
                     'chargers': [{'id': f"charger-{b['id']}", 'x': round(lot['chargerX'], 3), 'z': b['z'],
                                   'yaw': math.copysign(math.pi / 2, -lot['chargerX'])} for b in bays if b['ev']]})
    return lots


# --- geometry ------------------------------------------------------------------------------------
def build_lot(lot=None):
    """East lot hardscape, markings and planting from the east markers."""
    lot = lot or next(entry for entry in read_layout() if entry['id'] == 'east')
    b = Builder(root('parking-east-lot'))
    w, e, s, n = EAST['west'], EAST['east'], EAST['south'], EAST['north']
    throat, z0, z1 = ACCESS['throat'], ACCESS['z'] - ACCESS['half'], ACCESS['z'] + ACCESS['half']
    # Asphalt: the level turning apron by the throat plus the bay court (one L-shaped slab top).
    b.face('asphalt', [(w, TOP, n), (e, TOP, n), (e, TOP, z1), (throat, TOP, z1), (throat, TOP, z0), (w, TOP, z0)])
    for x0, x1, zz in ((w, throat, z0), (w, e, n)):
        b.face('asphalt', [(x0, TOP, zz), (x1, TOP, zz), (x1, PLINTH_TOP - .02, zz), (x0, PLINTH_TOP - .02, zz)])
    # Kerbs: east edge, north edge, the garden-side edge (gapped for the footway link) and the south edge.
    kerb_top, kerb_w = TOP + .12, .2
    link_x0, link_z, link_w = EAST['link']
    b.box('kerb', e + kerb_w / 2, (z1 + ACCESS['wall'] + n) / 2, kerb_w, n - z1 - ACCESS['wall'], PLINTH_TOP - .02, kerb_top)
    b.box('kerb', (w + e) / 2 + kerb_w / 2, n + kerb_w / 2, e - w + kerb_w * 2, kerb_w, PLINTH_TOP - .02, kerb_top)
    for za, zb in ((z0, link_z - link_w / 2), (link_z + link_w / 2, n)):
        b.box('kerb', w - kerb_w / 2, (za + zb) / 2, kerb_w, zb - za, PLINTH_TOP - .02, kerb_top)
    b.box('kerb', (w + throat) / 2, z0 - kerb_w / 2, throat - w + kerb_w, kerb_w, PLINTH_TOP - .02, kerb_top)
    # Dropped kerb where the garden link meets the lot.
    b.box('kerb', w - kerb_w / 2, link_z, kerb_w, link_w, PLINTH_TOP - .02, TOP + .02)
    # Footway along the garden side and its link across the garden bed to the building promenade paving.
    fx0, fx1 = EAST['footway']
    b.box('footway', (fx0 + fx1) / 2, (z0 + n) / 2, fx1 - fx0, n - z0, PLINTH_TOP - .02, TOP + .05)
    b.box('link', (link_x0 + fx0) / 2, link_z, fx0 - link_x0, link_w, PLINTH_TOP - .02, TOP + .05)
    lift = TOP + .006
    depth, width = EAST['bayDepth'], EAST['bayWidth']
    bays = lot['bays']
    for bay in bays:
        x0, x1 = bay['x'] - depth / 2, bay['x'] + depth / 2
        if bay['ev']:
            b.quad('ev', x0 + .12, bay['z'] - width / 2 + .12, x1 - .12, bay['z'] + width / 2 - .12, TOP + .003)
        head = x1 if bay['yaw'] < 0 else x0
        stop_x = head - math.copysign(.8, head - bay['x'])
        b.box('stop', stop_x, bay['z'], .15, 1.5, TOP, TOP + .09)
    # Bay division lines at every bay edge, and a head line along the charger strip.
    edges = sorted({round(bay['z'] - width / 2, 3) for bay in bays} | {round(bay['z'] + width / 2, 3) for bay in bays})
    bx0, bx1 = bays[0]['x'] - depth / 2, bays[0]['x'] + depth / 2
    for zz in edges:
        b.quad('paint', bx0, zz - .05, bx1, zz + .05, lift)
    b.quad('paint', bx1 - .05, edges[0], bx1 + .05, edges[-1], lift)
    # Two-way aisle guide dashes and the pedestrian crossing from the garden link to the bay row.
    ax = lot['aisle'][-1][0]
    for zz in range(-21, 21, 5):
        b.quad('guide', ax - .05, zz, ax + .05, zz + 2, lift)
    for x in [w + .5 + .8 * i for i in range(7)]:
        b.quad('paint', x, link_z - 1.2, x + .42, link_z + 1.2, lift)
    # North planting bed: three trees in a kerbed planter with low hedges.
    bed = (w + .3, n + .25, e - .3, n + 2.7)
    b.box('planter', (bed[0] + bed[2]) / 2, (bed[1] + bed[3]) / 2, bed[2] - bed[0], bed[3] - bed[1], PLINTH_TOP - .02, PLINTH_TOP + .18)
    b.quad('soil', bed[0] + .15, bed[1] + .15, bed[2] - .15, bed[3] - .15, PLINTH_TOP + .185)
    for i, tx in enumerate((41.6, 45.5, 49.4)):
        tz = (bed[1] + bed[3]) / 2
        b.cylinder('bark', (tx, tz), .16, PLINTH_TOP + .18, PLINTH_TOP + 2.6)
        b.blob('leaf' if i % 2 == 0 else 'leaf2', (tx, PLINTH_TOP + 3.6, tz), 1.35, .85, 2)
        b.blob('leaf2' if i % 2 == 0 else 'leaf', (tx + .55, PLINTH_TOP + 2.9, tz - .3), .85, .85, 2)
        b.blob('hedge', (tx + 1.9, PLINTH_TOP + .45, tz), .7, .5)
    return b.finish()


def build_access(side, lot=None):
    """One access connector: level throat, eased ramp cut into the plinth, footway crossing and returns."""
    sign = 1 if side == 'east' else -1
    lot = lot or next(entry for entry in read_layout() if entry['id'] == side)
    b = Builder(root(f'parking-access-{side}'))
    zc, half, throat, radius, wall = ACCESS['z'], ACCESS['half'], ACCESS['throat'], ACCESS['return'], ACCESS['wall']
    z0, z1 = zc - half, zc + half
    X = lambda u: sign * u  # noqa: E731 - mirror the east design for the west side

    def surface(role, us, za, zb, lift=0.0):
        b.strip(role, [X(u) for u in us], za, zb, lambda x: access_y(abs(x)), lift)

    # Level apron from the west aisle to the throat (the east apron belongs to the east lot slab).
    if side == 'west':
        b.quad('asphalt', -throat, z0, -39.5, z1, TOP)
        b.box('kerb', (-throat - 39.5) / 2, z0 - .1, throat - 39.5, .2, PLINTH_TOP - .02, TOP + .12)
        b.box('kerb', -39.4, zc, .2, z1 - z0 + .2, PLINTH_TOP - .02, TOP + .12)
    ramp = [throat + (BAND[0] - throat) * i / 20 for i in range(21)]
    surface('asphalt', ramp + [BAND[1]], z0, z1)
    # Solid ramp: the plinth notch is lined by retaining walls; past the plinth the ramp stands on the ground.
    for u0, u1 in zip(ramp, ramp[1:]):
        for zz in (z0, z1):
            b.face('asphalt', [(X(u0), GROUND, zz), (X(u1), GROUND, zz), (X(u1), access_y(u1), zz), (X(u0), access_y(u0), zz)])
    # Curved kerb returns: concave asphalt fillets widen the mouth to the road edge.
    arc = lambda cz, a0, a1: [(BAND[1] - radius + radius * math.cos(math.radians(a)), cz + radius * math.sin(math.radians(a)))  # noqa: E731
                              for a in [a0 + (a1 - a0) * i / 8 for i in range(9)]]
    south = arc(z0 - radius, 0, 90)      # from (road edge, z0 - r) to (road edge - r, z0)
    north = arc(z1 + radius, -90, 0)     # from (road edge - r, z1) to (road edge, z1 + r)
    for corner, points in (((BAND[1], z0), south), ((BAND[1], z1), north)):
        for (ua, za), (ub, zb) in zip(points, points[1:]):
            b.face('asphalt', [(X(corner[0]), access_y(corner[0]), corner[1]), (X(ua), access_y(ua), za), (X(ub), access_y(ub), zb)])
    # Kerb return stones along both arcs (outer edge 1.5 cm above the crossing, inner edge flush with the
    # footway), and the footway pieces between the walk ramp, the crossing and the resumed avenue footway.
    inner = .85
    shrink = lambda points, cz: [(BAND[1] - radius + (u - BAND[1] + radius) * inner / radius, cz + (zz - cz) * inner / radius) for u, zz in points]  # noqa: E731
    south_in, north_in = shrink(south, z0 - radius), shrink(north, z1 + radius)
    for outer, inside in ((south, south_in), (north, north_in)):
        for (ua, za), (ub, zb), (ia, ja), (ib, jb) in zip(outer, outer[1:], inside, inside[1:]):
            ya, yb = access_y(ua), access_y(ub)
            b.face('kerb', [(X(ua), ya + .015, za), (X(ub), yb + .015, zb), (X(ib), WALK_TOP, jb), (X(ia), WALK_TOP, ja)])
            b.face('kerb', [(X(ua), ya, za), (X(ub), yb, zb), (X(ub), yb + .015, zb), (X(ua), ya + .015, za)])
    walk_s, walk_n = -ACCESS['walkRampEdge'], -ACCESS['walkGap']
    south_piece = [(BAND[0], walk_s), (BAND[1], walk_s), south[0]] + south_in + [south[-1], (BAND[0], z0)]
    north_piece = [(BAND[0], z1), north[0]] + north_in + [north[-1], (BAND[1], walk_n), (BAND[0], walk_n)]
    for piece in (south_piece, north_piece):
        b.face('footway', [(X(u), WALK_TOP, zz) for u, zz in piece])
    for zz in (z0, z1):
        b.face('footway', [(X(BAND[0]), access_y(BAND[0]), zz), (X(BAND[1] - radius), access_y(BAND[1] - radius), zz),
                           (X(BAND[1] - radius), WALK_TOP, zz), (X(BAND[0]), WALK_TOP, zz)])
    # Tactile blister paving where the footway meets the crossing.
    for za, zb in ((z0 - .62, z0 - .02), (z1 + .02, z1 + .62)):
        b.quad('tactile', min(X(BAND[0] + .25), X(BAND[1] - radius - .1)), za, max(X(BAND[0] + .25), X(BAND[1] - radius - .1)), zb, WALK_TOP + .004)
    # Retaining walls: full height inside the plinth notch, stepping down with the ramp beyond it.
    def wall_top(u):
        if u <= PLINTH_EDGE - .4:
            return TOP + .04
        if u <= PLINTH_EDGE + .4:
            t = (u - (PLINTH_EDGE - .4)) / .8
            return (TOP + .04) * (1 - t) + (access_y(PLINTH_EDGE + .4) + .12) * t
        return access_y(u) + .12
    wall_us = [throat, PLINTH_EDGE - .4, PLINTH_EDGE + .4] + [PLINTH_EDGE + .4 + (BAND[0] - PLINTH_EDGE - .4) * i / 4 for i in range(1, 5)]
    for zz in (z0 - wall / 2, z1 + wall / 2):
        for u0, u1 in zip(wall_us, wall_us[1:]):
            for face_z in (zz - wall / 2, zz + wall / 2):
                b.face('wall', [(X(u0), GROUND, face_z), (X(u1), GROUND, face_z), (X(u1), wall_top(u1), face_z), (X(u0), wall_top(u0), face_z)])
            b.face('wall', [(X(u0), wall_top(u0), zz - wall / 2), (X(u1), wall_top(u1), zz - wall / 2), (X(u1), wall_top(u1), zz + wall / 2), (X(u0), wall_top(u0), zz + wall / 2)])
        for end in (throat, BAND[0]):
            b.face('wall', [(X(end), GROUND, zz - wall / 2), (X(end), GROUND, zz + wall / 2),
                            (X(end), wall_top(end), zz + wall / 2), (X(end), wall_top(end), zz - wall / 2)])
    # Markings: zebra across the mouth, give-way across the exit lane, dashed access centre line.
    for k in range(7):
        zz = z0 + .3 + k * .85
        surface('paint', [BAND[0] + .3, (BAND[0] + BAND[1]) / 2, BAND[1] - .5], zz, zz + .42, .005)
    exit_z = (zc, z1) if side == 'west' else (z0, zc)
    for offset in (.0, .22):
        u = BAND[1] - .32 + offset
        for k in range(5):
            za = exit_z[0] + .15 + k * .6
            surface('paint', [u - .05, u + .05], za, min(za + .4, exit_z[1] - .05), .006)
    for k in range(4):
        u = throat + .4 + k * 1.75
        surface('paint', [u, u + .5, u + 1.0], zc - .05, zc + .05, .005)
    return b.finish()


def triangles(objects):
    return sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objects if o.type == 'MESH')


def build(lots=None):
    lots = lots or read_layout()
    parts = {'parking-east-lot': build_lot(next(lot for lot in lots if lot['id'] == 'east'))}
    for side in ('west', 'east'):
        parts[f'parking-access-{side}'] = build_access(side, next(lot for lot in lots if lot['id'] == side))
    return parts


def profile():
    return {'z': ACCESS['z'], 'halfWidth': ACCESS['half'], 'throat': ACCESS['throat'], 'plinthEdge': PLINTH_EDGE,
            'bandStart': BAND[0], 'roadEdge': BAND[1], 'returnRadius': ACCESS['return'], 'wall': ACCESS['wall'],
            'top': TOP, 'walkTop': WALK_TOP, 'roadTop': ROAD_TOP, 'ease': 'smoothstep'}


def export(output):
    os.makedirs(output, exist_ok=True)
    lots = read_layout()
    parts = build(lots)
    groups = {name: {'triangles': triangles(objects)} for name, objects in parts.items()}
    total = sum(group['triangles'] for group in groups.values())
    assert total < 4000, total
    bpy.ops.object.select_all(action='DESELECT')
    for objects in parts.values():
        for obj in objects:
            obj.select_set(True)
        objects[0].parent.select_set(True)
    bpy.ops.export_scene.gltf(filepath=os.path.join(output, 'campus-parking.glb'), export_format='GLB', use_selection=True,
                              export_yup=True, export_extras=False, export_cameras=False, export_lights=False, export_apply=True)
    layout = {'$comment': 'Generated by tooling/blender/create-campus-parking.py from its layout markers; published by prepare-public-models.py.',
              'lots': lots, 'access': profile(), 'glb': {'groups': groups, 'triangles': total}}
    with open(os.path.join(output, 'campus-parking.layout.json'), 'w') as file:
        json.dump(layout, file, indent=2)
        file.write('\n')
    return layout


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', default=os.path.join(REPO, 'apps/web/local-assets/landscape'))
    parser.add_argument('--blend', help='Save the authored scene (review copy) to this path.')
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
    setup_scene('Extalia Parking', factory=True)
    create_markers()
    result = export(args.output)
    if args.blend:
        bpy.ops.wm.save_as_mainfile(filepath=args.blend, copy=True)
    print('CAMPUS_PARKING ' + json.dumps(result['glb']))
