import React from "react";

export function Sparkline({ values }: { values: number[] }) {
  const w = 120;
  const h = 28;
  if (!values || values.length === 0) return <span style={{ color: "var(--muted)" }}>—</span>;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = 2;

  const scaleX = (i: number) => (values.length === 1 ? w / 2 : (i / (values.length - 1)) * (w - pad * 2) + pad);
  const scaleY = (v: number) => {
    if (max === min) return h / 2;
    const t = (v - min) / (max - min);
    return (h - pad) - t * (h - pad * 2);
  };

  const points = values.map((v, i) => `${scaleX(i)},${scaleY(v)}`).join(" ");

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: "block" }}>
      <polyline fill="none" stroke="currentColor" strokeWidth="2" points={points} opacity={0.85} />
    </svg>
  );
}
