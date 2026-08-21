# 06 · Exam-day runbook

Print this. Keep it beside you.

## The day before

- [ ] Open the Supabase dashboard, so the free project is awake
- [ ] Open `setup.html` and run the checks — everything green
- [ ] On one lab machine: sign in, press **Start secure exam**, confirm the paper
      opens inside SEB already signed in
- [ ] Confirm every student has an account (Students tab) and knows their password
- [ ] Make the paper: **Papers** tab → title, code, times, minutes → create
- [ ] **Questions** tab → draft with AI or write by hand → read every question
- [ ] Check the total marks shown beside "In this paper"
- [ ] Sit the paper yourself in a private window with `?dev=1`, if the bypass is
      still on — then switch it off again

## One hour before

- [ ] The paper shows **live now** in the Papers list, or will at the right minute
- [ ] Safe Exam Browser is installed on every machine (nothing else is needed —
      the configuration comes from the website)
- [ ] Exam code on the board as a fallback; students normally just see their paper listed
- [ ] Spare slips printed for anyone who forgot a password
- [ ] Console open on your machine, **The room** tab selected

## At the start

Read this out, it is the whole instruction:

> Open the browser, go to our exam site, sign in. Your paper is listed. Press
> **Start secure exam**, and when the browser asks, choose **Open Safe Exam
> Browser**. Do not type anything else.

The invigilator holds the quit password and does not share it.

Anyone who cannot sign in: **Students** tab → type the roll number → **Reset** →
read the new password to them. It takes fifteen seconds.

Nothing happens when they press start: Safe Exam Browser is not installed on that
machine. Move the student to a spare machine and install it on that one later.

*"It says the launch expired"*: they pressed start, then waited too long before
approving the prompt. Press start again — the link lasts two minutes on purpose.

## During

Watch **The room**. It gives you three things:

- **The numbers** — sitting, submitted, not started, incidents.
- **The roster**, sorted with the most-flagged student at the top. From here you can
  grant **+5 min** or **Unlock** a paper whose machine crashed.
- **The live feed** of incidents as they happen.

Treat a flag as a reason to walk over and look, not as a verdict. The system
reports; people decide. A student who leans out of frame to think looks identical to
one who is reading a note.

**A machine crashes.** The student signs in again on the portal and presses
**Resume in SEB** — the card says so once an attempt exists. Their answers are
already saved and the paper reopens where they left off. If the paper was already
submitted, press **Unlock** on the roster first.

**The paper goes dark mid-exam.** That is the camera cover, not a crash. The
student is out of frame, or someone is standing behind them. It clears by itself
when only they are in front of the camera; the clock never stopped and nothing was
lost.

**A student needs more time.** Press **+5 min** as many times as needed. The exam
page picks it up within thirty seconds without a reload.

**The whole lab loses power.** Nothing is lost — every answer was saved as it was
typed. Restart and continue; grant extra minutes to cover the outage.

## After

- [ ] **Results** tab → check the table filled in
- [ ] Mark the long answers in the lower panel — totals update as you type
- [ ] **Export CSV** and file it
- [ ] Review the incident tally against your own observations before acting on it
- [ ] Take a database backup (Database → Backups)

## The week after

- Set the paper to unpublished in the Papers tab, so the code stops working.
- Keep the questions: next term, create a new paper and rewrite them rather than
  starting from nothing.
