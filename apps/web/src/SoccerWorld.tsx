import { useEffect, useRef } from "react";
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
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
  onKick: (side: VoteSide, multiplier: number) => void;
  onReady: () => void;
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
    gradient.addColorStop(0, stripe % 2 ? "#06172b" : "#08223a");
    gradient.addColorStop(0.5, stripe % 2 ? "#071d34" : "#0a2943");
    gradient.addColorStop(1, stripe % 2 ? "#051426" : "#071f35");
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
      if ("map" in material && material.map instanceof THREE.Texture) material.map.dispose();
      material.dispose();
    });
  });
}

export function SoccerWorld({ market, prices, kicks, onKick, onReady }: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const marketRef = useRef(market);
  const pricesRef = useRef(prices);
  const kicksRef = useRef(kicks);
  const kickRef = useRef(onKick);
  const readyRef = useRef(onReady);
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
    KICK_CUTINS.forEach((source) => {
      const image = new Image();
      image.decoding = "async";
      image.src = source;
    });
    const scene = new THREE.Scene();
    const skyTexture = stadiumSkyTexture();
    scene.background = skyTexture;
    scene.fog = new THREE.FogExp2(0x02040e, 0.013);
    const camera = new THREE.PerspectiveCamera(56, mount.clientWidth / mount.clientHeight, 0.08, 100);
    camera.position.set(0, 2.85, 10.6);
    camera.lookAt(0, 1.35, -6.7);

    const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
    const renderPixelRatio = Math.min(devicePixelRatio, 1.5);
    renderer.setPixelRatio(renderPixelRatio);
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.74;
    renderer.shadowMap.enabled = false;
    mount.appendChild(renderer.domElement);

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    composer.setPixelRatio(renderPixelRatio);
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(mount.clientWidth, mount.clientHeight), 0.26, 0.2, 0.9));
    composer.addPass(new OutputPass());

    scene.add(new THREE.HemisphereLight(0x527b77, 0x010506, 0.28));
    const moon = new THREE.DirectionalLight(0x8ef5e3, 0.82);
    moon.position.set(-8, 14, 8);
    scene.add(moon);
    const cyan = new THREE.SpotLight(0x8ef5e3, 75, 38, 0.42, 0.6, 1.2);
    cyan.position.set(-8, 10, 5);
    cyan.target.position.set(-2.2, 1.3, -9);
    const magenta = new THREE.SpotLight(0xe89a42, 72, 38, 0.42, 0.6, 1.2);
    magenta.position.set(8, 10, 5);
    magenta.target.position.set(2.2, 1.3, -9);
    scene.add(cyan, cyan.target, magenta, magenta.target);

    const fieldMap = pitchTexture(renderer);
    const field = new THREE.Mesh(
      new THREE.PlaneGeometry(24, 44, 1, 1),
      new THREE.MeshPhysicalMaterial({ map: fieldMap, color: 0xffffff, roughness: 0.34, metalness: 0.22, clearcoat: 0.88, clearcoatRoughness: 0.12 }),
    );
    field.rotation.x = -Math.PI / 2;
    field.position.z = -6;
    field.receiveShadow = true;
    scene.add(field);
    const lineMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xeff3ee).multiplyScalar(1.4), transparent: true, opacity: 0.82, toneMapped: false });
    const addPitchLine = (x: number, z: number, width: number, depth: number) => {
      const line = new THREE.Mesh(new THREE.BoxGeometry(width, 0.012, depth), lineMaterial);
      line.position.set(x, 0.022, z);
      scene.add(line);
    };
    for (const x of [-8.5, 8.5]) {
      addPitchLine(x, -6, 0.055, 38);
    }
    addPitchLine(0, -9, 17, 0.055);
    addPitchLine(0, -3.35, 12, 0.055);
    addPitchLine(-6, -6.175, 0.055, 5.65);
    addPitchLine(6, -6.175, 0.055, 5.65);
    addPitchLine(0, -6.9, 7, 0.055);
    addPitchLine(-3.5, -7.95, 0.055, 2.1);
    addPitchLine(3.5, -7.95, 0.055, 2.1);
    const penaltySpot = new THREE.Mesh(new THREE.CircleGeometry(0.09, 20), lineMaterial);
    penaltySpot.rotation.x = -Math.PI / 2;
    penaltySpot.position.set(0, 0.024, 1.65);
    scene.add(penaltySpot);
    const penaltyArc = new THREE.Mesh(new THREE.RingGeometry(2.65, 2.7, 64, 1, Math.PI, Math.PI), lineMaterial);
    penaltyArc.rotation.x = -Math.PI / 2;
    penaltyArc.position.set(0, 0.024, 1.65);
    scene.add(penaltyArc);

    const standMaterial = new THREE.MeshStandardMaterial({ color: 0x03091b, metalness: 0.78, roughness: 0.34 });
    for (const x of [-11.2, 11.2]) {
      for (let level = 0; level < 7; level += 1) {
        const stand = new THREE.Mesh(new THREE.BoxGeometry(4.8, 0.7, 38), standMaterial);
        stand.position.set(x + Math.sign(x) * level * 0.65, 0.4 + level * 0.72, -6);
        scene.add(stand);
      }
    }
    for (let level = 0; level < 8; level += 1) {
      const endStand = new THREE.Mesh(new THREE.BoxGeometry(22, 0.62, 3.5), standMaterial);
      endStand.position.set(0, 0.42 + level * 0.68, -18.5 - level * 0.42);
      scene.add(endStand);
    }

    const seatedCrowd: number[] = [];
    for (const side of [-1, 1]) {
      for (let level = 0; level < 7; level += 1) {
        for (let lane = 0; lane < 3; lane += 1) {
          for (let seat = 0; seat < 75; seat += 1) {
            seatedCrowd.push(side * (9.05 + level * 0.64 + lane * 0.23), 0.81 + level * 0.72 + lane * 0.018, 10.5 - seat * 0.5);
          }
        }
      }
    }
    for (let level = 0; level < 8; level += 1) {
      for (let lane = 0; lane < 3; lane += 1) {
        for (let seat = 0; seat < 44; seat += 1) {
          seatedCrowd.push(-10.25 + seat * 0.48, 0.79 + level * 0.68 + lane * 0.018, -17.9 - level * 0.42 - lane * 0.34);
        }
      }
    }
    const crowdCount = seatedCrowd.length / 3;
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

    const neonMaterial = (color: number) => new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(3.2), toneMapped: false });
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
      const flag = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map: supporterFlagTexture(index), side: THREE.DoubleSide, transparent: true, opacity: 0.94, toneMapped: false }));
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
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: smokeMap, color: particle % 4 === 0 ? 0xff7357 : 0xf00b43, transparent: true, opacity: 0.72, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
        sprite.position.copy(origin);
        scene.add(sprite);
        flareSprites.push({ sprite, origin, phase: particle / 20 + flareIndex * 0.17, speed: 0.55 + Math.random() * 0.4 });
      }
    });

    const floodlightMaterials = [0x8ef5e3, 0xe89a42].map((color) => new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(3.9), toneMapped: false }));
    for (const x of [-10.4, 10.4]) {
      for (const z of [7, -5, -17]) {
        const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.1, 9, 8), standMaterial);
        mast.position.set(x, 4.5, z);
        scene.add(mast);
        const bankColorIndex = (x < 0 ? 0 : 1) as 0 | 1;
        const bank = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.72, 0.12), floodlightMaterials[bankColorIndex]);
        bank.position.set(x, 8.9, z);
        bank.lookAt(0, 1.2, z - 8);
        scene.add(bank);
        const flood = new THREE.SpotLight(bankColorIndex === 0 ? 0x8ef5e3 : 0xe89a42, 34, 32, 0.52, 0.78, 1.3);
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
    const postMaterial = new THREE.MeshStandardMaterial({ color: 0xcffff6, emissive: 0x8ef5e3, emissiveIntensity: 2.1, metalness: 0.52, roughness: 0.18 });
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
    for (let x = -4.1; x <= 4.11; x += 0.41) netPoints.push(x, 0, 0.05, x, 3.28, 0.05);
    for (let y = 0; y <= 3.3; y += 0.33) netPoints.push(-4.1, y, 0.05, 4.1, y, 0.05);
    const netGeometry = new THREE.BufferGeometry();
    netGeometry.setAttribute("position", new THREE.Float32BufferAttribute(netPoints, 3));
    goal.add(new THREE.LineSegments(netGeometry, new THREE.LineBasicMaterial({ color: 0xe89a42, transparent: true, opacity: 0.42 })));
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
      new THREE.SphereGeometry(0.22, 28, 18),
      new THREE.MeshStandardMaterial({ color: 0xf1f5f2, roughness: 0.48, metalness: 0.04, emissive: 0x164154, emissiveIntensity: 0.2 }),
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
    let registered = false;
    let lastUiKey = "";
    let gaugePower = 1;
    let capturedMultiplier = 1;
    let lastGaugeValue = -1;
    let kickCutinIndex = 0;
    const chooseSide = (side: VoteSide) => { if (!kicking) aimedSide = side; };
    const startKick = () => {
      if (kicking || !marketRef.current) return;
      kicking = true;
      registered = false;
      kickSide = aimedSide;
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
    const onClick = () => startKick();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === "KeyA" || event.code === "ArrowLeft") chooseSide("YES");
      if (event.code === "KeyD" || event.code === "ArrowRight") chooseSide("NO");
      if (event.code === "Space") { event.preventDefault(); startKick(); }
    };
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("click", onClick);
    document.addEventListener("keydown", onKeyDown);

    let frame = 0;
    let previous = performance.now();
    focusCutinRef.current?.classList.add("active");
    const animate = (now: number) => {
      frame = requestAnimationFrame(animate);
      const dt = Math.min((now - previous) / 1000, 0.04);
      previous = now;
      const currentMarket = marketRef.current;
      const currentPrices = pricesRef.current;
      const currentKicks = kicksRef.current;
      if (!kicking) {
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
            kickRef.current(kickSide, capturedMultiplier);
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
        (sprite.material as THREE.SpriteMaterial).opacity = Math.sin(life * Math.PI) * 0.72;
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
    frame = requestAnimationFrame(animate);
    readyRef.current();

    const onResize = () => {
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
      composer.setSize(mount.clientWidth, mount.clientHeight);
    };
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKeyDown);
      disposeScene(scene);
      skyTexture.dispose();
      fieldMap.dispose();
      composer.dispose();
      renderer.dispose();
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
