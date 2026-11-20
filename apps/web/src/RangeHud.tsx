import type { FireMode } from "./range/arsenalSpec";
import type { HordeHud } from "./range/horde";
import type { IndexMarket, VoteCount, VoteSide } from "./types";

export type WeaponHud = {
  slot: number;
  name: string;
  calibre: string;
  mode: FireMode;
  modes: FireMode[];
  magazine: number;
  capacity: number;
  reloading: boolean;
  /** Aiming is through an optic rather than over the sights. */
  scope: boolean;
  /** Which slots are still carried: a dropped weapon is not, until it is picked up again. */
  owned: boolean[];
};

const SLOTS = ["AK-47", "M4A1", "FAMAS", "UZI", "BOLT", "DEAGLE"];

/** The last YES / NO target struck, with the contracts now staged on that market. */
export type StrikeHud = { id: number; market: IndexMarket; side: VoteSide; streak: number; count: VoteCount };

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** What the shots so far add up to: the contract being built on one market, updated on every hit. */
function StrikeCard({ strike }: { strike: StrikeHud }) {
  const { market, side, count } = strike;
  const price = { YES: market.yes, NO: 100 - market.yes };
  const staged = count[side] || 1, stake = staged * price[side], pays = staged * 100;
  const total = count.YES + count.NO || 1;
  return (
    <>
      <div className={`strike-marker is-${side.toLowerCase()}`} key={`marker-${strike.id}`}>
        <i /><i /><i /><i />
      </div>
      {/* Re-keyed on every hit so the card re-arms its own timeout and pulse. */}
      <div className={`strike-card is-${side.toLowerCase()}`} key={`card-${strike.id}`}>
        <header>
          <span>CONTRACT STAGED</span>
          {strike.streak > 1 && <em>STREAK ×{strike.streak}</em>}
        </header>
        <strong>{market.name}</strong>
        <div className="strike-side">
          <b>{side}</b>
          <span className="strike-count">×{staged}</span>
        </div>
        <dl>
          <div><dt>PRICE</dt><dd>{price[side]}¢</dd></div>
          <div><dt>STAKE</dt><dd>{dollars(stake)}</dd></div>
          <div><dt>PAYS</dt><dd>{dollars(pays)}</dd></div>
          <div><dt>PROFIT</dt><dd>+{dollars(pays - stake)}</dd></div>
        </dl>
        <div className="strike-split" style={{ ["--yes" as string]: `${(count.YES / total) * 100}%` }}>
          <span>YES ×{count.YES}</span>
          <i />
          <span>NO ×{count.NO}</span>
        </div>
        <footer><kbd>E</kbd> REVIEW · NOTHING SENT YET</footer>
      </div>
    </>
  );
}

export function RangeHud({ weapon, horde, strike }: { weapon: WeaponHud | null; horde: HordeHud | null; strike: StrikeHud | null }) {
  const playing = horde && horde.phase !== "idle";
  return (
    <div className={`range-hud${playing ? " is-horde" : ""}`} aria-live="off">
      {weapon && (
        <div className="weapon-hud">
          <ol>
            {SLOTS.map((label, index) => (
              <li key={label} className={index === weapon.slot ? "is-active" : weapon.owned[index] ? undefined : "is-gone"}>
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
          <div className="weapon-hud-mode">
            <i>{weapon.scope ? "SCOPE" : "AIM"}</i>
            <kbd>RMB</kbd>
          </div>
        </div>
      )}
      {strike && !playing && <StrikeCard strike={strike} />}
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
