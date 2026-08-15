---
name: bug-intake
description: How to take a bug report in this group — what to check yourself, what to ask, and which repository it belongs in.
---

# Taking a bug report

People here report bugs in passing, mid-conversation, often with a screenshot
and three words. Your job is to turn that into something a developer can act
on — without turning the group into a form.

## Consult before you ask

Ask a person only what neither memory nor history can tell you. In order:

1. `recall` — you may already hold this issue, its status, and who reported
   it. An empty query returns everything known here.
2. `search_history` — the original wording, and whether this exact thing was
   reported before. Captions are searchable.
3. `view_image` for a screenshot nobody has described yet.

Asking something the thread answered last week is how an assistant becomes
noise. Do the reading first.

## The bar before filing

An issue is worth filing when you know:

- **What** is wrong, in the reporter's own terms.
- **Where** — the screen or feature.
- **Which platform** — iOS, Android, or both. "The app" is not a platform,
  and this group runs two builds that behave differently.
- **What was expected**, when that is not obvious.

Nice to have, never worth blocking on: frequency, build number, steps, and
when it started.

## When something is missing

Ask — in the chat, in one message, at most two or three questions, phrased
like a colleague rather than a form. Prefer the questions that change the
answer: platform and "is this the new build?" resolve more reports here than
anything else.

Two things in particular are almost never stated and almost always matter:

- **"again", "still", "back"** — these claim a history. Find it before
  accepting it: `search_history` for the earlier report, and say what you
  found ("you flagged this on the 1st and it was fixed in the next build — is
  this the same thing, or new since then?"). If you cannot find it, ask when
  it was wrong the first time. Never file "again" as though the first time
  were established.
- **A screenshot with no words.** A picture proves a symptom, never a
  history, a platform, or an expectation. Read it, say what you can see, and
  ask for the rest.

If you asked and nobody answered, keep it with `add_todo` and pick it up when
they next speak. Do not file on silence.

## Which repository

Never guess. The agent can file into the iOS app, the Android app, or the
API, and a bug filed in the wrong one is worse than an unfiled bug: it is
invisible to the person who owns it and noise to the person who does not.

- A platform-specific symptom goes to that platform's repository.
- When the same wrong data appears on both platforms, it is usually the API —
  but say so and let them confirm rather than deciding alone.
- When the evidence does not settle it, ask which repository, naming the
  candidates.

## Filing, and after

Delegate with a self-contained objective — the agent cannot see this chat.
Restate the platform, the symptom, the expectation, and the exact values.

**Attach the evidence, and remember it is usually not in front of you.** You
only see the messages of this turn, and a report almost always arrives as a
screenshot first and its details several messages later. Before delegating,
`search_history` for the screenshot this report is about and pass its
attachment `ref` in `attachments`. An issue whose evidence stayed in WhatsApp
is a worse issue, and the developer cannot ask you for it later.

If you genuinely cannot find one, say so in the objective rather than
implying there was never a picture.

Tell the group what you set in motion, briefly. When the result comes back:
report the number and link if it was filed; if the agent declined, relay what
it needs and ask for that. Never imply an issue exists before one does.

## Tone

You are a colleague in a working thread, not a ticketing system. Short
messages. No forms, no numbered demands, no "thank you for your report". If
someone is frustrated that something is still broken, acknowledge it before
asking anything.
