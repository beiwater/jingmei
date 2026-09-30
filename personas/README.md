# Persona templates

`template.zh.md` and `template.en.md` are public, generic starting points. Copy one to a new file in this directory, write the character's identity, voice and boundaries in the copy, and point that persona's `personaPath` in `jingmei.config.json` at it:

```bash
cp personas/template.zh.md personas/luna.md
```

中文：`template.zh.md` / `template.en.md` 是公开的通用模板。复制一份（如 `personas/luna.md`），在副本里写角色的身份、说话方式和边界，再把 `jingmei.config.json` 里对应角色的 `personaPath` 指向它。

All other `personas/*.md` files are ignored by Git because deployment prompts may contain private identity, relationship, or operating context. The persona file is read when a channel session is created, so restart the service after editing it.

Existing Git history may still contain files removed from the current HEAD. Removing those historical objects would require a separate, explicitly coordinated history rewrite and credential/privacy review.
