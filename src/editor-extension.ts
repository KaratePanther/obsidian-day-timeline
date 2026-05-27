import { Extension } from "@codemirror/state";
import {
  EditorView,
  ViewPlugin,
  ViewUpdate,
  Decoration,
  DecorationSet,
  WidgetType,
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { yToTime, DEFAULT_DURATION } from "./timeline-renderer";

const TASK_RE = /^- \[[ x]\]\s+/;
const SUBTASK_RE = /^\t+- \[[ x]\]\s+/;

class DragHandleWidget extends WidgetType {
  constructor(readonly line: number) {
    super();
  }

  eq(other: DragHandleWidget): boolean {
    return this.line === other.line;
  }

  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "day-timeline-editor-handle";
    el.draggable = true;
    el.dataset.line = String(this.line);
    el.textContent = "⠿";
    return el;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function getTaskEndLine(
  doc: { lines: number; line: (n: number) => { text: string } },
  startLine: number
): number {
  for (let i = startLine + 1; i <= doc.lines; i++) {
    if (!SUBTASK_RE.test(doc.line(i).text)) return i - 1;
  }
  return doc.lines;
}

function findTaskLines(
  doc: { lines: number; line: (n: number) => { text: string } }
): number[] {
  const result: number[] = [];
  for (let i = 1; i <= doc.lines; i++) {
    if (TASK_RE.test(doc.line(i).text)) result.push(i);
  }
  return result;
}

const editorDragPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    private view: EditorView;
    private dropIndicator: HTMLElement | null = null;
    private dragSourceLine: number | null = null;
    private dragGhost: HTMLElement | null = null;
    private boundHandlers: {
      type: string;
      handler: EventListener;
      capture: boolean;
    }[] = [];

    constructor(view: EditorView) {
      this.view = view;
      this.decorations = this.buildDecorations(view);
      this.attachListeners();
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = this.buildDecorations(update.view);
      }
    }

    destroy() {
      for (const { type, handler, capture } of this.boundHandlers) {
        this.view.dom.removeEventListener(type, handler, capture);
      }
      this.cleanup();
    }

    buildDecorations(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      const doc = view.state.doc;
      for (let i = 1; i <= doc.lines; i++) {
        const line = doc.line(i);
        if (TASK_RE.test(line.text)) {
          builder.add(
            line.from,
            line.from,
            Decoration.widget({ widget: new DragHandleWidget(i), side: -1 })
          );
        }
      }
      return builder.finish();
    }

    private listen(
      type: string,
      handler: (e: Event) => void,
      capture = false
    ) {
      this.view.dom.addEventListener(type, handler, capture);
      this.boundHandlers.push({ type, handler, capture });
    }

    private attachListeners() {
      this.listen("dragstart", (e) => this.onDragStart(e as DragEvent));
      this.listen(
        "dragover",
        (e) => this.onDragOver(e as DragEvent),
        true
      );
      this.listen("drop", (e) => this.onDrop(e as DragEvent), true);
      this.listen("dragleave", (e) => this.onDragLeave(e as DragEvent));
      this.listen("dragend", () => this.onDragEnd());
    }

    private onDragStart(e: DragEvent) {
      const target = e.target as HTMLElement;
      if (!target.classList?.contains("day-timeline-editor-handle")) return;
      if (!e.dataTransfer) return;

      const lineNum = parseInt(target.dataset.line ?? "0");
      if (!lineNum) return;

      const doc = this.view.state.doc;
      if (lineNum > doc.lines) return;

      const endLine = getTaskEndLine(doc, lineNum);
      this.dragSourceLine = lineNum;

      e.dataTransfer.setData(
        "application/day-timeline-editor",
        JSON.stringify({ lineStart: lineNum - 1, startLine: lineNum, endLine })
      );
      e.dataTransfer.setData("text/plain", "");
      e.dataTransfer.effectAllowed = "move";

      const lineText = doc
        .line(lineNum)
        .text.replace(/^- \[[ x]\]\s+/, "")
        .replace(/@\d{2}:\d{2}-\d{2}:\d{2}/g, "")
        .replace(/#[\w-]+/g, "")
        .trim();

      const slotsEl = document.querySelector(".day-timeline-slots");
      const ghostWidth = slotsEl ? slotsEl.clientWidth - 8 : 150;

      const ghost = document.createElement("div");
      ghost.className = "task-block";
      ghost.style.cssText = `
        position: fixed; top: -1000px; left: -1000px;
        width: ${ghostWidth}px; height: 60px;
        background: var(--interactive-accent);
        border-radius: 4px; padding: 4px 6px;
        opacity: 0.85; pointer-events: none;
        box-shadow: 0 2px 8px rgba(0,0,0,0.25);
      `;
      const textEl = document.createElement("span");
      textEl.className = "task-block-text";
      textEl.textContent = lineText.slice(0, 40) || "Task";
      ghost.appendChild(textEl);

      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 4, 0);
      this.dragGhost = ghost;

      target.classList.add("is-dragging");
    }

    private onDragOver(e: DragEvent) {
      if (!e.dataTransfer) return;
      const types = Array.from(e.dataTransfer.types);
      const isEditorDrag = types.includes("application/day-timeline-editor");
      const isBlockDrag = types.includes("application/day-timeline-block");
      if (!isEditorDrag && !isBlockDrag) return;

      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";

      if (isBlockDrag) return;

      const slotsEl = document.querySelector(
        ".day-timeline-slots"
      ) as HTMLElement | null;
      if (slotsEl) {
        const slotsRect = slotsEl.getBoundingClientRect();
        const ghostWidth = slotsEl.clientWidth - 8;
        const threshold = slotsRect.left - ghostWidth / 2;
        if (e.clientX > threshold) {
          if (this.dropIndicator)
            this.dropIndicator.style.display = "none";
          return;
        }
      }

      const doc = this.view.state.doc;
      const taskLines = findTaskLines(doc);
      if (taskLines.length === 0) return;

      const insertionPoints: { line: number; y: number }[] = [];

      for (const tl of taskLines) {
        const coords = this.view.coordsAtPos(doc.line(tl).from);
        if (coords) insertionPoints.push({ line: tl, y: coords.top });
      }

      const lastTask = taskLines[taskLines.length - 1];
      const lastEnd = getTaskEndLine(doc, lastTask);
      if (lastEnd < doc.lines) {
        const coords = this.view.coordsAtPos(doc.line(lastEnd + 1).from);
        if (coords)
          insertionPoints.push({ line: lastEnd + 1, y: coords.top });
      } else {
        const coords = this.view.coordsAtPos(doc.line(lastEnd).to);
        if (coords)
          insertionPoints.push({ line: lastEnd + 1, y: coords.bottom });
      }

      if (insertionPoints.length === 0) return;

      let closest = insertionPoints[0];
      let minDist = Math.abs(e.clientY - closest.y);
      for (const ip of insertionPoints) {
        const dist = Math.abs(e.clientY - ip.y);
        if (dist < minDist) {
          minDist = dist;
          closest = ip;
        }
      }

      if (this.dragSourceLine !== null) {
        const srcEnd = getTaskEndLine(doc, this.dragSourceLine);
        if (
          closest.line >= this.dragSourceLine &&
          closest.line <= srcEnd + 1
        ) {
          if (this.dropIndicator)
            this.dropIndicator.style.display = "none";
          return;
        }
      }

      if (!this.dropIndicator) {
        this.dropIndicator = document.createElement("div");
        this.dropIndicator.className = "day-timeline-drop-indicator";
        document.body.appendChild(this.dropIndicator);
      }

      const contentRect = this.view.contentDOM.getBoundingClientRect();
      this.dropIndicator.style.display = "";
      this.dropIndicator.style.top = `${closest.y}px`;
      this.dropIndicator.style.left = `${contentRect.left}px`;
      this.dropIndicator.style.width = `${contentRect.width}px`;
      this.dropIndicator.dataset.insertBefore = String(closest.line);
    }

    private onDrop(e: DragEvent) {
      if (!e.dataTransfer) return;
      const types = Array.from(e.dataTransfer.types);
      const isEditorDrag = types.includes("application/day-timeline-editor");
      const isBlockDrag = types.includes("application/day-timeline-block");
      if (!isEditorDrag && !isBlockDrag) return;

      e.preventDefault();
      e.stopPropagation();

      if (isBlockDrag) {
        this.handleUnschedule(e);
        return;
      }

      const raw = e.dataTransfer.getData("application/day-timeline-editor");
      if (!raw) {
        this.cleanup();
        return;
      }

      const { startLine, endLine } = JSON.parse(raw);

      if (this.checkScheduleNearSidebar(e, startLine)) return;

      const insertBeforeStr = this.dropIndicator?.dataset.insertBefore;

      this.cleanup();

      if (!insertBeforeStr) return;
      const insertBefore = parseInt(insertBeforeStr);
      if (insertBefore >= startLine && insertBefore <= endLine + 1) return;

      const doc = this.view.state.doc;
      const lines: string[] = [];
      for (let i = 1; i <= doc.lines; i++) {
        lines.push(doc.line(i).text);
      }

      const srcIdx = startLine - 1;
      const count = endLine - startLine + 1;
      const sourceLines = lines.splice(srcIdx, count);

      let insertIdx = insertBefore - 1;
      if (insertBefore > endLine) insertIdx -= count;

      lines.splice(insertIdx, 0, ...sourceLines);

      const newContent = lines.join("\n");
      let charPos = 0;
      for (let i = 0; i < insertIdx; i++) {
        charPos += lines[i].length + 1;
      }

      this.view.dispatch({
        changes: { from: 0, to: doc.length, insert: newContent },
        effects: EditorView.scrollIntoView(charPos, { y: "nearest" }),
      });
    }

    private checkScheduleNearSidebar(
      e: DragEvent,
      startLine: number
    ): boolean {
      const containerEl = document.querySelector(
        ".day-timeline-container"
      ) as HTMLElement | null;
      const slotsEl = document.querySelector(
        ".day-timeline-slots"
      ) as HTMLElement | null;
      if (!containerEl || !slotsEl) return false;

      const sidebarLeft = containerEl.getBoundingClientRect().left;
      const ghostWidth = slotsEl.clientWidth - 8;
      const threshold = sidebarLeft - ghostWidth * 0.5 + 4;

      if (e.clientX <= threshold) return false;

      const slotsRect = slotsEl.getBoundingClientRect();
      const rawY = e.clientY - slotsRect.top;
      const dropTime = yToTime(Math.max(0, rawY));
      const endMinutes =
        dropTime.hour * 60 + dropTime.minute + DEFAULT_DURATION;
      const endHour = Math.floor(endMinutes / 60);
      const endMinute = endMinutes % 60;

      const pad = (n: number) => String(n).padStart(2, "0");
      const annotation = `@${pad(dropTime.hour)}:${pad(dropTime.minute)}-${pad(endHour)}:${pad(endMinute)}`;

      const doc = this.view.state.doc;
      const cmLine = doc.line(startLine);
      const tagMatch = cmLine.text.search(/#[\w-]+/);
      let insertPos: number;
      let insertText: string;
      if (tagMatch !== -1) {
        insertPos = cmLine.from + tagMatch;
        insertText = annotation + " ";
      } else {
        insertPos = cmLine.to;
        insertText = " " + annotation;
      }

      this.view.dispatch({
        changes: { from: insertPos, to: insertPos, insert: insertText },
      });

      this.cleanup();
      return true;
    }

    private handleUnschedule(e: DragEvent): void {
      if (!e.dataTransfer) return;

      const lineStart = parseInt(
        e.dataTransfer.getData("application/day-timeline-line") || "-1"
      );
      const slotIndex = parseInt(
        e.dataTransfer.getData("application/day-timeline-slot") || "0"
      );
      if (lineStart < 0) return;

      document.querySelectorAll(".task-block").forEach((el) => {
        const b = el as HTMLElement;
        if (
          b.dataset.lineStart === String(lineStart) &&
          b.dataset.slotIndex === String(slotIndex)
        ) {
          b.style.display = "none";
        }
      });

      const doc = this.view.state.doc;
      const cmLine = doc.line(lineStart + 1);
      const re = /@\d{2}:\d{2}-\d{2}:\d{2}/g;
      let match: RegExpExecArray | null;
      let matchIdx = 0;
      while ((match = re.exec(cmLine.text)) !== null) {
        if (matchIdx === slotIndex) {
          let from = cmLine.from + match.index;
          let to = from + match[0].length;
          if (
            to < cmLine.to &&
            cmLine.text[match.index + match[0].length] === " "
          ) {
            to += 1;
          } else if (match.index > 0 && cmLine.text[match.index - 1] === " ") {
            from -= 1;
          }
          this.view.dispatch({ changes: { from, to, insert: "" } });
          return;
        }
        matchIdx++;
      }
    }

    private onDragLeave(e: DragEvent) {
      if (!e.dataTransfer) return;
      const types = Array.from(e.dataTransfer.types);
      if (
        !types.includes("application/day-timeline-editor") &&
        !types.includes("application/day-timeline-block")
      )
        return;

      const related = e.relatedTarget as HTMLElement | null;
      if (related && this.view.dom.contains(related)) return;

      if (this.dropIndicator) this.dropIndicator.style.display = "none";
    }

    private onDragEnd() {
      this.cleanup();
      this.view.dom
        .querySelectorAll(".day-timeline-editor-handle.is-dragging")
        .forEach((el) => el.classList.remove("is-dragging"));
    }

    private cleanup() {
      if (this.dropIndicator) {
        this.dropIndicator.remove();
        this.dropIndicator = null;
      }
      if (this.dragGhost) {
        this.dragGhost.remove();
        this.dragGhost = null;
      }
      this.dragSourceLine = null;
    }
  },
  { decorations: (v) => v.decorations }
);

export function createEditorExtension(): Extension {
  return editorDragPlugin;
}
