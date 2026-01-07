import { AnswerMap, ExamResult, ExamSession } from "./examTypes";

function setEq(a: string[], b: string[]) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

export function scoreExam(session: ExamSession, answers: AnswerMap, pbqState?: Record<string, any>): ExamResult {
  let correctCount = 0;
  const scored: { questionId: string; isCorrect: boolean }[] = [];
  const domainAgg: Record<string, { correct: number; total: number }> = {};

  for (const q of session.questions) {
    if (!domainAgg[q.domain]) domainAgg[q.domain] = { correct: 0, total: 0 };
    domainAgg[q.domain].total += 1;

    let ok = false;
    if (q.type === "pbq-order") {
      const order = pbqState?.[q.id]?.order as string[] | undefined;
      ok = !!order && order.length === q.correct.length && order.every((t, i) => t === q.correct[i]);
    } else if (q.type === "pbq-match") {
      const pairs = pbqState?.[q.id]?.pairs as string[] | undefined;
      ok = !!pairs && setEq(pairs, q.correct);
    } else {
      const a = answers[q.id] ?? [];
      ok = setEq(a, q.correct);
    }

    if (ok) {
      correctCount += 1;
      domainAgg[q.domain].correct += 1;
    }
    scored.push({ questionId: q.id, isCorrect: ok });
  }

  const total = session.questions.length;
  const percent = Math.round((correctCount / total) * 1000) / 10;

  const byDomain = Object.entries(domainAgg).map(([domain, v]) => ({ domain, correct: v.correct, total: v.total }));

  return { percent, correctCount, total, byDomain, scored };
}
