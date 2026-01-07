import { CoreId } from "./objectives";
import { QuestionPlanItem } from "./sessionPlanner";

export type Difficulty = "easy" | "medium" | "hard";

export type GenerateRequest = {
  core: CoreId;
  items: QuestionPlanItem[];
  difficulty: Difficulty;
  generationId: string;
  batchIndex: number;
  model?: string; // server will enforce gpt-4o-mini
};

export type GeneratedItem =
  | {
      type: "single" | "multi";
      domain: string;
      objectiveId: string;
      objectiveTitle: string;
      objectiveBullets: string[];
      prompt: string;
      options: string[];
      correctIndices: number[];
      explanation: string;
    }
  | {
      type: "pbq-order";
      domain: string;
      objectiveId: string;
      objectiveTitle: string;
      objectiveBullets: string[];
      prompt: string;
      orderItems: string[];
      correctOrder: number[]; // indices into orderItems
      explanation: string;
    }
  | {
      type: "pbq-match";
      domain: string;
      objectiveId: string;
      objectiveTitle: string;
      objectiveBullets: string[];
      prompt: string;
      leftLabel: string;
      rightLabel: string;
      left: string[];
      right: string[];
      correctPairs: { leftIndex: number; rightIndex: number }[];
      explanation: string;
    };

export async function generateQuestions(req: GenerateRequest, signal?: AbortSignal): Promise<GeneratedItem[]> {
  const res = await fetch("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
    signal,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Generate failed (${res.status}): ${txt || res.statusText}`);
  }

  const data = (await res.json()) as { items: GeneratedItem[] };
  if (!data.items || !Array.isArray(data.items)) throw new Error("Invalid response from generator.");
  return data.items;
}
