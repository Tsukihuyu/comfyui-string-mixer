# Skills

A **skill** is a folder here containing a `SKILL.md`. The whole file becomes the
`system` message for the LLM, so one skill = one complete prompt-writing rulebook.

```
skills/
  your-skill/
    SKILL.md        # required: the rulebook itself (plain markdown, any length)
    meta.json       # optional: {"display_name": "...", "language": "zh+en", "notes": "..."}
```

- The dropdown lists folders that contain `SKILL.md`; `meta.json` only supplies a
  display name and notes.
- Extra folders: set `SKILLPROMPT_SKILL_DIRS` (path-separator separated).
- **Restart ComfyUI after adding or renaming a skill** — the dropdown is built at
  load time.
- Long rulebooks are fine: a 20k-token template costs one prefill per run and works
  on any endpoint with a ≥32k context.

## Why nothing ships here

The well-known anime prompt templates are third-party works with their own authors and
licensing. This repository ships no prompt text at all — bring your own rulebook, or
write one. A minimal skeleton:

```markdown
# My prompt rules

1. Open with one standalone art-style sentence.
2. Then describe subject, outfit, action, framing, light — in that order.
3. Never add quality tags, artist names or negative prompts.
4. Output English by default; Chinese only when asked.
```

## Safety

A skill is **text guidance only** — the node never executes anything from it. But it is
injected as the system prompt, so an untrusted skill can steer the model. Treat
third-party skills like third-party code.
