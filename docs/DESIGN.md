**The world:** the lifting platform in her gym: black rubber floor, chalk dust, a steel bar and competition bumper plates whose colour tells every lifter the weight from across the room.
**The feeling:** heavy things look heavy. One glance tells her how loaded today is and which plate to lift first; a light day looks light.
**The signature:** the loaded bar. Today's jobs sit edge-on on a steel bar, heaviest first (the way a bar is loaded), and every row in the app starts with its plate edge.

# Design System: Nivara

## Overview

**Creative North Star: "The loaded bar."** The owner runs a supplements shop from her phone, between WhatsApp chats, and trains in the same world he sells to. Competition plates are a colour code his whole audience already reads without thinking: red is heaviest, yellow is mid, green is light. Nivara spends that code on one thing only: how heavy a job is. The rest of the app is chalk and rubber: plain, loud type on a chalk ground, black bands where the weight sits.

Mode: Operate. Expression lives in three devices: the loaded bar (Today), the plate edge that opens every status row, and the drenched field that holds the single heaviest job. Everything else is type, rules and white space.

**Key Characteristics:**
- Hierarchy from type size, width and weight, never from boxes. No cards anywhere.
- Plate colour = job weight. Plate thickness carries the same meaning, so colour is never alone.
- Rubber black owns whole bands (top bar, load strip, primary buttons); chalk is the floor.
- Every number tabular; money through `inr()`; order IDs read "Order 4".

## Colors

Rubber and chalk carry the brand at page scale; the three plate colours are status and nothing else. Tokens live in `public/styles.css`.

### Primary
- **Rubber** (`--rubber` #141414): top bar, load strip, primary buttons, display type, table head rule. Chalk on rubber is 16:1.
- **Chalk** (`--chalk` #F2F1EC): page ground. A cool dusty white, never cream.

### Status (plates)
- **Plate red** (`--red` #C8102E): do now. Overdue orders, products that run out before new stock can arrive. Chalk text on it 5.2:1. Text form `--red-ink` #A50E22 (6.9:1 on chalk).
- **Plate yellow** (`--yellow` #F5C400): this week. Due today/tomorrow, no date, runs out within 7 days, fallbacks. Only rubber text on it (11:1). Text form `--amber-ink` #7A5600.
- **Plate green** (`--green` #0E7A3B): light. Money to save when she has a minute; live / delivered / fine. Chalk text on it 4.8:1. Text form `--green-ink` #0B6631.

### Neutral
- **Iron** (`--iron` #4A4740): secondary text on chalk (8.2:1). Used sparingly; most text is rubber.
- **Fog** (`--fog` #B8B5AB): secondary text on rubber (9:1).
- **Line** (`--line` #C9C6BC): row hairlines only.
- **Steel** (`--steel` #8E9093): the bar, collar and sleeve. Never text.
- **Paper** (`--paper` #FFFFFF): input fields only, so a field reads as a place to write.

**The Plate Rule.** Red, yellow and green mean job weight. They never decorate, never mark a brand moment, never fill a button on chalk.
**The No-Violet Rule.** No purple, indigo, blue, gradients, glass or glow.

## Typography

**Display Font:** Anybody (Etcetera Type, OFL, variable width 50–150, weight 100–900), self-hosted in `public/fonts/`.
**Body Font:** Atkinson Hyperlegible Next (Braille Institute, OFL, variable weight 200–800), self-hosted.

**Character:** expanded, heavy Anybody reads like the raised lettering on a bumper plate and fills a phone line with a job name; Atkinson is built for reading at a glance, with unambiguous 1/l/I and 0/O, which matters for quantities and rupees. Both carry tabular figures and ₹.

### Hierarchy
- **Job** (Anybody 850, width 125, `--t-job` clamp 2.25–4.5rem, 0.95): the heaviest job on Today. Once per screen.
- **Title** (Anybody 850, width 140, `--t-3` 2.25rem, 1): view titles.
- **Head** (Anybody 800, width 125, `--t-2` 1.625rem): section heads, followed by a count in the same line.
- **Name** (Anybody 700, width 112, `--t-1` 1.25rem): first line of a row (product, customer), and big row figures.
- **Body** (Atkinson 400, 1rem, 1.5): everything else, measure ≤ 68ch. Buttons and nav in Atkinson 700.
- **Small** (Atkinson 400, `--t-sm` 0.8125rem): provenance ("TabPFN v2 · 4 Oct").

**The Tabular Rule.** `font-variant-numeric: tabular-nums` on the body; figures right-align in columns.
**The Sentence Case Rule.** No uppercase labels, no tracked eyebrows. Heads, buttons and table heads are sentence case.

## Layout

Top bar (rubber) holds the wordmark and, from 900px, all nine views inline, with Workflows / Activity / Health set apart after a gap. Under 900px the views move to a fixed rubber bottom bar: Today, Ask, Orders, Stock, More (native popover with the other five).

Views are full width; content columns cap at `--page` (78rem) with `--gut` side padding. Bands (`.bleed`) run edge to edge. Today from 1024px: load strip and heaviest-job field full bleed, then 2:1 columns (the day's rows / Ask + brief); Ask uses the same split (conversation / "Try asking"). Section rhythm: `--s-8` above a head, `--s-3` below. Tables become label/value rows under 760px (secondary columns marked `wide` drop out); nothing scrolls sideways. The forecast cover bar keeps one fixed length (`--cover-w`) so rows compare.

## Elevation & Depth

Flat. No shadows. Depth comes from rubber bands against chalk and the bar running behind the plates.

## Shapes

Steel is square, rubber is barely rounded: plates, buttons and inputs take `--r-rubber` (3px); everything else is square. Plates on the bar are equal height and vary only in thickness, as real bumper plates do.

## Components

### Loaded bar (signature)
Rubber band. A steel shaft runs in from the left to the inner collar; plates follow heaviest first, threaded by a steel hub band at shaft height, then the outer clip collar and the sleeve end. The date and the tally ("6 do now · 4 this week · 8 when you can") sit on the shaft, left of the plates. Thickness: heavy `--plate-heavy` (2.5rem), mid `--plate-mid` (1.75rem), light `--plate-light` (1.25rem), spaced by `--plate-gap` so every plate has a 24px pitch. From 900px each plate is a button that jumps to its row, labelled with the job and its weight; on phones plates shrink (1/0.75/0.5rem) and turn decorative, because they are too thin to tap, and the rows carry the jump. Entrance: plates slide onto the bar once (420ms, expo out, 45ms stagger), off under reduced motion.

### Heaviest job
Full-bleed field in the plate colour of the first job. Kicker: the weight word in Anybody 800 at width 150 ("Do now") plus the count in body text ("· first of 18 jobs today"); then the Job line, a facts line, and actions at `--t-1` with `--s-3`/`--s-5` padding. Buttons on the field invert: chalk primary, outlined secondary.

### Row (`.row`)
Plate edge (thin vertical plate, same weight code) · name and why-line · figure on the right (Anybody, tabular) · optional action. Rows are separated by Line hairlines. Rows without status show an empty outlined edge.

### Buttons
Primary: rubber fill, chalk text. Secondary: 2px rubber outline; hover fills rubber. Text links for low-weight actions. Disabled: 50% opacity, progress cursor. Focus: 3px outline in the context ink (rubber on chalk and yellow, chalk on rubber, red and green).

### Inputs
Paper field, 2px rubber border, `--r-rubber`. Placeholder in Iron. Focus uses the same 3px outline.

### Navigation
Atkinson 700 on rubber; inactive in Fog, current in Chalk with a steel bar underneath (`aria-current="page"`).

## Do's and Don'ts

### Do:
- **Do** write jobs in her words: "Deliver Sneha's order", "Restock Gym Gloves", "Pay less for Mass Gainer 3kg".
- **Do** let the heaviest job be the biggest thing on Today, and keep it to one.
- **Do** pair every plate colour with a word or a thickness so colour is never alone.
- **Do** use tokens only: `--s-*`, `--t-*`, `--plate-*`.

### Don't:
- **Don't** add cards, KPI tiles, pills, badges, rounded boxes, shadows, gradients or emoji.
- **Don't** use plate colours on Workflows / Activity / Health except as status.
- **Don't** say AI, copilot, magic, seamless, "AI-powered".
