// Types for answerer.mjs (the scripted athlete hook).
import type { AnswerRule } from "./types.ts";

export function answer(
  input: { questions?: { question: string; header?: string; multiSelect?: boolean; options?: { label: string }[] }[] },
  rules: AnswerRule[],
): { answers: Record<string, string>; unanswered: string[]; clicks: number; typed: number };
