import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { WeaponHud } from "./RangeHud";
import type { TouchApi } from "./range/touch";

/** How far the thumb travels from where it landed to full speed, in CSS pixels. */
const REACH = 52;

/**
 * The range on a touch screen. The left thumb lands anywhere on the lower left and becomes the
 * movement stick; a drag anywhere else turns the view, including a drag that starts on FIRE, so
 * the right thumb can hold the trigger and track a target at once.
 */
export function RangeTouch({ api, weapon }: { api: { current: TouchApi | null }; weapon: WeaponHud | null }) {
  const layer = useRef<HTMLDivElement>(null), ring = useRef<HTMLDivElement>(null), knob = useRef<HTMLElement>(null);
  const stick = useRef<{ id: number; x: number; y: number } | null>(null);
  const looks = useRef(new Map<number, { x: number; y: number }>());
  const [aiming, setAiming] = useState(false);
  const [firing, setFiring] = useState(false);

  useEffect(() => {
    const node = layer.current;
    if (!node) return;
    // The page must not scroll, zoom or select text under the thumbs; touch-action alone is not honoured everywhere.
    const hold = (event: TouchEvent) => { if (event.cancelable) event.preventDefault(); };
    node.addEventListener("touchstart", hold, { passive: false });
    node.addEventListener("touchmove", hold, { passive: false });
    return () => {
      node.removeEventListener("touchstart", hold);
      node.removeEventListener("touchmove", hold);
      api.current?.move(0, 0);
      api.current?.fire(false);
      api.current?.aim(false);
    };
  }, [api]);

  const capture = (event: ReactPointerEvent<HTMLElement>) => {
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* the pointer is already gone */ }
  };
  const down = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    capture(event);
    const box = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - box.left, y = event.clientY - box.top;
    if (!stick.current && x < box.width * 0.42 && y > box.height * 0.3) {
      stick.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
      if (ring.current) {
        ring.current.style.left = `${x}px`;
        ring.current.style.top = `${y}px`;
        ring.current.style.bottom = "auto";
        ring.current.classList.add("is-on");
      }
    } else {
      looks.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }
  };
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const held = stick.current;
    if (held && held.id === event.pointerId) {
      let dx = (event.clientX - held.x) / REACH, dy = (event.clientY - held.y) / REACH;
      const length = Math.hypot(dx, dy);
      if (length > 1) { dx /= length; dy /= length; }
      if (knob.current) knob.current.style.transform = `translate(${dx * REACH}px, ${dy * REACH}px)`;
      // A resting thumb does not creep.
      if (length < 0.16) api.current?.move(0, 0);
      else api.current?.move(dx, dy);
      return;
    }
    const last = looks.current.get(event.pointerId);
    if (!last) return;
    api.current?.look(event.clientX - last.x, event.clientY - last.y);
    last.x = event.clientX;
    last.y = event.clientY;
  };
  const up = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (stick.current?.id === event.pointerId) {
      stick.current = null;
      api.current?.move(0, 0);
      if (knob.current) knob.current.style.transform = "";
      if (ring.current) {
        ring.current.style.left = ring.current.style.top = ring.current.style.bottom = "";
        ring.current.classList.remove("is-on");
      }
    }
    looks.current.delete(event.pointerId);
    api.current?.wake();
  };

  const trigger = (on: boolean) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (on) {
      capture(event);
      looks.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }
    setFiring(on);
    api.current?.fire(on);
  };
  const tap = (act: (controls: TouchApi) => void) => () => { if (api.current) act(api.current); };
  const toggleAim = () => {
    const next = !aiming;
    setAiming(next);
    api.current?.aim(next);
  };

  return (
    <div className="range-touch" ref={layer} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      <div className="touch-stick" ref={ring} aria-hidden="true"><i ref={knob} /><span>MOVE</span></div>
      <button type="button" className="touch-pause" aria-label="Pause" onPointerDown={tap((controls) => controls.pause())}>
        <i aria-hidden="true" /> PAUSE
      </button>
      {weapon && (
        <div className="touch-weapon">
          <button type="button" aria-label="Next weapon" onPointerDown={tap((controls) => controls.nextWeapon())}>
            <strong>{weapon.name}</strong>
            <span>{weapon.reloading ? "RELOADING" : weapon.blade ? "BLADE" : `${weapon.magazine} / ${weapon.capacity}`}</span>
            <em>SWITCH ↻</em>
          </button>
          {weapon.modes.length > 1 && (
            <button type="button" aria-label="Fire mode" onPointerDown={tap((controls) => controls.mode())}>
              <strong>{weapon.mode}</strong>
              <em>MODE ↻</em>
            </button>
          )}
        </div>
      )}
      <button type="button" className={`touch-aim${aiming ? " is-on" : ""}`} aria-pressed={aiming} onPointerDown={toggleAim}>
        {weapon?.scope ? "SCOPE" : "AIM"}
      </button>
      <button type="button" className="touch-reload" onPointerDown={tap((controls) => controls.reload())}>RELOAD</button>
      <button
        type="button"
        className={`touch-fire${firing ? " is-on" : ""}`}
        aria-label="Fire"
        onPointerDown={trigger(true)}
        onPointerUp={trigger(false)}
        onPointerCancel={trigger(false)}
      >
        FIRE
      </button>
    </div>
  );
}
