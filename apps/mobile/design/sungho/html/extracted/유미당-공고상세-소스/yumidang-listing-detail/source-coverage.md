# Current design-only contract (supersedes historical simulation notes)

The user approved cleanup of design mockups, not a second functional prototype. The existing29 scenes remain review fixtures, with two source-supported public awaiting/completed variants for31 total. Business confirmation actions and reopening no longer change key, applicant list or request data. Only explicit external scenario selection changes the fixture. Cooldown is a fixed60-second example, with no Date.now or setInterval in the detail controller. Existing dialogs, menus, press, sheet and scroll interaction remain.

Policy authority: original 정책.md lines108 (unset deadline=start),144 (request expiry=min(request+6h,start)),169 (mutual public-post/profile hiding). The original frontend/backend remain immutable. The approved blocked design scene now returns unavailable content and no footer, with the persistent original close handle. Other policy fixes are presentation fixtures only.

Temporal fields are provided by getView: startsAt/endsAt/reviewClock/deadlineAt/requestExpiresAt and formatted labels. Existing date format and layout are preserved. Connected cards use Oct8 09:00 KST for pre-start scenes; expired scenes use start+1 minute and completed scenes end+1 hour. Those review clocks are outside the artboard. No invented custom recruitment deadline or empty pending expiry remains.

Historical notes below record prior approved designs; descriptions of clicking to mutate application/recruitment/deletion state are superseded by this section.

# S02 source coverage and explicit display exceptions

## Current scope

29 offline review scenarios. Actual `PreviewPostDetail` in BrowseScreens.tsx:1145–1529 is the product-control authority. `RemotePostDetail` in RemoteScreens.tsx:543–602 provides the failure/retry reference only. The user explicitly removed the loaded-service, null-name, private-details, no-event and loading review examples. Those branches are removed from the generated selector/model/renderer, not from the actual runtime repository.

`runtime-control-map.csv` maps each remaining generated product-control family and confirmation pair to source lines/conditions. Cross-screen destinations are press-only by request. This is source/static coverage of represented scenarios, not every possible state-data cross product or live service behavior.

## Preserved runtime conditions

- Owner footer takes precedence over participant footer. Confirmed owner keeps disabled edit/close, ordinary applicant card, enabled profile/chat, disabled select, no reject/delete.
- Applicant selection opens the original confirmation directly. Pending consent keeps select/reject available; repeated requests return the existing one-at-a-time error.
- Closing/reopening retains existing conversation request data; reopening sets recruiting while applicant can remain pending. Rejection changes conversation without inventing a post transition.
- Nonowner participant gets only the appointment CTA. Other CTA label/disabled precedence follows guest, existing-chat, rejected, cooldown, age mismatch and unavailable source conditions.
- `restricted` does not invent a disabled detail button. Direct blocked preview retains its original body/disabled apply. Optional wishes remain absent unless the existing field is supplied.
- Status dropdown/menu, intermediate applicant picker, duplicate header edit and extra confirmed chat/blocked appointment shortcut remain absent.
- Error retains its title and retry button, but its decorative circle/dot is removed as requested. Retry does not navigate to a removed service-success fixture or unrelated preview. It keeps the failure example and gives external review feedback that no server was queried.

## Explicit user-requested presentation exceptions

1. Gender prefix removed from displayed qualification: ‘성인 전체’ / ‘만 30~35세’. No eligibility or signup logic changed.
2. Guest synthetic preview retains the same sample profile structure/content and adds 5px blur. No placeholder replacement or visible overlay message. Outer profile action remains login S05, never S14. Surface is aria-hidden/inert with empty image alt and pointer-events/user-select disabled. This is not data security: offline samples remain inspectable, and real anonymous data must continue to be withheld server-side. No real private data was added.
3. Existing X dismissal moved to a labelled native handle, with approved browse sheet gestures/motion. No duplicate close control. Meaningful post title, information and confirmation controls remain.
4. Service review examples removed except error; actual service source unchanged.

## Data provenance

Seed content is from data.ts:46–50,70–86,109–168,201–222: 박수빈 age29/sweetness15, applicant 김민지 age27, title/introduction/public/private location/linked exhibition. Existing design image assets are placeholders and do not identify those synthetic people. Review clock is 2026-10-12 09:00 KST; post now+2 days/duration2h and event currentWeek+1day/weekEnd+7days follow source. Date formatting uses source ui.tsx options.

Role/status fixtures exercise source-existing properties, not simultaneous live states. Default unconfirmed view is a review scenario, not the seed's actual confirmed post. Ineligible age30–35 and optional wishes are explicit synthetic inputs to existing fields. Precise location is omitted when not participant. The entire file is an offline sample, not an access-control implementation.

## Reusable bottom-sheet behavior

`shared/bottom-sheet.js` receives elements and callbacks only. Approved browse v31 contributes 280ms enter cubic-bezier(.22,1,.36,1), 200ms exit cubic-bezier(.4,0,1,1), 10px gesture activation, 80px inclusive dismissal and 240px displacement cap. Short pulls return over200ms; reduced motion has no delayed lifecycle. Mounted sheet/scrim remain through exit, and reopening invalidates stale entry/exit callbacks.

Touch downward pull starts on the handle or noninteractive content at scrollTop0. Handle mouse/pen remains supported. Horizontal/upward/multitouch/cancelled gestures cannot dismiss. Eligibility is rechecked while moving/releasing so a newly opened confirmation blocks underlying dismissal.

42×4px bar in72×36px region has geometric16px top/bottom gutters. Browse's33.63671875px grip is a filter-specific legacy adjustment, not a universal token or a verified current ink measurement. No browser measurement is claimed.

`shared/drag-scroll.js` adds primary-mouse blank-area content scrolling. At10px vertical movement, startScrollTop minus pointer delta determines bounded scroll. A downward gesture beginning at0 delegates to the existing sheet dismissal; one beginning below the top (scrollTop>0) remains scroll even when reaching the top. Controls, forms, links, sliders, text-bearing nodes, selected text and modifier gestures are excluded. Touch, pen content, wheel and keys remain native. Capture/cancel cleanup and synthetic-click suppression preserve the next ordinary click.

Scrollbar CSS hides chrome only; overflow stays enabled. Presentation modules do not mutate domain state, route, service or backend.

## Backend boundary

No original repository, backend, database, contract, credential or API was modified. Existing remote read is `service.getPost(id)` → GET /posts/{postId} (service.ts:1231–1252). Original RemotePostDetail leaves application disabled (:597). Future remote application/owner/applicant mutations require actual server authorization/state/wiring; no endpoint is inferred or created here. Prototype state.tsx helpers are not evidence of live backend support. Removing review examples does not remove actual runtime service branches.

## Verification

- node syntax checks: passed.
- test-detail.js:528 assertions /29 scenarios, including blur/login gating, removed-service selector, retry-no-success and no error decoration.
- test-bottom-sheet.js:73 mocked timer/gesture/CSS checks.
- Original tracked source hashes remain unchanged. Guest blur and service-example cleanup modify generated presentation only.
- Independent source checks covered the relevant revisions; this does not establish measured geometry, physical scroll, capture, text selection, touch or accessibility behavior.
- Browser execution previously denied with socket() Operation not permitted. No bypass or new browser attempt. Actual browser QA remains NOT RUN.

## Latest reference-layout presentation

Both user reference images were directly inspected before implementation. Schedule and public area now use separate lavender information cards, left calendar/pin tiles, small gray labels and bold values. Existing fixture schedule/publicArea are unchanged. The existing exact privacy notice moves below the region value, with the same !privateVisible condition; no new location detail is exposed. Remaining age/deadline/private rows and all controls keep their prior conditions.

Status remains the first noninteractive pill; the following category pill uses categoryBadge(f.category). Its16 SVG mappings and asset bytes are copied from the approved latest home source index.html:134–149, recorded in category-icon-provenance.json and hash-tested. No screenshot palette icon or emoji is substituted. Full relative asset paths support standalone/connected data-URI packaging. The category and region reference copy does not override fixture values.

The layout, SVG mapping and CSS are source/static-tested only. Actual pixel correspondence, wrapping and card geometry remain unverified because browser access is denied.

## Home/browse tone refinement

All three supplied home, browse and current-detail screenshots were directly inspected. The latest refinement is CSS-only: condition/event/introduction outer framing and heading rules are removed; qualification/deadline compact boxes become borderless full-width information rows; the event icon's duplicate outline is removed. Existing lavender date/location cards, profile glass, CTA, status/category pills and SVG mappings remain unchanged. No font family, typography token or global color token changes were made.

`tone-preservation.json` records pre-change SHA-256 for detail.js, detail-model.js, index.html, shared/tokens.css, shared/bottom-sheet.js and shared/drag-scroll.js. Tests verify those files are identical, preserving all29 scenarios, product controls, guest blur, error-only service review and gestures. Pixel spacing/wrapping remains unverified; screenshots establish the styling reference rather than proof of generated visual output.

## Section-boundary correction

After feedback that the open sections were insufficiently distinguished, only event/introduction section boundaries receive a 1px #DDD7E7 top divider, 24px margin above and 20px padding below. Conditions→event→introduction are consistently separated; if event is absent, introduction directly separates from conditions. No nested outer containers are restored. Headings, feature cards, profile, CTA, pills and all interactions/data remain unchanged. CSS/source testing only; actual rendered contrast and spacing remain unverified.

## Restrained outer-boundary compromise

The latest explicit approval restores one neutral #E7E3ED 1px border around each condition/event/introduction section, radius16px, padding16px (14px below340px), margin-top20px. This full border overrides the previous standalone top separator, so there is no doubled divider. Interior schedule/location cards keep their icon-tile/label/value geometry but lose their borders and use a quieter #fcfbfe background. Qualification/deadline remain borderless information rows; profile glass, category pills, purple icon/CTA emphasis and typography are untouched.

This remains CSS-only. The pre-recorded renderer/model/template/tokens/gesture hashes must match, and all29 controls remain unchanged. 561 detail checks and73 sheet/drag checks pass. Without browser rendering, no claim is made that the result is objectively better, pixel-perfect or visually validated.

## Latest reference composition with reduced color

The supplied image image(20261012-121349).png was directly viewed. CSS retains the large-section composition and restores neutral #E5E7EB heading dividers, using the same neutral color for outer borders. Date/region and the two lower information cells use borderless #F9FAFB surfaces; icon-tile background becomes #F3F4F6 while the existing purple icons remain. The two lower cells contain only the existing qualification and recruitment deadline fields. No companion-count field, reassuring privacy claim, women-only label, photo or reference-specific date/location is introduced.

All product HTML/JS/model/gesture/token files are unchanged; this is CSS-only. Status/category pills, main CTA, profile glass, guest blur, failure-only service example and all29 state conditions remain. 561 detail and73 sheet/drag checks pass. Actual rendered spacing, legibility and visual preference remain unverified.

## Confirmed location and owner-action presentation

Both supplied location references were directly viewed. The private-location renderer retains the same privateLocation condition and original place/address/meeting values. Existing pin icon, strong place name and secondary-gray address are placed in a lightly purple callout. Meeting instructions appear after a divider only when the existing meeting string is nonempty. The source label remains as an accessible definition term. No heart, reassurance text, new location or anonymous/third-party exposure is introduced.

The explicitly approved reject presentation becomes a44×44px native sibling button with a24px visible circle and12px X at the applicant-card upper right. aria-label/title remain ‘신청 거절’, action/confirmation and !appointment visibility remain. Profile width reserves44px so its hit target is separate. The further-approved delete action moves from the applicant section to a standalone footer row after edit/recruitment controls, using the same !appointment condition and confirmation handler. It uses white outline, error#BD4465 text/trash and10px separation; no new deletion operation is introduced.

Button metrics are role-scoped. Current S02 ordinary actions retain min44px/.82440475rem/10px13px padding; footer actions use the approved browse-v31 observed49px/1rem/8px6px/radius15 pattern. Text/icon/profile roles are not expanded to footer buttons. Transparent1px borders align fill/outline sizing, paired buttons stretch together, and the old descendant `.detail-footer .btn+.btn` top-margin bug is replaced by a direct-child stack rule. No hard heights are used, so long text may grow. At320px, source layout uses border-box, flexible columns/min-width0 and wrap rather than fixed excess widths. This is not physical overflow testing.

Renderer source changed for these expressly approved display arrangements; the older tone-preservation list now covers only unchanged model/template/tokens/gesture files.29 semantic actions/targets/disabled conditions and confirmation flows are independently checked, allowing reject's visual text to become its accessible name and delete's relocation. Current tests:561 detail +73 sheet/drag. Browser visuals/real hit overlap/accessibility/overflow remain unverified.

## Border-straddling reject placement

The marked reference image image(20261012-123610).png was directly viewed. Only CSS placement changes: has-reject-action cards have overflow:visible and24px top margin; their existing44px button moves to top:-22px/right:-10px. The24px visible circle is centered on the nominal top edge, near the right corner. Red annotation color is not copied. Existing neutral circle/X colors, profile-width reservation, accessible label/title, !appointment visibility and confirmation remain. Delete stays at its previously approved footer location.

Source geometry reserves24px above versus22px upward hit-area extension and uses the existing17.52381px right scroll gutter for10px extension plus focus outline/offset. Cards may still be clipped when physically scrolled outside the viewport, as normal. These are source constraints, not browser overlap/hit-test proof. Tests:561 detail +73 sheet/drag; actual pointer/touch/paint validation remains NOT RUN.

## Latest approved delete disclosure relocation

The user explicitly approved moving the existing delete entry into a title-right ⋮ disclosure. It exists only for owner&&!appointment, and the original footer delete entry is removed. A hidden native delete button in the small popover uses the same action/confirmation; no new deletion policy or endpoint is introduced. The trigger is the sole newly authorized presentation control.

Escape closes only the disclosure and restores the trigger; repeated activation toggles it. Outside pointer/click does not consume the underlying target's action. State updates, scroll, touch-start outside, sheet close/open and resize clear it. Selecting delete closes the menu then opens the original confirmation using the persistent trigger for return focus. Focus uses preventScroll to avoid a scroll-close race. A connected wrapper may call YumidangDetailRender.closePostMenu(false) when hiding the iframe. While open, sheet drag is gated; outside pointer closes it before ordinary gestures continue. Menu wrapper excludes desktop drag starts.

The popover is right-aligned within the title row at160px width with a viewport-width cap; it follows the whole title row, not a single-line icon, and can flip above when below is insufficient and above fits. Layout remains source-checked only, especially at short viewports. Popup rendering/hit placement needs actual browser validation.

The earlier statement that deletion stays in the footer is superseded by this explicit approval. Floating reject placement remains unchanged. Current tests:561 detail +73 sheet/drag,29 states. Backend/model/confirmation policy remain unchanged.

## Latest floating control alignment and third-party label

Both image(20261012-125236).png and125237 were directly viewed. The reject remains a44px native hit target with a centered SVG, now16px, and a28px white circular surface with neutral border/subtle shadow. Its top:-26/right:-6 anchor places the visual center4px above the card top and16px from the right. Card top margin28px and padding-top18px reserve the target; its lower edge is18px, ending at the profile content start. The whole-profile hit target returns to full width, with its trailing label margin-left:auto and ordinary14px horizontal inset. This removes the earlier44px right-width reservation without overlapping hit rectangles in source geometry.

Only confirmedOther's returned CTA label becomes ‘이미 마감된 동행이에요’. Its disabled state, opacity, destination and private-data conditions are unchanged; confirmed participants retain the appointment CTA. The model's small authorized display-label change is recorded separately and removed from the obsolete CSS-only hash baseline. Renderer, menu and gesture implementations remain unchanged. Current tests:561 detail +73 sheet/drag. These are source/static/mocked checks, not actual visual or touch validation.

## Final v14 application notice

Explicitly requested copy replaces the existing notice with “신청 버튼을 누르면 채팅방으로 이동돼요.” and “첫 메세지 보내면 신청이 완료돼요.” separated by a literal br and centered by a notice-only text-align rule. The user-specified spelling 메세지 is preserved. The existing second-sentence strong emphasis, palette, type and !owner&&!existingChat visibility condition remain. Deleted/error early returns remain. This display-copy change does not add chat navigation or backend functionality. Reference image125619 was directly viewed. Final tests561+73; browser appearance remains unverified.

## v15 smaller error-colored corner reject

Directly inspected image130912. CSS-only change: white circle24px, centered SVG14px in existing #BD4465 error token; native hit remains44px. Anchor top:-22/right:-14 puts its center on the top boundary and8px inside the right edge, crossing the rounded corner with4px visible overflow. Full hit right overflow14px plus existing focus extent3.04762px is within the17.52381px scroll gutter. Card top margin28px and padding-top22px reserve the upper hit and separate its lower edge from profile content. Full-width profile and trailing label alignment remain unchanged. Renderer/model/sheet/desktop drag hashes are checked in v15-behavior-preservation.json. Tests567+73 over29 scenarios; actual browser clipping/appearance/touch remain unverified.

## v16 exact corner center and authorWaiting-only spacing

Viewed supplied image131550 after Library materialization. X hit stays top:-22/right:-14/44px; white24px pseudo-element left changes10→18 and14px SVG translates8px right, aligning both centers with the actual card right boundary (previously8px inset). The full circle remains within target x18..42, with right overflow12px within the17.52381px scroll gutter. Heading/card margin28→14px ONLY for key authorWaiting, via conditional applicant-heading-compact class and adjacent-card selector. The heading reserves its right44px so upward-extending target cannot cover heading text. Other states retain28px. Profile full width/alignment remain unchanged. Source margin14px was selected to approach the supplied reference; it is not a measured final screenshot gap. No action, model, private condition or gesture edits. Tests598+73; actual browser appearance/clipping unverified.

## v17 CTA wording and explicit X geometry

Viewed image133739 (ordinary applicant note, not waiting). With parent approval compact spacing covers author and authorWaiting only: card margin-top28→10 and14→10 respectively. Other states untouched. The previous waiting-only scope followed the previous explicit request; the latest reference broadens it to author. Previous SVG relied on grid alignment plus translateX8; current14px SVG is absolute left23/top15 with transform:none/margin0/padding0/display:block. Its center(30,22) equals the24px circle left18/top10 center. The existing press replica copies the whole44px button and scales that replica; it does not separately transform the SVG. No global rule overrides the explicit positions. This removes layout-baseline reliance but does not establish the prior runtime root cause without a browser. ExistingChat CTA becomes 채팅방으로 이동하기, before unavailable checks. Closed/expired/appointment unavailable fallback becomes 이미 마감된 동행이에요. Participant CTA, disabled/target and all domain state remain unchanged. Tests605+73; actual browser/press rendering unverified.

Public scene provenance: BrowseScreens1170–1183 includes completed appointments and separately tests participant;1210–1225 marks non-recruiting posts unavailable unless existing-chat precedence applies. waitingOther has no chat; completedOther is not a participant. Both hide exact location and use existing disabled CTA rules, without a new operation.
