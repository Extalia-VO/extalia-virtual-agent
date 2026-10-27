# Seated desk rigging review

Implemented in 0.0.75 for both procedural avatars and optional local source bodies.

The previous desk solve constrained the elbow plane and reconstructed wrist
orientation without the actual posed torso. Source bodies also applied the
procedural nominal scale a second time to width and depth. Together these made
desk reaches short, shoulders strained and wrists twisted.

Desk arms now use a continuous two-bone pole solve. Typing contacts span 210 mm
over the letter keys; the pole lowers outward mouse reaches so the elbow stays
below the shoulder. Palm orientation uses the actual parent transform, with
bounded forearm roll. Activity goals blend position, orientation and finger
curl; mouse drift stays within 2 mm of its stationary contact. Cups follow the
solved wrist in the seat frame and stay upright.

Recognized source outfits had thigh weights far below the knee, despite
straight calf bones. A cached geometry copy confines pure upper/lower limb
cloth blending to the first 24% of the lower segment. Skin, shoes and vertices
with unrelated influences retain their original weights. The source body scale
now preserves the intended width/height and depth/height ratios.

The source skeleton has terminal hands. Two cached relaxed-hand morphs soften
the recognized source hands; independently articulated source fingers require
a different rig. Procedural fingers remain articulated. No local model file
was rewritten or added to the repository.

Verification covers mirrored exact forward kinematics, continuous transitions,
transformed palm normals, clothing-weight isolation, source arm adapters and
keyboard/mouse contacts across desktop, laptop, pod and executive seats.
Browser review uses actual workstation geometry and both detailed body
presentations, plus the procedural fallback. The detailed-model review cycles
typing, mouse, thinking, reading, lean-back, desk idle, phone, sip and typing;
after convergence, wrist error stays below 6 mm and palm/finger alignment dots
exceed 0.985. This checks contacts and transitions, not independent source
finger articulation or arbitrary prop pickup paths.

Final validation: `pnpm check` passed (184 suites, 1,666 tests), including lint,
package boundaries, type checks, builds, version consistency and local asset
validation. Desktop smoke passed with all three floor views ready and no model
loading errors. The focused rig/contact run passed 9 suites and 61 tests.
