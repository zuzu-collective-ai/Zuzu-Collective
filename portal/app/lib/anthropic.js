// AI features — Phase 4a/4b/4c.
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

// ── Palette + tone generator (Phase 4b) ────────────────────────────────
//
// Single Claude call. Takes the couple's brief — venue, season, vibe,
// anything they've said — and proposes a 4-color palette plus tone
// keywords and a one-line tone statement. Output drops directly into the
// `palette_color_1..4`, `palette_color_*_name`, `tone_keywords`, and
// `tone_statement` columns on `couples`.
//
// The system prompt encodes Zuzu's editorial sensibility (warm, coastal,
// candlelit, restrained) so couple briefs that don't specify a direction
// still produce on-brand suggestions. Couples who explicitly want a
// different direction (modern, garden, mountain) get it because the user
// message overrides the brand defaults.

function paletteSystemPrompt() {
  return `You are the design lead at Zuzu Collective, a boutique wedding planning studio. You're proposing a starting palette and tone for a new couple — colors, names, tone keywords, and a one-line tone statement that captures the feeling of their wedding.

Zuzu's editorial sensibility, when no other direction is given:
  • Warm and grounded — ivories, creams, soft greens, dusty neutrals. Avoid cold blues, neons, or saturated jewel tones unless the couple explicitly asks for them.
  • Candlelit, intimate, considered — never glossy or over-produced.
  • Coastal California is the house comfort zone (think Carmel, Big Sur, Ojai), but the studio also designs ranch weddings, garden weddings, urban venues — adapt to the brief.

The 4-color palette must include:
  • A dominant neutral (color_1) — ivory, cream, oat, dove, or similar.
  • A primary accent (color_2) — the color that carries the wedding's emotional weight (a soft sage, a dusty terracotta, a deep garnet, etc.). This is the most expressive of the four.
  • A clean light (color_3) — usually a near-white (#FFFFFF, #FAF7F2) that gives the page room to breathe.
  • A complementary neutral (color_4) — slightly warmer or cooler than color_1, used for variation in linens, stationery, and supporting elements.

For each color: hex code (uppercase, with leading #), and a friendly name (1-2 words, evocative not literal — "Chartreuse" beats "Olive Green", "Tobacco" beats "Brown").

Tone keywords: 5-7 single-word or short-phrase descriptors separated by " · " (a middle dot with spaces on either side). Should evoke the wedding's feeling — "Elegant · Coastal · Candlelit · Californian · Timeless · Intentional" is a model. Mix mood, place, and aesthetic. Avoid generic words like "beautiful" or "fun".

Tone statement: a single sentence (under 12 words) that distills the design intent. "All warmth reliant on candlelight." is the model. Should feel quotable — something the couple would write down. Avoid pull-quote clichés ("love is...", "happily ever after").

Also include a 1-2 sentence rationale_summary explaining how the palette and tone connect to the couple's brief.`;
}

const PALETTE_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    rationale_summary: {
      type: 'string',
      description: '1-2 sentence overview of how the palette + tone connect to the couple brief.',
    },
    palette_color_1:      { type: 'string', description: 'Hex code (uppercase, leading #) for the dominant neutral.' },
    palette_color_1_name: { type: 'string', description: 'Friendly name for color 1 (1-2 evocative words).' },
    palette_color_2:      { type: 'string', description: 'Hex code (uppercase, leading #) for the primary accent.' },
    palette_color_2_name: { type: 'string', description: 'Friendly name for color 2.' },
    palette_color_3:      { type: 'string', description: 'Hex code (uppercase, leading #) for the clean light.' },
    palette_color_3_name: { type: 'string', description: 'Friendly name for color 3.' },
    palette_color_4:      { type: 'string', description: 'Hex code (uppercase, leading #) for the complementary neutral.' },
    palette_color_4_name: { type: 'string', description: 'Friendly name for color 4.' },
    tone_keywords:        { type: 'string', description: '5-7 keywords joined by " · " (middle dot with spaces).' },
    tone_statement:       { type: 'string', description: 'Single sentence under 12 words distilling the design intent.' },
  },
  required: [
    'rationale_summary',
    'palette_color_1', 'palette_color_1_name',
    'palette_color_2', 'palette_color_2_name',
    'palette_color_3', 'palette_color_3_name',
    'palette_color_4', 'palette_color_4_name',
    'tone_keywords',
    'tone_statement',
  ],
  additionalProperties: false,
};

function paletteUserMessage({ displayName, weddingDate, venueName, venueLocation, season, brief }) {
  const lines = [
    `Couple: ${displayName || 'Unnamed couple'}`,
  ];
  if (weddingDate)    lines.push(`Wedding date: ${weddingDate}`);
  if (venueName)      lines.push(`Venue: ${venueName}${venueLocation ? ` (${venueLocation})` : ''}`);
  if (season)         lines.push(`Season: ${season}`);
  if (brief && brief.trim()) {
    lines.push('');
    lines.push('Brief from the couple:');
    lines.push(brief.trim());
  }
  lines.push('');
  lines.push('Generate the palette, tone keywords, and tone statement now.');
  return lines.join('\n');
}

/**
 * Generate a palette + tone for a couple.
 *
 * @param {object} input
 * @param {string} [input.displayName]
 * @param {string} [input.weddingDate]
 * @param {string} [input.venueName]
 * @param {string} [input.venueLocation]
 * @param {string} [input.season]
 * @param {string} [input.brief]            free-text couple brief / vibe
 * @returns {Promise<{rationale_summary, palette_color_1..4, palette_color_*_name, tone_keywords, tone_statement, usage}>}
 */
export async function generatePalette(input) {
  const response = await client().messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 4000,
    thinking: { type: 'adaptive' },
    output_config: {
      format: { type: 'json_schema', schema: PALETTE_RESPONSE_SCHEMA },
      effort: 'medium',
    },
    system: [
      {
        type: 'text',
        text: paletteSystemPrompt(),
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      { role: 'user', content: paletteUserMessage(input) },
    ],
  });

  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock) {
    throw new Error('No text block in Claude response');
  }
  const parsed = JSON.parse(textBlock.text);

  return {
    ...parsed,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_creation_input_tokens: response.usage.cache_creation_input_tokens || 0,
      cache_read_input_tokens: response.usage.cache_read_input_tokens || 0,
    },
  };
}

// ── Checklist generator (Phase 4c) ─────────────────────────────────────

function checklistSystemPrompt() {
  return `You are the lead planner at Zuzu Collective, a boutique wedding planning studio. You're building a custom planning checklist for a new couple — a month-by-month arc from booking to wedding day.

Structure: exactly 11 milestones, ordered from furthest-out to the wedding day.

Milestone arc:
  • Milestone 1 — Foundation: venue, date lock, planner retained, key family decisions.
  • Milestones 2–3 — Priority vendors: photographer, videographer, caterer, band/DJ.
  • Milestone 4 — Design direction + guest list draft.
  • Milestone 5 — Supporting vendors: florals, officiant, hair & makeup, transportation.
  • Milestone 6 — Invitations, registry, attire ordered.
  • Milestone 7 — RSVP deadline, seating chart, menu finalized.
  • Milestone 8 — Vendor confirmations, final payments, wedding-day timeline drafted.
  • Milestone 9 — Final fittings, rehearsal logistics, welcome bag assembly.
  • Milestone 10 — Week-of details: deliveries, vendor contacts sheet, marriage license.
  • Milestone 11 — Wedding day: morning prep, ceremony, reception send-off.

date_label format — follow exactly: "Month Year · N Months Out" (e.g. "October 2025 · 12 Months Out"). Use "6 Weeks Out", "2 Weeks Out", "1 Week Out", or "Wedding Day" for the final milestones. The user message gives target dates for each milestone position.

Tasks:
  • 3–6 tasks for early milestones; 5–8 for the 4-to-6-month crunch; 3–5 for final weeks.
  • Names are specific and actionable: "Book the officiant" not "Consider officiant options". Sentence case.
  • sub_text: vendor name + location once booked, a deadline note, or null. One short phrase only.
  • Tailor to venue type (full-service hotel vs. raw venue changes rental/coordination tasks), guest count, and the couple's brief.
  • Aim for 45–55 tasks total across all 11 milestones.`;
}

const CHECKLIST_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    planning_summary: { type: 'string', description: '1–2 sentence overview of the planning arc.' },
    milestones: {
      type: 'array',
      description: 'Exactly 11 milestones in planning order (furthest-out first).',
      items: {
        type: 'object',
        properties: {
          position:   { type: 'integer' },
          date_label: { type: 'string' },
          title:      { type: 'string' },
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                position: { type: 'integer' },
                name:     { type: 'string' },
                sub_text: { type: ['string', 'null'] },
              },
              required: ['position', 'name', 'sub_text'],
              additionalProperties: false,
            },
          },
        },
        required: ['position', 'date_label', 'title', 'tasks'],
        additionalProperties: false,
      },
    },
  },
  required: ['planning_summary', 'milestones'],
  additionalProperties: false,
};

function milestoneDates(weddingDate) {
  const wd = new Date(weddingDate);
  const monthsOut = [12, 10, 8, 6, 5, 4, 3, 2];
  const labels = monthsOut.map(n => {
    const d = new Date(wd);
    d.setMonth(d.getMonth() - n);
    const month = d.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
    return `${month} ${d.getUTCFullYear()} · ${n} Month${n === 1 ? '' : 's'} Out`;
  });
  labels.push('6 Weeks Out', '2 Weeks Out', 'Wedding Day');
  return labels;
}

function checklistUserMessage({ displayName, weddingDate, weddingDateFormatted, venueName, venueLocation, guestCount, brief }) {
  const lines = [
    `Couple: ${displayName || 'Unnamed couple'}`,
    `Wedding date: ${weddingDateFormatted || weddingDate}`,
  ];
  if (venueName)  lines.push(`Venue: ${venueName}${venueLocation ? ` (${venueLocation})` : ''}`);
  if (guestCount) lines.push(`Guest count: ${guestCount}`);
  if (brief?.trim()) { lines.push('', 'Brief:', brief.trim()); }
  lines.push('', 'Target dates for the 11 milestones:');
  milestoneDates(weddingDate).forEach((d, i) => lines.push(`  Milestone ${i + 1}: ${d}`));
  lines.push('', 'Generate the 11-milestone planning checklist now.');
  return lines.join('\n');
}

/**
 * Generate a planning checklist for a couple.
 * @param {object} input
 * @param {string} input.weddingDate          ISO date e.g. "2026-10-10"
 * @param {string} [input.weddingDateFormatted]
 * @param {string} [input.displayName]
 * @param {string} [input.venueName]
 * @param {string} [input.venueLocation]
 * @param {number} [input.guestCount]
 * @param {string} [input.brief]
 */
export async function generateChecklist(input) {
  if (!input?.weddingDate) throw new Error('weddingDate is required');

  const response = await client().messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 8000,
    thinking: { type: 'adaptive' },
    output_config: {
      format: { type: 'json_schema', schema: CHECKLIST_RESPONSE_SCHEMA },
      effort: 'medium',
    },
    system: [{ type: 'text', text: checklistSystemPrompt(), cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: checklistUserMessage(input) }],
  });

  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock) throw new Error('No text block in Claude response');
  const parsed = JSON.parse(textBlock.text);

  return {
    planning_summary: parsed.planning_summary,
    milestones:       parsed.milestones,
    usage: {
      input_tokens:                response.usage.input_tokens,
      output_tokens:               response.usage.output_tokens,
      cache_creation_input_tokens: response.usage.cache_creation_input_tokens || 0,
      cache_read_input_tokens:     response.usage.cache_read_input_tokens     || 0,
    },
  };
}

// ── Vendor outreach generator (Phase 4d) ───────────────────────────────
//
// Generates draft intro emails for pending/shortlist vendor slots.
// One email per vendor type. Output saved to vendor.note via apply route.

function vendorOutreachSystemPrompt() {
  return `You are Zoe McDaniel, founder and lead planner at Zuzu Collective, a boutique wedding and event planning company in San Diego. You're drafting initial outreach emails to potential vendors for a new couple.

Zuzu's email voice:
  • Warm but confident — never overly eager or gushing.
  • Selective — Zuzu is the expert, the vendor would be lucky to work with this wedding.
  • Concise — 3–4 short paragraphs, no fluff, no excessive adjectives.
  • Professional — you're one vendor to another, not a bride emailing cold.
  • Specific — mention the date, venue, and something concrete about what makes this wedding interesting.

Email structure:
  1. Opening: who you are, who the couple is, the date and venue. One sentence.
  2. Brief: what makes this wedding distinctive (palette, scale, vibe, any unusual logistics). Two to three sentences.
  3. Ask: what you're looking for from this vendor type specifically. One to two sentences.
  4. Close: propose a call or availability check. One sentence. Sign off as Zoe.

Use [Contact Name] as the salutation placeholder (will be filled in when sending).
Subject line: "{Couple names} | {Wedding date} | {Vendor type} Inquiry" — clean and direct.

Do not invent vendor-specific details you weren't given. Do not over-promise exclusivity or uniqueness.`;
}

const VENDOR_OUTREACH_SCHEMA = {
  type: 'object',
  properties: {
    drafts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          vendor_type: { type: 'string', description: 'Matches the input vendor_type exactly.' },
          subject:     { type: 'string', description: 'Email subject line.' },
          body:        { type: 'string', description: 'Full email body including salutation and sign-off.' },
        },
        required: ['vendor_type', 'subject', 'body'],
        additionalProperties: false,
      },
    },
  },
  required: ['drafts'],
  additionalProperties: false,
};

function vendorOutreachUserMessage({ displayName, weddingDate, venueName, venueLocation, toneKeywords, vendors, brief }) {
  const lines = [
    `Couple: ${displayName || 'Unnamed couple'}`,
    `Wedding date: ${weddingDate || 'TBD'}`,
  ];
  if (venueName)     lines.push(`Venue: ${venueName}${venueLocation ? ` (${venueLocation})` : ''}`);
  if (toneKeywords)  lines.push(`Wedding tone: ${toneKeywords}`);
  if (brief?.trim()) { lines.push('', 'Additional context:', brief.trim()); }
  lines.push('', 'Generate outreach emails for these vendor types:');
  vendors.forEach(v => {
    const line = `  • ${v.vendor_type}${v.note ? ` — ${v.note}` : ''}`;
    lines.push(line);
  });
  lines.push('', 'One email per vendor type listed above.');
  return lines.join('\n');
}

/**
 * Generate vendor outreach draft emails.
 * @param {object} input
 * @param {string} [input.displayName]
 * @param {string} [input.weddingDate]   formatted date string
 * @param {string} [input.venueName]
 * @param {string} [input.venueLocation]
 * @param {string} [input.toneKeywords]
 * @param {Array}  input.vendors         [{id, vendor_type, note}]
 * @param {string} [input.brief]
 */
export async function generateVendorOutreach(input) {
  if (!input?.vendors?.length) throw new Error('vendors array is required');

  const response = await client().messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 8000,
    thinking: { type: 'adaptive' },
    output_config: {
      format: { type: 'json_schema', schema: VENDOR_OUTREACH_SCHEMA },
      effort: 'medium',
    },
    system: [{ type: 'text', text: vendorOutreachSystemPrompt(), cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: vendorOutreachUserMessage(input) }],
  });

  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock) throw new Error('No text block in Claude response');
  const parsed = JSON.parse(textBlock.text);

  return {
    drafts: parsed.drafts,
    usage: {
      input_tokens:                response.usage.input_tokens,
      output_tokens:               response.usage.output_tokens,
      cache_creation_input_tokens: response.usage.cache_creation_input_tokens || 0,
      cache_read_input_tokens:     response.usage.cache_read_input_tokens     || 0,
    },
  };
}

// ── Vendor smart import ───────────────────────────────────────────────────
// Accepts a file buffer + mime type (image or plain text) and asks Claude
// to extract vendor contact details. Returns a flat object with whatever
// fields it could find; missing fields are empty strings.

const VENDOR_EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    vendor_type:  { type: 'string' },
    display_name: { type: 'string' },
    contact_name: { type: 'string' },
    email:        { type: 'string' },
    phone:        { type: 'string' },
    address:      { type: 'string' },
    note:         { type: 'string' },
  },
  required: ['vendor_type','display_name','contact_name','email','phone','address','note'],
  additionalProperties: false,
};

export async function extractVendorInfo({ buffer, mimeType }) {
  const isImage = mimeType.startsWith('image/');

  let userContent;
  if (isImage) {
    userContent = [
      {
        type: 'image',
        source: { type: 'base64', media_type: mimeType, data: buffer.toString('base64') },
      },
      { type: 'text', text: 'Extract all vendor contact details visible in this image.' },
    ];
  } else {
    userContent = [
      { type: 'text', text: `Extract vendor contact details from the following:\n\n${buffer.toString('utf-8')}` },
    ];
  }

  const response = await client().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    output_config: { format: { type: 'json_schema', schema: VENDOR_EXTRACT_SCHEMA } },
    system: `You are a data-extraction assistant for a wedding planning company.
Extract vendor contact information and return it as JSON.
vendor_type: best-fit category (e.g. Photographer, Florist, Venue, Caterer, etc.)
display_name: business name
contact_name: person's name if present
email, phone, address: as written
note: any other useful detail (e.g. website, Instagram, specialty)
Use empty string "" for any field you cannot find.`,
    messages: [{ role: 'user', content: userContent }],
  });

  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock) throw new Error('No text in Claude response');
  return JSON.parse(textBlock.text);
}

const TILE_DESCRIBE_SCHEMA = {
  type: 'object',
  properties: {
    label: { type: 'string' },
    title: { type: 'string' },
    note:  { type: 'string' },
  },
  required: ['label', 'title', 'note'],
  additionalProperties: false,
};

export async function describeTileImage({ buffer, mimeType }) {
  const response = await client().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    output_config: { format: { type: 'json_schema', schema: TILE_DESCRIBE_SCHEMA } },
    system: `You are a creative director writing editorial copy for a luxury wedding design page.
Given an inspiration image, return three short text fields:
label: a 1-3 word category tag in ALL CAPS (e.g. CEREMONY · FLORALS · TABLESCAPE · LIGHTING)
title: a single evocative sentence describing the visual mood (max 12 words, no full stop)
note: an optional short caption with a specific detail visible in the image (max 10 words, or empty string)
Write in a refined, editorial tone — poetic but concrete. No clichés.`,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: mimeType, data: buffer.toString('base64') } },
      { type: 'text', text: 'Describe this wedding inspiration image.' },
    ] }],
  });
  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock) throw new Error('No text in Claude response');
  return JSON.parse(textBlock.text);
}

export async function generateTimeline({ ceremonyTime, weddingDate, venueName, venueLocation, guestCount, notes }) {
  const SCHEMA = {
    type: 'object',
    properties: {
      phases: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title:       { type: 'string' },
            window_text: { type: 'string' },
            note_text:   { type: 'string' },
            variant:     { type: 'string', enum: ['standard','ceremony','sendoff'] },
            events: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  time_text:   { type: 'string' },
                  meridiem:    { type: 'string' },
                  title:       { type: 'string' },
                  where_label: { type: 'string' },
                  lead_label:  { type: 'string' },
                  with_label:  { type: 'string' },
                  note_text:   { type: 'string' },
                },
                required: ['time_text','meridiem','title','where_label','lead_label','with_label','note_text'],
                additionalProperties: false,
              },
            },
          },
          required: ['title','window_text','note_text','variant','events'],
          additionalProperties: false,
        },
      },
    },
    required: ['phases'],
    additionalProperties: false,
  };

  const ctx = [
    ceremonyTime   ? `Ceremony time: ${ceremonyTime}` : null,
    weddingDate    ? `Wedding date: ${weddingDate}` : null,
    venueName      ? `Venue: ${venueName}${venueLocation ? `, ${venueLocation}` : ''}` : null,
    guestCount     ? `Guest count: ${guestCount}` : null,
    notes          ? `Special notes: ${notes}` : null,
  ].filter(Boolean).join('\n');

  const response = await client().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    system: `You are a luxury wedding day coordinator generating a detailed minute-by-minute timeline.
Create a complete, realistic wedding day schedule with 5-8 phases and 4-8 events per phase.
Phases in order: Getting Ready, First Look & Wedding Party Photos, Ceremony, Cocktail Hour, Reception (dinner/toasts/dances), Grand Exit.
Use variant=ceremony for the Ceremony phase, variant=sendoff for Grand Exit, variant=standard for all others.
window_text format: "8:00 AM – 12:00 PM". time_text is just the time like "8:00" or "4:30", meridiem is "AM" or "PM".
where_label, lead_label, with_label are short detail lines (or empty string ""). note_text is an italic note (or "").
Work backwards from the ceremony time to set getting-ready start. Cocktail hour immediately follows ceremony.
Reception follows cocktail hour with dinner, toasts, first dance, parent dances, cake cutting, open dancing.
Be specific and realistic — include buffer times, transitions, photography golden hour if applicable.`,
    messages: [{ role: 'user', content: `Generate a full wedding day timeline.\n\n${ctx}` }],
  });

  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock) throw new Error('No text in Claude response');
  return JSON.parse(textBlock.text);
}

export async function importGuestList({ buffer, mimeType }) {
  const SCHEMA = {
    type: 'object',
    properties: {
      households: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            display_name: { type: 'string' },
            side: { type: 'string', enum: ['bride','groom','both','bridal_party'] },
            guests: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  display_name: { type: 'string' },
                  guest_type: { type: 'string', enum: ['adult','child','plus_one'] },
                },
                required: ['display_name','guest_type'],
                additionalProperties: false,
              },
            },
          },
          required: ['display_name','side','guests'],
          additionalProperties: false,
        },
      },
    },
    required: ['households'],
    additionalProperties: false,
  };

  let userContent;
  if (mimeType === 'application/pdf') {
    userContent = [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } },
      { type: 'text', text: 'Extract all guests from this wedding guest list document.' },
    ];
  } else if (mimeType.startsWith('image/')) {
    userContent = [
      { type: 'image', source: { type: 'base64', media_type: mimeType, data: buffer.toString('base64') } },
      { type: 'text', text: 'Extract all guests from this wedding guest list.' },
    ];
  } else {
    userContent = [{ type: 'text', text: `Extract all guests from this wedding guest list:\n\n${buffer.toString('utf-8')}` }];
  }

  const response = await client().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    system: `You are extracting a wedding guest list into structured data.
Group guests into households (families/couples who share an address or travel together).
display_name for households: use the family name ("Smith Family") or couple name ("John & Jane Smith").
side: 'bride' if clearly bride's side, 'groom' if groom's side, 'bridal_party' if in the wedding party, 'both' if unclear.
guest display_name: full name ("Jane Smith").
guest_type: 'adult' for adults, 'child' for children/minors, 'plus_one' for unnamed plus-ones.`,
    messages: [{ role: 'user', content: userContent }],
  });

  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock) throw new Error('No text in Claude response');
  return JSON.parse(textBlock.text);
}

// ── Vendor search: query generation + result parsing ─────────────────────

const VENDOR_SEARCH_QUERIES_SCHEMA = {
  type: 'object',
  properties: {
    queries: {
      type: 'array',
      items: { type: 'string' },
      description: '3-5 targeted Google search queries.',
    },
  },
  required: ['queries'],
  additionalProperties: false,
};

export async function generateVendorSearchQueries({ styleDescription, vendorType, location }) {
  const response = await client().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    output_config: { format: { type: 'json_schema', schema: VENDOR_SEARCH_QUERIES_SCHEMA } },
    system: `You are a search strategist for a luxury wedding planning company. Given a vendor type, location, and wedding style, generate 3-5 targeted Google search queries that will surface the best matching vendor businesses. Queries should be specific, location-anchored, and style-aware. Do not include review sites like Yelp, The Knot, or WeddingWire in the queries — focus on finding vendor business websites directly.`,
    messages: [{ role: 'user', content: `Vendor type: ${vendorType}\nLocation: ${location || 'San Diego, CA'}\nStyle: ${styleDescription || 'elegant, refined'}\n\nGenerate search queries now.` }],
  });
  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock) throw new Error('No text in Claude response');
  return JSON.parse(textBlock.text);
}

const VENDOR_CANDIDATES_SCHEMA = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          display_name: { type: 'string', description: 'Business name.' },
          vendor_type:  { type: 'string', description: 'Vendor category.' },
          website:      { type: 'string', description: 'Website URL or empty string.' },
          email:        { type: 'string', description: 'Email if visible or empty string.' },
          phone:        { type: 'string', description: 'Phone if visible or empty string.' },
          address:      { type: 'string', description: 'Location/address or empty string.' },
          description:  { type: 'string', description: 'One sentence about what makes them a good match.' },
        },
        required: ['display_name','vendor_type','website','email','phone','address','description'],
        additionalProperties: false,
      },
    },
  },
  required: ['candidates'],
  additionalProperties: false,
};

export async function parseVendorSearchResults({ results, vendorType, styleDescription }) {
  if (!results || results.length === 0) return { candidates: [] };

  const resultText = results.map((r, i) =>
    `[${i + 1}] ${r.title}\n${r.link}\n${r.snippet}`
  ).join('\n\n');

  const response = await client().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    output_config: { format: { type: 'json_schema', schema: VENDOR_CANDIDATES_SCHEMA } },
    system: `You are a researcher for a luxury wedding planning company. Given Google search results, extract distinct vendor businesses that match the requested vendor type and style. Deduplicate — if the same business appears multiple times, include it once. Skip directories, review sites, and listicles — only include individual businesses. For each, write a one-sentence description of why they might be a good match based on what's visible in the snippet.`,
    messages: [{ role: 'user', content: `Vendor type being searched: ${vendorType}\nStyle: ${styleDescription || 'elegant, refined'}\n\nSearch results:\n\n${resultText}\n\nExtract vendor candidates now.` }],
  });

  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock) throw new Error('No text in Claude response');
  return JSON.parse(textBlock.text);
}
