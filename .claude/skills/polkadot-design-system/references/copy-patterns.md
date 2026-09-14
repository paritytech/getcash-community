---
quadrant: reference
uid: 526ebb5f # NO LEETSPEAK
---

# Copy Patterns & Detection

Reference file for `polkadot-design-system` copy guidelines. Always flag and propose — never auto-rewrite.

---

## Detection Heuristics

Scan all user-facing strings for these patterns:

### Technical Language

Flag any of these in user-facing text:

- `null`, `undefined`, `NaN`, `nil`
- `exception`, `error code`, `stack trace`
- `token`, `session`, `authentication`, `authorization`
- `API`, `endpoint`, `request`, `response` (in error messages)
- HTTP status codes: `400`, `401`, `403`, `404`, `500`, `503`
- `timeout`, `connection refused`, `ECONNRESET`
- `parse`, `serialize`, `deserialize`
- `callback`, `promise`, `async`
- `field`, `parameter`, `argument`, `payload`
- `instance`, `object`, `entity`
- Database terms: `query`, `record`, `row`, `constraint`, `foreign key`

### Raw Identifiers

The same failure as technical language, one level down: not jargon _words_ but machine
_values_ rendered as if a person could read them.

Flag any of these appearing as content — a label, a title, a subtitle, a list row, a toast:

- Blockchain addresses (`15oF4uVJ…`, `0x71C7…`), public keys, seed-derived ids
- Transaction hashes, block hashes, block numbers, nonces
- UUIDs and GUIDs (`8f14e45f-ceea-...`)
- Internal database keys and slugs (`user_10023`, `itm_9f2b`)
- File paths, S3 keys, bucket names
- Correlation, trace, request and session ids
- Anything the interface prints only because it had nothing better

Truncation is not a fix. `15oF4u…MNHr6Sp5` removes the part that distinguished the value and
keeps the part nobody can read. It looks tidier and carries no more meaning.

**The escape hatch, and its limits.** The raw value may appear where the person explicitly
asked for it: a copy control, an expanded details row, an advanced or developer view they
opened on purpose. Rendered there, it uses `font-mono`. It is never the default, never the
primary label, and never a quiet subtitle under the real name.

**When no name exists**, that is the defect to report. The fix is a name — chosen by the
user, assigned by the system, or descriptive of the thing ("the sword you won on Tuesday") —
not a better-formatted identifier.

### Vague Phrasing

Flag phrases that hide what actually happened:

- "Something went wrong"
- "An error occurred"
- "An unexpected error"
- "Please try again later"
- "Operation failed"
- "Request failed"
- "Unable to process"
- "Action could not be completed"
- "There was a problem"
- "Oops!" / "Whoops!"
- "We're sorry"
- "Contact support" (without saying why)

### Passive Voice

Flag passive constructions that obscure responsibility or action:

- "Your request has been submitted" → Who submitted it? What happens next?
- "The form could not be processed" → Why? What should they fix?
- "An error was encountered" → What error? What caused it?
- "You have been logged out" → Why? Session expired? They clicked logout?

### Corporate Filler

Flag unnecessary politeness and filler:

- "We apologize for the inconvenience"
- "Please be advised that"
- "We would like to inform you that"
- "Kindly note that"
- "At this time"
- "Going forward"
- "Please do not hesitate to"
- "We appreciate your patience"
- "Thank you for your understanding"

### Hype & Manipulation Language

Flag language that sells instead of serves. The interface is a tool built _for_ its users, not a platform extracting from them:

- Hype words: "revolutionary", "game-changing", "next-generation", "cutting-edge", "supercharge", "unlock", "unleash"
- Artificial urgency: "Limited time", "Act now", "Don't miss out", "Only X left" (when not reflecting real inventory), countdown timers without real deadlines
- Engagement tricks: "You won't believe", "See what you're missing", "Your friends are already..."
- Buzzword soup: "Web3", "blockchain", "decentralized", "on-chain" used as marketing rather than technical description — if it doesn't help the user understand what's happening, cut it
- Dark patterns: Pre-checked opt-ins, confusing unsubscribe flows, "Are you sure you want to miss out?" guilt copy, hiding costs behind "starting at" or "from"

### Dishonest State

Flag copy that misleads about what's actually happening:

- Fake progress indicators that don't reflect real progress
- "Almost done!" when the system can't know that
- Optimistic confirmations before an action completes ("Saved!" before the server responds)
- Vague loading states that hide failures ("Still working on it..." when something has errored)
- Masking errors as delays ("This is taking longer than expected" when the request failed)

---

## Principles

Good copy is:

1. **Factual** — States exactly what happened. Not "something went wrong" but "we couldn't save your changes because the file is too large."
2. **Honest** — Never misleads about state. If something is loading, say it's loading. If it failed, say it failed. No optimistic UI that lies, no fake progress bars, no artificial urgency. The interface tells the truth about what's happening, even when the truth is "we don't know yet."
3. **Transparent** — Doesn't hide behind vague language. If there's a limit, say the limit. If there's a reason, say the reason. Surface costs, fees, and terms plainly — no hidden charges, no fine print that contradicts the headline.
4. **Common sense** — Uses words real people use. "Sign in" not "authenticate." "Password" not "credentials." No hype words, no buzzword soup. If a word exists to impress rather than inform, cut it.
5. **Actionable** — Tells the user what to do next. Every error message should have a next step.
6. **Concise** — Says it in as few words as possible. Cut filler words. Cut redundant phrases. Clarity and trust over decoration.
7. **Warm** — Treats the user as a person who owns their decisions. The tone is that of a tool built _for_ its users, not a platform extracting from them. Direct but not cold. Helpful but not patronizing. Never guilt, never pressure, never manipulate.
8. **Human-addressed** — Names things the way the user knows them. "Alice's wallet", not `15oF4u…MNHr6Sp5`. Machine identifiers are how the system finds a thing, never how the interface refers to it. If the only available label is an id, the missing name is the bug.

---

## Example Rewrites

### Error Messages

| #   | Bad                                | Good                                                                   |
| --- | ---------------------------------- | ---------------------------------------------------------------------- |
| 1   | "Something went wrong"             | "We couldn't load your projects. Check your connection and try again." |
| 2   | "An error occurred"                | "That file couldn't be uploaded — it's larger than 10 MB."             |
| 3   | "Error 404"                        | "This page doesn't exist. It may have been moved or deleted."          |
| 4   | "Error 500: Internal Server Error" | "Something broke on our end. We're looking into it."                   |
| 5   | "Error 401: Unauthorized"          | "You need to sign in to see this."                                     |
| 6   | "Error 403: Forbidden"             | "You don't have access to this. Ask the project owner to invite you."  |
| 7   | "Request timed out"                | "This is taking too long. Check your connection or try again."         |
| 8   | "Authentication token expired"     | "Your session expired. Sign in again to continue."                     |
| 9   | "Invalid credentials"              | "That password is incorrect. Try again or reset it."                   |
| 10  | "Validation failed"                | "Some fields need fixing. Check the highlighted areas below."          |

### Form Messages

| #   | Bad                                                                                                                              | Good                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 11  | "This field is required"                                                                                                         | "Enter your email to continue."                                  |
| 12  | "Invalid email format"                                                                                                           | "That doesn't look like an email address. Check for typos."      |
| 13  | "Password must contain at least 8 characters, one uppercase letter, one lowercase letter, one number, and one special character" | "Use 8+ characters with a mix of letters, numbers, and symbols." |
| 14  | "Input exceeds maximum length"                                                                                                   | "Keep it under 200 characters."                                  |
| 15  | "Duplicate entry detected"                                                                                                       | "That name is already taken. Try a different one."               |
| 16  | "Invalid date format"                                                                                                            | "Enter a date like March 8, 2026."                               |
| 17  | "Form submission failed"                                                                                                         | "We couldn't save this. Check your entries and try again."       |
| 18  | "Please enter a valid phone number"                                                                                              | "Enter your phone number, like (555) 123-4567."                  |

### Status Messages

| #   | Bad                                                      | Good                                                      |
| --- | -------------------------------------------------------- | --------------------------------------------------------- |
| 19  | "Operation completed successfully"                       | "Saved."                                                  |
| 20  | "Your request has been submitted and is being processed" | "We're on it. You'll get a notification when it's ready." |
| 21  | "Item has been deleted"                                  | "Deleted. Undo"                                           |
| 22  | "Changes saved successfully"                             | "Changes saved."                                          |
| 23  | "Action could not be completed at this time"             | "That didn't work. Try again in a few minutes."           |
| 24  | "Processing your request..."                             | "Saving..."                                               |
| 25  | "Please wait while we load your data"                    | "Loading..."                                              |
| 26  | "No results found for your query"                        | "No results for 'search term'. Try different keywords."   |

### Empty States

| #   | Bad                   | Good                                                       |
| --- | --------------------- | ---------------------------------------------------------- |
| 27  | "No data available"   | "Nothing here yet. Create your first item to get started." |
| 28  | "No records found"    | "No matches. Try adjusting your filters."                  |
| 29  | "Your inbox is empty" | "All caught up. New messages will appear here."            |
| 30  | "No notifications"    | "No notifications right now."                              |

### Permissions & Access

| #   | Bad                                                 | Good                                                                                 |
| --- | --------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 31  | "You do not have permission to perform this action" | "You don't have access to do this. Ask an admin for help."                           |
| 32  | "Access denied"                                     | "You can't access this page. Sign in with a different account or ask for an invite." |
| 33  | "Insufficient privileges"                           | "Your role doesn't allow this. Contact your team admin."                             |
| 34  | "Account locked"                                    | "Your account is locked after too many attempts. Reset your password to unlock it."  |

### Destructive Actions

| #   | Bad                                                                        | Good                                                                                    |
| --- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 35  | "Are you sure you want to delete this? This action cannot be undone."      | (Don't ask. Delete it and show:) "Deleted. Undo"                                        |
| 36  | "Warning: This will permanently remove all data associated with this item" | (Delete and show:) "Item and its data removed. Undo (10s)"                              |
| 37  | "Confirm cancellation of subscription"                                     | (Cancel and show:) "Subscription cancelled. Your access continues until March 31. Undo" |

### Onboarding & Help

| #   | Bad                                                                          | Good                                    |
| --- | ---------------------------------------------------------------------------- | --------------------------------------- |
| 38  | "Welcome to our platform! We're excited to have you on board."               | "Welcome. Let's set up your workspace." |
| 39  | "Please complete the following steps to set up your account"                 | "Three quick steps to get started:"     |
| 40  | "For more information, please consult our documentation"                     | "Learn more in the docs."               |
| 41  | "If you need assistance, please do not hesitate to contact our support team" | "Need help? Chat with us."              |

### Hype & Manipulation

| #   | Bad                                                                           | Good                                                              |
| --- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 42  | "Unlock the power of decentralized ticketing!"                                | "Buy and manage event tickets."                                   |
| 43  | "Revolutionary blockchain-powered experience"                                 | "Your tickets are stored on-chain, so only you control them."     |
| 44  | "Don't miss out! Only 3 tickets left!" (when inventory isn't actually scarce) | "12 tickets remaining." (only when true)                          |
| 45  | "Act now — limited time offer!"                                               | "Available until March 31."                                       |
| 46  | "Join 10,000+ users who already trust us"                                     | (Remove. Let the product speak for itself.)                       |
| 47  | "Are you sure you want to leave? You'll lose your exclusive access!"          | (Let them leave. No guilt.)                                       |
| 48  | "Starting at just $9.99" (when most users pay more)                           | "$9.99/month for the basic plan. $24.99/month for the full plan." |

### Identifiers

| #   | Bad                                                         | Good                                                                  |
| --- | ----------------------------------------------------------- | --------------------------------------------------------------------- |
| 54  | "Sent to 15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5"  | "Sent to Alice"                                                       |
| 55  | "Sent to 15oF4u…NHr6Sp5"                                    | "Sent to Alice" (truncating hid the only distinguishing part)         |
| 56  | "Item itm_9f2b equipped"                                    | "Longsword of Dawn equipped"                                          |
| 57  | "Transaction 0x8f14e45fceea… confirmed"                     | "Payment confirmed" — the hash belongs behind a copy control          |
| 58  | Account row titled `5GrwvaEF…` with the nickname beneath it | Account row titled "Savings", with the address behind a copy control  |
| 59  | "Error in record 10023"                                     | "That order couldn't be updated. Try again."                          |
| 60  | "Block #24,881,203" as a page heading                       | "Confirmed 3 minutes ago" — the block number is a detail, not a title |

### Dishonest State

| #   | Bad                                                                      | Good                                                                                             |
| --- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| 49  | "Saved!" (before the server confirms)                                    | "Saving..." → "Saved." (only after confirmation)                                                 |
| 50  | "Almost done!" (on a progress bar at 90% that's been stuck for a minute) | "Still processing. This usually takes 1–2 minutes."                                              |
| 51  | "This is taking longer than expected" (when the request actually failed) | "That didn't go through. Try again."                                                             |
| 52  | Spinning loader with no text, shown indefinitely                         | "Loading your tickets..." → after 10s: "Still loading. If this persists, check your connection." |
| 53  | "Your transaction is being processed" (with no further updates)          | "Transaction submitted. You'll see it confirmed in about 30 seconds."                            |

---

## Workflow

When scanning UI code:

1. **Read** all user-facing strings (labels, error messages, button text, placeholder text, headings, descriptions, tooltips, toasts)
2. **Check** each string against the detection heuristics above
3. **If a problem is found**: stop and report it before continuing with other work
4. **Format the report** as:
   - The problematic text (quoted)
   - What's wrong with it (one line)
   - Proposed rewrite
   - Ask: "Want me to apply this change?"
5. **Wait for confirmation** before modifying any copy
6. **If multiple issues are found**, batch them into a single report for the developer to review
