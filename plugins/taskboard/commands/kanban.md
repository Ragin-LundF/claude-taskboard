---
description: Put the current work on the live taskboard (plan, split, assign) and show the board URL
argument-hint: "[what to plan — optional]"
---

Use the taskboard skill.

1. Call `board_open` with `launchBrowser: true` and tell me the URL.
2. Call `board_list` to see what is already on the board for this project.
3. Work out the tasks for: $ARGUMENTS
   If nothing was given, use the current work in this conversation: the implementation being
   discussed, any plan or todo list, and open tasks.
4. Put the tasks on the board with `board_plan`. Split anything too big into subtasks, skip tasks
   that are already on the board, and mark any task that is already being worked on as in progress
   with its assignee.
5. Reply with a short summary: how many cards were created and what is in progress.
