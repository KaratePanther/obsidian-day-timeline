# Day Timeline

An Obsidian sidebar plugin that renders your daily note's tasks as a visual day timeline, with drag-and-drop scheduling between an unscheduled pool and timed slots.

## What it does

- Adds a **Day Timeline** sidebar view (right pane) plus a ribbon icon (`calendar-clock`) and an **Open Day Timeline** command.
- Reads the **active daily note** (`daily notes/YYYY-MM-DD.md`) and parses tasks from the `Highlight`, `Key Tasks`, and `Admin / Optional` sections (parsing stops at the `Notes` heading).
- Tasks annotated with `@HH:MM-HH:MM` render as **scheduled blocks** on the timeline; unannotated tasks sit in an **unscheduled pool**.
- Draws a live **"now" line** that updates every minute.
- **Click a block** to jump the editor cursor to that task's line.
- Refreshes automatically on file edits (debounced) and when the active note changes.

## Scheduling model

- A task can hold **multiple time slots** (e.g. `@09:00-10:00 @14:00-14:30`), each rendered as its own block.
- Schedule annotations are written **before any `#tag`** on the line, so tags stay at the end.
- The serializer supports add / update / remove of individual slots by index, preserving the rest of the line.

## How to use

1. Open a daily note (`daily notes/YYYY-MM-DD.md`).
2. Open the timeline (ribbon icon or command palette → *Open Day Timeline*).
3. Drag a task from the pool onto the timeline to schedule it; drag a block to move it; drag its edge to resize.
4. Right-click a block for the context menu; edits write `@HH:MM-HH:MM` back into the markdown.

## Recent work

- **Editor drag extension + cross-panel scheduling** — drag between the markdown editor and the timeline view (CodeMirror editor extension).
- **Multi-slot scheduling, context menu, drag ghost preview** — multiple time slots per task, right-click actions, and a live ghost while dragging.
- **Initial MVP** — day timeline sidebar, daily-note parsing, now line, click-to-navigate.

## Build

```bash
npm install
npm run build   # esbuild → main.js
```

Outputs `main.js` alongside `manifest.json` and `styles.css` for Obsidian to load.
