# 09 · The secure launch

What the student sees, and what actually happens underneath.

## What the student does

```
Normal browser (Chrome, Edge, Safari)
        │
        │  1. sign in at your site
        ▼
   Student portal  ──  their papers, one card each
        │
        │  2. press "Start secure exam"
        ▼
   Browser asks: "Open Safe Exam Browser?"  →  Open
        │
        ▼
   Safe Exam Browser starts, machine locks
        │
        │  3. signed in automatically — no password retyped
        ▼
   The chosen paper. Rules screen, then begin.
```

Three actions: sign in, press start, press Open. No file to find, no code to type,
no second password.

## What happens underneath

```
student.js                create-seb-launch          exam.js (inside SEB)
──────────                ─────────────────          ────────────────────
press Start
  │
  ├─ HEAD /seb/…seb ──► is the configuration published?
  │
  └─ POST exam_code ──►  is the caller a student?
                         is this paper published and open?
                         has it already been submitted?
                              │
                         mint 32 random bytes
                         store only the SHA-256 hash
                         two minutes, single use
                              │
     ◄──── launch_token ──────┘
  │
  └─ location.href = sebs://your-site/seb/…seb?launch=TOKEN
                              │
                    SEB downloads the configuration,
                    locks the machine, opens the Start URL
                    with ?launch=TOKEN appended
                              │
                              ▼
                                          exchange-seb-launch
                                          ───────────────────
                                          claim the hash atomically:
                                            unused AND unexpired
                                          → mark used, return a
                                            magic-link token
                              ◄───────────
                                          verifyOtp() → session
                                          token wiped from the URL
                                          paper opens
```

## Why each piece is shaped that way

**The token is random, not the exam code.** Anything a student can guess or
retype is not a credential. Thirty-two random bytes cannot be guessed.

**Only the hash is stored.** A leaked database backup contains no usable launch
links, the same reason passwords are hashed.

**Two minutes.** Long enough to approve the prompt and for SEB to start. Short
enough that a token copied out of a URL is worthless before it can be passed
along.

**Single use, claimed atomically.** The exchange is one `update … where used_at is
null` — the database decides the winner. If a student forwards the link the
instant it appears, exactly one of them gets a session, and the other sees an
expired-launch screen.

**A magic-link token, not a password.** SEB is a separate browser with its own
empty storage, so the student would otherwise have to type their password again
inside the locked machine, standing at a desk with people behind them. The
exchange hands SEB a one-time sign-in instead, and the token is removed from the
address bar as soon as it is spent.

## Why the launch link alone is not the security

A student could copy the `.seb` file, or write their own, and point it at your
exam page. Then they would be in a browser they control, with a paper open.

So the exam page does not ask "are you SEB?" — a question anything can answer
yes to. It asks SEB for the **Config Key** of the current URL, which is a hash
derived from the configuration file that opened the page, and sends it to
`verify-seb`. The server holds the real key as a secret and compares. A copied,
edited or home-made configuration produces a different key and the paper does
not open.

```
SEB  ──► configKey for this exact URL ──►  verify-seb
                                            sha256(url + SEB_CONFIG_KEY)
                                            constant-time compare
                                       ◄──  ok, or blocked
```

That is why two things in guide 05 are not optional: **Enable JavaScript API**
(so SEB will tell the page its key) and setting `SEB_CONFIG_KEY` on the server.
Until the secret is set, the exam page blocks everyone and says so plainly —
which is the correct failure direction, and the setup page flags it long before
exam day.

## What still is not protected

The launch is about **how a paper opens**, not **who is sitting there**. Nothing
here proves the person at the keyboard is the person who signed in. That is what
the invigilator, the roll list and the camera are for.

It also cannot help if a student signs in on their own laptop at home when the
exam was meant to be in a lab. If that matters for your exam, invigilate it in a
lab — the software cannot tell you which room a machine is in.

## The five-second cover

Separate from the launch, and worth knowing about: when the camera cannot see a
face, or sees more than one, the paper is covered after five seconds with a
plain explanation. The clock keeps running and the answers stay saved — it is a
cover, not a pause, and the student is told exactly that.

Turn it off with `LOCK_ON_FACE_LOSS = false` in `config.js` if your lab has poor
lighting and it triggers on honest students. The incident is still logged either
way; only the cover goes away.
