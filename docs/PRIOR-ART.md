# Prior art

Everything below was found by adversarial search, before building, with the
explicit goal of killing the idea. Two of the three questions came back as
"already done". Those parts were cut from the claim rather than defended.

## Measuring tremor from a device sensor: already shipping. Not claimed.

| | |
|---|---|
| **StudyMyTremor** (iOS, $3.99, since 2016) | Reports amplitude **in millimetres** from the phone accelerometer |
| **Tremor Monitor** (iOS, $1.99) | Results screen shows "Amplitude: 31.7 mm" |
| **StrivePD** (Rune Labs, free, FDA 510(k)) | Passive watch tremor via Apple's entitlement-gated API |
| ~10 more live apps | Frequency in Hz and/or acceleration in g |

**Apple's `CMMovementDisorderManager`** (watchOS 5+) is entitlement-gated, restricted
by Apple to "patients clinically diagnosed with a movement disorder", and its
output is **categorical**: `percentSlight` / `percentMild` / `percentModerate` /
`percentStrong`, summing to 1.0. No millimetres, no hertz.

We do not claim this part and do not build it.

## Adapting target size to a person: done before, three times, differently.

**SUPPLE++** (Gajos, Wobbrock & Weld, UIST 2007; CHI 2008) optimises `s`, a
per-user minimum target size, as a continuous parameter over 0 to 100 pixels.
CHI'08 results: 26.4% faster, 73% fewer errors, 11 motor-impaired participants.
Desktop mouse and trackball. Size is derived from **expected movement time**, not
from tremor; tremor is mentioned twice, incidentally. The ability test took
motor-impaired participants 30 to 90 minutes.

**ABD-MT** (Kong, Zhong, Fogarty & Wobbrock, MobileHCI 2024, open source) ships
an example keyboard that "automatically enlarges according to the presence and
amount of a user's tremor", and states plainly: *"In contrast to accessibility
guidelines emphasizing a single minimum target size, this example illustrates
how the ABD-MT can support adaptation to individual motor ability."* This is the
closest published work. Its `hasTremor()` is a **boolean** derived from touch
variability, the enlargement is four times the user's average **touch extent**,
and the paper contains zero occurrences of "WCAG" and zero of "millimetre".

**Sarcar, Jokinen, Oulasvirta, Wang, Silpasuwanchai & Ren** (IEEE Pervasive
Computing 17(1), 2018) is the only work found that puts a tremor amplitude in
physical length units on one side and key size on the other, with a design space
including "K1: Key size [26.5dp, 177.5dp]". The amplitudes are **population
values from the literature**: 4.7 cm for essential tremor, 10.6 cm for
Parkinson's. The authors name measuring the individual as future work.

## Accessibility tooling: flat constants, every one.

| Tool | Target-size rule |
|---|---|
| axe-core `target-size` | flat 24 CSS px |
| Lighthouse `tap-targets` | flat 48 px |
| MotorEase (ICSE 2024) | flat 48 px against visual bounds |
| WAVE, Siteimprove, Deque, Level Access, AudioEye | WCAG constants only |

None relates target size to any measured human capability. axe-core's own rule
documentation names "people who have mobility impairments such as hand tremors"
as the beneficiaries, and then applies 24 px to everyone.

## Operating systems: sliders, not measurements.

iOS Touch Accommodations, AssistiveTouch dwell and movement tolerance, Android
touch-and-hold delay and autoclick, macOS Pointer Control, Windows mouse
settings. Every one is a manual control or a three-way preset. **None measures
the user.**

## Simulators: synthetic, every one.

**Funkify**'s "Trembling Trevor" persona animates a synthetic cursor wobble; the
basis was a design workshop, not motion capture. Silktide, Chrome DevTools and
Accessibility Insights have no motor simulation at all. Research hardware
(vibration gloves, EMS, Stewart platforms) synthesises waveforms rather than
replaying a recording.

## Datasets: the gap that forced our approach.

No open dataset pairs raw time-stamped **cursor** trajectories with
**clinician-confirmed** tremor.

- **Findlater & Zhang** (`github.com/leahkf/mouseandtouchinput`, CC BY 4.0) is
  public and does contain raw cursor traces: 512 desktop mouse trace files from
  64 participants who tick a self-report tremor checkbox. **No diagnosis, no
  rating scale.**
- **Hevelius** (Gajos et al., *Movement Disorders*, 2020) has exactly what is
  needed, 95 ataxia and 46 parkinsonism participants scored on BARS and UPDRS
  from mouse trajectories, and **has never been released**. The 2024 follow-up
  explains why: "Both datasets were anonymized before the authors could access
  them."
- **White & Horvitz** (*npj Digital Medicine*, 2019) is cursor plus tremor at
  population scale and is Microsoft-restricted, and its tremor label is a
  self-report survey question.
- **Zhao et al.** (IMWUT 2025, DOI 10.1145/3712267) modelled mouse pointing and
  steering with 12 clinically confirmed PD participants. The most on-point paper
  that exists. No data release is discoverable.

That absence is why displacement is recovered from **wrist accelerometry**,
where clinically labelled recordings are public.

## What is left

Taking **clinically recorded** tremor, in physical units, and evaluating **WCAG
2.5.8 itself** against it, on **pages that are actually shipping**.

Not the measurement, which is a solved consumer product. Not the principle that
targets should adapt, which Wobbrock's group has argued since 2007 and shipped
code for in 2024. The join: a number from a clinical recording, pointed at the
specific constant that governs whether a real page is legally accessible, and
run against real pages.
