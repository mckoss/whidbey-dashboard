// Caption condensing via the Claude API.
//
// Long NatGeo captions are unreadable from a couch. This turns each one into
// the four fields the lower-third overlay renders:
//   { location, short_caption, headline, credit }
//
// Uses a strict tool (schema-validated arguments) rather than free-text JSON,
// so a malformed response is an API-level error instead of a parse bug here.
// Results are cached on disk by content hash — re-running the harvester on the
// same issue costs nothing.

import Anthropic from '@anthropic-ai/sdk';
import { IssueStore } from './store.js';
import { log } from './log.js';

export const CONDENSE_TOOL = {
  name: 'record_caption',
  description: 'Record the condensed caption fields for one magazine photograph.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      location: {
        type: 'string',
        description:
          'Where the photo was taken, as briefly as possible — "Serengeti, Tanzania", ' +
          '"Off the coast of Baja". Empty string if the caption does not say.',
      },
      short_caption: {
        type: 'string',
        description:
          'The caption rewritten to at most 18 words: what is actually in the frame. ' +
          'Present tense, no photographer name, no publication boilerplate, no trailing period ' +
          'unless it is a full sentence.',
      },
      headline: {
        type: 'string',
        description:
          'A 2-6 word title for this image. Reuse the article headline only if it genuinely ' +
          'describes this photograph; otherwise write a better one from the caption.',
      },
      credit: {
        type: 'string',
        description:
          'Photographer credit, name only, without a "Photograph by" prefix. ' +
          'Empty string if unknown.',
      },
    },
    required: ['location', 'short_caption', 'headline', 'credit'],
    additionalProperties: false,
  },
};

const SYSTEM_PROMPT = [
  'You condense photo captions for an always-on television slideshow.',
  'The viewer is across the room and reads each caption for a few seconds, so',
  'every field must be short, concrete, and immediately legible.',
  'Never invent a place, a name, or a fact that is not in the material you are given —',
  'return an empty string instead of guessing.',
].join(' ');

export function buildPrompt({ headline, caption, credit, altText, articleUrl }) {
  const lines = ['Condense this magazine photograph caption.', ''];
  if (headline) lines.push(`Article headline: ${headline}`);
  if (articleUrl) lines.push(`Article URL: ${articleUrl}`);
  if (credit) lines.push(`Credit as published: ${credit}`);
  if (altText && altText !== caption) lines.push(`Image alt text: ${altText}`);
  lines.push('', 'Caption as published:', caption || '(no caption was published with this image)');
  return lines.join('\n');
}

// Deterministic fallback used when no API key is configured, or when the API
// call fails. Keeps the slideshow running with honest (if blunter) text.
export function fallbackCondense({ headline, caption, credit }) {
  const text = String(caption || '').replace(/\s+/g, ' ').trim();
  const words = text.split(' ').filter(Boolean);
  const short = words.length > 18 ? `${words.slice(0, 18).join(' ')}…` : text;
  return {
    location: '',
    short_caption: short,
    headline: String(headline || '').trim(),
    credit: String(credit || '').replace(/^\s*photographs?\s+by\s+/i, '').trim(),
    _fallback: true,
  };
}

export class CaptionCondenser {
  constructor(config, { client = null, store = null } = {}) {
    this.config = config;
    this.model = config.condenseModel || 'claude-opus-5';
    this.effort = config.condenseEffort || 'low';
    this.store = store || new IssueStore(config.dataDir);
    this.enabled = Boolean(config.anthropicApiKey);
    this.client = client || (this.enabled ? new Anthropic({ apiKey: config.anthropicApiKey }) : null);
    this.cache = null;
    this.stats = { calls: 0, cached: 0, failed: 0, fallback: 0 };
  }

  async load() {
    this.cache = await this.store.readCache();
    return this;
  }

  async save() {
    if (this.cache) await this.store.writeCache(this.cache);
  }

  async condense(input) {
    if (!this.cache) await this.load();
    const key = IssueStore.cacheKey({ ...input, model: this.model });
    if (this.cache[key]) {
      this.stats.cached += 1;
      return this.cache[key];
    }

    if (!this.client) {
      this.stats.fallback += 1;
      const result = fallbackCondense(input);
      log.warn('CONDENSE_NO_API_KEY', 'ANTHROPIC_API_KEY is not set — using truncated captions', {
        headline: input.headline?.slice(0, 60) || '',
      });
      return result;
    }

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        output_config: { effort: this.effort },
        tools: [CONDENSE_TOOL],
        tool_choice: { type: 'tool', name: CONDENSE_TOOL.name },
        messages: [{ role: 'user', content: buildPrompt(input) }],
      });
      this.stats.calls += 1;

      if (response.stop_reason === 'refusal') {
        throw new Error(`model refused: ${response.stop_details?.category || 'unknown'}`);
      }
      const block = response.content.find(
        (b) => b.type === 'tool_use' && b.name === CONDENSE_TOOL.name,
      );
      if (!block) throw new Error(`no ${CONDENSE_TOOL.name} tool call in response`);

      const result = normalizeResult(block.input, input);
      this.cache[key] = result;
      return result;
    } catch (err) {
      this.stats.failed += 1;
      log.warn('CONDENSE_FAILED', err.message, { model: this.model });
      return fallbackCondense(input);
    }
  }
}

export function normalizeResult(raw, input) {
  const str = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');
  return {
    location: str(raw.location),
    short_caption: str(raw.short_caption),
    headline: str(raw.headline) || str(input.headline),
    credit: str(raw.credit).replace(/^\s*photographs?\s+by\s+/i, ''),
  };
}

export default CaptionCondenser;
