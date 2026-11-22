---
description: Push open questions (from a file or this conversation) to the taskboard so you can answer them in the browser
argument-hint: "[path to questions file — optional]"
---

Use the taskboard skill.

1. Collect the open questions:
   - If a file was given ($ARGUMENTS), read it. Typical formats: a Markdown list or table, or JSON,
     with a question id, description and recommendation per entry. Skip entries already answered.
   - Otherwise look for questions files in this project (names containing "question" or "fragen",
     e.g. OPEN_QUESTIONS.md, questions.json, docs/open-questions.md) and for open questions in this
     conversation.
2. Push them with one `board_ask_many` call: `id` = the existing id (create stable ids like "Q-1" if
   there are none), `description`, `recommendation`, `options` if there are clear alternatives,
   `taskId` if a board task relates to it.
3. Reply with a short summary: how many questions are on the board, and which were already answered.
   When answers arrive, write the decisions back into the file.
