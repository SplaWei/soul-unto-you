---
name: session-relay
description: >-
  Manage portable, low-context cross-window session handovers via docs/CURRENT_STATE.md.
  Use when the user asks to save progress, update the relay baton, switch to a new chat window
  ("更新接力棒", "保存进度", "换窗口"), or resume work in a fresh window ("继续", "接力", "下一步").
---

# Session Relay Workflow

Keep context tiny by storing only live decisions, next steps, and pitfalls in `docs/CURRENT_STATE.md`.

## Mode A: Save Baton Before Switching Windows ("更新接力棒" / "保存进度" / "换窗口")
1. Run `node --test tests/*.test.ts` to confirm the exact current pass/fail state.
2. Overwrite `docs/CURRENT_STATE.md` in place (`<= 60` lines, strictly zero private paths/IDs/keys):
   - **当前阶段与基线**: active phase, latest verified behavior, stopped/shelved items.
   - **环境与健康基线**: exact latest `node --test` result, local services/models status.
   - **关键避坑备忘**: 2–4 hard lessons learned in this session so the next window never repeats them.
   - **下一步精确任务**: the next 1–4 concrete file-level tasks with acceptance criteria.
3. Re-run `node --test tests/*.test.ts` if any tracked file changed to confirm the zero-privacy scan stays green.
4. Reply with **「白话版」+「专业版」**, telling the user they can now open a brand-new window and simply type `继续`.

## Mode B: Resume Baton in a New Window ("继续" / "接力" / "下一步")
1. Read `docs/CURRENT_STATE.md` immediately.
2. Do **not** read `CHANGELOG.md`, `HANDOVER_*.md`, or other `docs/` files unless a specific design contract in `docs/CURRENT_STATE.md` requires checking one section.
3. Read only the 1–2 source files directly named in Step 1 of **下一步精确任务**, briefly state the current stage in one sentence, and start implementing right away.
