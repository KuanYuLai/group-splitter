# Technical tradeoffs

## 1. Cross-device updates: polling instead of push

We use polling because we expect expenses to be added infrequently and can accept a short delay before they appear on other devices. Polling reuses our HTTP endpoints and avoids managing persistent connections. SSE could deliver updates sooner and reduce unnecessary requests, but would add connection management. Polling is simpler for this prototype, though it still sends requests when nothing changes.

## 2. Authentication: server-side sessions instead of JWTs

Server-side sessions make logout and revocation straightforward: deleting a session invalidates its token. They also provide a foundation for managing active sessions across devices, although that user-facing feature is not implemented. JWTs can support multiple devices too, but immediate revocation of self-contained tokens requires additional state or checks. We accept a database lookup on each authenticated request for simpler session control.

## 3. Login experience: one entry point for sign-in and registration

Sign-in and registration share one screen. Existing users enter their email to sign in; new users are prompted to choose a nickname and confirm registration. This simplifies onboarding, but the different responses reveal whether an email is registered. Real use requires verified authentication, which could use passwords or passwordless email links.

## 4. Storing expense splits in a shares table

Although we currently split expenses equally, we store each participant's allocated amount in the shares table and use those amounts to calculate balances. This preserves the saved allocation and provides a data model for future unequal splits. The tradeoff is additional rows and queries, plus keeping shares consistent when editing expenses.
