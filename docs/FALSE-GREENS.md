# False greens

Every entry below is a moment where this project reported success and was wrong,
or was about to. They are collected because the failure mode that matters in a
measurement tool is not an error message. It is a plausible number.

Each one records what the wrong output looked like, why it looked right, and what
now prevents it from coming back.

**HISTORICAL BY DESIGN.** Every figure and method described below as wrong IS
wrong, and is quoted so the failure is legible. Nothing here describes current
behaviour. For what the code does now, see `docs/METHOD.md`, and for the
current figures see `docs/FACTS.md`, which is generated.

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

## 14. Fixing a confound the data did not have

The worst one, and it was introduced **by fixing entry 13**.

**What it said.** A gyroscope-based attitude correction, validated against
synthetic records, rejecting rotation by 6.3x at every tilt from one degree to
ten. The rejection figure was constant across tilt, which is what a correct
linear correction looks like, and I said so in the commit message as evidence.

**What was wrong.** The filter's entire method rests on the accelerometer
carrying gravity, because gravity is the only thing that fixes an absolute
vertical. **PADS does not carry gravity.** Its accelerometer channel is
already gravity-free, the way CoreMotion's `userAcceleration` is. Measured
across the shipped recordings, the mean acceleration magnitude is **0.001 to
0.14 g**, never the ~1 g a gravity-bearing channel shows.

So the filter took a few thousandths of a g of drift and noise, declared it to
be the gravity vector, normalised it, and derived an attitude from it. It
reported **73 degrees of tilt on a stationary wrist**. Every displacement,
cohort and corpus figure computed through it was unsupported.

**Why it survived.** Every test injected a 1 g vector, because that is what
you write when you are thinking about the physics rather than about the file.
The synthetic cases were internally correct and validated a situation the
production data never presents. The suite was green, the ablation looked
sensible, and the numbers moved in a direction that flattered the finding.

**And the deeper error.** The confound in entry 13 is caused by *gravity
projecting onto rotating axes*. With gravity already removed, the mechanism is
largely absent. I had built a correction for a problem this dataset does not
have, and the correction was worse than the problem.

**What is actually true.** The device's axes still are not fixed in space, so
which direction "x" points is arbitrary. That is a real and much smaller
issue, and it is handled where it belongs, in the geometry, by publishing the
worst hold across azimuths instead of pretending a heading is known.

**Prevented by.** `removeRotation` now checks its own precondition and
**refuses** a gravity-free channel by name, with the measured magnitude in the
error. A test asserts, for every shipped recording, both that the channel is
gravity-free and that the filter refuses it. A second test asserts the filter
still works where gravity is present, because refusing everything is the lazy
way to pass the first one.

**The lesson, and it is the one I would keep from this whole project.** Entry
13 was found by asking *what else could produce this reading*. Entry 14 needed
a different question: *does the input actually have the property my method
assumes*. A synthetic test cannot answer that, because a synthetic test is
built from the assumption. **Measure the real input and assert the
precondition.** One line of arithmetic over the committed files would have
caught this before any of it was written.


---

## 15. A generator that did not perform the method its own output described

**What it said.** `cohort.json` carried a field stating that every hold was
the floor across twelve azimuths, and the README repeated it.

**What was wrong.** `scripts/cohort.mjs` computed hold from **one raw path**.
It never called `azimuthFamily`, `holdOverAzimuths` or `extentOverAzimuths`.
The generator had been written before the azimuth work and was never updated,
while the sentence describing it was added to the output file by hand.

On recording 071 the single-projection hold was 51.9% and the swept worst was
41.9%: ten points, on a published number, between what the file said and what
produced it.

**Why it survived.** The output looked generated, because it was. Nothing in
a JSON file says which code path wrote each field, and a description sitting
next to a number inherits the number's credibility.

**Prevented by.** The generator now calls `recordingToPath`, the same function
the product uses, rather than reimplementing the measurement. A generator that
does not call the product's code will eventually describe a different product.

---

## 16. Two names for the same corpus, counted twice

**What it said.** 7,723 interactive controls. A large, plausible number.

**What was wrong.** The truth was 3,842. The scan cache key includes the
recording id, so re-pinning the default recording created a second set of rows
for the same pages instead of replacing them, and the corpus aggregate had no
recording filter.

**Why it survived for a whole run.** A doubled number does not look wrong. It
looks impressive. Every per-site figure was correct, the total was simply the
sum of two runs, and nothing in the output hinted at a second generation.

**Prevented by.** `corpusSummary` takes a recording id and scopes to it, and
the seeder deletes rows from a superseded recording before reporting. The
guard fired on the next run and said so.


---

## The pattern

Fourteen of these sixteen produced **no error**. Most produced a number that
was the right shape, in the right units, in the right range. Several produced a
number that looked *better* than the truth, which is the hardest kind to go
looking for. The recurring defences are:

1. **Two independent renderings of the same quantity**, so they can disagree.
2. **A guard proven to fire**, by planting the thing it is supposed to catch,
   rather than observed to pass on a clean tree.
3. **A machine that lacks your scratch state**, which is what CI is for.
4. **Checking content rather than status**, wherever something else's server is
   involved.
5. **Asking what a ratio is made of**, because two names for the same number
   always divide to 1.
6. **An adversarial reader who wants it to be wrong.** Entries 12, 13 and 14,
   the three that actually threatened the finding, were all found by a second
   model asked to get this disqualified. None would have been found by testing
   harder, because all three passed every test we had thought to write. Entry
   14 was found in the round that reviewed the fix for entry 13, which is the
   argument for iterating a review until a round comes back clean rather than
   stopping after the first one.
7. **Asserting the precondition against the real input.** A synthetic test is
   built out of your assumptions, so it can never tell you the assumption is
   false. Measure the actual file.
8. **Making the generator call the product.** Entry 15 existed because a script
   reimplemented the measurement and then drifted from it while still
   describing it accurately in prose.
