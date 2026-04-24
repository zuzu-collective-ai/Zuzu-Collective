# Portal mockup — landing page

Static HTML/CSS proof of the portal's aesthetic before any backend work. No framework, no build step — open `landing.html` in a browser.

## How to view

```
open portal/mockup/landing.html        # macOS
xdg-open portal/mockup/landing.html    # Linux
```

Or any static server (`python3 -m http.server` in this directory, then visit `http://localhost:8000/landing.html`).

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
| Portal cards link to `#` | Wire to real page paths once the 8 sub-pages exist |

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
