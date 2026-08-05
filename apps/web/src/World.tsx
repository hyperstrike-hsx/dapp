import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import type { PortfolioDisplayEntry, SkinMarket, VoteCount, VoteSide } from "./types";

type Props = {
  markets: SkinMarket[];
  onSelect: (market: SkinMarket) => void;
  onProximity: (market: SkinMarket | null) => void;
  entered: boolean;
  onEntered: () => void;
  onLockChange: (locked: boolean) => void;
  onAmmoChange: (magazine: number, reserve: number, reloading: boolean) => void;
  onVote: (market: SkinMarket, side: VoteSide) => void;
  votes: Record<string, VoteCount>;
  portfolio: PortfolioDisplayEntry[];
  onFurnace: () => void;
  onFurnaceProximity: (nearby: boolean) => void;
  onReady: () => void;
};

type TimedEffect = {
  object: THREE.Object3D;
  expires: number;
  velocity?: THREE.Vector3;
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
    distortion: { value: 0.105 },
    aberration: { value: 0.0018 },
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
      vec2 uv = (p * (1.0 + distortion * r2)) * 0.5 + 0.5;
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
        gl_FragColor = vec4(0.006, 0.009, 0.012, 1.0);
        return;
      }
      vec2 split = normalize(p + vec2(0.0001)) * aberration * (0.3 + r2);
      float red = texture2D(tDiffuse, uv + split).r;
      float green = texture2D(tDiffuse, uv).g;
      float blue = texture2D(tDiffuse, uv - split).b;
      vec3 color = vec3(red, green, blue);
      float grain = hash(vUv * vec2(1919.0, 1079.0)) - 0.5;
      color += grain * 0.018;
      color *= 1.0 - smoothstep(0.5, 1.48, r2) * 0.42;
      gl_FragColor = vec4(color, 1.0);
    }
  `,
};

function marketLightColor(market: SkinMarket, count?: VoteCount) {
  if (!count || count.YES === count.NO) return market.accent;
  return count.YES > count.NO ? YES_LIGHT : NO_LIGHT;
}

function labelTexture(market: SkinMarket) {
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
  ctx.letterSpacing = "6px";
  ctx.fillText("HIP-4 · BALLISTIC PRICE CALL", 54, 110);
  ctx.fillStyle = "#effffc";
  ctx.font = "900 58px Arial";
  ctx.letterSpacing = "-2px";
  ctx.fillText(market.name.toUpperCase(), 54, 190, 840);
  ctx.fillStyle = "#7aa5a9";
  ctx.font = "700 20px monospace";
  ctx.letterSpacing = "3px";
  ctx.fillText(market.condition, 55, 232);
  ctx.strokeStyle = "#295057";
  ctx.beginPath();
  ctx.moveTo(54, 275);
  ctx.lineTo(955, 275);
  ctx.stroke();
  ctx.fillStyle = "#8ab1b5";
  ctx.font = "700 17px monospace";
  ctx.fillText("YES", 55, 345);
  ctx.fillStyle = "#74f0bd";
  ctx.font = "900 76px Arial";
  ctx.fillText(`${market.yes}¢`, 52, 430);
  ctx.fillStyle = "#658f94";
  ctx.font = "700 17px monospace";
  ctx.fillText("REFERENCE", 420, 345);
  ctx.fillStyle = accent;
  ctx.font = "800 40px monospace";
  ctx.fillText(market.currentPrice, 418, 408);
  ctx.fillStyle = "#658f94";
  ctx.font = "700 17px monospace";
  ctx.fillText("VOLUME", 735, 345);
  ctx.fillStyle = "#e2f4f2";
  ctx.font = "800 34px monospace";
  ctx.fillText(market.volume, 732, 408);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
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
  ctx.fillText("THE BALLISTIC PREDICTION MARKET FOR CS2 SKINS", 768, 274);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function outcomeTexture(side: VoteSide) {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 192;
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
  ctx.fillStyle = accent;
  ctx.font = "900 78px Arial";
  ctx.fillText(side, 28, 112);
  ctx.fillStyle = "#b6cecf";
  ctx.font = "700 19px monospace";
  ctx.letterSpacing = "4px";
  ctx.fillText("SHOOT · +1 VOTE", 29, 153);
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
  ctx.fillStyle = "#79a7a9";
  ctx.font = "700 25px monospace";
  ctx.letterSpacing = "7px";
  ctx.fillText(subtitle, 55, 180);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function skyTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createLinearGradient(0, 0, 0, 256);
  gradient.addColorStop(0, "#167ec8");
  gradient.addColorStop(.48, "#58b9ed");
  gradient.addColorStop(1, "#b9e9ff");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 512, 256);
  const glow = ctx.createRadialGradient(370, 44, 4, 370, 44, 125);
  glow.addColorStop(0, "rgba(255,248,218,.82)");
  glow.addColorStop(.22, "rgba(255,234,183,.28)");
  glow.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, 512, 256);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function sunTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(128, 128, 3, 128, 128, 126);
  gradient.addColorStop(0, "rgba(255,255,244,1)");
  gradient.addColorStop(.08, "rgba(255,235,180,.98)");
  gradient.addColorStop(.28, "rgba(255,191,95,.45)");
  gradient.addColorStop(1, "rgba(255,153,55,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 256, 256);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function puddleGeometry(seed: number) {
  const shape = new THREE.Shape();
  const points = 28;
  for (let index = 0; index < points; index += 1) {
    const angle = (index / points) * Math.PI * 2;
    const radius = 0.84 + Math.sin(index * 2.17 + seed) * 0.09 + Math.cos(index * 4.31 + seed * 0.7) * 0.055;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    if (index === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  return new THREE.ShapeGeometry(shape, 4);
}

function bakedGridTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 1024;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(2, 2);
  ctx.fillStyle = "#505c5b";
  ctx.fillRect(0, 0, 512, 512);
  let seed = 4187;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < 5200; i += 1) {
    const shade = Math.floor(48 + random() * 74);
    ctx.fillStyle = `rgba(${shade},${shade + 8},${shade + 7},${0.05 + random() * 0.12})`;
    const size = 0.5 + random() * 2.8;
    ctx.fillRect(random() * 512, random() * 512, size, size);
  }
  ctx.strokeStyle = "rgba(27,38,38,.42)";
  ctx.lineWidth = 3;
  for (let i = 0; i <= 512; i += 128) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 512); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(512, i); ctx.stroke();
  }
  ctx.strokeStyle = "rgba(217,226,219,.13)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 512; i += 32) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 512); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(512, i); ctx.stroke();
  }
  ctx.save();
  ctx.translate(256, 256);
  ctx.rotate(-0.18);
  ctx.fillStyle = "rgba(232,154,66,.68)";
  ctx.fillRect(-18, -390, 36, 780);
  ctx.fillStyle = "rgba(142,245,227,.58)";
  ctx.fillRect(55, -390, 6, 780);
  ctx.restore();
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(5, 8);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function industrialTexture(kind: "concrete" | "metal" | "wood") {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 1024;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(2, 2);
  const palette = kind === "concrete"
    ? { base: "#66706d", dark: "#263332", light: "#a5aca4" }
    : kind === "metal"
      ? { base: "#26383c", dark: "#0d171a", light: "#648084" }
      : { base: "#79563a", dark: "#2f2119", light: "#b3865d" };
  ctx.fillStyle = palette.base;
  ctx.fillRect(0, 0, 512, 512);
  let seed = kind === "concrete" ? 90210 : kind === "metal" ? 1138 : 2049;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < 3600; i += 1) {
    ctx.globalAlpha = 0.025 + random() * 0.11;
    ctx.fillStyle = random() > 0.45 ? palette.light : palette.dark;
    const length = kind === "metal" ? 6 + random() * 38 : 1 + random() * 8;
    ctx.fillRect(random() * 512, random() * 512, length, 0.5 + random() * 2.2);
  }
  ctx.globalAlpha = 1;
  if (kind === "concrete") {
    ctx.strokeStyle = "rgba(24,34,33,.42)";
    ctx.lineWidth = 2;
    for (let i = 0; i < 13; i += 1) {
      const x = random() * 512;
      const y = random() * 512;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + random() * 42 - 21, y + 18 + random() * 44);
      ctx.lineTo(x + random() * 58 - 29, y + 50 + random() * 50);
      ctx.stroke();
    }
  } else if (kind === "metal") {
    ctx.strokeStyle = "rgba(155,184,185,.24)";
    ctx.lineWidth = 2;
    for (let y = 0; y <= 512; y += 64) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(512, y); ctx.stroke();
    }
    for (let x = 24; x <= 512; x += 96) {
      ctx.fillStyle = "rgba(8,14,16,.68)";
      ctx.beginPath(); ctx.arc(x, 24, 4, 0, Math.PI * 2); ctx.fill();
    }
  } else {
    ctx.strokeStyle = "rgba(38,23,15,.68)";
    ctx.lineWidth = 5;
    for (let x = 0; x <= 512; x += 128) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 512); ctx.stroke();
    }
    ctx.strokeStyle = "rgba(222,170,112,.18)";
    ctx.lineWidth = 2;
    for (let x = 18; x <= 512; x += 32) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + 9, 512); ctx.stroke();
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function rangeDecalTexture(label: string, detail: string, orange = false) {
  const canvas = document.createElement("canvas");
  canvas.width = 768;
  canvas.height = 384;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, 768, 384);
  ctx.globalAlpha = 0.88;
  ctx.fillStyle = orange ? "#e89a42" : "#8ef5e3";
  ctx.font = "italic 900 210px Arial";
  ctx.fillText(label, 24, 230);
  ctx.globalAlpha = 0.7;
  ctx.font = "800 30px monospace";
  ctx.letterSpacing = "7px";
  ctx.fillText(detail, 34, 308);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function smooth01(value: number) {
  const clamped = THREE.MathUtils.clamp(value, 0, 1);
  return clamped * clamped * (3 - 2 * clamped);
}

function box(size: [number, number, number], color: number, metalness = 0.7, roughness = 0.3) {
  return new THREE.Mesh(
    new THREE.BoxGeometry(...size),
    new THREE.MeshStandardMaterial({ color, metalness, roughness }),
  );
}

function disposeEffect(effect: TimedEffect) {
  effect.object.traverse((object) => {
    if (!(object instanceof THREE.Mesh || object instanceof THREE.Line)) return;
    object.geometry.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.forEach((material) => material.dispose());
  });
  effect.object.removeFromParent();
}

export function World({ markets, onSelect, onProximity, entered, onEntered, onLockChange, onAmmoChange, onVote, votes, portfolio, onFurnace, onFurnaceProximity, onReady }: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
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
  const readyRef = useRef(onReady);

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
  useEffect(() => { readyRef.current = onReady; }, [onReady]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let disposed = false;

    const loadingManager = new THREE.LoadingManager();
    loadingManager.itemStart("hyperstrike-world-bootstrap");

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x010204);
    scene.fog = new THREE.FogExp2(0x04080d, 0.021);

    const camera = new THREE.PerspectiveCamera(76, mount.clientWidth / mount.clientHeight, 0.08, 110);
    camera.position.set(0, 1.62, 7.2);
    camera.rotation.order = "YXZ";
    const viewModelScene = new THREE.Scene();
    const viewModelCamera = new THREE.PerspectiveCamera(54, mount.clientWidth / mount.clientHeight, 0.01, 12);
    viewModelCamera.position.set(0, 0, 0);
    viewModelScene.add(viewModelCamera);
    viewModelScene.add(new THREE.HemisphereLight(0xe8f5f0, 0x15252a, 2.2));

    const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance", stencil: false });
    const initialPixelRatio = Math.min(window.devicePixelRatio, 1.5);
    renderer.setPixelRatio(initialPixelRatio);
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.68;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.autoClear = false;
    renderer.debug.checkShaderErrors = false;
    mount.appendChild(renderer.domElement);

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    composer.setPixelRatio(initialPixelRatio);
    const bloomPass = new UnrealBloomPass(new THREE.Vector2(mount.clientWidth, mount.clientHeight), 0.28, 0.22, 0.9);
    composer.addPass(bloomPass);
    const bodycamPass = new ShaderPass(BODYCAM_SHADER);
    composer.addPass(bodycamPass);
    composer.addPass(new OutputPass());

    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    let environmentMap: THREE.Texture | null = null;
    new HDRLoader(loadingManager).load("/environment/bonzai-sky.hdr", (hdr) => {
      if (disposed) { hdr.dispose(); return; }
      environmentMap = pmrem.fromEquirectangular(hdr).texture;
      scene.environment = environmentMap;
      scene.environmentIntensity = 0.54;
      viewModelScene.environment = environmentMap;
      viewModelScene.environmentIntensity = 1.25;
      hdr.dispose();
      pmrem.dispose();
    });

    scene.add(new THREE.AmbientLight(0x172b34, 0.1));
    scene.add(new THREE.HemisphereLight(0x467b87, 0x010203, 0.32));
    const key = new THREE.DirectionalLight(0x87b8c8, 0.84);
    key.position.set(-9, 12, 8);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -18;
    key.shadow.camera.right = 18;
    key.shadow.camera.top = 16;
    key.shadow.camera.bottom = -16;
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 58;
    key.shadow.bias = -0.00035;
    scene.add(key);
    const coolFill = new THREE.DirectionalLight(0x13e5ff, 0.36);
    coolFill.position.set(12, 6, 5);
    scene.add(coolFill);
    const rim = new THREE.DirectionalLight(0xe8fffb, 0.24);
    rim.position.set(0, 7, -24);
    scene.add(rim);
    const orangeBounce = new THREE.PointLight(0xff7a22, 18, 15, 2);
    orangeBounce.position.set(-7, 2.4, -10);
    scene.add(orangeBounce);
    const cyberCyan = new THREE.SpotLight(0x13e5ff, 48, 30, 0.38, 0.68, 1.4);
    cyberCyan.position.set(-8, 5.6, 5);
    cyberCyan.target.position.set(1, 1.2, -18);
    const cyberOrange = new THREE.SpotLight(0xff6a1a, 44, 30, 0.4, 0.68, 1.4);
    cyberOrange.position.set(8, 5.4, -4);
    cyberOrange.target.position.set(-1, 1.1, -23);
    scene.add(cyberCyan, cyberCyan.target, cyberOrange, cyberOrange.target);

    const emergencyMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff2c50).multiplyScalar(4.8), toneMapped: false });
    for (const z of [3.5, -8.5, -20.5]) {
      const fixture = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.12, 0.15), emergencyMaterial);
      fixture.position.set(-9.54, 3.25, z);
      scene.add(fixture);
      const emergency = new THREE.PointLight(0xff174d, 18, 8, 2);
      emergency.position.set(-8.9, 3.1, z);
      scene.add(emergency);
    }

    const shootableObjects: THREE.Object3D[] = [];
    const furnaceMeshes: THREE.Mesh[] = [];
    const environmentTextures: THREE.Texture[] = [];
    const textureLoader = new THREE.TextureLoader(loadingManager);
    const concreteRoot = "/textures/concrete-floor-worn-001";
    const floorDiffuse = textureLoader.load(`${concreteRoot}/diffuse.jpg`);
    const floorNormal = textureLoader.load(`${concreteRoot}/normal-gl.jpg`);
    const floorRoughness = textureLoader.load(`${concreteRoot}/roughness.jpg`);
    const floorAo = textureLoader.load(`${concreteRoot}/ao.jpg`);
    floorDiffuse.colorSpace = THREE.SRGBColorSpace;
    const floorTextures = [floorDiffuse, floorNormal, floorRoughness, floorAo];
    floorTextures.forEach((texture) => {
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.repeat.set(7, 10);
      texture.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
    });
    const wallDiffuse = floorDiffuse.clone();
    const wallNormal = floorNormal.clone();
    const wallRoughness = floorRoughness.clone();
    const wallTextures = [wallDiffuse, wallNormal, wallRoughness];
    wallTextures.forEach((texture) => {
      texture.repeat.set(2, 6);
      texture.needsUpdate = true;
    });
    const metalTexture = industrialTexture("metal");
    const woodTexture = industrialTexture("wood");
    const weaponMetalTexture = industrialTexture("metal");
    const weaponWoodTexture = industrialTexture("wood");
    metalTexture.repeat.set(2, 8);
    woodTexture.repeat.set(2, 2);
    weaponMetalTexture.repeat.set(1, 1);
    weaponWoodTexture.repeat.set(1, 1);
    environmentTextures.push(...floorTextures, ...wallTextures, metalTexture, woodTexture, weaponMetalTexture, weaponWoodTexture);
    [metalTexture, woodTexture, weaponMetalTexture, weaponWoodTexture].forEach((texture) => {
      texture.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
    });
    const floorGeometry = new THREE.PlaneGeometry(38, 52);
    floorGeometry.setAttribute("uv1", floorGeometry.attributes.uv.clone());
    const floor = new THREE.Mesh(floorGeometry, new THREE.MeshStandardMaterial({
      map: floorDiffuse,
      normalMap: floorNormal,
      normalScale: new THREE.Vector2(1.35, 1.35),
      roughnessMap: floorRoughness,
      aoMap: floorAo,
      aoMapIntensity: 0.78,
      color: 0xb8c0ba,
      roughness: 0.92,
      metalness: 0.02,
      envMapIntensity: 0.42,
    }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.z = -8;
    floor.receiveShadow = true;
    scene.add(floor);
    shootableObjects.push(floor);

    const puddleSpecs = [
      { x: -4.9, z: 2.4, sx: 2.15, sz: 0.72, rotation: -0.16 },
      { x: 4.6, z: -12.6, sx: 1.7, sz: 0.58, rotation: 0.28 },
    ];
    puddleSpecs.forEach((spec, index) => {
      const geometry = puddleGeometry(index + 2);
      const wetEdge = new THREE.Mesh(
        geometry.clone(),
        new THREE.MeshPhysicalMaterial({ color: 0x233f41, roughness: 0.14, metalness: 0.03, transparent: true, opacity: 0.3, depthWrite: false }),
      );
      wetEdge.rotation.x = -Math.PI / 2;
      wetEdge.rotation.z = spec.rotation;
      wetEdge.position.set(spec.x, 0.029, spec.z);
      wetEdge.scale.set(spec.sx * 1.06, spec.sz * 1.12, 1);
      scene.add(wetEdge);
      const puddle = new THREE.Mesh(geometry, new THREE.MeshPhysicalMaterial({
        color: 0x577e8d,
        roughness: 0.08,
        metalness: 0.12,
        clearcoat: 1,
        clearcoatRoughness: 0.04,
        envMapIntensity: 2.2,
        transparent: true,
        opacity: 0.82,
      }));
      puddle.rotation.x = -Math.PI / 2;
      puddle.rotation.z = spec.rotation;
      puddle.position.set(spec.x, 0.032, spec.z);
      puddle.scale.set(spec.sx, spec.sz, 1);
      scene.add(puddle);
    });

    for (const x of [-8.6, 8.6]) {
      const color = x < 0 ? STRIKE_ORANGE : BRAND;
      const stripeMat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.55, metalness: 0.22, roughness: 0.48 });
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.018, 40), stripeMat);
      stripe.position.set(x, 0.025, -8);
      scene.add(stripe);
    }
    const centerLane = new THREE.Mesh(
      new THREE.BoxGeometry(0.42, 0.016, 42),
      new THREE.MeshStandardMaterial({ color: STRIKE_ORANGE, roughness: 0.68, metalness: 0.03 }),
    );
    centerLane.position.set(0, 0.024, -9);
    scene.add(centerLane);

    const architecture = new THREE.MeshStandardMaterial({ map: metalTexture, color: 0xb6c3c1, roughness: 0.48, metalness: 0.62, envMapIntensity: 1.05 });
    const wallInset = new THREE.MeshStandardMaterial({ map: wallDiffuse, normalMap: wallNormal, normalScale: new THREE.Vector2(1.55, 1.55), roughnessMap: wallRoughness, color: 0xaeb6af, roughness: 0.92, metalness: 0.02 });
    for (const x of [-10, 10]) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(0.7, 8, 48), architecture);
      wall.position.set(x, 4, -9);
      wall.receiveShadow = true;
      scene.add(wall);
      shootableObjects.push(wall);
      const inset = new THREE.Mesh(new THREE.BoxGeometry(0.12, 4.2, 42), wallInset);
      inset.position.set(x * 0.96, 2.3, -9);
      scene.add(inset);
      shootableObjects.push(inset);
    }

    const instance = (
      size: [number, number, number],
      material: THREE.Material,
      transforms: Array<{ position: [number, number, number]; rotation?: [number, number, number]; scale?: [number, number, number] }>,
    ) => {
      const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(...size), material, transforms.length);
      const dummy = new THREE.Object3D();
      transforms.forEach((transform, index) => {
        dummy.position.set(...transform.position);
        dummy.rotation.set(...(transform.rotation ?? [0, 0, 0]));
        dummy.scale.set(...(transform.scale ?? [1, 1, 1]));
        dummy.updateMatrix();
        mesh.setMatrixAt(index, dummy.matrix);
      });
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      mesh.computeBoundingSphere();
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
      shootableObjects.push(mesh);
      return mesh;
    };

    const structural = new THREE.MeshStandardMaterial({ map: metalTexture, color: 0x8fa1a2, metalness: 0.72, roughness: 0.42, envMapIntensity: 1.1 });
    const concrete = new THREE.MeshStandardMaterial({ map: wallDiffuse, normalMap: wallNormal, normalScale: new THREE.Vector2(1.45, 1.45), roughnessMap: wallRoughness, color: 0xb8beb7, metalness: 0.02, roughness: 0.94 });
    const crateMaterial = new THREE.MeshStandardMaterial({ map: woodTexture, bumpMap: woodTexture, bumpScale: 0.025, color: 0xc49a6c, metalness: 0.04, roughness: 0.78 });
    const bayZ = [4, -2, -8, -14, -20, -26];
    instance([0.42, 5.3, 0.6], structural, bayZ.flatMap((z) => [-9.45, 9.45].map((x) => ({ position: [x, 2.65, z] as [number, number, number] }))));
    instance([2.2, 0.24, 5.3], concrete, bayZ.flatMap((z) => [-8.55, 8.55].map((x) => ({ position: [x, 3.78, z - 2.7] as [number, number, number] }))));
    instance([0.08, 0.08, 5.25], structural, bayZ.flatMap((z) => [-7.62, 7.62].map((x) => ({ position: [x, 4.55, z - 2.7] as [number, number, number] }))));
    instance(
      [0.08, 1.08, 0.08],
      structural,
      bayZ.flatMap((z) => [-7.62, 7.62].flatMap((x) =>
        [z - 5.1, z - 2.7, z - 0.3].map((railZ) => ({ position: [x, 4.05, railZ] as [number, number, number] })),
      )),
    );
    const wallStripeOrange = new THREE.MeshStandardMaterial({ color: STRIKE_ORANGE, emissive: 0x6c3210, emissiveIntensity: 0.35, roughness: 0.52 });
    const wallStripeMint = new THREE.MeshStandardMaterial({ color: BRAND, emissive: 0x245f58, emissiveIntensity: 0.45, roughness: 0.45 });
    instance([0.08, 0.18, 41], wallStripeOrange, [{ position: [-9.57, 0.72, -9] }]);
    instance([0.08, 0.18, 41], wallStripeMint, [{ position: [9.57, 0.72, -9] }]);

    const crateTransforms = [
      [-7.7, 0.55, 2.5], [-7.62, 0.55, 1.25], [-7.66, 1.66, 1.85],
      [7.7, 0.55, -2.1], [7.62, 0.55, -3.35], [7.66, 1.66, -2.75],
      [-7.7, 0.55, -14.8], [-7.62, 1.66, -14.8], [7.7, 0.55, -19.5], [7.62, 0.55, -20.75],
    ] as Array<[number, number, number]>;
    instance([1.08, 1.08, 1.08], crateMaterial, crateTransforms.map((position, index) => ({ position, rotation: [0, (index % 3 - 1) * 0.12, 0] as [number, number, number] })));

    const barrierTransforms = [
      [-6.5, 0.52, 5], [-8.35, 0.52, -10.5], [-6.5, 0.52, -18],
      [6.5, 0.52, 0], [6.5, 0.52, -11.5], [6.5, 0.52, -23],
    ] as Array<[number, number, number]>;
    instance([2.4, 1.04, 0.48], concrete, barrierTransforms.map((position, index) => ({ position, rotation: [0, index % 2 ? -0.08 : 0.08, 0] })));
    const hazardMaterial = new THREE.MeshStandardMaterial({ color: STRIKE_ORANGE, emissive: 0x6c3210, emissiveIntensity: 0.45, roughness: 0.5, metalness: 0.18 });
    instance([2.15, 0.14, 0.5], hazardMaterial, barrierTransforms.map((position) => ({ position: [position[0], 0.7, position[2] - 0.01] })));

    const doorMaterial = new THREE.MeshStandardMaterial({ map: metalTexture, color: 0x78898a, roughness: 0.5, metalness: 0.6 });
    instance([0.16, 2.8, 1.8], doorMaterial, [
      { position: [-9.56, 1.42, -4.6], rotation: [0, 0, 0] },
      { position: [9.56, 1.42, -15.6], rotation: [0, 0, 0] },
    ]);

    const decalSpecs = [
      { label: "A →", detail: "SKIN PRICE RANGE", x: -9.51, z: -9.2, rotation: Math.PI / 2, orange: true },
      // Center the label in the clear bay between the z=-20 and z=-26 columns.
      { label: "← B", detail: "HIP-4 OUTCOMES", x: 9.51, z: -23, rotation: -Math.PI / 2, orange: false },
    ];
    decalSpecs.forEach((decal) => {
      const texture = rangeDecalTexture(decal.label, decal.detail, decal.orange);
      environmentTextures.push(texture);
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(3.6, 1.8),
        new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false }),
      );
      mesh.position.set(decal.x, 2.3, decal.z);
      mesh.rotation.y = decal.rotation;
      scene.add(mesh);
    });

    const ductGeometry = new THREE.CylinderGeometry(0.23, 0.23, 39, 10);
    const ductMaterial = new THREE.MeshStandardMaterial({ color: 0x263c43, metalness: 0.92, roughness: 0.3, envMapIntensity: 1.3 });
    for (const x of [-7.2, 7.2]) {
      const duct = new THREE.Mesh(ductGeometry, ductMaterial);
      duct.rotation.x = Math.PI / 2;
      duct.position.set(x, 5.34, -10.5);
      scene.add(duct);
    }
    for (const x of [-5.2, 0, 5.2]) {
      const cable = new THREE.Mesh(
        new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
          new THREE.Vector3(x - 1.2, 5.8, 6),
          new THREE.Vector3(x, 5.2 - Math.abs(x) * 0.025, -4),
          new THREE.Vector3(x + 0.8, 5.55, -15),
          new THREE.Vector3(x - 0.4, 5.1, -27),
        ]), 56, 0.025, 5, false),
        new THREE.MeshBasicMaterial({ color: 0x0b1316 }),
      );
      scene.add(cable);
    }

    const rangeSigns = [
      { title: "1 ROUND = 1 VOTE", subtitle: "1 CONTRACT · HIT YES OR NO", position: [-6.65, 2.35, -12.4] as [number, number, number], rotation: 0.08 },
      { title: "$HSX ARMS THE CALL", subtitle: "HYPEREVM · BURN GATE", position: [7.65, 2.25, -18] as [number, number, number], rotation: -0.28 },
    ];
    rangeSigns.forEach((sign) => {
      const texture = environmentSignTexture(sign.title, sign.subtitle);
      environmentTextures.push(texture);
      const panel = new THREE.Mesh(
        new THREE.PlaneGeometry(4.6, 1.15),
        new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }),
      );
      panel.position.set(...sign.position);
      panel.rotation.y = sign.rotation;
      scene.add(panel);
    });

    const furnace = new THREE.Group();
    furnace.position.set(9.18, 0, -11.6);
    furnace.rotation.y = -Math.PI / 2;
    const furnaceSteel = new THREE.MeshStandardMaterial({ color: 0x27383a, metalness: 0.9, roughness: 0.28, envMapIntensity: 1.35 });
    const furnaceBody = new THREE.Mesh(new THREE.BoxGeometry(3.3, 3.5, 1.15), furnaceSteel);
    furnaceBody.position.y = 1.75;
    furnaceBody.castShadow = true;
    furnace.add(furnaceBody);
    const furnaceCoreMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff5d12).multiplyScalar(4.4), toneMapped: false });
    const furnaceCore = new THREE.Mesh(new THREE.PlaneGeometry(2.42, 1.86), furnaceCoreMaterial);
    furnaceCore.position.set(0, 1.68, 0.59);
    furnaceCore.userData.utility = "furnace";
    furnace.add(furnaceCore);
    furnaceMeshes.push(furnaceCore);
    const furnaceDoor = new THREE.Mesh(new THREE.BoxGeometry(2.85, 2.35, 0.2), new THREE.MeshStandardMaterial({ color: 0x172427, metalness: 0.86, roughness: 0.34 }));
    furnaceDoor.position.set(0, 1.68, 0.71);
    furnaceDoor.userData.utility = "furnace";
    furnace.add(furnaceDoor);
    furnaceMeshes.push(furnaceDoor);
    const furnaceWindow = new THREE.Mesh(new THREE.PlaneGeometry(2.25, 1.62), furnaceCoreMaterial);
    furnaceWindow.position.set(0, 1.68, 0.825);
    furnaceWindow.userData.utility = "furnace";
    furnace.add(furnaceWindow);
    furnaceMeshes.push(furnaceWindow);
    for (const x of [-0.82, -0.41, 0, 0.41, 0.82]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.075, 1.72, 0.08), furnaceSteel);
      bar.position.set(x, 1.68, 0.87);
      furnace.add(bar);
    }
    const furnaceFireMap = muzzleFireTexture();
    environmentTextures.push(furnaceFireMap);
    const furnaceFlames: THREE.Sprite[] = [];
    for (let index = 0; index < 5; index += 1) {
      const flame = new THREE.Sprite(new THREE.SpriteMaterial({ map: furnaceFireMap, color: index % 2 ? 0xff6a17 : 0xffba45, transparent: true, opacity: 0.72, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
      flame.position.set(-0.8 + index * 0.4, 1.48 + (index % 2) * 0.18, 0.92);
      flame.scale.set(0.72, 1.15 + index % 2 * 0.28, 1);
      furnace.add(flame);
      furnaceFlames.push(flame);
    }
    const furnaceLight = new THREE.PointLight(0xff6817, 34, 10, 2);
    furnaceLight.position.set(0, 1.7, 1.8);
    furnace.add(furnaceLight);
    const furnaceSignTexture = environmentSignTexture("$HSX FURNACE", "E · MANUAL SUPPLY BURN");
    environmentTextures.push(furnaceSignTexture);
    const furnaceSign = new THREE.Mesh(new THREE.PlaneGeometry(3.25, 0.82), new THREE.MeshBasicMaterial({ map: furnaceSignTexture, toneMapped: false }));
    furnaceSign.position.set(0, 4.15, 0.66);
    furnaceSign.userData.utility = "furnace";
    furnace.add(furnaceSign);
    furnaceMeshes.push(furnaceSign);
    scene.add(furnace);

    const laneMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(BRAND).multiplyScalar(1.8), transparent: true, opacity: 0.68, toneMapped: false });
    instance([0.045, 0.012, 16], laneMaterial, [-3.2, 0, 3.2].map((x) => ({ position: [x, 0.022, -17] as [number, number, number] })));

    for (let z = 8; z >= -29; z -= 6.2) {
      const beam = new THREE.Mesh(new THREE.BoxGeometry(20.8, 0.3, 0.52), architecture);
      beam.position.set(0, 6.2, z);
      beam.castShadow = true;
      scene.add(beam);
      for (const x of [-5, 0, 5]) {
        const lamp = new THREE.Mesh(
          new THREE.BoxGeometry(2.7, 0.045, 0.12),
          new THREE.MeshBasicMaterial({ color: new THREE.Color(z === 8 ? 0xd8fff8 : BRAND).multiplyScalar(3.6), toneMapped: false }),
        );
        lamp.position.set(x, 5.98, z - 0.05);
        scene.add(lamp);
      }
    }
    const skylightGlass = new THREE.MeshStandardMaterial({
      color: 0xc5e9e7,
      transparent: true,
      opacity: 0.24,
      roughness: 0.16,
      metalness: 0.18,
      envMapIntensity: 1.3,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const skyMap = skyTexture();
    const sunlightMap = sunTexture();
    environmentTextures.push(skyMap, sunlightMap);
    [2.1, -10.3, -22.7].forEach((z, index) => {
      const centerX = 0;
      const frameBars = [
        { size: [7.8, 0.26, 0.34] as [number, number, number], position: [centerX, 6.31, z - 1.98] as [number, number, number] },
        { size: [7.8, 0.26, 0.34] as [number, number, number], position: [centerX, 6.31, z + 1.98] as [number, number, number] },
        { size: [0.34, 0.26, 3.62] as [number, number, number], position: [centerX - 3.73, 6.31, z] as [number, number, number] },
        { size: [0.34, 0.26, 3.62] as [number, number, number], position: [centerX + 3.73, 6.31, z] as [number, number, number] },
      ];
      frameBars.forEach((bar) => {
        const frame = new THREE.Mesh(new THREE.BoxGeometry(...bar.size), structural);
        frame.position.set(...bar.position);
        scene.add(frame);
      });
      const opening = new THREE.Mesh(new THREE.PlaneGeometry(6.9, 3.45), skylightGlass);
      opening.rotation.x = -Math.PI / 2;
      opening.position.set(centerX, 6.17, z);
      scene.add(opening);
      const sky = new THREE.Mesh(
        new THREE.PlaneGeometry(10, 5),
        new THREE.MeshBasicMaterial({ map: skyMap, side: THREE.DoubleSide, toneMapped: false }),
      );
      sky.rotation.x = -Math.PI / 2;
      sky.position.set(0, 9.5 + index * 0.3, z - 0.8);
      scene.add(sky);
    });
    const ceilingMaterial = new THREE.MeshStandardMaterial({ map: metalTexture, color: 0x50666a, metalness: 0.74, roughness: 0.4, envMapIntensity: 0.95 });
    [
      { size: [6.3, 0.18, 44] as [number, number, number], position: [-6.85, 6.32, -9.5] as [number, number, number] },
      { size: [6.3, 0.18, 44] as [number, number, number], position: [6.85, 6.32, -9.5] as [number, number, number] },
      { size: [7.4, 0.18, 4.1] as [number, number, number], position: [0, 6.32, 6] as [number, number, number] },
      { size: [7.4, 0.18, 7.2] as [number, number, number], position: [0, 6.32, -4.1] as [number, number, number] },
      { size: [7.4, 0.18, 7.2] as [number, number, number], position: [0, 6.32, -16.5] as [number, number, number] },
      { size: [7.4, 0.18, 3.8] as [number, number, number], position: [0, 6.32, -27] as [number, number, number] },
    ].forEach((panel) => {
      const ceiling = new THREE.Mesh(new THREE.BoxGeometry(...panel.size), ceilingMaterial);
      ceiling.position.set(...panel.position);
      ceiling.receiveShadow = true;
      scene.add(ceiling);
    });
    const sun = new THREE.Sprite(new THREE.SpriteMaterial({ map: sunlightMap, color: new THREE.Color(3.6, 2.55, 1.55), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    sun.position.set(1.5, 11.8, -10.3);
    sun.scale.set(2.2, 2.2, 1);
    scene.add(sun);
    const sunShaft = new THREE.SpotLight(0xffd7a1, 86, 28, 0.34, 0.68, 1.35);
    sunShaft.position.copy(sun.position);
    sunShaft.target.position.set(1.5, 0, -10.3);
    sunShaft.castShadow = true;
    sunShaft.shadow.mapSize.set(512, 512);
    scene.add(sunShaft, sunShaft.target);
    [2, -10.4, -22.8].forEach((z, index) => {
      const practical = new THREE.PointLight(index === 1 ? 0xffcf98 : 0xbfffee, 22, 12, 2);
      practical.position.set(index === 1 ? -2.8 : 2.8, 5.35, z);
      scene.add(practical);
    });

    const backWall = new THREE.Mesh(new THREE.BoxGeometry(20, 7, 0.6), architecture);
    backWall.position.set(0, 3.5, -29);
    scene.add(backWall);
    shootableObjects.push(backWall);
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
    const screenMaterials: THREE.MeshBasicMaterial[] = [];
    const stationLights: THREE.PointLight[] = [];
    const stationRingMaterials: THREE.MeshBasicMaterial[] = [];
    const stationMajorities: string[] = [];
    const interactiveMeshes: THREE.Mesh[] = [];
    const voteMeshes: THREE.Mesh[] = [];
    const skinTextures: THREE.Texture[] = [];
    const voteTextures: THREE.Texture[] = [];

    markets.forEach((market, index) => {
      const group = new THREE.Group();
      group.position.copy(marketPositions[index]);
      const initialVoteCount = votesRef.current[market.id];
      const initialLightColor = marketLightColor(market, initialVoteCount);
      const stationLight = new THREE.PointLight(initialLightColor, 9, 6, 2);
      stationLight.position.set(0, 2.2, 1.1);
      group.add(stationLight);
      stationLights.push(stationLight);
      stationMajorities.push(initialVoteCount?.YES === initialVoteCount?.NO ? "TIE" : initialVoteCount?.YES > initialVoteCount?.NO ? "YES" : "NO");
      const base = new THREE.Mesh(
        new THREE.CylinderGeometry(1.62, 1.95, 0.42, 10),
        new THREE.MeshStandardMaterial({ color: 0x17343a, roughness: 0.24, metalness: 0.84 }),
      );
      base.position.y = 0.21;
      base.castShadow = true;
      base.userData.marketIndex = index;
      group.add(base);
      interactiveMeshes.push(base);
      const ringMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(initialLightColor).multiplyScalar(3.2), toneMapped: false });
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(1.52, 0.035, 8, 64),
        ringMaterial,
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.46;
      group.add(ring);
      stationRingMaterials.push(ringMaterial);

      const screenFrame = box([3.52, 2.15, 0.18], 0x17343a, 0.86, 0.16);
      screenFrame.position.set(0, 2.72, -0.42);
      screenFrame.castShadow = true;
      screenFrame.userData.marketIndex = index;
      group.add(screenFrame);
      interactiveMeshes.push(screenFrame);
      const screenMaterial = new THREE.MeshBasicMaterial({ map: labelTexture(market), color: new THREE.Color(1.18, 1.18, 1.18), toneMapped: false });
      const screen = new THREE.Mesh(new THREE.PlaneGeometry(3.28, 1.78), screenMaterial);
      screen.position.set(0, 2.72, -0.315);
      screen.userData.marketIndex = index;
      group.add(screen);
      interactiveMeshes.push(screen);
      screenMaterials.push(screenMaterial);

      const skinTexture = textureLoader.load(market.image);
      skinTexture.colorSpace = THREE.SRGBColorSpace;
      skinTexture.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
      skinTextures.push(skinTexture);
      const officialSkin = new THREE.Mesh(
        new THREE.PlaneGeometry(3.25, 3.25),
        new THREE.MeshBasicMaterial({
          map: skinTexture,
          transparent: true,
          alphaTest: 0.025,
          depthWrite: false,
          toneMapped: false,
        }),
      );
      officialSkin.position.set(0, 1.28, 0.2);
      officialSkin.userData.marketIndex = index;
      group.add(officialSkin);
      interactiveMeshes.push(officialSkin);

      (["YES", "NO"] as VoteSide[]).forEach((side, sideIndex) => {
        const texture = outcomeTexture(side);
        voteTextures.push(texture);
        const voteMaterial = new THREE.MeshBasicMaterial({ map: texture, color: new THREE.Color(1.35, 1.35, 1.35), toneMapped: false });
        const target = new THREE.Mesh(new THREE.PlaneGeometry(1.42, 0.53), voteMaterial);
        target.position.set(sideIndex === 0 ? -0.88 : 0.88, 0.73, 0.52);
        target.userData.marketIndex = index;
        target.userData.voteSide = side;
        target.userData.hitAt = -1000;
        group.add(target);
        voteMeshes.push(target);
      });

      scene.add(group);
      exhibitGroups.push(group);
    });

    const targetMeshes: THREE.Mesh[] = [];
    const committedExposure = portfolio.reduce((sum, entry) => sum + entry.amount, 0);
    const controlCenter = new THREE.Group();
    controlCenter.position.set(0, 0, -25.7);
    const controlShell = new THREE.MeshStandardMaterial({ color: 0x0b2429, metalness: 0.82, roughness: 0.26, envMapIntensity: 1.2 });
    const controlRack = new THREE.Mesh(new THREE.BoxGeometry(17.2, 5.2, 0.62), controlShell);
    controlRack.position.set(0, 2.7, -0.7);
    controlRack.castShadow = true;
    controlRack.receiveShadow = true;
    controlCenter.add(controlRack);
    const consoleDesk = new THREE.Mesh(new THREE.BoxGeometry(16.4, 1.05, 2.25), controlShell);
    consoleDesk.position.set(0, 0.55, 0.2);
    consoleDesk.castShadow = true;
    controlCenter.add(consoleDesk);
    shootableObjects.push(controlRack, consoleDesk);
    const lcdLayouts = [
      [-5.75, 3.65], [-2.88, 3.65], [0, 3.65], [2.88, 3.65], [5.75, 3.65],
      [-4.35, 1.85], [-1.45, 1.85], [1.45, 1.85], [4.35, 1.85],
    ] as Array<[number, number]>;
    lcdLayouts.forEach(([x, y], index) => {
      const frame = new THREE.Mesh(new THREE.BoxGeometry(2.72, 1.58, 0.22), controlShell);
      frame.position.set(x, y, -0.28);
      frame.castShadow = true;
      controlCenter.add(frame);
      const entry = index === 0 ? null : portfolio[index - 1] ?? null;
      const lcdTexture = controlCenterTexture(entry, index, portfolio.length, committedExposure);
      environmentTextures.push(lcdTexture);
      const screen = new THREE.Mesh(
        new THREE.PlaneGeometry(2.5, 1.36),
        new THREE.MeshBasicMaterial({ map: lcdTexture, color: new THREE.Color(1.12, 1.12, 1.12), toneMapped: false }),
      );
      screen.position.set(x, y, -0.155);
      controlCenter.add(screen);
    });
    [-5.8, -2.9, 0, 2.9, 5.8].forEach((x, index) => {
      const keyLight = new THREE.PointLight(index % 2 ? STRIKE_ORANGE : BRAND, 6, 4.5, 2);
      keyLight.position.set(x, 3.7, 0.25);
      controlCenter.add(keyLight);
    });
    const consoleStrip = new THREE.Mesh(
      new THREE.BoxGeometry(15.6, 0.045, 0.12),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(BRAND).multiplyScalar(3.4), toneMapped: false }),
    );
    consoleStrip.position.set(0, 1.12, 1.15);
    controlCenter.add(consoleStrip);
    scene.add(controlCenter);

    const dustCount = 180;
    const dustPositions = new Float32Array(dustCount * 3);
    for (let i = 0; i < dustCount; i += 1) {
      dustPositions[i * 3] = (Math.random() - 0.5) * 20;
      dustPositions[i * 3 + 1] = Math.random() * 6;
      dustPositions[i * 3 + 2] = 8 - Math.random() * 38;
    }
    const dustGeometry = new THREE.BufferGeometry();
    dustGeometry.setAttribute("position", new THREE.BufferAttribute(dustPositions, 3));
    const dust = new THREE.Points(
      dustGeometry,
      new THREE.PointsMaterial({ color: 0xbffff4, size: 0.022, transparent: true, opacity: 0.58, depthWrite: false }),
    );
    scene.add(dust);

    const scanningLine = new THREE.Mesh(
      new THREE.BoxGeometry(18, 0.014, 0.025),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(BRAND).multiplyScalar(2.8), transparent: true, opacity: 0.78, toneMapped: false }),
    );
    scanningLine.position.set(0, 0.04, -3);
    scene.add(scanningLine);

    const viewWeapon = new THREE.Group();
    viewWeapon.position.set(0.68, -0.68, -1.5);
    viewWeapon.rotation.set(0.11, 0.34, 0.025);
    viewModelScene.add(viewWeapon);
    const muzzleAnchor = new THREE.Object3D();
    muzzleAnchor.position.set(-0.4, 0.42, -0.45);
    viewWeapon.add(muzzleAnchor);
    let weaponMagazine: THREE.Object3D | null = null;
    let weaponBolt: THREE.Object3D | null = null;
    const magazineBasePosition = new THREE.Vector3();
    const magazineBaseQuaternion = new THREE.Quaternion();
    const boltBasePosition = new THREE.Vector3();
    new GLTFLoader(loadingManager).load("/models/ak-platform.glb", ({ scene: object }) => {
      if (disposed) return;
      const bounds = new THREE.Box3().setFromObject(object);
      const size = bounds.getSize(new THREE.Vector3());
      const center = bounds.getCenter(new THREE.Vector3());
      object.position.sub(center);
      object.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        child.frustumCulled = true;
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach((material) => {
          if (!(material instanceof THREE.MeshStandardMaterial)) return;
          const wood = material.name.includes("Material_2");
          material.metalness = wood ? 0.04 : 0.82;
          material.roughness = wood ? 0.42 : 0.26;
          material.envMapIntensity = wood ? 0.8 : 1.45;
          material.map = wood ? weaponWoodTexture : weaponMetalTexture;
          material.color.set(wood ? 0xd5a36d : 0xb7c4c3);
          material.needsUpdate = true;
        });
      });
      const model = new THREE.Group();
      model.add(object);
      model.scale.setScalar(2.04 / Math.max(size.x, size.y, size.z));
      model.rotation.y = Math.PI;
      model.position.set(0, 0.02, -0.08);
      viewWeapon.add(model);
      viewWeapon.updateMatrixWorld(true);
      model.updateMatrixWorld(true);
      const cleaningRod = object.getObjectByName("AK-47 2 Cleaning Rod 1");
      const rearSight = object.getObjectByName("AK-47 2 Rearsight 1");
      if (cleaningRod && rearSight) {
        const rear = rearSight.getWorldPosition(new THREE.Vector3());
        const rodBounds = new THREE.Box3().setFromObject(cleaningRod);
        const rodCenter = rodBounds.getCenter(new THREE.Vector3());
        const boreDirection = rodCenter.clone().sub(rear).normalize();
        let muzzleWorld = rodCenter.clone();
        for (const x of [rodBounds.min.x, rodBounds.max.x]) {
          for (const y of [rodBounds.min.y, rodBounds.max.y]) {
            for (const z of [rodBounds.min.z, rodBounds.max.z]) {
              const corner = new THREE.Vector3(x, y, z);
              if (corner.clone().sub(rear).dot(boreDirection) > muzzleWorld.clone().sub(rear).dot(boreDirection)) muzzleWorld = corner;
            }
          }
        }
        muzzleWorld.addScaledVector(boreDirection, 0.055);
        const localOrigin = viewWeapon.worldToLocal(muzzleWorld.clone());
        muzzleAnchor.position.copy(localOrigin);
        const localDirection = viewWeapon.worldToLocal(muzzleWorld.clone().add(boreDirection)).sub(localOrigin).normalize();
        muzzleAnchor.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), localDirection);
      }
      const magazine = object.getObjectByName("AK-47 2 Mag 1");
      if (magazine) {
        model.attach(magazine);
        weaponMagazine = magazine;
        magazineBasePosition.copy(magazine.position);
        magazineBaseQuaternion.copy(magazine.quaternion);
      }
      weaponBolt = object.getObjectByName("AK-47 2 Bolt Carrier 1") ?? null;
      if (weaponBolt) boltBasePosition.copy(weaponBolt.position);
    });

    const weaponLight = new THREE.PointLight(0xc9fff7, 7, 4, 2);
    weaponLight.position.set(0.3, 0.2, -0.7);
    viewModelScene.add(weaponLight);
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
    let lastFrameTime = performance.now();
    const magazineSize = 30;
    const fireInterval = 92;
    const reloadDuration = 2300;
    let magazine = magazineSize;
    let reserve = Number.POSITIVE_INFINITY;
    let reloading = false;
    let reloadStartedAt = 0;
    let lastShot = -fireInterval;
    let firing = false;
    let audioContext: AudioContext | null = null;
    const effects: TimedEffect[] = [];
    const moveDirection = new THREE.Vector3();
    ammoRef.current(magazine, reserve, reloading);

    const playShot = () => {
      audioContext ??= new AudioContext();
      const context = audioContext;
      const at = context.currentTime;
      const buffer = context.createBuffer(1, Math.floor(context.sampleRate * 0.075), context.sampleRate);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < channel.length; i += 1) channel[i] = (Math.random() * 2 - 1) * (1 - i / channel.length);
      const noise = context.createBufferSource();
      noise.buffer = buffer;
      const filter = context.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.value = 1250;
      filter.Q.value = 0.65;
      const gain = context.createGain();
      gain.gain.setValueAtTime(0.28, at);
      gain.gain.exponentialRampToValueAtTime(0.001, at + 0.075);
      noise.connect(filter).connect(gain).connect(context.destination);
      noise.start(at);
      const thump = context.createOscillator();
      const thumpGain = context.createGain();
      thump.type = "triangle";
      thump.frequency.setValueAtTime(120, at);
      thump.frequency.exponentialRampToValueAtTime(48, at + 0.09);
      thumpGain.gain.setValueAtTime(0.22, at);
      thumpGain.gain.exponentialRampToValueAtTime(0.001, at + 0.1);
      thump.connect(thumpGain).connect(context.destination);
      thump.start(at);
      thump.stop(at + 0.1);
    };

    const startReload = () => {
      if (reloading) return;
      reloading = true;
      reloadStartedAt = performance.now();
      ammoRef.current(magazine, reserve, true);
    };

    const spawnShotEffects = (now: number, endpoint: THREE.Vector3, hit?: THREE.Intersection<THREE.Object3D>) => {
      camera.updateMatrixWorld(true);
      viewModelCamera.updateMatrixWorld(true);
      muzzleAnchor.updateWorldMatrix(true, false);
      const muzzleNdc = muzzleAnchor.getWorldPosition(new THREE.Vector3()).project(viewModelCamera);
      tracerRaycaster.setFromCamera(new THREE.Vector2(muzzleNdc.x, muzzleNdc.y), camera);
      const start = tracerRaycaster.ray.origin.clone().addScaledVector(tracerRaycaster.ray.direction, 1.15);
      roomMuzzleLight.position.copy(start);
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([start, endpoint]),
        new THREE.LineBasicMaterial({ color: 0xaaffee, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      scene.add(line);
      effects.push({ object: line, expires: now + 115 });

      const impact = new THREE.Mesh(
        new THREE.SphereGeometry(0.07, 8, 8),
        new THREE.MeshBasicMaterial({ color: hit ? 0xcffff5 : 0x83dcd3, transparent: true, blending: THREE.AdditiveBlending }),
      );
      impact.position.copy(endpoint);
      scene.add(impact);
      effects.push({ object: impact, expires: now + 430 });

      const casing = new THREE.Mesh(
        new THREE.CylinderGeometry(0.018, 0.018, 0.09, 8),
        new THREE.MeshStandardMaterial({ color: 0xd0a454, metalness: 0.86, roughness: 0.24 }),
      );
      casing.position.copy(camera.localToWorld(new THREE.Vector3(0.66, -0.13, -1.14)));
      const right = new THREE.Vector3(1, 0.8, 0.2).applyQuaternion(camera.quaternion).multiplyScalar(1.8 + Math.random());
      casing.rotation.set(Math.random(), Math.random(), Math.random());
      scene.add(casing);
      effects.push({ object: casing, expires: now + 1250, velocity: right });
    };

    const requestLock = () => {
      if (!enteredRef.current) enteredEventRef.current();
      if (document.pointerLockElement !== renderer.domElement) renderer.domElement.requestPointerLock();
    };
    const onPointerLockChange = () => {
      const locked = document.pointerLockElement === renderer.domElement;
      if (!locked) firing = false;
      lockRef.current(locked);
    };
    const onMouseMove = (event: MouseEvent) => {
      if (document.pointerLockElement !== renderer.domElement) return;
      yaw -= event.movementX * 0.00165;
      pitch -= event.movementY * 0.00165;
      lookKickX = THREE.MathUtils.clamp(lookKickX + event.movementX * 0.00032, -0.035, 0.035);
      lookKickY = THREE.MathUtils.clamp(lookKickY + event.movementY * 0.00026, -0.028, 0.028);
      pitch = THREE.MathUtils.clamp(pitch, -1.28, 1.28);
    };
    const fireShot = (now: number) => {
      if (document.pointerLockElement !== renderer.domElement || reloading || now - lastShot < fireInterval) return;
      if (magazine <= 0) {
        startReload();
        return;
      }
      lastShot = now;
      magazine -= 1;
      ammoRef.current(magazine, reserve, false);
      recoil = 0.1;
      muzzleEnergy = 1;
      playShot();
      raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
      const hit = raycaster.intersectObjects([...voteMeshes, ...targetMeshes, ...interactiveMeshes, ...shootableObjects], false)[0];
      const endpoint = hit?.point.clone() ?? raycaster.ray.origin.clone().addScaledVector(raycaster.ray.direction, 45);
      if (hit && targetMeshes.includes(hit.object as THREE.Mesh)) hit.object.userData.hitAt = now;
      if (hit && voteMeshes.includes(hit.object as THREE.Mesh)) {
        const marketIndex = Number(hit.object.userData.marketIndex);
        const side = hit.object.userData.voteSide as VoteSide;
        hit.object.userData.hitAt = now;
        voteRef.current(markets[marketIndex], side);
      }
      spawnShotEffects(now, endpoint, hit);
      if (magazine === 0) startReload();
    };
    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0 || document.pointerLockElement !== renderer.domElement) return;
      firing = true;
      fireShot(performance.now());
    };
    const onMouseUp = (event: MouseEvent) => {
      if (event.button === 0) firing = false;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      keys.add(event.code);
      if (event.repeat) return;
      if (event.code === "KeyR") startReload();
      if (event.code === "KeyE" && furnaceTargeted) {
        furnaceRef.current();
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
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);

    let frame = 0;
    let fpsFrames = 0;
    let fpsSampleStarted = performance.now();
    let lowFpsSamples = 0;
    let adaptivePixelRatio = initialPixelRatio;
    const animate = (now: number) => {
      frame = requestAnimationFrame(animate);
      fpsFrames += 1;
      const fpsElapsed = now - fpsSampleStarted;
      if (fpsElapsed >= 1000) {
        const measuredFps = Math.round((fpsFrames * 1000) / fpsElapsed);
        mount.dataset.fps = String(measuredFps);
        lowFpsSamples = measuredFps < 54 ? lowFpsSamples + 1 : 0;
        if (lowFpsSamples >= 2 && adaptivePixelRatio > 1) {
          adaptivePixelRatio = Math.max(1, adaptivePixelRatio - 0.2);
          renderer.setPixelRatio(adaptivePixelRatio);
          composer.setPixelRatio(adaptivePixelRatio);
          renderer.setSize(mount.clientWidth, mount.clientHeight);
          composer.setSize(mount.clientWidth, mount.clientHeight);
        }
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
      camera.rotation.set(pitch + lookKickY * 0.2, yaw, bodyRoll - lookKickX * 0.34);

      let reloadProgress = 0;
      if (reloading) {
        reloadProgress = THREE.MathUtils.clamp((now - reloadStartedAt) / reloadDuration, 0, 1);
        if (reloadProgress >= 1) {
          magazine = magazineSize;
          reloading = false;
          reloadProgress = 0;
          ammoRef.current(magazine, reserve, false);
        }
      }
      if (firing) fireShot(now);

      recoil = THREE.MathUtils.lerp(recoil, 0, Math.min(1, dt * 14));
      muzzleEnergy = THREE.MathUtils.lerp(muzzleEnergy, 0, Math.min(1, dt * 25));
      viewWeapon.visible = enteredRef.current;
      muzzleFlash.visible = enteredRef.current && muzzleEnergy > 0.12;
      muzzleFlash.scale.setScalar(0.76 + muzzleEnergy * (0.9 + Math.sin(now * 0.071) * 0.14));
      muzzleFlash.rotation.z = Math.sin(now * 0.053) * 0.22;
      muzzle.intensity = muzzleEnergy * 48;
      roomMuzzleLight.intensity = muzzleEnergy * 72;
      const walkBob = moving ? Math.sin(now * 0.011) * 0.018 : Math.sin(now * 0.0022) * 0.004;
      const lateralBob = moving ? Math.cos(now * 0.0055) * 0.012 : Math.sin(now * 0.0017) * 0.003;
      const reloadSwing = reloading ? Math.sin(smooth01(reloadProgress) * Math.PI) : 0;
      viewWeapon.position.set(
        0.68 + lateralBob - lookKickX * 2.2 - reloadSwing * 0.18,
        -0.68 + walkBob + recoil + lookKickY * 1.6 - reloadSwing * 0.18,
        -1.5 + reloadSwing * 0.12,
      );
      viewWeapon.rotation.set(
        0.11 + recoil * 1.15 + lookKickY * 0.9 + reloadSwing * 0.3,
        0.34 + lookKickX * 1.1 + reloadSwing * 0.52,
        0.025 - lookKickX * 0.8 - reloadSwing * 0.52,
      );
      if (weaponMagazine) {
        weaponMagazine.position.copy(magazineBasePosition);
        weaponMagazine.quaternion.copy(magazineBaseQuaternion);
        weaponMagazine.visible = true;
        if (reloading && reloadProgress >= 0.16 && reloadProgress < 0.48) {
          const drop = smooth01((reloadProgress - 0.16) / 0.32);
          weaponMagazine.position.y -= drop * 0.24;
          weaponMagazine.position.x -= drop * 0.07;
          weaponMagazine.rotateZ(-drop * 0.38);
          weaponMagazine.visible = reloadProgress < 0.44;
        } else if (reloading && reloadProgress >= 0.48 && reloadProgress < 0.72) {
          const rise = smooth01((reloadProgress - 0.48) / 0.24);
          weaponMagazine.position.y -= (1 - rise) * 0.24;
          weaponMagazine.position.x += (1 - rise) * 0.09;
          weaponMagazine.rotateZ((1 - rise) * 0.42);
        }
      }
      if (weaponBolt) {
        weaponBolt.position.copy(boltBasePosition);
        if (reloading && reloadProgress > 0.76) {
          const rack = Math.sin(THREE.MathUtils.clamp((reloadProgress - 0.76) / 0.2, 0, 1) * Math.PI);
          weaponBolt.position.y += rack * 0.055;
        }
      }

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
        const targeted = index === lastTargeted;
        screenMaterials[index].color.setScalar(targeted ? 1.5 : 1.18);
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
        const pulse = elapsed < 180 ? Math.sin((elapsed / 180) * Math.PI) : 0;
        (target.material as THREE.MeshBasicMaterial).color.setScalar(1.35 + pulse * 1.4);
        target.scale.setScalar(1 + pulse * 0.08);
      });

      for (let index = effects.length - 1; index >= 0; index -= 1) {
        const effect = effects[index];
        if (effect.velocity) {
          effect.velocity.y -= 8.8 * dt;
          effect.object.position.addScaledVector(effect.velocity, dt);
          effect.object.rotation.x += dt * 11;
          effect.object.rotation.z += dt * 8;
        }
        if (now >= effect.expires) {
          disposeEffect(effect);
          effects.splice(index, 1);
        }
      }

      dust.rotation.y = now * 0.000015;
      scanningLine.position.z = 6 - ((now * 0.0018) % 34);
      furnaceFlames.forEach((flame, index) => {
        const pulse = 0.82 + Math.sin(now * 0.014 + index * 1.7) * 0.18;
        flame.scale.set(0.72 * pulse, (1.08 + (index % 2) * 0.3) * pulse, 1);
        flame.position.y = 1.46 + (index % 2) * 0.18 + Math.sin(now * 0.009 + index) * 0.08;
      });
      furnaceLight.intensity = 29 + Math.sin(now * 0.012) * 9;
      bodycamPass.uniforms.time.value = now;
      renderer.toneMappingExposure = THREE.MathUtils.lerp(renderer.toneMappingExposure, 0.66 + Math.sin(now * 0.00037) * 0.025, Math.min(1, dt * 1.4));
      camera.updateMatrixWorld(true);
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
      if (nextFurnaceTargeted !== furnaceTargeted) {
        furnaceTargeted = nextFurnaceTargeted;
        furnaceProximityRef.current(furnaceTargeted);
      }

      renderer.clear();
      composer.render(dt);
      renderer.clearDepth();
      renderer.render(viewModelScene, viewModelCamera);
    };
    const startRendering = () => {
      if (disposed || frame) return;
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
    };
    window.addEventListener("resize", onResize);

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      loadingManager.onLoad = () => {};
      window.removeEventListener("resize", onResize);
      renderer.domElement.removeEventListener("click", requestLock);
      renderer.domElement.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("pointerlockchange", onPointerLockChange);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
      furnaceProximityRef.current(false);
      effects.forEach(disposeEffect);
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
      environmentMap?.dispose();
      pmrem.dispose();
      composer.dispose();
      renderer.dispose();
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
    };
  }, [markets, portfolio]);

  return <div className="world-canvas" ref={mountRef} aria-label="HyperStrike first-person ballistic price range" />;
}
