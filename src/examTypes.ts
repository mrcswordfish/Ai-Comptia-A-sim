import { CoreId } from "./objectives";

export type QuestionType = "single" | "multi" | "pbq-order" | "pbq-match";

export type Question = {
  id: string;
  core: CoreId;
  domain: string;

  objective: string;
  objectiveTitle: string;
  objectiveBullets: string[];
  focus?: string;

  type: QuestionType;
  prompt: string;

  options?: { id: string; text: string }[];
  correct: string[];

  explanation: string;

  pbq?:
    | { kind: "order"; items: { id: string; text: string }[] }
    | {
        kind: "match";
        leftLabel: string;
        rightLabel: string;
        left: { id: string; text: string }[];
        right: { id: string; text: string }[];
      };
};
};

export type Difficulty = "easy" | "medium" | "hard";

export type SessionConfig = { pbqCount: number; showObjectiveHints: boolean; difficulty: Difficulty };

export type ExamSession = {
  sessionId: string;
  core: CoreId;
  createdAtISO: string;
  durationSeconds: number;
  config: SessionConfig;
  questions: Question[];
};

export type AnswerMap = Record<string, string[] | undefined>;
export type ScoredQuestion = { questionId: string; isCorrect: boolean };

export type ExamResult = {
  percent: number;
  correctCount: number;
  total: number;
  byDomain: { domain: string; correct: number; total: number }[];
  scored: ScoredQuestion[];
};
