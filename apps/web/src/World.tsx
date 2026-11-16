import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { FXAAShader } from "three/addons/shaders/FXAAShader.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { createBallistics } from "./range/ballistics";
import { buildRange, displayMaterial, projectUv } from "./range/environment";
import { VolumetricPass } from "./range/volumetric";
import { createArsenal, type ReloadSound, type RigPose, type Timeline, type WeaponRig } from "./range/arsenal";
import { buildContact, type Contact } from "./range/collider";
import { createTrigger, nextMode, pressTrigger, releaseTrigger, resetTrigger, takeShot, type FireMode, type WeaponSpec } from "./range/arsenalSpec";
import { createArms, emptyPose } from "./range/hands";
import { RangeHud, type WeaponHud } from "./RangeHud";
import { createStrikeFx } from "./range/strikeFx";
import { createHorde, type HordeHud } from "./range/horde";
import { createSequenceDetector } from "./range/konami";
import { withOpaqueOccluders } from "./opaqueOcclusion";
import { drawHsxChart, subscribeHsxChart } from "./hsxChart";
import type { PortfolioDisplayEntry, IndexMarket, VoteCount, VoteSide } from "./types";

type Props = {
  quality?: "HIGH" | "PERFORMANCE";
  markets: IndexMarket[];
  onSelect: (market: IndexMarket) => void;
  onProximity: (market: IndexMarket | null) => void;
  entered: boolean;
  onEntered: () => void;
  onLockChange: (locked: boolean) => void;
  onAmmoChange: (magazine: number, reserve: number, reloading: boolean) => void;
  onVote: (market: IndexMarket, side: VoteSide) => void;
  votes: Record<string, VoteCount>;
  portfolio: PortfolioDisplayEntry[];
  onFurnace: () => void;
  onFurnaceProximity: (nearby: boolean) => void;
  onChart: () => void;
  onChartProximity: (nearby: boolean) => void;
  onReady: () => void;
};

const BRAND = 0x8ef5e3;
const STRIKE_ORANGE = 0xe89a42;
const YES_LIGHT = 0x6df3b6;
const NO_LIGHT = 0xf06d63;

function muzzleFireTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  ctx.translate(128, 128);
  const gradient = ctx.createRadialGradient(0, 0, 2, 0, 0, 118);
  gradient.addColorStop(0, "rgba(255,255,238,1)");
  gradient.addColorStop(0.12, "rgba(255,246,174,.98)");
  gradient.addColorStop(0.34, "rgba(255,152,34,.9)");
  gradient.addColorStop(0.68, "rgba(234,52,8,.45)");
  gradient.addColorStop(1, "rgba(80,4,0,0)");
  ctx.fillStyle = gradient;
  ctx.beginPath();
  for (let point = 0; point < 24; point += 1) {
    const angle = point / 24 * Math.PI * 2;
    const radius = point % 2 === 0 ? 112 : 36 + (point % 3) * 9;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    if (point === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function controlCenterTexture(entry: PortfolioDisplayEntry | null, index: number, total: number, committed: number) {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 576;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  gradient.addColorStop(0, "#071f24");
  gradient.addColorStop(1, "#02090b");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = index % 2 ? "#e89a42" : "#8ef5e3";
  ctx.lineWidth = 10;
  ctx.strokeRect(8, 8, canvas.width - 16, canvas.height - 16);
  ctx.fillStyle = "#668d8f";
  ctx.font = "800 25px monospace";
  ctx.fillText(`PORTFOLIO CONTROL / LCD ${String(index + 1).padStart(2, "0")}`, 46, 66);
  if (!entry) {
    ctx.fillStyle = "#8ef5e3";
    ctx.font = "italic 900 58px Arial";
    ctx.fillText(index === 0 ? `${total} REGISTERED CALLS` : "AWAITING POSITION", 46, 172);
    ctx.fillStyle = "#eff3ee";
    ctx.font = "900 94px monospace";
    ctx.fillText(index === 0 ? `$${committed.toFixed(2)}` : "—", 45, 300);
    ctx.fillStyle = "#55787a";
    ctx.font = "700 24px monospace";
    ctx.fillText(index === 0 ? "TOTAL PAPER EXPOSURE" : "FIRE A MARKET · ARM · SUBMIT", 48, 354);
  } else {
    const sideColor = entry.side === "YES" ? "#6df3b6" : "#f06d63";
    ctx.fillStyle = "#eff3ee";
    ctx.font = "italic 900 54px Arial";
    ctx.fillText(entry.marketName.toUpperCase(), 46, 160, 910);
    ctx.fillStyle = sideColor;
    ctx.font = "900 104px monospace";
    ctx.fillText(entry.side, 44, 292);
    ctx.fillStyle = "#9fb7b8";
    ctx.font = "800 27px monospace";
    ctx.fillText(`${entry.contracts} CONTRACTS · ${entry.entryPrice}¢ ENTRY`, 48, 356);
    ctx.fillStyle = "#e89a42";
    ctx.font = "900 42px monospace";
    ctx.fillText(`$${entry.amount.toFixed(2)} EXPOSURE`, 48, 424);
    ctx.fillStyle = "#55787a";
    ctx.font = "700 21px monospace";
    ctx.fillText(`RESOLVES ${entry.resolves}`, 48, 484);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

const BODYCAM_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    time: { value: 0 },
    distortion: { value: 0.018 },
    aberration: { value: 0.00012 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float time;
    uniform float distortion;
    uniform float aberration;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7)) + time * 0.017) * 43758.5453);
    }

    void main() {
      vec2 p = vUv * 2.0 - 1.0;
      float r2 = dot(p, p);
      // Normalised so the warped image always fills the frame (no dark border).
      vec2 uv = (p * (1.0 + distortion * r2) / (1.0 + distortion * 2.0)) * 0.5 + 0.5;
      vec2 split = normalize(p + vec2(0.0001)) * aberration * (0.3 + r2);
      float red = texture2D(tDiffuse, uv + split).r;
      float green = texture2D(tDiffuse, uv).g;
      float blue = texture2D(tDiffuse, uv - split).b;
      vec3 color = vec3(red, green, blue);
      float grain = hash(vUv * vec2(1919.0, 1079.0)) - 0.5;
      float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
      color = mix(vec3(luminance), color, 1.12);
      color = (color - 0.5) * 1.08 + 0.5;
      color += vec3(-0.012, 0.018, 0.022) * (1.0 - smoothstep(0.18, 0.72, luminance));
      color += vec3(0.024, 0.009, -0.012) * smoothstep(0.56, 1.0, luminance);
      color += grain * 0.012 * (1.0 - luminance * 0.6);
      color *= 1.0 - smoothstep(0.5, 1.7, r2) * 0.3;
      // The contrast curve pushes near-black below zero, which the tone mapper turns red.
      gl_FragColor = vec4(max(color, 0.0), 1.0);
    }
  `,
};

function marketLightColor(market: IndexMarket, count?: VoteCount) {
  if (!count || count.YES === count.NO) return market.accent;
  return count.YES > count.NO ? YES_LIGHT : NO_LIGHT;
}

function labelTexture(market: IndexMarket) {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 512;
  const ctx = canvas.getContext("2d")!;
  const accent = `#${market.accent.toString(16).padStart(6, "0")}`;
  const gradient = ctx.createLinearGradient(0, 0, 1024, 512);
  gradient.addColorStop(0, "#102a30");
  gradient.addColorStop(1, "#07191e");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 1024, 512);
  ctx.fillStyle = "#8ef5e3";
  ctx.fillRect(0, 0, 12, 512);
  ctx.fillRect(54, 60, 72, 5);
  ctx.font = "700 23px monospace";
  ctx.letterSpacing = "2px";
  ctx.fillText("INDEX NATIVE · PAPER RANGE", 54, 110);
  ctx.fillStyle = "#effffc";
  ctx.font = "900 58px Arial";
  ctx.letterSpacing = "-2px";
  ctx.fillText(market.name.toUpperCase(), 54, 190, 840);
  ctx.fillStyle = "#bed8d2";
  ctx.font = "700 24px monospace";
  ctx.letterSpacing = "1px";
  ctx.fillText(market.condition, 55, 232, 910);
  ctx.strokeStyle = "#295057";
  ctx.beginPath();
  ctx.moveTo(54, 275);
  ctx.lineTo(955, 275);
  ctx.stroke();
  ctx.fillStyle = "#bed8d2";
  ctx.font = "700 23px monospace";
  ctx.fillText("YES", 55, 345);
  ctx.fillStyle = "#74f0bd";
  ctx.font = "900 76px Arial";
  ctx.fillText(`${market.yes}¢`, 52, 430);
  ctx.fillStyle = "#bed8d2";
  ctx.font = "700 23px monospace";
  ctx.fillText("REFERENCE", 420, 345);
  ctx.fillStyle = accent;
  ctx.font = "800 40px monospace";
  ctx.fillText(market.currentPrice, 418, 408);
  ctx.fillStyle = "#bed8d2";
  ctx.font = "700 23px monospace";
  ctx.fillText("VOLUME", 735, 345);
  ctx.fillStyle = "#e2f4f2";
  ctx.font = "800 34px monospace";
  ctx.fillText(market.volume, 732, 408);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

function indexExhibitTexture(market: IndexMarket) {
  const canvas = document.createElement("canvas"); canvas.width = 1024; canvas.height = 512;
  const c = canvas.getContext("2d")!;
  c.fillStyle = "#071819"; c.fillRect(0, 0, 1024, 512);
  c.strokeStyle = "#254a43"; c.lineWidth = 1;
  for (let x=40;x<1024;x+=80) { c.beginPath();c.moveTo(x,40);c.lineTo(x,450);c.stroke(); }
  for (let y=50;y<450;y+=70) { c.beginPath();c.moveTo(40,y);c.lineTo(984,y);c.stroke(); }
  c.fillStyle="#9af5df";c.font="italic 900 104px Arial";c.fillText(market.name,45,180,930);
  c.font="700 28px monospace";c.fillStyle="#88a9a0";c.fillText("BASE 1,000 / ILLUSTRATIVE INDEX",48,235);
  c.strokeStyle="#9af5df";c.lineWidth=4;c.setLineDash([12,10]);c.beginPath();c.moveTo(45,315);c.lineTo(979,315);c.stroke();
  c.setLineDash([]);c.fillStyle="#eea45d";c.font="700 23px monospace";c.fillText("NO INDIVIDUAL-ITEM PREDICTIONS",48,423);
  const texture = new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;texture.anisotropy=8;return texture;
}

function wordmarkTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 1536;
  canvas.height = 320;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.textAlign = "center";
  const wordGradient = ctx.createLinearGradient(290, 0, 1240, 0);
  wordGradient.addColorStop(0, "#cffff6");
  wordGradient.addColorStop(0.48, "#8ef5e3");
  wordGradient.addColorStop(1, "#e89a42");
  ctx.save();
  ctx.translate(768, 0);
  ctx.transform(1, 0, -0.14, 1, 0, 0);
  ctx.fillStyle = wordGradient;
  ctx.strokeStyle = "rgba(3,15,18,.9)";
  ctx.lineWidth = 8;
  ctx.font = "italic 950 152px Arial Black, Arial";
  ctx.letterSpacing = "-12px";
  ctx.strokeText("HYPERSTRIKE", 0, 172);
  ctx.fillText("HYPERSTRIKE", 0, 172);
  ctx.restore();
  ctx.strokeStyle = "rgba(142,245,227,.76)";
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.moveTo(250, 205);
  ctx.bezierCurveTo(480, 158, 570, 252, 790, 204);
  ctx.bezierCurveTo(980, 164, 1090, 221, 1278, 188);
  ctx.stroke();
  ctx.strokeStyle = "rgba(232,154,66,.7)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(306, 218);
  ctx.bezierCurveTo(505, 188, 620, 264, 846, 215);
  ctx.stroke();
  ctx.fillStyle = "#78a7aa";
  ctx.font = "700 21px monospace";
  ctx.letterSpacing = "7px";
  ctx.fillText("TRADE THE CS2 ECONOMY / CANONICAL INDEX MARKETS", 768, 274);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** A YES / NO target: the side, and under it the contracts staged on it so far and what they cost. */
function paintOutcome(canvas: HTMLCanvasElement, side: VoteSide, staged: number, cents: number) {
  const ctx = canvas.getContext("2d")!;
  const yes = side === "YES";
  const accent = yes ? "#6df3b6" : "#ff776f";
  const gradient = ctx.createLinearGradient(0, 0, 512, 192);
  gradient.addColorStop(0, yes ? "#102d2b" : "#301b20");
  gradient.addColorStop(1, "#07191e");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 512, 192);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 5;
  ctx.strokeRect(3, 3, 506, 186);
  ctx.textAlign = "left";
  ctx.fillStyle = accent;
  ctx.font = "900 78px Arial";
  ctx.letterSpacing = "0px";
  ctx.fillText(side, 28, 112);
  ctx.font = "700 19px monospace";
  ctx.letterSpacing = "3px";
  if (staged > 0) {
    // Staged: the count is the headline, with the price and the stake it adds up to.
    ctx.textAlign = "right";
    ctx.font = "900 78px Arial";
    ctx.letterSpacing = "0px";
    ctx.fillStyle = "#f4fffa";
    ctx.fillText(`×${staged}`, 486, 112);
    ctx.font = "700 19px monospace";
    ctx.letterSpacing = "2px";
    ctx.fillStyle = accent;
    ctx.fillText(`$${((staged * cents) / 100).toFixed(2)} STAKE`, 484, 153);
    ctx.textAlign = "left";
    ctx.fillStyle = "#b6cecf";
    ctx.fillText(`@ ${cents}¢ · SHOOT +1`, 29, 153);
  } else {
    ctx.fillStyle = "#b6cecf";
    ctx.fillText(`SHOOT · +1 @ ${cents}¢`, 29, 153);
  }
}

function outcomeTexture(side: VoteSide, staged: number, cents: number) {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 192;
  paintOutcome(canvas, side, staged, cents);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function environmentSignTexture(title: string, subtitle: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createLinearGradient(0, 0, 1024, 256);
  gradient.addColorStop(0, "#0b252b");
  gradient.addColorStop(1, "#07171b");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 1024, 256);
  ctx.fillStyle = "#8ef5e3";
  ctx.fillRect(0, 0, 11, 256);
  ctx.fillStyle = "#effffc";
  let titleSize = 72;
  ctx.font = `900 ${titleSize}px Arial`;
  while (ctx.measureText(title).width > 900 && titleSize > 42) {
    titleSize -= 2;
    ctx.font = `900 ${titleSize}px Arial`;
  }
  ctx.fillText(title, 52, 120);
  ctx.fillStyle = "#c1ddd7";
  ctx.font = "700 25px monospace";
  ctx.letterSpacing = "2px";
  ctx.fillText(subtitle, 55, 180, 910);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function rangeDecalTexture(label: string, detail: string, orange = false) {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 448;
  const ctx = canvas.getContext("2d")!;
  const accent = orange ? "#e89a42" : "#8ef5e3";
  const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  gradient.addColorStop(0, "#07171b");
  gradient.addColorStop(1, "#02090c");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 9;
  ctx.strokeRect(10, 10, canvas.width - 20, canvas.height - 20);
  ctx.fillStyle = accent;
  ctx.fillRect(10, 10, 22, canvas.height - 20);
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#effffc";
  ctx.font = "italic 900 146px Arial";
  ctx.fillText(label, 72, 220);
  ctx.fillStyle = accent;
  ctx.font = "800 35px monospace";
  ctx.letterSpacing = "5px";
  ctx.fillText(detail, 78, 324);
  ctx.fillStyle = "#668d8f";
  ctx.font = "700 22px monospace";
  ctx.letterSpacing = "3px";
  ctx.fillText("HYPEREVM NATIVE / WAYFINDING", 79, 377);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

function smooth01(value: number) {
  const clamped = THREE.MathUtils.clamp(value, 0, 1);
  return clamped * clamped * (3 - 2 * clamped);
}

export function World({ quality="HIGH", markets, onSelect, onProximity, entered, onEntered, onLockChange, onAmmoChange, onVote, votes, portfolio, onFurnace, onFurnaceProximity, onChart, onChartProximity, onReady }: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const scopeRef = useRef<HTMLDivElement>(null);
  const enteredRef = useRef(entered);
  const selectRef = useRef(onSelect);
  const proximityRef = useRef(onProximity);
  const enteredEventRef = useRef(onEntered);
  const lockRef = useRef(onLockChange);
  const ammoRef = useRef(onAmmoChange);
  const voteRef = useRef(onVote);
  const votesRef = useRef(votes);
  const furnaceRef = useRef(onFurnace);
  const furnaceProximityRef = useRef(onFurnaceProximity);
  const chartRef = useRef(onChart);
  const chartProximityRef = useRef(onChartProximity);
  const readyRef = useRef(onReady);
  const portfolioRef = useRef(portfolio);
  const lcdRefreshRef = useRef<(() => void) | null>(null);
  const [weaponHud, setWeaponHud] = useState<WeaponHud | null>(null);
  const [hordeHud, setHordeHud] = useState<HordeHud | null>(null);
  /** The last YES / NO target struck: which market and side, and how many in a row. */
  const [strike, setStrike] = useState<{ id: number; market: number; side: VoteSide; streak: number } | null>(null);

  useEffect(() => { enteredRef.current = entered; }, [entered]);
  useEffect(() => { selectRef.current = onSelect; }, [onSelect]);
  useEffect(() => { proximityRef.current = onProximity; }, [onProximity]);
  useEffect(() => { enteredEventRef.current = onEntered; }, [onEntered]);
  useEffect(() => { lockRef.current = onLockChange; }, [onLockChange]);
  useEffect(() => { ammoRef.current = onAmmoChange; }, [onAmmoChange]);
  useEffect(() => { voteRef.current = onVote; }, [onVote]);
  useEffect(() => { votesRef.current = votes; }, [votes]);
  useEffect(() => { furnaceRef.current = onFurnace; }, [onFurnace]);
  useEffect(() => { furnaceProximityRef.current = onFurnaceProximity; }, [onFurnaceProximity]);
  useEffect(() => { chartRef.current = onChart; }, [onChart]);
  useEffect(() => { chartProximityRef.current = onChartProximity; }, [onChartProximity]);
  useEffect(() => { readyRef.current = onReady; }, [onReady]);
  useEffect(() => { portfolioRef.current = portfolio; lcdRefreshRef.current?.(); }, [portfolio]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let disposed = false;

    const loadingManager = new THREE.LoadingManager();
    loadingManager.itemStart("hyperstrike-world-bootstrap");

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x6f8fa8);
    scene.fog = new THREE.FogExp2(0x16201f, quality === "HIGH" ? 0.0045 : 0.011);

    const BASE_FOV = 76;
    const camera = new THREE.PerspectiveCamera(BASE_FOV, mount.clientWidth / mount.clientHeight, 0.08, 110);
    camera.position.set(0, 1.62, 7.2);
    camera.rotation.order = "YXZ";
    const viewModelScene = new THREE.Scene();
    const viewModelCamera = new THREE.PerspectiveCamera(54, mount.clientWidth / mount.clientHeight, 0.01, 12);
    viewModelCamera.position.set(0, 0, 0);
    viewModelScene.add(viewModelCamera);
    viewModelScene.add(new THREE.HemisphereLight(0xd9ecec, 0x2a2622, 0.22));

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance", stencil: false });
    // Stable resolution from the first frame: no delayed quality drop/rebuild.
    const pixelBudget=quality==="HIGH"?2_800_000:1_300_000;
    const initialPixelRatio = Math.min(window.devicePixelRatio, quality==="HIGH"?1.6:1.25, Math.sqrt(pixelBudget / (mount.clientWidth * mount.clientHeight)));
    renderer.setPixelRatio(initialPixelRatio);
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.shadowMap.autoUpdate = false;
    renderer.autoClear = false;
    renderer.debug.checkShaderErrors = import.meta.env.DEV;
    mount.appendChild(renderer.domElement);

    const range = buildRange({ scene, renderer, quality, loadingManager });
    const ballistics = createBallistics(scene);
    range.mirrorHidden.push(...ballistics.transient);
    const strikeFx = createStrikeFx(scene);
    range.mirrorHidden.push(...strikeFx.transient);
    let strikeId = 0, strikeStreak = 0, lastStrikeAt = -1e6;
    const strikeNormal = new THREE.Vector3();
    const shootableObjects = range.shootable;
    const furnaceMeshes = range.furnaceMeshes;
    const environmentTextures: THREE.Texture[] = [];
    const textureLoader = new THREE.TextureLoader(loadingManager);

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    composer.setPixelRatio(initialPixelRatio);
    const aoPass = new GTAOPass(scene, camera, mount.clientWidth, mount.clientHeight);
    const renderAO = aoPass.render.bind(aoPass);
    aoPass.render = (...args: Parameters<typeof aoPass.render>) =>
      withOpaqueOccluders(scene, () => renderAO(...args));
    aoPass.enabled = quality === "HIGH";
    aoPass.updateGtaoMaterial({ radius: 0.55, samples: 8, distanceExponent: 1.4, thickness: 0.6, distanceFallOff: 1 });
    aoPass.updatePdMaterial({ samples: 8, rings: 2, radius: 4 });
    aoPass.blendIntensity = 0.82;
    // Keep contact occlusion at half resolution independently of the sharp scene.
    const sizeAO = aoPass.setSize.bind(aoPass);
    aoPass.setSize = (w: number, h: number) => sizeAO(Math.max(1, Math.floor(w / 2)), Math.max(1, Math.floor(h / 2)));
    composer.addPass(aoPass);
    // Sun shafts are marched against the opaque depth the occlusion pass already produced.
    const volumetricPass = new VolumetricPass(camera, range.sun, aoPass.depthTexture, new THREE.Color(0.022, 0.038, 0.042));
    volumetricPass.enabled = quality === "HIGH";
    volumetricPass.glows.push(...range.glows);
    composer.addPass(volumetricPass);
    const weaponPass = new RenderPass(viewModelScene, viewModelCamera);
    weaponPass.clear = false;
    weaponPass.clearDepth = true;
    const renderWeapon = weaponPass.render.bind(weaponPass);
    weaponPass.render = (...args: Parameters<typeof weaponPass.render>) => {
      // World shadows are static; only the rifle's own shadow map refreshes each frame.
      if (quality === "HIGH") renderer.shadowMap.needsUpdate = true;
      renderWeapon(...args);
    };
    composer.addPass(weaponPass);
    const bloomPass = new UnrealBloomPass(new THREE.Vector2(mount.clientWidth, mount.clientHeight), 0.26, 0.42, 1.15);
    composer.addPass(bloomPass);
    const bodycamPass = new ShaderPass(BODYCAM_SHADER);
    composer.addPass(bodycamPass);
    composer.addPass(new OutputPass());
    // Anti-alias the display-referred image: edge detection is unreliable on HDR values.
    const fxaaPass = new ShaderPass(FXAAShader);
    fxaaPass.uniforms.resolution.value.set(
      1 / (mount.clientWidth * initialPixelRatio),
      1 / (mount.clientHeight * initialPixelRatio),
    );
    composer.addPass(fxaaPass);
    range.reflection.setSize(mount.clientWidth * initialPixelRatio * 0.6, mount.clientHeight * initialPixelRatio * 0.6);

    // The HDR sky is only what the roof lights look out on; the room is lit by its own probe.
    const pmrem = new THREE.PMREMGenerator(renderer);
    let roomProbe: THREE.WebGLRenderTarget | null = null;
    let skyMap: THREE.Texture | null = null;
    new HDRLoader(loadingManager).load("/environment/bonzai-sky.hdr", (hdr) => {
      if (disposed) { hdr.dispose(); return; }
      hdr.mapping = THREE.EquirectangularReflectionMapping;
      skyMap = hdr;
      scene.background = hdr;
      scene.backgroundIntensity = 1.0;
    });

    const emergencyMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff2c50).multiplyScalar(4.8), toneMapped: false });
    for (const z of [3.5, -8.5, -20.5]) {
      const fixture = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.12, 0.15), emergencyMaterial);
      fixture.position.set(-9.54, 3.62, z);
      scene.add(fixture);
    }

    const signFrame = new THREE.MeshStandardMaterial({ color: 0x0c1416, metalness: 0.85, roughness: 0.38 });
    const mountSign = (texture: THREE.Texture, width: number, height: number, position: [number, number, number], rotation: number, parent: THREE.Object3D = scene) => {
      texture.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
      environmentTextures.push(texture);
      const housing = new THREE.Mesh(new RoundedBoxGeometry(width + 0.14, height + 0.14, 0.09, 2, 0.02), signFrame);
      housing.position.set(...position);
      housing.rotation.y = rotation;
      housing.castShadow = true;
      const face = new THREE.Mesh(new THREE.PlaneGeometry(width, height), displayMaterial(texture));
      face.position.z = 0.047;
      housing.add(face);
      parent.add(housing);
      return face;
    };
    // Keep signs centered in clear six-metre bays so structural columns never crop the copy.
    mountSign(rangeDecalTexture("RANGE A  →", "CS2 INDEX MARKETS", true), 4.8, 2.1, [-9.45, 2.45, -11], Math.PI / 2);
    mountSign(rangeDecalTexture("←  CONTROL", "PORTFOLIO / INDEX INTELLIGENCE", false), 4.8, 2.1, [9.45, 2.45, -23], -Math.PI / 2);
    mountSign(environmentSignTexture("1 HIT = 1 CONTRACT", "AIM YES / NO · E TO REVIEW · CONFIRM TO SUBMIT"), 4.6, 1.15, [-9.45, 2.6, -17], Math.PI / 2);
    mountSign(environmentSignTexture("HSX → STRIKE", "MINT CAPACITY · CREATE MARKETS"), 4.6, 1.15, [9.45, 2.6, -17], -Math.PI / 2);
    const furnaceSign = mountSign(environmentSignTexture("STRIKE FOUNDRY", "E · EXPLORE MARKET CAPACITY"), 3.25, 0.82, [0, 4.15, 0.62], 0, range.furnace);
    furnaceSign.userData.utility = "furnace";
    furnaceMeshes.push(furnaceSign);

    // The entrance end of the room is a physical market-tape wall.
    const chartFrame = new THREE.Mesh(new RoundedBoxGeometry(12.5, 6.5, 0.18, 2, 0.04), signFrame);
    chartFrame.position.set(0, 3.8, 9.62);
    chartFrame.castShadow = true;
    scene.add(chartFrame);
    const chartCanvas = document.createElement("canvas");
    drawHsxChart(chartCanvas, null);
    const chartTexture = new THREE.CanvasTexture(chartCanvas);
    chartTexture.colorSpace = THREE.SRGBColorSpace;
    chartTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    environmentTextures.push(chartTexture);
    const chartScreen = new THREE.Mesh(new THREE.PlaneGeometry(12, 6), displayMaterial(chartTexture));
    chartScreen.position.set(0, 3.8, 9.52);
    chartScreen.rotation.y = Math.PI;
    scene.add(chartScreen);
    shootableObjects.push(chartScreen);
    const unsubscribeChart = subscribeHsxChart(data => {
      if (disposed) return;
      drawHsxChart(chartCanvas, data);
      chartTexture.needsUpdate = true;
    });
    const wordmark = new THREE.Mesh(
      new THREE.PlaneGeometry(12, 2.5),
      new THREE.MeshBasicMaterial({ map: wordmarkTexture(), transparent: true, toneMapped: false }),
    );
    wordmark.position.set(0, 5.25, -25.92);
    wordmark.scale.setScalar(0.82);
    scene.add(wordmark);

    const brandTexture = textureLoader.load("/brand/hyperstrike-mark.png");
    brandTexture.colorSpace = THREE.SRGBColorSpace;
    const brandMark = new THREE.Mesh(
      new THREE.PlaneGeometry(3.7, 3.7),
      new THREE.MeshBasicMaterial({ map: brandTexture, transparent: true, opacity: 0.34, depthWrite: false, toneMapped: false }),
    );
    brandMark.position.set(0, 5.2, -28.3);
    brandMark.scale.setScalar(0.44);
    scene.add(brandMark);

    const marketPositions = markets.map((market) => new THREE.Vector3(...market.position));
    const exhibitGroups: THREE.Group[] = [];
    const screenMaterials: THREE.MeshPhysicalMaterial[] = [];
    const stationLights: THREE.PointLight[] = [];
    const stationRingMaterials: THREE.MeshBasicMaterial[] = [];
    const stationMajorities: string[] = [];
    const interactiveMeshes: THREE.Mesh[] = [];
    const voteMeshes: THREE.Mesh[] = [];
    const skinTextures: THREE.Texture[] = [];
    const voteTextures: THREE.Texture[] = [];
    const { darkMetal, machine, structural, brushed } = range.materials;
    const solid = (geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      parent.add(mesh);
      return mesh;
    };
    // Turned-steel plinth: stepped foot, waist and a chamfered deck.
    const plinthGeometry = new THREE.LatheGeometry([
      [0, 0], [1.96, 0], [1.98, 0.03], [1.98, 0.1], [1.9, 0.13], [1.72, 0.17], [1.66, 0.3],
      [1.64, 0.36], [1.6, 0.4], [1.5, 0.42], [1.46, 0.42], [1.42, 0.4], [0, 0.4],
    ].map(([x, y]) => new THREE.Vector2(x, y)), 56);
    projectUv(plinthGeometry, 1.3);
    const postGeometry = new THREE.CylinderGeometry(0.045, 0.055, 1.62, 12);
    const screenShell = new RoundedBoxGeometry(3.56, 2.19, 0.2, 3, 0.035);
    const exhibitShell = new RoundedBoxGeometry(3.12, 1.62, 0.07, 2, 0.02);
    const voteShell = new RoundedBoxGeometry(1.5, 0.61, 0.06, 2, 0.015);
    const braceGeometry = new THREE.BoxGeometry(0.035, 0.035, 0.74);

    markets.forEach((market, index) => {
      const group = new THREE.Group();
      group.position.copy(marketPositions[index]);
      const initialVoteCount = votesRef.current[market.id];
      const initialLightColor = marketLightColor(market, initialVoteCount);
      const stationLight = new THREE.PointLight(initialLightColor, 7, 6, 2);
      stationLight.position.set(0, 2.2, 1.1);
      group.add(stationLight);
      stationLights.push(stationLight);
      stationMajorities.push(initialVoteCount?.YES === initialVoteCount?.NO ? "TIE" : initialVoteCount?.YES > initialVoteCount?.NO ? "YES" : "NO");
      const base = solid(plinthGeometry, darkMetal, 0, 0, 0, group);
      base.userData.marketIndex = index;
      interactiveMeshes.push(base);
      const ringMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(initialLightColor).multiplyScalar(3.2), toneMapped: false });
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(1.52, 0.028, 8, 96),
        ringMaterial,
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.425;
      group.add(ring);
      stationRingMaterials.push(ringMaterial);

      // Twin masts and rear stays carry the display instead of leaving it floating.
      for (const x of [-1.42, 1.42]) {
        solid(postGeometry, brushed, x, 1.21, -0.42, group);
        const stay = solid(braceGeometry, structural, x, 0.74, -0.74, group);
        stay.rotation.x = -0.72;
      }
      const screenFrame = solid(screenShell, machine, 0, 2.72, -0.42, group);
      screenFrame.userData.marketIndex = index;
      interactiveMeshes.push(screenFrame);
      const screenMaterial = displayMaterial(labelTexture(market));
      const screen = new THREE.Mesh(new THREE.PlaneGeometry(3.28, 1.78), screenMaterial);
      screen.position.set(0, 2.72, -0.315);
      screen.userData.marketIndex = index;
      group.add(screen);
      interactiveMeshes.push(screen);
      screenMaterials.push(screenMaterial);

      const skinTexture = indexExhibitTexture(market);
      skinTexture.colorSpace = THREE.SRGBColorSpace;
      skinTexture.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
      skinTextures.push(skinTexture);
      solid(exhibitShell, machine, 0, 1.3, 0.16, group);
      for (const x of [-1.2, 1.2]) solid(new THREE.CylinderGeometry(0.03, 0.03, 0.2, 10), brushed, x, 0.5, 0.16, group);
      const officialSkin = new THREE.Mesh(new THREE.PlaneGeometry(3.0, 1.5), displayMaterial(skinTexture));
      officialSkin.position.set(0, 1.3, 0.2);
      officialSkin.userData.marketIndex = index;
      group.add(officialSkin);
      interactiveMeshes.push(officialSkin);

      (["YES", "NO"] as VoteSide[]).forEach((side, sideIndex) => {
        const staged = initialVoteCount?.[side] ?? 0, cents = side === "YES" ? market.yes : 100 - market.yes;
        const texture = outcomeTexture(side, staged, cents);
        voteTextures.push(texture);
        const x = sideIndex === 0 ? -0.88 : 0.88;
        solid(voteShell, darkMetal, x, 0.73, 0.485, group);
        const target = new THREE.Mesh(new THREE.PlaneGeometry(1.42, 0.53), displayMaterial(texture));
        target.position.set(x, 0.73, 0.52);
        target.userData.marketIndex = index;
        target.userData.voteSide = side;
        target.userData.staged = staged;
        target.userData.cents = cents;
        target.userData.hitAt = -1000;
        group.add(target);
        voteMeshes.push(target);
      });

      scene.add(group);
      exhibitGroups.push(group);
    });

    const targetMeshes: THREE.Mesh[] = [];
    const committedExposure = portfolio.reduce((sum, entry) => sum + entry.amount, 0);
    const lcdMaterials: THREE.MeshPhysicalMaterial[] = [];
    const controlCenter = new THREE.Group();
    controlCenter.position.set(0, 0, -25.7);
    const controlRack = solid(new RoundedBoxGeometry(17.2, 5.2, 0.62, 3, 0.05), machine, 0, 2.7, -0.7, controlCenter);
    const consoleDesk = solid(new RoundedBoxGeometry(16.4, 1.05, 2.25, 3, 0.06), machine, 0, 0.55, 0.2, controlCenter);
    solid(new RoundedBoxGeometry(16.6, 0.07, 2.4, 2, 0.02), darkMetal, 0, 1.09, 0.2, controlCenter);
    solid(new THREE.BoxGeometry(16.5, 0.12, 2.3), darkMetal, 0, 0.06, 0.2, controlCenter);
    shootableObjects.push(controlRack, consoleDesk);
    const lcdLayouts = [
      [-5.75, 3.65], [-2.88, 3.65], [0, 3.65], [2.88, 3.65], [5.75, 3.65],
      [-4.35, 1.85], [-1.45, 1.85], [1.45, 1.85], [4.35, 1.85],
    ] as Array<[number, number]>;
    const lcdShell = new RoundedBoxGeometry(2.72, 1.58, 0.22, 3, 0.03);
    lcdLayouts.forEach(([x, y], index) => {
      solid(lcdShell, darkMetal, x, y, -0.28, controlCenter);
      const entry = index === 0 ? null : portfolio[index - 1] ?? null;
      const lcdTexture = controlCenterTexture(entry, index, portfolio.length, committedExposure);
      const screen = new THREE.Mesh(new THREE.PlaneGeometry(2.5, 1.36), displayMaterial(lcdTexture, 1.12));
      screen.position.set(x, y, -0.165);
      controlCenter.add(screen);
      lcdMaterials.push(screen.material);
    });
    lcdRefreshRef.current = () => {
      const entries = portfolioRef.current;
      lcdMaterials.forEach((material, index) => {
        material.emissiveMap?.dispose();
        material.emissiveMap = controlCenterTexture(index === 0 ? null : entries[index - 1] ?? null, index, entries.length, entries.reduce((sum, e) => sum + e.amount, 0));
        material.needsUpdate = true;
      });
    };
    const consoleStrip = new THREE.Mesh(
      new THREE.BoxGeometry(15.6, 0.045, 0.12),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(BRAND).multiplyScalar(3.4), toneMapped: false }),
    );
    consoleStrip.position.set(0, 1.12, 1.15);
    controlCenter.add(consoleStrip);
    scene.add(controlCenter);

    const scanningLine = new THREE.Mesh(
      new THREE.BoxGeometry(18, 0.014, 0.025),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(BRAND).multiplyScalar(2.8), transparent: true, opacity: 0.78, toneMapped: false }),
    );
    scanningLine.position.set(0, 0.04, -3);
    scene.add(scanningLine);

    // Viewmodel: `viewWeapon` carries sway and recoil, `weaponBody` the reload tilt.
    // Weapons and hands are built in real metres and scaled up into view units.
    const VIEW_SCALE = 2.5;
    const viewWeapon = new THREE.Group();
    viewWeapon.scale.setScalar(VIEW_SCALE);
    const shoulder = new THREE.Vector3(0.41, -0.45, -0.96);
    const weaponRotation = new THREE.Euler(0.03, 0.065, 0.015);
    viewWeapon.position.copy(shoulder);
    viewWeapon.rotation.copy(weaponRotation);
    viewModelScene.add(viewWeapon);
    const weaponBody = new THREE.Group();
    viewWeapon.add(weaponBody);
    const anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
    const arsenal = createArsenal(anisotropy, loadingManager, () => disposed);
    const arms = createArms(anisotropy, loadingManager, () => disposed);
    weaponBody.add(arms.hands);
    viewWeapon.add(arms.sleeves);
    arsenal.rigs.forEach((rig, index) => { rig.root.visible = index === 0; weaponBody.add(rig.root); });
    const contacts = new Map<WeaponRig, Contact>();
    const rigPose: RigPose = { left: emptyPose(), right: emptyPose(), bodyPosition: new THREE.Vector3(), bodyRotation: new THREE.Euler() };
    const muzzleAnchor = new THREE.Object3D();
    muzzleAnchor.scale.setScalar(1 / VIEW_SCALE);
    weaponBody.add(muzzleAnchor);

    // The rifle is lit by the room: an overhead key that stays world-anchored as the
    // player looks around, plus direct sun whenever they stand in a sun patch.
    const weaponKey = new THREE.DirectionalLight(0xdff3ef, 1.5);
    weaponKey.castShadow = quality === "HIGH";
    weaponKey.shadow.mapSize.set(1024, 1024);
    weaponKey.shadow.camera.left = -1.3; weaponKey.shadow.camera.right = 1.3;
    weaponKey.shadow.camera.top = 1.3; weaponKey.shadow.camera.bottom = -1.3;
    weaponKey.shadow.camera.near = 0.5; weaponKey.shadow.camera.far = 9;
    weaponKey.shadow.bias = -0.0015;
    weaponKey.shadow.normalBias = 0.012;
    weaponKey.target.position.set(0.25, -0.35, -1.25);
    const weaponSun = new THREE.DirectionalLight(0xfff0d8, 0);
    weaponSun.target.position.copy(weaponKey.target.position);
    const weaponRim = new THREE.DirectionalLight(0xffc89a, 0.55);
    weaponRim.position.set(2.4, 0.4, 1.2);
    weaponRim.target.position.copy(weaponKey.target.position);
    viewModelScene.add(weaponKey, weaponKey.target, weaponSun, weaponSun.target, weaponRim, weaponRim.target);
    const overhead = new THREE.Vector3(), sunward = new THREE.Vector3(), inverseView = new THREE.Quaternion();
    let weaponSunAmount = 0;
    const muzzle = new THREE.PointLight(0xff9c43, 0, 5, 2);
    muzzleAnchor.add(muzzle);
    const muzzleFireMap = muzzleFireTexture();
    environmentTextures.push(muzzleFireMap);
    const muzzleFlash = new THREE.Group();
    const muzzleCore = new THREE.Mesh(
      new THREE.ConeGeometry(0.075, 0.48, 12, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xffffdf, transparent: true, opacity: 0.96, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
    );
    muzzleCore.rotation.x = -Math.PI / 2;
    muzzleCore.position.z = -0.22;
    muzzleFlash.add(muzzleCore);
    const muzzleOuter = new THREE.Mesh(
      new THREE.ConeGeometry(0.19, 0.68, 9, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xff6817, transparent: true, opacity: 0.66, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
    );
    muzzleOuter.rotation.x = -Math.PI / 2;
    muzzleOuter.position.z = -0.31;
    muzzleFlash.add(muzzleOuter);
    const muzzleBurst = new THREE.Sprite(new THREE.SpriteMaterial({ map: muzzleFireMap, color: 0xffb13b, transparent: true, opacity: 0.92, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    muzzleBurst.position.z = -0.1;
    muzzleBurst.scale.set(0.62, 0.62, 1);
    muzzleFlash.add(muzzleBurst);
    muzzleFlash.visible = false;
    muzzleAnchor.add(muzzleFlash);
    const roomMuzzleLight = new THREE.PointLight(0xff7a24, 0, 13, 2);
    scene.add(roomMuzzleLight);
    scene.add(camera);

    const keys = new Set<string>();
    const raycaster = new THREE.Raycaster();
    const tracerRaycaster = new THREE.Raycaster();
    raycaster.far = 60;
    let yaw = 0;
    let pitch = 0.06;
    let lookKickX = 0;
    let lookKickY = 0;
    let recoil = 0;
    let muzzleEnergy = 0;
    let lastTargeted = -1;
    let furnaceTargeted = false;
    let chartTargeted = false;
    let lastFrameTime = performance.now();
    let current = 0;
    let previous = 1;
    let switchingTo = -1;
    let switchStartedAt = 0;
    const SWITCH_DOWN = 190, SWITCH_UP = 300;
    const magazines = arsenal.rigs.map((rig) => rig.spec.magazine);
    const modes: FireMode[] = arsenal.rigs.map((rig) => rig.spec.modes[0]);
    const trigger = createTrigger();
    const reserve = Number.POSITIVE_INFINITY;
    let reloading = false;
    let reloadStartedAt = 0;
    let reloadCursor = 0;
    let cycleStartedAt = -1;
    let cycleCursor = 0;
    let cycleEjected = false;
    let autoReloadAt = -1;
    let climbDebt = 0;
    let forceFire = false;
    // Aiming: held on Space. `aim` eases 0→1; looking slows by the magnification.
    let forceScope = false, aim = 0, lookScale = 1, throughScope = false;
    let frozenReload: number | null = null;

    // Wave mode (unlocked with the Konami code).
    let shake = 0;
    const horde = createHorde({
      scene,
      obstacles: [...marketPositions.map((position) => ({ x: position.x, z: position.z, r: 2.15 })), { x: 9.18, z: -11.6, r: 2.6 }],
      audio: () => (audioContext ??= new AudioContext()),
      onHud: (hud) => { if (!disposed) setHordeHud(hud); },
      onHurt: (amount) => { shake = Math.max(shake, amount <= 1 ? 0.25 + amount * 0.5 : 1); },
    });
    volumetricPass.glows.push(...horde.glows);
    const konami = createSequenceDetector();
    const calm = {
      fog: (scene.fog as THREE.FogExp2).color.clone(), fogDensity: (scene.fog as THREE.FogExp2).density,
      sun: range.sun.color.clone(), sunIntensity: range.sun.intensity,
      haze: volumetricPass.haze.clone(), density: volumetricPass.density,
      fills: range.fills.map((light) => light.intensity),
    };
    const dread = { fog: new THREE.Color(0x140303), sun: new THREE.Color(1, 0.34, 0.24), haze: new THREE.Color(0.05, 0.012, 0.01) };
    const toggleHorde = () => {
      if (horde.active) horde.stop();
      else horde.start(performance.now());
    };
    let audioContext: AudioContext | null = null;
    const moveDirection = new THREE.Vector3();
    const reportWeapon = () => {
      const spec = arsenal.rigs[current].spec;
      ammoRef.current(magazines[current], reserve, reloading);
      setWeaponHud({ slot: current, name: spec.name, calibre: spec.calibre, mode: modes[current], modes: spec.modes, magazine: magazines[current], capacity: spec.magazine, reloading, scope: spec.scope });
    };
    reportWeapon();

    const burst = (frequency: number, q: number, length: number, gain: number, delay = 0, type: BiquadFilterType = "bandpass") => {
      audioContext ??= new AudioContext();
      const context = audioContext;
      const at = context.currentTime + delay;
      const buffer = context.createBuffer(1, Math.max(1, Math.floor(context.sampleRate * length)), context.sampleRate);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < channel.length; i += 1) channel[i] = (Math.random() * 2 - 1) * (1 - i / channel.length) ** 2;
      const noise = context.createBufferSource();
      noise.buffer = buffer;
      const filter = context.createBiquadFilter();
      filter.type = type;
      filter.frequency.value = frequency;
      filter.Q.value = q;
      const volume = context.createGain();
      volume.gain.value = gain;
      noise.connect(filter).connect(volume).connect(context.destination);
      noise.start(at);
    };
    /** A short bright tone: the confirmation that a contract was staged. */
    const chime = (frequency: number) => {
      audioContext ??= new AudioContext();
      const context = audioContext, at = context.currentTime;
      [1, 2.01].forEach((harmonic, index) => {
        const oscillator = context.createOscillator(), volume = context.createGain();
        oscillator.type = index === 0 ? "triangle" : "sine";
        oscillator.frequency.setValueAtTime(frequency * harmonic, at);
        volume.gain.setValueAtTime(index === 0 ? 0.09 : 0.035, at);
        volume.gain.exponentialRampToValueAtTime(0.0001, at + (index === 0 ? 0.34 : 0.2));
        oscillator.connect(volume).connect(context.destination);
        oscillator.start(at);
        oscillator.stop(at + 0.36);
      });
    };
    const playAction = (kind: ReloadSound | "select" | "draw" | "dry") => {
      if (kind === "magOut") { burst(900, 2, 0.05, 0.3); burst(2600, 4, 0.03, 0.14, 0.04); }
      else if (kind === "magIn") { burst(520, 1.5, 0.07, 0.42); burst(2100, 5, 0.025, 0.2, 0.03); }
      else if (kind === "rack") { burst(1700, 3, 0.05, 0.3); burst(1100, 2, 0.06, 0.38, 0.11); burst(3200, 6, 0.02, 0.16, 0.13); }
      else if (kind === "slap") { burst(320, 1, 0.07, 0.5, 0, "lowpass"); burst(1500, 3, 0.04, 0.24, 0.015); }
      else if (kind === "boltUp") burst(2300, 5, 0.035, 0.26);
      else if (kind === "boltBack") { burst(1250, 2.5, 0.09, 0.3); burst(3400, 7, 0.02, 0.14, 0.085); }
      else if (kind === "boltHome") { burst(950, 2, 0.08, 0.32); burst(2500, 5, 0.03, 0.22, 0.09); }
      else if (kind === "cloth") burst(700, 0.6, 0.16, 0.08, 0, "lowpass");
      else if (kind === "select") burst(3100, 8, 0.02, 0.22);
      else if (kind === "draw") { burst(600, 0.7, 0.14, 0.12, 0, "lowpass"); burst(1900, 4, 0.03, 0.14, 0.12); }
      else burst(2800, 9, 0.018, 0.2);
    };

    const playShot = (spec: WeaponSpec) => {
      audioContext ??= new AudioContext();
      const context = audioContext;
      const at = context.currentTime;
      const buffer = context.createBuffer(1, Math.floor(context.sampleRate * spec.sound.length), context.sampleRate);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < channel.length; i += 1) channel[i] = (Math.random() * 2 - 1) * (1 - i / channel.length);
      const noise = context.createBufferSource();
      noise.buffer = buffer;
      const filter = context.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.value = spec.sound.pitch;
      filter.Q.value = 0.65;
      const gain = context.createGain();
      gain.gain.setValueAtTime(spec.sound.gain, at);
      gain.gain.exponentialRampToValueAtTime(0.001, at + spec.sound.length);
      noise.connect(filter).connect(gain).connect(context.destination);
      noise.start(at);
      const thump = context.createOscillator();
      const thumpGain = context.createGain();
      thump.type = "triangle";
      thump.frequency.setValueAtTime(spec.sound.thump, at);
      thump.frequency.exponentialRampToValueAtTime(48, at + 0.09);
      thumpGain.gain.setValueAtTime(spec.sound.gain * 0.8, at);
      thumpGain.gain.exponentialRampToValueAtTime(0.001, at + 0.1);
      thump.connect(thumpGain).connect(context.destination);
      thump.start(at);
      thump.stop(at + 0.1);
    };

    const startReload = () => {
      if (reloading || switchingTo >= 0 || magazines[current] === arsenal.rigs[current].spec.magazine) return;
      reloading = true;
      reloadStartedAt = performance.now();
      reloadCursor = 0;
      cycleStartedAt = -1;
      autoReloadAt = -1;
      resetTrigger(trigger);
      reportWeapon();
    };
    const switchWeapon = (index: number) => {
      if (index === current || index < 0 || index >= arsenal.rigs.length || switchingTo >= 0) return;
      reloading = false;
      cycleStartedAt = -1;
      autoReloadAt = -1;
      resetTrigger(trigger);
      switchingTo = index;
      switchStartedAt = performance.now();
      playAction("draw");
    };
    const cycleMode = () => {
      const spec = arsenal.rigs[current].spec;
      const next = nextMode(spec, modes[current]);
      if (next === modes[current]) return;
      modes[current] = next;
      resetTrigger(trigger);
      playAction("select");
      reportWeapon();
    };

    const spawnShotEffects = (now: number, endpoint: THREE.Vector3, hit: THREE.Intersection<THREE.Object3D> | undefined, eject: boolean) => {
      camera.updateMatrixWorld(true);
      viewModelCamera.updateMatrixWorld(true);
      muzzleAnchor.updateWorldMatrix(true, false);
      const muzzleNdc = muzzleAnchor.getWorldPosition(new THREE.Vector3()).project(viewModelCamera);
      tracerRaycaster.setFromCamera(new THREE.Vector2(muzzleNdc.x, muzzleNdc.y), camera);
      const start = tracerRaycaster.ray.origin.clone().addScaledVector(tracerRaycaster.ray.direction, 1.15);
      roomMuzzleLight.position.copy(start);
      ballistics.fire(now, start, endpoint, hit);
      if (eject) ballistics.eject(
        now,
        camera.localToWorld(new THREE.Vector3(0.36, -0.2, -0.75)),
        new THREE.Vector3(1.5 + Math.random() * 0.9, 1.5 + Math.random() * 0.6, 0.25).applyQuaternion(camera.quaternion),
      );
    };

    const requestLock = () => {
      if (!enteredRef.current) enteredEventRef.current();
      if (document.pointerLockElement !== renderer.domElement) void renderer.domElement.requestPointerLock()?.catch(() => { releaseTrigger(trigger); });
    };
    const onPointerLockChange = () => {
      const locked = document.pointerLockElement === renderer.domElement;
      if (!locked) { releaseTrigger(trigger); resetTrigger(trigger); }
      lockRef.current(locked);
    };
    const onMouseMove = (event: MouseEvent) => {
      if (document.pointerLockElement !== renderer.domElement) return;
      yaw -= event.movementX * 0.00165 * lookScale;
      pitch -= event.movementY * 0.00165 * lookScale;
      lookKickX = THREE.MathUtils.clamp(lookKickX + event.movementX * 0.00032, -0.035, 0.035);
      lookKickY = THREE.MathUtils.clamp(lookKickY + event.movementY * 0.00026, -0.028, 0.028);
      pitch = THREE.MathUtils.clamp(pitch, -1.28, 1.28);
    };
    const fireShot = (now: number) => {
      const rig = arsenal.rigs[current], spec = rig.spec;
      magazines[current] -= 1;
      reportWeapon();
      recoil = spec.kick;
      climbDebt += spec.climb;
      pitch = THREE.MathUtils.clamp(pitch + spec.climb, -1.28, 1.28);
      lookKickX = THREE.MathUtils.clamp(lookKickX + (Math.random() - 0.5) * spec.climb * 1.6, -0.035, 0.035);
      muzzleEnergy = 1;
      playShot(spec);
      raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
      const hits = raycaster.intersectObjects([...voteMeshes, ...targetMeshes, ...interactiveMeshes, ...shootableObjects, ...(horde.active ? horde.targets : [])], false);
      // Bullets stop in the first zombie; the bolt-action punches through a line of them.
      let hit: THREE.Intersection<THREE.Object3D> | undefined;
      let flesh: THREE.Vector3 | null = null;
      const struck = new Set<number>();
      for (const candidate of hits) {
        const zombie = candidate.object.userData.zombie as number | undefined;
        if (zombie === undefined) { hit = candidate; break; }
        if (struck.has(zombie)) continue;
        struck.add(zombie);
        if (horde.hit(candidate.object, candidate.point, raycaster.ray.direction, spec.damage, spec.headshot, now)) flesh ??= candidate.point.clone();
        if (modes[current] !== "BOLT" || struck.size >= 4) { hit = undefined; break; }
      }
      if (flesh && modes[current] !== "BOLT") hit = undefined;
      const endpoint = hit?.point.clone() ?? flesh ?? raycaster.ray.origin.clone().addScaledVector(raycaster.ray.direction, 45);
      if (hit && targetMeshes.includes(hit.object as THREE.Mesh)) hit.object.userData.hitAt = now;
      if (hit && !horde.active && voteMeshes.includes(hit.object as THREE.Mesh)) {
        const marketIndex = Number(hit.object.userData.marketIndex);
        const side = hit.object.userData.voteSide as VoteSide;
        hit.object.userData.hitAt = now;
        voteRef.current(markets[marketIndex], side);
        // Make it land: effects on the panel, a rising chime for a run of hits, and the live contract readout.
        strikeStreak = now - lastStrikeAt < 1400 ? strikeStreak + 1 : 1;
        lastStrikeAt = now;
        strikeFx.hit(now, hit.point, hit.object.getWorldDirection(strikeNormal), side, strikeStreak);
        stationLights[marketIndex].userData.hitAt = now;
        chime((side === "YES" ? 784 : 523) * 2 ** (Math.min(strikeStreak - 1, 7) / 12));
        strikeId += 1;
        setStrike({ id: strikeId, market: marketIndex, side, streak: strikeStreak });
      }
      spawnShotEffects(now, endpoint, hit, modes[current] !== "BOLT");
      if (modes[current] === "BOLT" && magazines[current] > 0) { cycleStartedAt = now; cycleCursor = 0; cycleEjected = false; }
      if (magazines[current] === 0) { autoReloadAt = now + (modes[current] === "BOLT" ? 420 : 160); resetTrigger(trigger); }
    };
    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0 || document.pointerLockElement !== renderer.domElement) return;
      pressTrigger(trigger);
    };
    const onMouseUp = (event: MouseEvent) => {
      if (event.button === 0) releaseTrigger(trigger);
    };
    const onWheel = (event: WheelEvent) => {
      if (document.pointerLockElement !== renderer.domElement || event.deltaY === 0) return;
      const count = arsenal.rigs.length;
      switchWeapon((current + (event.deltaY > 0 ? 1 : count - 1)) % count);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (enteredRef.current && !event.repeat && konami(event.code)) toggleHorde();
      if (horde.phase === "over" && !event.repeat) {
        if (event.code === "Enter") horde.start(performance.now());
        if (event.code === "Backspace") horde.stop();
      }
      if (document.pointerLockElement !== renderer.domElement) return;
      keys.add(event.code);
      if (event.code === "Space") event.preventDefault();
      if (event.repeat) return;
      if (event.code === "KeyR") startReload();
      if (event.code === "KeyV") cycleMode();
      if (event.code === "KeyQ") switchWeapon(previous);
      if (/^Digit[1-5]$/.test(event.code)) switchWeapon(Number(event.code.slice(5)) - 1);
      if (event.code === "KeyE" && furnaceTargeted) {
        furnaceRef.current();
        document.exitPointerLock();
      } else if (event.code === "KeyE" && chartTargeted) {
        chartRef.current();
        document.exitPointerLock();
      } else if (event.code === "KeyE" && lastTargeted >= 0) {
        selectRef.current(markets[lastTargeted]);
        document.exitPointerLock();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => keys.delete(event.code);

    renderer.domElement.addEventListener("click", requestLock);
    renderer.domElement.addEventListener("mousedown", onMouseDown);
    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("pointerlockchange", onPointerLockChange);
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("wheel", onWheel, { passive: true });
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);

    let frame = 0;
    let fpsFrames = 0;
    let fpsSampleStarted = performance.now();
    let lowFpsSamples = 0;
    let adaptivePixelRatio = initialPixelRatio;
    let moodApplied = 0;
    const animate = (now: number) => {
      frame = requestAnimationFrame(animate);
      fpsFrames += 1;
      const fpsElapsed = now - fpsSampleStarted;
      if (fpsElapsed >= 1000) {
        const measuredFps = Math.round((fpsFrames * 1000) / fpsElapsed);
        mount.dataset.fps = String(measuredFps);
        lowFpsSamples = measuredFps < 54 ? lowFpsSamples + 1 : 0;
        fpsFrames = 0;
        fpsSampleStarted = now;
      }
      const dt = Math.min((now - lastFrameTime) / 1000, 0.033);
      lastFrameTime = now;
      let moving = false;
      if (document.pointerLockElement === renderer.domElement) {
        moveDirection.set(0, 0, 0);
        if (keys.has("KeyW")) moveDirection.z -= 1;
        if (keys.has("KeyS")) moveDirection.z += 1;
        if (keys.has("KeyA")) moveDirection.x -= 1;
        if (keys.has("KeyD")) moveDirection.x += 1;
        moving = moveDirection.lengthSq() > 0;
        if (moving) {
          moveDirection.normalize().applyAxisAngle(THREE.Object3D.DEFAULT_UP, yaw);
          camera.position.addScaledVector(moveDirection, (keys.has("ShiftLeft") ? 7.4 : 5.1) * dt);
          camera.position.x = THREE.MathUtils.clamp(camera.position.x, -8.6, 8.6);
          camera.position.z = THREE.MathUtils.clamp(camera.position.z, -26, 8);
        }
      }
      const sprinting = moving && keys.has("ShiftLeft");
      const gait = now * (sprinting ? 0.0125 : 0.0092);
      const bodyBob = moving ? Math.abs(Math.sin(gait)) * (sprinting ? 0.075 : 0.052) : Math.sin(now * 0.0015) * 0.007;
      const bodyRoll = moving ? Math.sin(gait * 0.5) * (sprinting ? 0.022 : 0.013) : Math.sin(now * 0.0012) * 0.0025;
      lookKickX = THREE.MathUtils.lerp(lookKickX, 0, Math.min(1, dt * 8));
      lookKickY = THREE.MathUtils.lerp(lookKickY, 0, Math.min(1, dt * 8));
      camera.position.y = 1.62 + bodyBob;
      shake = THREE.MathUtils.lerp(shake, 0, Math.min(1, dt * 7));
      camera.rotation.set(
        pitch + lookKickY * 0.2 + Math.sin(now * 0.09) * shake * 0.03,
        yaw + Math.sin(now * 0.071) * shake * 0.024,
        bodyRoll - lookKickX * 0.34 + Math.sin(now * 0.113) * shake * 0.05,
      );

      // Wave mode restages the room: lamps fail, the sun turns blood red, alarms sweep.
      horde.update(now, dt, camera.position, yaw);
      const dreadful = horde.mood();
      if (dreadful > 0.002 || moodApplied > 0) {
        moodApplied = dreadful > 0.002 ? dreadful : 0;
        const m = moodApplied, fog = scene.fog as THREE.FogExp2;
        fog.color.copy(calm.fog).lerp(dread.fog, m);
        fog.density = calm.fogDensity * (1 + m * 1.5);
        scene.environmentIntensity = THREE.MathUtils.lerp(1.2, 0.3, m);
        scene.backgroundIntensity = THREE.MathUtils.lerp(1, 0.1, m);
        viewModelScene.environmentIntensity = THREE.MathUtils.lerp(1.15, 0.5, m);
        range.sun.color.copy(calm.sun).lerp(dread.sun, m);
        range.sun.intensity = THREE.MathUtils.lerp(calm.sunIntensity, 2.2, m);
        volumetricPass.haze.copy(calm.haze).lerp(dread.haze, m);
        volumetricPass.density = THREE.MathUtils.lerp(calm.density, 0.026, m);
        const flicker = Math.sin(now * 0.021) * Math.sin(now * 0.0047) > 0.72 ? 0.2 : 1;
        range.fills.forEach((light, index) => { light.intensity = calm.fills[index] * THREE.MathUtils.lerp(1, 0.2 * flicker, m); });
        bloomPass.strength = THREE.MathUtils.lerp(0.26, 0.42, m);
      }

      // Weapon switch: lower the old weapon, swap, raise the new one.
      let lowered = 0;
      if (switchingTo >= 0) {
        const elapsed = now - switchStartedAt;
        if (elapsed >= SWITCH_DOWN && switchingTo !== current) {
          arsenal.rigs[current].root.visible = false;
          previous = current;
          current = switchingTo;
          arsenal.rigs[current].root.visible = true;
          reportWeapon();
        }
        lowered = elapsed < SWITCH_DOWN ? smooth01(elapsed / SWITCH_DOWN) : 1 - smooth01(Math.min(1, (elapsed - SWITCH_DOWN) / SWITCH_UP));
        if (elapsed >= SWITCH_DOWN + SWITCH_UP) { switchingTo = -1; lowered = 0; }
      }
      const rig = arsenal.rigs[current], spec = rig.spec;
      let timeline: Timeline | null = null;
      let progress = 0;
      if (reloading) {
        progress = frozenReload ?? THREE.MathUtils.clamp((now - reloadStartedAt) / spec.reloadMs, 0, 1);
        timeline = rig.reload;
        const sounds = timeline.sounds ?? [];
        while (reloadCursor < sounds.length && sounds[reloadCursor].t <= progress) { playAction(sounds[reloadCursor].kind); reloadCursor += 1; }
        if (progress >= 1) {
          magazines[current] = spec.magazine;
          reloading = false;
          timeline = null;
          reportWeapon();
        }
      } else if (cycleStartedAt >= 0 && rig.cycle) {
        progress = frozenReload ?? (now - cycleStartedAt) / spec.cycleMs;
        if (progress >= 1) cycleStartedAt = -1;
        else {
          timeline = rig.cycle;
          const sounds = timeline.sounds ?? [];
          while (cycleCursor < sounds.length && sounds[cycleCursor].t <= progress) { playAction(sounds[cycleCursor].kind); cycleCursor += 1; }
          if (!cycleEjected && progress >= (timeline.eject ?? 2)) {
            cycleEjected = true;
            ballistics.eject(now, camera.localToWorld(new THREE.Vector3(0.36, -0.2, -0.75)), new THREE.Vector3(1.2 + Math.random() * 0.6, 1.9 + Math.random() * 0.5, 0.5).applyQuaternion(camera.quaternion));
          }
        }
      }
      if (autoReloadAt >= 0 && now >= autoReloadAt) startReload();
      const armed = enteredRef.current && !reloading && switchingTo < 0 && (forceFire || document.pointerLockElement === renderer.domElement);
      if (armed && takeShot(spec, modes[current], trigger, now)) {
        if (magazines[current] > 0) fireShot(now);
        else { playAction("dry"); resetTrigger(trigger); startReload(); }
      }
      const climbBack = climbDebt * Math.min(1, dt * 5);
      climbDebt -= climbBack;
      pitch -= climbBack;

      recoil = THREE.MathUtils.lerp(recoil, 0, Math.min(1, dt * 14));
      muzzleEnergy = THREE.MathUtils.lerp(muzzleEnergy, 0, Math.min(1, dt * 25));
      // Aim down the sights while Space is held; an optic takes over the whole view once it is up.
      const aiming = enteredRef.current && (forceScope || (keys.has("Space") && document.pointerLockElement === renderer.domElement)) && !reloading && switchingTo < 0 && cycleStartedAt < 0;
      aim += ((aiming ? 1 : 0) - aim) * Math.min(1, dt * 13);
      if (Math.abs(aim - (aiming ? 1 : 0)) < 0.003) aim = aiming ? 1 : 0;
      const sighted = smooth01(aim), magnification = THREE.MathUtils.lerp(1, spec.zoom, sighted);
      const fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(BASE_FOV / 2)) / magnification));
      if (Math.abs(camera.fov - fov) > 0.005) { camera.fov = fov; camera.updateProjectionMatrix(); }
      lookScale = 1 / magnification;
      const through = spec.scope && aim > 0.82;
      if (scopeRef.current) scopeRef.current.style.opacity = spec.scope ? String(THREE.MathUtils.clamp((aim - 0.6) / 0.3, 0, 1)) : "0";
      if (through !== throughScope) { throughScope = through; document.documentElement.toggleAttribute("data-scoped", through); }
      viewWeapon.visible = enteredRef.current && !through;
      muzzleFlash.visible = enteredRef.current && muzzleEnergy > 0.12;
      muzzleFlash.scale.setScalar(0.76 + muzzleEnergy * (0.9 + Math.sin(now * 0.071) * 0.14));
      muzzleFlash.rotation.z = Math.sin(now * 0.053) * 0.22;
      muzzle.intensity = muzzleEnergy * 48;
      roomMuzzleLight.intensity = muzzleEnergy * 72;
      const walkBob = moving ? Math.sin(now * 0.011) * 0.018 : Math.sin(now * 0.0022) * 0.004;
      const lateralBob = moving ? Math.cos(now * 0.0055) * 0.012 : Math.sin(now * 0.0017) * 0.003;
      let contact = contacts.get(rig);
      if (!contact && rig.ready && arms.ready()) {
        // Once per weapon: build what the hands collide with, and seat the resting grips on it.
        rig.pose(null, 0, rigPose);
        contact = buildContact(rig.root, arms.hands, rig.movers());
        contacts.set(rig, contact);
        const built = contact;
        rig.fit((pose, left) => arms.fit(pose, left, built));
      }
      rig.pose(timeline, progress, rigPose);
      weaponBody.position.copy(rigPose.bodyPosition);
      weaponBody.rotation.copy(rigPose.bodyRotation);
      arms.left.apply(rigPose.left);
      arms.right.apply(rigPose.right);
      muzzleAnchor.position.copy(rig.muzzle.position);
      viewWeapon.position.set(
        (shoulder.x + rig.view.p[0] * VIEW_SCALE) * (1 - 0.82 * sighted) + (lateralBob - lookKickX * 0.9) * (1 - 0.6 * sighted),
        shoulder.y + rig.view.p[1] * VIEW_SCALE + 0.1 * sighted + walkBob * (1 - 0.6 * sighted) + recoil * 0.35 + lookKickY * 0.7 - lowered * 0.75,
        shoulder.z + rig.view.p[2] * VIEW_SCALE + recoil * 0.9,
      );
      viewWeapon.rotation.set(
        weaponRotation.x + rig.view.r[0] + recoil * 0.55 + lookKickY * 0.45 - lowered * 0.7,
        weaponRotation.y + rig.view.r[1] + lookKickX * 0.55 + lowered * 0.25,
        weaponRotation.z + rig.view.r[2] - lookKickX * 0.4,
      );
      contact?.update();
      arms.update(contact);

      exhibitGroups.forEach((group, index) => {
        const market = markets[index];
        const count = votesRef.current[market.id] ?? { YES: 0, NO: 0 };
        const majority = count.YES === count.NO ? "TIE" : count.YES > count.NO ? "YES" : "NO";
        if (majority !== stationMajorities[index]) {
          stationMajorities[index] = majority;
          const color = marketLightColor(market, count);
          stationLights[index].color.setHex(color);
          stationRingMaterials[index].color.setHex(color).multiplyScalar(3.2);
        }
        // The targets carry the contracts staged on them, and the station flares when one is added.
        for (let sideIndex = 0; sideIndex < 2; sideIndex += 1) {
          const target = voteMeshes[index * 2 + sideIndex], staged = count[sideIndex === 0 ? "YES" : "NO"];
          if (target.userData.staged === staged) continue;
          target.userData.staged = staged;
          const texture = voteTextures[index * 2 + sideIndex];
          paintOutcome(texture.image as HTMLCanvasElement, target.userData.voteSide as VoteSide, staged, Number(target.userData.cents));
          texture.needsUpdate = true;
        }
        const flare = Math.max(0, 1 - (now - (stationLights[index].userData.hitAt ?? -1e6)) / 420);
        stationLights[index].intensity = 7 * (1 + flare * flare * 2.6);
        const targeted = index === lastTargeted;
        screenMaterials[index].emissiveIntensity = targeted ? 1.1 : 1;
        group.scale.setScalar(THREE.MathUtils.lerp(group.scale.x, targeted ? 1.03 : 1, 0.1));
      });

      targetMeshes.forEach((target) => {
        const elapsed = now - (target.userData.hitAt ?? -1000);
        const punch = elapsed < 180 ? Math.sin((elapsed / 180) * Math.PI) * 0.18 : 0;
        target.position.z = -punch;
        const material = target.material as THREE.MeshStandardMaterial;
        material.emissiveIntensity = elapsed < 130 ? 5 : 0.7;
      });

      voteMeshes.forEach((target) => {
        const elapsed = now - (target.userData.hitAt ?? -1000);
        // Struck: the panel flares white-hot, is driven back and springs out again.
        const flare = elapsed < 520 ? (1 - elapsed / 520) ** 2 : 0;
        const spring = elapsed < 520 ? Math.exp(-elapsed / 110) * Math.cos(elapsed / 38) : 0;
        (target.material as THREE.MeshStandardMaterial).emissiveIntensity = 1 + flare * 2.4;
        target.scale.setScalar(1 + flare * 0.07 - spring * 0.05);
        target.position.z = 0.52 - spring * 0.07;
      });

      range.update(now);
      ballistics.update(now, dt);
      strikeFx.update(now, dt);
      bodycamPass.uniforms.time.value = now;
      camera.updateMatrixWorld(true);
      // Viewmodel space is camera space, so world lighting is rotated into it each frame.
      inverseView.copy(camera.quaternion).invert();
      viewModelScene.environmentRotation.setFromQuaternion(inverseView);
      overhead.set(-0.35, 1, 0.3).normalize().applyQuaternion(inverseView);
      weaponKey.position.copy(weaponKey.target.position).addScaledVector(overhead, 4);
      sunward.copy(range.sun.position).sub(range.sun.target.position).normalize().applyQuaternion(inverseView);
      weaponSun.position.copy(weaponSun.target.position).addScaledVector(sunward, 4);
      weaponSunAmount = THREE.MathUtils.lerp(weaponSunAmount, range.sunlitAt(camera.position), Math.min(1, dt * 7));
      weaponSun.intensity = weaponSunAmount * range.sun.intensity * 0.8;
      raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
      const aimed = raycaster.intersectObjects(interactiveMeshes, false).find((hit) => hit.distance <= 22);
      let targeted = aimed ? Number(aimed.object.userData.marketIndex) : -1;
      if (targeted < 0) {
        let distance = 5.5;
        marketPositions.forEach((position, index) => {
          const nextDistance = camera.position.distanceTo(position);
          if (nextDistance < distance) {
            targeted = index;
            distance = nextDistance;
          }
        });
      }
      if (targeted !== lastTargeted) {
        lastTargeted = targeted;
        proximityRef.current(targeted >= 0 ? markets[targeted] : null);
      }
      const nextFurnaceTargeted = raycaster.intersectObjects(furnaceMeshes, false).some((hit) => hit.distance <= 9);
      const nextChartTargeted = raycaster.intersectObject(chartScreen, false).some(hit => hit.distance <= 22);
      if (nextChartTargeted !== chartTargeted) {
        chartTargeted = nextChartTargeted;
        chartProximityRef.current(chartTargeted);
      }
      if (nextFurnaceTargeted !== furnaceTargeted) {
        furnaceTargeted = nextFurnaceTargeted;
        furnaceProximityRef.current(furnaceTargeted);
      }

      range.reflection.render(scene, camera, range.mirrorHidden);
      renderer.clear();
      composer.render(dt);
    };
    if (import.meta.env.DEV) {
      // Dev-only camera hook for automated visual checks (pointer lock is unavailable headless).
      (window as unknown as Record<string, unknown>).__hsRange = {
        view: (x: number, z: number, nextYaw: number, nextPitch = 0) => { camera.position.x = x; camera.position.z = z; yaw = nextYaw; pitch = nextPitch; },
        flash: (energy = 1) => { muzzleEnergy = energy; },
        shoot: () => { if (magazines[current] > 0) fireShot(performance.now()); },
        hold: (down: boolean) => { forceFire = down; if (down) pressTrigger(trigger); else releaseTrigger(trigger); },
        weapon: (index: number) => switchWeapon(index),
        mode: () => cycleMode(),
        arsenal, arms, weaponBody, viewWeapon, contacts,
        freeze: (at: number | null) => { frozenReload = at; },
        scope: (on: boolean) => { forceScope = on; },
        horde, toggleHorde,
        reload: () => startReload(),
        scene, viewModelScene, camera, renderer, range, composer,
      };
    }
    const startRendering = () => {
      if (disposed || frame) return;
      // Light the room by itself: capture the lit scene, then again so the second
      // capture includes one bounce of the first.
      range.update(performance.now());
      renderer.shadowMap.needsUpdate = true;
      for (let bounce = 0; bounce < 2; bounce += 1) {
        const captured = range.captureProbe(pmrem);
        roomProbe?.dispose();
        roomProbe = captured;
        scene.environment = captured.texture;
        scene.environmentIntensity = 1.2;
      }
      viewModelScene.environment = roomProbe!.texture;
      viewModelScene.environmentIntensity = 1.15;
      pmrem.dispose();
      renderer.shadowMap.needsUpdate = true;
      frame = requestAnimationFrame(animate);
      readyRef.current();
    };
    loadingManager.onLoad = startRendering;
    loadingManager.itemEnd("hyperstrike-world-bootstrap");

    const onResize = () => {
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      viewModelCamera.aspect = mount.clientWidth / mount.clientHeight;
      viewModelCamera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
      composer.setSize(mount.clientWidth, mount.clientHeight);
      range.reflection.setSize(mount.clientWidth * adaptivePixelRatio * 0.6, mount.clientHeight * adaptivePixelRatio * 0.6);
      fxaaPass.uniforms.resolution.value.set(
        1 / (mount.clientWidth * adaptivePixelRatio),
        1 / (mount.clientHeight * adaptivePixelRatio),
      );
    };
    window.addEventListener("resize", onResize);

    return () => {
      disposed = true;
      unsubscribeChart();
      lcdRefreshRef.current = null;
      cancelAnimationFrame(frame);
      loadingManager.onLoad = () => {};
      window.removeEventListener("resize", onResize);
      renderer.domElement.removeEventListener("click", requestLock);
      renderer.domElement.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("pointerlockchange", onPointerLockChange);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("wheel", onWheel);
      document.documentElement.removeAttribute("data-scoped");
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
      furnaceProximityRef.current(false);
      void audioContext?.close();
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((material) => material.dispose());
        }
      });
      viewModelScene.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((material) => material.dispose());
        }
      });
      brandTexture.dispose();
      skinTextures.forEach((texture) => texture.dispose());
      voteTextures.forEach((texture) => texture.dispose());
      environmentTextures.forEach((texture) => texture.dispose());
      roomProbe?.dispose();
      skyMap?.dispose();
      range.dispose();
      ballistics.dispose();
      strikeFx.dispose();
      arsenal.dispose();
      arms.dispose();
      horde.dispose();
      pmrem.dispose();
      lcdMaterials.forEach(material => material.emissiveMap?.dispose());
      composer.passes.forEach(pass => pass.dispose());
      composer.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
    };
  }, [markets, quality]);

  return (
    <>
      <div className="world-canvas" ref={mountRef} aria-label="HyperStrike first-person ballistic price range" />
      <div className="scope-view" ref={scopeRef} aria-hidden="true"><div><i /><i /><i /><i /><b /></div></div>
      {entered && <RangeHud weapon={weaponHud} horde={hordeHud} strike={strike && markets[strike.market] ? { ...strike, market: markets[strike.market], count: votes[markets[strike.market].id] ?? { YES: 0, NO: 0 } } : null} />}
    </>
  );
}
