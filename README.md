---
title: Amplify
emoji: 📣
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
---

# Amplify — اكتب بوست واحد وانشره على كل منصاتك

تطبيق شخصي لمستخدم واحد: صمّم بوستر جوه التطبيق، اختار المنصات، وكل منصة لها زرار
نشر لوحده، مع جدولة وطابور وحدود يومية وإحصائيات. المنصات المدعومة: تيليجرام،
فيسبوك (صفحات)، إنستجرام، لينكدإن، يوتيوب، تيك توك.

A personal one-user publisher: poster designer, per-platform publish buttons,
scheduling, queue, daily caps and post analytics. Supported: Telegram, Facebook
Pages, Instagram, LinkedIn, YouTube, TikTok.

**Setup (no terminal needed):** open Settings → Variables and secrets and add
`APP_PASSCODE` (protects the whole app), `ADMIN_PASSCODE` (protects the Admin
tab), and — once you have a bot — `SEED_TELEGRAM_BOT_TOKEN` +
`SEED_TELEGRAM_CHAT_ID`. Then set `MOCK_MODE=0` to publish for real.
`SEED_*` secrets are re-inserted into the database on every restart, because
free Spaces reset their disk. Full walkthrough: see the repo you downloaded
it from (`HOSTING-AR.md`).
