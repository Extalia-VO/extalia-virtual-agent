# Office character picking

## Hidden floors intercepting a visible character

The reported symptom was a click on a seated avatar opening another character's
card with “Not in view”. Character selection itself uses the avatar's presence ID;
it does not resolve an identity from the desk or seat allocation.

Three.js raycasts hidden object subtrees. The default React Three Fiber pointer
manager also retains those intersections before bubbling to registered handlers.
Office agents and facility staff remain mounted when their floor is hidden, with
an ancestor group's `visible` property set to false. A hidden upper-floor avatar
can project onto the visible seated avatar and produce the nearer intersection.
Its click handler then correctly dispatches its own ID, but that was the wrong
visual target for the user.

## Visibility-aware pointer dispatch

The Office canvas now uses its normal pointer manager with an intersection
filter. It drops any hit whose object or ancestor has `visible === false` before
hover/click events bubble. Visibility is read at event time, so changing floors,
character fading and hidden wardrobe pieces cannot leave a cached hidden target.

Visible hits retain their original ordering and instance metadata. Intentionally
transparent pick volumes are still valid: their object hierarchy is visible even
though their material opacity is zero. Existing selection IDs, seating,
movement, popup placement and default pointer computation/capture are unchanged.

This addresses hidden-object interception; it does not introduce a general
opaque-wall occlusion policy or change the size of avatar pick volumes.

## Verification

Seven regressions use real Three.js raycasts, including a nearer hidden upper
floor, hidden intermediate ancestors/wardrobe, transparent pick volumes, live
floor changes, instance metadata and a fully hidden scene. These and existing
card selection/placement and Office controls suites pass 28 tests.

A synthetic browser scene uses the production OfficeCharacter, CharacterPopover,
PopoverAnchor and pointer manager. Two seated avatars on different floors project
to the same pixel. With default legacy pointer dispatch, clicking the shown
avatar selects the hidden ID and the card says “Not in view”. At the same pixel,
the new manager selects the shown ID and anchors its own card. Switching floors
selects the newly shown ID. English/light desktop and Indonesian/dark at 1200 px
and 390 px were checked; the mobile card remains anchored within the viewport.

The browser scene uses synthetic identities and local scene assets. It does not
access real sessions or identify which exact live avatar was hit in the supplied
screenshots. The reproduced hidden-floor failure matches their observed symptom.

The fix was introduced in v0.4.265. Web typechecking, production renderer build
and Desktop build pass. The full workspace gate was attempted, but remains
blocked by concurrent ownership-review entries in Chat event/image presentation,
observation and importer code. No full-gate success is claimed for this update.
