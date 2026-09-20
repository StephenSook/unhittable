# False greens

Every entry below is a moment where this project reported success and was wrong,
or was about to. They are collected because the failure mode that matters in a
measurement tool is not an error message. It is a plausible number.

Each one records what the wrong output looked like, why it looked right, and what
now prevents it from coming back.

---

## 1. Millimetres to pixels, off by 8.3x

**What it said.** An analysis of the cohort reported that the median measured
tremor was "a 2.5 CSS pixel excursion", which would have made the entire project
pointless: a 2.5 px wobble against a 24 px target is nothing.

**Why it looked right.** The conversion used was 1 CSS px = 0.2646 mm, which is
correct. It is the size of a pixel on a 96 dpi screen. That is the right number
for a **finger touching glass** and the wrong number for a **hand on a mouse**.
A mouse at 800 cpi moves the cursor `800 / 25.4 = 31.5` pixels per millimetre of
hand movement, not 3.78. The same millimetre means two different distances
depending on what is moving, and both conversions are defensible in isolation.

**Corrected.** The median is 48.3 px of cursor travel, twice the whole target.

**Prevented by.** `cpiToCssPxPerMm` is the only conversion in the codebase and it
takes cpi, so there is no code path that can reach a pixel figure through a
screen density. Its test asserts agreement with the device-space conversion at
scale 1 and divergence under display scaling.

---

## 2. One recording presented as typical

**What it said.** The first version of this project was built on subject 006 and
described it as "a Parkinson's tremor". Every number was correct.

**Why it looked right.** It *is* a Parkinson's tremor, clinically labelled,
correctly measured. Nothing about the recording was wrong.

**What was wrong.** Measuring all 1,560 postural recordings from 260 subjects
showed that subject 006 is the **second cleanest in the set**, and that only
**3.3%** of recordings contain a detectable tremor at all. The claim was true of
that person and misleading about everyone else.

**Prevented by.** `scripts/cohort.mjs` publishes the distribution, including the
parts that weaken the claim, and the shipped recording set deliberately includes
a healthy control and a patient wrist that both hold a 24 px target 100% of the
time.

---

## 3. A robots.txt matcher that excluded 18 of 40 sites, politely

**What it said.** `[09/40] GOV.UK: SKIPPED, Disallow: /*/print$`

**Why it looked right.** It reads like a considered decision. The tool named a
rule, cited it, and declined. Eighteen such lines scrolled past without
suspicion.

**What was wrong.** The matcher truncated each pattern at its first wildcard, so
`/*/print$` became `/`, which matches everything. None of the eighteen sites
disallowed their homepage. A guard that is too strict fails **silently and
looks responsible**, which is worse than one that is too loose.

**Prevented by.** `packages/core/src/robots.js` implements RFC 9309 matching, and
its test suite is built from the fourteen real patterns that were misread, each
asserted in both directions: it must not block the homepage, and it must still
block what it was written for.

---

## 4. A 403 on robots.txt read as a prohibition

**What it said.** Three government and hospital sites skipped with
`robots.txt returned 403`.

**What was wrong.** RFC 9309 section 2.3.1 says a 4xx other than 429 means there
are no applicable rules, so fetching is permitted. A 403 on robots.txt is
usually a WAF, not a policy.

**Prevented by.** `statusMeaning()`, with the status classes pinned by test.

---

## 5. A server that never listened and printed nothing

**What it said.** Nothing at all. An empty log file and a connection refused.

**Why it looked right.** The process started, exited zero, and wrote no error.

**What was wrong.** The entry-point guard was
`import.meta.url === \`file://${process.argv[1]}\``. The repository path contains
a space, `import.meta.url` percent-encodes it, and the comparison was false, so
the module loaded and did nothing. A silent no-op is the hardest startup failure
to read, because there is no message to search for.

**Prevented by.** `pathToFileURL(process.argv[1]).href`, with the reason in a
comment at the comparison.

---

## 6. Two renderers of the same quantity disagreeing on screen

**What it said.** The cursor sat in the bottom-right corner of the instrument
while the trail it was supposed to be leading was centred.

**Why it was caught.** Only because there were two of them. The cursor element
is centred by `left:50%; top:50%` and the animation added half the stage width
again; the trail canvas is `inset:0` and draws in absolute coordinates, so it was
right. **One renderer would have been believed.**

**Prevented by.** A browser assertion that pins the cursor to the measurement
area rather than a corner.

---

## 7. A ratio that was 1 by construction

**What it said.** Every page scanned at a mobile viewport reported
`layoutScale: 1`, meaning nothing was being shrunk.

**What was wrong.** The scale was computed inside the page as
`window.innerWidth / document.documentElement.clientWidth`. In the page those
are the same number. The ratio could never be anything but 1, and a page with no
viewport meta tag laying out at 980 px on a 390 px screen looked perfectly fine.

**Prevented by.** The scale is computed by the caller, against the width it
actually asked the browser for, and a test asserts a real shrink on a fixture
with no viewport meta tag and none on a fixture that has one.

---

## 8. A generator that only worked on the machine that wrote it

**What it said.** Nothing, locally. CI failed on its first run of the staleness
gate.

**What was wrong.** `scripts/manifest.mjs` read condition labels from the scratch
directory the dataset had been downloaded into. On any machine without it, every
label regenerated as `null`. The committed manifest and the code that produces it
had silently stopped agreeing, and only a machine **without** the developer's
scratch state could notice.

**Prevented by.** The labels are committed, and CI regenerates the manifest and
fails on any diff.

---

## 9. This page failing its own standard

**What it said.** The footer, measuring its own controls on first load:
*"The smallest is 36 px on its short side, which is under the 44 px we hold
ourselves to."*

**Why it matters.** The filter chips were 36 px. On a page whose entire argument
is that people publish accessibility numbers without checking them, that is the
exact failure being described.

**Prevented by.** It was not prevented, it was **detected**, which is the point.
The measurement runs on every page load in the visitor's own browser and would
say so again.

---

## 10. A bot challenge wearing an HTTP 200

**Designed for, and it fired.** Enterprise WAFs commonly answer an automated
client with a challenge or block page carrying a 200. A scanner that trusts the
status code files "this hospital homepage has four interactive controls" as a
measurement.

`looksLikeChallenge()` checks content, not status: known challenge titles, any
4xx, and an implausibly low control count for a homepage. During the corpus run
it excluded exactly one site, which was serving "Access Denied" under a 200, and
recorded the reason rather than dropping it.

---

## 11. A confidence metric that was confident about a blank wall

Inherited from the signal-processing work this project's core came from, and the
reason `prominentPeak` exists in the shape it does.

An early peak-detection metric compared a spectral peak against the **global
median** of the spectrum. Pointed at a blank wall it reported a confidence of
**394.7**, because it was comparing low-frequency scene content against a
high-frequency noise floor: two unrelated quantities whose ratio is large and
means nothing.

The fix was a **local** running-median baseline and prominence measured against
it, so a peak is compared to its own neighbourhood. A companion failure, a single
localised bump scoring 0.970 coherence, is why `fitSinusoid` projects onto an
exact least-squares sinusoid and reports what fraction of the signal the fit
explains: a real oscillation scores 1.000, a bump scores 0.311.

---

## 12. A window that inflated every hold rate, invisibly

**What it said.** A true 2.000 mm tremor amplitude, recovered correctly. Peak
to peak came back as 3.981 mm against a true 4.000 mm, an error under half a
percent, and the headline amplitude on every page was right.

**What was wrong.** A Hann window was applied before integration and never
removed, so the recovered displacement carried the window's envelope. Measured
along the record, a flat 2.000 mm amplitude read **0.778 mm** one fifth of the
way in, 1.991 mm at the centre, and 0.796 mm four fifths in.

**Why it survived.** Peak-to-peak cannot see it. The peak lands near the middle
where the window gain is 1, so the number everybody looks at was correct. What
it corrupted was the **hold fraction**, which integrates over the whole
retained record: most of the evaluated trace had been pulled toward the centre
of the target, so every published hold rate was more generous than the truth.

**The lesson that generalises.** A taper is right for estimating a spectrum and
wrong for reconstructing an amplitude, and the two paths had been sharing one
function. When one routine serves two purposes, ask whether both purposes want
the same preprocessing.

**Prevented by.** A regression test that asserts **flatness** across the
retained window rather than peak-to-peak, because an assertion on peak-to-peak
would have passed throughout.

---

## 13. Reading a wrist that turned as a hand that moved

**What it said.** Displacement in millimetres, from a clinical recording, with
the whole pipeline validated against synthetic sinusoids of known amplitude.

**What was wrong.** An accelerometer at rest does not read zero. It reads
gravity projected onto its own axes. So a wrist rotating in place, translating
not at all, changes how much gravity falls on each axis and produces a signal
in exactly the tremor band. Integrated twice, a **five degree oscillation with
zero translation** becomes **1.75 mm** of apparent movement, which is larger
than the median amplitude across our entire 260-subject cohort.

**Why it survived.** Every validation we had used synthetic **translation**.
The pipeline was correct for the case we tested and untested for the case that
mattered. The synchronised gyroscope needed to detect the difference was
parsed out of every record and never used.

**The lesson that generalises.** Validating against the signal you expect tells
you the code computes what you meant. It says nothing about whether what you
meant is what the instrument measures. Ask what else could produce this
reading, then synthesise that and check.

**Prevented by.** A distinguishing pair rather than a single assertion, because
the easy way to pass "rotation is removed" is to destroy everything: pure
rotation must fall by more than five times **and** a true 4 mm translation must
survive within 12 percent **and** a mixed record must recover the translation.

**Both of these were errors in our own favour.** Correcting them made the
finding stronger: median hold of a 24 px target fell from 74% to 58%, and
tremors wider than the entire target rose from 37 to 41 of 52. That direction
is worth stating plainly, because a correction that helps you is the one you
are least likely to go looking for.

---

## The pattern

Eleven of these thirteen produced **no error**. Most produced a number that was
the right shape, in the right units, in the right range. The recurring defences
are:

1. **Two independent renderings of the same quantity**, so they can disagree.
2. **A guard proven to fire**, by planting the thing it is supposed to catch,
   rather than observed to pass on a clean tree.
3. **A machine that lacks your scratch state**, which is what CI is for.
4. **Checking content rather than status**, wherever something else's server is
   involved.
5. **Asking what a ratio is made of**, because two names for the same number
   always divide to 1.
6. **An adversarial reader who wants it to be wrong.** Entries 12 and 13, the
   two that actually threatened the finding, were found by a second model
   asked to get this disqualified. Neither would have been found by testing
   harder, because both passed every test we had thought to write.
