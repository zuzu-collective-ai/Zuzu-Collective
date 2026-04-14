# HoneyBook Email Templates — Zuzu Collective Client Onboarding

_Written in Zoe's voice per the Brand Voice Prompt and Communication Style Guide._
_Merge field placeholders use `{curly_brace}` notation — map these to your actual HoneyBook field names before activating automations._

---

## Merge fields reference

| Placeholder | What it maps to |
|---|---|
| `{first_name}` | Client's first name |
| `{event_date}` | Event date |
| `{service_type}` | Service type from inquiry form |
| `{call_date}` | Scheduled discovery call date |
| `{call_time}` | Scheduled discovery call time (include timezone) |
| `{scheduler_link}` | HoneyBook scheduling page URL |
| `{proposal_link}` | Proposal smart file link |

---

## T1 — Inquiry acknowledgment

**Stage:** 1 — Inquiry received
**Trigger:** New HoneyBook inquiry submitted
**Send:** Within 5 minutes of inquiry

---

**Subject:** Your inquiry — Zuzu Collective

Hi {first_name},

Thank you so much for reaching out — I'd be honored to be a part of what you're creating!

A little about how we work: before a single vendor is booked or a palette is chosen, we start by getting to know *you* — your story, your taste, what moves you. Then we design something that couldn't exist for anyone else. We pull from film, nature, art, and culture. The result feels like a world you've stepped into, not an event that was assembled.

I'd love to set up a call to hear more about your vision. You can book a time directly here: **{scheduler_link}**

Sincerely,

Zoe McDaniel
Founder & Creative Director
Zuzu Collective

Bespoke weddings & events that escape the mundane
Story-driven design rooted in intention

---

## T2 — Discovery call confirmation

**Stage:** 2 — Discovery call booked
**Trigger:** HoneyBook scheduler appointment confirmed
**Send:** Immediately on booking

---

**Subject:** Our call is confirmed — a few things to think about

Hi {first_name},

So excited for our call on {call_date} at {call_time}!

To make the most of our time together, I'd love for you to think through a few things beforehand — nothing formal, just to get ideas flowing:

- What's the overall feeling you want to create? Not the details yet, just the mood — what you want people to walk away feeling.
- Are there any films, places, images, or moments in your life that capture the aesthetic you're drawn to?
- What matters most to you about this event — the design, the guest experience, the flow of the day, or all of it equally?
- Is there anything about the planning process that feels uncertain or overwhelming right now?

Come as you are. These are just conversation starters. 🙂

From here, we'll spend our time getting to know each other and talking through what a partnership with Zuzu could look like for you.

Sincerely,

Zoe McDaniel
Founder & Creative Director
Zuzu Collective

Bespoke weddings & events that escape the mundane
Story-driven design rooted in intention

---

## T3 — 48-hour follow-up nudge (no call booked)

**Stage:** 2 — No call booked within 48 hours of inquiry acknowledgment
**Trigger:** 48 hours after T1 sent, no scheduler appointment confirmed
**Send:** Once only

---

**Subject:** Still here — Zuzu Collective

Hi {first_name},

Just making sure my last note didn't get lost. I'd love to connect and hear about what you're planning.

When you're ready, you can grab a time here: **{scheduler_link}**

Sincerely,

Zoe McDaniel
Founder & Creative Director
Zuzu Collective

Bespoke weddings & events that escape the mundane
Story-driven design rooted in intention

---

## T4 — Graceful decline

**Stage:** 3 — Post-discovery, "Not a fit" selected
**Trigger:** Zoe selects "Not a fit" outcome after marking call complete
**Send:** Immediately on selection

---

**Subject:** Thank you — Zuzu Collective

Hi {first_name},

It was genuinely lovely speaking with you, and thank you for sharing your vision with me.

After our conversation, I don't think we're the right fit for your event — and I'd rather be honest with you now than have you spend time moving forward with the wrong partner.

I'm rooting for you to find someone who's exactly right for what you're building. Wishing you a beautiful event.

Sincerely,

Zoe McDaniel
Founder & Creative Director
Zuzu Collective

Bespoke weddings & events that escape the mundane
Story-driven design rooted in intention

---

## T5 — Proposal not opened (48-hour follow-up)

**Stage:** 4 — Proposal sent, not opened after 48 hours
**Trigger:** Proposal delivered, no open tracked after 48 hours
**Send:** Once only

---

**Subject:** Just checking — your proposal

Hi {first_name},

Just making sure your proposal arrived safely — sometimes these end up in spam.

Your custom proposal is ready to review here: **{proposal_link}**

Take your time, and feel free to email or text me if anything comes up before you look it over.

Sincerely,

Zoe McDaniel
Founder & Creative Director
Zuzu Collective

Bespoke weddings & events that escape the mundane
Story-driven design rooted in intention

---

## T6 — Proposal opened, not signed (72-hour check-in)

**Stage:** 4 — Proposal opened but not signed after 72 hours
**Trigger:** Proposal opened, no signature after 72 hours
**Send:** Once only

---

**Subject:** Any questions on your proposal?

Hi {first_name},

Checking in to see if you had a chance to look over the proposal and if anything came up for you.

I'm happy to answer questions, talk through scope, or adjust anything before you decide. No pressure — I just want to make sure you have everything you need.

Sincerely,

Zoe McDaniel
Founder & Creative Director
Zuzu Collective

Bespoke weddings & events that escape the mundane
Story-driven design rooted in intention

---

## T7 — Welcome email (contract signed + retainer paid)

**Stage:** 5 — Contract signed AND retainer invoice paid
**Trigger:** Both contract signature and retainer payment confirmed in HoneyBook
**Send:** Immediately on both conditions met

---

**Subject:** Welcome to Zuzu Collective

Hi {first_name},

This is officially happening — I'm so honored you chose to work with us!

Your contract and retainer are confirmed, and you're now an active Zuzu Collective client. Design is my favorite part of this process and I love to get ideas flowing early, so expect to hear from me within the next few business days to get things underway.

In the meantime, feel free to email or text me anytime.

Sincerely,

Zoe McDaniel
Founder & Creative Director
Zuzu Collective

Bespoke weddings & events that escape the mundane
Story-driven design rooted in intention
