import type { FireMode } from "./range/arsenalSpec";
import type { HordeHud } from "./range/horde";

export type WeaponHud = {
  slot: number;
  name: string;
  calibre: string;
  mode: FireMode;
  modes: FireMode[];
  magazine: number;
  capacity: number;
  reloading: boolean;
};

const SLOTS = ["AK-47", "M4A1", "FAMAS", "UZI", "BOLT"];

export function RangeHud({ weapon, horde }: { weapon: WeaponHud | null; horde: HordeHud | null }) {
  const playing = horde && horde.phase !== "idle";
  return (
    <div className={`range-hud${playing ? " is-horde" : ""}`} aria-live="off">
      {weapon && (
        <div className="weapon-hud">
          <ol>
            {SLOTS.map((label, index) => (
              <li key={label} className={index === weapon.slot ? "is-active" : undefined}>
                <kbd>{index + 1}</kbd>
                {label}
              </li>
            ))}
          </ol>
          <div className="weapon-hud-name">
            <strong>{weapon.name}</strong>
            <span>{weapon.calibre}</span>
          </div>
          <div className="weapon-hud-mode">
            {weapon.modes.map((mode) => (
              <i key={mode} className={mode === weapon.mode ? "is-active" : undefined}>
                {mode}
              </i>
            ))}
            {weapon.modes.length > 1 && <kbd>V</kbd>}
          </div>
        </div>
      )}
      {playing && horde && (
        <>
          <div className="horde-vignette" key={`hurt-${horde.hurtId}`} data-hurt={horde.hurtId > 0 ? "" : undefined} style={{ ["--danger" as string]: String(Math.max(0, 1 - horde.health / 60)) }} />
          {horde.hitId > 0 && (
            <div className={`horde-hitmarker${horde.headshot ? " is-headshot" : ""}`} key={`hit-${horde.hitId}`}>
              <i /><i /><i /><i />
            </div>
          )}
          <div className="horde-top">
            <div>
              <span>WAVE</span>
              <strong>{horde.wave || "—"}</strong>
            </div>
            <div>
              <span>{horde.phase === "break" || horde.phase === "intro" ? "NEXT WAVE" : "REMAINING"}</span>
              <strong>{horde.phase === "break" || horde.phase === "intro" ? `${horde.countdown}s` : horde.remaining}</strong>
            </div>
            <div>
              <span>SCORE</span>
              <strong>{horde.score.toLocaleString("en-US")}</strong>
            </div>
            <div>
              <span>KILLS</span>
              <strong>{horde.kills}</strong>
            </div>
          </div>
          {horde.multiplier > 1 && (
            <div className="horde-combo" key={`combo-${horde.multiplier}`}>
              ×{horde.multiplier}
              <span style={{ width: `${Math.min(100, (horde.combo / 3.6) * 100)}%` }} />
            </div>
          )}
          {horde.boost > 0 && <div className="horde-boost">OVERDRIVE {Math.ceil(horde.boost)}s</div>}
          {horde.banner && horde.phase !== "over" && (
            <div className="horde-banner" key={`banner-${horde.bannerId}`}>
              <strong>{horde.banner}</strong>
              {horde.detail && <span>{horde.detail}</span>}
            </div>
          )}
          <div className="horde-health">
            <span>HEALTH</span>
            <div><i style={{ width: `${horde.health}%` }} data-low={horde.health < 36 ? "" : undefined} /></div>
            <strong>{horde.health}</strong>
          </div>
          {horde.phase === "over" && (
            <div className="horde-over">
              <span>YOU WERE OVERRUN</span>
              <strong>{horde.score.toLocaleString("en-US")}</strong>
              <p>
                WAVE {horde.wave} · {horde.kills} KILLS · BEST {horde.best.toLocaleString("en-US")}
              </p>
              <p>
                <kbd>ENTER</kbd> FIGHT AGAIN <kbd>BACKSPACE</kbd> RETURN TO THE RANGE
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
