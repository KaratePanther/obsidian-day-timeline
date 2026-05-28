# Day Timeline

An Obsidian sidebar plugin that renders your daily note's tasks and time blocks as a visual day timeline, with a focus timer and drag-and-drop scheduling.

## Features

- **Sidebar view** (right pane) + ribbon icon (`calendar-clock`) + **Open Day Timeline** command.
- Reads the **active daily note** (`daily notes/YYYY-MM-DD.md`) and renders:
  - Tasks from `Highlight`, `Key Tasks`, `Admin / Optional` (parsing stops at `Notes`).
  - Plain-bullet time blocks from a `## Schedule` section.
- **Focus timer** in the header: click the time to set minutes (1–180, persisted to `localStorage`), `▶/⏸` play/pause, `↺` reset, ascending chime on completion.
- **Unscheduled pool** (tasks + schedule blocks), resizable by dragging its handle.
- **Drag-and-drop scheduling**: drag from the pool onto the timeline to schedule; drag a block to move it; drag its top/bottom edge to resize; drag a block back to the pool to unschedule. 15-minute snapping.
- **Editor drag handles** (`⠟` gutter widget): drag a task/schedule line straight from the markdown editor onto the timeline, or reorder lines; drag a timeline block into the editor to remove its time.
- **Quick-add**: right-click empty timeline → add a Schedule block (presets `Lunch / Unwind time / Break / Exercise / Coffee`, or a custom name).
- **Now line** (updates each minute); click any block to jump the editor cursor to its line.

## Scheduling model

- Times are stored inline as `@HH:MM-HH:MM`, written **before any `#tag`** on the line.
- A task can hold **multiple slots** (e.g. `@09:00-10:00 @14:00-14:30`), each its own block.
- Add / update / remove operate on a single slot by index, preserving the rest of the line.

## Architecture

- **Source of truth: `src/main.ts`** — a single self-contained file (runtime JS in a `.ts` wrapper, `// @ts-nocheck`).
- **`main.js` is a generated build artifact** (gitignored) produced by esbuild and auto-copied to the vault plugin folder. **Do not hand-edit `main.js`** — edit `src/main.ts` and rebuild.

```bash
npm install
npm run build   # esbuild → main.js (minified) + copy to vault
npm run dev     # watch mode (sourcemap, no minify)
```
