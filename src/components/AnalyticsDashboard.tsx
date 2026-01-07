import React, { useMemo, useState } from "react";
import { CoreId } from "../objectives";
import { clearHistory, computeObjectiveTrends, loadHistory } from "../analytics";
import { Sparkline } from "./Sparkline";

export function AnalyticsDashboard({ core, onClose }: { core: CoreId; onClose: () => void }) {
  const [selectedCore, setSelectedCore] = useState<CoreId>(core);

  const history = useMemo(() => loadHistory().filter((h) => h.core === selectedCore), [selectedCore]);
  const trends = useMemo(() => computeObjectiveTrends(selectedCore), [selectedCore]);

  const scoreTrend = history.slice().reverse().map((h) => h.percent);

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Analytics Dashboard</h2>
        <button className="btn ghost" onClick={onClose}>Close</button>
      </div>

      <div className="row">
        <label className="radio">
          <input type="radio" checked={selectedCore === "220-1201"} onChange={() => setSelectedCore("220-1201")} />
          <span><b>Core 1</b></span>
        </label>
        <label className="radio">
          <input type="radio" checked={selectedCore === "220-1202"} onChange={() => setSelectedCore("220-1202")} />
          <span><b>Core 2</b></span>
        </label>
      </div>

      <div className="note">
        <b>Score trend (latest at right):</b>
        <div style={{ marginTop: 8, color: "var(--text)" }}>
          <Sparkline values={scoreTrend} />
        </div>
        <div className="muted small">Attempts: {history.length}</div>
      </div>

      <h3>Weak objectives (lowest accuracy)</h3>
      <div className="table">
        <div className="trow thead">
          <div>Objective</div>
          <div>Accuracy</div>
          <div>Attempts</div>
          <div>Trend</div>
        </div>
        {trends.slice(0, 12).map((t) => (
          <div className="trow" key={t.objectiveId}>
            <div>
              <b>{t.objectiveId}</b>
              <div className="muted small">{t.objectiveTitle}</div>
            </div>
            <div>{t.accuracy}%</div>
            <div>{t.attempts}</div>
            <div><Sparkline values={t.trend.slice().reverse()} /></div>
          </div>
        ))}
      </div>

      <h3>Attempt history</h3>
      <div className="table">
        <div className="trow thead">
          <div>Date</div>
          <div>Score</div>
          <div>Correct</div>
          <div>PBQs</div>
        </div>
        {history.slice(0, 15).map((h) => (
          <div className="trow" key={h.attemptId}>
            <div>{new Date(h.submittedAtISO).toLocaleString()}</div>
            <div>{h.percent}%</div>
            <div>{h.correctCount}/{h.total}</div>
            <div>{h.pbqCount}</div>
          </div>
        ))}
      </div>

      <div className="row">
        <button className="btn danger" onClick={() => { clearHistory(); window.location.reload(); }}>
          Clear History
        </button>
      </div>
    </div>
  );
}
