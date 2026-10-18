# Working directory

This directory is the shared GitHub source for タイテ作成ツール. Run project commands here. Do not initialize a nested Git repository. Keep application changes inside this directory; do not modify sibling projects such as `../tibo-reset/`.

Stage only this project's paths, never the entire shared repository. Root README and ignore changes should be limited to documenting or isolating this project. Never commit real `.env*`, `.dev.vars*`, dependency folders, generated output, or local database state.

# Existing Sites publication

The owner-local `../cue/` directory is an independent, ignored Sites publishing checkout. It is not the shared development directory. Preserve its Git metadata, hosted Site identity, secrets, and runtime data.

For changes to the existing published website, edit shared source here first, then synchronize only the relevant application source into the publishing checkout and follow the Sites skill there. Do not overwrite the publishing checkout's `.openai/hosting.json` with this directory's unbound local-development manifest. Reuse the existing Site; do not create a replacement merely because this shared manifest omits `project_id`.
