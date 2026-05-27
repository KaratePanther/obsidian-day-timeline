import { App, Menu, TFile } from "obsidian";
import { DailyNote, Task, TimeRange } from "./types";
import { parseDaily, getAllTasks, getDisplayText } from "./parser";
import { addSchedule, removeSchedule, updateSchedule } from "./serializer";
import {
  RenderedElements,
  yToTime,
  timeToY,
  durationToHeight,
  HOUR_HEIGHT,
  DEFAULT_DURATION,
  SNAP_MINUTES,
  SECTION_COLORS,
  snapToGrid,
} from "./timeline-renderer";

export type RefreshCallback = () => void;

export class DragHandler {
  private app: App;
  private file: TFile;
  private daily: DailyNote;
  private elements: RenderedElements;
  private onRefresh: RefreshCallback;
  private writeTimeout: ReturnType<typeof setTimeout> | null = null;
  private suppressNextModify = false;
  private grabOffsetY = 0;
  private dragGhost: HTMLElement | null = null;

  constructor(
    app: App,
    file: TFile,
    daily: DailyNote,
    elements: RenderedElements,
    onRefresh: RefreshCallback
  ) {
    this.app = app;
    this.file = file;
    this.daily = daily;
    this.elements = elements;
    this.onRefresh = onRefresh;
  }

  get shouldSuppressModify(): boolean {
    const val = this.suppressNextModify;
    this.suppressNextModify = false;
    return val;
  }

  setup(): void {
    this.setupPoolDrag();
    this.setupBlockDrag();
    this.setupResizeBottom();
    this.setupResizeTop();
    this.setupGridDrop();
    this.setupPoolDrop();
    this.setupContextMenu();
  }

  private createDragGhost(
    task: Task,
    e: DragEvent,
    sourceEl?: HTMLElement
  ): void {
    const ghost = document.createElement("div");
    ghost.className = "task-block";

    const gridWidth = this.elements.slotsContainer.offsetWidth;
    const ghostWidth = gridWidth - 8;
    ghost.style.width = `${ghostWidth}px`;
    ghost.style.height = `${HOUR_HEIGHT}px`;
    ghost.style.backgroundColor =
      SECTION_COLORS[task.section] ?? "var(--text-accent)";
    ghost.style.position = "fixed";
    ghost.style.top = "-1000px";
    ghost.style.left = "-1000px";
    ghost.style.borderRadius = "4px";
    ghost.style.padding = "4px 6px";
    ghost.style.boxShadow = "0 2px 8px rgba(0,0,0,0.25)";
    ghost.style.zIndex = "9999";
    ghost.style.opacity = "0.85";
    ghost.style.pointerEvents = "none";

    const textEl = document.createElement("span");
    textEl.className = "task-block-text";
    textEl.textContent = getDisplayText(task).slice(0, 40);
    ghost.appendChild(textEl);

    document.body.appendChild(ghost);

    let offsetX = 4;
    if (sourceEl) {
      const srcRect = sourceEl.getBoundingClientRect();
      const grabX = e.clientX - srcRect.left;
      offsetX = Math.max(4, Math.min(grabX, ghostWidth - 4));
    }
    e.dataTransfer!.setDragImage(ghost, offsetX, 0);
    this.dragGhost = ghost;
  }

  private removeDragGhost(): void {
    if (this.dragGhost) {
      this.dragGhost.remove();
      this.dragGhost = null;
    }
  }

  private setupPoolDrag(): void {
    for (const [taskId, item] of this.elements.poolItems) {
      item.addEventListener("dragstart", (e) => {
        e.dataTransfer!.setData("text/plain", taskId);
        e.dataTransfer!.setData("application/day-timeline-pool", "1");
        this.grabOffsetY = 0;

        const task = this.findTask(taskId);
        if (task) this.createDragGhost(task, e, item);

        item.addClass("is-dragging");
      });
      item.addEventListener("dragend", () => {
        item.removeClass("is-dragging");
        this.removeDragGhost();
      });
    }
  }

  private setupBlockDrag(): void {
    for (const [blockKey, block] of this.elements.taskBlocks) {
      const handle = block.querySelector(".task-block-handle") as HTMLElement;
      if (!handle) continue;

      const taskId = block.dataset.taskId!;
      const slotIndex = block.dataset.slotIndex ?? "0";

      handle.addEventListener("mousedown", (e) => {
        block.setAttribute("draggable", "true");
        this.grabOffsetY = e.clientY - block.getBoundingClientRect().top;
      });

      block.addEventListener("dragstart", (e) => {
        e.dataTransfer!.setData("text/plain", taskId);
        e.dataTransfer!.setData("application/day-timeline-block", "1");
        e.dataTransfer!.setData("application/day-timeline-slot", slotIndex);
        e.dataTransfer!.setData(
          "application/day-timeline-line",
          block.dataset.lineStart ?? ""
        );
        block.addClass("is-dragging");
      });

      block.addEventListener("dragend", () => {
        block.removeClass("is-dragging");
        block.setAttribute("draggable", "false");
      });
    }
  }

  private setupGridDrop(): void {
    const grid = this.elements.slotsContainer;
    const dropZone = grid.parentElement ?? grid;

    dropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer!.dropEffect = "move";
      grid.addClass("drag-over");
    });

    dropZone.addEventListener("dragleave", (e) => {
      const related = e.relatedTarget as HTMLElement | null;
      if (related && dropZone.contains(related)) return;
      grid.removeClass("drag-over");
    });

    dropZone.addEventListener("drop", async (e) => {
      e.preventDefault();
      grid.removeClass("drag-over");

      const isFromPool = e.dataTransfer!.types.includes("application/day-timeline-pool");
      const isFromEditor = e.dataTransfer!.types.includes("application/day-timeline-editor");
      const isFromBlock = e.dataTransfer!.types.includes("application/day-timeline-block");

      if (isFromEditor) this.grabOffsetY = 0;

      const rect = grid.getBoundingClientRect();
      const rawY = e.clientY - rect.top - this.grabOffsetY;
      const dropTime = yToTime(Math.max(0, rawY));

      let task: Task | undefined;

      if (isFromEditor) {
        const editorData = JSON.parse(
          e.dataTransfer!.getData("application/day-timeline-editor")
        );
        task = getAllTasks(this.daily).find(
          (t) => t.lineStart === editorData.lineStart
        );
      } else {
        const taskId = e.dataTransfer!.getData("text/plain");
        if (!taskId) return;
        task = this.findTask(taskId);
      }

      if (!task) return;

      if (isFromPool || isFromEditor) {
        const endMinutes = dropTime.hour * 60 + dropTime.minute + DEFAULT_DURATION;
        const newTime: TimeRange = {
          start: dropTime,
          end: { hour: Math.floor(endMinutes / 60), minute: endMinutes % 60 },
        };

        if (isFromPool) {
          const poolItem = this.elements.poolItems.get(task.id);
          if (poolItem) poolItem.style.display = "none";
        }

        await this.writeChange(
          (content) => addSchedule(content, task!.lineStart, newTime),
          true
        );
      } else if (isFromBlock) {
        const slotIndex = parseInt(e.dataTransfer!.getData("application/day-timeline-slot") || "0");
        const duration = this.getSlotDuration(task, slotIndex);
        const endMinutes = dropTime.hour * 60 + dropTime.minute + duration;
        const newTime: TimeRange = {
          start: dropTime,
          end: { hour: Math.floor(endMinutes / 60), minute: endMinutes % 60 },
        };

        const blockKey = `${task.id}:${slotIndex}`;
        const block = this.elements.taskBlocks.get(blockKey);
        if (block) {
          block.removeClass("is-dragging");
          const newTop = timeToY(dropTime.hour, dropTime.minute);
          const newHeight = durationToHeight(dropTime, newTime.end!);
          block.style.top = `${newTop}px`;
          block.style.height = `${Math.max(newHeight, SNAP_MINUTES)}px`;
        }

        await this.writeChange(
          (content) => updateSchedule(content, task!.lineStart, newTime, slotIndex),
          true
        );
      }
    });
  }

  private setupPoolDrop(): void {
    const pool = this.elements.pool;

    pool.addEventListener("dragover", (e) => {
      if (!e.dataTransfer!.types.includes("application/day-timeline-block")) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = "move";
      pool.addClass("drag-over");
    });

    pool.addEventListener("dragleave", () => {
      pool.removeClass("drag-over");
    });

    pool.addEventListener("drop", async (e) => {
      e.preventDefault();
      pool.removeClass("drag-over");

      const taskId = e.dataTransfer!.getData("text/plain");
      if (!taskId) return;

      const slotIndex = parseInt(e.dataTransfer!.getData("application/day-timeline-slot") || "0");

      const task = this.findTask(taskId);
      if (!task || task.scheduledTimes.length === 0) return;

      const blockKey = `${taskId}:${slotIndex}`;
      const block = this.elements.taskBlocks.get(blockKey);
      if (block) block.style.display = "none";

      await this.writeChange(
        (content) => removeSchedule(content, task.lineStart, slotIndex),
        true
      );
    });
  }

  private setupResizeBottom(): void {
    for (const [blockKey, block] of this.elements.taskBlocks) {
      const resizeHandle = block.querySelector(".task-block-resize") as HTMLElement;
      if (!resizeHandle) continue;

      const slotIndex = parseInt(block.dataset.slotIndex ?? "0");
      let startY = 0;
      let startHeight = 0;

      const onMouseMove = (e: MouseEvent) => {
        e.preventDefault();
        const dy = e.clientY - startY;
        const rawMinutes = ((startHeight + dy) / HOUR_HEIGHT) * 60;
        const snappedMinutes = Math.max(
          SNAP_MINUTES,
          snapToGrid(rawMinutes)
        );
        block.style.height = `${(snappedMinutes / 60) * HOUR_HEIGHT}px`;
      };

      const onMouseUp = async () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        block.removeClass("is-resizing");

        const taskId = block.dataset.taskId!;
        const task = this.findTask(taskId);
        if (!task || task.scheduledTimes.length <= slotIndex) return;

        const tr = task.scheduledTimes[slotIndex];
        const finalHeight = parseFloat(block.style.height);
        const durationMinutes = snapToGrid((finalHeight / HOUR_HEIGHT) * 60);
        const endMinutes =
          tr.start.hour * 60 + tr.start.minute + durationMinutes;

        const newTime: TimeRange = {
          start: tr.start,
          end: { hour: Math.floor(endMinutes / 60), minute: endMinutes % 60 },
        };

        await this.writeChange((content) =>
          updateSchedule(content, task.lineStart, newTime, slotIndex)
        );
      };

      resizeHandle.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        startY = e.clientY;
        startHeight = block.offsetHeight;
        block.addClass("is-resizing");
        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
      });
    }
  }

  private setupResizeTop(): void {
    for (const [blockKey, block] of this.elements.taskBlocks) {
      const resizeHandle = block.querySelector(".task-block-resize-top") as HTMLElement;
      if (!resizeHandle) continue;

      const slotIndex = parseInt(block.dataset.slotIndex ?? "0");
      let startY = 0;
      let origTop = 0;
      let origHeight = 0;

      const onMouseMove = (e: MouseEvent) => {
        e.preventDefault();
        const dy = e.clientY - startY;
        const newHeight = origHeight - dy;

        const rawMinutes = (newHeight / HOUR_HEIGHT) * 60;
        const snappedMinutes = Math.max(SNAP_MINUTES, snapToGrid(rawMinutes));
        const snappedHeight = (snappedMinutes / 60) * HOUR_HEIGHT;
        const snappedTop = origTop + origHeight - snappedHeight;

        block.style.top = `${snappedTop}px`;
        block.style.height = `${snappedHeight}px`;
      };

      const onMouseUp = async () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        block.removeClass("is-resizing");

        const taskId = block.dataset.taskId!;
        const task = this.findTask(taskId);
        if (!task || task.scheduledTimes.length <= slotIndex) return;

        const finalTop = parseFloat(block.style.top);
        const finalHeight = parseFloat(block.style.height);

        const newStart = yToTime(finalTop);
        const durationMinutes = snapToGrid((finalHeight / HOUR_HEIGHT) * 60);
        const endMinutes = newStart.hour * 60 + newStart.minute + durationMinutes;

        const newTime: TimeRange = {
          start: newStart,
          end: { hour: Math.floor(endMinutes / 60), minute: endMinutes % 60 },
        };

        await this.writeChange((content) =>
          updateSchedule(content, task.lineStart, newTime, slotIndex)
        );
      };

      resizeHandle.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        startY = e.clientY;
        origTop = parseFloat(block.style.top);
        origHeight = block.offsetHeight;
        block.addClass("is-resizing");
        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
      });
    }
  }

  private setupContextMenu(): void {
    for (const [blockKey, block] of this.elements.taskBlocks) {
      block.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();

        const taskId = block.dataset.taskId!;
        const slotIndex = parseInt(block.dataset.slotIndex ?? "0");
        const task = this.findTask(taskId);
        if (!task) return;

        const menu = new Menu();

        menu.addItem((item) => {
          item.setTitle("Add another time slot");
          item.setIcon("plus");
          item.onClick(async () => {
            const lastSlot = task.scheduledTimes[task.scheduledTimes.length - 1];
            const slotEnd = lastSlot.end ?? {
              hour: lastSlot.start.hour + 1,
              minute: lastSlot.start.minute,
            };
            const newEndMinutes = slotEnd.hour * 60 + slotEnd.minute + DEFAULT_DURATION;
            const newTime: TimeRange = {
              start: { hour: slotEnd.hour, minute: slotEnd.minute },
              end: { hour: Math.floor(newEndMinutes / 60), minute: newEndMinutes % 60 },
            };
            await this.writeChange(
              (content) => addSchedule(content, task.lineStart, newTime),
              true
            );
          });
        });

        menu.addSeparator();

        menu.addItem((item) => {
          item.setTitle("Remove from calendar");
          item.setIcon("trash");
          item.onClick(async () => {
            await this.writeChange(
              (content) => removeSchedule(content, task.lineStart, slotIndex),
              true
            );
          });
        });

        menu.showAtMouseEvent(e);
      });
    }
  }

  private getSlotDuration(task: Task, slotIndex: number): number {
    const tr = task.scheduledTimes[slotIndex];
    if (!tr) return DEFAULT_DURATION;
    const e = tr.end;
    if (!e) return DEFAULT_DURATION;
    return (e.hour * 60 + e.minute) - (tr.start.hour * 60 + tr.start.minute);
  }

  private findTask(taskId: string): Task | undefined {
    return getAllTasks(this.daily).find((t) => t.id === taskId);
  }

  private async writeChange(
    modify: (content: string) => string,
    immediate = false
  ): Promise<void> {
    if (this.writeTimeout) {
      clearTimeout(this.writeTimeout);
    }

    const doWrite = async () => {
      const content = await this.app.vault.read(this.file);
      const newContent = modify(content);
      if (newContent !== content) {
        this.suppressNextModify = true;
        await this.app.vault.modify(this.file, newContent);
        const newDaily = parseDaily(newContent, this.file.path);
        this.daily = newDaily;
        this.onRefresh();
      }
    };

    if (immediate) {
      await doWrite();
    } else {
      this.writeTimeout = setTimeout(doWrite, 150);
    }
  }
}
