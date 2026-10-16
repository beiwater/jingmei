---
layout: home
title: 精魅
titleTemplate: 住在群里的 AI 群宠

hero:
  name: 精魅
  text: 住在群里的 AI 群宠
  tagline: Discord 与 Telegram 双平台 · 一份配置养几个性格不同的角色 · 基于 Pi 构建
  image:
    src: /logo.webp
    alt: 精魅
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/quick-start
    - theme: alt
      text: 能做什么
      link: /guide/
    - theme: alt
      text: GitHub
      link: https://github.com/beiwater/jingmei

features:
  - icon: 💬
    title: 懂内容再接话
    details: 被 @、被回复、被叫名字一定回应；普通消息按概率与内容判断接话，冷却与发言占比门控，不刷屏。
    link: /guide/
  - icon: 🖼️
    title: 看图、看视频
    details: 每条消息最多 4 张图交给模型，视频用 ffmpeg 抽帧；主模型不能看图时可配看图模型先描述。
    link: /guide/
  - icon: 🎙️
    title: 语音、画图、长文转图
    details: Fish Audio 语音，Antigravity 画图，长回复渲染成带公式和函数图的图片，还有实时 K 线图。
    link: /features/
  - icon: 🧠
    title: 记得群友
    details: 记住名字、生日和本人说过的长期信息，按需回想；每个角色还有自己的 soul。成员随时 /forget。
    link: /reference/commands
  - icon: 🔎
    title: 联网搜索与历史检索
    details: DeepSeek 联网搜索附来源；更早的群聊用关键词 + 语义检索找回，只查当前群。
    link: /guide/
  - icon: 💸
    title: 省 token
    details: system prompt 与工具定义稳定以命中前缀缓存，对话段有上限，reasoning 默认关闭。
    link: /dev/architecture
  - icon: 🛡️
    title: 沙箱计算
    details: run_js 在 bubblewrap 隔离的短时子进程里做精确计算，没有沙箱就拒绝启动。
    link: /guide/deploy#run_js-操作系统沙箱
  - icon: 🧰
    title: 好养活
    details: init 向导生成配置，doctor 一键自检，改配置自动热重载，update 一条命令更新。
    link: /reference/cli
---

<div class="home-extra vp-doc">

## 几条命令养起来

需要 Linux、Bun 1.3+、bubblewrap，以及一个 Discord 或 Telegram bot 和模型凭据。详见[快速开始](/guide/quick-start)。

```bash
git clone https://github.com/beiwater/jingmei.git
cd jingmei
bun install
bun run jingmei init   # 交互向导：平台、token、角色、模型
bun run start
```

<img class="startup" src="../assets/startup.gif" width="480" alt="启动动画">

</div>
