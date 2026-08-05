# HyperStrike Design System

## 1. Product idea

HyperStrike is the world’s first prediction market for CS2 skin prices. It turns a market opinion into a physical action: enter a range, aim at a skin outcome, and fire one round for one directional vote and one contract. The interface must feel like a credible competitive FPS and a credible trading terminal at the same time.

Limited-time event worlds may translate the same explicit staging model into another physical verb. The retired World Cup demo uses an anime penalty cut-in: left goal target stages YES, right goal target stages NO, and an oscillating 1–100 power gauge determines how many demo contracts the completed kick stages. Event worlds must remain visually and transactionally distinct from the canonical skin range; retired events must be labelled as demos and must not request wallet signatures, burns, or live HIP-4 orders.

The product is not about esports matches. Every surface, metric, target, and line of copy must point back to skin price discovery.

## 2. Creative direction

The visual system merges two sources:

1. The existing HyperStrike language: deep teal, luminous mint, circular crosshair mark, compact market telemetry, and a dark Hyperliquid-native terminal.
2. The official [Counter-Strike 2 presentation site](https://www.counter-strike.net/cs2): high-contrast orange and navy, oversized italic display type, diagonal graphic motion, concrete/paint/steel tactility, and cinematic weapon-led compositions.

The result is **Ballistic Exchange**: a sunlit industrial price range whose physical world carries CS2’s grounded materiality while its digital layer remains unmistakably HyperStrike.

This is an inspired visual synthesis, not a reproduction of Valve assets, layouts, logos, maps, or trade dress.

## 3. Design principles

### Conviction should feel physical

Market selection is not an abstract checkbox. Outcomes are physical YES and NO targets. A hit produces recoil, light, sound, impact feedback, a casing, and a vote confirmation.

### Texture beats decoration

Production value comes from believable material response and environmental storytelling—not additional floating neon. Concrete has aggregate and cracks. Steel has seams and fasteners. Wood has grain and slats. Paint is worn, directional, and functional.

### One visual hierarchy

The 2D interface and 3D world share the same colors, type scale, labels, and language. Market cards should look like portable versions of the in-world market stations.

### Competitive clarity

Crosshair, targets, ammunition, interaction prompts, and market prices must be readable immediately. Atmosphere can never obscure play.

### Honest financial states

Paper mode, wallet state, burn requirements, and HIP-4 status must always be explicit. Never imply that a local vote is an on-chain position.

## 4. Brand palette

| Token | Hex | Use |
| --- | --- | --- |
| Range ink | `#07171B` | Primary background and terminal surfaces |
| Deep navy | `#172B31` | World fog, steel shadows, secondary panels |
| Strike orange | `#E89A42` | Primary actions, navigation markers, environmental paint |
| Hyper mint | `#8EF5E3` | Crosshair, active market data, HyperStrike identity |
| Signal green | `#6DF3B6` | YES, positive movement, connected state |
| Signal red | `#F06D63` | NO, negative movement, destructive warning |
| Concrete | `#AEB4AE` | Bright environmental structure and neutral text |
| Field white | `#EFF3EE` | Headlines and maximum-contrast copy |

Orange provides physical-world energy. Mint identifies the protocol and interactive layer. They should meet at focal points, not compete across every surface.

## 5. Typography

- Display: condensed, heavy, uppercase, slightly italic. Use tight tracking and short phrases.
- Interface: condensed sans serif in uppercase for navigation and commands.
- Telemetry: monospace for prices, probabilities, chain state, ammunition, addresses, and timestamps.
- Body copy: neutral sans serif with generous line height.

Headlines should sound operational:

- “CALL THE NEXT PRICE.”
- “ENTER THE PRICE RANGE.”
- “ONE HIT. ONE VOTE.”
- “ARM THE OUTCOME.”

Avoid vague world-building phrases such as “skin market floor.” Describe the mechanic or the market directly.

## 6. Composition and shape

- Use diagonal cuts, slashes, and bands to imply forward momentum.
- Prefer strong left/right massing over centered dashboard layouts.
- Keep panels rectangular and engineered; small clipped corners are acceptable on primary actions.
- Use borders as structure, not decoration.
- Reserve circles for the crosshair, the HyperStrike mark, and target feedback.

## 7. Website system

### Header

The header is compact, dark, and technical. The brand remains left, product navigation sits in the center, and wallet state is the strongest action on the right. An orange top rule provides the CS2-derived kinetic accent.

### Landing composition

The live 3D range is the hero art. Copy occupies the left third, with a narrow orange chapter label, an oversized two-line command, a concise explanation, live protocol metrics, and one dominant entry action.

The hero should not obscure the center firing lane or the right-side weapon silhouette.

### Market surfaces

Cards use official Steam Community Market item imagery on restrained dark fields. Probability, reference price, resolution, and the user’s ballistic vote count remain visible without opening a drawer.

### Motion

- Entry actions: 160–220 ms.
- Drawers: 200–260 ms.
- Vote confirmation: sharp 100 ms strike followed by a 500–700 ms settle.
- Avoid ambient UI motion that competes with the 3D scene.

## 8. 3D range art direction

### Environment

The range is a converted industrial training hall—not a science-fiction void. It should contain:

- worn concrete walls and floor tiles;
- painted orange and mint navigation lines;
- steel structural bays, ducts, conduit, and suspended cables;
- side doors, vents, barriers, crates, catwalks, and rails;
- large A/B wayfinding paint and range-sector labels;
- bright overhead practicals and warm/cool light separation;
- market stations with official 2D skin imagery and physical YES/NO plates.

### Materials

Use physically plausible roughness:

- concrete: roughness `0.8–0.95`, metalness `0–0.05`;
- painted steel: roughness `0.4–0.6`, metalness `0.5–0.75`;
- wood: roughness `0.7–0.85`, metalness `0–0.05`;
- screens: unlit or low-tone-mapped for legibility.

Texture detail should be baked or procedural and reused. Prefer instancing for repeated architecture and props.

### Lighting

- Neutral skylight establishes visibility.
- Warm key light and orange bounce create physical depth.
- Cool mint fill connects the space to HyperStrike.
- HDR/PMREM reflections provide material response.
- Heavy screen-space effects are optional and should never cost interaction latency.

## 9. FPS view model

The AK must read as a first-person view model, not a world prop attached to the camera.

- Receiver lives in the lower-right quadrant.
- Stock exits below/right and does not dominate the frame.
- Barrel points toward the crosshair with a slight right-to-left perspective.
- The weapon occupies roughly 38–46% of viewport width at 16:9.
- Idle roll is minimal; yaw is shallow enough to preserve the recognizable AK silhouette.
- Walking produces restrained vertical and lateral sway.
- Recoil is a brief rear/up impulse with fast recovery.
- Reload rotates the receiver inward, removes the real magazine part, seats it, then racks the real bolt part.

Avoid procedural low-poly hands unless a production-quality rig and animation set are available. A clean weapon-only view is better than placeholder anatomy.

## 10. Interaction contract

- `WASD`: move.
- Mouse: aim.
- Hold `LMB`: automatic fire.
- One bullet hitting a YES or NO plate: one local ballistic vote and one staged contract on that side.
- Misses: no vote.
- `R`: tactical reload; reserve ammunition remains infinite.
- `E`: open the targeted skin market.
- `Esc`: release pointer lock.

Every interaction prompt should use these exact verbs.

## 10.1 Fidelity roadmap

The current AK is suitable for a prototype, not for a CS2-quality first-person presentation: it has roughly 28.5k rendered vertices, no texture maps, no rig, and no authored animation clips. Lighting changes alone cannot recover detail that is absent from the asset.

Close the fidelity gap in this order:

1. Replace the AK with an owned/licensed first-person asset containing 2K–4K base-color, normal, roughness, metalness, and ambient-occlusion maps.
2. Add a rigged first-person arm and glove set with authored idle, fire, inspect, magazine-out, magazine-in, and bolt-rack animations.
3. Render the view model with a separate 50–56° weapon camera so its perspective and clipping remain independent of the 65° world camera.
4. Replace procedural room boxes with a modular authored environment kit: beveled concrete, trim sheets, decals, props, UV2 lightmaps, and collision proxies.
5. Add scalable contact shadows, SSAO, reflection probes, baked indirect light, color grading, and selective bloom behind a quality preset.
6. Transcode production textures to KTX2/Basis and geometry to Meshopt/Draco so higher visual quality does not produce unusable browser loads.
7. Add spatial weapon tails, material-specific impacts, shell sounds, and animation-synchronized mechanical audio.

The target is not literal parity with Source 2. The achievable browser target is a polished, responsive first-person product whose asset quality, lighting, animation, and material response belong to the same visual generation.

## 11. Performance budget

- Target 60 FPS on a modern laptop at native browser size.
- Cap device pixel ratio near `1.1` by default.
- Reuse geometries, materials, and textures.
- Instance repeated structural props.
- Keep particles bounded and dispose short-lived effects.
- Prefer baked detail and lighting composition over expensive post-processing.
- Keep official skin images as 2D planes; never reconstruct market skins as 3D geometry.

## 12. Accessibility and responsive behavior

- Maintain WCAG AA contrast for essential text and controls.
- Do not communicate YES/NO solely through green/red; always include labels.
- Respect `prefers-reduced-motion` for interface transitions.
- Preserve 2D market browsing when FPS controls are unavailable.
- On narrow screens, collapse navigation, simplify telemetry, and prioritize the market drawer over the weapon HUD.

## 13. Definition of done

A HyperStrike screen is successful when a new user can answer all four questions within five seconds:

1. What is this? A prediction market for CS2 skin prices.
2. What do I do? Aim at YES or NO and fire.
3. What does a bullet mean? One hit equals one vote and one contract; order value is contract count multiplied by side price.
4. What is real? The interface clearly distinguishes paper voting, retired-event demos, manual `$HSX` burns, and any future live HIP-4 position layer.
