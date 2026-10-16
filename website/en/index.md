---
layout: home
title: Jingmei
titleTemplate: An AI group pet for your chats

hero:
  name: Jingmei
  text: An AI group pet for your chats
  tagline: Discord and Telegram · several characters from one config · built on Pi
  image:
    src: /logo.webp
    alt: Jingmei
  actions:
    - theme: brand
      text: Quick start
      link: /en/guide/quick-start
    - theme: alt
      text: What it does
      link: /en/guide/
    - theme: alt
      text: GitHub
      link: https://github.com/beiwater/jingmei

features:
  - icon: 💬
    title: Reads the room
    details: Always answers when mentioned, replied to or called by name; otherwise chimes in by probability and content, gated by cooldowns and share of the conversation.
    link: /en/guide/
  - icon: 🖼️
    title: Sees images and video
    details: Up to 4 images per message go to the model, videos are sampled with ffmpeg, and a separate vision model can describe images for text-only models.
    link: /en/guide/
  - icon: 🎙️
    title: Voice, drawing, long-text images
    details: Fish Audio voice messages, Antigravity drawing, long replies rendered as images with formulas and plots, and live candlestick charts.
    link: /en/features/
  - icon: 🧠
    title: Remembers members
    details: Names, birthdays and lasting facts people state about themselves, recalled on demand; each character keeps its own soul. Anyone can /forget.
    link: /en/reference/commands
  - icon: 🔎
    title: Web and history search
    details: DeepSeek web search with sources; older chat is found again by keyword and semantic search, scoped to the current group.
    link: /en/guide/
  - icon: 💸
    title: Token-frugal
    details: A stable system prompt and tool list hit provider prefix caches, conversation segments are bounded, and reasoning is off by default.
    link: /dev/architecture
  - icon: 🛡️
    title: Sandboxed math
    details: run_js computes in a short-lived bubblewrap-isolated subprocess; without the sandbox the bot refuses to start.
    link: /guide/deploy#run_js-操作系统沙箱
  - icon: 🧰
    title: Easy to keep
    details: An init wizard writes the config, doctor checks everything, config edits hot-reload, and update is one command.
    link: /en/reference/cli
---

<div class="home-extra vp-doc">

## Up and running in a few commands

You need Linux, Bun 1.3+, bubblewrap, a Discord or Telegram bot and model credentials. See [Quick start](/en/guide/quick-start).

```bash
git clone https://github.com/beiwater/jingmei.git
cd jingmei
bun install
bun run jingmei init   # wizard: platforms, tokens, characters, model
bun run start
```

<img class="startup" src="../../assets/startup.gif" width="480" alt="Startup animation">

</div>
