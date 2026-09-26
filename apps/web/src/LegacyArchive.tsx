import { useState } from "react";
const keys = [
  ["hyperstrike.paperPredictions.v1", "Historical skin paper predictions"],
  ["hyperstrike.demoWorldCupPredictions.v1", "World Cup demo predictions"],
  [
    "hyperstrike.liveWorldCupPredictions.v1",
    "Legacy World Cup records — onchain status unverified",
  ],
] as const;
export function LegacyArchive() {
  const [open, setOpen] = useState(false);
  const records = keys
    .map(([key, label]) => {
      try {
        const data = JSON.parse(localStorage.getItem(key) ?? "null");
        return { key, label, data };
      } catch {
        return { key, label, data: null };
      }
    })
    .filter((r) => r.data);
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(records, null, 2)], {
        type: "application/json",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "hyperstrike-historical-portfolio.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <section className="activity-feed onchain-portfolio">
      <h3>Historical portfolio archive</h3>
      <p>
        Older skin and World Cup records remain unchanged. They are not migrated
        into index positions or treated as verified onchain holdings.
      </p>
      {records.length ? (
        <>
          <button className="secondary" onClick={() => setOpen(!open)}>
            {open ? "HIDE" : "VIEW"} HISTORICAL RECORDS
          </button>{" "}
          <button className="secondary" onClick={download}>
            EXPORT JSON
          </button>
          {open &&
            records.map((r) => (
              <details key={r.key}>
                <summary>
                  {r.label} · {Array.isArray(r.data) ? r.data.length : "saved"}{" "}
                  records
                </summary>
                <pre className="archive-records">
                  {JSON.stringify(r.data, null, 2)}
                </pre>
              </details>
            ))}
        </>
      ) : (
        <p>No historical records in this browser.</p>
      )}
    </section>
  );
}
