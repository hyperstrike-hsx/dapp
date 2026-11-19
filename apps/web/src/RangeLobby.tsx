import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { RANGE_MAPS, type RangeMapId } from "./range/mapList";

type Props = {
  /** The range that is loaded behind this screen. */
  current: RangeMapId;
  /** True once the visitor has been in the range: this is then a pause screen. */
  entered: boolean;
  /** Played with on-screen controls rather than a mouse and keys. */
  touch: boolean;
  onDeploy: () => void;
  /** Loads another range and goes straight into it. */
  onLoad: (id: RangeMapId) => void;
  onFoundry: () => void;
  onChart: () => void;
  /** The frame-rate readout and quality switch, which live in this screen's header while it is up. */
  tools: ReactNode;
};

const CONTROLS: Array<[string, string]> = [
  ["WASD", "move"],
  ["MOUSE", "aim"],
  ["HOLD", "fire"],
  ["R", "reload"],
  ["E", "review"],
  ["1–6", "weapons"],
  ["M", "mute"],
];
const TOUCH_CONTROLS: Array<[string, string]> = [
  ["LEFT THUMB", "move"],
  ["DRAG", "aim"],
  ["FIRE", "hold"],
  ["TAP PROMPT", "review"],
];

// On a narrow screen the briefing is one long column, so its one action is docked to the bottom edge.
const NARROW = "(max-width: 900px)";
const watchNarrow = (changed: () => void) => {
  const query = window.matchMedia(NARROW);
  query.addEventListener("change", changed);
  return () => query.removeEventListener("change", changed);
};
const isNarrow = () => window.matchMedia(NARROW).matches;

/**
 * The briefing shown whenever the pointer is free: before deploying and while paused. It covers
 * the live scene with a blurred, darkened sheet so the text reads against any map, says what the
 * loaded range is, and lets the visitor look at the others (picture, description, conditions)
 * before deciding on one. Looking is free; DEPLOY TO swaps the scene and goes straight into it.
 */
export function RangeLobby({ current, entered, touch, onDeploy, onLoad, onFoundry, onChart, tools }: Props) {
  const docked = useSyncExternalStore(watchNarrow, isNarrow, () => false);
  const [shown, setShown] = useState<RangeMapId>(current);
  const [missing, setMissing] = useState<Record<string, boolean>>({});
  const cards = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => setShown(current), [current]);
  // Where the ranges are a sideways strip, keep the one being looked at in view. Only the strip
  // moves: scrollIntoView would also pull the whole briefing down on a phone.
  const strip = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const row = strip.current, card = cards.current[RANGE_MAPS.findIndex((entry) => entry.id === shown)];
    if (!row || !card || row.scrollWidth <= row.clientWidth + 1) return;
    row.scrollTo({ left: card.offsetLeft - (row.clientWidth - card.offsetWidth) / 2, behavior: "smooth" });
  }, [shown]);

  const info = RANGE_MAPS.find((entry) => entry.id === shown) ?? RANGE_MAPS[0];
  const loaded = shown === current;
  const picture = (id: string) => `/maps/${id}.jpg`;
  const noPicture = (id: string) => setMissing((was) => (was[id] ? was : { ...was, [id]: true }));

  const onKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = RANGE_MAPS.findIndex((entry) => entry.id === shown);
    // Two rows of five on a tall window, one sideways strip otherwise: count what shares the first row.
    const top = cards.current[0]?.offsetTop ?? 0;
    const perRow = cards.current.filter((card) => card && card.offsetTop === top).length || 1;
    const columns = perRow >= RANGE_MAPS.length ? 1 : perRow;
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns }[event.key];
    const next = event.key === "Home" ? 0 : event.key === "End" ? RANGE_MAPS.length - 1 : step === undefined ? -1 : index + step;
    if (next < 0 || next >= RANGE_MAPS.length || next === index) return;
    event.preventDefault();
    setShown(RANGE_MAPS[next].id);
    cards.current[next]?.focus();
  };

  const action = loaded ? (
    <button className="range-enter" onClick={onDeploy}>
      <strong>{entered ? "RESUME OPERATION" : "DEPLOY TO THE RANGE"}{"\u00a0"}↗</strong>
    </button>
  ) : (
    <div className="lobby-switch">
      <button className="range-load" onClick={() => onLoad(shown)}>
        <strong>DEPLOY TO {info.name}{"\u00a0"}↗</strong>
      </button>
      <button className="lobby-back" onClick={() => setShown(current)}>
        Back to {RANGE_MAPS.find((entry) => entry.id === current)?.name}
      </button>
    </div>
  );

  return (
    <section className={`range-lobby ${entered ? "paused" : ""} ${docked ? "docked" : ""}`} aria-label="Range briefing">
      <div className="lobby-shell">
        <header className="lobby-top">
          <strong>{entered ? "PAUSED" : "RANGE BRIEFING"}</strong>
          <div className="range-utilities">
            <button onClick={onFoundry}>STRIKE FOUNDRY ↗</button>
            <button onClick={onChart}>$HSX CANDLE CHART ↗</button>
          </div>
          {tools}
        </header>
        <div className="lobby-brief">
          <figure className="lobby-shot">
            {missing[info.id] ? (
              <div className="lobby-shot-blank" aria-hidden="true">{info.code}</div>
            ) : (
              <img key={info.id} src={picture(info.id)} alt={`View of ${info.name}`} onError={() => noPicture(info.id)} />
            )}
            <figcaption>
              <span>RANGE {info.code}</span>
              <em className={loaded ? "on" : ""}>{loaded ? "LOADED" : "PREVIEW"}</em>
            </figcaption>
          </figure>
          <div className="lobby-about">
            <span className="lobby-eyebrow">{entered ? "OPERATION PAUSED" : "THE ECONOMY IS YOUR TARGET."}</span>
            <h2>{info.name}</h2>
            <p className="lobby-line">{info.line}</p>
            <p className="lobby-text">{info.brief}</p>
            <dl className="lobby-facts">
              <div><dt>SETTING</dt><dd>{info.setting}</dd></div>
              <div><dt>LIGHT</dt><dd>{info.light}</dd></div>
              <div><dt>AIR</dt><dd>{info.air}</dd></div>
              <div><dt>SOUND</dt><dd>{info.sound}</dd></div>
            </dl>
            {!docked && action}
            <p className="lobby-hint">
              {loaded
                ? (touch ? TOUCH_CONTROLS : CONTROLS).map(([key, does]) => (
                    <span key={key}><kbd>{key}</kbd>{does}</span>
                  ))
                : entered
                  ? "Deploying to another range ends the session in progress."
                  : "Loading takes a few seconds. Your staged orders are kept."}
            </p>
          </div>
        </div>

        <div className="lobby-maps-head">
          <strong>CHOOSE A RANGE</strong>
          <span>Same lanes, stations and targets everywhere. The place, the light and the sound change.</span>
        </div>
        <div className="lobby-maps" ref={strip} role="radiogroup" aria-label="Range" onKeyDown={onKeys}>
          {RANGE_MAPS.map((entry, index) => (
            <button
              key={entry.id}
              ref={(node) => { cards.current[index] = node; }}
              role="radio"
              aria-checked={entry.id === shown}
              tabIndex={entry.id === shown ? 0 : -1}
              className={`${entry.id === shown ? "shown" : ""} ${entry.id === current ? "loaded" : ""}`}
              onClick={() => setShown(entry.id)}
              onDoubleClick={() => { if (entry.id !== current) onLoad(entry.id); }}
            >
              <span className="lobby-thumb">
                {missing[entry.id] ? (
                  <i aria-hidden="true">{entry.code}</i>
                ) : (
                  <img src={picture(entry.id)} alt="" loading="lazy" onError={() => noPicture(entry.id)} />
                )}
                {entry.id === current && <b>LOADED</b>}
              </span>
              <span className="lobby-card-text">
                <small>RANGE {entry.code}</small>
                <strong>{entry.name}</strong>
                <em>{entry.line}</em>
              </span>
            </button>
          ))}
        </div>

        {docked && <div className="lobby-dock">{action}</div>}
      </div>
    </section>
  );
}
