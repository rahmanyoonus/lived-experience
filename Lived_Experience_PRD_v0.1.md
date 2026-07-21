# Lived Experience

**Product Requirements Document**

*MVP web application for capturing personal stories by voice or writing*

**Version:** 0.1

**Status:** Ready for product design and prototyping

**Date:** 19 July 2026

**Product owner:** TBD

**Hackathon authentication update (20 July 2026):** Passwordless email magic
links replace Google OAuth as the only first-version sign-in method. Google
OAuth is deferred.

> **Product promise:** A private, distraction-free place where people can speak or write their stories at their own pace, with their original voice faithfully preserved.

## Document purpose

This PRD defines the agreed first version of the Lived Experience web application. It is intended to guide product design, prototyping, technical architecture, and MVP acceptance. The initial product is deliberately narrow: it prioritises effortless, trustworthy story capture before advanced organisation, categorisation, or sharing.

### Contents

1. Product definition and opportunity

2. User, jobs, and principles

3. MVP scope

4. Core user journeys

5. Experience and interface requirements

6. AI and transcription behaviour

7. Data, autosave, authentication, and trust

8. Functional and non-functional requirements

9. Success measures, risks, and release acceptance

10. Deferred work and open decisions

## 1. Product definition and opportunity

### 1.1 Concept

Many meaningful lives remain undocumented because the tools and attention normally reserved for famous public figures rarely extend to ordinary people. Lived Experience gives the person who lived the life a simple medium to capture memories, work, relationships, challenges, beliefs, and hard-earned wisdom in their own words.

The product is not initially a public biography platform, a social network, or an automated memoir generator. Its first responsibility is to help a person begin speaking or writing immediately and to preserve what they share without imposing structure while they are remembering.

### 1.2 Problem statement

- People may want to preserve their experiences but do not know where to begin or feel capable of writing a formal autobiography.

- Traditional writing tools provide a blank document but little optional support; interview services can be expensive, scheduled, and externally directed.

- Voice recorders preserve audio but make stories difficult to review, edit, continue, or connect later.

- Many AI writing experiences become intrusive by rewriting, summarising, categorising, or steering before the person has finished expressing themselves.

- Account creation, forms, titles, categories, and save actions introduce friction before the user experiences any value.

### 1.3 Product response

> **Core design rule:** Capture first. Make sense of it later.

The application opens directly to a fresh canvas. The user can speak or write, move between the two, pause, leave, and return. The product autosaves continuously, preserves original recordings and transcripts, and keeps AI guidance optional and visible. It does not require the user to define where one story ends or another begins.

### 1.4 Product positioning

| **The product is** | **The product is not (in the MVP)** |
| --- | --- |
| **A private medium for self-authored lived experience** | A public publishing or social platform |
| **Voice-first and writing-friendly** | A conventional chat interface |
| **Patient, flexible, and non-linear** | A course, streak, or deadline-driven programme |
| **AI-assisted only when useful** | An AI-authored account of the person's life |
| **Faithful to original expression** | A tool that silently polishes or reframes stories |

## 2. User, jobs, and principles

### 2.1 Primary user

The primary user is the person telling their own story. They may be documenting their life for themselves, preserving it for people close to them, or considering future public sharing. No assumption is made about age, fame, writing ability, or the perceived importance of their life.

### 2.2 Jobs to be done

| **Situation** | **Motivation** | **Desired outcome** |
| --- | --- | --- |
| **When a memory comes to me** | I want to capture it immediately | so it is not lost. |
| **When writing feels difficult** | I want to speak naturally | so the technology does not become a barrier. |
| **When I do not know where to start** | I want optional, thoughtful guidance | so I can begin without giving up control. |
| **When I pause or change direction** | I want the application to keep listening patiently | so I do not feel rushed or corrected. |
| **When I return later** | I want my stories to be intact and recoverable | so I trust the application with meaningful material. |
| **When I edit my words** | I want the original to remain recoverable | so refinement never erases what I actually said. |

### 2.3 Product principles

- **User before system.** The person's natural flow matters more than clean data, perfect story boundaries, or complete metadata.

- **Immediate value.** A first-time visitor can begin capturing before account creation.

- **Calm during speech.** The interface does not display moving text or reactive audio visualisation while the person is speaking. One minimal, muted sine wave may move only to confirm that recording is active and becomes static when reduced motion is requested.

- **Faithful preservation.** Original audio and the first transcript remain recoverable; AI never silently rewrites history.

- **AI by invitation.** Guidance and cross-story context are visible, optional, and user-controlled.

- **No completion pressure.** Stories can remain unfinished, be continued later, or contain several memories without intervention.

- **Private by default.** The initial experience is personal and non-public.

## 3. MVP scope

### 3.1 MVP outcome

A person can open the web application, capture a story through voice or writing without first creating an account, review and directly edit a faithful transcript, retain the draft locally, and use a passwordless email magic link once to preserve the story in their personal cloud library.

### 3.2 Included capabilities

- Responsive web application with a distraction-free capture canvas

- Guest voice and writing capture before sign-up

- Just listen as the default capture mode

- Visible Interview me and Guide me with a prompt options

- Calm recording state with explicit stop control, a minimal muted sine wave, and elapsed time

- Transcript displayed after the spoken segment ends

- Faithful, readable transcription with punctuation and paragraph breaks

- Direct editing with original audio, original transcript, and recoverable version history

- Continuous local autosave before authentication and cloud autosave after authentication

- Passwordless email sign-in triggered through a one-time Keep this story action

- Fresh canvas as the default authenticated landing experience

- Simple previous-stories library using AI title, date, excerpt, and duration

- Optional private **Visualise my stories** surface using a shuffled, non-chronological arrangement of factual story summaries

- Optional, visible use of earlier stories during guided sessions

### 3.3 Explicitly out of scope

- Public profiles, publishing, discovery, social interactions, or sharing controls

- Advanced AI organisation, categorisation, life timelines, themes, or generated autobiography

- Automatic splitting or merging of stories

- Photographs, documents, or other media attachments

- Nudges, reminders, streaks, or scheduled prompts

- Apple sign-in, mobile-number sign-in, or native mobile applications

- Automatic rewriting, polishing, summarising, or extracting lessons inside the capture flow

- Rich-text formatting, templates, word counts, scores, or writing analytics

## 4. Core user journeys

### 4.1 First-time guest capture

1. **Arrive.** The visitor lands directly on a fresh blank canvas with no sign-up gate.

2. **Begin.** They type immediately or select the microphone. Microphone permission is requested only after the first microphone action, with a short explanation.

3. **Speak.** Just listen is active. The canvas remains visually calm and shows a subtle Listening status, a minimal muted sine wave confirming that recording is active, and an elapsed-time indicator.

4. **Stop a segment.** The user explicitly stops recording. Silence never ends a recording automatically.

5. **Review.** The transcript appears after processing. The user may edit, type, or record another segment.

6. **Retain locally.** The story is already temporarily autosaved in the current browser and clearly labelled as device-only.

7. **Keep.** A non-blocking Keep this story action asks for an email address and offers Email me a sign-in link. The prompt does not interrupt an active capture, and the person can keep working locally after requesting the link.

8. **Authenticate.** After the passwordless link returns to the same supported browser and device, the same story remains open and is transferred to cloud autosave without duplication or lost edits. A link opened elsewhere must not delete or falsely cloud-save the original device-only draft.

### 4.2 Returning authenticated capture

- The user lands on a fresh canvas rather than a dashboard or an unfinished-story decision screen.

- A new story record begins when the user first types or starts recording; an untouched canvas creates no empty library item.

- All typed text, audio segments, and edits cloud-autosave continuously.

- Previous stories remain accessible through a quiet library control without occupying the main canvas.

### 4.3 Continue a previous story

- The user opens the story library and selects an earlier item.

- The current edited version opens in the same minimal canvas.

- New typed content is inserted at the cursor; new speech appends at the end unless the user deliberately places the cursor elsewhere first.

- The original audio and transcript remain recoverable after further editing.

- The application may later identify relationships to other material, but it does not merge, split, or interrupt the current capture.

### 4.4 Guided capture

- The user explicitly switches from Just listen to Interview me.

- The interface offers Stay with this story and Explore past stories as visible context choices.

- AI presents one question at a time as still text. A small control can read the question aloud.

- The user may answer by voice or writing, skip the question, request another, or return to Just listen at any moment.

- If Explore past stories is active, every question based on earlier material identifies and links to the source story.

- AI never interrupts an active recording or starts speaking automatically.

### 4.5 Visualise retained stories

- An authenticated user explicitly opens **Visualise my stories** outside the capture flow.

- Retained story titles and verbatim excerpts move through a slowly animated, shuffled arrangement that does not use chronology, categories, inferred relationships, or generated imagery.

- The arrangement remains stable until the user selects **Shuffle stories**. Selecting a story pauses the motion and exposes its factual metadata and an **Open story** action.

- **Pause motion** is always available. Reduced-motion preferences replace the animated arrangement with a static editorial composition without removing any story action.

- The surface remains private. Order and proximity explicitly do not imply that stories are connected, and opening a story uses the same safe open-and-continue path as the library.

### 4.6 Guest recovery

If an unsigned-in visitor closes the tab or browser, the guest draft remains recoverable on the same device for 30 days. On return, the application should make the recovered draft visible without falsely implying that it has been cloud-saved. The user can keep it through passwordless email sign-in or discard it.

## 5. Experience and interface requirements

### 5.1 Information architecture

The MVP has two primary product spaces and one optional exploratory surface:

- **Capture canvas:** the default landing and story-editing surface.

- **Your stories:** a minimal personal library for opening and continuing retained stories.

- **Visualise my stories:** a private, non-chronological animated arrangement for rediscovering retained stories without replacing the practical library.

Account and settings controls remain secondary. There is no dashboard, progress score, category navigation, public profile, or onboarding questionnaire.

### 5.2 Capture canvas

| **Element** | **Requirement** |
| --- | --- |
| **Layout** | A centred, readable document canvas with generous whitespace and minimal persistent controls. |
| **Starting state** | Placeholder text such as 'Start speaking or writing...' and an immediately available microphone. |
| **Mode controls** | Just listen visibly selected; Interview me and Guide me with a prompt clearly available without dominating the canvas. |
| **Recording control** | A prominent start/stop microphone control positioned consistently on desktop and smaller screens. |
| **Status** | Quiet states for Listening, Processing transcript, Saving, Saved locally, and Saved. |
| **Editor** | Plain paragraphs, cursor editing, selection, copy/paste, and undo/redo; no visible formatting toolbar. |
| **Previous stories** | A quiet library entry point that does not cover or crowd the canvas. |

### 5.3 Capture state behaviour

| **State** | **User sees** | **Available action** |
| --- | --- | --- |
| **Empty** | No story record until the first character or recording begins. | Type, start voice, Interview me, or request a prompt. |
| **Recording** | Calm canvas; no live transcript or reactive audio visualisation. A minimal muted sine wave confirms that capture is active beside the Listening state and elapsed time. | Stop the spoken segment. |
| **Processing** | Recording is secure; transcript is being prepared. Editing controls remain stable. | Wait, type elsewhere if safe, or retry after an error. |
| **Editing** | Faithful transcript appears in the canvas and can be directly edited. | Type, record more, undo, or leave. |
| **Guest retained** | Device-only status and Keep this story action remain visible but non-blocking. | Email a sign-in link or keep working locally. |
| **Offline** | Local buffering and clear status prevent false confirmation of cloud save. | Continue where supported; sync when connection returns. |

### 5.4 Story library

Each library item includes only the information required to recognise and reopen the story:

- A simple, factual AI-generated title

- Original capture date and time

- A short verbatim excerpt

- Total voice-recording duration, when applicable

- An open-and-continue action

If AI cannot produce a confident factual title, the card falls back to the date and excerpt. Titles are editable, but no title is required from the user. The library is reverse chronological in the MVP and contains no visible categories, scores, summaries, or progress indicators.

### 5.5 Story visualisation

The visualisation uses the same owner-scoped summaries as the story library. It may vary scale, position and order for visual rhythm, but it must not infer meaning from proximity or turn capture dates into a life timeline. Each story remains identifiable through its factual title, verbatim excerpt, capture date, voice duration when present, and **Open story** action.

Motion is ambient and user-controlled rather than a video or autoplaying slideshow. It pauses on explicit request, while a story is in focus, and when the page is hidden. It does not play audio automatically. Decorative copies used for a continuous visual flow are hidden from assistive technology; every retained story has one semantic interactive representation.

## 6. AI and transcription behaviour

### 6.1 AI role in the MVP

AI supports capture without becoming the author. Its MVP roles are speech transcription, readable formatting, simple factual title generation, optional prompts, optional interview questions, and explicitly authorised reference to previous stories.

> **Prohibited default behaviour:** AI must not silently remove words, rewrite meaning, infer a preferred narrative, split stories, categorise content in the capture flow, or interrupt a person while they are speaking.

### 6.2 Faithful, readable transcript

| **Transformation** | **Default** | **Rule** |
| --- | --- | --- |
| **Add punctuation** | Yes | Use punctuation to make speech readable without changing wording. |
| **Add capitalisation** | Yes | Apply standard sentence and proper-noun capitalisation where confident. |
| **Add paragraph breaks** | Yes | Group natural topic or pause boundaries for readability. |
| **Remove filler words** | No | Preserve filler words unless the user explicitly requests editing. |
| **Remove repetition or false starts** | No | Preserve the spoken form. |
| **Rewrite grammar or vocabulary** | No | Do not make the speaker sound unlike themselves. |
| **Guess uncertain words** | No | Mark uncertainty and label the complete stored audio part **Review this part**. Do not invent word-level timing. |

### 6.3 Transcript and editing layers

| **Layer** | **Behaviour** |
| --- | --- |
| **Original audio** | Immutable unless the user deletes it; source of truth for what was spoken. |
| **Original transcript** | The first faithful, readable transcription; recoverable after edits. |
| **Current story** | The directly editable version shown in the canvas. |
| **Version history** | Automatic recoverable snapshots of meaningful edits; restoring creates a new current version rather than destroying later work. |

### 6.4 Guidance and previous-story context

- Just listen is the default and AI remains silent.

- Guide me with a prompt provides one optional prompt without changing modes permanently. It may use only the story currently open; if there is not enough meaningful context, it offers a general topic such as work, holidays, people, places, practical wisdom, or a clear memory.

- Interview me presents one question at a time and waits for the user's action.

- Stay with this story limits guidance to the current material.

- Explore past stories grants visible, session-level permission to use previous material.

- Any question drawing on past material cites the story title and provides a direct link to it.

- The user can turn previous-story access off or return to Just listen at any time.

### 6.5 AI title generation

After capture, AI may generate a short, descriptive title for the library card. Titles should identify the subject without dramatic interpretation, diagnosis, moral judgement, or unsupported detail. The title does not appear in the active capture canvas, and failure to generate one must never block saving.

## 7. Data, autosave, authentication, and trust

### 7.1 Autosave model

| **State** | **Persistence behaviour** | **User-facing status** |
| --- | --- | --- |
| **Guest** | Audio, typed text, transcripts, and edits persist locally in the current browser. | Temporarily saved on this device. |
| **Authentication transition** | The existing local story transfers to the authenticated account without refresh, duplication, or content loss. | Securing your story... |
| **Authenticated** | New audio segments, text, and edits save continuously to cloud storage, with local buffering during connection interruptions. | Saving... / Saved |
| **Failure** | The interface never displays Saved when the latest content is only buffered or has failed to persist. | Not yet synced / Retry |
| **Concurrent edit** | The incumbent cloud text and the competing local text are both preserved as recoverable versions. The application never auto-merges them or silently overwrites either candidate. | Conflict found / Review versions |

### 7.2 Guest-to-account conversion

- Guest capture starts without an authentication modal, identity form, or email field.

- Once content exists, a non-blocking Keep this story action becomes available.

- Selecting the action reveals an email field and Email me a sign-in link as the only first-version sign-in method.

- After a link is requested, the interface shows Check your email without claiming that the story is cloud-saved or blocking continued local editing.

- Sign-in must return the user to the same story and cursor context where practical.

- The application must explain that an unsigned story is stored only on the current device and is not yet available elsewhere.

- A navigation or close attempt may remind the guest to keep the story, but must not claim it will be lost if local recovery is available.

### 7.3 Privacy and trust requirements

- Stories are private by default and have no public URL or discovery surface in the MVP.

- The product clearly distinguishes device-only storage from authenticated cloud storage.

- Story content must not be used for generalised model training without the user's explicit, informed opt-in.

- Previous stories are not used for guided questions unless Explore past stories is visibly enabled.

- The system keeps a clear provenance chain from original audio to transcript and edited versions.

- Users can delete a story. Recovery window and permanent-deletion policy must be set before launch.

- Application logs and analytics must not include raw story content, transcript text, or audio payloads by default.

- Security architecture must protect private audio and text in transit and at rest; exact implementation is an engineering decision subject to review.

### 7.4 Conceptual data objects

| **Object** | **Purpose** |
| --- | --- |
| **User** | Authenticated owner of private stories and preferences. |
| **Guest draft** | Device-local, unsigned capture state awaiting retention or discard. |
| **Story** | The user-facing record created from one capture canvas; it may contain several memories or subjects. |
| **Audio segment** | One explicit start-to-stop recording within a story, including duration and transcript linkage. |
| **Original transcript** | First faithful, readable transcription for an audio segment or combined story view. |
| **Story version** | Recoverable snapshot of the directly edited story. |
| **Guidance session** | Temporary mode and permission state, including whether previous stories may be used. |

## 8. Functional and non-functional requirements

### 8.1 Capture and editing

| **ID** | **Requirement** | **Priority** |
| --- | --- | --- |
| **CAP-01** | Open to a fresh capture canvas for new and returning authenticated users. | Must |
| **CAP-02** | Allow immediate typing without creating an empty story before content exists. | Must |
| **CAP-03** | Request microphone permission only after the user selects voice capture. | Must |
| **CAP-04** | Record audio with explicit start and stop; silence must not end recording. | Must |
| **CAP-05** | Keep the recording screen calm: no live transcript, reactive audio visualisation, or distracting motion. Show only the approved minimal muted sine wave and elapsed time. | Must |
| **CAP-06** | Display the transcript only after the spoken segment stops and processing completes. | Must |
| **CAP-07** | Permit direct transcript editing, typing, undo/redo, and additional voice segments. | Must |
| **CAP-08** | Insert new speech at the end by default or at an intentionally placed cursor. | Should |
| **CAP-09** | Allow a story to contain multiple subjects without automatic splitting or warnings. | Must |

### 8.2 Transcription and AI

| **ID** | **Requirement** | **Priority** |
| --- | --- | --- |
| **AI-01** | Produce a faithful, readable transcript using punctuation, capitalisation, and paragraph breaks only. | Must |
| **AI-02** | Preserve filler words, repetitions, false starts, vocabulary, and meaning by default. | Must |
| **AI-03** | Mark uncertain transcription rather than silently guessing. | Must |
| **AI-04** | Retain playable original audio associated with transcript content. | Must |
| **AI-05** | Offer Just listen, Interview me, and Guide me with a prompt within the same canvas. | Must |
| **AI-06** | Use previous stories for guidance only after explicit Explore past stories selection. | Must |
| **AI-07** | Identify and link the prior story used to form a guided question. | Must |
| **AI-08** | Generate a simple factual library title without blocking save if generation fails. | Should |

### 8.3 Persistence, account, and library

| **ID** | **Requirement** | **Priority** |
| --- | --- | --- |
| **DAT-01** | Autosave guest content locally throughout capture and editing. | Must |
| **DAT-02** | Recover an unsigned draft after accidental tab or browser closure on the same device. | Must |
| **DAT-03** | Offer Keep this story without blocking ongoing capture. | Must |
| **DAT-04** | Support passwordless email sign-in and transfer the active guest story without loss or duplication. | Must |
| **DAT-05** | Continuously cloud-save authenticated content and buffer during network interruption. | Must |
| **DAT-06** | Preserve original audio, original transcript, current story, and version history. | Must |
| **DAT-07** | Preserve both candidates during a concurrent edit, show the conflict, and require a deliberate choice rather than auto-merging. | Must |
| **LIB-01** | List retained stories in reverse chronological order. | Must |
| **LIB-02** | Display title, date/time, verbatim excerpt, duration, and open action. | Must |
| **LIB-03** | Allow the user to open and continue an earlier story in the same canvas. | Must |
| **VIS-01** | Present retained stories in a shuffled, non-chronological arrangement without inferred categories, chronology, or relationships. | Must |
| **VIS-02** | Provide pause, resume, shuffle, story focus, return-to-capture, and safe open-story actions. | Must |
| **VIS-03** | Replace ambient motion with an equivalent static arrangement when reduced motion is requested. | Must |

### 8.4 Non-functional requirements

- **NFR-01 Reliability.** No acknowledged audio or text may be lost after the interface reports it as saved.

- **NFR-02 Responsiveness.** The capture flow must remain usable across current desktop and mobile browsers selected for MVP support.

- **NFR-03 Accessibility.** Core capture, stop, mode, editor, sign-in, library, visualisation, and recovery actions must be keyboard and screen-reader operable.

- **NFR-04 Visual stability.** Recording must not cause moving text, reactive audio visualisation, layout shift, or uncontrolled focus changes. The approved minimal sine wave is the only recording animation and becomes static under reduced motion.

- **NFR-05 Performance.** The blank canvas should become interactive quickly; exact budgets are set after architecture selection and baseline measurement.

- **NFR-06 Long-session safety.** Audio must be buffered or chunked so a network interruption or long recording does not create a single point of catastrophic loss.

- **NFR-07 Observability.** Operational events may be measured without capturing story text or audio in analytics logs.

- **NFR-08 International text.** The editor and storage model must safely preserve Unicode text even if initial transcription-language support is limited.

### 8.5 Accessibility and inclusive design

- Do not rely on colour alone to indicate recording, local-only, saving, saved, or error states.

- Provide visible focus states and descriptive accessible names for microphone, stop, playback, modes, and story actions.

- Offer a text path for every voice-driven interaction, including guidance questions.

- Ensure the static recording state still communicates that capture is active to screen-reader users.

- Respect reduced-motion preferences; the core recording state should already require no movement.

- Keep a persistent pause control beside any ambient visualisation that moves for longer than five seconds; focusing or selecting a moving story must pause its motion.

- Use readable line length, scalable text, sufficient contrast, and touch targets appropriate for smaller screens.

- Treat accents, hesitations, code-switching, and non-standard grammar as normal speech rather than errors to be corrected.

## 9. Success measures, risks, and release acceptance

### 9.1 Product success measures

Initial metrics should validate whether people can begin, trust, and retain a story. Numeric targets should be set after a baseline prototype study rather than guessed in this PRD.

| **Measure** | **Definition** | **Why it matters** |
| --- | --- | --- |
| **Time to first capture** | Time from canvas becoming interactive to first typed character or microphone start. | Lower indicates reduced friction. |
| **First-story retention** | Share of first-time visitors who create content and keep it through passwordless email sign-in. | Tests the try-before-account model. |
| **Capture reliability** | Share of acknowledged text and audio segments recovered intact after reload and network interruption. | Must approach zero data-loss incidents. |
| **Transcript correction rate** | Extent of user corrections attributable to transcription errors rather than intentional editing. | Signals transcription quality across real speech. |
| **Return capture** | Share of retained users who create or continue another story within an observation window. | Indicates ongoing value without nudges. |
| **Guidance usefulness** | Share of guided sessions in which a user answers, skips, or exits, supported by qualitative feedback. | Tests whether guidance feels helpful and controllable. |

### 9.2 Analytics guardrails

- Measure product events and technical outcomes, not the substance of stories.

- Do not send transcript text, AI prompts containing story content, or audio to general analytics platforms.

- Keep consent and privacy disclosures understandable before any optional research or content review.

- Qualitative prototype testing should use explicit participant consent and controlled test material where possible.

### 9.3 Key risks and mitigations

| **Risk** | **Potential impact** | **MVP mitigation** |
| --- | --- | --- |
| **Trust failure** | People may withhold meaningful stories if storage or AI use is unclear. | Plain-language device/cloud status, private defaults, visible permissions, and content-free analytics. |
| **Audio loss** | Browser, network, or long-session failure could destroy irreplaceable material. | Local buffering, chunked persistence, recovery testing, and truthful save states. |
| **Transcription bias** | Accents, multilingual speech, names, and code-switching may be transcribed poorly. | Uncertainty marking, audio-linked correction, inclusive testing, and declared language support. |
| **AI intrusion** | Guidance may feel invasive or shape the story. | Just listen default, one question at a time, no interruption, and explicit cross-story permission. |
| **Guest conversion loss** | Authentication could refresh the page or duplicate the story. | Treat guest-to-account migration as a release-critical end-to-end flow. |
| **Scope expansion** | Organisation, media, sharing, and reminders could obscure capture quality. | Maintain the stated MVP boundary until capture acceptance criteria pass. |
| **Emotional sensitivity** | People may record distressing or traumatic experiences. | Use calm, non-judgemental language; do not position AI as therapy or make clinical interpretations. |

### 9.4 MVP release acceptance

- A first-time visitor can type or start recording without creating an account.

- The recording screen remains calm, shows only the minimal muted sine wave and elapsed time, and shows no transcript until the user explicitly stops the segment.

- A long silence does not end or split a recording.

- The returned transcript adds punctuation and paragraphs without removing or rewriting words.

- The user can directly edit the transcript and later recover the original transcript and audio.

- Guest content survives an accidental reload or browser restart on the same supported device.

- Keep this story completes passwordless email sign-in and preserves the active story without loss, duplication, or unexpected navigation.

- Authenticated autosave truthfully distinguishes Saving, Saved, and Not yet synced states.

- Interview me can be entered and exited without affecting the story; previous stories are unavailable unless explicitly enabled.

- Every cross-story question visibly names and links its source story.

- The story library shows a simple title, date, excerpt, duration, and reliable open-and-continue action.

- **Visualise my stories** remains private, non-chronological and fully usable with motion paused or reduced, without implying connections between neighbouring stories.

- Core flows pass keyboard, screen-reader, mobile-width, network-interruption, and microphone-denial tests.

- Operational analytics contain no raw story text or audio.

### 9.5 Prototype test priorities

| **Test** | **Research question** |
| --- | --- |
| **Start without instruction** | Can a person understand how to speak or write immediately? |
| **Recording calmness** | Does hiding live transcription while showing only restrained capture activity help the person focus and feel heard? |
| **Explicit stop** | Is it clear how to finish one spoken segment without implying the story is complete? |
| **Guest retention** | Does Keep this story appear at the right moment without interrupting expression? |
| **Faithful transcript** | Does the transcript feel like the person's voice rather than an AI rewrite? |
| **Guidance control** | Do Stay with this story and Explore past stories feel understandable and non-intrusive? |
| **Return behaviour** | Does a fresh canvas feel inviting while previous stories remain easy to reach? |

## 10. Deferred work and open decisions

### 10.1 Deferred product layers

| **Layer** | **Examples** |
| --- | --- |
| **Organisation** | AI-generated themes, people, places, time periods, relationships, story connections, search, and evolving collections. The approved shuffled visualisation is presentation-only and does not implement these layers. |
| **Long-form outputs** | Generated autobiography, chapters, timelines, wisdom collections, printed or exported formats. |
| **Sharing** | Private invitations, selective sharing, anonymous or public publishing, discovery, and consent controls. |
| **Media** | Photographs, documents, letters, video, and other memory anchors. |
| **Engagement** | Optional reminders, prompts, anniversaries, and nudges without streaks or pressure. |
| **Authentication** | Google OAuth, Apple sign-in, mobile-number sign-in, passkeys, and account-recovery expansion. |
| **Platforms** | Native mobile applications, offline-first installation, and device integrations. |

### 10.2 Decisions required before production launch

The first implementation uses React and TypeScript with Vite, IndexedDB,
Supabase, and one Cloudflare Worker with Static Assets. It supports current
Chrome, Safari, and Edge on desktop, Chrome on Android, and Safari on iOS;
English transcription; 30-minute user-created spoken segments; and 30-day guest
retention on the current device. OpenAI `gpt-4o-mini-transcribe` receives
ordered internal chunks of no more than four minutes or 20 MB while the product
retains one logical spoken segment. Anonymous transcription is limited to three
segments per hour and ten per day per browser and twenty per hour per IP, with
a ten-minute processing timeout. The Worker stops new provider calls at US$49
of conservatively reserved monthly spend, leaving a US$1 safety margin beneath
the approved hard US$50 monthly ceiling.
Authenticated audio is capped at 750,000,000 bytes per account for the Supabase
Free project. Concurrent edits preserve both versions, show a conflict, and are
never auto-merged. Transcription uncertainty is linked to the complete stored
audio part and shown as **Review this part**, never as invented word timing.

The remaining launch decisions are:

- Final product name and brand identity

- Shared-device privacy behaviour after the first single-person slice

- Production regions, processing geography, backup policy, and regional data handling

- Encryption, key management, deletion recovery window, backup, export, and account-recovery policies

- Definition and frequency of automatic version-history snapshots

- Privacy notice, terms, consent language, age policy, and jurisdiction-specific compliance review

- Operational limits for later AI guidance and any scale beyond the hackathon allowance

- Quantitative success targets after prototype baseline testing

### 10.3 Recommended next steps

1. **Prototype the capture canvas.** Create low-fidelity desktop and mobile-width web flows for empty, recording, processing, editing, guest-retained, and offline states.

2. **Test the core interaction.** Run moderated sessions focused on starting, calm recording feedback, transcript review, and guest-to-account retention through email magic links.

3. **Select architecture.** Evaluate browser recording reliability, local persistence, secure cloud storage, transcription quality, and authentication continuity.

4. **Build the thin vertical slice.** Implement guest capture through authenticated recovery before adding guidance or library refinement.

5. **Add optional AI.** Layer Interview me, one-off prompts, titles, and explicit past-story context only after capture reliability is proven.

> **MVP guardrail:** The first release succeeds when a person can trust the application to get out of the way and preserve what they meant to say. Organisation and expansion should follow only after that experience is dependable.
