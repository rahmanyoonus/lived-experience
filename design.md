# Lived Experience design system

This file records the implemented visual direction for the capture application.
The product behaviour remains governed by `Lived_Experience_PRD_v0.1.md` and
`AGENTS.md`.

> Capture first. Make sense of it later.

## Character

The interface should feel calm, private, literary and unhurried. The person’s
story is the dominant visual material. Avoid dashboard framing, decorative
imagery, productivity language, prominent recording animation and unnecessary
containers.

## Foundations

### Colour

| Token | Value | Use |
| --- | --- | --- |
| `--paper` | `#f2ede2` | Application background |
| `--surface-card` | `#fffdf8` | Dialogs and raised cards |
| `--surface-sunken` | `#e9e3d3` | Quiet disabled or inset states |
| `--surface-cream` | `#faefd9` | Restrained attention surfaces |
| `--ink-1` | `#26221b` | Primary text |
| `--ink-2` | `#5d564a` | Supporting text |
| `--ink-3` | `#8b8272` | Metadata and quiet labels |
| `--line-1` | `#e2dac7` | Hairline divisions |
| `--line-2` | `#ccc3ac` | Inputs and stronger divisions |
| `--accent` | `#1e453a` | Primary actions, links and focus |
| `--accent-soft` | `#e3eae3` | Selected quiet controls |
| `--recording` | `#a4443c` | Recording, always paired with words |
| `--review` | `#7c611f` | Review and sync attention states |

Do not use gradients, pure black, pure white or multiple competing accents in
the capture experience.

### Typography

- Newsreader Variable carries the person’s words, display titles and quiet
  reassurance copy.
- Public Sans Variable carries navigation, controls, status and metadata.
- Story text is `19px` at `1.7` line height and never smaller.
- Story measure is capped at `62ch`.
- Use sentence case. Tiny artefact labels may use tracked uppercase.

Both fonts are bundled through Fontsource. The application must not depend on a
third-party font request at runtime.

### Space and shape

- Use the 4px-based spacing scale in `src/styles.css`.
- The capture canvas is a single centred column, at most `680px` wide.
- Controls use pill corners; fields use 6px corners; cards and dialogs use 10px.
- Hairlines provide most separation. Shadows are reserved for dialogs and
  genuinely raised cards.

## Capture layout

The header contains the plain-text product name, current navigation and truthful
save status. No logo has been adopted.

The empty canvas presents, in order:

1. A short invitation and device-only privacy explanation.
2. `Just listen`, `Guide me` and `Give me a prompt` controls.
3. The borderless literary story editor.
4. The recording action and quiet capture state.

Once content exists, the introductory copy leaves the canvas so the person’s
words become the page. `Keep this story`, originals, recovery and error actions
appear only when their real state makes them relevant.

Do not reintroduce a split-screen hero, onboarding steps, feature bullets,
dashboard cards or explanatory marketing panels around the editor.

## Interaction

- `Just listen` is selected by default.
- Disabled guidance controls remain visible and are announced as unavailable.
- Recording has a still dot, words, elapsed time and one minimal muted sine wave
  to confirm that capture is active. It never uses a reactive audio visualiser,
  pulse or live transcript.
- The transcript appears only after explicit stop and processing.
- Hover and focus changes are brief colour shifts only. No element scales,
  bounces or moves while the person writes or records.
- Focus uses a 2px forest-green outline with a 2px offset.
- Reduced-motion preferences make the sine wave static and remove non-essential
  transitions.

## Status language

Persistence language must correspond to the acknowledged layer:

- `Saving…`
- `Saved locally · Only on this device`
- `Securing your story…`
- `Saved · Private in your account`
- `Not yet synced`

Colour never carries a status by itself.

## Dialogs and library

Dialogs use a plain scrim, warm near-white surface, short title, direct copy and
right-aligned actions on desktop. They become bottom-aligned, full-width sheets
on small screens.

Story-library cards show only a factual title, capture date and time, verbatim
excerpt, voice duration and `Continue`. No category, score, summary or progress
indicator belongs in the MVP library.

## Accessibility and responsive behaviour

- Keep the skip link, semantic regions, live status announcements, focus traps
  and descriptive accessible names.
- Every voice path retains an equivalent writing path.
- Touch actions are at least 44px high on mobile.
- Mobile preserves the desktop content order. It changes spacing and stacking,
  not product behaviour.
- The capture experience is tested at 390px and 1200px widths.
