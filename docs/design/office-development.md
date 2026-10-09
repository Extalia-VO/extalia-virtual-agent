# Office development and character roadmap

## One application and one source of truth

Extalia Virtual Agent is the development home for the Office renderer, characters,
furniture and spatial behavior. Web and Desktop package the same React renderer.
Setup, provider configuration, Chat and the Office share one host/session index.

The earlier Virtual Office is a migration reference. Complete its furnished F1,
F2 and F3 geometry and authored avatar visuals here; do not keep two product
renderers evolving independently. New Office improvements belong in this repo.

If an outstanding improvement is made in the earlier project during migration,
review its source diff and adapt it here. Check dependencies, neutral labels,
protocol/session contracts and asset provenance before copying it. Compare the
affected room or character visually in Web and Desktop. Imported geometry is
adapted source code, not an automatically synchronized copy.

## Conversations belong to characters' sessions

- A primary character opens and prompts its own managed session. Changing the
  selected character switches the history, composer and approval controls to
  that session ID.
- Delegated workers display their reported activity. Their instructions and
  approvals remain with the parent session until a runtime offers independent
  worker conversations.
- Observed characters display native history. Observation does not grant prompt,
  cancellation or approval control over the source app.

## Appearance and movement work to complete

Keep appearance and animation preferences separate from model/provider identity.
Do not infer a person's gender from a name or an agent's model. Provide editable
presets and individual options:

| Area | Required follow-up |
| --- | --- |
| Hair | Distinct masculine and feminine presets, lengths and styles; explicit user choice |
| Clothing | Appropriate garment cuts and outfits across presets; independently editable |
| Accessories | Per-character glasses, watches, bags and other accessories, including preset variants |
| Movement | Configurable masculine, feminine and neutral walking styles, proportions and stride |
| Consistency | Seated, idle, typing and walking poses must work with every garment and hair style |
| Preferences | Store appearance per character, preserve it across sessions/restarts, and honor reduced motion |

These are tracked requirements, not a claim that the complete appearance editor
or gait presets have shipped. Extend the shared character implementation here
so both Web and Desktop receive each improvement together.
