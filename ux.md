# Disk Watch interface

Space answers which folders use the disk and how recently their contents were written. Changes compares captured sizes; Settings manages tracked data and exclusions.

The approved Scope mockup is `disk-watch-folder-activity`, revision 5. Its desktop layout gives Name the largest share, while the other columns expand with the window. Writer attribution is unavailable, so Space redistributes that column's space to Name, Size, Files and Age at 38%, 22%, 16% and 24%.

Names and sizes lead through weight. Counts stay quiet. Latest write and creation share one line with pencil and circled-plus symbols; creation keeps the smaller muted type. Edits less than a day old use sage. Missing values leave blank space. Hover text explains the symbols without permanent legend labels.

Child indentation and a shared background tint express hierarchy. The Age column shares its row's background. Floating menus use a shadow to separate them from the table. Secondary row actions live in the context menu, available by right-click, Menu or Shift+F10.

The app uses the existing warm-paper palette and system UI fonts for offline operation. No theme or web-font request is needed.

Deletion failures open a large modal for investigating the blocked path. The queued path and exact failed operation stay separate because a child or containing folder can cause the failure. The modal lists every failed queued target and the available process values in labeled rows. Values wrap and stay selectable, with Copy beside each available value and Copy report in the fixed footer. Details scroll while the title and Close action stay visible. View details reopens the same snapshot after Close. Process lookup labels distinguish file users from open handles and say when Windows cannot identify an owner. The app leaves process stopping to the user and keeps the existing queue for retry.
