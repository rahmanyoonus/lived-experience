# ADR 0009: Same-tab email OTP authentication

- **Status:** Accepted
- **Date:** 22 July 2026
- **Decision owners:** Product owner and implementation team
- **Supersedes:** The magic-link flow selected in ADR 0005

## Context

The active guest story, original artefacts, and authentication return context
belong to the browser where capture began. An email application can open a
magic link in another browser, profile, or device. That authenticated context
cannot access the initiating browser's device-only IndexedDB story, so it
cannot reliably complete the intended guest-to-cloud migration.

Supabase email OTP uses the same passwordless request boundary as magic links,
but sends `{{ .Token }}` in the email template. The person can copy the code
into the tab where their story is already open and verify it with their email
address, avoiding callback navigation and email-link prefetching.

## Decision

Use Supabase passwordless email OTP as the only visible sign-in method in the
hackathon first version. Defer Google OAuth and do not add passwords, password
reset, or other account methods.

Keep Resend custom SMTP with the verified `email.atomik.bn` domain and sender
`no-reply@email.atomik.bn`. Keep the credential only in provider dashboards;
never store it in the repository or browser application.

Ask for an email address only after the person selects **Keep this story**.
Call `signInWithOtp` with automatic user creation and no redirect. Keep the
verification form in the initiating tab and call `verifyOtp` with the email,
six-digit token, and type `email`.

Keep the email address and entered code only in component memory. While an OTP
is pending, store only the client story identifier, cursor range, and one-hour
expiry in browser local storage. Do not store the email address, OTP, story
text, transcript, or audio in return metadata.

Keep the story labelled **Saved locally** after a code is sent. Show **Saved**
only after OTP verification and the authenticated cloud migration are both
acknowledged. If delivery, verification, or migration fails, retain the device
copy and allow a safe retry.

## Consequences

- Verification stays with the browser and IndexedDB story where capture began.
- The flow no longer needs an `/auth/confirm` route, token hash, or redirect
  allowlist.
- Email scanners cannot consume the sign-in credential by following a link.
- Entering the code adds one explicit step, so the form supports paste, resend,
  changing the email address, invalid or expired codes, and keyboard use.
- A code entered elsewhere may authenticate that browser, but it cannot delete
  or falsely acknowledge the initiating device-only draft.

The OTP-capable application and hosted `{{ .Token }}` template were deployed on
22 July 2026. Automated checks and live content-free probes passed. A fresh
inbox code has not yet completed the full live verification sequence below.

## Verification

Before calling hosted email OTP live-verified, verify with synthetic story
content:

1. request a code only after the local save is acknowledged;
2. paste the code into the initiating story tab;
3. retain the exact story and cursor context without navigation;
4. confirm one idempotent private cloud migration;
5. reload and open the story from the private library; and
6. confirm invalid, expired, replayed, resent, and other-device codes never
   remove or falsely cloud-save the local draft.

## References

- [Supabase passwordless email](https://supabase.com/docs/guides/auth/auth-email-passwordless)
- [Supabase email templates](https://supabase.com/docs/guides/auth/auth-email-templates)
- [Supabase custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp)
- [Resend with Supabase SMTP](https://resend.com/docs/send-with-supabase-smtp)
