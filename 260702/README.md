# Reasoning Foundry

Local-first human-in-the-loop data generator for static reasoning datasets.

The original Spatial Annotation Foundry now lives under the `SAF` subdomain route. The landing route is `TREE`, which is the only place that links across subdomains.

## Run

```bash
python3 -m http.server 5173
```

Then open:

```text
http://127.0.0.1:5173
```

The app has no package install step. It stores the current queue and annotations in `localStorage`.

## Subdomains

- `#tree` / `TREE`: 3 x 4 domain map and navigation hub.
- Geometry row set: `#saf` Spatial Annotation Foundry, `#bi` Billiards, `#mp` Mirror Pattern, `#cc` Cube Count, `#mc` Mirror Clock, and `#ov` Overlap.
- SQL-improvement classification row set: `#vq` Visual Query, `#rc` Relation Classifier, `#cf` Condition Filter, `#tg` Table Grouping, `#pm` Predicate Mapping, and `#ca` Column Assignment.

Each non-tree subdomain exposes only the `TREE` link for cross-domain movement. `SAF` keeps settings as an internal button inside its own workflow.

## Workflow

- Open `#tree`, choose a subdomain, then work the conveyor for that subdomain.
- In `SAF`, `Belt` is the conveyor view. Look at the static scene, choose one value in the single answer input, then press `Save & Next`.
- In `SAF`, use the `Settings` button on the belt controls to open generator settings, detailed labels, solver traces, import/export tools, and PNG export.
- In 3D scenes, drag the scene to orbit, use the mouse wheel to zoom, and double-click to reset the camera.
- When a task mentions `초기카메라`, click that blue inline control to return to the default view.
- `Export & New 100` exports the current batch and immediately replaces it with a fresh 100-item batch.
- `Export & New 100` asks for Yes/No confirmation before replacing the belt.
- `Reset 100` asks for confirmation, clears the local dataset cache, and starts a fresh 100-item batch without exporting.
- Open `http://127.0.0.1:5173/#saf/settings` to jump directly to the SAF settings/data view.
- Reasoning subdomains generate 100 scaffold drafts per domain. Choose the answer, use the bottom strip to jump directly between drafts, use `Label Schema` for schema/notes, then export domain JSONL.
- On Android/iOS, the `TREE` domain shows a large warning because the annotation workflow is intended for desktop Chrome.

## What It Generates

- 3D spatial labeling: frontmost object, leftmost object, tallest object, color counts, partial occlusion counts, and nearest-to-target queries.
- Electric charge fields: net field direction, force direction, weakest field candidate, highest potential candidate, and potential sign.
- Reasoning scaffold drafts: domain-specific prompts, answer options, static visual tokens, label schema, difficulty levers, human answers, notes, and review status.

Each instance includes deterministic seed metadata, scene variables, solver traces, difficulty proxies, answer confidence, and human annotation fields. Export JSONL for dataset work and PNG for static image assets.
