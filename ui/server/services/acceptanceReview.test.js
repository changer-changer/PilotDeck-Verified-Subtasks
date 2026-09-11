import { describe, expect, it } from 'vitest';
import { validatePilotDeckConfig } from './pilotdeckConfig.js';
import { findModelReferences, rewriteModelReferences } from './modelReferences.js';
const config = (review) => ({ schemaVersion: 1, agent: { model: 'main/model', ...(review === undefined ? {} : { acceptanceReview: review }) },
  model: { providers: { main: { protocol: 'openai', url: 'https://example.com/v1', apiKey: 'test', models: { model: {}, reviewer: {} } } } } });

describe('model acceptance settings validation', () => {
  it('validates the independent acceptance-memory opt-out', () => {
    for (const value of [true, false]) expect(validatePilotDeckConfig({ ...config(), memory: { enabled: true, captureAcceptance: value } }).errors).toEqual([]);
    for (const value of [null, 'false', 0, [], {}]) expect(validatePilotDeckConfig({ ...config(), memory: { enabled: true, captureAcceptance: value } }).errors.some(e => e.includes('memory.captureAcceptance'))).toBe(true);
  });
  it('accepts inheritance, explicit reviewer and opt out', () => {
    for (const review of [undefined, {}, { enabled: false }, { model: 'main/reviewer', maxTurns: 4, timeoutMs: 60000 }]) {
      expect(validatePilotDeckConfig(config(review)).errors).toEqual([]);
    }
  });
  it('rejects bad model references, wrong types and excessive budgets before saving', () => {
    for (const review of [null, [], true, { enabled: 'true' }, { model: 'inherit' }, { model: 'absent/model' }, { model: null },
      { maxTurns: 0 }, { maxTurns: 9 }, { maxTurns: null }, { timeoutMs: 180001 }, { unexpected: true }]) {
      expect(validatePilotDeckConfig(config(review)).errors.some(e => e.includes('agent.acceptanceReview')), JSON.stringify(review)).toBe(true);
    }
  });
  it('tracks and rewrites reviewer references without touching the main model', () => {
    const next = config({ model: 'main/reviewer' });
    expect(findModelReferences(next, { modelId: 'reviewer' })).toEqual([{ path: 'agent.acceptanceReview.model', value: 'main/reviewer', kind: 'agent' }]);
    rewriteModelReferences(next, { modelRenames: new Map([['main/reviewer', { modelId: 'judge' }]]) });
    expect(next.agent.model).toBe('main/model');
    expect(next.agent.acceptanceReview.model).toBe('main/judge');
  });
});
