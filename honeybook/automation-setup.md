# HoneyBook Automation Setup — Zuzu Collective Client Onboarding

_Step-by-step configuration guide for the full inquiry-to-contract pipeline._
_All email copy lives in `email-templates.md`. Build the automations here, then paste template copy into each step._

---

## Before you start: one-time setup

### 1. Create pipeline stages

In HoneyBook go to **Settings → Pipeline** and create these stages in order:

| Stage name | Purpose |
|---|---|
| Inquiry received | New lead, not yet contacted |
| Discovery call booked | Scheduler appointment confirmed |
| Call complete — proposal | Zoe marked call done, proposal path |
| Call complete — not a fit | Zoe marked call done, decline path |
| Proposal sent | Proposal delivered to client |
| Contract & retainer sent | Proposal accepted, awaiting signatures |
| Active client | Contract signed + retainer paid |
| Archived — declined | Lead declined or not a fit |

### 2. Create lead tags

In HoneyBook go to **Settings → Tags** and add:

- `full-service`
- `partial-planning`
- `month-of`
- `design-only`
- `event` (non-wedding)

These are applied during the inquiry form (see Inquiry Form section below) and used to pull the correct proposal template in Stage 3.

### 3. Build your proposal templates

Create one saved proposal template per service type in **Templates → Smart Files**:

- `Proposal — Full-Service`
- `Proposal — Partial Planning`
- `Proposal — Month-of Coordination`
- `Proposal — Design-Only`

Each template should include: scope of work, investment, payment schedule (50% retainer + 50% balance), and contract terms.

---

## Inquiry form setup

Go to **Templates → Contact Forms** and build one form with the following fields:

| Field | Type | Notes |
|---|---|---|
| First name | Text | Required |
| Last name | Text | Required |
| Email | Email | Required |
| Phone | Phone | Optional |
| Event date | Date | Required |
| Event type | Dropdown | Wedding / Event |
| Service interested in | Dropdown | Full-service / Partial planning / Month-of / Design-only |
| Venue (if booked) | Text | Optional |
| Guest count (estimate) | Number | Optional |
| Tell us about your event | Long text | "What are you envisioning? No detail is too small." |
| How did you find us? | Dropdown | Instagram / Referral / Google / Other |

**After form submission:** HoneyBook should auto-create a new project and move it to **Inquiry received** stage. The service type selected on the form should auto-apply the matching tag (configure this under form settings → tags).

---

## Stage 1 automation — Inquiry received

**Trigger:** New project created via contact form (or manually added to "Inquiry received" stage)

### Automation steps

1. **Wait:** 0 minutes (send immediately, within 5 min target)
2. **Send email:** T1 — Inquiry acknowledgment (from `email-templates.md`)
3. **Internal notification to Zoe:** "New inquiry: {first_name} {last_name} — {service_type} — {event_date}. Review and confirm service tag is applied."

### Notes

- The 5-minute response goal is met by triggering send immediately on stage entry.
- Verify the service type tag was correctly applied from the form before the call. If the client didn't select a service type, Zoe should tag manually.
- No further automations fire at this stage until the client books a call OR 48 hours pass.

---

## Stage 1 → 2 transition: 48-hour nudge

**Trigger:** 48 hours after T1 sent, project still in "Inquiry received" stage (no scheduler appointment confirmed)

### Automation steps

1. **Condition check:** Is project still in "Inquiry received"? (i.e., no call booked)
2. **If yes:** Send email T3 — 48-hour follow-up nudge
3. **If no:** Do nothing (call already booked, Stage 2 automation handles from here)

### Notes

- Send this nudge once only. Do not create a recurring follow-up loop.
- If the client still doesn't book after T3, Zoe reviews the lead manually at 7 days.

---

## Stage 2 automation — Discovery call booked

**Trigger:** HoneyBook scheduler appointment confirmed; project moves to "Discovery call booked" stage

### Automation steps

1. **Send email:** T2 — Discovery call confirmation (immediately on booking)
2. **Internal notification to Zoe:** "Discovery call confirmed: {first_name} {last_name} — {call_date} at {call_time}. Service type: {service_type}. Event date: {event_date}. [Link to project]"

### Notes

- The internal notification gives Zoe a quick lead summary before the call — no extra prep work needed.
- No client-facing automations fire between booking and the call itself.

---

## Stage 3 automation — Post-discovery

**Trigger:** Zoe marks call complete in HoneyBook (manual action)

Zoe should log this by updating the project stage. Two paths:

### Path A: Send proposal

1. Zoe moves project to **"Call complete — proposal"** stage
2. HoneyBook generates proposal from saved template matching the client's service type tag
3. Zoe reviews and personalizes the proposal (add specific notes from the call, confirm pricing)
4. Zoe sends proposal — project auto-moves to **"Proposal sent"** stage on delivery

### Path B: Not a fit

1. Zoe moves project to **"Call complete — not a fit"** stage
2. **Automation:** Send email T4 — Graceful decline (immediately on stage entry)
3. **Automation:** After T4 confirms sent, move project to **"Archived — declined"**

### Notes

- Proposal templates should be pre-built with standard scope and pricing per service type. Zoe only needs to personalize 2–3 lines before sending.
- The "not a fit" path is fully automated after Zoe moves the stage. No further action needed.

---

## Stage 4 automation — Proposal sent

**Trigger:** Proposal delivered to client; project moves to "Proposal sent" stage

Two time-based automations run in parallel from this point:

### Branch A: Proposal not opened

1. **Wait:** 48 hours from proposal delivery
2. **Condition check:** Has proposal been opened?
3. **If not opened:** Send email T5 — Proposal not opened follow-up
4. **If opened:** Branch A ends (Branch B handles from here)

### Branch B: Proposal opened but not signed

1. **Condition check:** Has proposal been opened?
2. **If opened:** Start 72-hour timer from open event
3. **Wait:** 72 hours from first open
4. **Condition check:** Has proposal been signed/accepted?
5. **If not signed:** Send email T6 — Proposal opened check-in
6. **If signed:** Branch B ends (Stage 5 automation handles from here)

### If proposal is declined

1. Zoe moves project to **"Archived — declined"**
2. Zoe logs decline reason in the project notes field (required before archiving)
3. No automated email is sent on decline — Zoe handles any response personally if warranted

### Notes

- T5 and T6 each fire once only. No additional follow-up automations after these.
- If no response after T6, Zoe reviews the lead manually at 14 days post-proposal.

---

## Stage 5 automation — Contract and retainer

**Trigger:** Proposal accepted; project moves to "Contract & retainer sent" stage

### Automation steps (on proposal acceptance)

1. **Auto-send:** Contract via HoneyBook smart file (use your saved contract template)
2. **Auto-send:** Retainer invoice for 50% of total project amount
3. **Internal notification to Zoe:** "{first_name} {last_name} accepted their proposal. Contract and retainer invoice auto-sent. [Link to project]"

### Automation steps (on both contract signed AND retainer paid)

HoneyBook should detect both events. When both are confirmed:

1. **Send email:** T7 — Welcome email
2. **Move project** to **"Active client"** stage
3. **Internal notification to Zoe:** "{first_name} {last_name} is confirmed! Contract signed and retainer paid. Welcome email sent. Move to active client workflow."

### Notes

- The retainer invoice is always 50% of the total quoted in the proposal. Confirm this amount is correct in the auto-generated invoice before activating.
- T7 fires only when both conditions are met (signed + paid), not on contract signature alone.
- "Active client" stage is the handoff point to your post-booking workflow (outside scope of this pipeline).

---

## Quick reference: automation map

```
New inquiry
    └── T1: Inquiry acknowledgment (immediate)
    └── [48 hrs, no booking] → T3: Nudge (once)

Call booked
    └── T2: Call confirmation (immediate)
    └── Internal notification to Zoe

Zoe marks call complete
    ├── [Not a fit] → T4: Graceful decline → Archive
    └── [Send proposal] → Zoe personalizes → Proposal sent

Proposal sent
    ├── [Not opened 48 hrs] → T5: Not opened follow-up (once)
    └── [Opened, not signed 72 hrs] → T6: Check-in (once)
    └── [Declined] → Archive, log reason (Zoe handles manually)

Proposal accepted
    └── Auto-send contract + retainer invoice
    └── [Both signed + paid] → T7: Welcome email → Active client
```

---

## Success metrics tracking

HoneyBook's pipeline view and reports will surface these — check monthly:

| Metric | Target | Where to find it |
|---|---|---|
| Inquiry response time | Under 10 minutes | Automation send logs |
| Inquiry → call booked rate | Track trend | Pipeline stage counts |
| Proposal → contract conversion | Track monthly | "Archived — declined" vs "Active client" counts |
| Time from inquiry to discovery call | Zoe spends < 15 min | Check pipeline activity log |

For conversion rate: at the start of each month, count projects that moved to "Active client" in the prior month divided by projects that reached "Proposal sent." Log this in a simple spreadsheet to track trend over time.
