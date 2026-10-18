# Working directory

This is the standalone `GM7595/auto-timetable` repository for タイテ作成ツール. Run project commands at this repository root. Do not initialize another Git repository inside it or modify neighboring projects.

The project was extracted from the hackathon repository with its own commit history. Do not copy application source back into that shared repository. Never commit real `.env*`, `.dev.vars*`, dependency folders, generated output, or local database state.

# Existing Sites publication

The existing owner-local Sites publishing checkout remains at `../DevDay Community Hackathon 2026-10-18/cue/`. It is independent of this repository. Preserve its Git metadata, hosted Site identity, secrets, and runtime data. If this local layout changes, locate the existing publishing checkout rather than creating a replacement Site.

For changes to the existing published website, edit source here first, then synchronize only the relevant application source into the publishing checkout and follow the Sites skill there. Do not overwrite the publishing checkout's `.openai/hosting.json` with this repository's unbound local-development manifest. Reuse the existing Site; do not create a replacement merely because this manifest omits `project_id`.
