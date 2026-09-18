import { strict as assert } from 'assert';
import { test } from 'node:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { CONDENSE_TOOL, CaptionCondenser, buildPrompt, fallbackCondense, normalizeResult } from '../lib/condense.js';
import { IssueStore } from '../lib/store.js';
import { DEFAULTS } from '../lib/config.js';

const LONG_CAPTION =
  'A colony of giant tubeworms crowds a hydrothermal vent nearly two miles below ' +
  'the surface of the Pacific Ocean near the Galapagos Rift, where superheated, ' +
  'mineral-rich water supports an ecosystem that never sees sunlight.';

async function tempConfig() {
  const dir = await mkdtemp(join(tmpdir(), 'natgeo-condense-'));
  return { dir, config: { ...DEFAULTS, dataDir: dir, anthropicApiKey: 'test-key' } };
}

function stubClient(handler) {
  return { messages: { create: handler } };
}

function toolResponse(input) {
  return { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: CONDENSE_TOOL.name, input }] };
}

test('the tool schema is strict, so arguments are always schema-valid', () => {
  assert.equal(CONDENSE_TOOL.strict, true);
  assert.equal(CONDENSE_TOOL.input_schema.additionalProperties, false);
  assert.deepEqual(
    CONDENSE_TOOL.input_schema.required.sort(),
    ['credit', 'headline', 'location', 'short_caption'],
  );
});

test('the prompt carries headline, credit, and caption without inventing content', () => {
  const prompt = buildPrompt({
    headline: 'Life at the Vents', caption: LONG_CAPTION, credit: 'Maria Chen',
    articleUrl: 'https://x/a',
  });
  assert.match(prompt, /Life at the Vents/);
  assert.match(prompt, /Maria Chen/);
  assert.match(prompt, /giant tubeworms/);
  const empty = buildPrompt({ headline: 'H', caption: '' });
  assert.match(empty, /no caption was published/);
});

test('a condensed caption is returned and cached, so a re-run makes no API call', async () => {
  const { dir, config } = await tempConfig();
  try {
    let calls = 0;
    const client = stubClient(async () => {
      calls += 1;
      return toolResponse({
        location: 'Galápagos Rift, Pacific Ocean',
        short_caption: 'Giant tubeworms crowd a hydrothermal vent two miles down',
        headline: 'Life at the Vents',
        credit: 'Maria Chen',
      });
    });
    const store = await new IssueStore(dir).init();
    const input = { headline: 'Life at the Vents', caption: LONG_CAPTION, credit: 'Maria Chen' };

    const first = new CaptionCondenser(config, { client, store });
    const result = await first.condense(input);
    await first.save();
    assert.equal(result.location, 'Galápagos Rift, Pacific Ocean');
    assert.ok(result.short_caption.split(' ').length <= 18);
    assert.equal(calls, 1);

    // A fresh condenser reading the same on-disk cache must not call the API.
    const second = new CaptionCondenser(config, { client, store });
    const cached = await second.condense(input);
    assert.deepEqual(cached, result);
    assert.equal(calls, 1, 'no second API call');
    assert.equal(second.stats.cached, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an API failure degrades to a truncated caption instead of losing the slide', async () => {
  const { dir, config } = await tempConfig();
  try {
    const client = stubClient(async () => { throw new Error('rate limited'); });
    const condenser = new CaptionCondenser(config, { client, store: await new IssueStore(dir).init() });
    const result = await condenser.condense({ headline: 'H', caption: LONG_CAPTION, credit: 'Maria Chen' });
    assert.ok(result._fallback);
    assert.equal(result.headline, 'H');
    assert.equal(result.credit, 'Maria Chen');
    assert.ok(result.short_caption.length < LONG_CAPTION.length);
    assert.equal(condenser.stats.failed, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a model refusal is treated as a failure, not as valid output', async () => {
  const { dir, config } = await tempConfig();
  try {
    const client = stubClient(async () => ({
      stop_reason: 'refusal', stop_details: { category: 'other' }, content: [],
    }));
    const condenser = new CaptionCondenser(config, { client, store: await new IssueStore(dir).init() });
    const result = await condenser.condense({ headline: 'H', caption: 'c' });
    assert.ok(result._fallback);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('with no API key configured the harvester still produces slides', async () => {
  const { dir, config } = await tempConfig();
  try {
    const condenser = new CaptionCondenser(
      { ...config, anthropicApiKey: '' }, { store: await new IssueStore(dir).init() },
    );
    assert.equal(condenser.enabled, false);
    const result = await condenser.condense({ headline: 'H', caption: LONG_CAPTION });
    assert.ok(result.short_caption);
    assert.equal(condenser.stats.fallback, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('results are normalized: whitespace collapsed, credit prefix dropped', () => {
  const result = normalizeResult(
    { location: ' Nairobi,\n Kenya ', short_caption: 'A  lion   rests', headline: '', credit: 'Photograph by Ada L.' },
    { headline: 'Fallback Headline' },
  );
  assert.equal(result.location, 'Nairobi, Kenya');
  assert.equal(result.short_caption, 'A lion rests');
  assert.equal(result.headline, 'Fallback Headline', 'falls back to the article headline');
  assert.equal(result.credit, 'Ada L.');
});

test('fallback truncation ends on a word boundary with an ellipsis', () => {
  const result = fallbackCondense({ headline: 'H', caption: LONG_CAPTION, credit: 'Photographs by Ada' });
  assert.ok(result.short_caption.endsWith('…'));
  assert.equal(result.short_caption.split(' ').length, 18, 'capped at 18 words');
  assert.equal(result.credit, 'Ada');
});
