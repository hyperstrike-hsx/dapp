import { useEffect, useState, useSyncExternalStore } from "react";
import { cycleRangeVolume, onRangeVolume, rangeVolume } from "./range/volume";

export function RangePerformance({
  quality,
  onQuality,
}: {
  quality: "HIGH" | "PERFORMANCE";
  onQuality: (q: "HIGH" | "PERFORMANCE") => void;
}) {
  const [fps, setFps] = useState("—");
  const volume = useSyncExternalStore(onRangeVolume, rangeVolume);
  useEffect(() => {
    const timer = setInterval(
      () =>
        setFps(
          document.querySelector<HTMLElement>(".world-canvas")?.dataset.fps ??
            "—",
        ),
      1000,
    );
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="range-performance">
      <span>{fps} FPS</span>
      <button
        onClick={() => onQuality(quality === "HIGH" ? "PERFORMANCE" : "HIGH")}
        title="High: floor reflections, volumetric sun shafts, contact occlusion, 4K sun shadows, up to 4 MP. Performance: none of those, 2K shadows, up to 1.8 MP. Only changes when clicked."
      >
        {quality} ↻
      </button>
      <button
        className="range-volume"
        onClick={cycleRangeVolume}
        title="Range sound: guns, the map's ambience and wildlife. Click to step the level; M mutes while playing."
      >
        {volume > 0 ? `SOUND ${Math.round(volume * 100)}` : "MUTED"}
      </button>
    </div>
  );
}
