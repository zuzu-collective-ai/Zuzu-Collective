// AI budget allocator — Phase 4a.
//
// Single Anthropic API call: takes a couple's wedding total, venue, guest
// count, optional priorities/notes, and asks Claude to propose an
// allocation across the 19 standard wedding-budget categories. Returns
// {rationale_summary, categories: [{title, estimated_cents, rationale}]}.
//
// Implementation notes:
//
//   • Opus 4.7 with `thinking: {type: 'adaptive'}` — Claude decides how
//     much to think per request. Adaptive thinking is OFF by default on
//     4.7, so it has to be explicitly enabled.
//
//   • `output_config.format` with a JSON schema — guarantees the response
//     parses cleanly without prompt-engineering JSON contracts.
//
//   • `cache_control: {type: 'ephemeral'}` on the system prompt — the
//     standard-categories list and methodology are identical across every
//     allocation request, so the prefix caches and subsequent calls cost
//     ~10% of the first one.
//
//   • Lazy client construction — boots cleanly even when ANTHROPIC_API_KEY
//     is unset. The admin UI checks `isConfigured()` and disables the
//     allocator button with a hint instead of crashing on click.

import Anthropic from '@anthropic-ai/sdk';

let _client = null;

export function isConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function client() {
  if (_client) return _client;
  if (!isConfigured()) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }
  _client = new Anthropic();
  return _client;
}

// The 19 standard wedding-planning categories Zuzu uses. Mirrors the seed
// in db/seed.sql so the AI's output drops directly into the existing
// budget_categories table without title fuzzing. `emphasis` is the italic
// suffix that styles the category title on the public page.
export const STANDARD_CATEGORIES = [
  { number: 1,  title: 'Venue',             emphasis: null },
  { number: 2,  title: 'Catering',          emphasis: '(food & bar)' },
  { number: 3,  title: 'Photography',       emphasis: null },
  { number: 4,  title: 'Videography',       emphasis: null },
  { number: 5,  title: 'Florals &',         emphasis: 'Decor' },
  { number: 6,  title: 'Rentals',           emphasis: null },
  { number: 7,  title: 'Wedding Dress &',   emphasis: 'Accessories' },
  { number: 8,  title: 'Groom Attire',      emphasis: null },
  { number: 9,  title: 'Wedding Cake &',    emphasis: 'Desserts' },
  { number: 10, title: 'Music &',           emphasis: 'Sound' },
  { number: 11, title: 'Hair &',            emphasis: 'Makeup' },
  { number: 12, title: 'Transportation',    emphasis: null },
  { number: 13, title: 'Officiant',         emphasis: null },
  { number: 14, title: 'Invitations &',     emphasis: 'Stationery' },
  { number: 15, title: 'Wedding Rings',     emphasis: null },
  { number: 16, title: 'Wedding Favors',    emphasis: null },
  { number: 17, title: 'Rehearsal',         emphasis: 'Dinner' },
  { number: 18, title: 'Wedding Planner',   emphasis: null },
  { number: 19, title: 'Miscellaneous',     emphasis: null },
];

// System prompt — fixed across all couples so the prefix caches. Anything
// couple-specific (total, venue, notes) goes in the user message.
function systemPrompt() {
  const list = STANDARD_CATEGORIES
    .map(c => `  ${String(c.number).padStart(2, '0')}. ${c.title}${c.emphasis ? ' ' + c.emphasis : ''}`)
    .join('\n');
  return `You are a senior wedding planner at Zuzu Collective, a boutique studio that plans elegant, editorial weddings (think coastal California, candlelit, considered). You're helping the lead planner draft an opening budget allocation for a new couple — a starting point she'll refine with them, not a final spreadsheet.

You will allocate the couple's total budget across these 19 standard categories, in this exact order:

${list}

Allocation methodology:
  • Use wedding-industry averages as your baseline (Venue + Catering typically dominate at 45-55% combined; Photography/Video around 10-15%; Florals 8-12%; Music 5-8%; the rest split among the other categories).
  • Adjust for the couple's specific context: guest count (more guests = more catering, rentals, stationery), venue type (full-service hotel needs less rental spend; a raw venue needs more), priorities they mentioned, and any constraints noted.
  • Always include a Miscellaneous buffer (3-5% of total) for vendor tips, marriage license, and contingency.
  • Round each amount to a clean $50 or $100 increment — these are starter numbers, not contractually bound.
  • The 19 amounts must sum to the couple's total budget exactly.

For each category, write a short (one sentence, max ~20 words) rationale explaining the allocation in language Zoe could read aloud to the couple — concrete and specific to their situation, not generic ("scaled up for your 120-guest count" beats "industry standard for catering").

Also write a 1-2 sentence overall rationale_summary that gives Zoe the headline read on the allocation strategy.`;
}

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    rationale_summary: {
      type: 'string',
      description: '1-2 sentence overview of the allocation strategy.',
    },
    categories: {
      type: 'array',
      description: 'Allocations for the 19 standard categories, in order.',
      items: {
        type: 'object',
        properties: {
          category_number: { type: 'integer', description: 'The category number (1-19) from the standard list.' },
          title:           { type: 'string',  description: 'The category title from the standard list, exactly as given.' },
          estimated_cents: { type: 'integer', description: 'Allocated amount in integer cents (e.g. 3500000 for $35,000).' },
          rationale:       { type: 'string',  description: 'One sentence explaining this allocation.' },
        },
        required: ['category_number', 'title', 'estimated_cents', 'rationale'],
        additionalProperties: false,
      },
    },
  },
  required: ['rationale_summary', 'categories'],
  additionalProperties: false,
};

// Build the couple-specific user message. Keeping it terse so the model
// doesn't over-anchor on stray phrasing.
function userMessage({ totalDollars, displayName, weddingDate, venueName, venueLocation, guestCount, notes }) {
  const lines = [
    `Total budget: $${totalDollars.toLocaleString('en-US')}`,
    `Couple: ${displayName || 'Unnamed couple'}`,
  ];
  if (weddingDate)    lines.push(`Wedding date: ${weddingDate}`);
  if (venueName)      lines.push(`Venue: ${venueName}${venueLocation ? ` (${venueLocation})` : ''}`);
  if (guestCount)     lines.push(`Guest count: ${guestCount}`);
  if (notes && notes.trim()) {
    lines.push('');
    lines.push('Priorities and notes from the couple:');
    lines.push(notes.trim());
  }
  lines.push('');
  lines.push('Generate the 19-category allocation now.');
  return lines.join('\n');
}

/**
 * Generate a budget allocation for a couple.
 *
 * @param {object} input
 * @param {number} input.totalCents          required — total budget in integer cents
 * @param {string} [input.displayName]       e.g. "Alicia & Jack"
 * @param {string} [input.weddingDate]       e.g. "October 10, 2026"
 * @param {string} [input.venueName]         e.g. "La Playa Hotel"
 * @param {string} [input.venueLocation]     e.g. "Carmel-by-the-Sea"
 * @param {number} [input.guestCount]        e.g. 100
 * @param {string} [input.notes]             free-text priorities / constraints
 * @returns {Promise<{rationale_summary: string, categories: Array, usage: object}>}
 */
export async function generateAllocation(input) {
  if (!input || !input.totalCents || input.totalCents <= 0) {
    throw new Error('totalCents is required and must be positive');
  }
  const totalDollars = Math.round(input.totalCents / 100);

  const response = await client().messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 8000,
    thinking: { type: 'adaptive' },
    output_config: {
      format: { type: 'json_schema', schema: RESPONSE_SCHEMA },
      effort: 'medium',
    },
    system: [
      {
        type: 'text',
        text: systemPrompt(),
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      { role: 'user', content: userMessage({ ...input, totalDollars }) },
    ],
  });

  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock) {
    throw new Error('No text block in Claude response');
  }
  const parsed = JSON.parse(textBlock.text);

  return {
    rationale_summary: parsed.rationale_summary,
    categories: parsed.categories,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_creation_input_tokens: response.usage.cache_creation_input_tokens || 0,
      cache_read_input_tokens: response.usage.cache_read_input_tokens || 0,
    },
  };
}
