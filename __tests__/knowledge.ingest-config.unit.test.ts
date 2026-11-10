import { knowledgeIngestSections, knowledgePathAllowed } from '../src/modules/knowledge/knowledge.config';

const original = process.env.KNOWLEDGE_INGEST_SECTIONS;
afterEach(() => {
  if (original === undefined) delete process.env.KNOWLEDGE_INGEST_SECTIONS;
  else process.env.KNOWLEDGE_INGEST_SECTIONS = original;
});

test('an unset policy preserves existing environment behavior', () => {
  delete process.env.KNOWLEDGE_INGEST_SECTIONS;
  expect(knowledgeIngestSections()).toBeUndefined();
});

test('explicit valid sections are parsed without widening the audience', () => {
  process.env.KNOWLEDGE_INGEST_SECTIONS = 'COMPANY';
  expect(knowledgeIngestSections()).toEqual(['COMPANY']);
  process.env.KNOWLEDGE_INGEST_SECTIONS = ' COMPANY, AI_WORKSPACE ';
  expect(knowledgeIngestSections()).toEqual(['COMPANY', 'AI_WORKSPACE']);
});

test.each(['', '*', 'company', 'COMPANY,', 'COMPANY,COMPANY', 'COMPANY,UNKNOWN'])('invalid configured policy %j fails closed', value => {
  process.env.KNOWLEDGE_INGEST_SECTIONS = value;
  expect(() => knowledgeIngestSections()).toThrow('KNOWLEDGE_INGEST_SECTIONS_INVALID');
});

test('section boundaries use exact top-level folders', () => {
  const config = { key: 'test', name: 'test', fingerprint: 'test', url: 'https://cloud.example.org', user: 'reader', password: 'test', root: 'База знаний', ingestSections: ['COMPANY'] as const };
  expect(knowledgePathAllowed(config, 'Материалы компании/a.md')).toBe(true);
  expect(knowledgePathAllowed(config, 'Материалы компании старые/a.md')).toBe(false);
  expect(knowledgePathAllowed(config, 'Архив/Материалы компании/a.md')).toBe(false);
  expect(knowledgePathAllowed(config, 'Рабочая область ИИ/a.md')).toBe(false);
});
