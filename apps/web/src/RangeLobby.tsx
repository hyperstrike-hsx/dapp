import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { RANGE_MAPS, type RangeMapId } from "./range/mapList";

type Props = {
  /** The range that is loaded behind this screen. */
  current: RangeMapId;
  /** True once the visitor has been in the range: this is then a pause screen. */
  entered: boolean;
  /** Played with on-screen controls rather than a mouse and keys. */
  touch: boolean;
  /** Goes into (or back into) the loaded range. */
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
 * the live scene with a blurred, darkened sheet so the text reads against any map and says what
 * the loaded range is. Picking is one step: a click on a range's card loads it and goes straight
 * into play (on the loaded one, straight back in). Pointing at a card, or reaching it with the
 * keyboard, is enough to read about it first.
 */
export function RangeLobby({ current, entered, touch, onDeploy, onLoad, onFoundry, onChart, tools }: Props) {
  const docked = useSyncExternalStore(watchNarrow, isNarrow, () => false);
  /** The range being read about without being loaded: under the mouse, or reached with the keyboard. */
  const [peek, setPeek] = useState<RangeMapId | null>(null);
  const [missing, setMissing] = useState<Record<string, boolean>>({});
  const cards = useRef<Array<HTMLButtonElement | null>>([]);
  const strip = useRef<HTMLDivElement | null>(null);
  // Where the ranges are a sideways strip, bring a card into view. Only the strip moves:
  // scrollIntoView would also pull the whole briefing down on a phone.
  const reveal = (index: number) => {
    const row = strip.current, card = cards.current[index];
    if (!row || !card || row.scrollWidth <= row.clientWidth + 1) return;
    row.scrollTo({ left: card.offsetLeft - (row.clientWidth - card.offsetWidth) / 2, behavior: "smooth" });
  };
  useEffect(() => {
    setPeek(null);
    reveal(RANGE_MAPS.findIndex((entry) => entry.id === current));
  }, [current]);

  const shown = peek ?? current;
  const info = RANGE_MAPS.find((entry) => entry.id === shown) ?? RANGE_MAPS[0];
  const loaded = shown === current;
  const picture = (id: string) => `/maps/${id}.jpg`;
  const noPicture = (id: string) => setMissing((was) => (was[id] ? was : { ...was, [id]: true }));
  const pick = (id: RangeMapId) => (id === current ? onDeploy() : onLoad(id));

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
    setPeek(RANGE_MAPS[next].id);
    cards.current[next]?.focus({ preventScroll: true });
    reveal(next);
  };

  // The one button belongs to the loaded range. Another range is entered from its own card.
  const action = (
    <button className="range-enter" onClick={onDeploy} disabled={!loaded}>
      <strong>{entered ? "RESUME OPERATION" : "DEPLOY TO THE RANGE"}{" "}↗</strong>
    </button>
  );
  // Every range's text sits in the same cell, so the panel is as tall as the longest and nothing
  // below it moves while the mouse travels over the cards. One long column has no mouse to follow.
  const sheets = docked ? [info] : RANGE_MAPS;

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
            <div className="lobby-sheets">
              {sheets.map((entry) => (
                <div key={entry.id} className="lobby-sheet" aria-hidden={entry.id !== shown} data-shown={entry.id === shown || undefined}>
                  <h2>{entry.name}</h2>
                  <p className="lobby-line">{entry.line}</p>
                  <p className="lobby-text">{entry.brief}</p>
                  <dl className="lobby-facts">
                    <div><dt>SETTING</dt><dd>{entry.setting}</dd></div>
                    <div><dt>LIGHT</dt><dd>{entry.light}</dd></div>
                    <div><dt>AIR</dt><dd>{entry.air}</dd></div>
                    <div><dt>SOUND</dt><dd>{entry.sound}</dd></div>
                  </dl>
                </div>
              ))}
            </div>
            {!docked && (
              <div className="lobby-action" data-peek={!loaded || undefined}>
                {action}
                <p className="lobby-pick" aria-hidden={loaded}>
                  <strong>{touch ? "TAP" : "CLICK"} TO DEPLOY HERE{" "}↗</strong>
                  <span>
                    {entered
                      ? "This ends the session in progress. Your staged orders are kept."
                      : "Loading takes a few seconds. Your staged orders are kept."}
                  </span>
                </p>
              </div>
            )}
            <p className="lobby-hint">
              {(touch ? TOUCH_CONTROLS : CONTROLS).map(([key, does]) => (
                <span key={key}><kbd>{key}</kbd>{does}</span>
              ))}
            </p>
          </div>
        </div>

        <div className="lobby-maps-head">
          <strong>{touch ? "TAP A RANGE TO DEPLOY" : "CLICK A RANGE TO DEPLOY"}</strong>
          <span>Same lanes, stations and targets everywhere. The place, the light and the sound change.</span>
        </div>
        <div
          className="lobby-maps"
          ref={strip}
          role="group"
          aria-label="Ranges"
          onKeyDown={onKeys}
          onPointerLeave={(event) => { if (event.pointerType === "mouse") setPeek(null); }}
          onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setPeek(null); }}
        >
          {RANGE_MAPS.map((entry, index) => (
            <button
              key={entry.id}
              ref={(node) => { cards.current[index] = node; }}
              aria-current={entry.id === current || undefined}
              aria-label={`${entry.name}, range ${entry.code}: ${entry.id === current ? (entered ? "loaded, resume" : "loaded, deploy") : "load and deploy"}`}
              tabIndex={entry.id === shown ? 0 : -1}
              className={`${entry.id === shown ? "shown" : ""} ${entry.id === current ? "loaded" : ""}`}
              onClick={() => pick(entry.id)}
              onPointerEnter={(event) => { if (event.pointerType === "mouse") setPeek(entry.id); }}
              onFocus={(event) => { if (event.currentTarget.matches(":focus-visible")) setPeek(entry.id); }}
            >
              <span className="lobby-thumb">
                {missing[entry.id] ? (
                  <i aria-hidden="true">{entry.code}</i>
                ) : (
                  <img src={picture(entry.id)} alt="" loading="lazy" onError={() => noPicture(entry.id)} />
                )}
                {entry.id === current && <b>LOADED</b>}
                <u aria-hidden="true">{entry.id === current && entered ? "RESUME" : "DEPLOY"}{" "}↗</u>
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
