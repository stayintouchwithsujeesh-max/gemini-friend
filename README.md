# Gemini Friend v2 (ctrl+z Speak)

A local voice-practice app. You have a daily call with a friendly native-speaker "friend" powered by Gemini 3.8 Live, then get a structured read from Claude and one drill for tomorrow.

## Run it

```
npm install            # first time only
npm start
```
Open http://localhost:3000 in Chrome. Wear headphones. Your key lives in `.env` (see `.env.example`).

## The daily loop

1. **Today**: pick a focus (Free chat, Small talk, Storytelling, Pitch, Explain, Debate), add an optional topic, start the call.
2. **Talk.** The transcript is hidden by default so you stay in the conversation. Toggle it if you want it.
3. **End call**: you land on the review with duration, your talk share and filler count.
4. **Get the read**: Copy prompt → paste into your Claude chat → paste Claude's reply back into the app → Save.
5. The app shows the summary, scores, what worked, what to work on, and **tomorrow's drill**.
6. Next call, tick "Work yesterday's drill into this call". Your friend creates natural openings to practise it without mentioning it.

## Where things are stored

- `data/sessions/*.json`: one file per call (transcript, stats, feedback, drill status). This is the app's database.
- `transcripts/*.md`: plain-text copy of each call.

Delete a file to delete that call. Nothing leaves your Mac except your voice, sent to Gemini during calls.

## Customising

- `friend-prompt.txt`: your friend's personality and rules.
- `server.js` → `MODES`: edit or add focus modes.
- `.env`: `DAILY_GOAL_MIN` (default 45), `STREAK_MIN` (minutes a day that count toward the streak, default 10), `VOICE`, `GEMINI_MODEL`.

## Notes

- The Live API closes a connection about every 10 minutes. The server reconnects with a resumption handle; you may hear a brief blip.
- Free tier: rate limits apply, and Google may use free-tier data to improve its products. Keep confidential work topics out of calls.
- Filler counts come from the transcript, which can drop "um/uh", so treat them as approximate. Claude's scores are a coach's read from one transcript: use the trend over weeks, not a single number.
- Pronunciation and tone aren't judged; feedback is based on the transcript.

## Run it in the cloud

See **DEPLOY.md**. It's a free setup (Render + Upstash + GitHub) that gives you a passcode-protected web address for any device.
