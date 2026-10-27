# kept for Hermes

Hermes reads the same `SKILL.md` as every other agent; there is no Hermes-only copy.

## Install

```sh
# From kept's well-known index (kept.host/.well-known/skills/index.json)
hermes skills install well-known:https://kept.host/.well-known/skills/kept

# Or straight from this repository
hermes skills install kept-host/skill
```

## Optional PR to `NousResearch/hermes-agent`

`optional-skills/` takes one folder per skill under a category. Copy, do not rewrite:

```
optional-skills/
  web-development/
    kept/
      SKILL.md            ← skills/kept/SKILL.md, unchanged
      scripts/
        publish.sh        ← skills/kept/scripts/publish.sh, unchanged
```

Run the script from the skill folder as `${HERMES_SKILL_DIR}/scripts/publish.sh`. Re-copy both files whenever this repository changes.
