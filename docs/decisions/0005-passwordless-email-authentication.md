# ADR 0005: Passwordless email authentication

- **Status:** Accepted
- **Date:** 20 July 2026
- **Decision owners:** Product owner and implementation team
- **Supersedes:** The Google-only authentication choice in ADR 0001

## Context

The product owner selected passwordless email magic links for the OpenAI build
hackathon instead of Google OAuth. Guest capture must still begin without an
account or email field, and authentication must not lose, duplicate, or falsely
cloud-save the active device-only story.

Email applications commonly open links in a new tab. The earlier OAuth return
context used tab-scoped session storage, which cannot reliably reconnect that
tab to the existing IndexedDB story. Supabase's PKCE magic-link flow also
requires a token-hash email template and explicit verification at an
allowlisted callback route.

## Decision

Use Supabase passwordless email magic links as the only visible sign-in method
in the hackathon first version. Defer Google OAuth and do not add passwords,
password reset, or other account methods.

Use Resend custom SMTP with the verified `email.atomik.bn` domain and sender
`no-reply@email.atomik.bn`. Restrict the Resend credential to sending access and
that domain. Keep the credential only in the provider dashboards; never store
it in the repository or browser application.

Ask for an email address only after the person selects **Keep this story**.
Call `signInWithOtp` with automatic user creation and the exact
`/auth/confirm` callback. The callback verifies the one-time token hash before
cloud synchronisation begins.

Store only a random attempt identifier, client story identifier, cursor range,
and one-hour expiry in browser local storage. Do not put the email address,
story text, transcript, or audio in return metadata. Gate consumption to the
callback path so the original tab cannot consume another tab's context.

Keep the story labelled **Saved locally** after an email is sent. Show **Saved**
only after the authenticated cloud migration is acknowledged. If delivery,
verification, or migration fails, retain the original device copy and allow a
safe retry.

## Consequences

- A link opened in the same browser can reconnect to the shared IndexedDB draft
  even when the email application creates a new tab.
- A link opened on another device cannot access the device-only draft and must
  not delete or falsely acknowledge it.
- The canonical `https://livedexp.atomik.bn` Site URL, query-aware callback
  allowlist, Resend SMTP service, and token-hash email template are configured.
- A synthetic text story completed live Gmail delivery, same-browser callback,
  private cloud acknowledgement, reload, private-library retrieval, and reopen
  without duplication or sync error. Original-audio migration still needs a
  live browser-device verification.
- Email scanners can prefetch ordinary confirmation links. The app callback
  performs the one-time verification in browser code so a plain HTTP prefetch
  does not consume the token.

## Verification

Before calling hosted authentication live, verify with synthetic story content:

1. request a link after the local save is acknowledged;
2. open it in a new tab of the same browser;
3. return to the exact story and cursor context;
4. confirm one idempotent private cloud migration;
5. reload and open the story from the private library; and
6. confirm invalid, expired, replayed, and other-device links never remove or
   falsely cloud-save the local draft.

## References

- [Supabase passwordless email](https://supabase.com/docs/guides/auth/auth-email-passwordless)
- [Supabase redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls)
- [Supabase custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp)
- [Resend with Supabase SMTP](https://resend.com/docs/send-with-supabase-smtp)
