import { CoreId } from "./objectives";
import { readJson, writeJson, uid } from "./storage";
import { ExamSession, ExamResult } from "./examTypes";

const HISTORY_KEY = "comptia_a_history_v2";

export type Attempt = {
  attemptId: string;
  submittedAtISO: string;
  core: CoreId;
  sessionId: string;
  percent: number;
  correctCount: number;
  total: number;
  durationSeconds: number;
  pbqCount: number;
  byDomain: { domain: string; correct: number; total: number }[];
  byObjective: { objectiveId: string; objectiveTitle: string; correct: number; total: number; accuracy: number }[];
  missedObjectives: { objectiveId: string; objectiveTitle: string; missed: number; total: number }[];
};

export function loadHistory(): Attempt[] {
  return readJson<Attempt[]>(HISTORY_KEY, []);
}

export function clearHistory() {
  writeJson(HISTORY_KEY, []);
}

export function recordAttempt(session: ExamSession, result: ExamResult): Attempt {
  const byObjAgg: Record<string, { title: string; correct: number; total: number }> = {};

  for (const q of session.questions) {
    const scored = result.scored.find((s) => s.questionId === q.id);
    const ok = !!scored?.isCorrect;

    const objId = q.objective;
    const title = q.objectiveTitle || `Objective ${objId}`;

    if (!byObjAgg[objId]) byObjAgg[objId] = { title, correct: 0, total: 0 };
    byObjAgg[objId].total += 1;
    if (ok) byObjAgg[objId].correct += 1;
  }

  const byObjective = Object.entries(byObjAgg).map(([objectiveId, v]) => {
    const accuracy = v.total ? Math.round((v.correct / v.total) * 1000) / 10 : 0;
    return { objectiveId, objectiveTitle: v.title, correct: v.correct, total: v.total, accuracy };
  });

  const missedObjectives = byObjective
    .filter((o) => o.correct < o.total)
    .map((o) => ({ objectiveId: o.objectiveId, objectiveTitle: o.objectiveTitle, missed: o.total - o.correct, total: o.total }))
    .sort((a, b) => b.missed - a.missed);

  const attempt: Attempt = {
    attemptId: uid("attempt"),
    submittedAtISO: new Date().toISOString(),
    core: session.core,
    sessionId: session.sessionId,
    percent: result.percent,
    correctCount: result.correctCount,
    total: result.total,
    durationSeconds: session.durationSeconds,
    pbqCount: session.config.pbqCount,
    byDomain: result.byDomain,
    byObjective: byObjective.sort((a, b) => a.objectiveId.localeCompare(b.objectiveId, undefined, { numeric: true })),
    missedObjectives,
  };

  const history = loadHistory();
  history.unshift(attempt);
  writeJson(HISTORY_KEY, history);

  return attempt;
}

export type ObjectiveTrend = {
  objectiveId: string;
  objectiveTitle: string;
  attempts: number;
  questions: number;
  correct: number;
  accuracy: number;
  trend: number[];
};

export function computeObjectiveTrends(core: CoreId): ObjectiveTrend[] {
  const history = loadHistory().filter((h) => h.core === core);

  const map: Record<string, ObjectiveTrend> = {};
  for (const h of history) {
    for (const o of h.byObjective) {
      if (!map[o.objectiveId]) {
        map[o.objectiveId] = { objectiveId: o.objectiveId, objectiveTitle: o.objectiveTitle, attempts: 0, questions: 0, correct: 0, accuracy: 0, trend: [] };
      }
      map[o.objectiveId].attempts += 1;
      map[o.objectiveId].questions += o.total;
      map[o.objectiveId].correct += o.correct;
      map[o.objectiveId].trend.push(o.accuracy);
    }
  }

  const out = Object.values(map);
  for (const x of out) x.accuracy = x.questions ? Math.round((x.correct / x.questions) * 1000) / 10 : 0;

  return out.sort((a, b) => a.accuracy - b.accuracy);
}
