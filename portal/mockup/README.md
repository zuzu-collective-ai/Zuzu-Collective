# Portal mockup

Static HTML/CSS proof of the portal's aesthetic before any backend work. No framework, no build step — open the files in a browser.

## Pages built so far

- `landing.html` — hero, intro, palette preview, footer. The couple's "home."
- `palette.html` — page header, primary palette (circle swatches), tone & feeling, inspiration grid, materials detail. Section 02 of the portal.
- `vendors.html` — single-column editorial list of all **17 vendor types** from Zoe's spreadsheet (Venue, Caterer, Photographer, Videographer, Florist, DJ, Band, Wedding Planner, Officiant, Hair Stylist, Makeup Artist, Transportation, Baker/Cake, Hotel Room Block, Rehearsal Dinner Venue, Honeymoon Hotel, Honeymoon Airline). Each entry shows mono eyebrow + big italic company name + labeled contact list (Contact / Phone / Email / Address) + a status pill (Booked · Shortlisting · Pending · N/A). TBC vendors get a short italic note describing what's being looked for instead of contacts. Anti-spreadsheet — no grid lines, no table cells. Section 03.
- `checklist.html` — **11 month-by-month milestones** from "12 Months Out" through "Day Of," with 52 total tasks. Each milestone shows a mono date eyebrow, an italic title ("The foundation," "The big bookings," "Filling in the canvas," etc.), task progress count, and a list of custom Finn-filled checkboxes. Three milestone states render differently: `is-done` (with a "Complete" badge), `is-active` ("You are here" indicator + subtle Tobacco-tinted background), `is-upcoming` (quieter date and progress). The "Day Of" milestone gets centered/celebratory treatment. Section 04.
- `budget.html` — summary stats (total / spent / remaining), the **"Generate suggested split"** AI-allocator placeholder, **19 itemized categories** matching Zoe's working spreadsheet (Venue, Catering, Photography, Videography, Florals & Decor, Rentals, Dress, Groom Attire, Cake, Music & Sound, Hair & Makeup, Transportation, Officiant, Stationery, Rings, Favors, Rehearsal Dinner, Planner, Misc). Each category shows Estimated / Actual / Remaining as a 3-cell block + line items + status pills. Section 05.
- `timeline.html` — the day-of run-of-show. **Six phases** (Getting Ready · First Look & Portraits · Ceremony · Cocktail Hour · Reception · Send-off) and **30 timed events** from 8:00 AM hair-and-makeup through the 10:45 PM town-car departure. Each event renders as `time | details` with mono time + italic title + labeled `Where` / `Lead` / `With` metadata + an optional italic note (entrance song, confetti staging, wine pairing). The Ceremony phase gets a Tobacco-tinted highlight band and the Send-off phase gets centered/celebratory treatment, mirroring the checklist's "active" and "Day Of" milestones. Summary strip shows date / ceremony time / event count / last call. Print-friendly (hides the topbar and footer). Section 06.
- `guest-list.html` — guest list, RSVP, and seating in one page (they share source data). Top: 5 KPIs (Invited 124 · Accepted 98 · Awaiting 12 · Declined 14 · Seated 84) and a filter strip (All · Bride's side · Groom's side · Both · Bridal party · Children — visual only in the mockup). Middle: **RSVP grouped by status** — `Awaiting reply` first (Tobacco-tinted highlight band, the follow-up list Zoe needs this week), then `Accepted` (with Cypress / Bay / Olive / Beach / Bougainvillea / Sage / Manzanita table assignments shown), then `With regrets`. Households are the unit — each entry shows mono eyebrow + italic household name + flat list of guests (with `· child` and italic plus-one annotations) + an optional italic note (dietary, mobility, conflicts) + a stacked right column with table assignment and status pill. Bottom: **10 table cards** in a 2-column grid — head table (Cypress) inverts to Finn/Moonlight, every other table shows a numbered `01–10` seat list with `Open seat` italics in unfilled slots. Closes with a 3-column "Still to seat" bucket of 14 accepted guests waiting for assignment. Section 07.

The top nav is wired between Home ↔ Palette ↔ Vendors ↔ Checklist ↔ Budget ↔ Timeline ↔ Guest List. The one remaining link (Floor Plan) still points to `#` until that page exists.

The combined "Guest List, RSVP, and Seating" section replaces what used to be a separate "Seating" tab — guest list and seating share source data, so they live on one page.

## How to view

```
open portal/mockup/landing.html        # macOS
xdg-open portal/mockup/landing.html    # Linux
```

Or any static server (`python3 -m http.server` in this directory, then visit `http://localhost:8000/landing.html`). Click through the top nav to see the palette page.

## What this proves

Two layers render together cleanly:

1. **Zuzu brand shell** — Moonlight background, Finn plum, Cormorant Garamond + Fragment Mono, signature block, "escape the mundane." Constant across every couple's portal.
2. **Couple overlay** — Alicia & Jack's ivory/chartreuse palette, their name, venue, date, style keywords. Every other couple overrides these.

The overlay is driven by CSS custom properties scoped to `[data-couple="..."]` on `<html>`. Swap that selector (or its variables) and the portal re-themes without touching markup.

See `styles/tokens.css` for the two-layer token definitions.

## Stubs to swap later

| Stub | How to replace |
|---|---|
| Wordmark is text "Zuzu" in Cormorant Garamond | When the Zuzu submark SVG lands in `brand/logo/`, replace `.wordmark` contents with `<img src="...">` |
| Hero background is a warm stone color | Drop the engagement photo at `portal/mockup/assets/hero.jpg`, then uncomment the `.hero-photo` override block in `styles/landing.css` |
| Fonts are Cormorant Garamond + Fragment Mono (free Google Fonts) | When Romie + Art Company Mono `.woff2` files land in `portal/mockup/assets/fonts/`, declare them via `@font-face` and update `--zz-display` / `--zz-mono` in `tokens.css` |
| Top nav: 1 of 8 still links to `#` | Wire to real page paths as each sub-page is built (Home + Palette + Vendors + Checklist + Budget + Timeline + Guest List done; Floor Plan remaining) |
| Budget numbers are placeholder data for Alicia & Jack ($120K total) | Replace with the couple's real budget when wired to the DB |
| Vendor company names + contacts are placeholder data | Replace with real per-couple vendor entries when wired to the DB; populate from the Zuzu vendor Rolodex (Google Sheets for now) |
| Checklist tasks are static — checkboxes toggle visually but don't persist | Wire to DB so each couple's task state is saved; surface "current milestone" automatically based on wedding date vs. today |
| Timeline events, phases, and metadata are placeholder data for Alicia & Jack | Make editable per couple so Zoe can drag/edit/reorder events; auto-populate the lead vendor from the Vendors table |
| Guest list / RSVP / seating data is static placeholder for Alicia & Jack | Wire to DB so households, RSVP statuses, and table assignments persist; build a real RSVP flow at `portal.zuzucollective.com/rsvp/<household-slug>` for guests; let Zoe drag guests between tables in admin |
| Filter chips on the guest list are visual only | Wire to client-side filtering across the household list and the seating chart |
| "Generate suggested split" button is disabled, copy says "coming soon" | Wire to a Claude API call (`/claude-api` skill) — input total, return per-category allocation using wedding-industry averages. Build with prompt caching for the system prompt. |
| Budget + vendors + checklist are read-only HTML | Make editable in the real product — Zoe should be able to add/edit/delete categories, line items, vendors, tasks, and amounts per couple |
| Inspiration tiles tint with the couple's palette colors | Drop reference photos at `assets/inspo/*.jpg`, swap `background` on `.inspo-tile` to the image URL |
| Material swatches are CSS gradients (silver, matte white, clear glass) | Swap for real texture photos when ready |

## Voice compliance

Copy on this page follows `brand/ZuzuCollective BrandVoicePrompt.pdf`:

- Uses: "escape the mundane", "intentional", "design" (not "decorate"), "Let's chat", "Sincerely" (signature)
- Avoids: "your special day", "your big day", "bringing your vision to life", "I hope this email finds you well"
- Signature block matches the brand doc exactly
- No ellipses, no excessive exclamation points, no emoji

## Next

- Zoe reviews aesthetic direction
- Iterate on typography, spacing, layout as needed
- When the look is locked, graduate this mockup into the real Express/Postgres portal scaffold (§14 of the original brief)
