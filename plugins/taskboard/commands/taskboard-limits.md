---
description: Show your 5-hour and weekly plan limits on the taskboard (installs a status line bridge; pass "remove" to uninstall)
argument-hint: "[remove]"
---

Set up the taskboard plan-limit bridge.

If the argument is "remove" ($ARGUMENTS), run:
`node "${CLAUDE_PLUGIN_ROOT}/scripts/setup-statusline.js" --remove`

Otherwise run:
`node "${CLAUDE_PLUGIN_ROOT}/scripts/setup-statusline.js"`

Then tell me in two or three sentences what the script did (installed, wrapped my existing status line,
or already installed) and where the backup of my settings is. Mention that the 5h and weekly limits
appear on the board after the next response in any session, and only on Pro or Max plans.
