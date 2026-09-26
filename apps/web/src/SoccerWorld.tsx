import { useEffect, useRef } from "react";
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { FXAAShader } from "three/addons/shaders/FXAAShader.js";
import { withOpaqueOccluders } from "./opaqueOcclusion";
import { addStadiumDetail, footballTexture } from "./stadiumDetail";
import type { Hip4Outcome } from "./hip4";
import type { VoteCount, VoteSide } from "./types";

const KICK_CUTINS = [
  "/event/mbappe-commander-kick.webp",
  "/event/mbappe-commander-kick-v2.webp",
  "/event/mbappe-commander-kick-v3.webp",
  "/event/mbappe-commander-kick-v4.webp",
] as const;

type Props = {
  market: Hip4Outcome | null;
  prices: { YES: number; NO: number };
  kicks: VoteCount;
  onKick: (side: VoteSide, multiplier: number, outcomeId: number) => void;
  onReady: () => void;
  paused?: boolean;
};

function drawTarget(canvas: HTMLCanvasElement, side: VoteSide, country: string, price: number, active: boolean) {
  const ctx = canvas.getContext("2d")!;
  const color = side === "YES" ? "#6df3b6" : "#f06d63";
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  gradient.addColorStop(0, "rgba(4,14,24,.96)");
  gradient.addColorStop(1, side === "YES" ? "rgba(9,65,61,.96)" : "rgba(68,20,18,.96)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = color;
  ctx.lineWidth = active ? 15 : 7;
  ctx.shadowColor = color;
  ctx.shadowBlur = active ? 32 : 12;
  ctx.strokeRect(10, 10, canvas.width - 20, canvas.height - 20);
  ctx.shadowBlur = 0;
  ctx.fillStyle = color;
  ctx.font = "900 66px Arial";
  ctx.fillText(side, 34, 80);
  ctx.fillStyle = "#f3fffd";
  ctx.font = "900 38px Arial";
  ctx.fillText(`${Math.round(price * 100)}¢`, canvas.width - 120, 76);
  ctx.font = "800 22px Arial";
  ctx.fillText(country.toUpperCase(), 35, 130, 420);
  ctx.fillStyle = "#789ea4";
  ctx.font = "700 15px monospace";
  ctx.fillText("KICK HERE · POWER = CONTRACTS", 36, 168);
}

function drawScoreboard(canvas: HTMLCanvasElement, market: Hip4Outcome | null, prices: Props["prices"], kicks: VoteCount) {
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#030812";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#8ef5e3";
  ctx.fillRect(0, 0, canvas.width, 8);
  ctx.fillStyle = "#e89a42";
  ctx.fillRect(canvas.width / 2, 0, canvas.width / 2, 8);
  ctx.fillStyle = "#6c8f98";
  ctx.font = "800 18px monospace";
  ctx.fillText(`HYPERSTRIKE WORLD CUP DEMO · REF #${market?.outcome ?? "—"}`, 32, 48);
  ctx.fillStyle = "#f2fffd";
  ctx.font = "900 42px Arial";
  ctx.fillText(market?.name.toUpperCase() ?? "SELECT A DEMO OUTCOME", 31, 100, 850);
  ctx.fillStyle = "#6df3b6";
  ctx.font = "900 25px monospace";
  ctx.fillText(`YES ${Math.round(prices.YES * 100)}¢ · ${kicks.YES} CONTRACTS`, 32, 145);
  ctx.fillStyle = "#f06d63";
  ctx.fillText(`NO ${Math.round(prices.NO * 100)}¢ · ${kicks.NO} CONTRACTS`, 520, 145);
}

function fireTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(64, 64, 1, 64, 64, 62);
  gradient.addColorStop(0, "rgba(255,255,218,1)");
  gradient.addColorStop(.2, "rgba(255,220,61,.98)");
  gradient.addColorStop(.5, "rgba(255,88,8,.72)");
  gradient.addColorStop(1, "rgba(160,0,35,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function smokeTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 192;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(96, 96, 8, 96, 96, 92);
  gradient.addColorStop(0, "rgba(255,94,91,.86)");
  gradient.addColorStop(0.25, "rgba(231,21,63,.62)");
  gradient.addColorStop(0.62, "rgba(118,5,38,.3)");
  gradient.addColorStop(1, "rgba(35,0,18,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 192, 192);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function supporterFlagTexture(index: number) {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 320;
  const ctx = canvas.getContext("2d")!;
  const palettes = [
    ["#07181d", "#8ef5e3", "#eff3ee"],
    ["#07181d", "#e89a42", "#f2c077"],
    ["#07181d", "#f06d63", "#8ef5e3"],
  ];
  const colors = palettes[index % palettes.length];
  colors.forEach((color, stripe) => {
    ctx.fillStyle = color;
    ctx.fillRect(stripe * canvas.width / 3, 0, canvas.width / 3 + 1, canvas.height);
  });
  ctx.strokeStyle = "rgba(255,255,255,.85)";
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.arc(256, 160, 82, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "rgba(1,5,18,.72)";
  ctx.beginPath();
  ctx.arc(256, 160, 58, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#f4ffff";
  ctx.font = "900 48px Arial";
  ctx.textAlign = "center";
  ctx.fillText("HSX", 256, 177);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

function pitchTexture(renderer: THREE.WebGLRenderer) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 2048;
  const ctx = canvas.getContext("2d")!;
  const stripeWidth = canvas.width / 12;
  for (let stripe = 0; stripe < 12; stripe += 1) {
    const gradient = ctx.createLinearGradient(stripe * stripeWidth, 0, (stripe + 1) * stripeWidth, 0);
    gradient.addColorStop(0, stripe % 2 ? "#25442b" : "#305336");
    gradient.addColorStop(0.5, stripe % 2 ? "#325638" : "#446f42");
    gradient.addColorStop(1, stripe % 2 ? "#243d29" : "#345538");
    ctx.fillStyle = gradient;
    ctx.fillRect(stripe * stripeWidth, 0, stripeWidth + 1, canvas.height);
  }
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  for (let index = 0; index < image.data.length; index += 4) {
    const grain = (Math.random() - 0.5) * 20;
    image.data[index] += grain * 0.24;
    image.data[index + 1] += grain * 0.62;
    image.data[index + 2] += grain;
  }
  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
  return texture;
}

function stadiumSkyTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 2048;
  canvas.height = 1024;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(2, 2);
  const sky = ctx.createLinearGradient(0, 0, 0, canvas.height);
  sky.addColorStop(0, "#010607");
  sky.addColorStop(0.5, "#031014");
  sky.addColorStop(0.78, "#08252b");
  sky.addColorStop(1, "#050b0d");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const cyanGlow = ctx.createRadialGradient(230, 300, 8, 230, 300, 310);
  cyanGlow.addColorStop(0, "rgba(142,245,227,.16)");
  cyanGlow.addColorStop(1, "rgba(142,245,227,0)");
  ctx.fillStyle = cyanGlow;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const magentaGlow = ctx.createRadialGradient(820, 285, 8, 820, 285, 290);
  magentaGlow.addColorStop(0, "rgba(232,154,66,.16)");
  magentaGlow.addColorStop(1, "rgba(232,154,66,0)");
  ctx.fillStyle = magentaGlow;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let index = 0; index < 160; index += 1) {
    ctx.fillStyle = index % 9 === 0 ? "#f06d63" : index % 3 === 0 ? "#e89a42" : "#8ef5e3";
    ctx.globalAlpha = 0.18 + Math.random() * 0.72;
    const size = Math.random() * 2.2;
    ctx.fillRect(Math.random() * canvas.width, Math.random() * 390, size, size);
  }
  ctx.globalAlpha = 1;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.mapping = THREE.EquirectangularReflectionMapping;
  return texture;
}

function disposeScene(scene: THREE.Scene) {
  scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh || object instanceof THREE.LineSegments || object instanceof THREE.Points || object instanceof THREE.Sprite)) return;
    object.geometry.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.forEach((material) => {
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) value.dispose();
      material.dispose();
    });
  });
}

export function SoccerWorld({ market, prices, kicks, onKick, onReady, paused = false }: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const marketRef = useRef(market);
  const pricesRef = useRef(prices);
  const kicksRef = useRef(kicks);
  const kickRef = useRef(onKick);
  const readyRef = useRef(onReady);
  const pausedRef = useRef(paused);
  useEffect(() => { pausedRef.current = paused; }, [paused]);
  const gaugeFillRef = useRef<HTMLElement>(null);
  const gaugeNumberRef = useRef<HTMLElement>(null);
  const focusCutinRef = useRef<HTMLDivElement>(null);
  const kickCutinRef = useRef<HTMLDivElement>(null);
  const kickMultiplierRef = useRef<HTMLElement>(null);
  const kickImageRef = useRef<HTMLImageElement>(null);
  useEffect(() => { marketRef.current = market; }, [market]);
  useEffect(() => { pricesRef.current = prices; }, [prices]);
  useEffect(() => { kicksRef.current = kicks; }, [kicks]);
  useEffect(() => { kickRef.current = onKick; }, [onKick]);
  useEffect(() => { readyRef.current = onReady; }, [onReady]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let disposed = false;
    const manager = new THREE.LoadingManager();
    manager.itemStart("stadium-bootstrap");
    const loader = new THREE.TextureLoader(manager);
    const surfaceTextures: THREE.Texture[] = [];
    const loadMap = (url: string, repeatX: number, repeatY: number, srgb: boolean, apply: (map: THREE.Texture) => void) => {
      loader.load(url, map => {
        if (disposed) { map.dispose(); return; }
        map.wrapS=map.wrapT=THREE.RepeatWrapping;map.repeat.set(repeatX,repeatY);
        if (srgb) map.colorSpace=THREE.SRGBColorSpace;
        map.anisotropy=Math.min(16,renderer.capabilities.getMaxAnisotropy());surfaceTextures.push(map);apply(map);
      }, undefined, () => { mount.dataset.materialStatus = "fallback"; });
    };
    KICK_CUTINS.forEach((source) => {
      const image = new Image();
      image.decoding = "async";
      image.src = source;
    });
    const scene = new THREE.Scene();
    const skyTexture = stadiumSkyTexture();
    scene.background = skyTexture;
    scene.fog = new THREE.FogExp2(0x0a1716, 0.008);
    const camera = new THREE.PerspectiveCamera(56, mount.clientWidth / mount.clientHeight, 0.08, 100);
    camera.position.set(0, 2.85, 10.6);
    camera.lookAt(0, 1.35, -6.7);

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance", stencil: false });
    const renderPixelRatio = Math.min(devicePixelRatio, 1.75, Math.sqrt(2_800_000 / (mount.clientWidth * mount.clientHeight)));
    renderer.setPixelRatio(renderPixelRatio);
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.02;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.shadowMap.autoUpdate = false;
    mount.appendChild(renderer.domElement);
    renderer.domElement.tabIndex = 0;
    renderer.domElement.setAttribute("aria-label", "Penalty pitch. Left arrow selects YES, right arrow selects NO, Space kicks.");

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    composer.setPixelRatio(renderPixelRatio);
    const ao = new GTAOPass(scene,camera,mount.clientWidth,mount.clientHeight);
    const aoRender = ao.render.bind(ao);
    ao.render = (...args: Parameters<typeof ao.render>) => withOpaqueOccluders(scene,()=>aoRender(...args));
    ao.updateGtaoMaterial({radius:.42,samples:8,thickness:.45,distanceFallOff:1});
    ao.updatePdMaterial({samples:8,rings:2,radius:3});ao.blendIntensity=.3;
    const sizeAo=ao.setSize.bind(ao);ao.setSize=(w,h)=>sizeAo(Math.max(1,Math.floor(w/2)),Math.max(1,Math.floor(h/2)));
    composer.addPass(ao);
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(mount.clientWidth, mount.clientHeight), 0.14, 0.18, 1.65));
    const fxaa=new ShaderPass(FXAAShader);fxaa.uniforms.resolution.value.set(1/(mount.clientWidth*renderPixelRatio),1/(mount.clientHeight*renderPixelRatio));composer.addPass(fxaa);
    composer.addPass(new OutputPass());

    scene.add(new THREE.HemisphereLight(0xb1d6ca, 0x263328, 0.85));
    const moon = new THREE.DirectionalLight(0xf0f5df, 2.6);
    moon.position.set(-8, 14, 8);
    moon.target.position.set(0,0,-9);scene.add(moon.target);
    moon.castShadow=true;moon.shadow.mapSize.set(2048,2048);moon.shadow.camera.left=-22;moon.shadow.camera.right=22;moon.shadow.camera.top=24;moon.shadow.camera.bottom=-24;moon.shadow.camera.far=65;moon.shadow.normalBias=.035;moon.shadow.bias=-.00015;
    scene.add(moon);
    const cyan = new THREE.SpotLight(0x8ef5e3, 75, 38, 0.42, 0.6, 1.2);
    cyan.position.set(-8, 10, 5);
    cyan.target.position.set(-2.2, 1.3, -9);
    const magenta = new THREE.SpotLight(0xe89a42, 72, 38, 0.42, 0.6, 1.2);
    magenta.position.set(8, 10, 5);
    magenta.target.position.set(2.2, 1.3, -9);
    scene.add(cyan, cyan.target, magenta, magenta.target);

    const fieldMap = pitchTexture(renderer);
    const turf = new THREE.MeshStandardMaterial({map:fieldMap,color:0xb2cf9c,roughness:.92,metalness:0,vertexColors:true,normalScale:new THREE.Vector2(.65,.65)});
    const turfGeometry = new THREE.PlaneGeometry(24,44,24,88);
    const turfColors=[];
    for(let i=0;i<turfGeometry.attributes.position.count;i++) {
      const y=turfGeometry.attributes.position.getY(i);
      const stripe = Math.floor((y+22)/2.75)%2 ? .84 : 1;
      turfColors.push(stripe,stripe,stripe);
    }
    turfGeometry.setAttribute("color",new THREE.Float32BufferAttribute(turfColors,3));
    turfGeometry.setAttribute("uv1",turfGeometry.attributes.uv.clone());
    loadMap("/textures/grass_ground-2k/diffuse.jpg",12,22,true,map=>{turf.map=map;turf.needsUpdate=true;});
    loadMap("/textures/grass_ground-2k/normal-gl.jpg",12,22,false,map=>{turf.normalMap=map;turf.needsUpdate=true;});
    loadMap("/textures/grass_ground-2k/roughness.jpg",12,22,false,map=>{turf.roughnessMap=map;turf.needsUpdate=true;});
    loadMap("/textures/grass_ground-2k/ao.jpg",12,22,false,map=>{turf.aoMap=map;turf.aoMapIntensity=.45;turf.needsUpdate=true;});
    const field = new THREE.Mesh(
      turfGeometry,
      turf,
    );
    field.rotation.x = -Math.PI / 2;
    field.position.z = -6;
    field.receiveShadow = true;
    scene.add(field);
    const lineMaterial = new THREE.MeshStandardMaterial({ color: 0xd9e0c9, roughness:.98, metalness:0 });
    const addPitchLine = (x: number, z: number, width: number, depth: number) => {
      const line = new THREE.Mesh(new THREE.BoxGeometry(width, 0.012, depth), lineMaterial);
      line.position.set(x, 0.022, z);
      scene.add(line);
    };
    for (const x of [-8.5, 8.5]) {
      addPitchLine(x, -6, 0.055, 38);
    }
    addPitchLine(0, -9, 17, 0.055);
    addPitchLine(0, 3.2, 14.5, 0.075);
    addPitchLine(-7.25, -2.9, 0.075, 12.2);
    addPitchLine(7.25, -2.9, 0.075, 12.2);
    addPitchLine(0, -5.8, 11, 0.075);
    addPitchLine(-5.5, -7.4, 0.075, 3.2);
    addPitchLine(5.5, -7.4, 0.075, 3.2);
    const penaltySpot = new THREE.Mesh(new THREE.CircleGeometry(0.09, 20), lineMaterial);
    penaltySpot.rotation.x = -Math.PI / 2;
    penaltySpot.position.set(0, 0.024, 1.65);
    scene.add(penaltySpot);
    const arcCut = Math.asin((3.2 - 1.65) / 2.7);
    const penaltyArc = new THREE.Mesh(new THREE.RingGeometry(2.65, 2.7, 64, 1, Math.PI + arcCut, Math.PI - 2 * arcCut), lineMaterial);
    penaltyArc.rotation.x = -Math.PI / 2;
    penaltyArc.position.set(0, 0.024, 1.65);
    scene.add(penaltyArc);

    const standMaterial = new THREE.MeshStandardMaterial({ color: 0x68776e, metalness: 0, roughness: .88 });
    loadMap("/textures/concrete_floor_worn_001-2k/diffuse.jpg",4,4,true,map=>{standMaterial.map=map;standMaterial.needsUpdate=true;});
    loadMap("/textures/concrete_floor_worn_001-2k/normal-gl.jpg",4,4,false,map=>{standMaterial.normalMap=map;standMaterial.normalScale.set(.35,.35);standMaterial.needsUpdate=true;});
    for (const x of [-1, 1]) {
      for (let level = 0; level < 7; level += 1) {
        const height=(level+1)*.72;
        const stand = new THREE.Mesh(new THREE.BoxGeometry(.76, height, 38), standMaterial);
        stand.position.set(x * (9.55 + level * .75), height/2, -6);
        stand.receiveShadow=true;
        scene.add(stand);
      }
    }
    for (let level = 0; level < 8; level += 1) {
      const height=(level+1)*.68;
      const endStand = new THREE.Mesh(new THREE.BoxGeometry(22, height, .71), standMaterial);
      endStand.position.set(0, height/2, -18 - level * .7);
      endStand.receiveShadow=true;
      scene.add(endStand);
    }

    const seatedCrowd: number[] = [];
    for (const side of [-1, 1]) {
      for (let level = 0; level < 7; level += 1) {
        for (let lane = 0; lane < 1; lane += 1) {
          for (let seat = 0; seat < 75; seat += 1) {
            if (seat % 18 < 2) continue;
            seatedCrowd.push(side * (9.55 + level * .75), 1.57 + level * .72, 10.5 - seat * 0.5);
          }
        }
      }
    }
    for (let level = 0; level < 8; level += 1) {
      for (let lane = 0; lane < 1; lane += 1) {
        for (let seat = 0; seat < 44; seat += 1) {
          if (seat % 15 < 2) continue;
          seatedCrowd.push(-10.25 + seat * 0.48, 1.53 + level * .68, -18 - level * .7);
        }
      }
    }
    const crowdCount = seatedCrowd.length / 3;
    const stadiumDetail=addStadiumDetail(scene,seatedCrowd,standMaterial);
    const crowdPositions = Float32Array.from(seatedCrowd);
    const crowdBaseY = new Float32Array(crowdCount);
    const crowdPhase = new Float32Array(crowdCount);
    const crowdColors = new Float32Array(crowdCount * 3);
    for (let index = 0; index < crowdCount; index += 1) {
      crowdBaseY[index] = crowdPositions[index * 3 + 1];
      crowdPhase[index] = crowdPositions[index * 3 + 2] * 0.12 + crowdPositions[index * 3] * 0.08;
      const color = new THREE.Color(index % 11 === 0 ? 0xf06d63 : index % 7 === 0 ? 0xe89a42 : index % 3 === 0 ? 0x8ef5e3 : 0xeff3ee);
      crowdColors.set([color.r, color.g, color.b], index * 3);
    }
    const crowdGeometry = new THREE.BufferGeometry();
    crowdGeometry.setAttribute("position", new THREE.BufferAttribute(crowdPositions, 3));
    crowdGeometry.setAttribute("color", new THREE.BufferAttribute(crowdColors, 3));
    const crowdMaterial = new THREE.PointsMaterial({ size: 0.098, vertexColors: true, transparent: true, opacity: 0.94, depthWrite: false, blending: THREE.AdditiveBlending });
    scene.add(new THREE.Points(crowdGeometry, crowdMaterial));

    const neonMaterial = (color: number) => new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(2), toneMapped: false });
    for (const x of [-8.2, 8.2]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 39), neonMaterial(x < 0 ? 0x8ef5e3 : 0xe89a42));
      rail.position.set(x, 0.11, -6);
      scene.add(rail);
    }
    const orangeAccent = neonMaterial(0xff852e);
    for (const z of [6.5, 0.5, -5.5, -11.5, -17.5]) {
      const dash = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.025, 0.08), orangeAccent);
      dash.position.set(z % 2 === 0 ? -5.8 : 5.8, 0.055, z);
      scene.add(dash);
    }
    const warmReflection = new THREE.PointLight(0xff6b21, 14, 12, 2);
    warmReflection.position.set(0, 0.6, -7.5);
    scene.add(warmReflection);
    const wavingFlags: Array<{ mesh: THREE.Mesh; base: Float32Array; phase: number }> = [];
    const flagPlacements = [
      [-8.7, 4.2, 3.5], [8.7, 4.5, -1.5], [-9.1, 3.75, -8.5], [9.1, 4.05, -13.5],
      [-5.8, 5.15, -18.1], [0, 5.45, -18.3], [5.8, 5.1, -18.1],
    ] as Array<[number, number, number]>;
    flagPlacements.forEach((position, index) => {
      const geometry = new THREE.PlaneGeometry(2.05, 1.25, 14, 7);
      const base = Float32Array.from((geometry.attributes.position as THREE.BufferAttribute).array as ArrayLike<number>);
      const flag = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ map: supporterFlagTexture(index), side: THREE.DoubleSide, roughness:.95, metalness:0 }));
      flag.position.set(...position);
      flag.rotation.y = position[0] < -7 ? Math.PI * 0.2 : position[0] > 7 ? -Math.PI * 0.2 : 0;
      scene.add(flag);
      wavingFlags.push({ mesh: flag, base, phase: index * 0.83 });
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.028, 2.35, 6), new THREE.MeshStandardMaterial({ color: 0x8aa5b3, metalness: 0.8, roughness: 0.25 }));
      pole.position.set(position[0] - 1.03, position[1] - 0.52, position[2]);
      scene.add(pole);
    });

    const smokeMap = smokeTexture();
    const flareSprites: Array<{ sprite: THREE.Sprite; origin: THREE.Vector3; phase: number; speed: number }> = [];
    const flareLights: THREE.PointLight[] = [];
    const flareOrigins = [new THREE.Vector3(-8.2, 4.45, -5), new THREE.Vector3(8.2, 4.65, -11), new THREE.Vector3(-5.2, 5.8, -17.8), new THREE.Vector3(5.1, 6, -17.8)];
    flareOrigins.forEach((origin, flareIndex) => {
      const light = new THREE.PointLight(0xff123f, 22, 9, 2);
      light.position.copy(origin);
      scene.add(light);
      flareLights.push(light);
      for (let particle = 0; particle < 20; particle += 1) {
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: smokeMap, color: particle % 4 === 0 ? 0xff7357 : 0xf00b43, transparent: true, opacity: 0.3, depthWrite: false, blending: THREE.NormalBlending, toneMapped: false }));
        sprite.position.copy(origin);
        scene.add(sprite);
        flareSprites.push({ sprite, origin, phase: particle / 20 + flareIndex * 0.17, speed: 0.55 + Math.random() * 0.4 });
      }
    });

    const floodlightMaterials = [0xd5fff0, 0xffe7c7].map((color) => new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(2.8), toneMapped: false }));
    for (const x of [-10.4, 10.4]) {
      for (const z of [7, -5, -17]) {
        const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.1, 9, 8), standMaterial);
        mast.position.set(x, 4.5, z);
        scene.add(mast);
        const bankColorIndex = (x < 0 ? 0 : 1) as 0 | 1;
        const bank = new THREE.Group();
        bank.add(new THREE.Mesh(new THREE.BoxGeometry(2.5,.78,.16),new THREE.MeshStandardMaterial({color:0x2c3d38,metalness:.75,roughness:.4})));
        for(let column=0;column<5;column++)for(let row=0;row<2;row++) {
          const cell=new THREE.Mesh(new THREE.BoxGeometry(.36,.24,.04),floodlightMaterials[bankColorIndex]);
          cell.position.set((column-2)*.46,(row-.5)*.34,.11);bank.add(cell);
        }
        bank.position.set(x, 8.9, z);
        bank.lookAt(0, 1.2, z - 8);
        scene.add(bank);
        if(z !== -5) continue; // Two broad practical fills, not six overlapping per-pixel lights.
        const flood = new THREE.SpotLight(bankColorIndex === 0 ? 0xdbffed : 0xffd9ab, 100, 40, 0.7, 0.78, 1.3);
        flood.position.set(x, 8.7, z);
        flood.target.position.set(Math.sign(x) * 2.2, 0, z - 7);
        scene.add(flood, flood.target);
      }
    }

    const ribbonColors = [0x8ef5e3, 0xe89a42, 0xf06d63];
    for (let z = 9; z > -27; z -= 4.5) {
      const color = ribbonColors[Math.abs(Math.round(z * 2)) % ribbonColors.length];
      for (const x of [-9.25, 9.25]) {
        const ribbon = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.42, 3.7), neonMaterial(color));
        ribbon.position.set(x, 2.35 + ((z + 27) % 2) * 0.15, z);
        scene.add(ribbon);
      }
    }

    const goal = new THREE.Group();
    goal.position.z = -9;
    const postMaterial = new THREE.MeshStandardMaterial({ color: 0xe8f0df, emissive: 0x8ef5e3, emissiveIntensity: .12, metalness: 0.25, roughness: 0.36 });
    const post = (height: number, rotationZ = 0) => {
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, height, 12), postMaterial);
      mesh.rotation.z = rotationZ;
      mesh.castShadow = true;
      return mesh;
    };
    const leftPost = post(3.3); leftPost.position.set(-4.15, 1.65, 0);
    const rightPost = post(3.3); rightPost.position.set(4.15, 1.65, 0);
    const crossbar = post(8.3, Math.PI / 2); crossbar.position.set(0, 3.3, 0);
    goal.add(leftPost, rightPost, crossbar);
    const netPoints: number[] = [];
    // Back, roof and side netting: a goal has depth, not a grid across its mouth.
    for (let x=-4.1;x<=4.11;x+=.205) {
      netPoints.push(x,0,-2,x,3.28,-1.3,x,3.28,-1.3,x,3.28,0);
    }
    for(let y=0;y<=3.3;y+=.205) {
      const z=-2+y/3.28*.7;netPoints.push(-4.1,y,z,4.1,y,z);
      for(const x of [-4.1,4.1]) netPoints.push(x,y,0,x,y,z);
    }
    for(let z=-1.3;z<=0;z+=.2) netPoints.push(-4.1,3.28,z,4.1,3.28,z);
    for(const x of [-4.1,4.1]) for(let z=-1.2;z<0;z+=.2) netPoints.push(x,0,z,x,3.28,z);
    const netGeometry = new THREE.BufferGeometry();
    netGeometry.setAttribute("position", new THREE.Float32BufferAttribute(netPoints, 3));
    const netRest=Float32Array.from(netPoints);
    goal.add(new THREE.LineSegments(netGeometry, new THREE.LineBasicMaterial({ color: 0xc1cbbb, transparent: true, opacity: 0.62 })));
    for(const x of [-4.15,4.15]) {
      const foot=new THREE.Mesh(new THREE.BoxGeometry(.09,.09,2.1),postMaterial);foot.position.set(x,.045,-1);goal.add(foot);
    }
    scene.add(goal);

    const targetCanvases = [document.createElement("canvas"), document.createElement("canvas")];
    targetCanvases.forEach((canvas) => { canvas.width = 512; canvas.height = 196; });
    const targetTextures = targetCanvases.map((canvas) => new THREE.CanvasTexture(canvas));
    targetTextures.forEach((texture) => { texture.colorSpace = THREE.SRGBColorSpace; });
    const targetMeshes = targetTextures.map((texture, index) => {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(3.25, 1.25), new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }));
      mesh.position.set(index === 0 ? -2.05 : 2.05, 1.75, -8.88);
      scene.add(mesh);
      return mesh;
    });

    const scoreboardCanvas = document.createElement("canvas");
    scoreboardCanvas.width = 1024; scoreboardCanvas.height = 180;
    const scoreboardTexture = new THREE.CanvasTexture(scoreboardCanvas);
    scoreboardTexture.colorSpace = THREE.SRGBColorSpace;
    const scoreboard = new THREE.Mesh(new THREE.PlaneGeometry(10.2, 1.8), new THREE.MeshBasicMaterial({ map: scoreboardTexture, toneMapped: false }));
    scoreboard.position.set(0, 5.35, -10.8);
    scene.add(scoreboard);

    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 40, 24),
      new THREE.MeshStandardMaterial({ map: footballTexture(), color: 0xf1f5f2, roughness: 0.66, metalness: 0 }),
    );
    const ballStart = new THREE.Vector3(0, 0.24, 1.65);
    ball.position.copy(ballStart);
    ball.visible = false;
    scene.add(ball);
    const flameMap = fireTexture();
    const flameTrail = Array.from({ length: 32 }, (_, index) => {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: flameMap,
        color: index % 3 === 0 ? 0xffe564 : index % 2 === 0 ? 0xff6a12 : 0xff1c55,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }));
      sprite.visible = false;
      scene.add(sprite);
      return sprite;
    });
    const ballFireLight = new THREE.PointLight(0xff6a12, 0, 8, 2);
    scene.add(ballFireLight);
    const impactSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: flameMap, color: 0xff8a2e, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    impactSprite.visible = false;
    scene.add(impactSprite);
    const impactRing = new THREE.Mesh(
      new THREE.RingGeometry(0.42, 0.52, 48),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0xe89a42).multiplyScalar(3.2), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
    );
    impactRing.visible = false;
    scene.add(impactRing);
    const impactLight = new THREE.PointLight(0xff7b27, 0, 15, 2);
    scene.add(impactLight);

    const rainCount = 360;
    const rainPositions = new Float32Array(rainCount * 3);
    for (let index = 0; index < rainCount; index += 1) {
      rainPositions[index * 3] = (Math.random() - 0.5) * 28;
      rainPositions[index * 3 + 1] = Math.random() * 12;
      rainPositions[index * 3 + 2] = 12 - Math.random() * 43;
    }
    const rainGeometry = new THREE.BufferGeometry();
    rainGeometry.setAttribute("position", new THREE.BufferAttribute(rainPositions, 3));
    const rain = new THREE.Points(rainGeometry, new THREE.PointsMaterial({ color: 0x8ef5e3, size: 0.025, transparent: true, opacity: 0.38, depthWrite: false }));
    scene.add(rain);

    let aimedSide: VoteSide = "YES";
    let kickStarted = 0;
    let kicking = false;
    let kickSide: VoteSide = "YES";
    let kickOutcome = 0;
    let registered = false;
    let lastUiKey = "";
    let gaugePower = 1;
    let capturedMultiplier = 1;
    let lastGaugeValue = -1;
    let kickCutinIndex = 0;
    const chooseSide = (side: VoteSide) => { if (!kicking) aimedSide = side; };
    const startKick = () => {
      if (kicking || !marketRef.current || pausedRef.current) return;
      kicking = true;
      registered = false;
      kickSide = aimedSide;
      kickOutcome = marketRef.current.outcome;
      capturedMultiplier = Math.round(gaugePower);
      kickStarted = performance.now();
      ball.visible = true;
      ball.position.copy(ballStart);
      impactSprite.visible = false;
      impactRing.visible = false;
      impactLight.intensity = 0;
      if (kickImageRef.current) {
        kickImageRef.current.src = KICK_CUTINS[kickCutinIndex % KICK_CUTINS.length];
        kickImageRef.current.dataset.variant = String(kickCutinIndex + 1);
      }
      kickCutinIndex = (kickCutinIndex + 1) % KICK_CUTINS.length;
      focusCutinRef.current?.classList.remove("active");
      kickCutinRef.current?.classList.add("active");
      if (kickMultiplierRef.current) kickMultiplierRef.current.textContent = `×${capturedMultiplier}`;
    };
    const onPointerMove = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      chooseSide(event.clientX - rect.left < rect.width / 2 ? "YES" : "NO");
    };
    const onClick = () => { renderer.domElement.focus({ preventScroll: true }); startKick(); };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || document.activeElement !== renderer.domElement || pausedRef.current) return;
      if (["ArrowLeft", "ArrowRight"].includes(event.code)) event.preventDefault();
      if (event.code === "KeyA" || event.code === "ArrowLeft") chooseSide("YES");
      if (event.code === "KeyD" || event.code === "ArrowRight") chooseSide("NO");
      if (event.code === "Space") { event.preventDefault(); startKick(); }
    };
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("click", onClick);
    document.addEventListener("keydown", onKeyDown);

    let frame = 0;
    let previous = performance.now();
    let fpsSince=previous, fpsFrames=0;
    focusCutinRef.current?.classList.add("active");
    const animate = (now: number) => {
      frame = requestAnimationFrame(animate);
      const dt = Math.min((now - previous) / 1000, 0.04);
      previous = now;
      stadiumDetail.update(now);
      fpsFrames++;
      if(now-fpsSince>=1000) { mount.dataset.fps=String(Math.round(fpsFrames*1000/(now-fpsSince)));fpsSince=now;fpsFrames=0; }
      const currentMarket = marketRef.current;
      const currentPrices = pricesRef.current;
      const currentKicks = kicksRef.current;
      if (!kicking && !pausedRef.current) {
        const phase = (now * 0.00078) % 2;
        gaugePower = 1 + (phase <= 1 ? phase : 2 - phase) * 99;
      }
      const gaugeValue = Math.round(gaugePower);
      if (gaugeValue !== lastGaugeValue) {
        lastGaugeValue = gaugeValue;
        if (gaugeNumberRef.current) gaugeNumberRef.current.textContent = String(gaugeValue);
        if (gaugeFillRef.current) gaugeFillRef.current.style.width = `${gaugeValue}%`;
      }
      const uiKey = `${currentMarket?.outcome}-${currentPrices.YES}-${currentPrices.NO}-${currentKicks.YES}-${currentKicks.NO}-${aimedSide}`;
      if (uiKey !== lastUiKey) {
        lastUiKey = uiKey;
        const country = currentMarket?.name ?? "NO MARKET";
        drawTarget(targetCanvases[0], "YES", country, currentPrices.YES, aimedSide === "YES");
        drawTarget(targetCanvases[1], "NO", country, currentPrices.NO, aimedSide === "NO");
        targetTextures.forEach((texture) => { texture.needsUpdate = true; });
        drawScoreboard(scoreboardCanvas, currentMarket, currentPrices, currentKicks);
        scoreboardTexture.needsUpdate = true;
      }
      targetMeshes.forEach((mesh, index) => {
        const active = (index === 0 ? "YES" : "NO") === aimedSide;
        mesh.scale.setScalar(THREE.MathUtils.lerp(mesh.scale.x, active ? 1.045 : 1, 0.14));
      });

      let impactShake = 0;
      const netAttribute=netGeometry.attributes.position as THREE.BufferAttribute;
      const netTime=kicking?(now-kickStarted)/1000-.8:0;
      for(let i=0;i<netAttribute.count;i++) {
        const x=netRest[i*3],y=netRest[i*3+1],z=netRest[i*3+2];
        const falloff=Math.exp(-((x-(kickSide==="YES"?-2.05:2.05))**2+(y-1.75)**2)*.7);
        const stretch=netTime>0?Math.sin(netTime*18)*Math.exp(-netTime*5)*.32*falloff:0;
        netAttribute.setZ(i,z-stretch);
      }
      netAttribute.needsUpdate=true;
      if (kicking) {
        const progress = Math.min(1, (now - kickStarted) / 1500);
        if (progress >= 0.48) kickCutinRef.current?.classList.remove("active");
        if (progress > 0.16) {
          const flight = Math.min(1, (progress - 0.16) / 0.4);
          const flightEased = 1 - Math.pow(1 - flight, 2.15);
          const target = new THREE.Vector3(kickSide === "YES" ? -2.05 : 2.05, 1.75, -8.72);
          ball.position.lerpVectors(ballStart, target, flightEased);
          ball.position.y += Math.sin(flightEased * Math.PI) * 2.15;
          ball.scale.setScalar(1 + capturedMultiplier * 0.0025);
          ball.rotation.x -= dt * 18;
          ball.rotation.z += (kickSide === "YES" ? -1 : 1) * dt * 10;
          const powerScale = 0.4 + capturedMultiplier / 62;
          const trailFade = progress > 0.56 ? THREE.MathUtils.clamp(1 - (progress - 0.56) / 0.26, 0, 1) : 1;
          flameTrail.forEach((flame, index) => {
            const trailFlight = flightEased - index * 0.019;
            flame.visible = trailFlight > 0.01 && trailFade > 0.01;
            if (!flame.visible) return;
            flame.position.lerpVectors(ballStart, target, trailFlight);
            flame.position.y += Math.sin(trailFlight * Math.PI) * 2.15;
            flame.position.x += Math.sin(index * 2.13) * 0.05 * powerScale;
            flame.position.y += Math.cos(index * 1.71) * 0.04 * powerScale;
            const taper = 1 - index / flameTrail.length;
            flame.scale.setScalar(powerScale * (0.32 + taper * 0.58));
            (flame.material as THREE.SpriteMaterial).opacity = Math.min(0.96, taper * 0.9 + capturedMultiplier / 650) * trailFade;
          });
          ballFireLight.position.copy(ball.position);
          ballFireLight.intensity = (12 + capturedMultiplier * 0.72) * trailFade;
          if (progress >= 0.5 && progress < 0.86) {
            const impact = THREE.MathUtils.clamp((progress - 0.5) / 0.36, 0, 1);
            ball.visible = impact < 0.08;
            impactSprite.visible = true;
            impactSprite.position.copy(target).add(new THREE.Vector3(0, 0, 0.08));
            impactSprite.scale.setScalar((1.45 + capturedMultiplier * 0.012) * (1 + impact * 2.8));
            (impactSprite.material as THREE.SpriteMaterial).opacity = Math.pow(1 - impact, 0.65);
            impactRing.visible = true;
            impactRing.position.copy(target).add(new THREE.Vector3(0, 0, 0.11));
            impactRing.scale.setScalar(1 + impact * (4.2 + capturedMultiplier * 0.018));
            (impactRing.material as THREE.MeshBasicMaterial).opacity = (1 - impact) * 0.95;
            impactLight.position.copy(target).add(new THREE.Vector3(0, 0.6, 0.6));
            impactLight.intensity = (1 - impact) * (48 + capturedMultiplier * 0.9);
            impactShake = Math.sin(impact * Math.PI * 12) * (1 - impact) * (0.035 + capturedMultiplier * 0.00065);
          } else if (progress >= 0.86) {
            impactSprite.visible = false;
            impactRing.visible = false;
            impactLight.intensity = 0;
          }
          if (progress >= 0.54 && !registered) {
            registered = true;
            kickRef.current(kickSide, capturedMultiplier, kickOutcome);
          }
        }
        if (progress >= 1) {
          kicking = false;
          ball.position.copy(ballStart);
          ball.scale.setScalar(1);
          ball.visible = false;
          ballFireLight.intensity = 0;
          impactLight.intensity = 0;
          impactSprite.visible = false;
          impactRing.visible = false;
          flameTrail.forEach((flame) => { flame.visible = false; });
          kickCutinRef.current?.classList.remove("active");
          focusCutinRef.current?.classList.add("active");
        }
      }

      const positions = rainGeometry.attributes.position as THREE.BufferAttribute;
      for (let index = 0; index < rainCount; index += 1) {
        let y = positions.getY(index) - dt * 5.8;
        if (y < 0) y = 10 + Math.random() * 3;
        positions.setY(index, y);
      }
      positions.needsUpdate = true;

      const crowdPositionAttribute = crowdGeometry.attributes.position as THREE.BufferAttribute;
      for (let index = 0; index < crowdCount; index += 1) {
        const x = crowdPositionAttribute.getX(index);
        const z = crowdPositionAttribute.getZ(index);
        const wave = Math.sin(now * 0.0062 + crowdPhase[index] + x * 0.16 + z * 0.08);
        crowdPositionAttribute.setY(index, crowdBaseY[index] + Math.max(0, wave) * 0.085);
      }
      crowdPositionAttribute.needsUpdate = true;
      crowdMaterial.opacity = 0.88 + Math.sin(now * 0.0021) * 0.08;
      crowdMaterial.size = 0.094 + Math.sin(now * 0.0034) * 0.012;

      wavingFlags.forEach(({ mesh, base, phase }) => {
        const attribute = mesh.geometry.attributes.position as THREE.BufferAttribute;
        for (let vertex = 0; vertex < attribute.count; vertex += 1) {
          const baseIndex = vertex * 3;
          const x = base[baseIndex];
          const y = base[baseIndex + 1];
          attribute.setXYZ(vertex, x, y + Math.sin(now * 0.0045 + phase + x * 2.5) * 0.035, base[baseIndex + 2] + Math.sin(now * 0.0052 + phase + x * 3.1 + y) * (0.08 + (x + 1.05) * 0.075));
        }
        attribute.needsUpdate = true;
      });

      flareSprites.forEach(({ sprite, origin, phase, speed }, index) => {
        const life = (now * 0.00016 * speed + phase) % 1;
        const drift = origin.x < 0 ? 1 : -1;
        sprite.position.set(
          origin.x + drift * life * 2.25 + Math.sin(life * 7.2 + index) * (0.18 + life * 0.5),
          origin.y + life * 1.55 + Math.sin(life * 3.4 + index) * 0.18,
          origin.z - life * 0.72 + Math.cos(life * 5.4 + index * 0.7) * (0.1 + life * 0.3),
        );
        sprite.scale.setScalar(0.58 + life * 2.15);
        (sprite.material as THREE.SpriteMaterial).opacity = Math.sin(life * Math.PI) * 0.28;
      });
      flareLights.forEach((light, index) => {
        light.intensity = 18 + Math.sin(now * 0.012 + index * 1.7) * 7;
      });

      camera.position.x = Math.sin(now * 0.00018) * 0.12 + impactShake;
      camera.lookAt(0, 1.34, -6.7);
      cyan.intensity = 38 + Math.sin(now * 0.002) * 7;
      magenta.intensity = 40 + Math.cos(now * 0.0017) * 7;
      composer.render(dt);
    };
    // Reveal one fully textured frame; no delayed "low detail → high detail" swap.
    manager.onLoad=()=>{
      if(disposed)return;
      renderer.shadowMap.needsUpdate=true;
      frame=requestAnimationFrame(animate);
      readyRef.current();
    };
    manager.itemEnd("stadium-bootstrap");

    const onResize = () => {
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
      composer.setSize(mount.clientWidth, mount.clientHeight);
      fxaa.uniforms.resolution.value.set(1/(mount.clientWidth*renderPixelRatio),1/(mount.clientHeight*renderPixelRatio));
    };
    window.addEventListener("resize", onResize);
    return () => {
      disposed=true;manager.onLoad=()=>{};
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKeyDown);
      disposeScene(scene);
      skyTexture.dispose();
      fieldMap.dispose();
      surfaceTextures.forEach(texture=>texture.dispose());
      composer.passes.forEach(pass => pass.dispose());
      composer.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
    };
  }, []);

  return (
    <div className="world-canvas soccer-world" ref={mountRef} aria-label="HyperStrike World Cup demo penalty stadium">
      <div className="power-gauge" aria-label="Penalty power multiplier">
        <span>CONTRACT MULTIPLIER</span><b ref={gaugeNumberRef}>1</b><em>×</em>
        <div><i ref={gaugeFillRef} /></div>
        <small>A / ← YES · D / → NO · CLICK / SPACE TO LOCK POWER</small>
      </div>
      <div className="anime-cutin anime-cutin--focus" ref={focusCutinRef} aria-hidden="true">
        <img src="/event/mbappe-commander-focus.webp" alt="" />
        <div><span>COMMANDER MODE</span><strong>LOCK THE MULTIPLIER.</strong></div>
      </div>
      <div className="anime-cutin anime-cutin--kick" ref={kickCutinRef} aria-hidden="true">
        <img ref={kickImageRef} src={KICK_CUTINS[0]} data-variant="1" alt="" />
        <b ref={kickMultiplierRef}>×1</b>
      </div>
    </div>
  );
}
