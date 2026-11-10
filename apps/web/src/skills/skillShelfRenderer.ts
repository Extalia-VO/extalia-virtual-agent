import * as THREE from 'three';
import { BOOK_COLORS, BOOKS_PER_SHELF, type SkillBook } from './skillLibraryModel';
import { SkillBookMotion, type SkillBookPage } from './skillBookMotion';
import { bookSeed, createBookCover, createClothWeave, createPaperEdges } from './skillBookArtwork';
import { createShelfFlight, shelfFlightPose, SkillShelfMagic, type ShelfFlight } from './skillShelfMagic';

export interface ShelfReader { id: string | null; pages: readonly SkillBookPage[]; page: number; pageLabel: (page: number, total: number) => string }
export interface ShelfHover { id: string; clientX: number; clientY: number }
export interface ShelfActions { onSelect(id: string): void; onTurn(direction: -1 | 1): void; onClose(): void; onUnavailable(): void; onShelfRest(): void; onHover?(hover: ShelfHover | null): void }

/** Extalia's installed Three.js, procedural geometry and local canvas covers. No remote runtime or artwork. */
export function createSkillShelf(canvas: HTMLCanvasElement, books: readonly SkillBook[], actions: ShelfActions) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene();
  const rows = Math.ceil(BOOKS_PER_SHELF / 6);
  const camera = new THREE.PerspectiveCamera(34, 1, .1, 50);
  camera.position.set(.25, rows * .8, 12.5);
  camera.lookAt(0, (rows - 1) * .95, 0);
  scene.add(new THREE.HemisphereLight(0xfff5e7, 0x445566, 2));
  const key = new THREE.DirectionalLight(0xfff1db, 3); key.position.set(-3, 6, 7); scene.add(key);
  key.castShadow = true; key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, { left: -6, right: 6, top: rows * 2 + 2, bottom: -3, near: .5, far: 25 });
  key.shadow.bias = -.0008; key.shadow.normalBias = .015;
  const fill = new THREE.DirectionalLight(0xe2edff, 1.2); fill.position.set(5, 2, 4); scene.add(fill);
  const resources: { dispose(): void }[] = [];
  const geometry = (x: number, y: number, z: number) => { const g = new THREE.BoxGeometry(x, y, z); resources.push(g); return g; };
  const material = (color: string, roughness = .8) => { const m = new THREE.MeshStandardMaterial({ color, roughness }); resources.push(m); return m; };
  const wood = material('#49372e');
  const paper = material('#e6dfce');
  const gold = new THREE.MeshStandardMaterial({ color: '#d7bd80', metalness: .55, roughness: .42 }); resources.push(gold);
  const texture = (art: HTMLCanvasElement, color = true) => {
    const map = new THREE.CanvasTexture(art);
    if (color) map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy()); resources.push(map); return map;
  };
  const weave = texture(createClothWeave(), false); weave.wrapS = weave.wrapT = THREE.RepeatWrapping; weave.repeat.set(5, 8);
  const edgeMap = texture(createPaperEdges());
  const topEdgeMap = edgeMap.clone(); topEdgeMap.center.set(.5, .5); topEdgeMap.rotation = Math.PI / 2; resources.push(topEdgeMap);
  const paperEdge = new THREE.MeshStandardMaterial({ map: edgeMap, roughness: .96 });
  const topEdge = new THREE.MeshStandardMaterial({ map: topEdgeMap, roughness: .96 }); resources.push(paperEdge, topEdge);
  const bindingShade = material('#302a24');
  const shelfGeometry = geometry(8.1, .11, 1.05);
  for (let row = 0; row < rows; row++) {
    const shelf = new THREE.Mesh(shelfGeometry, wood); shelf.position.set(0, row * 1.9 - .79, -.07); shelf.receiveShadow = true; scene.add(shelf);
    const lip = new THREE.Mesh(geometry(8.1, .035, .03), material('#775d43')); lip.position.set(0, row * 1.9 - .765, .465); scene.add(lip);
  }
  const targets: THREE.Object3D[] = [];
  const volumes = new Map<string, { index: number; book: THREE.Group; hinge: THREE.Group; home: THREE.Vector3; rotation: THREE.Quaternion; title: string; leftStack: THREE.Mesh; glow: THREE.MeshStandardMaterial[]; flight: ShelfFlight | null; flightStart: number; flightPosition: THREE.Vector3 }>();
  books.forEach((book, index) => {
    const group = new THREE.Group();
    const x = (index % 6 - 2.5) * 1.22, y = (rows - 1 - Math.floor(index / 6)) * 1.9;
    group.position.set(x, y, 0); group.rotation.y = -.19 + (bookSeed(book.id) % 5 - 2) * .014;
    const color = new THREE.Color(BOOK_COLORS[book.category]); color.offsetHSL(((bookSeed(book.id) >>> 8) % 13 - 6) / 220, .025, .02);
    const clothColor = `#${color.getHexString()}`;
    const cloth = material(clothColor, .96); cloth.bumpMap = weave; cloth.bumpScale = .002;
    const block = new THREE.Mesh(geometry(.855, 1.425, .255), [paperEdge, paperEdge, topEdge, topEdge, paper, paper]); block.position.x = .005; group.add(block);
    const back = new THREE.Mesh(geometry(.94, 1.54, .045), cloth); back.position.z = -.15; group.add(back);
    const spineGeometry = new THREE.CylinderGeometry(.175, .175, 1.54, 16); resources.push(spineGeometry);
    const spine = new THREE.Mesh(spineGeometry, cloth); spine.scale.x = .23; spine.position.x = -.457; group.add(spine);
    const joint = new THREE.Mesh(geometry(.017, 1.49, .011), bindingShade); joint.position.set(-.421, 0, .177); group.add(joint);
    const hinge = new THREE.Group(); hinge.position.set(-.445, 0, .16); group.add(hinge);
    const cover = new THREE.Mesh(geometry(.94, 1.54, .045), cloth); cover.position.x = .445; hinge.add(cover);
    const printed = new THREE.MeshStandardMaterial({ map: texture(createBookCover(book, index, clothColor)), roughness: .91, bumpMap: weave, bumpScale: .0015 }); resources.push(printed);
    for (const surface of [cloth, printed]) { surface.emissive.set('#b9a7dc'); surface.emissiveIntensity = 0; }
    const faceGeometry = new THREE.PlaneGeometry(.925, 1.525); resources.push(faceGeometry);
    const face = new THREE.Mesh(faceGeometry, printed); face.position.set(.445, 0, .025); hinge.add(face);
    const leftStack = new THREE.Mesh(geometry(.885, 1.45, .025), [paperEdge, paperEdge, topEdge, topEdge, paper, paper]);
    leftStack.position.set(.43, 0, -.041); leftStack.visible = false; hinge.add(leftStack);
    const ribbonMaterial = material(color.clone().offsetHSL(.03, -.1, .16).getStyle(), .7);
    const ribbonGeometry = new THREE.Shape(); ribbonGeometry.moveTo(-.023, 0); ribbonGeometry.lineTo(.023, 0); ribbonGeometry.lineTo(.023, -.22); ribbonGeometry.lineTo(0, -.202); ribbonGeometry.lineTo(-.023, -.22); ribbonGeometry.closePath();
    const bookmarkGeometry = new THREE.ShapeGeometry(ribbonGeometry); resources.push(bookmarkGeometry);
    const bookmark = new THREE.Mesh(bookmarkGeometry, ribbonMaterial); bookmark.position.set(-.28, -.64, .105); group.add(bookmark);
    for (const offset of [-.57, .57]) {
      const band = new THREE.Mesh(geometry(.081, .012, .355), gold); band.position.set(-.457, offset, 0); group.add(band);
    }
    group.traverse(part => { part.userData.bookId = book.id; if (part instanceof THREE.Mesh) { part.castShadow = true; part.receiveShadow = true; targets.push(part); } });
    scene.add(group); volumes.set(book.id, { index, book: group, hinge, home: group.position.clone(), rotation: group.quaternion.clone(), title: book.title, leftStack, glow: [cloth, printed], flight: null, flightStart: 0, flightPosition: group.position.clone() });
  });
  const motion = new SkillBookMotion();
  const magic = new SkillShelfMagic(books.length);
  // A small, shared point burst; no textures, postprocessing, or perpetual ambient loop.
  const sparkGeometry = new THREE.BufferGeometry();
  const sparkPositions = new Float32Array(32 * 3), sparkSeeds = new Float32Array(32);
  for (let index = 0; index < 32; index++) {
    const seed = bookSeed(`shelf-spark-${index}`);
    sparkPositions.set([((seed & 255) / 255 - .5) * 1.16, (((seed >>> 8) & 255) / 255 - .5) * 1.6, .2 + ((seed >>> 16) & 255) / 255 * .14], index * 3);
    sparkSeeds[index] = (seed % 997) / 997;
  }
  sparkGeometry.setAttribute('position', new THREE.BufferAttribute(sparkPositions, 3));
  sparkGeometry.setAttribute('seed', new THREE.BufferAttribute(sparkSeeds, 1));
  const sparkMaterial = new THREE.ShaderMaterial({
    uniforms: { progress: { value: 1 }, pixelRatio: { value: renderer.getPixelRatio() } },
    vertexShader: `attribute float seed; uniform float progress; uniform float pixelRatio; varying float intensity;
      void main() {
        vec3 point = position; point.y += progress * (.16 + seed * .22);
        point.x += sin(progress * 4.0 + seed * 6.283) * .035;
        vec4 view = modelViewMatrix * vec4(point, 1.0);
        gl_Position = projectionMatrix * view;
        gl_PointSize = clamp((2.5 + seed * 3.0) * pixelRatio * 9.0 / -view.z, 1.0, 9.0);
        intensity = sin(progress * 3.14159) * (.3 + seed * .5);
      }`,
    fragmentShader: `varying float intensity;
      void main() {
        vec2 point = abs(gl_PointCoord - .5);
        float core = 1.0 - smoothstep(.08, .48, length(point));
        float cross = (1.0 - smoothstep(.02, .08, min(point.x, point.y))) * (1.0 - smoothstep(.1, .49, max(point.x, point.y)));
        gl_FragColor = vec4(.88, .81, 1.0, max(core * .55, cross) * intensity);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const sparks = new THREE.Points(sparkGeometry, sparkMaterial); sparks.frustumCulled = false; sparks.visible = false; scene.add(sparks);
  resources.push(sparkGeometry, sparkMaterial);
  // Eight past-path motes per volume share one bounded draw call and reusable GPU buffers.
  const dustCapacity = BOOKS_PER_SHELF * 8, dustGeometry = new THREE.BufferGeometry();
  const dustPositions = new THREE.BufferAttribute(new Float32Array(dustCapacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const dustStrengths = new THREE.BufferAttribute(new Float32Array(dustCapacity), 1).setUsage(THREE.DynamicDrawUsage);
  const dustTones = new Float32Array(dustCapacity);
  for (let index = 0; index < dustCapacity; index++) dustTones[index] = index % 3 === 0 ? 1 : 0;
  dustGeometry.setAttribute('position', dustPositions); dustGeometry.setAttribute('strength', dustStrengths);
  dustGeometry.setAttribute('tone', new THREE.BufferAttribute(dustTones, 1)); dustGeometry.setDrawRange(0, 0);
  const dustMaterial = new THREE.ShaderMaterial({
    uniforms: { pixelRatio: { value: renderer.getPixelRatio() } },
    vertexShader: `attribute float strength; attribute float tone; uniform float pixelRatio;
      varying float alpha; varying vec3 tint;
      void main() {
        vec4 view = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * view;
        gl_PointSize = clamp((5.0 + tone * 2.0) * pixelRatio * 10.0 / -view.z, 2.0, 11.0);
        alpha = strength; tint = mix(vec3(.2, .94, .8), vec3(1.0, .78, .34), tone);
      }`,
    fragmentShader: `varying float alpha; varying vec3 tint;
      void main() {
        float radius = length(gl_PointCoord - .5);
        float halo = 1.0 - smoothstep(.04, .5, radius);
        float core = 1.0 - smoothstep(.01, .15, radius);
        gl_FragColor = vec4(tint, (halo * .65 + core * .35) * alpha);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const dust = new THREE.Points(dustGeometry, dustMaterial); dust.frustumCulled = false; dust.visible = false; scene.add(dust);
  const dustPoint = new THREE.Vector3(); resources.push(dustGeometry, dustMaterial);
  // One bounded smoke draw call follows hovered volumes; only active hover keeps it moving.
  const auraGeometry = new THREE.PlaneGeometry(2.1, 3.05);
  const auraStrengths = new THREE.InstancedBufferAttribute(new Float32Array(BOOKS_PER_SHELF), 1).setUsage(THREE.DynamicDrawUsage);
  const auraFloors = new THREE.InstancedBufferAttribute(new Float32Array(BOOKS_PER_SHELF), 1).setUsage(THREE.DynamicDrawUsage);
  auraGeometry.setAttribute('strength', auraStrengths); auraGeometry.setAttribute('shelfTop', auraFloors);
  const auraMaterial = new THREE.ShaderMaterial({
    uniforms: { smokeTime: { value: 0 }, frontLayer: { value: 0 } },
    vertexShader: `attribute float strength; attribute float shelfTop;
      varying vec2 point; varying vec2 bookPoint; varying float worldHeight; varying float floorHeight;
      varying float alpha; varying vec3 tint;
      void main() {
        point = uv * 2.0 - 1.0; alpha = strength; tint = instanceColor;
        bookPoint = position.xy; floorHeight = shelfTop;
        worldHeight = (modelMatrix * instanceMatrix * vec4(position, 1.0)).y;
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `uniform float smokeTime; uniform float frontLayer;
      varying vec2 point; varying vec2 bookPoint; varying float worldHeight; varying float floorHeight;
      varying float alpha; varying vec3 tint;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 cell = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(cell), hash(cell + vec2(1.0, 0.0)), f.x),
          mix(hash(cell + vec2(0.0, 1.0)), hash(cell + vec2(1.0)), f.x), f.y);
      }
      float smoke(vec2 p) {
        return noise(p) * .57 + noise(p * 2.07 + vec2(7.1, 3.4)) * .28
          + noise(p * 4.11 + vec2(2.8, 9.2)) * .15;
      }
      void main() {
        // Clips follow both the tilted book foot and its fixed shelf, preventing undershelf spill.
        float footClip = smoothstep(-.77, -.69, bookPoint.y) * smoothstep(floorHeight, floorHeight + .035, worldHeight);
        if (footClip <= .001) discard;
        vec2 flow = vec2(point.x * 3.4 + sin(point.y * 5.0 - smokeTime * 2.1) * .48,
          point.y * 3.8 - smokeTime * 1.35);
        float billow = smoke(flow);
        vec2 edge = vec2(point.x + sin(point.y * 4.0 - smokeTime * 1.7) * .06, (point.y + .1) * .82);
        float plume = 1.0 - smoothstep(.60 + billow * .18, 1.0, length(edge));
        float density = smoothstep(.22, .73, billow);
        float wisps = smoothstep(.12, .72, billow + sin(point.y * 8.0 - smokeTime * 2.4) * .09);
        vec3 pigment = tint / max(.12, max(tint.r, max(tint.g, tint.b)));
        vec3 color = pigment * (.24 + billow * .7);
        float opacity = min(.94, (.18 + density * .75 + wisps * .24) * plume);
        if (frontLayer > .5) {
          float bottom = 1.0 - smoothstep(-.59, -.35, bookPoint.y);
          float sides = smoothstep(.36, .48, abs(bookPoint.x)) * (1.0 - smoothstep(-.4, .08, bookPoint.y));
          float coverWidth = 1.0 - smoothstep(.49, .59, abs(bookPoint.x));
          opacity *= max(bottom * .27, sides * .12) * coverWidth;
        }
        gl_FragColor = vec4(color, opacity * alpha * footClip);
      }`,
    transparent: true, depthWrite: false, blending: THREE.NormalBlending,
  });
  const auras = new THREE.InstancedMesh(auraGeometry, auraMaterial, BOOKS_PER_SHELF);
  auras.frustumCulled = false; auras.count = 0; auras.visible = false;
  auras.instanceMatrix.setUsage(THREE.DynamicDrawUsage); auras.setColorAt(0, new THREE.Color());
  auras.instanceColor!.setUsage(THREE.DynamicDrawUsage); scene.add(auras);
  const frontAuraMaterial = auraMaterial.clone(); frontAuraMaterial.uniforms.frontLayer!.value = 1;
  const frontAuras = new THREE.InstancedMesh(auraGeometry, frontAuraMaterial, BOOKS_PER_SHELF);
  frontAuras.frustumCulled = false; frontAuras.count = 0; frontAuras.visible = false;
  frontAuras.instanceMatrix.setUsage(THREE.DynamicDrawUsage); frontAuras.instanceColor = auras.instanceColor; scene.add(frontAuras);
  const auraMatrix = new THREE.Matrix4(), auraOffset = new THREE.Matrix4().makeTranslation(0, 0, -.23), frontAuraOffset = new THREE.Matrix4().makeTranslation(0, 0, .225), auraTint = new THREE.Color();
  resources.push(auraGeometry, auraMaterial, auras, frontAuraMaterial, frontAuras);
  let requested: ShelfReader = { id: null, pages: [], page: 0, pageLabel: () => '' };
  let content: ShelfReader = requested;
  let attached: string | null = null;
  let painted = '';
  let compact = false;
  const pageSurface = (reverse = false) => {
    const art = document.createElement('canvas'); art.width = 768; art.height = 1152;
    const texture = new THREE.CanvasTexture(art); texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    const printed = new THREE.MeshStandardMaterial({ map: texture, roughness: .96 });
    const meshGeometry = new THREE.PlaneGeometry(.85, 1.42, 40, 8);
    const mesh = new THREE.Mesh(meshGeometry, printed);
    mesh.castShadow = true; mesh.receiveShadow = true;
    if (reverse) mesh.rotation.y = Math.PI;
    resources.push(texture, printed, meshGeometry);
    return { art, texture, mesh };
  };
  const left = pageSurface(true), right = pageSurface();
  const front = pageSurface(), back = pageSurface(true);
  left.mesh.position.set(.43, 0, -.056); left.mesh.scale.set(1.035, 1.018, 1);
  right.mesh.position.set(.005, 0, .132);
  const leaf = new THREE.Group(); leaf.position.set(-.4275, 0, .195);
  front.mesh.position.set(.4325, 0, .001); back.mesh.position.set(.4325, 0, -.001);
  leaf.add(front.mesh, back.mesh);
  const shade = new THREE.MeshBasicMaterial({ color: '#100e0c', transparent: true, opacity: 0, depthWrite: false });
  const veilGeometry = new THREE.PlaneGeometry(1, 1);
  const veil = new THREE.Mesh(veilGeometry, shade); scene.add(veil); resources.push(shade, veilGeometry);
  const forward = new THREE.Vector3(), rightAxis = new THREE.Vector3(), upAxis = new THREE.Vector3(), goal = new THREE.Vector3();
  const inspectionTilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(-.035, -.27, -.006));
  const inspectionRotation = new THREE.Quaternion();

  function paint(surface: ReturnType<typeof pageSurface>, page: number) {
    const ctx = surface.art.getContext('2d'); if (!ctx) return;
    const data = content.pages[page];
    const width = surface.art.width, height = surface.art.height;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#f5f1e6'; ctx.fillRect(0, 0, width, height);
    const gradient = ctx.createLinearGradient(0, 0, width, 0);
    gradient.addColorStop(0, '#8c7f6045'); gradient.addColorStop(.035, '#c9bfa336'); gradient.addColorStop(.13, '#f5f1e600'); gradient.addColorStop(.91, '#f5f1e600'); gradient.addColorStop(1, '#bcb09530');
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, width, height);
    // Faint laid-paper lines add texture without competing with literal skill text.
    ctx.fillStyle = '#86795c05'; for (let y = 0; y < height; y += 4) ctx.fillRect(0, y, width, 1);
    ctx.fillStyle = '#82775e'; ctx.font = '18px sans-serif'; ctx.fillText('E X T A L I A', 65, 59);
    ctx.textAlign = 'right';
    if (data) ctx.fillText(String(page + 1).padStart(2, '0'), 703, 59);
    ctx.textAlign = 'start';
    ctx.strokeStyle = '#c6bca5'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(65, 84); ctx.lineTo(703, 84); ctx.stroke();
    const volume = motion.activeId ? volumes.get(motion.activeId) : undefined;
    ctx.fillStyle = '#84775f'; ctx.font = 'italic 24px Georgia, serif';
    if (volume) ctx.fillText(volume.title, 65, 128, 638);
    let code = false;
    data?.lines.forEach((line, index) => {
      // Render the original characters, including Markdown markers. Prose receives
      // book typography; code remains monospaced. Nothing executes or rewrites it.
      if (line.trimStart().startsWith('```') || line.trimStart().startsWith('~~~')) code = !code;
      const heading = /^\s*#{1,6}\s/u.test(line);
      ctx.fillStyle = heading ? '#394c60' : '#30342e';
      ctx.font = code || /^\s{2,}/u.test(line) ? '38px ui-monospace, monospace' : heading ? 'bold 43px Georgia, serif' : '44px Georgia, serif';
      ctx.fillText(line, 65, 193 + index * 52, 638);
    });
    ctx.strokeStyle = '#c6bca5'; ctx.beginPath(); ctx.moveTo(65, 1059); ctx.lineTo(703, 1059); ctx.stroke();
    ctx.fillStyle = '#82775e'; ctx.font = '24px Georgia, serif'; ctx.textAlign = 'center';
    if (data) ctx.fillText(content.pageLabel(page + 1, content.pages.length), 384, 1103, 638);
    ctx.textAlign = 'start'; surface.texture.needsUpdate = true;
  }
  const pair = (page: number) => compact ? [page - 1, page] as const : [page, page + 1] as const;
  function updatePages() {
    const volume = motion.activeId ? volumes.get(motion.activeId) : undefined;
    if (attached !== motion.activeId) {
      left.mesh.removeFromParent(); right.mesh.removeFromParent(); leaf.removeFromParent();
      attached = motion.activeId; painted = '';
      if (volume) { volume.hinge.add(left.mesh); volume.book.add(right.mesh, leaf); }
    }
    if (!volume) return;
    const turning = motion.phase === 'turning';
    const forwardTurn = motion.toPage > motion.fromPage;
    const [oldLeft, oldRight] = pair(turning ? motion.fromPage : motion.page);
    const [newLeft, newRight] = pair(turning ? motion.toPage : motion.page);
    const signature = `${motion.activeId}:${compact}:${turning}:${oldLeft}:${newLeft}:${content.pages.length}`;
    if (painted !== signature) {
      paint(left, turning && !forwardTurn ? newLeft : oldLeft);
      paint(right, turning && forwardTurn ? newRight : oldRight);
      paint(front, forwardTurn ? oldRight : newRight);
      paint(back, forwardTurn ? newLeft : oldLeft);
      painted = signature;
    }
    left.mesh.visible = right.mesh.visible = volume.leftStack.visible = motion.open > .02;
    leaf.visible = turning;
    if (turning) {
      const leafProgress = forwardTurn ? motion.turn : 1 - motion.turn;
      leaf.rotation.y = -(Math.PI - .065) * leafProgress;
      leaf.position.z = .135 + .08 * leafProgress;
      const curve = .14 * Math.sin(motion.turn * Math.PI);
      for (const [surface, sign] of [[front, 1], [back, -1]] as const) {
        const positions = surface.mesh.geometry.attributes.position!;
        for (let vertex = 0; vertex < positions.count; vertex++) {
          const localAcross = (positions.getX(vertex) + .425) / .85;
          const across = sign === 1 ? localAcross : 1 - localAcross;
          const corner = positions.getY(vertex) / .71;
          positions.setZ(vertex, sign * (Math.sin(across * Math.PI) * curve + Math.pow(across, 3) * corner * curve * .2));
        }
        positions.needsUpdate = true;
        surface.mesh.geometry.computeVertexNormals();
        surface.mesh.geometry.computeBoundingSphere();
      }
    }
  }

  let frame = 0, disposed = false, previousTime: number | undefined, wasActive = false, smokeActive = false, smokeTime = 0;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const render = (time: number) => {
    frame = 0;
    if (disposed || document.hidden) return;
    // Let finite book motion stay smooth; render a resting smoke plume at at most 30 fps.
    if (smokeActive && !reduced.matches && !motion.animating && !magic.animating && previousTime !== undefined && time - previousTime < 1000 / 30 - .5) {
      frame = requestAnimationFrame(render); return;
    }
    const delta = previousTime === undefined ? 16 : Math.min(64, time - previousTime);
    motion.advance(delta, reduced.matches); magic.advance(delta, reduced.matches);
    if (motion.activeId === requested.id && content !== requested) { content = requested; painted = ''; }
    const distance = 3.8;
    const height = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * distance;
    const width = height * camera.aspect;
    const scale = Math.min(width * .86 / (compact ? .96 : 1.92), height * (compact ? .66 : .73) / 1.54);
    camera.getWorldDirection(forward);
    rightAxis.set(1, 0, 0).applyQuaternion(camera.quaternion);
    upAxis.set(0, 1, 0).applyQuaternion(camera.quaternion);
    goal.copy(camera.position).addScaledVector(forward, distance).addScaledVector(rightAxis, compact ? 0 : .47 * scale).addScaledVector(upAxis, .02 * height);
    inspectionRotation.copy(camera.quaternion).multiply(inspectionTilt);
    const decorative = !reduced.matches && !motion.activeId && !requested.id;
    let dustCount = 0, auraCount = 0;
    for (const [id, volume] of volumes) {
      const amount = id === motion.activeId ? motion.lift : 0;
      const arrival = magic.reveal(volume.index), hover = motion.activeId || requested.id ? 0 : magic.hover(volume.index);
      const flight = volume.flight && arrival < 1 ? shelfFlightPose(volume.flight, (arrival - volume.flightStart) / (1 - volume.flightStart), arrival) : null;
      if (flight) volume.flightPosition.set(flight.x, flight.y, flight.z).unproject(camera);
      else volume.flightPosition.copy(volume.home);
      volume.book.position.copy(volume.flightPosition).lerp(goal, amount);
      volume.book.position.y += hover * .065 * (1 - amount);
      volume.book.position.z += hover * .15 * (1 - amount);
      volume.book.quaternion.copy(volume.rotation);
      if (flight) { volume.book.rotateZ(flight.roll); volume.book.rotateY(flight.tilt); }
      volume.book.quaternion.slerp(inspectionRotation, amount);
      volume.book.rotateX(-hover * .025 * (1 - amount));
      volume.book.scale.setScalar((1 + (scale - 1) * amount) * (1 + ((flight?.scale ?? 1) - 1) * (1 - amount)));
      const arrivalGlow = decorative ? .14 * Math.sin(arrival * Math.PI) + .12 * Math.sin(Math.max(0, (arrival - .65) / .35) * Math.PI) : 0;
      for (const surface of volume.glow) surface.emissiveIntensity = (arrivalGlow + hover * .12) * (1 - amount);
      if (decorative && hover > 0 && auraCount < BOOKS_PER_SHELF) {
        volume.book.updateMatrixWorld(); auraMatrix.copy(volume.book.matrixWorld).multiply(auraOffset);
        auras.setMatrixAt(auraCount, auraMatrix);
        auraMatrix.copy(volume.book.matrixWorld).multiply(frontAuraOffset); frontAuras.setMatrixAt(auraCount, auraMatrix);
        auraTint.copy(volume.glow[0]!.color);
        auras.setColorAt(auraCount, auraTint); auraStrengths.setX(auraCount, hover);
        auraFloors.setX(auraCount, volume.home.y - .79 + .11 / 2); auraCount++;
      }
      if (decorative && volume.flight && arrival > 0 && arrival < 1 && volume.index < BOOKS_PER_SHELF) {
        for (let sample = 0; sample < 8; sample++) {
          const past = Math.max(volume.flightStart, magic.reveal(volume.index, 16 + sample * 18));
          const trail = shelfFlightPose(volume.flight, (past - volume.flightStart) / (1 - volume.flightStart), past);
          const phase = arrival * 8 + sample * .73 + volume.index * 1.31;
          dustPoint.set(trail.x, trail.y, trail.z).unproject(camera)
            .addScaledVector(rightAxis, Math.sin(phase) * .065)
            .addScaledVector(upAxis, Math.cos(phase) * .065 - .17)
            .addScaledVector(forward, .12);
          dustPositions.setXYZ(dustCount, dustPoint.x, dustPoint.y, dustPoint.z);
          dustStrengths.setX(dustCount, (.8 - sample * .07) * Math.sin(arrival * Math.PI));
          dustCount++;
        }
      }
      volume.hinge.rotation.y = id === motion.activeId ? -(Math.PI - .065) * motion.open : 0;
      volume.leftStack.visible = id === motion.activeId && motion.open > .02;
    }
    dust.visible = dustCount > 0; dustGeometry.setDrawRange(0, dustCount);
    if (dustCount) { dustPositions.needsUpdate = true; dustStrengths.needsUpdate = true; }
    auras.count = frontAuras.count = auraCount; auras.visible = frontAuras.visible = auraCount > 0;
    if (auraCount) {
      auras.instanceMatrix.needsUpdate = true; frontAuras.instanceMatrix.needsUpdate = true;
      auras.instanceColor!.needsUpdate = true; auraStrengths.needsUpdate = true; auraFloors.needsUpdate = true;
    }
    smokeActive = decorative && auraCount > 0;
    if (smokeActive) smokeTime += delta / 1000;
    auraMaterial.uniforms.smokeTime!.value = smokeTime;
    frontAuraMaterial.uniforms.smokeTime!.value = smokeTime;
    previousTime = motion.animating || magic.animating || smokeActive ? time : undefined;
    veil.position.copy(camera.position).addScaledVector(forward, 6); veil.quaternion.copy(camera.quaternion);
    veil.scale.set(width * 6 / distance * 1.1, height * 6 / distance * 1.1, 1);
    shade.opacity = .66 * motion.lift; veil.visible = motion.lift > .01;
    const sparkling = books[magic.burstIndex ?? -1];
    const sparkVolume = sparkling ? volumes.get(sparkling.id) : undefined;
    sparks.visible = !!sparkVolume && magic.burst < 1 && !reduced.matches && !motion.activeId && !requested.id;
    if (sparkVolume && sparks.visible) {
      sparks.position.copy(sparkVolume.book.position); sparks.quaternion.copy(sparkVolume.book.quaternion);
      sparkMaterial.uniforms.progress!.value = magic.burst;
    }
    updatePages();
    canvas.dataset.bookPhase = motion.phase;
    canvas.dataset.activeBook = motion.activeId ?? '';
    renderer.render(scene, camera);
    if (!motion.activeId && wasActive) actions.onShelfRest();
    wasActive = motion.activeId !== null;
    if (!disposed && !document.hidden && (motion.animating || magic.animating || smokeActive)) frame = requestAnimationFrame(render);
  };
  const draw = () => { if (!disposed && !frame && !document.hidden) frame = requestAnimationFrame(render); };
  const resize = () => {
    const { width, height } = canvas.getBoundingClientRect();
    if (!width || !height) return;
    compact = width < 620;
    renderer.setSize(width, height, false); camera.aspect = width / height;
    const vertical = THREE.MathUtils.degToRad(camera.fov);
    camera.position.z = Math.max(10.4, 8.8 / (2 * Math.tan(vertical / 2) * camera.aspect));
    camera.lookAt(0, (rows - 1) * .95, 0); camera.updateProjectionMatrix(); camera.updateMatrixWorld();
    for (const volume of volumes.values()) {
      const arrival = magic.reveal(volume.index), home = volume.home.clone().project(camera);
      const depth = -volume.home.clone().applyMatrix4(camera.matrixWorldInverse).z;
      // Sphere radius covers the book and its initial tilt; using the near side keeps every edge offscreen.
      const nearDepth = Math.max(.1, depth - 1.1);
      const extent = { x: 1.1 * camera.projectionMatrix.elements[0]! / nearDepth, y: 1.1 * camera.projectionMatrix.elements[5]! / nearDepth };
      // Rebase an airborne path from its current world pose, so resizing never teleports it to an edge.
      const from = volume.flight && arrival > 0 && arrival < 1 ? volume.flightPosition.clone().project(camera) : undefined;
      volume.flight = createShelfFlight(volume.index, home, extent, from);
      volume.flightStart = from ? arrival : 0;
    }
    draw();
  };
  const ray = new THREE.Raycaster(); const pointer = new THREE.Vector2();
  const hit = (event: PointerEvent) => {
    const box = canvas.getBoundingClientRect(); if (!box.width || !box.height) return;
    scene.updateMatrixWorld(true); camera.updateMatrixWorld();
    pointer.set((event.clientX - box.left) / box.width * 2 - 1, -(event.clientY - box.top) / box.height * 2 + 1);
    ray.setFromCamera(pointer, camera); return ray.intersectObjects(targets, false)[0];
  };
  let pressed: { x: number; y: number; pointerId: number; book: string | undefined } | undefined;
  let hovered: ShelfHover | null = null;
  const clearHover = () => {
    canvas.style.cursor = '';
    if (hovered) { hovered = null; actions.onHover?.(null); }
    magic.setHover(null); draw();
  };
  const down = (event: PointerEvent) => {
    if (event.pointerType === 'touch') clearHover();
    if (event.button === 0 && event.isPrimary) pressed = { x: event.clientX, y: event.clientY, pointerId: event.pointerId, book: hit(event)?.object.userData.bookId as string | undefined };
  };
  const cancel = () => { pressed = undefined; clearHover(); };
  const choose = (event: PointerEvent) => {
    if (event.button !== 0 || !event.isPrimary || pressed?.pointerId !== event.pointerId) return;
    const previous = pressed; pressed = undefined;
    const found = hit(event), id = found?.object.userData.bookId as string | undefined;
    if (previous) {
      const dx = event.clientX - previous.x, dy = event.clientY - previous.y;
      if (Math.abs(dy) > 18 && Math.abs(dy) > Math.abs(dx)) return;
      if (Math.abs(dx) > 30) {
        if (previous.book === motion.activeId && motion.phase === 'reading') actions.onTurn(dx < 0 ? 1 : -1);
        return;
      }
    }
    if (!id) { if (motion.activeId) actions.onClose(); return; }
    if (id === motion.activeId && motion.phase === 'reading' && found) {
      const local = volumes.get(id)!.book.worldToLocal(found.point.clone());
      actions.onTurn(local.x > -.47 ? 1 : -1);
    } else if (id !== motion.activeId) { clearHover(); actions.onSelect(id); }
  };
  const hover = (event: PointerEvent) => {
    if (!['mouse', 'pen'].includes(event.pointerType) || document.hidden) { clearHover(); return; }
    if (motion.activeId || requested.id) { clearHover(); canvas.style.cursor = hit(event) ? 'pointer' : ''; return; }
    const id = hit(event)?.object.userData.bookId as string | undefined;
    if (!id) { clearHover(); return; }
    canvas.style.cursor = 'pointer';
    hovered = { id, clientX: event.clientX, clientY: event.clientY }; actions.onHover?.(hovered);
    magic.setHover(volumes.get(id)!.index); draw();
  };
  const visibility = () => {
    previousTime = undefined;
    if (document.hidden) { cancel(); if (frame) cancelAnimationFrame(frame); frame = 0; }
    else draw();
  };
  const lost = (event: Event) => { event.preventDefault(); actions.onUnavailable(); };
  const observer = new ResizeObserver(resize); observer.observe(canvas);
  canvas.addEventListener('pointerdown', down); canvas.addEventListener('pointerup', choose); canvas.addEventListener('pointercancel', cancel); canvas.addEventListener('pointerleave', clearHover); canvas.addEventListener('pointermove', hover); canvas.addEventListener('webglcontextlost', lost);
  document.addEventListener('visibilitychange', visibility); document.addEventListener('scroll', clearHover, true); reduced.addEventListener('change', draw); resize();
  return {
    read(next: ShelfReader) { clearHover(); requested = next; motion.request(next.id, next.page); draw(); },
    dispose() {
      disposed = true; cancel(); cancelAnimationFrame(frame); observer.disconnect();
      canvas.removeEventListener('pointerdown', down); canvas.removeEventListener('pointerup', choose); canvas.removeEventListener('pointercancel', cancel); canvas.removeEventListener('pointerleave', clearHover); canvas.removeEventListener('pointermove', hover); canvas.removeEventListener('webglcontextlost', lost);
      document.removeEventListener('visibilitychange', visibility); document.removeEventListener('scroll', clearHover, true); reduced.removeEventListener('change', draw);
      resources.forEach(resource => resource.dispose()); key.shadow.dispose(); scene.clear(); renderer.dispose();
      // StrictMode reuses the canvas immediately; release its context only after actual removal.
      queueMicrotask(() => { if (!canvas.isConnected) renderer.forceContextLoss(); });
    },
  };
}
