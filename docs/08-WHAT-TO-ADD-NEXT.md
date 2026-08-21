# 08 · What to add next

Everything below was deliberately left out of the build. Each entry says what it is
worth, and roughly what it costs, so you can decide after your first real exam
rather than before it.

## Worth doing soon

**A question bank across papers.** Right now questions belong to one paper. A bank —
tagged by unit and difficulty, with "pull 10 random from Unit 3" — turns one term's
work into next term's paper. Add a `question_bank` table and a copy-into-paper step.
*Half a day.*

**Per-question analytics.** The query is already in guide 02: average marks per
question. Put it on the Results tab as a small chart and a bad question announces
itself — everyone got it wrong, or everyone got it right.
*An hour.*

**A printable question paper.** A print stylesheet on a faculty-only view of the
paper, for the department file and for the external examiner. Accreditation asks for
this eventually.
*An hour or two.*

**Attendance sheet export.** Roll, name, started at, submitted at, incident count,
in one CSV. You already have every field.
*An hour.*

**Section-wise papers.** Section A compulsory, choose 2 of 4 from Section B. Needs a
`section` column and a rule about how many count. Common in university papers.
*Half a day.*

## Worth doing before you scale past one lab

**Self-hosted Piston.** The public API is fine for a lab of sixty submitting at
different moments. Two labs at once, or a whole year submitting in the last five
minutes, will hit the rate limit. Docker on a free Oracle Cloud VM, then one secret
change. Guide 03 has the line.
*Two hours, mostly waiting for Docker.*

**A second faculty account per department.** The rules already support it — promote
another profile. What is missing is co-ownership of a paper: today only the creator
sees it. A `co_faculty` array on `exams` and a widened policy fixes that.
*Two hours.*

**Roll-number sign-in.** Students currently sign in with the generated email. Some
students will type the roll number instead and get stuck. A tiny lookup on the sign-
in page — roll number in, email out — removes the confusion at the door.
*An hour.*

## Worth considering, with reservations

**Storing proctoring snapshots.** Technically easy: capture a frame on each
incident, upload to Supabase Storage. But it converts a system that stores no
images into one that stores images of students, which brings consent, retention and
access questions your institution should answer before the code does. If you go
ahead: tell students in the instructions text, keep frames only for flagged
incidents, and delete them on a schedule.

**Automatic disqualification on N flags.** Do not. The flags are noisy for innocent
reasons — a dim room, a cap, a student who thinks with their head down. Automating
a penalty on a noisy signal produces wrong accusations, and the person who has to
defend that decision is you, not the software. Keep the human step.

**Plagiarism comparison across coding answers.** Comparing submitted code between
students is genuinely useful and not hard — token-level similarity over the
`code_submitted` column, run after the exam. Worth doing. Present it as "these two
are worth reading side by side", never as a verdict.

**Question-level timing.** Recording how long each question took is easy and makes
good analytics. It is also a step further into surveillance for a marginal gain.
Decide deliberately.

## Not worth it

**Full video recording of every candidate.** Enormous storage, real privacy exposure,
and nobody ever watches sixty hours of footage. The event log gives you the moments
worth looking at, which is what you would have skipped to anyway.

**Browser-only lockdown without SEB.** Every few months someone suggests dropping
Safe Exam Browser and relying on JavaScript. It cannot work: a page cannot block a
screenshot, and pretending otherwise is worse than admitting the limit.

**Your own execution sandbox.** Running untrusted student code safely is a genuinely
hard security problem. Piston has solved it. Use Piston.
