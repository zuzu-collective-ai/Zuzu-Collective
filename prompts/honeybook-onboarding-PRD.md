# PRD: HoneyBook client onboarding workflow


## Overview
Automate the full client onboarding sequence in HoneyBook — from first inquiry to signed contract — so no lead falls through the cracks and Zoe's time is protected for high-value work.

## Problem
Inquiry responses, follow-ups, and contract sends are currently manual. Delays in response reduce booking rate. Repetitive writing wastes time that could go toward client experience and design work.

## Goal
A new inquiry should trigger an automatic, warm and brand-accurate response within minutes. From there, a semi-automated pipeline should move leads through to a signed contract with minimal manual input from Zoe.

## Scope
**In scope:** HoneyBook automations, email templates, inquiry form, proposal workflow, contract send
**Out of scope:** Post-booking workflows, vendor management, day-of coordination tools

## Workflow stages

### Stage 1 — Inquiry received
Trigger: new HoneyBook inquiry submitted
- Auto-send branded inquiry response within 5 minutes
- Email includes: warm acknowledgment, Zuzu's three differentiators, link to book a discovery call
- Tag lead with service type (full-service, partial, day-of, design-only)

### Stage 2 — Discovery call booked
Trigger: calendar link clicked / appointment confirmed
- Auto-send confirmation email with call prep questions
- Zoe receives internal notification with lead summary
- If no booking within 48 hrs: send one follow-up nudge

### Stage 3 — Post-discovery
Trigger: Zoe marks call complete in HoneyBook
- Zoe selects outcome: "Send proposal" or "Not a fit"
- If not a fit: send graceful decline email
- If send proposal: generate proposal from saved template based on service type

### Stage 4 — Proposal sent
Trigger: proposal delivered to client
- If not opened in 48 hrs: auto follow-up
- If opened but not signed in 72 hrs: send one gentle check-in
- If declined: archive lead, log reason

### Stage 5 — Contract and retainer
Trigger: proposal accepted
- Auto-send contract via HoneyBook
- Auto-send retainer invoice (50% of total)
- Once both signed and paid: trigger welcome email and move to active client pipeline

## Email tone requirements
- Warm but confident — never overly eager
- Selective — Zuzu is the expert, client is lucky to work with her
- Concise — no fluff, no excessive adjectives
- Brand voice: boutique, design-forward, calm

## Success metrics
- Inquiry response time under 10 minutes
- Proposal-to-contract conversion rate tracked monthly
- Zoe spends less than 15 minutes per lead before discovery call

## Open questions
- Does Amanda handle any inquiry responses independently?
- Should design-only leads go through the same pipeline or a separate one?
- Which scheduler to use — Calendly or HoneyBook native?
