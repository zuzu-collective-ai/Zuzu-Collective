# Portal mockup

Static HTML/CSS proof of the portal's aesthetic before any backend work. No framework, no build step — open the files in a browser.

## Pages built so far

- `landing.html` — hero, intro, palette preview, footer. The couple's "home."
- `palette.html` — page header, primary palette (circle swatches), tone & feeling, inspiration grid, materials detail. Section 02 of the portal.
- `budget.html` — summary stats (total / spent / remaining), the **"Generate suggested split"** AI-allocator placeholder, **19 itemized categories** matching Zoe's working spreadsheet (Venue, Catering, Photography, Videography, Florals & Decor, Rentals, Dress, Groom Attire, Cake, Music & Sound, Hair & Makeup, Transportation, Officiant, Stationery, Rings, Favors, Rehearsal Dinner, Planner, Misc). Each category shows Estimated / Actual / Remaining as a 3-cell block + line items + status pills. Section 05.

The top nav is wired between Home ↔ Palette ↔ Budget. The remaining four links (Vendors, Checklist, Timeline, Floor Plan, "Guest List, RSVP, and Seating") still point to `#` until those pages exist.

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
| Top nav: 5 of 8 still link to `#` | Wire to real page paths as each sub-page is built (Home + Palette + Budget done) |
| Budget numbers are placeholder data for Alicia & Jack ($120K total) | Replace with the couple's real budget when wired to the DB |
| "Generate suggested split" button is disabled, copy says "coming soon" | Wire to a Claude API call (`/claude-api` skill) — input total, return per-category allocation using wedding-industry averages. Build with prompt caching for the system prompt. |
| Budget categories and line items are read-only HTML | Make editable in the real product — Zoe should be able to add/edit/delete categories, line items, and amounts per couple |
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
