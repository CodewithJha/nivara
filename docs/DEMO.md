# Demo video script (1:30 to 2:00, live site)

Recorded on the live Render deploy: https://nivara-x9iv.onrender.com

Goal: show her morning in under two minutes. Seller screens first, Behind the scenes last. Speak slowly and in your own voice; the lines below are a guide, not a teleprompter.

## Before you hit record

1. **Wake the site.** Free Render sleeps, though a keep-alive ping runs every 10 minutes until 15 Oct. Open https://nivara-x9iv.onrender.com/api/health and wait until JSON appears (30 to 60 seconds on a cold start). Then open the app itself.
2. **Check Health.** Open the menu (top right on a phone width) and tap Health. You want Live on MongoDB Atlas, Render, Gemma (Gemma 4 26B A4B), ElevenLabs, TabPFN, Tiger Data, SerpApi, Backboard and Sentry. Mastra and Temporal show Standby on Render; that's expected, don't hide it.
3. **Check today's brief.** The app writes it at 8 AM IST by itself. If you record before 8, or the brief shows yesterday's date, tap "Make a fresh brief" on Today once and wait for it to finish.
4. **Warm Gemma.** Ask one throwaway question ("What orders are still pending?") so the first on-camera answer isn't the slow one.
5. **Voice note clip.** Use the test clip at `~/Projects/nivara-voice/test-hinglish-voice-note.opus` (it says "राहुल भाई को 2 MB Biozyme way भेज देना कल तक"). Upload it once before recording to check it reads as Rahul Verma, 2 × MB biozyme whey, ₹5,198, delivery tomorrow. Don't press "Confirm and save" during the check.
6. **Microphone.** Use Chrome. Tap Speak on Ask once, allow the microphone, say something, tap Stop. Make sure it transcribes. If ElevenLabs misbehaves the Ask page quietly falls back to the browser's speech, which handles Hinglish less well, so test it.
7. **Window size.** Make the browser about phone width (around 400 px, or use DevTools device mode at 375 px) so it looks like her phone. Hide bookmarks and other tabs. Zoom 100 to 110%.
8. **Read today's numbers.** The live data changes daily (dates, which product is at risk, which saving is biggest). Glance at Today, Forecast and Suppliers and note the real figures so you read what's actually on screen, not the examples below. The delivery date for "कल तक" is the day after you record.
9. **Don't write to the live database by accident.** Uploading a voice note or tapping "Read the message" only makes a draft. "Confirm and save" and "Mark delivered" change real data in Atlas. Decide in advance whether you'll press confirm on camera. It's fine, it adds Order 9 to Today; afterwards tell me and I'll put the demo data back.
10. Quiet room, notifications off, screen recorder at 1080p.

## Shot list

| Time | Screen | Do | Say |
|---|---|---|---|
| 0:00 to 0:10 | Today (phone width) | Hold still on the barbell at the top. | "My friend runs a supplements shop on her own, from her phone. Orders come in as WhatsApp messages and voice notes, mostly Hinglish, and she keeps stock in her head. This is Nivara, built for her." |
| 0:10 to 0:22 | Today | Point at the plates, then scroll slowly past the big first job and the Deliver list. | "Every job is a plate on the bar, heaviest first. Red is now, yellow is this week, green is when you have a minute. The biggest job gets the whole screen and one button." |
| 0:22 to 0:44 | Orders (menu, then Orders) | Tap the menu button, tap Orders. Under "From a voice note" tap "Upload a voice note" and pick `test-hinglish-voice-note.opus`. Wait for "Check this order" and hold on the "Heard" line. | "Most of her orders are voice notes. She forwards one here. ElevenLabs turns the Hinglish into text, Gemma reads the words, and everything after that is code: it ignores the 'bhai', finds Rahul Verma, matches the whey from her stock list, works out ₹5,198, and turns 'kal tak' into tomorrow's date. Nothing saves until she confirms." |
| 0:44 to 0:58 | Ask (menu, then Ask) | Tap Ask. Tap Speak, say **"Mujhe kya restock karna chahiye?"**, tap Stop. When the answer shows, tap "Read aloud" for two seconds, then stop it. | "She can just talk. The answer is read back if her hands are full. The reorder numbers come from her stock, the forecast and delivery times, not from the model, and they match Today and Forecast." |
| 0:58 to 1:10 | Ask | Type **MuscleBlaze whey under 3000**, press Enter. | "Product search runs on Tiger Data: full-text plus vector search over 212 real Indian products from Open Food Facts, with the price limit applied as a hard filter." |
| 1:10 to 1:20 | Ask | Tap the "Give me today's business brief" suggestion. | "This is her morning brief, ready at eight every morning. Who to deliver to, what runs out this week, where she can pay less. Gemma only writes the first sentence, from facts the code already checked." |
| 1:20 to 1:32 | Forecast (menu, then Forecast) | Hold on the "Worked out by TabPFN" line, then scroll down a few rows. Point at one red or yellow bar and its delivery notch. | "Next week's demand is forecast with TabPFN, and the page says so. Render has no Python, so I ran it over all 212 products on my laptop and published the result. Demand here comes from Google searches, a stand-in until her real sales build up." |
| 1:32 to 1:42 | Suppliers | Scroll to "Cheaper quotes". Point at the top one and read its saving per unit. | "A cheaper supplier only counts if it saves at least ten rupees and five percent a unit. Online prices come from SerpApi each morning." |
| 1:42 to 1:55 | Health, then Activity | Open Health, scroll the list. Then Activity, open the steps on the top entry. | "All the technical detail lives behind the scenes. Health shows every partner in plain words: Atlas, Tiger, TabPFN, ElevenLabs, Sentry, Backboard live; Temporal and Mastra on standby on the free host. Activity shows each answer step by step." |
| 1:55 to 2:00 | Today | Back to Today. | "Gemma does the language, code does the facts. Nivara, for my friend. Link's below." |

## If something goes wrong on camera

- **Cold start or slow answer:** keep talking over the "Thinking" or "Listening to the voice note" line, or cut it in editing. Gemma via the free AI Studio tier can take several seconds.
- **The voice note doesn't read right:** tap Upload again once. If it still fails, paste `Rahul bhai ko 2 MB biozyme whey bhej dena kal tak` into the message box and tap "Read the message"; it goes through the same steps.
- **Speak doesn't catch the Hinglish:** type the same question. Say "she can type too" and move on.
- **An error box appears:** tap Retry once. If it still fails, cut and re-record that shot.
- **A price looks odd in search:** most prices are estimates from pack size (only 4 of 212 came from Open Prices). The whey tubs that were priced as sachets are fixed, but don't zoom in on a price you haven't checked.

## Too long? Cut in this order

1. Read aloud (save 3 s)
2. The brief shot (save 10 s, the article covers it)
3. Activity, keep only Health (save 5 s)

## Notes for the edit

- Captions help: put the "Heard" line, "kal tak = tomorrow" and the Hinglish Ask question on screen.
- The recording button on Orders works too, but uploading the clip gives the same result every take.
- Optional extra line on Ask: type **Rahul ka order kab deliver karna hai?** It answers with Rahul's orders and due dates.
- The example questions on Ask only read data, so tapping any of them on camera is safe.
