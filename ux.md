# Disk Watch interface

Space answers which folders use the disk and how recently their contents were written. Changes compares captured sizes; Settings manages tracked data and exclusions.

Treemap answers which folders occupy the most space visually. Rectangle areas represent visible logical bytes from the selected scan. Muted colors distinguish sibling folders, and nested children inherit their parent's color. Colors do not imply a file category. Click a folder to zoom in and use the breadcrumb path to return. Right-click and keyboard context menus reuse the file actions from Space. Stripes identify captured smaller-file totals, which cannot be acted on individually. Large folders group their smallest entries into an expandable other-items tile. Only the largest readable folders preview children, keeping large scans responsive.

The approved Scope mockup is `disk-watch-folder-activity`, revision 5. Its desktop layout gives Name the largest share, while the other columns expand with the window. Writer attribution is unavailable, so Space redistributes that column's space to Name, Size, Files and Age at 38%, 22%, 16% and 24%.

Names and sizes lead through weight. Counts stay quiet. Latest write and creation share one line with pencil and circled-plus symbols; creation keeps the smaller muted type. Edits less than a day old use sage. Missing values leave blank space. Hover text explains the symbols without permanent legend labels.

Child indentation and a shared background tint express hierarchy. The Age column shares its row's background. Floating menus use a shadow to separate them from the table. Secondary row actions live in the context menu, available by right-click, Menu or Shift+F10.

The app uses the existing warm-paper palette and system UI fonts for offline operation. No theme or web-font request is needed.

Deletion failures open a large modal for investigating the blocked path. The queued path and exact failed operation stay separate because a child or containing folder can cause the failure. The modal lists every failed queued target and the available process values in labeled rows. Values wrap and stay selectable, with Copy beside each available value and Copy report in the fixed footer. Details scroll while the title and Close action stay visible. View details reopens the same snapshot after Close. Process lookup labels distinguish file users from open handles and say when Windows cannot identify an owner. The app leaves process stopping to the user and keeps the existing queue for retry.

Tracked roots show their machine alongside the path. SSH setup asks for an existing SSH destination and remote root, then the worker resolves and records the root. Remote file actions copy the displayed path instead of opening a local file browser. Saved history stays browseable without connecting to its machine. Capacity is labeled as a saved observation, with its observation time in Settings and hover details.

Unix node actions retain encoded native components independently of escaped display labels. Hide offers containing folders from the selected node without converting its label back into an operational path. Editing text discards that selection so the worker resolves the new typed path. Remote exclusions use typed remote paths, while row context actions keep the node identity.

Partial scans remain browseable in Space and Treemap, with partial coverage marked in the scan picker and history. Changes offers only scans with complete coverage. Windows elevation guidance appears only for local Windows scans, and NTFS metadata controls appear only for Windows roots.

Unix cleanup starts disabled. Settings explains the owner-controlled, writable, quiescent-tree requirement and enables native validation for that root. Uncertain deletion receipts stay visible with Check deletion status. The app never replays a deletion from that control. A fresh complete scan after an uncertain operation permits deliberate restaging. Windows deletion diagnostics retain their process lookup details; Unix failures name their native error domain and say when process lookup is unavailable.
