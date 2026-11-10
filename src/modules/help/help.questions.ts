import { z } from 'zod';

export const helpQuestionSchema = z.object({
  id: z.string().trim().min(1).max(64),
  header: z.string().trim().min(1).max(60),
  question: z.string().trim().min(1).max(600),
  options: z.array(z.object({ label: z.string().trim().min(1).max(120),
    description: z.string().trim().max(240) }).strict()).max(4),
  multiSelect: z.boolean(),
}).strict();
export type HelpAIQuestion = z.infer<typeof helpQuestionSchema>;

export const helpQuestionsJsonSchema = {
  type: 'array', maxItems: 3, items: {
    type: 'object', additionalProperties: false,
    required: ['id', 'header', 'question', 'options', 'multiSelect'],
    properties: {
      id: { type: 'string', minLength: 1, maxLength: 64 },
      header: { type: 'string', minLength: 1, maxLength: 60 },
      question: { type: 'string', minLength: 1, maxLength: 600 },
      multiSelect: { type: 'boolean' },
      options: { type: 'array', maxItems: 4, items: {
        type: 'object', additionalProperties: false, required: ['label', 'description'],
        properties: { label: { type: 'string', minLength: 1, maxLength: 120 },
          description: { type: 'string', maxLength: 240 } },
      } },
    },
  },
};

export function normalizeHelpQuestions(value: unknown): HelpAIQuestion[] {
  if (!Array.isArray(value)) return [];
  const result: HelpAIQuestion[] = [];
  for (const item of value.slice(0, 3)) {
    const parsed = helpQuestionSchema.safeParse(item);
    if (!parsed.success || result.some(question => question.id === parsed.data.id)) continue;
    result.push({ ...parsed.data, options: parsed.data.options.filter((option, index, all) =>
      all.findIndex(other => other.label === option.label) === index) });
  }
  return result;
}
