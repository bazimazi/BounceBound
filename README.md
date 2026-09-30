# Bouncebound

A physics roguelite where bouncing *is* the combat system. The ball never stops
moving; you steer it while airborne and turn every collision into an attack, a
route, a defence, or an opportunity.

TypeScript, a hand-written deterministic physics solver, a Canvas 2D renderer, and
fully procedural WebAudio sound. No binary assets of any kind.

```bash
npm install
npm run dev        # play at the printed localhost URL
npm test           # 164 tests
npm run build      # typecheck + production bundle
```

## Controls

| Action | Keyboard / Mouse | Controller | Touch |
| --- | --- | --- | --- |
| Steer while airborne | `A` `D` / arrows | Left stick | Floating stick (left thumb) |
| Dive (stay low, hit harder) | `S` / hold down | Left stick down | Pull the stick down |
| **Bounce** | `Space` or `J` | `A` | Anywhere on the right half |
| Air brake | `Shift` or `K` | `LB` | Brake button |
| Dash *(once unlocked)* | Right mouse or `L` | `RB` | Dash button, aimed by the stick |
| Aim | Mouse | Right stick | Stick direction |
| Build panel | `Tab` | Select | Corner button |
| Pause | `Esc` | Start | Corner button |
| Debug overlay | `` ` `` | - | - |

**Bounce is one button with two meanings**, resolved by how close a surface is.
Near one it arms the Perfect Bounce window; far from one it spends an air-bounce
charge. A player only ever learns "press to bounce".

## Playing on a phone

The game is fully playable on a phone in either orientation, and designed for
landscape. On touch devices on-screen controls appear automatically (Settings >
Touch can force them on or off, resize them, fade them, or put the stick on the
right). The stick floats - it appears wherever the thumb lands - and the whole
opposite half of the screen is the Bounce button apart from the smaller Brake and
Dash buttons, because Bounce is the timing input and must never miss by a few
pixels. Taps are latched, so a tap shorter than a frame still bounces.

In portrait the arena sits at the top at full width and the controls get the
space beneath it, so no thumb ever covers the play area; the HUD, room banners,
boss bar and callouts are placed relative to the arena and inside the device's
safe area (notches, rounded corners, home indicator). Starting a run on a touch
device goes fullscreen and locks landscape where the browser allows it. Every
menu has phone layouts for both orientations - the reward hand becomes a column
of wide cards upright and one row of short cards sideways - and anything that was
only a hover tooltip can be read by tapping it.

## The two mechanics everything else is built on

**The Perfect Bounce.** Press bounce just before contact and the rebound is
stronger, safer, and more damaging, scaled by how precisely you timed it. It is
learnable because the renderer draws the predicted contact point with a ring that
closes as contact approaches — when the ring touches the marker, press. Crucially
a mistimed press *costs* you: it locks the input for 0.26s, so mashing is worse
than not pressing at all.

**Velocity is damage.** Impact damage scales with impact speed against a reference
of 700 u/s. That single rule turns physical decisions into combat decisions:
diving before a hit, preserving momentum through a ricochet, or braking for
control are all damage choices.

Three rules keep that from becoming chaos. The floor guarantees a rebound of
780 u/s — a bit over a fifth of the arena height — so you are always back in
useful airspace. **Diving suppresses that guarantee**, which is how you choose to
stay low or drop off a platform. And **walls return less energy than floors**,
because a wall should redirect the ball, not accelerate it; horizontal speed also
bleeds continuously unless you are actively steering. Ricochet builds buy the wall
energy back through upgrades, so amplification is something you choose rather than
something you suffer.

## Architecture

```
src/core/     seed-deterministic RNG, fixed-timestep clock, typed event bus,
              pooling, journalled persistence
src/sim/      the simulation: geometry, collision solver, impact pipeline, ball,
              enemies, bosses, props, combo, stats
src/gen/      seeded generation: room templates, validation, branching maps
src/content/  all game data: enemies, bosses, biomes, upgrades, synergies, events,
              ball classes, unlocks, achievements, Bound modifiers
src/game/     build state, upgrade offers, input, debug tools, the app loop
src/run/      run orchestration and the phase machine
src/render/   camera, effects, renderer, HUD
src/audio/    procedural synthesis
src/ui/       DOM screens
src/meta/     profile, settings
```

The dependency rule is one-directional: `content` and `sim` never import `render`,
`ui`, or `game`. The simulation is therefore fully headless, which is what lets the
test suite and the balance simulator play thousands of rooms without a browser.

### The impact pipeline is the extension point

Every collision produces one `ImpactContext` carrying the complete situation —
target, impact speed, incidence angle, incoming and outgoing velocity, relative
speed, surface material, combo state, airborne chain length, time since the last
impact, perfect and critical flags. Resolution runs in ordered stages:

1. Physics produces the raw contact.
2. `buildImpact` derives the gameplay view and base damage.
3. `impactPre` listeners may veto, redirect the rebound, or rescale damage.
4. The solver applies the rebound and the damage.
5. `impact` listeners fire secondary effects: blasts, arcs, fields, projectiles.
6. `impactResolved` listeners observe the final numbers: combo, audio, particles,
   telemetry.

**An upgrade is a data record plus event listeners.** Adding one never touches the
collision solver. Adding an enemy never touches room generation. Adding a biome
never touches progression.

## Content

79 upgrades across seven families, 20 authored synergies, 19 enemies including
three elites, three bosses with distinct mechanics, six biomes, nine ball classes,
seven altar events, 30 unlock-tree nodes, 34 achievements, 12 Bound levels, a
30-rank career track, five mastery tiers per ball, eleven contract types, and
eight ball finishes.

Each system follows one rule from the brief:

- **Enemies ask collision questions, not health questions.** A Bristler's spines
  face upward, so dropping on it costs you and a flank does not. A Platewright's
  plate turns to cover its last wound, so every hit must come from somewhere new.
  A Warden ignores anything that came straight off the floor. Difficulty escalates
  by combining enemies whose answers *conflict* — the generator's encounter
  weighting actively prefers a different tag set to what is already in the room.
- **Bosses own a property of the physics.** The Mirror owns reflection, The Crusher
  owns geometry, The Architect owns surfaces. Vulnerability is expressed through
  the same armour-arc language the player already learned from ordinary enemies.
- **Upgrades change behaviour, not numbers.** Where a stat changes, the card states
  the trade-off. Offer weighting pulls toward the build already forming, so builds
  converge into an identity the HUD names for you.
- **Permanent progression widens the game rather than flattening it.** Roughly 70%
  of the unlock tree is "new things exist now"; every power node combined is worth
  less than two good in-run upgrades. Every content node gates something real: a
  fresh profile starts without transformations, evolutions, exotic physics,
  Specialists, Primes, Wardens or Hollows, and each arrives when its node is
  bought. Nodes whose content is not built yet are shown but cannot be bought.

## Progression

Two currencies and a career, each answering a different question.

**Echoes** ("what can a run contain?") are earned by every run and spent in the
unlock tree. **Relics** come from Wardens, hard contracts and the career track,
and buy the **Reliquary** branch: Opening Hand (every run opens with an upgrade
offer), Salvage Rights (skipping pays half again), Keepsake (start with a shield)
and Attunement (the opening offer leans rare).

**The career** ("am I getting anywhere?") moves after every run, including the
ones that die in the second room:

- **Rank.** Every run pays experience - rooms, elites, bosses, perfect bounces,
  combo, a win - scaled by Bound. Each rank pays something on a fixed track
  (echoes, relics, a title or a ball finish) for thirty ranks, then echoes forever.
- **Mastery.** The same experience fills the played ball class's own five-tier
  track, paying echoes, a relic, two titles and the Gilded finish, so each class
  is worth playing past the run that unlocked it.
- **Daily contracts.** Three objectives a day - easy, medium, hard - rolled from
  the date so everyone gets the same three. Progress accumulates across all of the
  day's runs, and the hard one pays a relic.
- **Cosmetics.** Titles and ball finishes are chosen on the Career screen and
  worn in play. None of the career is power: echoes and relics feed a tree with
  its own ceiling, and everything else is decoration.

The menu shows rank, title and open contracts under the logo; the run summary
itemises the experience, every rank and mastery tier reached with its reward, and
any contract completed.

## Routes and the descent

A run is three depths: Verdant Ruins, Clockwork Foundry, Frozen Abyss. Unlocking
the Storm Citadel or the Gravity Rift does not make runs longer; it turns the
second or third act boundary into a **fork**, shown as two act boards side by
side, each with its rules and the boss that holds it. The Unbound is the one real
extension: a fourth and final depth. Alternatives share a depth range and never
repeat a boss on any route.

Every route option shows its **outlook**: glyphs for what is still reachable down
that branch (Exchange, Wellspring, Cache, Encounter, Elite, unknowns) and the
number of rooms to the boss. Hovering an option traces that branch on the board.
Filler rooms pay differently, so a fork between them is a real decision: a Hazard
pays shards, an Ascent restores some integrity, a Mechanism grants a reroll, and a
Trial offers a rarer upgrade. Beating a boss restores 35% integrity before the
next depth.

A run ends pointing forward. Echoes are itemised (rooms, bosses, elites, and a
one-off bonus the first time a depth is reached), and the summary names the next
unlock with a progress bar, or says what is already affordable, plus the closest
unfinished achievement.

## Determinism

Every random decision flows through a seeded RNG derived from the run seed, and
subsystems use forked streams so that consuming an extra number for a particle can
never shift a room's layout. The simulation runs at a fixed 240 Hz. Hit-stop and
time dilation are applied to the *clock*, never to the timestep, so game feel never
compromises reproducibility. A seed reproduces the map, every room, every encounter
and every reward offer exactly — which is what makes daily challenges and bug
reports work.

## Balance tooling

Balance decisions in this project were made against measurements, not intuition.

```bash
npm run balance 60 0   # 60 bot-played runs at Bound 0: win rates, death causes,
                       # pick rates, build identities, damage attribution
npm run pacing         # per-room clear times by archetype, slowest rooms, and
                       # which enemies dominate the slow quartile
npm run soak           # hunts unreachable states across hundreds of rooms
npx tsx tools/diagnose-feel.ts   # quantifies "how bouncy is it": average and peak
                       # speed, lateral speed, wall contacts per second
```

A deliberately mediocre bot drives these. Things it found that no unit test would
have, all of which are fixed:

- The guaranteed minimum rebound has a narrow good range, and both ends are wrong
  in ways only measurement shows. At 300 u/s it lifts the ball 21 units, so a ball
  that had bled off energy was trapped on the floor and rooms became unclearable. At
  950 it kept total speed above 900 u/s a quarter of the time, which playtesting
  described as too bouncy to enjoy. It now sits at 780, verified with a dedicated
  feel probe.
- Wall contacts returned nearly all incoming speed, so a corner acted as an
  amplifier and the ball ping-ponged sideways uncontrollably. Vertical surfaces now
  absorb energy and lateral speed bleeds while coasting.
- Flying enemies had no arena containment and would slowly drift thousands of units
  outside the room, permanently unreachable. They also pinned themselves against
  pillars between them and the player, so they now steer around obstacles — with the
  raycast throttled, because casting per enemy per 240 Hz step took a soak run from
  fourteen seconds to six minutes.
- An enemy wedged where a pillar meets the floor oscillated forever between two
  de-penetration solutions. Overlaps are now resolved together, with a guaranteed
  escape search as a last resort.
- The combo meter could be pinned at its cap by idle wall-tapping, making the
  multiplier a baseline rather than a reward. Surface bounces now grant combo only
  when they are perfect.
- An armoured enemy facing the wrong way could block a naive approach forever. Now
  blocked hits accumulate strain and force the defence open, so persistence is a
  slow answer rather than no answer.
- Enemies could spawn or be knocked inside solid props, where the ball collides with
  the prop first and the room can never be cleared.
- A Brood Matron split into more Brood Matrons, multiplying its own spawner into
  forty concurrent enemies.
- An unaffordable shop pedestal re-spawned every frame, allocating without bound
  until the process ran out of memory.
- Static hazards accounted for 60% of all damage taken — chip damage rather than
  situational difficulty.

## Interface

Panels are deliberately sparse. Playtesting said the first version read as a web
app rather than a game, so: cards carry a name, one effect line, a cost if there is
one, and at most two stat deltas; the journal is a dense grid of names; the ball
select spells out only the chosen class; and settings hints live in tooltips. Detail
is always one hover away, never printed for every entry at once.

Visually the shape does the work rather than the colour — clipped corners instead of
rounded, uppercase tracked headings, oversized tabular numerals, corner brackets,
faint scanlines, and fully restyled range and checkbox controls, since a native
slider is the strongest "settings page" signal there is. Cards are dealt in with a
short stagger and sweep on hover, legendary and cursed picks pulse, selectable route
nodes glow, and results numbers count in one after another.

In the arena, the feedback layer borrows from the games that defined "juice":
squash along the impact normal and stretch along velocity (Celeste), a white pop
and jelly squash on every enemy hit plus a camera kick in the direction of the
blow (Nuclear Throne), trauma-squared screen shake driven by smooth noise rather
than white noise (Eiserloh's camera talk), contact flares, arcing damage numbers
and enemies that come apart into pieces of themselves. Enemies have eyes that track
the ball, scowl while winding up and cross out when stunned, which makes a
telegraph readable at a glance. The ball lights the grid around it, the exit
becomes a spinning portal when it opens, rooms open with an iris on the ball, and
big moments (room cleared, boss defeated, synergy, a lost combo) are narrated by
callouts that queue rather than overlap. The HUD animates every number: integrity
keeps a fighting-game ghost of the last hit, the combo pops and escalates by tier,
and shards count up. Bloom is pre-rendered glow sprites drawn with additive
compositing, never `shadowBlur`, so it stays cheap. The title screen runs a small
decorative bouncing scene with its own physics, kept apart from the seeded
simulation.

All of that is motion, so all of it is subordinate to the accessibility settings:
*Reduce motion* and *Reduce flashing* now apply to the DOM panels as well as the
canvas, and the interface-scale setting drives the root font size so menus scale with
the HUD. Two tests enforce text-density budgets so the wordiness cannot creep back.

## Accessibility

The game should be hard because of the physics, never because of the presentation.
Configurable: trajectory guide (impact point, full path, or off), the Perfect Bounce
timing ring, hazard outlines as a shape cue independent of colour, four colour-vision
palettes plus high contrast, interface scale, screen shake, hit-stop, particle
density, reduced flashing, reduced motion, stick sensitivity, dash aim assist, a
hold-to-arm bounce mode, left-handed binding swap, and independent audio buses.

## Save integrity

Writes are journalled: staged with a checksum, the previous value copied to a
backup, then promoted. A crash at any point leaves either the old value or a
recoverable staging value, never a half-written one. On load, a failed checksum
falls back to staging, then to backup, and the player is told when a recovery
happened. A stored profile is treated as untrusted input and repaired rather than
trusted.

**Runs survive a reload.** Refreshing the page drops you straight back into the run
you were in — no prompt, no menu. What makes this cheap is determinism: because the
map and every room are pure functions of the seed, nothing about the *world* is
stored. Only what the player accumulated is written down (build, currencies, vitals,
route progress, telemetry) and the room is regenerated on load.

Granularity is the room, not the frame. A resume puts you at the start of the room
you were in, carrying your **current** integrity and shields rather than the values
at room entry — so a reload cannot be used to undo damage. The snapshot is written
on room entry, on taking an upgrade, on touching an interactable, every six seconds,
and on shutdown; it is cleared the moment a run ends, so death still means death. A
snapshot that references content this build no longer defines is repaired or
discarded rather than trusted, so a stale save can never trap you in a boot loop.

Pause offers both **Save and quit** (shelves the run; the menu then leads with
*Continue run*) and **Abandon run** (ends it and discards it).

## Where this stands

Complete and playable end to end: the core loop, in-run buildcraft, branching
routes, three bosses, meta progression, the journal, achievements, Bound levels,
and a full accessibility pass. Deliberately still open:

- **Biomes 4-6** (Storm Citadel, Gravity Rift, The Unbound) have palettes, rules,
  hazard tables and unlock gates, but no dedicated bosses — each borrows the boss of
  the depth it stands in for (the Unbound closes against the Mirror). One boss each
  is the next content increment.
- **Other Occupants** (`boss_variants`) currently swaps a depth's boss for one of
  the other two; dedicated alternate bosses would make it more than a reshuffle.
- **Challenge modes** (boss rush, endless) and the **Resonance** secrets are in the
  tree as closed nodes; the deterministic seeding they need is in place, the modes
  themselves are not built.
- **Balance** is measured but not settled. The bot is a floor, not a substitute for
  human playtesting, and the win-rate curve across Bound levels needs real players.
