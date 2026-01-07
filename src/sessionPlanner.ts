import { CoreId, listObjectivesByDomain, getObjectiveMeta } from "./objectives";
import { QuestionType, SessionConfig, ExamSession, Question } from "./examTypes";

export const EXAM_QUESTION_COUNT = 90;
export const EXAM_DURATION_SECONDS = 90 * 60;

type DomainBlueprint = { domainNumber: string; domainLabel: string; weight: number };

const CORE1_BLUEPRINT: DomainBlueprint[] = [
  { domainNumber: "1.0", domainLabel: "Mobile Devices", weight: 13 },
  { domainNumber: "2.0", domainLabel: "Networking", weight: 23 },
  { domainNumber: "3.0", domainLabel: "Hardware", weight: 25 },
  { domainNumber: "4.0", domainLabel: "Virtualization and Cloud Computing", weight: 11 },
  { domainNumber: "5.0", domainLabel: "Hardware and Network Troubleshooting", weight: 28 },
];

const CORE2_BLUEPRINT: DomainBlueprint[] = [
  { domainNumber: "1.0", domainLabel: "Operating Systems", weight: 28 },
  { domainNumber: "2.0", domainLabel: "Security", weight: 28 },
  { domainNumber: "3.0", domainLabel: "Software Troubleshooting", weight: 23 },
  { domainNumber: "4.0", domainLabel: "Operational Procedures", weight: 21 },
];

function allocateByWeight(total: number, blueprint: DomainBlueprint[]) {
  const sum = blueprint.reduce((s, d) => s + d.weight, 0);
  const raw = blueprint.map((d) => ({ key: d.domainNumber, exact: (d.weight / sum) * total, floor: Math.floor((d.weight / sum) * total) }));
  const used = raw.reduce((s, r) => s + r.floor, 0);
  let remaining = total - used;

  const byRemainder = raw.map((r) => ({ ...r, rem: r.exact - r.floor })).sort((a, b) => b.rem - a.rem);

  const counts: Record<string, number> = {};
  for (const r of raw) counts[r.key] = r.floor;
  for (let i = 0; i < remaining; i++) counts[byRemainder[i % byRemainder.length].key] += 1;

  return counts;
}

function pickOne<T>(arr: T[]) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export type QuestionPlanItem = {
  domainNumber: string;
  domainLabel: string;
  objectiveId: string;
  objectiveTitle: string;
  objectiveBullets: string[];
  type: QuestionType;
};

export function buildPlan(core: CoreId, config: SessionConfig): QuestionPlanItem[] {
  const blueprint = core === "220-1201" ? CORE1_BLUEPRINT : CORE2_BLUEPRINT;
  const allocation = allocateByWeight(EXAM_QUESTION_COUNT, blueprint);

  const plan: QuestionPlanItem[] = [];

  for (const d of blueprint) {
    const count = allocation[d.domainNumber] ?? 0;
    const objectiveIds = listObjectivesByDomain(core, d.domainNumber);

    for (let i = 0; i < count; i++) {
      const objId = objectiveIds.length ? pickOne(objectiveIds) : `${d.domainNumber.split(".")[0]}.1`;
      const meta = getObjectiveMeta(core, objId);
      plan.push({
        domainNumber: d.domainNumber,
        domainLabel: d.domainLabel,
        objectiveId: objId,
        objectiveTitle: meta?.title ?? `Objective ${objId}`,
        objectiveBullets: meta?.bullets ?? [],
        type: "single",
      });
    }
  }

  // Inject PBQs
  const pbqCount = Math.max(0, Math.min(config.pbqCount, 12));
  for (let i = 0; i < pbqCount; i++) {
    const idx = Math.floor(Math.random() * plan.length);
    plan[idx] = {
      ...plan[idx],
      type: Math.random() < 0.5 ? "pbq-order" : "pbq-match",
    };
  }

  // Sprinkle some multi-selects
  const multiCount = Math.min(10, Math.floor(plan.length * 0.12));
  for (let i = 0; i < multiCount; i++) {
    const idx = Math.floor(Math.random() * plan.length);
    if (plan[idx].type === "single") plan[idx] = { ...plan[idx], type: "multi" };
  }

  return plan.slice(0, EXAM_QUESTION_COUNT);
}

export function createEmptySession(core: CoreId, config: SessionConfig): ExamSession {
  const sessionId = `${core}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    sessionId,
    core,
    createdAtISO: new Date().toISOString(),
    durationSeconds: EXAM_DURATION_SECONDS,
    config,
    questions: [],
  };
}

// Helper to adapt AI output to internal Question
export function normalizeQuestions(core: CoreId, sessionId: string, items: any[]): Question[] {
  let seq = 0;
  const out: Question[] = [];

  for (const it of items) {
    seq += 1;
    const id = `${sessionId}-q-${seq}`;
    const objective = String(it.objectiveId);
    const objectiveTitle = String(it.objectiveTitle || `Objective ${objective}`);
    const objectiveBullets = Array.isArray(it.objectiveBullets) ? it.objectiveBullets.map(String) : [];
    const domain = String(it.domain || `${objective.split(".")[0]}.0`);

    const type = it.type as any;
    const prompt = String(it.prompt || "");
    const explanation = String(it.explanation || "Review the objective and rationale.");

    if (type === "single" || type === "multi") {
      const options = (it.options ?? []).map((t: any, i: number) => ({ id: `o${i + 1}`, text: String(t) }));
      const correctIdx = Array.isArray(it.correctIndices) ? it.correctIndices.map((n: any) => Number(n)) : [];
      const correct = correctIdx.map((i: number) => options[i]?.id).filter(Boolean);
      out.push({ id, core, domain, objective, objectiveTitle, objectiveBullets, type, prompt, options, correct, explanation });
      continue;
    }

    if (type === "pbq-order") {
      const baseItems = (it.orderItems ?? []).map((t: any, i: number) => ({ id: `s${i + 1}`, text: String(t) }));
      // Display shuffled to simulate PBQ
      const shuffled = [...baseItems].sort(() => Math.random() - 0.5);
      const orderIdx = Array.isArray(it.correctOrder) ? it.correctOrder.map((n: any) => Number(n)) : [];
      const correct = orderIdx.map((i: number) => baseItems[i]?.text).filter(Boolean);
      out.push({ id, core, domain, objective, objectiveTitle, objectiveBullets, type, prompt, correct, explanation, pbq: { kind: "order", items: shuffled } });
      continue;
    }

    if (type === "pbq-match") {
      const left = (it.left ?? []).map((t: any, i: number) => ({ id: `l${i + 1}`, text: String(t) }));
      const right = (it.right ?? []).map((t: any, i: number) => ({ id: `r${i + 1}`, text: String(t) }));
      const pairs = Array.isArray(it.correctPairs) ? it.correctPairs : [];
      const correct = pairs
        .map((p: any) => `${left[Number(p.leftIndex)]?.text}=>${right[Number(p.rightIndex)]?.text}`)
        .filter((x: any) => typeof x === "string" && !x.startsWith("undefined"));
      out.push({
        id,
        core,
        domain,
        objective,
        objectiveTitle,
        objectiveBullets,
        type,
        prompt,
        correct,
        explanation,
        pbq: { kind: "match", leftLabel: String(it.leftLabel || "Left"), rightLabel: String(it.rightLabel || "Right"), left, right },
      });
      continue;
    }
  }

  return out;
}
