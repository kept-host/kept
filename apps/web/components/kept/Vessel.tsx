"use client";

import * as React from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { ContactShadows } from "@react-three/drei";
import { useTheme } from "next-themes";
import * as THREE from "three";

import { useVesselState } from "@/components/kept/vessel-state";

/**
 * Vessel — the real React Three Fiber brand object (frontend-specs §7,
 * design-system §7). Ported from the design's own three.js scene: a refractive
 * frosted-glass urn (LatheGeometry → MeshPhysicalMaterial transmission) holding
 * one glowing violet orb (emissive mesh + PointLight + additive glow sprite),
 * lit by a PMREM environment for believable refraction.
 *
 * Two independent idle loops (vessel breathe; orb bob with out-of-phase glow),
 * eased pointer parallax (vessel tilts toward the cursor, orb drifts more),
 * theme-aware material, and a `scrollProgress` rotation input the Phase 2
 * scroll choreography will drive. `health` (0..1) modulates orb brightness;
 * `phase` (idle | dragover | minting | scrolling) inhales the vessel + brightens
 * the orb (E1 publish-flow seam). Reduced-motion renders a single static frame.
 *
 * This file is dynamically imported `ssr:false` by VesselMount; the static still
 * is the no-WebGL / reduced-motion fallback there.
 */

const ACCENT_LIGHT = "#6D4AFF";
const ACCENT_DARK = "#8B6DFF";

/** Smooth egg/ovoid urn profile — taller than wide, belly low (~40% up), a
 *  continuous taper to a rounded narrower mouth (NO straight wall, so it reads
 *  as an elegant vessel, not a barrel/can). Outer silhouette bottom→top, then
 *  inner wall top→bottom for a hollow body with a thin rim. */
const URN_CONTROL: [number, number][] = [
  // outer wall, bottom → mouth
  [0.0, -1.12], [0.3, -1.06], [0.54, -0.93], [0.72, -0.74], [0.84, -0.5], [0.9, -0.22],
  [0.89, 0.06], [0.84, 0.34], [0.76, 0.58], [0.67, 0.78], [0.6, 0.94], [0.57, 1.02],
  // inner wall, mouth → bottom
  [0.5, 1.02], [0.51, 0.92], [0.58, 0.66], [0.66, 0.34], [0.72, 0.0], [0.74, -0.28],
  [0.69, -0.56], [0.56, -0.8], [0.34, -0.98], [0.0, -1.0],
];

function buildUrnGeometry(): THREE.LatheGeometry {
  const ctrl = URN_CONTROL.map(([x, y]) => new THREE.Vector2(x, y));
  const spline = new THREE.SplineCurve(ctrl);
  const points = spline.getPoints(150);
  const geo = new THREE.LatheGeometry(points, 160);
  geo.computeVertexNormals();
  return geo;
}

/** Soft studio env (warm highlight + violet pool) baked through PMREM. */
function buildEnvTexture(gl: THREE.WebGLRenderer): THREE.Texture {
  const w = 512;
  const h = 256;
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d")!;
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "#ffffff");
  g.addColorStop(0.45, "#f4f0ff");
  g.addColorStop(0.7, "#e9e2fb");
  g.addColorStop(1, "#d8d0ee");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  const r1 = ctx.createRadialGradient(w * 0.7, h * 0.3, 0, w * 0.7, h * 0.3, h * 0.6);
  r1.addColorStop(0, "rgba(255,250,240,0.9)");
  r1.addColorStop(1, "rgba(255,250,240,0)");
  ctx.fillStyle = r1;
  ctx.fillRect(0, 0, w, h);
  const r2 = ctx.createRadialGradient(w * 0.25, h * 0.7, 0, w * 0.25, h * 0.7, h * 0.7);
  r2.addColorStop(0, "rgba(140,109,255,0.5)");
  r2.addColorStop(1, "rgba(140,109,255,0)");
  ctx.fillStyle = r2;
  ctx.fillRect(0, 0, w, h);

  const tex = new THREE.CanvasTexture(cv);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  const pmrem = new THREE.PMREMGenerator(gl);
  pmrem.compileEquirectangularShader();
  const rt = pmrem.fromEquirectangular(tex);
  tex.dispose();
  pmrem.dispose();
  return rt.texture;
}

/** Additive radial-glow sprite for the orb's diffuse bloom. */
function buildGlowSprite(): THREE.Sprite {
  const s = 128;
  const cv = document.createElement("canvas");
  cv.width = cv.height = s;
  const ctx = cv.getContext("2d")!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, "rgba(168,140,255,0.55)");
  g.addColorStop(0.35, "rgba(124,90,255,0.30)");
  g.addColorStop(1, "rgba(124,90,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(cv);
  return new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: tex,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    }),
  );
}

function Scene({ reducedMotion }: { reducedMotion: boolean }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const invalidate = useThree((s) => s.invalidate);
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  const accent = dark ? ACCENT_DARK : ACCENT_LIGHT;

  const { phase, health, scrollProgress } = useVesselState();

  // Persisted scene objects (built once).
  const groupRef = React.useRef<THREE.Group>(null);
  const geometry = React.useMemo(buildUrnGeometry, []);
  const material = React.useMemo(
    () =>
      // Crisp translucent frosted glass. Lower roughness than the design's
      // r0.150 source (0.18 → 0.12) so the PMREM env paints clean highlights
      // under r0.184's physically-correct lighting (post-r155 useLegacyLights
      // default flip made the old values read milky/plastic). Thickness pulled
      // from 1.8 → 0.9 so the orb refracts as a rounded SPHERE through the wall
      // instead of smearing into a horizontal "liquid" band. ior 1.45 glass.
      new THREE.MeshPhysicalMaterial({
        color: 0xffffff,
        roughness: 0.12,
        metalness: 0,
        transmission: 1,
        thickness: 0.9,
        ior: 1.45,
        clearcoat: 0.6,
        clearcoatRoughness: 0.28,
        attenuationColor: new THREE.Color(0xece6ff),
        attenuationDistance: 2.2,
        transparent: true,
        side: THREE.DoubleSide,
        envMapIntensity: 1.25,
      }),
    [],
  );
  const orbMaterial = React.useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: ACCENT_LIGHT,
        emissive: ACCENT_LIGHT,
        emissiveIntensity: 1.8,
        roughness: 0.4,
        toneMapped: false,
      }),
    [],
  );
  const glow = React.useMemo(buildGlowSprite, []);
  const orbRef = React.useRef<THREE.Mesh>(null);
  const orbLightRef = React.useRef<THREE.PointLight>(null);

  // Eased animation accumulators.
  const eased = React.useRef({ scale: 1, rise: 0, glowBoost: 0, scroll: 0 });

  // Bake the PMREM environment once we have a renderer.
  React.useEffect(() => {
    const env = buildEnvTexture(gl);
    scene.environment = env;
    invalidate();
    return () => {
      scene.environment = null;
      env.dispose();
    };
  }, [gl, scene, invalidate]);

  // Theme-aware material + orb tint. Re-render the static frame when it changes.
  React.useEffect(() => {
    material.color.set(dark ? 0x6a6490 : 0xffffff);
    material.attenuationColor.set(dark ? 0x322b52 : 0xece6ff);
    material.roughness = dark ? 0.2 : 0.12;
    material.envMapIntensity = dark ? 0.85 : 1.25;
    orbMaterial.color.set(accent);
    orbMaterial.emissive.set(accent);
    if (orbLightRef.current) orbLightRef.current.color.set(accent);
    invalidate();
  }, [dark, accent, material, orbMaterial, invalidate]);

  // Dispose GPU resources on unmount.
  React.useEffect(() => {
    return () => {
      geometry.dispose();
      material.dispose();
      orbMaterial.dispose();
      glow.material.map?.dispose();
      glow.material.dispose();
    };
  }, [geometry, material, orbMaterial, glow]);

  useFrame((state, delta) => {
    const group = groupRef.current;
    const orb = orbRef.current;
    const orbLight = orbLightRef.current;
    if (!group || !orb || !orbLight) return;

    const e = eased.current;
    const active = phase === "dragover" || phase === "minting";

    if (reducedMotion) {
      // One settled, static pose. No time-driven motion.
      group.scale.setScalar(1);
      group.rotation.set(-0.12, 0, 0);
      const oy = -0.05;
      orb.position.set(0, oy, 0);
      orbLight.position.set(0, oy, 0);
      glow.position.set(0, oy, 0.2);
      glow.scale.setScalar(0.64);
      const inten = 1.45 + health * 0.6;
      orbMaterial.emissiveIntensity = inten;
      orbLight.intensity = inten * 1.15;
      return;
    }

    const time = state.clock.getElapsedTime();

    // Pointer parallax — R3F gives a normalized [-1,1] pointer; ease it hard.
    const px = state.pointer.x * 0.5;
    const py = state.pointer.y * 0.5;

    // Scroll scrub (Phase 2 drives scrollProgress; ease toward it). A gentle
    // ease-out shaping (not linear) so the side-turn reads deliberate/premium.
    e.scroll += (scrollProgress - e.scroll) * 0.08;
    const s = e.scroll;
    const scrollEased = 1 - (1 - s) * (1 - s); // quad ease-out

    // Vessel breathing + drag inhale.
    const breathe = 1 + Math.sin(time * 0.8) * 0.018;
    const targetScale = active ? 1.07 : 1.0;
    e.scale += (targetScale - e.scale) * 0.08;
    group.scale.setScalar(breathe * e.scale);

    // Rotation: slow drift + scroll scrub + pointer parallax (vessel moves less).
    // The scroll turns the urn to its side (rotation.y) and tips it forward
    // (rotation.x), so the contained orb swings into profile as the page advances.
    group.rotation.y = time * 0.12 + scrollEased * Math.PI * 0.62 + px * 0.4;
    group.rotation.x =
      -0.12 + Math.sin(time * 0.5) * 0.035 - py * 0.2 - scrollEased * 0.24;

    // Orb bob (independent, faster) + parallax (orb moves more) + rise on drag.
    // Pointer parallax pushed a touch livelier (0.55→0.62) so the orb feels more
    // alive under the cursor, still eased by R3F's smoothed pointer.
    const bob = Math.sin(time * 2.2) * 0.11;
    const rise = active ? 0.5 : 0;
    e.rise += (rise - e.rise) * 0.07;
    const ox = px * 0.62;
    const oy = -0.05 + bob + e.rise;
    const oz = py * -0.22;

    // Glow / brightness, out-of-phase pulse; health lifts the floor; scroll
    // intensifies the orb as the vessel turns into profile (the light the page's
    // ambient glow layer mirrors). Eased, so it swells rather than snaps.
    const basePulse = 1.45 + Math.sin(time * 1.5 + 1.3) * 0.45;
    const dragBoost = active ? 0.9 : 0;
    const healthBoost = (health - 0.5) * 0.8;
    const scrollGlow = Math.sin(scrollEased * Math.PI) * 1.0; // peaks mid-scroll
    e.glowBoost *= 0.94;
    const inten = basePulse + dragBoost + healthBoost + scrollGlow + e.glowBoost;
    orbMaterial.emissiveIntensity = inten;
    orbLight.intensity = inten * 1.15;

    orb.position.set(ox, oy, oz);
    orbLight.position.set(ox, oy, oz);
    glow.position.set(ox, oy, oz + 0.2);
    glow.scale.setScalar(
      (0.62 + Math.sin(time * 1.5 + 1.3) * 0.09 + scrollGlow * 0.12) *
        (1 + e.glowBoost * 0.3),
    );

    // Brighten on pointer proximity to the orb (a bit punchier, still subtle).
    const prox = 1 - Math.min(1, Math.hypot(state.pointer.x, state.pointer.y));
    orbLight.intensity += prox * 0.35;
    orbMaterial.emissiveIntensity += prox * 0.12;

    void delta;
  });

  return (
    <>
      {/* World-fixed studio rig (design adds these to the scene, NOT the rotating
          group) — keeps the key/fill/rim stable so glass highlights don't swim
          as the vessel turns. */}
      <ambientLight intensity={0.4} />
      <directionalLight position={[3, 5, 4]} intensity={1.1} />
      <directionalLight color={0xc9b8ff} position={[-4, 1, 2]} intensity={0.45} />
      <directionalLight position={[-2, 3, -4]} intensity={0.8} />

      {/* Soft contact shadow pooled under the urn's foot (y ≈ -1.06). */}
      <ContactShadows
        position={[0, -1.12, 0]}
        scale={3.4}
        opacity={dark ? 0.5 : 0.32}
        blur={2.6}
        far={2.2}
        resolution={512}
        color={dark ? "#000000" : "#2a2014"}
      />

      <group ref={groupRef}>
        <mesh geometry={geometry} material={material} />
        {/* A real SPHERE (~0.30 of the ~1.04 belly width), self-luminous violet.
            Sized up from the design's 0.16 so it reads as a distinct hovering
            orb whose refraction through the curved glass produces the winged
            halo — never a flat band/disc. radius == uniform, so it can't scale flat. */}
        <mesh ref={orbRef} material={orbMaterial} position={[0, -0.05, 0]}>
          <sphereGeometry args={[0.22, 48, 48]} />
        </mesh>
        <pointLight ref={orbLightRef} color={accent} intensity={1.8} distance={7} decay={2} />
        <primitive object={glow} />
      </group>
    </>
  );
}

export default function Vessel({
  reducedMotion = false,
}: {
  reducedMotion?: boolean;
}) {
  return (
    <div className="h-[560px] w-full" data-vessel="canvas">
      <Canvas
        dpr={[1, 2]}
        frameloop={reducedMotion ? "demand" : "always"}
        camera={{ position: [0, 0.18, 6.1], fov: 30, near: 0.1, far: 100 }}
        gl={{ alpha: true, antialias: true }}
        onCreated={({ gl, camera }) => {
          gl.outputColorSpace = THREE.SRGBColorSpace;
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = 1.05;
          camera.lookAt(0, -0.02, 0);
        }}
        style={{ width: "100%", height: "100%", display: "block" }}
      >
        <Scene reducedMotion={reducedMotion} />
      </Canvas>
    </div>
  );
}
