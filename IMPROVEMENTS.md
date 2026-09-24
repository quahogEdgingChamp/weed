# Cloudline — improvement plan

Reviewed: 2026-09-23. Scope: `index.html`, `styles.css`, `app.js`, `serve.py`, `ocs.py`, README and current data shape. Source-based audit; Chromium failed during inspection, so visual proposals are not screenshot-verified. No app, personal-data or system changes were retained.

## Direction

Make Cloudline a **personal collection journal and purchase planner**: quickly record a product, remember the experience, compare candidates, and decide what to buy again. Keep plain HTML/CSS/JS + Python; the existing scale does not justify a framework migration. Professionalism comes from clear hierarchy, useful interactions and trustworthy saving.

Already useful: CRUD, favorites, search/type/sort, summary metrics, mobile table-to-card layout, OCS lookup, shopping-to-collection flow, JSON import/export, local persistence and server polling. Preserve these. Biggest gaps: no product detail view; saved experience fields are mostly hidden; favorites cannot be filtered; long undifferentiated form; weak recovery/undo; ambiguous sync and destructive actions.

Effort below is relative: **S** = localized UI/logic; **M** = several components or data changes; **L** = cross-cutting storage/workflow work. Priorities: **P0** trust, **P1** everyday usefulness, **P2** enrichment, **P3** optional expansion.

## 1. Fix trust before adding complexity

| Priority | Observed issue | Concrete change / acceptance condition | Effort |
|---|---|---|---|
| P0 | `resetData()` says “Clear local data” but calls `persist()`, which can clear the shared server file. | Label it “Clear collection and shopping list”; explain scope; offer export before confirmation. If browser-only clearing is needed, make it a separate action that cannot queue a server save. | S |
| P0 | `save_state()` overwrites the entire dataset without checking the client's revision. Two devices can overwrite each other. | Send `baseRevision` with writes; compare under `state_lock`; return 409 on mismatch. Keep local edits pending, fetch the newer snapshot, resolve conflicts before retry. Use opaque string revisions: nanosecond mtimes exceed JS safe-integer precision. | L |
| P0 | `pollServerState()` can run during the 300 ms save debounce; a newer server snapshot can replace pending edits. | Track dirty state from the first mutation; never apply incoming state over dirty edits. Clear dirty state only for the acknowledged write generation. Test edits made while a request is in flight. | M |
| P0 | A polling failure sets `syncEnabled=false`, stopping subsequent polls; a failed save has no automatic retry. Startup fetch can also arrive after a user begins editing. | Explicit loading/saved/pending/offline/error states; bounded retry with backoff; reconnect on `online`; manual Retry action. Reconcile edits made before initial hydration. Persist pending-write metadata across reloads. | L |
| P0 | Empty server + populated browser automatically uploads browser contents; stale devices can restore intentionally cleared data. | Distinguish first initialization from a deliberately empty dataset using a persisted dataset ID/revision. Ask which copy to use only when migration or recovery is actually ambiguous. | M |
| P0 | `writeLocal()` logs storage failures but the UI can still report “Saved.” | Return a result; retain dirty state; show a persistent warning and export/retry actions when storage fails. Never imply durability until a storage destination acknowledges the write. | M |
| P0 | Import replaces both lists immediately; entry validation is limited, wishlist validation weaker, server validates only top-level arrays. | Validate schema, types, ranges, IDs, string lengths and safe URL schemes at every input boundary. Show import preview, skipped-row errors, and Merge/Replace choices; snapshot before replacement. Invalid files must leave existing data intact. | M |
| P1 | Static server serves from the repository root using `SimpleHTTPRequestHandler`. | Explicitly allow public assets and intended API routes; prevent access to `.git`, Python files, backups and directory listings. Keep the current access model; reassess authentication before any public hosting. | M |

## 2. Visual and navigation redesign

| Area | Proposed change | Why / implementation |
|---|---|---|
| Hierarchy | Add a real page heading, short description and primary “Add entry” action above metrics; group search/filter/sort directly with the collection. | Current page starts with stats and utilities; establish a clear task before showing data. Touch `index.html`, layout tokens and toolbar CSS. |
| Navigation | Collection · Favorites · Shopping list, with counts. Keep compact tabs for three sections; consider desktop sidebar only when Journal/Insights become real destinations. | Favorites should be immediately useful; avoid consuming horizontal space just for decoration. Preserve navigation state and current filters when returning. |
| Visual system | Prototype warm off-white canvas, white panels, forest-green actions, muted sage accents, charcoal text; keep a dark option using the same semantic tokens. | Starting light palette: canvas `#F6F7F4`, surface `#FFFFFF`, text `#202C27`, muted `#59665F`, accent `#245C43`, border `#DDE3DD`. Verify actual contrast; these are proposals. Respect OS preference and persist manual choice. |
| Typography/spacing | System font; ~30 px page heading, 18 px section heading, 14–16 px body; 4/8/12/16/24/32 spacing scale; consistent 8–12 px radii. | Improve rhythm and hierarchy without downloaded fonts, ornamental gradients or oversized cards. Use tabular numerals for prices/potency. |
| Collection | Prioritize product/brand, category, potency, rating, price; place long terpene lists in details. Use restrained category badges; make the product name a real detail button. | Eight columns compete on desktop; phone cards repeat many labels. On phones show name, brand, 2–3 key facts and clearly labeled actions; expand for more. |
| Metrics | Keep whole-collection totals stable; label chart scope separately as “Current results.” Add result count and visible filter chips with Clear all. | Today all stats change with search, making “Total spend” ambiguous. Distinguish all-time totals from filtered results. |
| Empty states | Separate first-use, no search matches, no favorites and empty shopping list; give each one relevant action. | “Add first entry,” “Clear filters,” “Browse collection,” or “Paste OCS link.” Current generic empty-row text mixes different problems. |
| Form | Sections: Product, Potency & purchase, Experience. Keep name/type immediately visible; collapse genuinely optional details. | Reduce perceived workload. Preserve draft on accidental close; warn only if dirty; prefill today's purchase date for new entries. Keep save/cancel reachable. |
| Shopping | Prominent URL input, clear loading state, inline retry, optional manual entry; stronger image/name/price hierarchy. | Change “Log it” to “Log purchase.” Show price freshness and source rather than implying looked-up price is permanently current. |
| Feedback | Toast for successful minor actions; persistent inline errors for failed saves/lookups; buttons indicate pending work. | Never require a user to catch a disappearing message to discover data was not saved. Avoid routine “loaded from server” toasts. |

## 3. High-value new features and interactions

| Priority | Feature | Specific interaction / useful outcome | Data / effort |
|---|---|---|---|
| P1 | **Product detail panel** | Click name → readable summary, full terpene breakdown, effects, notes, purchase date/vendor, source link, favorite/edit actions. Escape closes and returns focus. | Existing fields; M. Highest immediate value: makes already-entered information accessible. |
| P1 | **Favorites + useful filters** | One-click favorites; multi-select type, brand, rating threshold, date range, price range; removable active-filter chips; result count. | Existing fields; M. Start favorites/brand before building every filter. |
| P1 | **Quick add, enrich later** | Minimal name/type form; optional brand, price and rating; “More details” expansion. OCS link can create a draft directly in either collection or shopping. | Reuse existing lookup and drawer; M. Never require a shopping-list detour for a purchased item. |
| P1 | **Undo** | Remove item → “Removed … · Undo” action; restore exact record and position. Retain recently deleted records beyond the toast window. | Short-lived client undo initially; persisted trash later; M. Delay permanent removal or retain tombstones compatible with sync. |
| P1 | **Duplicate / buy again** | Product action creates an editable new purchase with product facts copied, date reset to today and prior rating/experience cleared. | Existing record model; S. Distinguish product facts from purchase-specific facts. |
| P1 | **Better shopping workflow** | Set priority and target price; sort by priority/cost/date; mark purchased → prefilled form; cancel preserves shopping item; save removes it. | `priority`, `targetPrice`; M. Show estimated basket total and unknown-price count. |
| P1 | **Duplicate detection** | Pasting an already-saved canonical OCS URL offers “View existing” or “Add another”; manual duplicates show a nonblocking hint. | Normalize URL/handle; S–M. Repeat purchases are legitimate, so never silently discard them. |
| P2 | **Compare products** | Select 2–4 entries → compare price/amount, rating, potency with units, terpenes and personal notes; highlight missing data honestly. | Existing fields + normalized units; M. Mobile comparison uses stacked sections, not an unusable wide table. |
| P2 | **Experience journal** | “Record experience” from product details → date, optional amount/unit, subjective effect tags, flavor, rating and notes; timeline of sessions. | Separate `experiences[]` referencing stable product IDs; L. Preserve private journal data in exports; avoid treatment/dosing claims. |
| P2 | **Inventory status** | Mark unopened / in use / finished; optionally record opening date and remaining amount; filter active inventory. | `status`, `openedAt`, optional remaining quantity/unit; M. Do not infer consumption from elapsed time. |
| P2 | **Interactive insights** | Click a category bar to filter; click a ranked product to inspect. Add monthly spend, favorites by brand and rating distribution. | Existing fields; M. Provide textual values/keyboard equivalents. Label missing dates/prices and incomplete coverage. |
| P2 | **Personal repurchase list** | Explicit “Would buy again” choice; view favorite/high-rated products alongside repeat purchases and actual prices paid. | Nullable `wouldRepurchase`; M. Transparent sorting rules first; AI recommendations unnecessary. |
| P2 | **Budget planning** | User sets optional monthly budget → recorded spend + remaining amount; show proposed shopping total separately. | Preference + dated purchases; M. Undated entries excluded with visible count; no invented spending forecast. |
| P2 | **Portable views** | Persist sort/filter/theme; URL parameters for current view/search; named saved filters such as “Favorites under $40.” | Preferences separate from collection data; M. Sharing a view URL must not imply sharing private records. |
| P3 | **Installable offline app** | Home-screen installation; cached shell; offline editing with visible pending count and safe reconciliation. | Manifest/service worker + durable outbox; L. Only after conflict handling; never cache stale API responses as current truth. |
| P3 | **Photos / receipt attachments** | Add product photo or receipt; thumbnail in details; remove/export attachments. | File storage, validation, size limits, backup/export plan; L. Avoid base64 images in localStorage or the shared JSON file. |

### Additional features worth considering

| Priority | Feature | Specific interaction / useful outcome | Data / effort |
|---|---|---|---|
| P1 | **Backup recovery** | Browse dated snapshots, preview changes and restore after an accidental import or deletion; create a recovery snapshot before restoring. | Versioned server snapshots with bounded retention; M. Store outside publicly served assets; restore through revision checks. Browser-only copies do not protect against disk loss. |
| P1 | **Custom tags** | Create labels such as “great flavor,” “harsh,” “weekend” or “wouldn’t repurchase”; autocomplete existing tags; filter by multiple tags; rename/merge tags. | `tags[]`, normalized for duplicate detection while preserving display labels; M. Distinguish personal tags from source-provided product facts. |
| P2 | **Purchase history per product** | One product detail page lists every purchase, vendor, price and linked experience; “Buy again” adds a purchase without duplicating the product identity. | Separate `products[]` and `purchases[]` with stable references; L. Migrate existing entries losslessly; suggest duplicate merges for review, never merge by name alone. |
| P2 | **Value comparisons** | Show price per gram or unit beside total price; compare equivalent products and historical prices paid. | Structured quantity/unit and explicit tax basis; M. Convert compatible units only; exclude missing/zero quantities and keep unlike categories separate. |
| P2 | **Batch tracking** | Record lot/batch per purchase; compare actual potency, terpenes and experience between batches of the same product. | Optional batch ID and purchase-level measured values; M after purchase history. Preserve provenance: label measurement versus storefront estimate. |
| P2 | **Shopping notes** | Record why an item is interesting, preferred store and alternatives; carry useful context into purchase details when bought. | `shoppingNote`, `preferredVendor`, optional alternative-product references; S–M. Keep shopping intent separate from post-purchase experience. |
| P2 | **Bulk editing** | Select entries to tag, categorize, export or archive; show selection count and preview affected records. | Multi-selection + batch mutation/undo; M. Make “select visible” versus “select all matching” explicit; archived entries remain recoverable. |
| P2 | **Privacy mode** | One toggle temporarily hides spending and personal notes across cards, details, charts and shopping totals; clearly indicate when active. | Display preference; S–M. Concealment for screen sharing, not authentication; exports still contain full data unless explicitly redacted. |
| P3 | **Explainable discovery** | Surface candidates using the user's ratings, tags and recorded terpene similarities; explain each match and allow dismissal. | Transparent local ranking; M after enough usable history. Show evidence and missing data; no invented catalog, promised effects or AI dependency. |
| P3 | **Optional reminders** | User schedules a prompt to rate a purchase or review shopping items; snooze, dismiss and disable individually. | Due dates/preferences; M for in-app reminders, L for reliable background delivery. Start in-app; request notification permission only when enabled and describe delivery limits. |

**Strongest additions:** purchase history, custom tags, value comparisons and backup recovery. Implement tags/recovery early; establish purchase identity and structured units before adding batch comparisons or discovery.

## 4. Interaction and accessibility rules

- **Drawer:** existing `aria-modal` does not enforce modality. Trap Tab/Shift+Tab, make background inert, remember opener, restore focus on close; inspect dirty state before dismissal. Consider native `<dialog>` with tested focus handling.
- **Menu:** current `role="menu"` needs managed keyboard behavior; either implement arrow-key/Escape/focus semantics or use a simpler disclosure with ordinary buttons. Make Import keyboard-activatable instead of relying on a focusable label alone.
- **Controls:** consistent ~44 px touch targets (mobile row buttons are currently 44×40); descriptive accessible names; favorite buttons expose `aria-pressed`; avoid hover-only actions. Keep visible focus rings and reduced-motion support already present.
- **Search:** optional `/` shortcut only outside editable fields; Escape clears search only when no dialog/menu is open. Announce result count politely; do not announce every rebuilt row. Debounce only if collection size warrants it.
- **Validation:** inline field errors linked via `aria-describedby`; preserve entered values; focus first invalid field. Validate whitespace-only product names, numeric bounds and dates in logic as well as HTML.
- **Progressive disclosure:** detail view for reading, form for editing; do not force users to enter edit mode to read notes. Keep one primary action per panel.
- **Units:** percentages and milligrams are distinct. Add explicit potency units before expanding edible tracking; OCS ranges are estimates, not measured exact values. Do not average incompatible categories/units.
- **State persistence:** browser Back should restore meaningful section/filter state; opening and closing a detail panel should preserve scroll position. Sorting must consistently place missing values last.

## 5. Implementation shape

| File / area | Suggested work |
|---|---|
| `index.html` | Page headings, favorites control, result count/filter controls, detail panel, sectional form, clear empty states. Retain semantic controls and existing IDs where practical. |
| `styles.css` | Refactor semantic tokens; hierarchy/spacing; desktop table + compact mobile cards; theme support; focus/error/disabled/pending states. Avoid layering a second complete override stylesheet. |
| `app.js` | Centralize filter/view state; separate detail/read and edit modes; undo/drafts; explicit save state machine. Split into small files only as responsibilities grow; keep direct `file://` compatibility if still promised by README. |
| `serve.py` | Revision preconditions, durable revision identity, strict schema validation, safe asset routing, consistent JSON errors. Preserve atomic replacement and locking. Reject negative body lengths before reading. |
| `ocs.py` | Retain fixed-host lookup and bounded fetches; normalize deduplication key; preserve units/ranges; capture lookup timestamp. Recheck current OCS behavior before implementing variants or refresh. |
| Data model | Add explicit schema version + migrations before journal/inventory expansion. Back up before migration. Initially keep purchases as entries; separate product identity from purchases only when repeat purchases/journaling justify it. |
| Tests | Focus on data integrity and real workflows; use temporary data and an isolated browser profile, never live `weed_chart.json`. No snapshot-only tests for decorative CSS. |

## 6. Delivery sequence and definition of done

1. **Trust foundation:** honest clear/save messages; dirty tracking and retries; revision conflict protection; import validation/preview; recoverable snapshots. Verify two clients cannot silently overwrite edits, an empty server cannot resurrect stale data, and a restore preserves a way back.
2. **Professional UI:** heading/action hierarchy, coherent tokens, favorites filter, result counts, compact mobile presentation, drawer/menu accessibility. Verify 360/390/768/1440 px, long names, empty lists, keyboard-only use, reduced motion and no horizontal overflow.
3. **Useful interaction:** detail panel, quick add, draft preservation, undo, duplicate/buy-again, custom tags, shopping notes/priority and duplicate detection. Verify add → inspect → edit → favorite → filter → delete → undo, plus lookup/manual add → purchase → cancel/save. Add bulk editing and privacy mode as collection use warrants.
4. **Personal insight:** purchase history, structured quantities/value comparisons, batches, inventory, journal, interactive charts, optional budget. Introduce migrations with fixtures from older exports; preserve fields and record relationships through export/import round trips.
5. **Optional expansion:** offline installation/photos only after reliable synchronization and backup coverage; explainable discovery after sufficient history; reminders when explicitly enabled. Avoid accounts, social feeds, a framework rewrite or AI features until a concrete use case requires them.

**First feature bundle if time is limited:** product details + favorites filter + quick add + undo, paired with clear scope labels and keyboard-safe dialogs. These unlock existing data and remove friction without requiring new infrastructure.
