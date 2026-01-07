import { CoreId, OBJECTIVES, listObjectiveIds } from "./objectives";
import { Question, SessionConfig } from "./examTypes";
import { QuestionPlanItem } from "./sessionPlanner";

type RNG = { next: () => number };

function hashStringToSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): RNG {
  let t = seed >>> 0;
  return {
    next: () => {
      t += 0x6D2B79F5;
      let x = t;
      x = Math.imul(x ^ (x >>> 15), x | 1);
      x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    },
  };
}

function pickOne<T>(rng: RNG, arr: T[]): T {
  return arr[Math.floor(rng.next() * arr.length)];
}

function shuffle<T>(rng: RNG, arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function takeDistinct<T>(rng: RNG, arr: T[], n: number): T[] {
  if (n <= 0) return [];
  return shuffle(rng, arr).slice(0, Math.min(n, arr.length));
}

function makeOptionIds(n: number): string[] {
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  return Array.from({ length: n }, (_, i) => alpha[i] ?? `O${i + 1}`);
}

function sanitizeText(s: string): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

/**
 * PBQ templates (offline).
 * These are intentionally generic, exam-like, and do not copy CompTIA content verbatim.
 */
function pbqTemplates(core: CoreId) {
  const common = [
    {
      kind: "order" as const,
      id: "pbq-troubleshoot-order",
      title: "Troubleshooting methodology",
      prompt: "Put the standard troubleshooting steps in the correct order.",
      items: [
        "Identify the problem",
        "Establish a theory of probable cause",
        "Test the theory to determine the cause",
        "Establish a plan of action and implement the solution",
        "Verify full system functionality and implement preventive measures",
        "Document findings, actions, and outcomes",
      ],
    },
  ];

  const core1 = [
    {
      kind: "match" as const,
      id: "pbq-ports-match",
      title: "Ports and protocols",
      prompt: "Match each port number to the correct protocol/service.",
      leftLabel: "Port",
      rightLabel: "Service",
      pairs: [
        ["22", "SSH"],
        ["53", "DNS"],
        ["80", "HTTP"],
        ["443", "HTTPS"],
      ],
    },
    {
      kind: "match" as const,
      id: "pbq-wifi-match",
      title: "Wi‑Fi standards",
      prompt: "Match each Wi‑Fi generation to the correct standard label.",
      leftLabel: "Generation",
      rightLabel: "Standard",
      pairs: [
        ["Wi‑Fi 5", "802.11ac"],
        ["Wi‑Fi 6", "802.11ax"],
        ["Wi‑Fi 4", "802.11n"],
        ["Wi‑Fi 6E", "802.11ax (6 GHz)"],
      ],
    },
    {
      kind: "order" as const,
      id: "pbq-router-harden",
      title: "Router hardening",
      prompt: "Order the following router hardening actions from first to last.",
      items: [
        "Change default admin credentials",
        "Update router firmware",
        "Disable WPS if not required",
        "Configure WPA2/WPA3 and set a strong passphrase",
        "Disable remote administration (unless required)",
        "Document settings and store backup config securely",
      ],
    },
    {
      kind: "match" as const,
      id: "pbq-cable-match",
      title: "Cables and connectors",
      prompt: "Match the connector to the cable type.",
      leftLabel: "Connector",
      rightLabel: "Cable",
      pairs: [
        ["RJ‑45", "Ethernet (twisted pair)"],
        ["LC", "Fiber optic (SFP transceiver)"],
        ["BNC", "Coaxial"],
        ["USB‑C", "USB"],
      ],
    },
  ];

  const core2 = [
    {
      kind: "match" as const,
      id: "pbq-windows-tools",
      title: "Windows tools",
      prompt: "Match each tool to the best use case.",
      leftLabel: "Tool",
      rightLabel: "Use case",
      pairs: [
        ["Task Manager", "View/stop processes and performance"],
        ["Event Viewer", "Review system/application logs"],
        ["Disk Management", "Create/format/assign volumes"],
        ["Device Manager", "Manage hardware devices/drivers"],
      ],
    },
    {
      kind: "order" as const,
      id: "pbq-malware-flow",
      title: "Malware response workflow",
      prompt: "Order the steps for responding to a malware incident.",
      items: [
        "Identify and isolate the infected system",
        "Disable System Restore (if used in your procedure)",
        "Remediate/clean or reimage as required",
        "Update signatures and apply patches",
        "Re-enable protections and restore services",
        "Document incident and user education",
      ],
    },
    {
      kind: "match" as const,
      id: "pbq-ticket-triage",
      title: "Help desk triage",
      prompt: "Match each ticket description to the most appropriate priority.",
      leftLabel: "Ticket",
      rightLabel: "Priority",
      pairs: [
        ["Single user cannot print to local printer", "Low"],
        ["Multiple users cannot access shared drive", "High"],
        ["CEO laptop will not boot before a meeting", "High"],
        ["User requests software installation", "Medium"],
      ],
    },
    {
      kind: "order" as const,
      id: "pbq-change-mgmt",
      title: "Change management",
      prompt: "Order common change management steps in a controlled environment.",
      items: [
        "Identify scope and risk",
        "Create a rollback plan",
        "Test in a staging environment",
        "Schedule and communicate downtime",
        "Implement the change",
        "Validate and document results",
      ],
    },
  ];

  return {
    common,
    specific: core === "220-1201" ? core1 : core2,
  };
}

function buildPBQQuestion(core: CoreId, sessionId: string, baseId: string, objective: QuestionPlanItem, rng: RNG): Question {
  const t = pickOne(rng, [...pbqTemplates(core).common, ...pbqTemplates(core).specific]);

  if (t.kind === "order") {
    const ids = makeOptionIds(t.items.length);
    const items = t.items.map((text, i) => ({ id: ids[i], text }));
    return {
      id: `${sessionId}-${baseId}`,
      core,
      domain: objective.domainLabel,
      objective: objective.objectiveId,
      objectiveTitle: objective.objectiveTitle,
      objectiveBullets: objective.objectiveBullets,
      type: "pbq-order",
      prompt: `${t.prompt}`,
      pbq: { kind: "order", items },
      // correct order is the original order of items (by text), matching the UI encoding
      correct: t.items,
      explanation: `This PBQ practices a common workflow relevant to the exam objectives. Review the steps and why the order matters.`,
    };
  }

  // match
  const pairs = shuffle(rng, t.pairs);
  const leftIds = makeOptionIds(pairs.length);
  const rightIds = makeOptionIds(pairs.length).map((x) => `R${x}`);

  const left = pairs.map(([l], i) => ({ id: leftIds[i], text: l }));
  const right = shuffle(rng, pairs.map(([, r], i) => ({ id: rightIds[i], text: r })));

  // correct is encoded as "LeftText=>RightText" (matches UI encoding)
  const correctPairs = pairs.map(([l, r]) => `${l}=>${r}`);

  return {
    id: `${sessionId}-${baseId}`,
    core,
    domain: objective.domainLabel,
    objective: objective.objectiveId,
    objectiveTitle: objective.objectiveTitle,
    objectiveBullets: objective.objectiveBullets,
    type: "pbq-match",
    prompt: `${t.prompt}`,
    pbq: {
      kind: "match",
      leftLabel: t.leftLabel,
      rightLabel: t.rightLabel,
      left,
      right,
    },
    correct: correctPairs,
    explanation: `This PBQ covers common mappings. Review why each left item matches the right item.`,
  };
}

function allBulletPool(core: CoreId): string[] {
  const ids = listObjectiveIds(core);
  const pool: string[] = [];
  for (const id of ids) {
    const b = OBJECTIVES[core]?.[id]?.bullets ?? [];
    for (const x of b) {
      const s = sanitizeText(x);
      if (s && s.length <= 120) pool.push(s);
    }
  }
  // Some objectives have long multi-line bullets; keep them short for options.
  return pool.length ? pool : ids.map((id) => sanitizeText(OBJECTIVES[core]?.[id]?.title ?? id)).filter(Boolean);
}

function buildSingleFromObjective(core: CoreId, sessionId: string, baseId: string, obj: QuestionPlanItem, rng: RNG): Question {
  const bullets = obj.objectiveBullets.map(sanitizeText).filter(Boolean).filter((b) => b.length <= 140);
  const pool = allBulletPool(core);

  const correctText = bullets.length ? pickOne(rng, bullets) : sanitizeText(obj.objectiveTitle);
  const distractors = takeDistinct(rng, pool.filter((x) => x !== correctText), 3);

  const optsText = shuffle(rng, [correctText, ...distractors]).slice(0, 4);
  const ids = makeOptionIds(optsText.length);
  const options = optsText.map((text, i) => ({ id: ids[i], text }));

  const correctId = options.find((o) => o.text === correctText)?.id ?? ids[0];

  const prompt =
    `Which of the following is specifically listed under the objective:\n` +
    `"${sanitizeText(obj.objectiveTitle)}"?`;

  return {
    id: `${sessionId}-${baseId}`,
    core,
    domain: obj.domainLabel,
    objective: obj.objectiveId,
    objectiveTitle: obj.objectiveTitle,
    objectiveBullets: obj.objectiveBullets,
    type: "single",
    prompt,
    options,
    correct: [correctId],
    explanation: `"${correctText}" is explicitly included under this objective. Review the objective bullets for related terms.`,
    focus: correctText,
  };
}

function buildMultiFromObjective(core: CoreId, sessionId: string, baseId: string, obj: QuestionPlanItem, rng: RNG): Question {
  const bullets = obj.objectiveBullets.map(sanitizeText).filter(Boolean).filter((b) => b.length <= 140);
  if (bullets.length < 2) return buildSingleFromObjective(core, sessionId, baseId, obj, rng);

  const pool = allBulletPool(core);
  const correctTexts = takeDistinct(rng, bullets, 2);
  const distractors = takeDistinct(rng, pool.filter((x) => !correctTexts.includes(x)), 3);

  const optsText = shuffle(rng, [...correctTexts, ...distractors]).slice(0, 5);
  const ids = makeOptionIds(optsText.length);
  const options = optsText.map((text, i) => ({ id: ids[i], text }));

  const correctIds = options.filter((o) => correctTexts.includes(o.text)).map((o) => o.id);

  const prompt =
    `Select ALL that apply. Which of the following are specifically listed under the objective:\n` +
    `"${sanitizeText(obj.objectiveTitle)}"?`;

  return {
    id: `${sessionId}-${baseId}`,
    core,
    domain: obj.domainLabel,
    objective: obj.objectiveId,
    objectiveTitle: obj.objectiveTitle,
    objectiveBullets: obj.objectiveBullets,
    type: "multi",
    prompt,
    options,
    correct: correctIds,
    explanation: `These items are listed under the objective. The distractors are from other objectives/domains.`,
    focus: correctTexts.join("; "),
  };
}

/**
 * Build 90 questions offline that follow the session plan distribution.
 * This is a fallback when the AI backend is unavailable, and also supports a fully offline mode.
 */
export function buildOfflineQuestions(core: CoreId, sessionId: string, config: SessionConfig, plan: QuestionPlanItem[]): Question[] {
  const rng = mulberry32(hashStringToSeed(`${sessionId}:${core}:${config.difficulty}`));
  const questions: Question[] = [];

  // Slightly shuffle plan for variety, but keep PBQ count roughly as planned.
  const planShuffled = shuffle(rng, plan);

  let counter = 0;
  for (const p of planShuffled) {
    counter++;
    const baseId = `offline-${String(counter).padStart(3, "0")}`;

    if (p.type === "pbq-order" || p.type === "pbq-match") {
      questions.push(buildPBQQuestion(core, sessionId, baseId, p, rng));
      continue;
    }

    // Difficulty influences how "direct" the question is; we keep it simple offline
    if (p.type === "multi") {
      questions.push(buildMultiFromObjective(core, sessionId, baseId, p, rng));
    } else {
      questions.push(buildSingleFromObjective(core, sessionId, baseId, p, rng));
    }
  }

  // Ensure exactly plan length (90)
  return questions.slice(0, plan.length);
}