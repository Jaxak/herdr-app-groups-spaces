# Third-party notices

Original Project Spaces contributions are licensed under Apache License 2.0
(`LICENSE-APACHE`). Third-party components retain the terms and notices below.

The Spaces toolbar and press/move/release folder and project interactions in
`main.js` are adapted from [Herdr Space Folders](https://github.com/jankeesvw/herdr-space-folders),
commit `63a78b20d5ed30d57166a3c7165a6eb558c3ef84`.

Herdr Space Folders additions are Copyright (c) 2026 Jankees van Woezik,
licensed under MIT; the complete notice is in `LICENSE-space-folders`.
The upstream mod derives from Herdr's spaces mod (0.1.10), licensed under
Apache License 2.0; the complete license is in `LICENSE-APACHE`.

This adaptation keeps Project Spaces' existing groups, shared state,
settings and nested terminals, and delegates project menus to Herdr. It adds native creation buttons and drag feedback,
uses stable full IDs and a movement threshold, validates current targets,
limits native space reordering to one machine, and supports cancellation.
It does not include upstream Git queries, shell execution, filesystem persistence,
automatic folder rules or machine grouping.

Referenced icons under `mods/workspace-chrome/` are supplied by Herdr and are
not redistributed by this mod.
