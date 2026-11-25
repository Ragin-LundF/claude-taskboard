---
name: taskboard
description: Track implementation work on the live kanban taskboard. Use when the user says "taskboard", "kanban", "track this on the board", "put it on the board", "use the board", or asks to plan/split a big implementation so they can watch progress. Also use whenever you delegate work to subagents during a multi-step implementation while the taskboard tools are available.
---

# Taskboard

A live kanban board (To Do · In Progress · Blocked · Finished) that the user watches in the browser
while agents work. It also shows token usage and lets agents ask the user questions that are
answered in the browser. It is served by the `taskboard` MCP server at http://localhost:4747 and exists only
while Claude Code sessions run. Every session on the machine shares the same board; tasks are grouped
by project (the git root of the session).

## Workflow

1. **Open** — call `board_open` once. Give the user the URL the first time (pass `launchBrowser: true`
   if they asked to open or see the board).
2. **Check first** — call `board_list` before adding anything. Reuse existing cards instead of
   creating duplicates; another agent may already have planned the work.
3. **Plan** — analyse the request (and the codebase if needed), then create the cards with one
   `board_plan` call. Good cards:
   - an imperative title of a few words ("Add JWT validation filter")
   - a description of 1–3 sentences: scope, files or modules touched, acceptance criteria
   - one deliverable each, finishable in one focused sitting
4. **Split** what is too big — touches several modules or layers, has multiple deliverables, or
   would take more than about an hour. Use nested `subtasks` in `board_plan`, or `board_split` for an
   existing card. A parent card shows progress and finishes automatically when every subtask is done,
   so never finish parents by hand.
5. **Claim** — `board_start` with an `assignee` immediately before working on a card. The assignee
   is who actually does the work:
   - yourself: use a stable name, e.g. "Claude" (or the name the user gave you)
   - subagents: give each one a short human name ("Bob", "Alice", "Mia") and use it as assignee.
     Pass the card id in the subagent prompt and tell it to call `board_start` / `board_finish`
     for that id itself (subagents can use the same tools).
6. **Finish** — `board_finish` as soon as a card is really done (code written and verified), with a
   one-line `note` on the result. Keep the board honest: one card in progress per worker.
7. **Blocked** — `board_update` with `status: "blocked"` and a `note` naming what is missing.
8. **Scope changes** — add new cards with `board_add` (use `parentId` to attach them), rewrite
   cards with `board_update`. Delete nothing.
9. **Questions go on the board, not only in the chat.** While the board is in use, every question
   for the user goes to the board so they can answer in the browser:
   - one question → `board_ask` (waits for the answer by default)
   - several questions, or questions collected in a file (OPEN_QUESTIONS.md, questions.json,
     offene-fragen.md, …) → `board_ask_many` with one entry per question: `id` (the id from the
     file, e.g. "Q-12"), `description`, `recommendation`, optional `options` and `taskId`.
     Re-pushing the same id updates the entry instead of duplicating it; already answered entries
     come back with their answer.
   - always give a `recommendation` when you have one: the user answers with **Accept**,
     **Reject** (optionally with an alternative), an option button, or free text.
   - for questions with more than accept/reject, give `options` as objects:
     `{ label, type, recommended, description }`. `type` sets the color: `accept` (green),
     `reject` (red), `neutral` (blue, anything in between). Mark your preferred option with
     `recommended: true` instead of writing "(Recommended)" into the label, and use
     `description` to explain consequences of complex choices (shown under the label).
   - answers arrive automatically, usually right after your next tool call (formatted
     `Q-3 [your id] → ACCEPTED …`, `REJECTED — instead: …`, `CHOSE: …`, or free text).
     **Do not poll `board_answers`**: every call costs tokens and answers come by themselves. Use
     it only when the user asks, with `ids: [...]` to look up specific questions (also answers that
     went to an earlier session), or with `includeOpen: true` to see what is still open. Write
     decisions back into the questions file if there is one.
   - never ask a question twice. Before asking again (e.g. after a restart or when you lost
     track), look it up with `board_answers` and `ids: [...]`. Re-pushing the same id or the same
     question text returns the existing entry (with its answer if it has one) instead of a new one.
   - don't stop and wait for answers you don't need yet: keep working on other cards, or mark
     the dependent card blocked.
   - when you have pushed questions and **nothing else is left to do**, call `board_wait` once
     instead of ending your turn. It uses no tokens while it waits and returns as soon as the user
     answers; then continue the work. **Call it at most once per turn and never in a loop.** If it
     says nothing arrived, that waiting is turned off, or that there is nothing to wait for, end
     your turn: answers reach you automatically on your next turn.
   - subagents can ask too; tell them to pass their own name as `askedBy`.
   Hooks remind you when you write a questions file or end a turn with questions in the chat.
10. **Other answer types (A2UI)** — when a question needs more than one choice or free text, use
    `board_ui` with A2UI v1.0 messages and the taskboard catalog
    (`catalogId: "https://github.com/Ragin-LundF/claude-taskboard/catalog/v1"`). One surface per
    question, `surfaceId` = your question id, exactly one component with `"id": "root"`:
    ```json
    {"version":"1.0","createSurface":{"surfaceId":"Q-31","catalogId":"https://github.com/Ragin-LundF/claude-taskboard/catalog/v1",
     "components":[{"id":"root","component":"MultiChoice","question":"Which payment methods at launch?",
     "options":[{"label":"Card","recommended":true},{"label":"Apple Pay"},{"label":"PayPal"}]}],
     "metadata":{"taskId":"T-1","askedBy":"Alice"}}}
    ```
    | Component | Use for | Fields (besides `question`, `details`) |
    |---|---|---|
    | Decision | pick one, typed options | `recommendation`, `options[{label,type,recommended,description}]` |
    | Confirm | accept / reject a recommendation | `recommendation`, `acceptLabel`, `rejectLabel` |
    | MultiChoice | pick several | `options[{label,description,recommended}]`, `min`, `max` |
    | Checklist | confirm points | `items[{label,checked}]` |
    | Form | a few values at once | `fields[{name,label,type: text/textarea/number/select/boolean,options,required,default}]` |
    | Range | a number | `min`, `max`, `step`, `unit`, `recommended` |
    | DateTime | a date / time | `mode: date/time/datetime`, `min`, `max` |
    | Ranking | an order | `items[]` |
    | Info | a note, no answer (user acknowledges) | `text` |

    `updateComponents` changes an open question, `deleteSurface` withdraws it. Answers arrive like
    other answers, as one line (`SELECTED: …`, `CHECKED: … — NOT CHECKED: …`, `FORM: a=…; b=…`,
    `VALUE: 25 min`, `DATE: …`, `ORDER: 1. … 2. …`, `ACKNOWLEDGED`). Use `board_answers` with
    `format: "a2ui"` only if you need the raw A2UI action messages.

11. **Usage** — `board_usage` reports token usage and API-equivalent cost (today, current 5-hour
    block, 7/30 days). Use it when the user asks about usage or cost.

## Rules

- Only the user removes finished cards from the board (they check them off in the UI). Never try to
  clean up the Finished column.
- Keep the board in sync while you work — update right when status changes, not in a batch at the
  end.
- Cards marked `auto` were mirrored from an agent's internal task list by a hook. Leave them alone;
  they update themselves. When you create a proper plan with `board_plan`, prefer those cards.
- If a tool reports a port conflict, tell the user to set `TASKBOARD_PORT` to a free port.
