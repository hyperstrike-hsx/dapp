import { readSportsReceipts } from "./sportsDemoData";

export function SportsDemoRecords({ onPlay }: { onPlay?: () => void }) {
  let records;
  try {
    records = readSportsReceipts();
  } catch {
    return (
      <p>
        Sports demo receipts could not be read. Your saved data has not been
        changed.
      </p>
    );
  }
  if (!records.length)
    return (
      <section className="portfolio-empty">
        <span className="overline">THE STADIUM IS CALLING</span>
        <h2>Make your first call.</h2>
        <p>
          Lock your power, score a goal, and save a demo prediction. Your
          receipts will live here, separate from real holdings.
        </p>
        {onPlay && (
          <button className="primary" onClick={onPlay}>
            ENTER THE STADIUM ↗
          </button>
        )}
      </section>
    );
  return (
    <section className="sports-records">
      <div className="section-heading">
        <h2>Your stadium calls.</h2>
        {onPlay && (
          <button className="secondary" onClick={onPlay}>
            BACK TO THE ARENA ↗
          </button>
        )}
      </div>
      <p>
        World Cup replay · Local simulation only. No real holdings, burns or
        payouts.
      </p>
      <div className="sports-record-grid">
        {records
          .filter((r) => r && typeof r.marketName === "string")
          .map((r, i) => (
            <article className="sports-record" key={`${r.id}-${i}`}>
              <header>
                <span className={`outcome-pill ${r.side.toLowerCase()}`}>
                  {r.side} / DEMO
                </span>
                <span>SAVED RECEIPT</span>
              </header>
              <h3>
                {r.marketName}
                <span>to lift the trophy</span>
              </h3>
              <div className="sports-record-stats">
                <div>
                  <small>CONTRACTS</small>
                  <strong>{r.contracts}</strong>
                </div>
                <div>
                  <small>DEMO COST</small>
                  <strong>${Number(r.orderValue).toFixed(2)}</strong>
                </div>
              </div>
              <footer>
                <time>{new Date(r.createdAt).toLocaleString()}</time>
                <span>NO REAL PAYOUT</span>
              </footer>
            </article>
          ))}
      </div>
    </section>
  );
}
