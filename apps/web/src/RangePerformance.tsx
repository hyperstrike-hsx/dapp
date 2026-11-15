import { useEffect, useState } from "react";
export function RangePerformance({
  quality,
  onQuality,
}: {
  quality: "HIGH" | "PERFORMANCE";
  onQuality: (q: "HIGH" | "PERFORMANCE") => void;
}) {
  const [fps, setFps] = useState("—");
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
        title="High: floor reflections, volumetric sun shafts, contact occlusion, 4K sun shadows, up to 2.8 MP. Performance: none of those, 2K shadows, up to 1.3 MP. Only changes when clicked."
      >
        {quality} ↻
      </button>
    </div>
  );
}
